import type { ComponentProps } from "react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import TableDetailPanel from "./TableDetailPanel";
import type {
  MenuItemListing,
  TableBillingSummary,
} from "@/lib/gateways/staffOperationsGateway";

// TableDetailPanel（タスク8.2/8.3）のコンポーネントテスト。
// FloorMap（親、タスク8.1）が保持する`state.tables`から都度算出される
// `TableBillingSummary`と、check-in・品目追加・品目削除の各コールバック・
// 処理中フラグ・エラーメッセージのみをpropsとして受け取る純粋な
// プレゼンテーションコンポーネントとして、FloorMapから切り離してテストする
// （FloorMap.test.tsxはstartSession/addOrderItem/removeOrderItemの実際の
// 呼び出し・マージ・ポーリングとの競合など、FloorMap側の状態管理に関わる
// 結合的な振る舞いを担当する）。
//
// Requirements: 3.1, 3.2, 3.4, 5.1, 5.2, 5.3, 5.5, 5.6

let idCounter = 0;

function makeTable(
  overrides: Partial<TableBillingSummary> = {},
): TableBillingSummary {
  idCounter += 1;
  return {
    tableId: `table-${idCounter}`,
    tableLabel: `T${idCounter}`,
    activeSession: null,
    items: [],
    total: 0,
    hasOpenCallRequest: false,
    ...overrides,
  };
}

let itemIdCounter = 0;

function makeBillingItem(
  overrides: Partial<TableBillingSummary["items"][number]> = {},
): TableBillingSummary["items"][number] {
  itemIdCounter += 1;
  return {
    id: `order-item-${itemIdCounter}`,
    menuItemId: `menu-${itemIdCounter}`,
    name: `品目${itemIdCounter}`,
    quantity: 1,
    unitPrice: 100,
    optionsSummary: null,
    status: "received",
    // タスク8.4で追加（0014_list_register_feed_item_genre.sql）。
    genre: "food",
    ...overrides,
  };
}

let menuItemIdCounter = 0;

function makeMenuItem(overrides: Partial<MenuItemListing> = {}): MenuItemListing {
  menuItemIdCounter += 1;
  return {
    id: `menu-item-${menuItemIdCounter}`,
    name: `メニュー${menuItemIdCounter}`,
    price: 500,
    soldOut: false,
    genre: "food",
    imageUrl: null,
    options: [],
    ...overrides,
  };
}

type PanelProps = ComponentProps<typeof TableDetailPanel>;

function renderPanel(overrides: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    table: makeTable({ activeSession: null }),
    onClose: vi.fn(),
    onCheckIn: vi.fn(),
    submitting: false,
    checkInErrorMessage: null,
    menuItems: [],
    menuItemsLoadError: false,
    onAddItem: vi.fn().mockResolvedValue(undefined),
    addItemErrorMessage: null,
    onRemoveItem: vi.fn().mockResolvedValue(undefined),
    removeItemErrorMessage: null,
    onUpdateItemStatus: vi.fn().mockResolvedValue(undefined),
    updateStatusErrorMessage: null,
    // タスク8.5で追加。
    onCloseSession: vi.fn().mockResolvedValue(undefined),
    closeSessionErrorMessage: null,
    ...overrides,
  };
  render(<TableDetailPanel {...props} />);
  return props;
}

describe("TableDetailPanel", () => {
  afterEach(() => {
    vi.useRealTimers();
    idCounter = 0;
    itemIdCounter = 0;
    menuItemIdCounter = 0;
  });

  describe("空席の卓（要件3.1, 5.2）", () => {
    it("「空席です」の案内と入店ボタンを表示する", () => {
      const table = makeTable({ tableLabel: "T1", activeSession: null });
      renderPanel({ table });

      expect(screen.getByText(/空席です/)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "入店" }),
      ).toBeInTheDocument();
      // 会計対象の明細・合計は表示されない
      expect(
        screen.queryByTestId("register-table-detail-items"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("register-table-detail-total"),
      ).not.toBeInTheDocument();
    });

    it("「入店」を押すと人数入力ステッパー（デフォルト2）が表示される", () => {
      const table = makeTable({ activeSession: null });
      renderPanel({ table });

      fireEvent.click(screen.getByRole("button", { name: "入店" }));

      expect(screen.getByTestId("register-check-in-party-size")).toHaveTextContent(
        "2",
      );
      expect(
        screen.getByRole("button", { name: "キャンセル" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "入店する" }),
      ).toBeInTheDocument();
    });

    it("＋/−で人数を増減でき、1未満にはならない", () => {
      const table = makeTable({ activeSession: null });
      renderPanel({ table });

      fireEvent.click(screen.getByRole("button", { name: "入店" }));
      const partySize = screen.getByTestId("register-check-in-party-size");
      expect(partySize).toHaveTextContent("2");

      fireEvent.click(screen.getByRole("button", { name: "人数を増やす" }));
      expect(partySize).toHaveTextContent("3");

      fireEvent.click(screen.getByRole("button", { name: "人数を減らす" }));
      fireEvent.click(screen.getByRole("button", { name: "人数を減らす" }));
      expect(partySize).toHaveTextContent("1");

      // 下限（1）に到達した後、さらに減らそうとしても1のまま
      fireEvent.click(screen.getByRole("button", { name: "人数を減らす" }));
      expect(partySize).toHaveTextContent("1");
    });

    it("キャンセルを押すとonCheckInを呼び出さずに空席の初期表示へ戻る", () => {
      const onCheckIn = vi.fn();
      const table = makeTable({ activeSession: null });
      renderPanel({ table, onCheckIn });

      fireEvent.click(screen.getByRole("button", { name: "入店" }));
      fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

      expect(onCheckIn).not.toHaveBeenCalled();
      expect(screen.getByText(/空席です/)).toBeInTheDocument();
      expect(
        screen.queryByTestId("register-check-in-party-size"),
      ).not.toBeInTheDocument();
    });

    it("入店するを押すと現在の人数でonCheckInを呼び出す", () => {
      const onCheckIn = vi.fn();
      const table = makeTable({ activeSession: null });
      renderPanel({ table, onCheckIn });

      fireEvent.click(screen.getByRole("button", { name: "入店" }));
      fireEvent.click(screen.getByRole("button", { name: "人数を増やす" }));
      fireEvent.click(screen.getByRole("button", { name: "入店する" }));

      expect(onCheckIn).toHaveBeenCalledTimes(1);
      expect(onCheckIn).toHaveBeenCalledWith(3);
    });

    it("submitting中はキャンセル・入店するボタンが無効化される", () => {
      const table = makeTable({ activeSession: null });
      renderPanel({ table, submitting: true });

      fireEvent.click(screen.getByRole("button", { name: "入店" }));

      expect(screen.getByRole("button", { name: "キャンセル" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "処理中..." }),
      ).toBeDisabled();
    });

    it("checkInErrorMessageが指定されると警告として表示する（要件3.2）", () => {
      const table = makeTable({ activeSession: null });
      renderPanel({
        table,
        checkInErrorMessage: "既に有効な来店セッションが存在します。",
      });

      expect(screen.getByRole("alert")).toHaveTextContent(
        "既に有効な来店セッションが存在します。",
      );
    });
  });

  describe("来店中の卓（要件5.1）", () => {
    it("人数・経過時間・セッションIDを表示する", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T12:30:00.000Z"));

      const table = makeTable({
        activeSession: {
          id: "session-abc",
          startedAt: "2026-01-01T12:00:00.000Z",
          partySize: 4,
        },
      });
      renderPanel({ table });

      expect(
        screen.getByTestId("register-table-detail-occupancy"),
      ).toHaveTextContent("4名");
      expect(
        screen.getByTestId("register-table-detail-occupancy"),
      ).toHaveTextContent("30分");
      expect(screen.getByText(/session-abc/)).toBeInTheDocument();
    });

    it("注文明細（品目名・オプション概要・数量・単価×数量）と合計をtotalの値そのまま表示する（再計算しない）", () => {
      const table = makeTable({
        activeSession: {
          id: "s1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [
          makeBillingItem({
            name: "唐揚げ",
            quantity: 2,
            unitPrice: 500,
            optionsSummary: "わさび抜き",
            genre: "food",
            status: "done",
          }),
          makeBillingItem({
            name: "ビール",
            quantity: 1,
            unitPrice: 600,
            genre: "drink",
            status: "done",
          }),
        ],
        // items単純合計（500*2+600=1600）とは意図的に異なる値。
        total: 9999,
      });
      renderPanel({ table });

      const items = screen.getAllByTestId("register-table-detail-item");
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveTextContent("唐揚げ");
      expect(items[0]).toHaveTextContent("（わさび抜き）");
      expect(items[0]).toHaveTextContent("2");
      expect(items[0]).toHaveTextContent("¥1,000");
      expect(items[1]).toHaveTextContent("ビール");
      expect(items[1]).toHaveTextContent("¥600");

      expect(
        screen.getByTestId("register-table-detail-total"),
      ).toHaveTextContent("¥9,999");
      // 両品目ともdone状態のため、進めるボタンはいずれも表示されない
      // （タスク8.4の完全なボタン表示可否テーブルはdescribe
      // 「品目のステータス変更」で網羅する）。
      expect(screen.queryByRole("button", { name: "進める" })).not.toBeInTheDocument();
    });

    it("注文明細が無い場合はその旨を表示する", () => {
      const table = makeTable({
        activeSession: {
          id: "s1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [],
        total: 0,
      });
      renderPanel({ table });

      expect(screen.getByText(/まだ注文はありません/)).toBeInTheDocument();
    });

    it("呼び出し中の場合、案内バナーを表示する（対応ボタンは8.6のスコープのため表示しない）", () => {
      const table = makeTable({
        activeSession: {
          id: "s1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        hasOpenCallRequest: true,
      });
      renderPanel({ table });

      expect(screen.getByTestId("register-table-detail-call-banner")).toHaveTextContent(
        "呼び出し中",
      );
      expect(
        screen.queryByRole("button", { name: "対応済みにする" }),
      ).not.toBeInTheDocument();
    });

    it("呼び出しが無い場合バナーを表示しない", () => {
      const table = makeTable({
        activeSession: {
          id: "s1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        hasOpenCallRequest: false,
      });
      renderPanel({ table });

      expect(
        screen.queryByTestId("register-table-detail-call-banner"),
      ).not.toBeInTheDocument();
    });
  });

  // タスク8.3: 品目の削除UI（確認モーダル）。
  // Requirements: 5.6
  describe("品目の削除（タスク8.3、要件5.6）", () => {
    function occupiedTableWithItem(
      itemOverrides: Partial<TableBillingSummary["items"][number]> = {},
    ) {
      const item = makeBillingItem({
        name: "唐揚げ",
        quantity: 2,
        unitPrice: 500,
        optionsSummary: "わさび抜き",
        ...itemOverrides,
      });
      return {
        item,
        table: makeTable({
          activeSession: {
            id: "s1",
            startedAt: "2026-01-01T00:00:00.000Z",
            partySize: 2,
          },
          items: [item],
          total: 1000,
        }),
      };
    }

    it("「削除」を押すと確認モーダルが対象品目名（オプション概要付き）を表示する", () => {
      const { table } = occupiedTableWithItem();
      renderPanel({ table });

      fireEvent.click(
        screen.getByRole("button", { name: "唐揚げを削除" }),
      );

      const modal = screen.getByTestId("register-remove-confirm");
      expect(modal).toHaveTextContent("唐揚げ（わさび抜き）");
      expect(modal).toHaveTextContent("削除しますか");
    });

    it("確認モーダルの「いいえ」を選ぶと、onRemoveItemが呼ばれず、注文明細（画面表示・propsのtable）も変化しない（本タスクの観測可能な完了条件そのもの）", () => {
      const { table, item } = occupiedTableWithItem();
      const onRemoveItem = vi.fn().mockResolvedValue(undefined);
      renderPanel({ table, onRemoveItem });

      fireEvent.click(
        screen.getByRole("button", { name: "唐揚げを削除" }),
      );
      fireEvent.click(screen.getByTestId("register-remove-confirm-cancel"));

      expect(onRemoveItem).not.toHaveBeenCalled();
      expect(
        screen.queryByTestId("register-remove-confirm"),
      ).not.toBeInTheDocument();
      // 画面表示: 明細は変わらず1件のまま、同じ内容を表示し続ける。
      const items = screen.getAllByTestId("register-table-detail-item");
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveTextContent("唐揚げ");
      // 元のtableオブジェクト自体（親から渡されたデータ）も不変。
      expect(table.items).toEqual([item]);
      expect(table.total).toBe(1000);
    });

    it("確認モーダルで確認すると、onRemoveItemを対象のorderItemIdで呼び出す", async () => {
      const { table, item } = occupiedTableWithItem();
      const onRemoveItem = vi.fn().mockResolvedValue(undefined);
      renderPanel({ table, onRemoveItem });

      fireEvent.click(
        screen.getByRole("button", { name: "唐揚げを削除" }),
      );
      fireEvent.click(screen.getByTestId("register-remove-confirm-confirm"));

      expect(onRemoveItem).toHaveBeenCalledTimes(1);
      expect(onRemoveItem).toHaveBeenCalledWith(item.id);
    });

    it("削除確定中はモーダルのボタンが無効化され、応答が返ると閉じる", async () => {
      const { table } = occupiedTableWithItem();
      let resolveRemove!: () => void;
      const onRemoveItem = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveRemove = resolve;
          }),
      );
      renderPanel({ table, onRemoveItem });

      fireEvent.click(
        screen.getByRole("button", { name: "唐揚げを削除" }),
      );
      fireEvent.click(screen.getByTestId("register-remove-confirm-confirm"));

      expect(screen.getByTestId("register-remove-confirm-confirm")).toBeDisabled();
      expect(screen.getByTestId("register-remove-confirm-cancel")).toBeDisabled();

      resolveRemove();
      await screen.findByTestId("register-table-detail-panel");
      expect(
        screen.queryByTestId("register-remove-confirm"),
      ).not.toBeInTheDocument();
    });

    it("removeItemErrorMessageが指定されると警告として表示する", () => {
      const { table } = occupiedTableWithItem();
      renderPanel({
        table,
        removeItemErrorMessage: "品目の削除に失敗しました。もう一度お試しください。",
      });

      expect(
        screen.getByTestId("register-remove-item-error"),
      ).toHaveTextContent("品目の削除に失敗しました");
    });
  });

  // タスク8.3: 品目の追加UI（確認モーダル）。
  // Requirements: 5.5
  describe("品目の追加（タスク8.3、要件5.5）", () => {
    function occupiedTable(menuItems: ReadonlyArray<MenuItemListing>) {
      const table = makeTable({
        activeSession: {
          id: "s1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [],
        total: 0,
      });
      return { table, menuItems };
    }

    it("初期状態では品目追加リストを表示しない。トグルを押すと表示される", () => {
      const noOption = makeMenuItem({ name: "唐揚げ" });
      const { table, menuItems } = occupiedTable([noOption]);
      renderPanel({ table, menuItems });

      expect(
        screen.queryByTestId("register-add-menu-list"),
      ).not.toBeInTheDocument();

      fireEvent.click(
        screen.getByTestId("register-add-menu-toggle"),
      );

      expect(screen.getByTestId("register-add-menu-list")).toBeInTheDocument();
      expect(screen.getByTestId("register-add-menu-list")).toHaveTextContent(
        "唐揚げ",
      );
    });

    it("もう一度トグルを押すと閉じる", () => {
      const noOption = makeMenuItem({ name: "唐揚げ" });
      const { table, menuItems } = occupiedTable([noOption]);
      renderPanel({ table, menuItems });

      const toggle = screen.getByTestId("register-add-menu-toggle");
      fireEvent.click(toggle);
      fireEvent.click(toggle);

      expect(
        screen.queryByTestId("register-add-menu-list"),
      ).not.toBeInTheDocument();
    });

    it("ジャンル別にグループ化して表示する（一品→フード→ドリンクの順、該当なしのジャンルは表示しない）", () => {
      const drink = makeMenuItem({ name: "レモンサワー", genre: "drink" });
      const ippin = makeMenuItem({ name: "冷奴", genre: "ippin" });
      const { table, menuItems } = occupiedTable([drink, ippin]);
      renderPanel({ table, menuItems });

      fireEvent.click(screen.getByTestId("register-add-menu-toggle"));

      const list = screen.getByTestId("register-add-menu-list");
      const text = list.textContent ?? "";
      expect(text).not.toContain("フード");
      expect(text.indexOf("一品")).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("ドリンク")).toBeGreaterThan(text.indexOf("一品"));
      expect(text.indexOf("冷奴")).toBeGreaterThan(text.indexOf("一品"));
      expect(text.indexOf("レモンサワー")).toBeGreaterThan(
        text.indexOf("ドリンク"),
      );
    });

    it("売り切れ品目は視覚的に区別され、＋ボタンが無効化される（要件G）", () => {
      const soldOut = makeMenuItem({ name: "売り切れ品", soldOut: true });
      const { table, menuItems } = occupiedTable([soldOut]);
      renderPanel({ table, menuItems });

      fireEvent.click(screen.getByTestId("register-add-menu-toggle"));

      const addButton = screen.getByRole("button", {
        name: "売り切れ品を追加",
      });
      expect(addButton).toBeDisabled();
    });

    it("オプションを持たない品目の＋を押すと簡易確認モーダルが開き、確認するとonAddItemをquantity=1・optionSelections={}で呼び出す", async () => {
      const noOption = makeMenuItem({ name: "唐揚げ", price: 600 });
      const { table, menuItems } = occupiedTable([noOption]);
      const onAddItem = vi.fn().mockResolvedValue(undefined);
      renderPanel({ table, menuItems, onAddItem });

      fireEvent.click(screen.getByTestId("register-add-menu-toggle"));
      fireEvent.click(screen.getByRole("button", { name: "唐揚げを追加" }));

      const modal = screen.getByTestId("register-add-confirm");
      expect(modal).toHaveTextContent("「唐揚げ」を注文に追加しますか？");

      fireEvent.click(screen.getByTestId("register-add-confirm-confirm"));

      expect(onAddItem).toHaveBeenCalledTimes(1);
      expect(onAddItem).toHaveBeenCalledWith({
        menuItemId: noOption.id,
        quantity: 1,
        optionSelections: {},
      });
    });

    it("簡易確認モーダルの「いいえ」を選ぶとonAddItemを呼び出さない", () => {
      const noOption = makeMenuItem({ name: "唐揚げ" });
      const { table, menuItems } = occupiedTable([noOption]);
      const onAddItem = vi.fn().mockResolvedValue(undefined);
      renderPanel({ table, menuItems, onAddItem });

      fireEvent.click(screen.getByTestId("register-add-menu-toggle"));
      fireEvent.click(screen.getByRole("button", { name: "唐揚げを追加" }));
      fireEvent.click(screen.getByTestId("register-add-confirm-cancel"));

      expect(onAddItem).not.toHaveBeenCalled();
      expect(screen.queryByTestId("register-add-confirm")).not.toBeInTheDocument();
    });

    it("オプションを持つ品目の＋を押すとOptionSelectionPanel（客側から再利用）が開く", () => {
      const withOption = makeMenuItem({
        name: "ハイボール",
        options: [
          {
            id: "strength",
            type: "choice",
            label: "濃さ",
            choices: ["普通", "濃いめ"],
            default: "普通",
          },
        ],
      });
      const { table, menuItems } = occupiedTable([withOption]);
      renderPanel({ table, menuItems });

      fireEvent.click(screen.getByTestId("register-add-menu-toggle"));
      fireEvent.click(screen.getByRole("button", { name: "ハイボールを追加" }));

      expect(
        screen.getByRole("dialog", { name: "ハイボールのオプション選択" }),
      ).toBeInTheDocument();
      // オプションを持つ品目には簡易確認モーダルを出さない
      // （OptionSelectionPanelの「選択を確定」自体が確認ステップのため）。
      expect(
        screen.queryByTestId("register-add-confirm"),
      ).not.toBeInTheDocument();
    });

    it("OptionSelectionPanelで選択を確定すると、onAddItemを選択したoptionSelections/quantityで呼び出す", async () => {
      const withOption = makeMenuItem({
        name: "ハイボール",
        options: [
          {
            id: "strength",
            type: "choice",
            label: "濃さ",
            choices: ["普通", "濃いめ"],
            default: "普通",
          },
        ],
      });
      const { table, menuItems } = occupiedTable([withOption]);
      const onAddItem = vi.fn().mockResolvedValue(undefined);
      renderPanel({ table, menuItems, onAddItem });

      fireEvent.click(screen.getByTestId("register-add-menu-toggle"));
      fireEvent.click(screen.getByRole("button", { name: "ハイボールを追加" }));

      fireEvent.click(screen.getByRole("button", { name: "濃いめ" }));
      fireEvent.click(screen.getByRole("button", { name: "数量を増やす" }));
      fireEvent.click(screen.getByRole("button", { name: "選択を確定" }));

      expect(onAddItem).toHaveBeenCalledTimes(1);
      expect(onAddItem).toHaveBeenCalledWith({
        menuItemId: withOption.id,
        quantity: 2,
        optionSelections: { strength: "濃いめ" },
      });
    });

    it("OptionSelectionPanelのキャンセルでonAddItemを呼び出さずに閉じる", () => {
      const withOption = makeMenuItem({
        name: "ハイボール",
        options: [
          { id: "strength", type: "toggle", label: "濃いめ", default: false },
        ],
      });
      const { table, menuItems } = occupiedTable([withOption]);
      const onAddItem = vi.fn().mockResolvedValue(undefined);
      renderPanel({ table, menuItems, onAddItem });

      fireEvent.click(screen.getByTestId("register-add-menu-toggle"));
      fireEvent.click(screen.getByRole("button", { name: "ハイボールを追加" }));
      fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

      expect(onAddItem).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("dialog", { name: "ハイボールのオプション選択" }),
      ).not.toBeInTheDocument();
    });

    it("addItemErrorMessageが指定されると警告として表示する（ITEM_SOLD_OUTレースを含む）", () => {
      const { table, menuItems } = occupiedTable([]);
      renderPanel({
        table,
        menuItems,
        addItemErrorMessage:
          "この品目は現在売り切れのため追加できませんでした。品目一覧をご確認ください。",
      });

      expect(screen.getByTestId("register-add-item-error")).toHaveTextContent(
        "売り切れ",
      );
    });

    it("menuItemsLoadErrorが真の場合、追加リストにエラーメッセージを表示する", () => {
      const { table } = occupiedTable([]);
      renderPanel({ table, menuItems: [], menuItemsLoadError: true });

      fireEvent.click(screen.getByTestId("register-add-menu-toggle"));

      expect(screen.getByTestId("register-add-menu-list")).toHaveTextContent(
        "取得に失敗",
      );
    });
  });

  // タスク8.4: 品目ステータス変更UI（確認モーダル）。
  // Requirements: 5.7
  describe("品目のステータス変更（タスク8.4、要件5.7）", () => {
    function occupiedTableWithItem(
      itemOverrides: Partial<TableBillingSummary["items"][number]> = {},
    ) {
      const item = makeBillingItem({
        name: "唐揚げ",
        genre: "food",
        status: "received",
        ...itemOverrides,
      });
      return {
        item,
        table: makeTable({
          activeSession: {
            id: "s1",
            startedAt: "2026-01-01T00:00:00.000Z",
            partySize: 2,
          },
          items: [item],
          total: item.unitPrice * item.quantity,
        }),
      };
    }

    // ジャンル×現在ステータス→ステータス表示ラベル・進めるボタン表示可否の
    // 全数テーブル（tasks.md「Testing requirements」が要求する網羅テスト）。
    // mock-preview.htmlのstatusLabel(genre, status)と一致させる。
    const STATUS_DISPLAY_TABLE: ReadonlyArray<{
      genre: "food" | "ippin" | "drink";
      status: "received" | "in_progress" | "done";
      label: string;
      hasAdvanceButton: boolean;
    }> = [
      { genre: "food", status: "received", label: "未対応", hasAdvanceButton: true },
      { genre: "food", status: "in_progress", label: "調理中", hasAdvanceButton: true },
      { genre: "food", status: "done", label: "調理完了", hasAdvanceButton: false },
      { genre: "ippin", status: "received", label: "未対応", hasAdvanceButton: true },
      { genre: "ippin", status: "in_progress", label: "調理中", hasAdvanceButton: true },
      { genre: "ippin", status: "done", label: "調理完了", hasAdvanceButton: false },
      { genre: "drink", status: "received", label: "未対応", hasAdvanceButton: true },
      { genre: "drink", status: "done", label: "対応済み", hasAdvanceButton: false },
    ];

    it.each(STATUS_DISPLAY_TABLE)(
      "genre=$genre, status=$status のとき、ステータス表示は「$label」、進めるボタンの表示は$hasAdvanceButton",
      ({ genre, status, label, hasAdvanceButton }) => {
        const { table } = occupiedTableWithItem({ genre, status });
        renderPanel({ table });

        expect(
          screen.getByTestId("register-table-detail-item-status"),
        ).toHaveTextContent(label);
        if (hasAdvanceButton) {
          expect(
            screen.getByTestId("register-table-detail-item-advance"),
          ).toBeInTheDocument();
        } else {
          expect(
            screen.queryByTestId("register-table-detail-item-advance"),
          ).not.toBeInTheDocument();
        }
      },
    );

    it("「進める」を押すと確認モーダルが対象品目名と次ステータスラベルを表示する", () => {
      const { table } = occupiedTableWithItem({
        genre: "food",
        status: "received",
      });
      renderPanel({ table });

      fireEvent.click(
        screen.getByRole("button", { name: "唐揚げのステータスを進める" }),
      );

      const modal = screen.getByTestId("register-status-confirm");
      expect(modal).toHaveTextContent("唐揚げ");
      expect(modal).toHaveTextContent("調理中");
    });

    it("確認モーダルの「いいえ」を選ぶと、onUpdateItemStatusが呼ばれず、ステータス表示（画面表示・propsのtable）も変化しない（本タスクの完了条件の裏面、要件5.7と対称）", () => {
      const { table, item } = occupiedTableWithItem({
        genre: "food",
        status: "received",
      });
      const onUpdateItemStatus = vi.fn().mockResolvedValue(undefined);
      renderPanel({ table, onUpdateItemStatus });

      fireEvent.click(
        screen.getByRole("button", { name: "唐揚げのステータスを進める" }),
      );
      fireEvent.click(screen.getByTestId("register-status-confirm-cancel"));

      expect(onUpdateItemStatus).not.toHaveBeenCalled();
      expect(
        screen.queryByTestId("register-status-confirm"),
      ).not.toBeInTheDocument();
      // 画面表示: ステータス表示は変わらず「未対応」のまま。
      expect(
        screen.getByTestId("register-table-detail-item-status"),
      ).toHaveTextContent("未対応");
      // 元のtableオブジェクト自体（親から渡されたデータ）も不変。
      expect(table.items).toEqual([item]);
    });

    it("確認モーダルで確認すると、onUpdateItemStatusを対象のorderItemIdと次ステータスで呼び出す（本タスクの観測可能な完了条件の呼び出し側検証）", async () => {
      const { table, item } = occupiedTableWithItem({
        genre: "food",
        status: "received",
      });
      const onUpdateItemStatus = vi.fn().mockResolvedValue(undefined);
      renderPanel({ table, onUpdateItemStatus });

      fireEvent.click(
        screen.getByRole("button", { name: "唐揚げのステータスを進める" }),
      );
      fireEvent.click(screen.getByTestId("register-status-confirm-confirm"));

      expect(onUpdateItemStatus).toHaveBeenCalledTimes(1);
      expect(onUpdateItemStatus).toHaveBeenCalledWith(item.id, "in_progress");
    });

    it("ドリンク品目の「進める」確認は次ステータスdoneをonUpdateItemStatusへ渡す（in_progressを経由しない、要件6.4相当の境界）", () => {
      const { item } = occupiedTableWithItem({
        genre: "drink",
        status: "received",
        name: "レモンサワー",
      });
      const table = makeTable({
        activeSession: {
          id: "s1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [item],
        total: item.unitPrice,
      });
      const onUpdateItemStatus = vi.fn().mockResolvedValue(undefined);
      renderPanel({ table, onUpdateItemStatus });

      fireEvent.click(
        screen.getByRole("button", { name: "レモンサワーのステータスを進める" }),
      );
      fireEvent.click(screen.getByTestId("register-status-confirm-confirm"));

      expect(onUpdateItemStatus).toHaveBeenCalledWith(item.id, "done");
    });

    it("ステータス変更確定中はモーダルのボタンが無効化され、応答が返ると閉じる", async () => {
      const { table } = occupiedTableWithItem({
        genre: "food",
        status: "received",
      });
      let resolveUpdate!: () => void;
      const onUpdateItemStatus = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveUpdate = resolve;
          }),
      );
      renderPanel({ table, onUpdateItemStatus });

      fireEvent.click(
        screen.getByRole("button", { name: "唐揚げのステータスを進める" }),
      );
      fireEvent.click(screen.getByTestId("register-status-confirm-confirm"));

      expect(
        screen.getByTestId("register-status-confirm-confirm"),
      ).toBeDisabled();
      expect(
        screen.getByTestId("register-status-confirm-cancel"),
      ).toBeDisabled();

      resolveUpdate();
      await screen.findByTestId("register-table-detail-panel");
      expect(
        screen.queryByTestId("register-status-confirm"),
      ).not.toBeInTheDocument();
    });

    it("updateStatusErrorMessageが指定されると警告として表示する（INVALID_TRANSITION等の汎用メッセージ）", () => {
      const { table } = occupiedTableWithItem();
      renderPanel({
        table,
        updateStatusErrorMessage:
          "ステータスの更新に失敗しました。もう一度お試しください。",
      });

      expect(
        screen.getByTestId("register-update-status-error"),
      ).toHaveTextContent("ステータスの更新に失敗しました");
    });
  });

  // タスク8.5: 会計操作（確認モーダル・セッション終了）。
  // Requirements: 3.3
  describe("会計操作（タスク8.5、要件3.3）", () => {
    function occupiedTable(overrides: Partial<TableBillingSummary> = {}) {
      return makeTable({
        activeSession: {
          id: "session-checkout-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [],
        total: 0,
        ...overrides,
      });
    }

    const CHECKOUT_CONFIRM_MESSAGE =
      "お会計完了でよろしいですか？完了するとQRコード情報がリセットされます";

    it("空席の卓には会計（退店）ボタンを表示しない", () => {
      const table = makeTable({ activeSession: null });
      renderPanel({ table });

      expect(
        screen.queryByRole("button", { name: "会計（退店）" }),
      ).not.toBeInTheDocument();
    });

    it("来店中の卓には会計（退店）ボタンを表示する", () => {
      const table = occupiedTable();
      renderPanel({ table });

      expect(
        screen.getByRole("button", { name: "会計（退店）" }),
      ).toBeInTheDocument();
    });

    it("会計（退店）を押すと、タスク文書に明記された文言そのままの確認モーダルが表示される", () => {
      const table = occupiedTable();
      renderPanel({ table });

      fireEvent.click(screen.getByRole("button", { name: "会計（退店）" }));

      const modal = screen.getByTestId("register-checkout-confirm");
      expect(modal).toHaveTextContent(CHECKOUT_CONFIRM_MESSAGE);
    });

    it("確認モーダルの「いいえ」を選ぶと、onCloseSessionが呼ばれず、パネルは開いたまま卓は来店中のまま変化しない（本タスクの観測可能な完了条件の裏面）", () => {
      const table = occupiedTable();
      const onCloseSession = vi.fn().mockResolvedValue(undefined);
      renderPanel({ table, onCloseSession });

      fireEvent.click(screen.getByRole("button", { name: "会計（退店）" }));
      fireEvent.click(screen.getByTestId("register-checkout-confirm-cancel"));

      expect(onCloseSession).not.toHaveBeenCalled();
      expect(
        screen.queryByTestId("register-checkout-confirm"),
      ).not.toBeInTheDocument();
      // パネル自体は開いたまま（onCloseは呼ばれない）で、卓は引き続き
      // 来店中の表示のまま（会計対象の明細・合計欄が表示され続ける）。
      expect(
        screen.getByTestId("register-table-detail-panel"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("register-table-detail-occupancy"),
      ).toBeInTheDocument();
    });

    it("確認モーダルで確認すると、onCloseSessionを呼び出す", () => {
      const table = occupiedTable();
      const onCloseSession = vi.fn().mockResolvedValue(undefined);
      renderPanel({ table, onCloseSession });

      fireEvent.click(screen.getByRole("button", { name: "会計（退店）" }));
      fireEvent.click(screen.getByTestId("register-checkout-confirm-confirm"));

      expect(onCloseSession).toHaveBeenCalledTimes(1);
    });

    it("会計確定中はモーダルのボタンが無効化され、応答が返ると閉じる", async () => {
      const table = occupiedTable();
      let resolveClose!: () => void;
      const onCloseSession = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveClose = resolve;
          }),
      );
      renderPanel({ table, onCloseSession });

      fireEvent.click(screen.getByRole("button", { name: "会計（退店）" }));
      fireEvent.click(screen.getByTestId("register-checkout-confirm-confirm"));

      expect(
        screen.getByTestId("register-checkout-confirm-confirm"),
      ).toBeDisabled();
      expect(
        screen.getByTestId("register-checkout-confirm-cancel"),
      ).toBeDisabled();

      resolveClose();
      await screen.findByTestId("register-table-detail-panel");
      expect(
        screen.queryByTestId("register-checkout-confirm"),
      ).not.toBeInTheDocument();
    });

    it("closeSessionErrorMessageが指定されると警告として表示する（SESSION_NOT_ACTIVE等の汎用メッセージ、要件E）", () => {
      const table = occupiedTable();
      renderPanel({
        table,
        closeSessionErrorMessage:
          "このセッションは既に会計処理済みです。卓マップの表示をご確認ください。",
      });

      expect(
        screen.getByTestId("register-checkout-error"),
      ).toHaveTextContent("既に会計処理済み");
    });
  });

  it("閉じるボタンでonCloseを呼び出す", () => {
    const onClose = vi.fn();
    const table = makeTable({ activeSession: null });
    renderPanel({ table, onClose });

    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("卓ラベルをヘッダーに表示する", () => {
    const table = makeTable({ tableLabel: "C2", activeSession: null });
    renderPanel({ table });

    expect(within(screen.getByTestId("register-table-detail-panel")).getByText("C2")).toBeInTheDocument();
  });
});
