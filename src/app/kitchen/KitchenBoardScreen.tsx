"use client";

import { useEffect, useState } from "react";
import { ensureDeviceSession } from "@/lib/device/useDeviceIdentity";
import KitchenTabs, { KITCHEN_TABS, type KitchenTabId } from "./KitchenTabs";
import FoodBoard from "./FoodBoard";

/**
 * 厨房KDS画面の実体（design.md「KitchenBoard」コンポーネント）。
 *
 * Requirements: 6.8（固定ヘッダー・サブタブ領域）
 * Design: .kiro/specs/table-order-kitchen/design.md の「KitchenBoard」
 *   （Presentation Layer summary）を参照。
 *
 * ## 本タスク（7.1）のスコープ
 * タスク7.1は「3タブ共通シェルと固定ヘッダー」のみを担う。以下は明示的に
 * スコープ外（tasks.mdの後続タスクが担当）であり、本コンポーネントは
 * これらを一切行わない:
 * - フード/ドリンク/売り切れの各ボードの実データ表示（7.2-7.4）
 * - `StaffOperationsGateway.listKitchenFeed`の呼び出し（7.2/7.3が
 *   実データ表示と合わせて配線する）
 * - `useRealtimeFeed`の配線・接続断表示（7.6）
 * - ステータス更新操作（7.5）
 * そのため各タブの内容は簡易なプレースホルダー文言のみとする。
 *
 * ## タスク7.2での更新: フードボードタブの実データ表示への置き換え
 * 7.2は上記スコープのうち「フードボードの実データ表示」のみを実装する
 * （ドリンク/売り切れは引き続きプレースホルダーのまま、7.3/7.4のスコープ）。
 * "food"タブ選択中は、7.1時点のプレースホルダー文言の代わりに
 * `FoodBoard`（`./FoodBoard.tsx`）へ委譲する。`FoodBoard`は
 * `view.status === "ready"`（＝kitchenロールのデバイスセッション確立済み）
 * の場合にのみマウントされ、`ensureDeviceSession`が返した
 * `DeviceIdentity.storeId`をpropsとして受け取る。
 *
 * ## デバイスセッション確認について（タスク9.1との役割分担）
 * `/kitchen`はデバイス識別基盤（タスク2.1-2.3）が要求するkitchen-role
 * 認証済みセッションを前提とする画面である。9.1は「未プロビジョニングの
 * 場合は/setup/[role]へ誘導する」導線を正式に実装するタスクだが、それまでの
 * 間もこの画面がクラッシュしたり空白のまま固まったりしないよう、本タスクでも
 * マウント時に`ensureDeviceSession()`を呼び、失敗時は最小限の案内文を
 * 表示するに留める（本タスクの完了条件はタブ/固定ヘッダーの構造であり、
 * セットアップ画面への自動遷移導線までは作り込まない。CustomerOrderAppが
 * 6.1で最小限の案内画面を出し、6.4で正式な画面を実装した「段階的な充実」と
 * 同じパターン）。`ensureDeviceSession`はNOT_PROVISIONED以外の想定外の
 * 失敗（ネットワーク断等）をResultではなく例外として投げる設計のため
 * （useDeviceIdentity.ts冒頭コメント参照）、必ずtry/catchで捕捉する。
 * 併せて、万一`register`役割のデバイスで`/kitchen`を開いた場合も
 * （将来7.2+がlistKitchenFeedを呼び出せばサーバー側のassert_device_role
 * がFORBIDDENで拒否するが、本タスクの時点ではまだRPC呼び出しが無いため）
 * クラッシュせず同様の案内文を表示する防御的な分岐を設ける。
 *
 * ## レイアウト構造について（mock-preview.html #kitchenScreen参照）
 * mock-preview.htmlの`renderKitchen`関数・関連CSS
 * （`.screen-inner{display:flex;flex-direction:column}`、
 * `.scroll-area{overflow-y:auto;flex:1;min-height:0}`、`.screen-header`/
 * `.tabs`はいずれも`flex-shrink:0`でスクロール領域の外）が検証済みの構造を
 * そのままTailwindで再現する: 画面全体を`flex flex-col`の縦積み
 * コンテナとし、タイトル＋タブバーを`shrink-0`（スクロールしても動かない）、
 * 実際のボード内容はその下の`flex-1 overflow-y-auto`な領域（スクロールする側）
 * に閉じ込める。固定ヘッダーとスクロール領域は兄弟要素であり、タブバーが
 * スクロール領域の子になることはない
 * （観測可能な完了条件「ボード内をスクロールしてもタブ・ヘッダーが画面上部に
 * 固定表示され続ける」の実現方法。KitchenBoardScreen.test.tsxの構造検証と、
 * 実ブラウザでのスクロール確認の両方で裏付ける）。
 */

type ViewState =
  | { status: "checking-device" }
  | { status: "device-unavailable"; message: string }
  | { status: "ready"; storeId: string };

const NOT_PROVISIONED_MESSAGE =
  "このタブレットは厨房用デバイスとしてセットアップされていません。店舗スタッフにご確認のうえ、/setup/kitchen からセットアップしてください。";

const WRONG_ROLE_MESSAGE =
  "このタブレットは厨房用デバイスとして登録されていません（別の役割のデバイスとして登録済みです）。店舗スタッフにご確認ください。";

const GENERIC_DEVICE_ERROR_MESSAGE =
  "デバイスの確認中に予期しないエラーが発生しました。ネットワーク接続をご確認のうえ、画面を再読み込みしてください。";

// "food"は7.2でFoodBoard（実データ表示）へ置き換え済みのため対象外
// （下記レンダリング分岐参照）。ドリンク/売り切れは引き続き7.3/7.4が
// 実装するまでの簡易プレースホルダー文言のみ。
const PLACEHOLDER_TEXT: Record<Exclude<KitchenTabId, "food">, string> = {
  drink: "ドリンクボード（実装は7.3）",
  soldout: "売り切れボード（実装は7.4）",
};

export default function KitchenBoardScreen() {
  const [view, setView] = useState<ViewState>({ status: "checking-device" });
  const [activeTab, setActiveTab] = useState<KitchenTabId>("food");

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
        if (result.value.role !== "kitchen") {
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
        data-testid="kitchen-device-unavailable"
        className="flex h-screen flex-col items-center justify-center gap-3 bg-white px-6 text-center"
      >
        <h1 className="text-lg font-semibold text-neutral-900">
          厨房画面を利用できません
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

  const activeTabLabel =
    KITCHEN_TABS.find((tab) => tab.id === activeTab)?.label ?? "";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white">
      <header data-testid="kitchen-fixed-header" className="shrink-0">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-base font-semibold text-neutral-900">
            {activeTabLabel}
          </h1>
        </div>
        <KitchenTabs value={activeTab} onChange={setActiveTab} />
      </header>

      <div
        data-testid="kitchen-scroll-area"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        {activeTab === "food" ? (
          <FoodBoard storeId={view.storeId} />
        ) : (
          <p
            data-testid="kitchen-board-placeholder"
            className="p-4 text-sm text-neutral-500"
          >
            {PLACEHOLDER_TEXT[activeTab]}
          </p>
        )}
      </div>
    </div>
  );
}
