"use client";

/**
 * 厨房画面の3タブ（フードボード／ドリンクボード／売り切れボード）の
 * 切り替えバー（design.md KitchenBoard「フードボード／ドリンクボード／
 * 売り切れボードの3タブを1台のタブレットで切り替える」）。
 *
 * mock-preview.html（`#kitchenScreen`、`.tabs`/`.tab`クラス、`renderKitchen`
 * 関数の`titles`定数）が検証済みのタブ構成・ラベル文言をそのまま反映する。
 * 各タブの実際の内容（カンバン表示等）はKitchenBoardScreen側（および
 * 後続タスク7.2-7.4）が担い、本コンポーネントは選択状態の表示と切り替え
 * 通知のみを責務とする（src/app/order/[tableId]/GenreTabs.tsxと同じ
 * 「表示専用コンポーネントへの委譲」パターン）。
 */
export type KitchenTabId = "food" | "drink" | "soldout";

export const KITCHEN_TABS: ReadonlyArray<{ id: KitchenTabId; label: string }> =
  [
    { id: "food", label: "フードボード" },
    { id: "drink", label: "ドリンクボード" },
    { id: "soldout", label: "売り切れボード" },
  ];

type KitchenTabsProps = {
  value: KitchenTabId;
  onChange: (value: KitchenTabId) => void;
};

export default function KitchenTabs({ value, onChange }: KitchenTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="厨房ボードの切り替え"
      className="flex gap-1 overflow-x-auto border-b border-neutral-200 px-3"
    >
      {KITCHEN_TABS.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={
              "shrink-0 border-b-2 px-3 py-2 text-sm font-semibold transition-colors " +
              (selected
                ? "border-neutral-900 text-neutral-900"
                : "border-transparent text-neutral-500")
            }
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
