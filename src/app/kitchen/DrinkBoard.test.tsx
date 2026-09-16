import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import DrinkBoard from "./DrinkBoard";
import type { KitchenFeedItem } from "./FoodBoard";

// DrinkBoard（タスク7.3、ドリンクボードの2分割カンバン）のコンポーネントテスト。
// staffOperationsGatewayをモックし、実DBには接続しない
// （FoodBoard.test.tsx・MenuScreen.test.tsxと同じ方式）。
//
// design.md/requirements.md（要件6.4）の通り、ドリンクジャンルは
// received → doneの2状態のみを取り得る（in_progressには決して遷移しない）。
// 本テストの核心的な関心事は、この構造をDrinkBoardが「常に空の調理中列」
// ではなく「調理中列そのものが存在しない」という形で表現すること、および
// FoodBoard.test.tsxと同様にRPCが返す配列順を一切再ソートしないことである。
//
// Requirements: 6.4, 6.8

const mockListKitchenFeed = vi.fn();

vi.mock("@/lib/gateways/staffOperationsGateway", () => ({
  createStaffOperationsGateway: () => ({
    listKitchenFeed: (...args: unknown[]) => mockListKitchenFeed(...args),
  }),
}));

let idCounter = 0;

function makeItem(overrides: Partial<KitchenFeedItem> = {}): KitchenFeedItem {
  idCounter += 1;
  return {
    id: `item-${idCounter}`,
    menuItemId: `menu-${idCounter}`,
    name: `品目${idCounter}`,
    unitPrice: 500,
    quantity: 1,
    optionsSummary: null,
    status: "received",
    statusUpdatedAt: "2026-01-01T03:04:00.000Z",
    tableId: "table-1",
    tableLabel: "1番卓",
    genre: "drink",
    ...overrides,
  };
}

/** formatClock（DrinkBoard.tsx）と同じロジックで期待値を導出する。実行環境の
 * タイムゾーンに依存せず一致させるため、決め打ちの文字列と比較しない。 */
function expectedClock(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe("DrinkBoard", () => {
  beforeEach(() => {
    idCounter = 0;
    mockListKitchenFeed.mockReset();
  });

  it("ドリンクジャンルの品目のみをstatusごとの列へ表示し、フード/一品品目は除外する", async () => {
    const drinkReceived = makeItem({
      name: "レモンサワー",
      genre: "drink",
      status: "received",
    });
    const foodReceived = makeItem({
      name: "唐揚げ",
      genre: "food",
      status: "received",
    });
    const ippinDone = makeItem({
      name: "冷奴",
      genre: "ippin",
      status: "done",
    });
    const drinkDone = makeItem({
      name: "生ビール",
      genre: "drink",
      status: "done",
    });

    mockListKitchenFeed.mockResolvedValue({
      ok: true,
      value: [drinkReceived, foodReceived, ippinDone, drinkDone],
    });

    render(<DrinkBoard storeId="store-1" />);

    expect(await screen.findByTestId("drink-board")).toBeInTheDocument();
    expect(mockListKitchenFeed).toHaveBeenCalledWith({ storeId: "store-1" });

    const receivedColumn = screen.getByTestId("drink-board-column-received");
    const doneColumn = screen.getByTestId("drink-board-column-done");

    expect(
      within(receivedColumn).getByText(/レモンサワー/),
    ).toBeInTheDocument();
    expect(
      within(receivedColumn).queryByText(/唐揚げ/),
    ).not.toBeInTheDocument();
    expect(within(doneColumn).getByText(/生ビール/)).toBeInTheDocument();
    expect(within(doneColumn).queryByText(/冷奴/)).not.toBeInTheDocument();

    // フード/一品品目はどの列にも一切表示されない（フードボードは7.2の対象）。
    expect(screen.queryByText(/唐揚げ/)).not.toBeInTheDocument();
    expect(screen.queryByText(/冷奴/)).not.toBeInTheDocument();
  });

  it("調理中列は構造上存在しない（空ではなく、列自体が描画されない）", async () => {
    const drinkReceived = makeItem({ name: "レモンサワー", status: "received" });
    const drinkDone = makeItem({ name: "生ビール", status: "done" });

    mockListKitchenFeed.mockResolvedValue({
      ok: true,
      value: [drinkReceived, drinkDone],
    });

    render(<DrinkBoard storeId="store-1" />);

    await screen.findByTestId("drink-board");

    expect(
      screen.queryByTestId("drink-board-column-in_progress"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("調理中")).not.toBeInTheDocument();

    // 2列のみが存在する（未対応・対応済み）。
    expect(screen.getAllByTestId(/^drink-board-column-/)).toHaveLength(2);
  });

  it("列の見出しラベルは「未対応」「対応済み」であり、フードボードの「調理完了」は使わない", async () => {
    const drinkReceived = makeItem({ name: "レモンサワー", status: "received" });
    const drinkDone = makeItem({ name: "生ビール", status: "done" });

    mockListKitchenFeed.mockResolvedValue({
      ok: true,
      value: [drinkReceived, drinkDone],
    });

    render(<DrinkBoard storeId="store-1" />);

    await screen.findByTestId("drink-board");

    expect(screen.getByText(/未対応/)).toBeInTheDocument();
    expect(screen.getByText(/対応済み/)).toBeInTheDocument();
    expect(screen.queryByText("調理完了")).not.toBeInTheDocument();
  });

  it("未対応列: RPCが返した配列順をそのまま描画し、独自に並び替え直さない", async () => {
    // ドリンクには一品のような優先表示ルールが無いため、RPCが返した順序
    // （ここでは意図的に受注時刻の降順、かつ品目名のアルファベット順でもない
    // 順序）をそのまま描画することのみを検証する。
    const second = makeItem({
      name: "レモンサワー",
      statusUpdatedAt: "2026-01-01T03:10:00.000Z",
    });
    const first = makeItem({
      name: "生ビール",
      statusUpdatedAt: "2026-01-01T03:00:00.000Z",
    });

    mockListKitchenFeed.mockResolvedValue({
      ok: true,
      value: [second, first],
    });

    render(<DrinkBoard storeId="store-1" />);

    const receivedColumn = await screen.findByTestId(
      "drink-board-column-received",
    );
    const cards = within(receivedColumn).getAllByTestId("drink-board-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText(/レモンサワー/)).toBeInTheDocument();
    expect(within(cards[1]).getByText(/生ビール/)).toBeInTheDocument();
  });

  it("対応済み列: RPCが返した配列順をそのまま描画する", async () => {
    const later = makeItem({
      name: "烏龍茶",
      status: "done",
      statusUpdatedAt: "2026-01-01T03:10:00.000Z",
    });
    const earlier = makeItem({
      name: "コーラ",
      status: "done",
      statusUpdatedAt: "2026-01-01T03:00:00.000Z",
    });

    mockListKitchenFeed.mockResolvedValue({
      ok: true,
      value: [later, earlier],
    });

    render(<DrinkBoard storeId="store-1" />);

    const doneColumn = await screen.findByTestId("drink-board-column-done");
    const cards = within(doneColumn).getAllByTestId("drink-board-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText(/烏龍茶/)).toBeInTheDocument();
    expect(within(cards[1]).getByText(/コーラ/)).toBeInTheDocument();
  });

  it("各カードに卓の識別情報・時刻・品目名・数量・オプションサマリー（ある場合）を表示する", async () => {
    const withOptions = makeItem({
      name: "レモンサワー",
      tableLabel: "3番卓",
      quantity: 2,
      optionsSummary: "氷少なめ",
      statusUpdatedAt: "2026-01-01T12:34:00.000Z",
    });

    mockListKitchenFeed.mockResolvedValue({ ok: true, value: [withOptions] });

    render(<DrinkBoard storeId="store-1" />);

    const card = (await screen.findAllByTestId("drink-board-card"))[0];
    expect(within(card).getByText("3番卓")).toBeInTheDocument();
    expect(
      within(card).getByText(expectedClock(withOptions.statusUpdatedAt)),
    ).toBeInTheDocument();
    expect(
      within(card).getByText("レモンサワー（氷少なめ） ×2"),
    ).toBeInTheDocument();
  });

  it("listKitchenFeedが例外を投げても（ドキュメント化されていない失敗）、クラッシュせず案内メッセージを表示する", async () => {
    mockListKitchenFeed.mockRejectedValue(new Error("network error"));

    render(<DrinkBoard storeId="store-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "厨房データの取得に失敗しました",
    );
    expect(screen.queryByTestId("drink-board")).not.toBeInTheDocument();
  });
});
