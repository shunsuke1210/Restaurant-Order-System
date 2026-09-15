"use client";

import type { MenuItemView } from "@/lib/gateways/customerOrderingGateway";
import { formatYen } from "./formatYen";

type MenuItemCardProps = {
  item: MenuItemView;
  onSelect: (item: MenuItemView) => void;
};

/**
 * メニュー品目1件分のカード。
 *
 * 要件1.4「品目が売り切れ登録されている場合、選択不可として表示する」の
 * 観測可能な完了条件（売り切れ品目がグレーアウトされ選択操作ができない）を
 * 満たすため、soldOutの場合はネイティブの<button disabled>を用いる。
 * disabled属性を持つbuttonはクリックイベント自体を発火しない
 * （jsdom/ブラウザ双方の標準動作）ため、見た目のグレーアウトに加えて
 * 実際に操作不能であることをDOMレベルで保証する。念のためonClickも
 * 渡さない（disabledの二重の安全策）。
 */
export default function MenuItemCard({ item, onSelect }: MenuItemCardProps) {
  const { soldOut } = item;

  return (
    <button
      type="button"
      disabled={soldOut}
      aria-disabled={soldOut}
      onClick={soldOut ? undefined : () => onSelect(item)}
      className={
        "flex w-full items-center gap-3 border-b border-neutral-100 px-4 py-3 text-left last:border-b-0 " +
        (soldOut
          ? "cursor-not-allowed grayscale opacity-50"
          : "cursor-pointer hover:bg-neutral-50")
      }
    >
      {item.imageUrl ? (
        // 任意のリモートURL（Supabase Storage等）をnext/imageのドメイン
        // 許可リスト設定なしで表示するため、素の<img>を用いる。
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.imageUrl}
          alt={item.name}
          className="h-16 w-16 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div
          data-testid="photo-placeholder"
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md bg-neutral-200 text-2xl"
          aria-hidden="true"
        >
          🍽️
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 font-medium text-neutral-900">
          <span className={soldOut ? "line-through" : undefined}>
            {item.name}
          </span>
          {soldOut ? (
            <span className="shrink-0 rounded bg-neutral-500 px-1.5 py-0.5 text-xs text-white">
              売り切れ
            </span>
          ) : null}
        </p>
        <p className="text-sm text-neutral-500">{formatYen(item.price)}</p>
      </div>
      {!soldOut ? (
        <span aria-hidden="true" className="text-neutral-300">
          ›
        </span>
      ) : null}
    </button>
  );
}
