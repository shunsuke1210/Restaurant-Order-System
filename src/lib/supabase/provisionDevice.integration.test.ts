// @vitest-environment node
//
// 0007_provision_device.sql のprovision_device RPCを、ローカルSupabase
// スタックに対する実際の匿名サインイン＋RPC呼び出しで検証する結合テスト。
// customAccessTokenHook.integration.test.ts / assertDeviceRole.integration.test.ts
// と同じ構成: 事前に `npm run db:start` と、config.toml変更
// （[db.vault]セクションの追加）を反映させるための`npm run db:reset`
// （0001, 0002, 0005, 0006, 0007を適用し、DEVICE_SETUP_CODEをVaultへ登録）が必要。
//
// 正しいセットアップコードの期待値は、このテスト自身もprocess.env.DEVICE_SETUP_CODE
// （.env.local由来）から読み取る。Vite/Vitestはデフォルトでは.env.local等の
// 中身をprocess.envへ自動反映しない（VITE_接頭辞の変数のみimport.meta.env向けに
// 公開される別経路）ため、vitest.config.mtsで明示的に`loadEnv`の結果を
// process.envへマージしている（詳細は同ファイルのコメント参照）。これにより
// Next.js経由でなくても.env.localの値が届く。
// DEVICE_SETUP_CODEはセットアップコードという性質上、他の結合テストの
// NEXT_PUBLIC_SUPABASE_URL等（Supabase CLIが発行する既知のローカル開発用
// デフォルト値で、それ自体は秘匿情報ではない）とは異なり、推測可能な
// デフォルト値へフォールバックすべきではない。そのため本ファイルでは
// フォールバックを持たず、未設定ならbeforeAllで即座に失敗させる
// （下記beforeAll参照）。
//
// Requirements: 8.2（厨房スタッフに個人認証を要求しない）,
//               8.3（レジスタッフに個人認証を要求しない）
//               — セットアップコードによる初回デバイスプロビジョニングが
//               この無ログイン運用の入り口であることの検証
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const connectionString =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
// supabase/config.tomlの[db.vault]がdb reset/start時に`.env.local`の
// DEVICE_SETUP_CODEをVaultシークレットdevice_setup_codeへ反映する
// （0007_provision_device.sqlのマイグレーションコメントで実機検証済み）。
// フォールバック値は意図的に持たない（下記beforeAllのガード参照）。
// describeのbeforeAllが最初のテストより前に必ず値を設定するため、
// it()内では非nullとして扱える。
let expectedSetupCode: string;

// 0007_provision_device.sqlがセットアップコード不一致時に送出するカスタムSQLSTATE。
const INVALID_SETUP_CODE = "P0401";

const pool = new Pool({ connectionString });

/** JWTのペイロード部分（第2セグメント）をbase64url→JSONへデコードする。 */
function decodeJwtPayload(accessToken: string): Record<string, unknown> {
  const segments = accessToken.split(".");
  const payloadSegment = segments[1];
  if (!payloadSegment) {
    throw new Error(
      `Invalid JWT: expected 3 dot-separated segments, got ${segments.length}`,
    );
  }
  const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(paddingLength);
  const json = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

function newAnonClient() {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

describe("0007_provision_device.sql: provision_device RPC（結合テスト）", () => {
  const storeId = randomUUID();
  const createdAuthUserIds: string[] = [];

  beforeAll(async () => {
    // 推測可能なデフォルト値へ静かにフォールバックしないよう、
    // 未設定の場合はここで即座に明確なエラーで失敗させる
    // （.env.localの値をそのままハードコードしたフォールバックは、
    // Vaultによる平文シークレット隠蔽という設計判断と矛盾する上、
    // テストとして単独でも好ましくないパターンであるため）。
    if (!process.env.DEVICE_SETUP_CODE) {
      throw new Error(
        "DEVICE_SETUP_CODE must be set in .env.local for this integration test",
      );
    }
    expectedSetupCode = process.env.DEVICE_SETUP_CODE;

    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "provision_device結合テスト用店舗",
    ]);
  });

  afterEach(async () => {
    // 各テストが作成したdevices/auth.usersをベストエフォートで後始末する。
    for (const authUserId of createdAuthUserIds.splice(0)) {
      await pool.query("delete from devices where auth_user_id = $1", [
        authUserId,
      ]);
      try {
        await pool.query("delete from auth.users where id = $1", [
          authUserId,
        ]);
      } catch {
        // ベストエフォート。テストの合否には影響しない。
      }
    }
  });

  afterAll(async () => {
    await pool.query("delete from stores where id = $1", [storeId]);
    await pool.end();
  });

  it(
    "正しいセットアップコードで呼び出すと、自分自身のauth_user_idでdevices行が作成される",
    async () => {
      const supabase = newAnonClient();
      const signInResult = await supabase.auth.signInAnonymously();
      expect(signInResult.error).toBeNull();
      const authUserId = signInResult.data.user?.id;
      expect(authUserId).toBeDefined();
      if (authUserId) {
        createdAuthUserIds.push(authUserId);
      }

      const { data, error } = await supabase.rpc("provision_device", {
        p_setup_code: expectedSetupCode,
        p_role: "kitchen",
        p_store_id: storeId,
      });

      expect(error).toBeNull();
      expect(data).toMatchObject({
        auth_user_id: authUserId,
        store_id: storeId,
        role: "kitchen",
      });

      const dbRow = await pool.query(
        "select auth_user_id, store_id, role from devices where auth_user_id = $1",
        [authUserId],
      );
      expect(dbRow.rows).toEqual([
        { auth_user_id: authUserId, store_id: storeId, role: "kitchen" },
      ]);
    },
    30_000,
  );

  it(
    "誤ったセットアップコードで呼び出すと、カスタムSQLSTATE P0401で拒否され、devices行は作成されない",
    async () => {
      const supabase = newAnonClient();
      const signInResult = await supabase.auth.signInAnonymously();
      expect(signInResult.error).toBeNull();
      const authUserId = signInResult.data.user?.id;
      expect(authUserId).toBeDefined();
      if (authUserId) {
        createdAuthUserIds.push(authUserId);
      }

      const { data, error } = await supabase.rpc("provision_device", {
        p_setup_code: "definitely-not-the-setup-code",
        p_role: "kitchen",
        p_store_id: storeId,
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(INVALID_SETUP_CODE);

      const dbRow = await pool.query(
        "select 1 from devices where auth_user_id = $1",
        [authUserId],
      );
      expect(dbRow.rows).toHaveLength(0);
    },
    30_000,
  );

  it(
    "provision_device成功後、refreshSession()した新しいJWTはdevice_roleクレームを持つ",
    async () => {
      const supabase = newAnonClient();
      const signInResult = await supabase.auth.signInAnonymously();
      expect(signInResult.error).toBeNull();
      const authUserId = signInResult.data.user?.id;
      const refreshToken = signInResult.data.session?.refresh_token;
      expect(authUserId).toBeDefined();
      expect(refreshToken).toBeDefined();
      if (authUserId) {
        createdAuthUserIds.push(authUserId);
      }

      // サインイン直後（provision_device呼び出し前）のトークンにはまだ
      // device_roleクレームが含まれない。
      const initialClaims = decodeJwtPayload(
        signInResult.data.session?.access_token as string,
      );
      expect(initialClaims).not.toHaveProperty("device_role");

      const provisionResult = await supabase.rpc("provision_device", {
        p_setup_code: expectedSetupCode,
        p_role: "register",
        p_store_id: storeId,
      });
      expect(provisionResult.error).toBeNull();

      const refreshResult = await supabase.auth.refreshSession({
        refresh_token: refreshToken as string,
      });
      expect(refreshResult.error).toBeNull();
      const refreshedClaims = decodeJwtPayload(
        refreshResult.data.session?.access_token as string,
      );
      expect(refreshedClaims.device_role).toBe("register");
    },
    30_000,
  );

  it(
    "同一デバイス（同一匿名セッション）で再度provision_deviceを呼ぶと、新規行を作らず既存行を更新する（再セットアップの冪等性）",
    async () => {
      const supabase = newAnonClient();
      const signInResult = await supabase.auth.signInAnonymously();
      expect(signInResult.error).toBeNull();
      const authUserId = signInResult.data.user?.id;
      expect(authUserId).toBeDefined();
      if (authUserId) {
        createdAuthUserIds.push(authUserId);
      }

      const first = await supabase.rpc("provision_device", {
        p_setup_code: expectedSetupCode,
        p_role: "kitchen",
        p_store_id: storeId,
      });
      expect(first.error).toBeNull();
      const firstDeviceId = first.data?.id;

      const second = await supabase.rpc("provision_device", {
        p_setup_code: expectedSetupCode,
        p_role: "register",
        p_store_id: storeId,
      });
      expect(second.error).toBeNull();
      expect(second.data?.id).toBe(firstDeviceId);
      expect(second.data?.role).toBe("register");

      const rows = await pool.query(
        "select role from devices where auth_user_id = $1",
        [authUserId],
      );
      expect(rows.rows).toEqual([{ role: "register" }]);
    },
    30_000,
  );

  it(
    "匿名サインインすらしていない場合（anonロール）は、EXECUTE権限がなく呼び出し自体が失敗する",
    async () => {
      // authenticatedロールにのみEXECUTEを付与しており、anon/publicからは
      // 明示的に剥奪している（0007マイグレーション参照）。実機確認済み:
      // PostgRESTはこのケースで生のPostgres権限エラー
      // （SQLSTATE 42501 "permission denied for function provision_device"）を
      // そのまま返す（「関数が見つからない」スタイルのPGRST202ではない）。
      // エラーコードの詳細な形はPostgREST側の実装詳細であり将来変わり得るため、
      // ここではerrorが返ること自体のみを検証する。
      const supabase = newAnonClient();

      const { data, error } = await supabase.rpc("provision_device", {
        p_setup_code: expectedSetupCode,
        p_role: "kitchen",
        p_store_id: storeId,
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    },
    30_000,
  );
});
