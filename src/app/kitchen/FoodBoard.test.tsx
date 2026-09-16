import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import FoodBoard, { type KitchenFeedItem } from "./FoodBoard";

// FoodBoard（タスク7.2、フードボードの5分割カンバン・一品優先表示）の
// コンポーネントテスト。staffOperationsGatewayをモックし、実DBには接続
// しない（MenuScreen.test.tsx・KitchenBoardScreen.test.tsxと同じ方式）。
//
// tasks.md Implementation Notes: listKitchenFeedは既にジャンル別の並び替え
// （一品優先／直近完了順）を適用済みで配列を返す（タスク4.5）。本テストの
// 核心的な関心事は「FoodBoardがこの配列順を一切再ソートせずそのまま
// 描画すること」であり、そのために意図的に「もし独自にソートし直したら
// 結果が変わってしまう」ような並びのモック応答を与えて検証する。
//
// Requirements: 6.3, 6.6, 6.7, 6.8, 6.10

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
    genre: "food",
    ...overrides,
  };
}

/** formatClock（FoodBoard.tsx）と同じロジックで期待値を導出する。実行環境の
 * タイムゾーンに依存せず一致させるため、決め打ちの文字列と比較しない。 */
function expectedClock(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe("FoodBoard", () => {
  beforeEach(() => {
    idCounter = 0;
    mockListKitchenFeed.mockReset();
  });

  it("フード/一品ジャンルの品目のみをstatusごとの列へ表示し、ドリンク品目は除外する", async () => {
    const foodReceived = makeItem({
      name: "唐揚げ",
      genre: "food",
      status: "received",
    });
    const drinkReceived = makeItem({
      name: "レモンサワー",
      genre: "drink",
      status: "received",
    });
    const ippinInProgress = makeItem({
      name: "冷奴",
      genre: "ippin",
      status: "in_progress",
    });
    const foodDone = makeItem({
      name: "焼き鳥",
      genre: "food",
      status: "done",
    });

    mockListKitchenFeed.mockResolvedValue({
      ok: true,
      value: [foodReceived, drinkReceived, ippinInProgress, foodDone],
    });

    render(<FoodBoard storeId="store-1" />);

    expect(await screen.findByTestId("food-board")).toBeInTheDocument();
    expect(mockListKitchenFeed).toHaveBeenCalledWith({ storeId: "store-1" });

    const receivedColumn = screen.getByTestId("food-board-column-received");
    const inProgressColumn = screen.getByTestId(
      "food-board-column-in_progress",
    );
    const doneColumn = screen.getByTestId("food-board-column-done");

    expect(within(receivedColumn).getByText(/唐揚げ/)).toBeInTheDocument();
    expect(
      within(receivedColumn).queryByText(/レモンサワー/),
    ).not.toBeInTheDocument();
    expect(within(inProgressColumn).getByText(/冷奴/)).toBeInTheDocument();
    expect(within(doneColumn).getByText(/焼き鳥/)).toBeInTheDocument();

    // ドリンク品目はどの列にも一切表示されない（ドリンクボードは7.3の対象）。
    expect(screen.queryByText(/レモンサワー/)).not.toBeInTheDocument();
  });

  it("未対応列: RPCが返した配列順をそのまま描画し、一品が配列の先頭でなくても並び替え直さない", async () => {
    // 意図的に「一品が配列の先頭ではない」応答を与える。実際のRPC
    // （list_kitchen_feed）は一品を常に先頭に並べて返すが、本テストは
    // 「FoodBoardが独自に並び替えロジックを持たず、RPCの応答順を信頼して
    // そのまま描画する」ことを証明するためのものなので、あえて逆順を渡す。
    const foodFirst = makeItem({ name: "唐揚げ", genre: "food" });
    const ippinSecond = makeItem({ name: "冷奴", genre: "ippin" });

    mockListKitchenFeed.mockResolvedValue({
      ok: true,
      value: [foodFirst, ippinSecond],
    });

    render(<FoodBoard storeId="store-1" />);

    const receivedColumn = await screen.findByTestId(
      "food-board-column-received",
    );
    const cards = within(receivedColumn).getAllByTestId("food-board-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText(/唐揚げ/)).toBeInTheDocument();
    expect(within(cards[1]).getByText(/冷奴/)).toBeInTheDocument();
  });

  it("調理完了列: RPCが返した配列順をそのまま描画し、後から完了した品目が先頭に来る順序を保つ", async () => {
    // 配列自体は既にRPCが「直近完了が先頭」の順で返す想定（タスク4.5）。
    // ここではその応答順をFoodBoardが独自に再ソートしない
    // （＝createdAt等の別基準で並び替え直さない）ことを検証する。
    const completedLater = makeItem({
      name: "刺身盛り合わせ",
      status: "done",
      statusUpdatedAt: "2026-01-01T03:10:00.000Z",
    });
    const completedEarlier = makeItem({
      name: "餃子",
      status: "done",
      statusUpdatedAt: "2026-01-01T03:00:00.000Z",
    });

    // 配列順自体を「後から完了したものが先頭」にして応答する。
    mockListKitchenFeed.mockResolvedValue({
      ok: true,
      value: [completedLater, completedEarlier],
    });

    render(<FoodBoard storeId="store-1" />);

    const doneColumn = await screen.findByTestId("food-board-column-done");
    const cards = within(doneColumn).getAllByTestId("food-board-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText(/刺身盛り合わせ/)).toBeInTheDocument();
    expect(within(cards[1]).getByText(/餃子/)).toBeInTheDocument();
  });

  it("各カードに卓の識別情報・時刻・品目名・数量・オプションサマリー（ある場合）を表示する", async () => {
    const withOptions = makeItem({
      name: "唐揚げ",
      tableLabel: "3番卓",
      quantity: 2,
      optionsSummary: "タレ増し",
      statusUpdatedAt: "2026-01-01T12:34:00.000Z",
    });

    mockListKitchenFeed.mockResolvedValue({ ok: true, value: [withOptions] });

    render(<FoodBoard storeId="store-1" />);

    const card = (await screen.findAllByTestId("food-board-card"))[0];
    expect(within(card).getByText("3番卓")).toBeInTheDocument();
    expect(
      within(card).getByText(expectedClock(withOptions.statusUpdatedAt)),
    ).toBeInTheDocument();
    expect(
      within(card).getByText("唐揚げ（タレ増し） ×2"),
    ).toBeInTheDocument();
  });

  it("一品ジャンルの品目には識別用のバッジを表示する", async () => {
    const ippinItem = makeItem({ name: "冷奴", genre: "ippin" });
    mockListKitchenFeed.mockResolvedValue({ ok: true, value: [ippinItem] });

    render(<FoodBoard storeId="store-1" />);

    const card = (await screen.findAllByTestId("food-board-card"))[0];
    expect(within(card).getByText("一品")).toBeInTheDocument();
  });

  it("listKitchenFeedが例外を投げても（ドキュメント化されていない失敗）、クラッシュせず案内メッセージを表示する", async () => {
    mockListKitchenFeed.mockRejectedValue(new Error("network error"));

    render(<FoodBoard storeId="store-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "厨房データの取得に失敗しました",
    );
    expect(screen.queryByTestId("food-board")).not.toBeInTheDocument();
  });
});
