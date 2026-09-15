"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  createCustomerOrderingGateway,
  type MenuItemView,
} from "@/lib/gateways/customerOrderingGateway";
import GenreTabs, { type GenreFilter } from "./GenreTabs";
import MenuItemCard from "./MenuItemCard";
import OptionSelectionPanel, {
  type ItemSelection,
  type OptionValue,
} from "./OptionSelectionPanel";

type MenuScreenProps = {
  tableId: string;
};

type TableInfo = { id: string; label: string };

type ViewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "no-session"; table: TableInfo }
  | { status: "ready"; table: TableInfo; menu: ReadonlyArray<MenuItemView> };

/**
 * 送信前の1品目分の選択内容。実際の注文送信（submitOrder呼び出し、
 * design.mdのSubmitOrderInput.items相当への変換）は6.2の責務のため、
 * ここではCustomerOrderingGateway.submitOrderのitems要素にほぼ対応する形
 * （menuItemId/quantity/optionSelections/note）でローカルに保持するだけに
 * 留める。keyはカート内での一意な行識別用（同一品目でもオプション別に
 * 別明細として扱う要件1.8を6.2が実装しやすいよう、行ごとに独立させる）。
 */
export type CartLine = {
  key: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  optionSelections: Readonly<Record<string, OptionValue>>;
  note: string | null;
};

const GENERIC_ERROR_MESSAGE =
  "予期しないエラーが発生しました。ネットワーク接続をご確認のうえ、もう一度お試しください。";

/**
 * 客の卓側QR注文画面の実体（design.md CustomerOrderApp）。
 * page.tsxからtableIdを受け取り、CustomerOrderingGateway.getOrderingContext
 * のみに依存してメニュー閲覧・ジャンル別タブ・オプション選択UIを提供する
 * （タスク6.1のスコープ）。
 *
 * 注文送信・呼び出しボタン・アクティブセッション不在時の専用案内画面は
 * それぞれ6.2/6.3/6.4の責務であり、本コンポーネントはそれらを実装しない。
 * アクティブセッションが無い場合はクラッシュや空白画面を避けるための
 * 最小限の案内文のみを表示する（6.4が正式なUIを実装する前提）。
 */
export default function MenuScreen({ tableId }: MenuScreenProps) {
  const gateway = useMemo(
    () => createCustomerOrderingGateway(createBrowserClient()),
    [],
  );

  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [genreFilter, setGenreFilter] = useState<GenreFilter>("all");
  const [selectedItem, setSelectedItem] = useState<MenuItemView | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // tasks.md Implementation Notes: customerOrderingGatewayの各メソッドは
      // ドキュメント化されたエラーコード以外の予期しない失敗（ネットワーク断等）
      // をResultに含めず例外としてthrowする。Reactのイベントハンドラ/エフェクト
      // 内の非同期例外はエラーバウンダリが自動捕捉しないため、必ずここで
      // try/catchし、汎用エラーメッセージへ変換する。
      try {
        const result = await gateway.getOrderingContext({ tableId });
        if (cancelled) {
          return;
        }

        if (!result.ok) {
          // OrderingContextErrorは現時点で{code: "TABLE_NOT_FOUND"}の
          // 1メンバーのみの共用体。将来メンバーが増えた場合にも汎用エラーへ
          // フォールバックできるよう、既知のコードだけを個別メッセージへ
          // マッピングし、それ以外は汎用エラーメッセージにする
          // （網羅的switchではなくif/elseにしているのは、TypeScriptの
          // 制御フロー解析がswitch内のreturnだけでは`result`をこのif文の
          // 直後でok:trueへ確実に絞り込めない場合があるため。ここでは
          // if文自体が必ずreturnすることを単純な形で保証する）。
          const message =
            result.error.code === "TABLE_NOT_FOUND"
              ? "指定された卓が見つかりません。店員にお問い合わせください。"
              : GENERIC_ERROR_MESSAGE;
          setView({ status: "error", message });
          return;
        }

        const context = result.value;
        if (!context.activeSession) {
          setView({ status: "no-session", table: context.table });
          return;
        }

        setView({
          status: "ready",
          table: context.table,
          menu: context.menu,
        });
      } catch {
        if (!cancelled) {
          setView({ status: "error", message: GENERIC_ERROR_MESSAGE });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [gateway, tableId]);

  function handleSelectItem(item: MenuItemView) {
    setSelectedItem(item);
  }

  function handleCancelSelection() {
    setSelectedItem(null);
  }

  function handleConfirmSelection(selection: ItemSelection) {
    if (!selectedItem) {
      return;
    }
    setCart((prev) => [
      ...prev,
      {
        key: `${selectedItem.id}-${prev.length}-${Date.now()}`,
        menuItemId: selectedItem.id,
        name: selectedItem.name,
        unitPrice: selectedItem.price,
        quantity: selection.quantity,
        optionSelections: selection.optionSelections,
        note: null,
      },
    ]);
    setSelectedItem(null);
  }

  if (view.status === "loading") {
    return (
      <main className="p-4">
        <p>読み込み中...</p>
      </main>
    );
  }

  if (view.status === "error") {
    return (
      <main className="p-4">
        <h1 className="text-lg font-semibold">注文メニュー</h1>
        <p role="alert" className="mt-2 text-red-600">
          {view.message}
        </p>
      </main>
    );
  }

  if (view.status === "no-session") {
    // 要件1.3の完全な案内画面は6.4の責務。ここではクラッシュ・空白画面を
    // 避ける最小限の文言のみ表示する（tasks.md 6.1の指示に基づく意図的な
    // 割り切り）。
    return (
      <main className="p-4">
        <h1 className="text-lg font-semibold">ご案内をお待ちください</h1>
        <p className="mt-2 text-neutral-600">
          この卓はまだご案内前です。店員がご案内するまで少々お待ちください。
        </p>
      </main>
    );
  }

  const visibleMenu = view.menu.filter(
    (item) => genreFilter === "all" || item.genre === genreFilter,
  );

  return (
    <main className="min-h-screen bg-white pb-8">
      <header className="border-b border-neutral-100 px-4 py-3">
        <h1 className="text-lg font-semibold">注文メニュー</h1>
        <div className="mt-1 flex items-center gap-2">
          <span
            data-testid="table-label"
            className="rounded bg-neutral-100 px-2 py-0.5 text-sm text-neutral-600"
          >
            {view.table.label}
          </span>
          <span data-testid="cart-count" className="text-xs text-neutral-400">
            選択中の品目: {cart.length}件
          </span>
        </div>
      </header>

      <GenreTabs value={genreFilter} onChange={setGenreFilter} />

      <div>
        {visibleMenu.length === 0 ? (
          <p className="px-4 py-6 text-sm text-neutral-500">
            該当する品目がありません。
          </p>
        ) : (
          visibleMenu.map((item) => (
            <MenuItemCard key={item.id} item={item} onSelect={handleSelectItem} />
          ))
        )}
      </div>

      {selectedItem ? (
        <OptionSelectionPanel
          item={selectedItem}
          onCancel={handleCancelSelection}
          onConfirm={handleConfirmSelection}
        />
      ) : null}
    </main>
  );
}
