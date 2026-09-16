import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import SoldOutBoard from "./SoldOutBoard";
import type { MenuItemListing } from "@/lib/gateways/staffOperationsGateway";

// SoldOutBoard（タスク7.4、売り切れボードの検索・サマリー・確認モーダル）の
// コンポーネントテスト。staffOperationsGatewayをモックし、実DBには接続しない
// （FoodBoard.test.tsx/DrinkBoard.test.tsxと同じ方式）。
//
// 本タスクの観測可能な完了条件（tasks.md）: 「売り切れ切り替え操作で確認
// モーダルの『いいえ』を選ぶと状態が変化しない」。本テストの核心的な関心事は
// これをmockの呼び出し回数（setSoldOutが呼ばれていないこと）で厳密に
// 実証することである（UIの見た目だけでなく、実際に書き込みRPCが呼ばれて
// いないことまで確認する）。
//
// Requirements: 7.1, 7.3, 7.4

const mockListMenuItems = vi.fn();
const mockSetSoldOut = vi.fn();

vi.mock("@/lib/gateways/staffOperationsGateway", () => ({
  createStaffOperationsGateway: () => ({
    listMenuItems: (...args: unknown[]) => mockListMenuItems(...args),
    setSoldOut: (...args: unknown[]) => mockSetSoldOut(...args),
  }),
}));

let idCounter = 0;

function makeItem(overrides: Partial<MenuItemListing> = {}): MenuItemListing {
  idCounter += 1;
  return {
    id: `item-${idCounter}`,
    name: `品目${idCounter}`,
    price: 500,
    soldOut: false,
    genre: "food",
    // タスク8.3でMenuItemListingへ追加されたフィールド（レジの品目追加
    // フローがOptionSelectionPanel.tsxを再利用するために必要。
    // staffOperationsGateway.ts参照）。SoldOutBoard.tsx自体はこれらを
    // 参照しないが、型を満たすためのデフォルト値を用意する。
    imageUrl: null,
    options: [],
    ...overrides,
  };
}

describe("SoldOutBoard", () => {
  beforeEach(() => {
    idCounter = 0;
    mockListMenuItems.mockReset();
    mockSetSoldOut.mockReset();
  });

  it("品目一覧を表示し、各行に名前・価格・現在の売り切れ状態を示す", async () => {
    const available = makeItem({ name: "唐揚げ", price: 600, soldOut: false });
    const soldOut = makeItem({ name: "レモンサワー", price: 400, soldOut: true });

    mockListMenuItems.mockResolvedValue({ ok: true, value: [available, soldOut] });

    render(<SoldOutBoard storeId="store-1" />);

    expect(await screen.findByTestId("soldout-board")).toBeInTheDocument();
    expect(mockListMenuItems).toHaveBeenCalledWith({ storeId: "store-1" });

    const rows = screen.getAllByTestId("soldout-item-row");
    expect(rows).toHaveLength(2);

    const availableRow = rows.find((row) =>
      within(row).queryByText("唐揚げ"),
    )!;
    expect(within(availableRow).getByText("¥600")).toBeInTheDocument();
    expect(
      within(availableRow).getByTestId("soldout-toggle"),
    ).toHaveAttribute("aria-pressed", "false");

    const soldOutRow = rows.find((row) =>
      within(row).queryByText("レモンサワー"),
    )!;
    expect(within(soldOutRow).getByText("¥400")).toBeInTheDocument();
    expect(within(soldOutRow).getByTestId("soldout-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("検索入力で品目名によるフィルタが機能する", async () => {
    const karaage = makeItem({ name: "唐揚げ" });
    const lemonSour = makeItem({ name: "レモンサワー" });

    mockListMenuItems.mockResolvedValue({
      ok: true,
      value: [karaage, lemonSour],
    });

    render(<SoldOutBoard storeId="store-1" />);
    await screen.findByTestId("soldout-board");

    expect(screen.getAllByTestId("soldout-item-row")).toHaveLength(2);

    fireEvent.change(screen.getByTestId("soldout-search"), {
      target: { value: "唐揚" },
    });

    const rows = screen.getAllByTestId("soldout-item-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("唐揚げ")).toBeInTheDocument();
  });

  it("検索結果が0件の場合、案内文を表示し行は表示されない", async () => {
    mockListMenuItems.mockResolvedValue({
      ok: true,
      value: [makeItem({ name: "唐揚げ" })],
    });

    render(<SoldOutBoard storeId="store-1" />);
    await screen.findByTestId("soldout-board");

    fireEvent.change(screen.getByTestId("soldout-search"), {
      target: { value: "存在しない品目名" },
    });

    expect(screen.queryByTestId("soldout-item-row")).not.toBeInTheDocument();
    expect(screen.getByText("該当する品目がありません")).toBeInTheDocument();
  });

  it("サマリーは現在売り切れ中の件数を表示する", async () => {
    mockListMenuItems.mockResolvedValue({
      ok: true,
      value: [
        makeItem({ soldOut: true }),
        makeItem({ soldOut: true }),
        makeItem({ soldOut: false }),
      ],
    });

    render(<SoldOutBoard storeId="store-1" />);

    expect(await screen.findByTestId("soldout-summary")).toHaveTextContent(
      "現在売り切れ中：2品",
    );
  });

  it("トグルをタップすると確認モーダルが開き、即座にはsetSoldOutを呼び出さない", async () => {
    mockListMenuItems.mockResolvedValue({
      ok: true,
      value: [makeItem({ name: "唐揚げ", soldOut: false })],
    });

    render(<SoldOutBoard storeId="store-1" />);
    await screen.findByTestId("soldout-board");

    expect(screen.queryByTestId("soldout-confirm-modal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("soldout-toggle"));

    expect(await screen.findByTestId("soldout-confirm-modal")).toBeInTheDocument();
    expect(screen.getByText("「唐揚げ」を売り切れにしますか？")).toBeInTheDocument();
    expect(mockSetSoldOut).not.toHaveBeenCalled();
  });

  it("既に売り切れの品目をタップすると、解除の確認文言・ボタンラベルになる", async () => {
    mockListMenuItems.mockResolvedValue({
      ok: true,
      value: [makeItem({ name: "レモンサワー", soldOut: true })],
    });

    render(<SoldOutBoard storeId="store-1" />);
    await screen.findByTestId("soldout-board");

    fireEvent.click(screen.getByTestId("soldout-toggle"));

    expect(
      await screen.findByText("「レモンサワー」の売り切れを解除しますか？"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("soldout-confirm-ok")).toHaveTextContent(
      "解除する",
    );
  });

  it(
    "観測可能な完了条件: 確認モーダルの「いいえ」を選ぶと状態が変化せず、" +
      "setSoldOutは一切呼び出されない",
    async () => {
      const item = makeItem({ name: "唐揚げ", soldOut: false });
      mockListMenuItems.mockResolvedValue({ ok: true, value: [item] });

      render(<SoldOutBoard storeId="store-1" />);
      await screen.findByTestId("soldout-board");

      fireEvent.click(screen.getByTestId("soldout-toggle"));
      await screen.findByTestId("soldout-confirm-modal");

      fireEvent.click(screen.getByTestId("soldout-confirm-cancel"));

      expect(screen.queryByTestId("soldout-confirm-modal")).not.toBeInTheDocument();
      expect(mockSetSoldOut).not.toHaveBeenCalled();
      // 表示状態も変化していない（引き続き「売り切れにする」表示、
      // aria-pressed=false のまま）。
      expect(screen.getByTestId("soldout-toggle")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(screen.getByTestId("soldout-toggle")).toHaveTextContent(
        "売り切れにする",
      );
    },
  );

  it("確認モーダルで確定すると、setSoldOutが正しい引数で呼び出され、表示状態が更新される", async () => {
    const item = makeItem({
      id: "menu-1",
      name: "唐揚げ",
      soldOut: false,
    });
    mockListMenuItems.mockResolvedValue({ ok: true, value: [item] });
    mockSetSoldOut.mockResolvedValue({
      ok: true,
      value: {
        id: "menu-1",
        storeId: "store-1",
        name: "唐揚げ",
        price: 500,
        soldOut: true,
      },
    });

    render(<SoldOutBoard storeId="store-1" />);
    await screen.findByTestId("soldout-board");

    fireEvent.click(screen.getByTestId("soldout-toggle"));
    await screen.findByTestId("soldout-confirm-modal");

    fireEvent.click(screen.getByTestId("soldout-confirm-ok"));

    expect(mockSetSoldOut).toHaveBeenCalledWith({
      menuItemId: "menu-1",
      soldOut: true,
    });

    // モーダルが閉じ、表示状態がサーバー応答どおりに更新される。
    await vi.waitFor(() => {
      expect(
        screen.queryByTestId("soldout-confirm-modal"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("soldout-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("soldout-toggle")).toHaveTextContent(
      "売り切れ中",
    );
    expect(screen.getByTestId("soldout-summary")).toHaveTextContent(
      "現在売り切れ中：1品",
    );
  });

  it("ITEM_NOT_FOUNDが返っても、クラッシュせず案内メッセージを表示し、確認モーダルは閉じる", async () => {
    const item = makeItem({ id: "menu-1", name: "唐揚げ", soldOut: false });
    mockListMenuItems.mockResolvedValue({ ok: true, value: [item] });
    mockSetSoldOut.mockResolvedValue({
      ok: false,
      error: { code: "ITEM_NOT_FOUND" },
    });

    render(<SoldOutBoard storeId="store-1" />);
    await screen.findByTestId("soldout-board");

    fireEvent.click(screen.getByTestId("soldout-toggle"));
    await screen.findByTestId("soldout-confirm-modal");
    fireEvent.click(screen.getByTestId("soldout-confirm-ok"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "この品目は見つかりませんでした",
    );
    expect(
      screen.queryByTestId("soldout-confirm-modal"),
    ).not.toBeInTheDocument();
  });

  it("setSoldOutが例外を投げても（ドキュメント化されていない失敗）、クラッシュせず案内メッセージを表示する", async () => {
    const item = makeItem({ id: "menu-1", name: "唐揚げ", soldOut: false });
    mockListMenuItems.mockResolvedValue({ ok: true, value: [item] });
    mockSetSoldOut.mockRejectedValue(new Error("network error"));

    render(<SoldOutBoard storeId="store-1" />);
    await screen.findByTestId("soldout-board");

    fireEvent.click(screen.getByTestId("soldout-toggle"));
    await screen.findByTestId("soldout-confirm-modal");
    fireEvent.click(screen.getByTestId("soldout-confirm-ok"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "売り切れ状態の更新に失敗しました",
    );
    expect(
      screen.queryByTestId("soldout-confirm-modal"),
    ).not.toBeInTheDocument();
    // 更新に失敗したため表示状態は変化しない。
    expect(screen.getByTestId("soldout-toggle")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("listMenuItemsが例外を投げても（ドキュメント化されていない失敗）、クラッシュせず案内メッセージを表示する", async () => {
    mockListMenuItems.mockRejectedValue(new Error("network error"));

    render(<SoldOutBoard storeId="store-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "品目一覧の取得に失敗しました",
    );
    expect(screen.queryByTestId("soldout-board")).not.toBeInTheDocument();
  });
});
