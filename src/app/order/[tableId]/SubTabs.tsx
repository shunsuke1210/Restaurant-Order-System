"use client";

/**
 * ジャンル内のサブタブ（例: 一品→おつまみ/サラダ、フード→刺身/焼き物/
 * ご飯もの、ドリンク→ソフトドリンク/ノンアルコール/ビール・ハイボール/
 * サワー/その他）。
 *
 * mock-preview.htmlのSUBTABS定数はジャンルごとに固定のサブカテゴリ一覧を
 * ハードコードしていたが、本コンポーネントは`menu_items.sub_category`
 * （0016マイグレーションで追加）の実際の値からサブタブ一覧を動的に導出する
 * （フロントエンドにメニュー構成をハードコードしない。店主がサブカテゴリを
 * 追加・変更してもフロントエンドの変更が不要になる）。並び順は、渡された
 * `items`配列（GenreTabsで絞り込んだ後の、get_ordering_contextが返す順序
 * ＝品目名順）の中で各sub_categoryが最初に現れた順を採用する
 * （「サーバーが返す順序を信頼し、フロントエンドで独自にソートし直さない」
 * という本specで一貫している方針、tasks.md Implementation Notes参照）。
 *
 * sub_categoryを持たない品目（null）は、どのサブタブにも属さない
 * （「すべて」相当のサブタブは設けない——親のジャンルタブ自体が既に
 * 「すべて」の役割を持つため、二重に「すべて」を用意しない）。
 * 現在選択中のジャンルにsub_categoryを持つ品目が1件も無い場合は、
 * サブタブ自体を描画しない（空のタブ行を表示しない）。
 */

export type SubTabFilter = string | null;

type SubTabsProps = {
  items: ReadonlyArray<{ subCategory: string | null }>;
  value: SubTabFilter;
  onChange: (value: SubTabFilter) => void;
};

export default function SubTabs({ items, value, onChange }: SubTabsProps) {
  const subCategories: string[] = [];
  for (const item of items) {
    if (item.subCategory && !subCategories.includes(item.subCategory)) {
      subCategories.push(item.subCategory);
    }
  }

  if (subCategories.length === 0) {
    return null;
  }

  return (
    <div
      role="tablist"
      aria-label="サブカテゴリ"
      className="flex gap-1.5 overflow-x-auto border-t border-neutral-50 px-4 py-1.5"
    >
      {subCategories.map((subCategory) => {
        const selected = subCategory === value;
        return (
          <button
            key={subCategory}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(selected ? null : subCategory)}
            className={
              "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors " +
              (selected
                ? "bg-neutral-700 text-white"
                : "bg-neutral-50 text-neutral-500")
            }
          >
            {subCategory}
          </button>
        );
      })}
    </div>
  );
}
