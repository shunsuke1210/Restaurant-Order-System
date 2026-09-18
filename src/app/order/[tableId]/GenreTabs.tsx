"use client";

import type { MenuItemGenre } from "@/lib/gateways/customerOrderingGateway";

/**
 * メニューのジャンル別タブ。
 *
 * mock-preview.html（#customerScreen、GENRES定数・menuHeaderHtml関数）が
 * 検証済みのUXを参考にした「おすすめ/一品/フード/ドリンク」構成。
 *
 * ## 「おすすめ」タブについて（当初見送り→spec完了後に追加、0016）
 * タスク6.1時点ではmenu_itemsに対応する列（recommendフラグ等）が存在せず、
 * 「おすすめ」タブの代わりに全品目を横断表示する「すべて」タブとしていた
 * （当時のCONCERNS）。spec完了後、実際にアプリを操作したユーザーの指摘で
 * menu_items.recommended列（0016マイグレーション）を追加し、本来のモック
 * 通り「おすすめ」タブを実装した。「すべて」タブは実用上の価値があるため
 * 削除せず残し、モックの4タブ構成に追加する形にした。
 */
export type GenreFilter = "all" | "recommended" | MenuItemGenre;

export const GENRE_TABS: ReadonlyArray<{ id: GenreFilter; label: string }> = [
  { id: "all", label: "すべて" },
  { id: "recommended", label: "おすすめ" },
  { id: "ippin", label: "一品" },
  { id: "food", label: "フード" },
  { id: "drink", label: "ドリンク" },
];

type GenreTabsProps = {
  value: GenreFilter;
  onChange: (value: GenreFilter) => void;
};

export default function GenreTabs({ value, onChange }: GenreTabsProps) {
  return (
    <div role="tablist" aria-label="メニューのジャンル" className="flex gap-2 overflow-x-auto px-4 py-2">
      {GENRE_TABS.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={
              "shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors " +
              (selected
                ? "bg-neutral-900 text-white"
                : "bg-neutral-100 text-neutral-600")
            }
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
