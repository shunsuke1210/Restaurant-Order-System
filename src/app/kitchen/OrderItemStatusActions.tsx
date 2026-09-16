import type { OrderItemStatus } from "@/lib/gateways/customerOrderingGateway";
import type { KitchenFeedItem } from "./FoodBoard";

/**
 * OrderItemStatusActions — 品目カード下部に表示するステータス更新ボタン
 * 群。FoodBoard.tsx（フード/一品ジャンル）・DrinkBoard.tsx（ドリンク
 * ジャンル）の両方から、カードごとに1回呼び出される（タスク7.5）。
 *
 * Requirements: 6.1, 6.2, 6.5, 6.6
 * Design: .kiro/specs/table-order-kitchen/design.md「StaffOperationsGateway」
 *   `updateOrderItemStatus`の許可遷移表（フード/一品:
 *   received → in_progress → done、ドリンク: received → done。一品のみ
 *   received → doneの直接遷移も可、要件6.6）。
 * Mock: mock-preview.htmlの`kanbanHtml`（`FOOD_STATES`/`DRINK_STATES`の
 *   `actionLabel`、一品のreceived列のみ「開始」「完了」の2ボタンを並べる
 *   構造）を参照した検証済みUXパターン。文言自体は本タスクの指示に従い
 *   「調理開始」「調理完了」「直接完了」「対応完了」というより明示的な
 *   表現を採用する（mock-previewの短縮表記から変更。SoldOutBoard.tsxの
 *   「売り切れにする」等、既存の完全な動詞表現に揃える）。
 *
 * ## 確認モーダルを設けない（要件6.5、SoldOutBoard.tsxとの意図的な非対称性）
 * クリックすると`onAdvance`を即座に呼び出す。SoldOutBoard.tsx（7.4）の
 * ような確認ダイアログは経由しない（useAdvanceOrderItemStatus.ts冒頭
 * コメント参照）。
 *
 * ## ボタン構成の算出（`resolveActions`）
 * 「未対応→調理完了への直接遷移」（一品のみ、要件6.6）を除けば、常に
 * 高々1個の「次のステータスへ進める」ボタン（`advance`）のみを持つ。
 * 一品ジャンルの未対応状態のみ、これに加えて直接完了ショートカット
 * （`shortcut`）を並べる。`done`状態およびドリンクの`in_progress`
 * （構造上到達しない、DrinkBoard.tsx冒頭コメント参照）では空配列を返し、
 * 呼び出し側は何も描画しない。
 */

type OrderItemStatusActionsProps = {
  item: KitchenFeedItem;
  pending: boolean;
  onAdvance: (item: KitchenFeedItem, nextStatus: OrderItemStatus) => void;
};

type Action = {
  key: "advance" | "shortcut";
  label: string;
  nextStatus: OrderItemStatus;
};

function resolveActions(item: KitchenFeedItem): ReadonlyArray<Action> {
  if (item.status === "done") {
    return [];
  }

  if (item.genre === "drink") {
    if (item.status !== "received") {
      // ドリンク品目のstatusはreceived/doneの2値しか実際には取り得ない
      // （DrinkBoard.tsx冒頭コメント「列構成について」参照）ための防御的分岐。
      return [];
    }
    return [{ key: "advance", label: "対応完了", nextStatus: "done" }];
  }

  // food または ippin ジャンル。
  if (item.status === "received") {
    const actions: Action[] = [
      { key: "advance", label: "調理開始", nextStatus: "in_progress" },
    ];
    if (item.genre === "ippin") {
      // 要件6.6: 一品ジャンルは未対応→調理完了への直接遷移を、通常の
      // 段階的操作に加えて提供する。
      actions.push({ key: "shortcut", label: "直接完了", nextStatus: "done" });
    }
    return actions;
  }

  // in_progress → done（フード/一品共通）。
  return [{ key: "advance", label: "調理完了", nextStatus: "done" }];
}

const ADVANCE_BUTTON_CLASS =
  "flex-1 rounded-md bg-neutral-900 px-2 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50";
const SHORTCUT_BUTTON_CLASS =
  "flex-1 rounded-md border border-neutral-300 px-2 py-1.5 text-[11px] font-semibold text-neutral-700 disabled:opacity-50";

export default function OrderItemStatusActions({
  item,
  pending,
  onAdvance,
}: OrderItemStatusActionsProps) {
  const actions = resolveActions(item);

  if (actions.length === 0) {
    return null;
  }

  return (
    <div className="mt-1 flex gap-1">
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          data-testid={`order-item-action-${action.key}`}
          onClick={() => onAdvance(item, action.nextStatus)}
          disabled={pending}
          className={
            action.key === "advance"
              ? ADVANCE_BUTTON_CLASS
              : SHORTCUT_BUTTON_CLASS
          }
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
