import type { SupabaseClient, Session } from "@supabase/supabase-js";
import { createBrowserClient } from "../supabase/client";
import type { Database } from "../supabase/database.types";
import { type Result, ok, err } from "../result";

/**
 * DeviceIdentityProvider — 厨房/レジタブレットに対し、個人ログインなしで
 * device_roleクレーム付きの永続セッションを一度だけ発行する。
 *
 * Requirements: 8.2, 8.3
 * Design: .kiro/specs/table-order-kitchen/design.md の
 *   "DeviceIdentityProvider" コンポーネント（Service Interface, State
 *   Management, Implementation Notes）を参照。
 *
 * ## エラーモデルの方針
 * `DeviceProvisioningError`は design.md が明示的にモデル化した2つの業務エラー
 * （セットアップコード不一致／未プロビジョニング）のみを表す。
 * ネットワーク断や想定外のRPCエラーのような、型でモデル化されていない失敗は
 * Resultに押し込めず、Promiseのrejectとして呼び出し元へ伝播させる
 * （src/lib/result.tsのコメント参照）。
 *
 * ## 状態管理（State Managementの実装）
 * `getCurrentDevice()`は同期APIとして設計されているため、
 * (a) モジュールスコープの変数（同一タブ内でのメモリキャッシュ）と
 * (b) ブラウザのlocalStorage（タブレットの再訪時・再読み込み時の永続化。
 *     タスクの観測可能な完了条件「タブレットのローカルストレージに
 *     永続化されたセッションで再訪時に認証UIが表示されない」に対応）
 * の2段構成でDeviceIdentityをキャッシュする。
 *
 * devicesテーブルの実在確認は、0005_custom_access_token_hook.sqlが
 * JWTへ埋め込むdevice_roleクレームをデコードして行い、そのためだけの
 * 追加DB往復は行わない。ただしJWTにはdevice_roleクレームのみが含まれ
 * storeIdは含まれない（0005の変更は本タスクのスコープ外）ため、
 * storeIdはprovisionDevice成功時にlocalStorageへ保存したキャッシュから
 * 復元する。デバイスのdevice_roleクレームは存在するのにローカルキャッシュが
 * 失われている場合（タブレットのストレージが部分的に消去された等）は、
 * design.mdの「タブレットのストレージが消去された場合は再度/setup/[role]が
 * 必要」という想定どおりNOT_PROVISIONEDを返し、再セットアップを促す
 * （provision_deviceはauth_user_id単位のupsertのため、再実行は安全）。
 */

export type DeviceRole = "kitchen" | "register";

export interface DeviceIdentity {
  deviceUserId: string;
  role: DeviceRole;
  storeId: string;
}

export interface ProvisionDeviceInput {
  setupCode: string;
  role: DeviceRole;
  storeId: string;
}

export type DeviceProvisioningError =
  | { code: "INVALID_SETUP_CODE" }
  | { code: "NOT_PROVISIONED" };

/**
 * 0007_provision_device.sqlがセットアップコード不一致時に送出する
 * カスタムSQLSTATE。PostgRESTはPostgres関数が`raise exception ... using
 * errcode = '...'`で送出したSQLSTATEをそのままエラーレスポンスの`code`
 * フィールドとして返すことをローカルスタックへの実RPC呼び出しで確認済み
 * （0007のマイグレーションコメント参照）。
 */
const INVALID_SETUP_CODE_SQLSTATE = "P0401";

const DEVICE_IDENTITY_STORAGE_KEY = "table-order-kitchen:device-identity";

let cachedClient: SupabaseClient<Database> | null = null;

function getClient(): SupabaseClient<Database> {
  if (!cachedClient) {
    cachedClient = createBrowserClient();
  }
  return cachedClient;
}

/** モジュールスコープのメモリキャッシュ（同一タブ内でのgetCurrentDevice用）。 */
let currentDevice: DeviceIdentity | null = null;

function isDeviceRole(value: unknown): value is DeviceRole {
  return value === "kitchen" || value === "register";
}

function isDeviceIdentity(value: unknown): value is DeviceIdentity {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deviceUserId === "string" &&
    isDeviceRole(candidate.role) &&
    typeof candidate.storeId === "string"
  );
}

function readCachedDeviceIdentity(): DeviceIdentity | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(DEVICE_IDENTITY_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return isDeviceIdentity(parsed) ? parsed : null;
  } catch {
    // 破損したJSON・localStorage自体が使えない環境（プライベートモード等）では
    // キャッシュなし扱いにフォールバックする。
    return null;
  }
}

function writeCachedDeviceIdentity(identity: DeviceIdentity): void {
  currentDevice = identity;
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      DEVICE_IDENTITY_STORAGE_KEY,
      JSON.stringify(identity),
    );
  } catch {
    // localStorageへ書き込めない環境でも、モジュールスコープのメモリキャッシュ
    // （currentDevice）は更新済みのため、同一タブ内の動作は継続できる。
  }
}

function clearCachedDeviceIdentity(): void {
  currentDevice = null;
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(DEVICE_IDENTITY_STORAGE_KEY);
  } catch {
    // ベストエフォート。
  }
}

/**
 * JWTのペイロード部分（第2セグメント）をbase64url→JSONへデコードする。
 * customAccessTokenHook.integration.test.tsが確立したデコード手順と同じ
 * 考え方だが、本番コードとして例外を投げず失敗時はnullを返す。
 */
function decodeJwtPayload(accessToken: string): Record<string, unknown> | null {
  try {
    const segments = accessToken.split(".");
    const payloadSegment = segments[1];
    if (!payloadSegment) {
      return null;
    }
    const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const paddingLength = (4 - (base64.length % 4)) % 4;
    const padded = base64 + "=".repeat(paddingLength);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const json = new TextDecoder("utf-8").decode(bytes);
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 永続化された匿名セッションを取得し、なければ新規に匿名サインインする。
 * Supabase JSクライアントはセッションをlocalStorageへ自動永続化するため
 * （デフォルト挙動）、タブレット再訪時はgetSession()がネットワークを
 * 経由せず既存セッションを返す。
 */
async function getOrCreateSession(
  client: SupabaseClient<Database>,
): Promise<Session> {
  const { data } = await client.auth.getSession();
  if (data.session) {
    return data.session;
  }

  const { data: signInData, error } = await client.auth.signInAnonymously();
  if (error || !signInData.session) {
    // 匿名サインイン自体の失敗はdesign.mdのDeviceProvisioningErrorが
    // モデル化する業務エラーではないため、Resultではなく例外として伝播させる
    // （本ファイル冒頭のコメント参照）。
    throw new Error(
      `Failed to establish an anonymous device session: ${error?.message ?? "unknown error"}`,
    );
  }
  return signInData.session;
}

/**
 * 永続化された匿名セッションを確認し、devicesテーブルへの登録
 * （device_roleクレーム）が既に済んでいればDeviceIdentityを、
 * 未登録であればNOT_PROVISIONEDを返す。
 *
 * 観測可能な完了条件（タスク2.3）: セットアップコード入力後、タブレットの
 * ローカルストレージに永続化されたセッションで再訪時に認証UIが表示されない
 * ＝ 本関数がOKを返し続けること。
 */
export async function ensureDeviceSession(): Promise<
  Result<DeviceIdentity, DeviceProvisioningError>
> {
  const client = getClient();
  const session = await getOrCreateSession(client);

  const claims = decodeJwtPayload(session.access_token);
  const deviceRole = claims?.device_role;

  if (!isDeviceRole(deviceRole)) {
    // devicesテーブルに一致する行がない（客の匿名セッションと同型、または
    // まだセットアップされていない厨房/レジタブレット）。
    clearCachedDeviceIdentity();
    return err({ code: "NOT_PROVISIONED" });
  }

  const cached = readCachedDeviceIdentity();
  if (
    cached &&
    cached.role === deviceRole &&
    cached.deviceUserId === session.user.id
  ) {
    currentDevice = cached;
    return ok(cached);
  }

  // JWTはdevicesテーブルの実在（role）を証明しているが、storeIdを含まない。
  // ローカルキャッシュが失われている（またはユーザーID/roleが食い違う）場合、
  // storeIdを安全に復元する経路がないため再セットアップを促す
  // （ファイル冒頭のコメント参照）。
  clearCachedDeviceIdentity();
  return err({ code: "NOT_PROVISIONED" });
}

/**
 * セットアップコードを検証し、devicesテーブルへ自分自身の行を登録する
 * （0007_provision_device.sqlのSECURITY DEFINER RPCを呼び出す）。
 * 成功後はセッションをrefreshし、新しいJWTのdevice_roleクレームを
 * 反映させてからDeviceIdentityを返す
 * （0005実装時に実機検証済みのパターン: クレームはトークン発行時にのみ
 * 埋め込まれるため、devices行の作成直後の既存トークンには反映されない）。
 */
export async function provisionDevice(
  input: ProvisionDeviceInput,
): Promise<Result<DeviceIdentity, DeviceProvisioningError>> {
  const client = getClient();
  const session = await getOrCreateSession(client);

  const { data, error } = await client.rpc("provision_device", {
    p_setup_code: input.setupCode,
    p_role: input.role,
    p_store_id: input.storeId,
  });

  if (error) {
    if (error.code === INVALID_SETUP_CODE_SQLSTATE) {
      return err({ code: "INVALID_SETUP_CODE" });
    }
    // モデル化されていないRPCエラー（想定外のサーバーエラー・ネットワーク断等）は
    // Resultに押し込めず例外として伝播させる（ファイル冒頭のコメント参照）。
    throw new Error(`provision_device RPC failed unexpectedly: ${error.message}`);
  }

  const { data: refreshed, error: refreshError } =
    await client.auth.refreshSession();
  if (refreshError || !refreshed.session) {
    throw new Error(
      `Failed to refresh session after provisioning: ${refreshError?.message ?? "unknown error"}`,
    );
  }

  // provision_deviceはDBで確定したdevices行を返す。通常はinputの値と一致するが、
  // 再プロビジョニング（upsert）時にDB側の値を正としたいため、data（返却行）を優先する。
  const identity: DeviceIdentity = {
    deviceUserId: data?.auth_user_id ?? session.user.id,
    role: isDeviceRole(data?.role) ? data.role : input.role,
    storeId: data?.store_id ?? input.storeId,
  };

  writeCachedDeviceIdentity(identity);
  return ok(identity);
}

/**
 * 直近のensureDeviceSession/provisionDevice成功時に確立した
 * DeviceIdentityを同期的に返す（design.mdの`State [x]`契約）。
 * モジュールスコープのメモリキャッシュが空でも、localStorageに
 * 永続化されたキャッシュがあればそれを採用する
 * （ページ読み込み直後、ensureDeviceSessionをまだ呼んでいない場合の
 * 早期描画に使える）。
 */
export function getCurrentDevice(): DeviceIdentity | null {
  if (currentDevice) {
    return currentDevice;
  }
  const cached = readCachedDeviceIdentity();
  if (cached) {
    currentDevice = cached;
  }
  return currentDevice;
}

/**
 * design.mdのFile Structure Planがファイル名を`useDeviceIdentity.ts`と
 * 命名していることに対応する、Reactコンポーネントから使う薄いフック。
 * 各メソッドはモジュールスコープの関数（安定参照）をそのまま返すだけで、
 * 内部的なReact状態は持たない（design.mdのConcurrency strategy
 * 「対象外（デバイス単位で1セッションのみ）」を踏まえた最小実装）。
 * テストやフック外の呼び出しからは、同じロジックを個別の名前付きexport
 * （ensureDeviceSession等）として直接importできる。
 */
export function useDeviceIdentity(): {
  ensureDeviceSession: typeof ensureDeviceSession;
  provisionDevice: typeof provisionDevice;
  getCurrentDevice: typeof getCurrentDevice;
} {
  return { ensureDeviceSession, provisionDevice, getCurrentDevice };
}
