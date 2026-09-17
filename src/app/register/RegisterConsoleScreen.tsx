"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ensureDeviceSession } from "@/lib/device/useDeviceIdentity";
import FloorMap from "./FloorMap";

/**
 * レジ画面の実体（design.md「RegisterConsole」コンポーネント）。
 *
 * Requirements: 2.2, 5.4
 * Design: .kiro/specs/table-order-kitchen/design.md の「RegisterConsole」
 *   （Presentation Layer summary）を参照。
 *
 * ## 本タスク（8.1）のスコープ
 * 8.1は「卓マップ表示」のみを担う。KitchenBoardScreen.tsx（7.1）と同型の
 * デバイスセッション確認（`ensureDeviceSession`、"register"ロール限定）を
 * 行い、確立済みの場合は卓マップ本体（`FloorMap.tsx`）へ委譲する。
 * KitchenBoardScreenと異なりRegisterConsoleは（少なくとも8.1時点では）
 * タブ切り替えを持たないため、固定ヘッダー・接続状態インジケーター等の
 * 「複数の子ボードを横断して共有する画面レベルの状態」は本タスクの時点では
 * 存在しない（接続断表示・Realtime配線はタスク9.2のスコープ、
 * FloorMap.tsx冒頭コメント「更新方式についての設計判断」参照）。そのため
 * 本コンポーネントはデバイスセッション確認のみを担う薄いラッパーであり、
 * 「卓マップ／全N卓」ヘッダーを含む実際の表示内容はすべてFloorMap.tsxが
 * 自己完結して持つ（KitchenBoardScreenの`activeTabLabel`表示とは異なり、
 * 卓の総数はFloorMap側が取得したデータからのみ導出できるため、画面レベルへ
 * 巻き上げずFloorMap自身に持たせる設計判断）。
 *
 * ## デバイスセッション確認について（KitchenBoardScreen.tsxと同型）
 * `ensureDeviceSession`はNOT_PROVISIONED以外の想定外の失敗（ネットワーク断等）
 * をResultではなく例外として投げる設計のため（useDeviceIdentity.ts冒頭
 * コメント参照）、必ずtry/catchで捕捉する。`register`ロール以外（例:
 * kitchenロールのデバイスで`/register`を開いた場合）もクラッシュせず
 * 同様の案内文を表示する防御的な分岐を設ける（KitchenBoardScreen.tsxが
 * 確立した「本タスクの完了条件はタブ/固定ヘッダーの構造であり、セットアップ
 * 画面への自動遷移導線までは作り込まない」という段階的な充実パターンを
 * 踏襲。正式な導線はタスク9.1のスコープ）。
 *
 * ## タスク9.1での更新: NOT_PROVISIONED時のセットアップ導線
 * KitchenBoardScreen.tsxと全く同型の変更を`/register`側にも適用する
 * （設計判断・理由の詳細はKitchenBoardScreen.tsx冒頭コメント「## タスク
 * 9.1での更新」を参照。実際の`<Link>`を選んだ理由、KitchenBoardScreen側の
 * Linkとコンポーネントを共有しなかった理由——Boundary Contextを跨ぐ物理
 * importを避ける本specの確立済み方針——いずれも同一）。差分はhref/文言中の
 * パスが自画面のロール（`register`）を指す点のみ:
 * NOT_PROVISIONEDの場合のみ`ViewState`に`setupHref`（`/setup/register`）を
 * 設定し、案内文の下に`data-testid="register-setup-link"`のLinkを表示する。
 * WRONG_ROLE・汎用デバイスエラーは`setupHref`を設定せず、本タスクの前から
 * 変わらないプレーンテキストのみの表示のまま据え置く。
 */

type ViewState =
  | { status: "checking-device" }
  // タスク9.1: setupHreadはNOT_PROVISIONEDの場合のみ設定する（WRONG_ROLE・
  // 汎用デバイスエラーではundefinedのまま、Linkを描画しない）。
  | { status: "device-unavailable"; message: string; setupHref?: string }
  | { status: "ready"; storeId: string };

// タスク9.1: NOT_PROVISIONED時のセットアップ導線（<Link>）の遷移先。
const REGISTER_SETUP_PATH = "/setup/register";

const NOT_PROVISIONED_MESSAGE =
  "このタブレットはレジ用デバイスとしてセットアップされていません。店舗スタッフにご確認のうえ、/setup/register からセットアップしてください。";

const WRONG_ROLE_MESSAGE =
  "このタブレットはレジ用デバイスとして登録されていません（別の役割のデバイスとして登録済みです）。店舗スタッフにご確認ください。";

const GENERIC_DEVICE_ERROR_MESSAGE =
  "デバイスの確認中に予期しないエラーが発生しました。ネットワーク接続をご確認のうえ、画面を再読み込みしてください。";

export default function RegisterConsoleScreen() {
  const [view, setView] = useState<ViewState>({ status: "checking-device" });

  useEffect(() => {
    let cancelled = false;

    async function checkDevice() {
      // ensureDeviceSessionはNOT_PROVISIONED以外の想定外の失敗（ネットワーク断等）
      // をResultではなく例外として投げる（useDeviceIdentity.ts冒頭コメント参照）ため、
      // 必ずtry/catchで捕捉する（tasks.md Implementation Notesが確立した
      // 「ドキュメント化されたエラーコード以外は例外」規約への対応）。
      try {
        const result = await ensureDeviceSession();
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setView({
            status: "device-unavailable",
            message: NOT_PROVISIONED_MESSAGE,
            setupHref: REGISTER_SETUP_PATH,
          });
          return;
        }
        if (result.value.role !== "register") {
          setView({
            status: "device-unavailable",
            message: WRONG_ROLE_MESSAGE,
          });
          return;
        }
        setView({ status: "ready", storeId: result.value.storeId });
      } catch {
        if (!cancelled) {
          setView({
            status: "device-unavailable",
            message: GENERIC_DEVICE_ERROR_MESSAGE,
          });
        }
      }
    }

    void checkDevice();
    return () => {
      cancelled = true;
    };
  }, []);

  if (view.status === "checking-device") {
    return (
      <main className="flex h-screen items-center justify-center bg-white">
        <p className="text-sm text-neutral-500">確認中...</p>
      </main>
    );
  }

  if (view.status === "device-unavailable") {
    return (
      <main
        data-testid="register-device-unavailable"
        className="flex h-screen flex-col items-center justify-center gap-3 bg-white px-6 text-center"
      >
        <h1 className="text-lg font-semibold text-neutral-900">
          レジ画面を利用できません
        </h1>
        <p
          role="alert"
          className="max-w-sm text-sm leading-relaxed text-neutral-600"
        >
          {view.message}
        </p>
        {view.setupHref ? (
          <Link
            href={view.setupHref}
            data-testid="register-setup-link"
            className="text-sm font-semibold text-blue-600 underline underline-offset-2"
          >
            セットアップ画面へ進む
          </Link>
        ) : null}
      </main>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-y-auto bg-white">
      <FloorMap storeId={view.storeId} />
    </div>
  );
}
