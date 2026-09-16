"use client";

import { useEffect, useState } from "react";
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
 */

type ViewState =
  | { status: "checking-device" }
  | { status: "device-unavailable"; message: string }
  | { status: "ready"; storeId: string };

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
      </main>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-y-auto bg-white">
      <FloorMap storeId={view.storeId} />
    </div>
  );
}
