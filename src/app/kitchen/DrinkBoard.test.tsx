import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import DrinkBoard, { DRINK_BOARD_POLL_INTERVAL_MS } from "./DrinkBoard";
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
const mockUpdateOrderItemStatus = vi.fn();

vi.mock("@/lib/gateways/staffOperationsGateway", () => ({
  createStaffOperationsGateway: () => ({
    listKitchenFeed: (...args: unknown[]) => mockListKitchenFeed(...args),
    updateOrderItemStatus: (...args: unknown[]) =>
      mockUpdateOrderItemStatus(...args),
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
    mockUpdateOrderItemStatus.mockReset();
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

// =========================================================================
// タスク7.5: ステータス更新操作と即時反映
// Requirements: 6.1, 6.2, 6.5
//
// FoodBoard.test.tsx（タスク7.5ブロック）冒頭コメントと同じ前提——要件6.5に
// 確認モーダルの言及が無いため、クリック直後に確認ステップ無しで
// updateOrderItemStatusを呼び出すことを検証する。ドリンクはreceived→done
// の1操作のみで、一品のような直接完了ショートカットは存在しない。
// =========================================================================

describe("DrinkBoard（タスク7.5: ステータス更新操作と即時反映）", () => {
  beforeEach(() => {
    idCounter = 0;
    mockListKitchenFeed.mockReset();
    mockUpdateOrderItemStatus.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("未対応カードには「対応完了」ボタンのみが表示される", async () => {
    const item = makeItem({ name: "レモンサワー", status: "received" });
    mockListKitchenFeed.mockResolvedValue({ ok: true, value: [item] });

    render(<DrinkBoard storeId="store-1" />);

    const card = (await screen.findAllByTestId("drink-board-card"))[0];
    expect(
      within(card).getByRole("button", { name: "対応完了" }),
    ).toBeInTheDocument();
  });

  it("対応済みカードにはステータス更新ボタンが一切表示されない", async () => {
    const item = makeItem({ name: "生ビール", status: "done" });
    mockListKitchenFeed.mockResolvedValue({ ok: true, value: [item] });

    render(<DrinkBoard storeId="store-1" />);

    const card = (await screen.findAllByTestId("drink-board-card"))[0];
    expect(within(card).queryByRole("button")).not.toBeInTheDocument();
  });

  it("「対応完了」クリックで確認なしに直接updateOrderItemStatusを呼び出す（要件6.5: 確認モーダルは存在しない）", async () => {
    const item = makeItem({ name: "レモンサワー", status: "received" });
    mockListKitchenFeed.mockResolvedValue({ ok: true, value: [item] });
    mockUpdateOrderItemStatus.mockResolvedValue({
      ok: true,
      value: { ...item, status: "done" },
    });

    render(<DrinkBoard storeId="store-1" />);

    const card = (await screen.findAllByTestId("drink-board-card"))[0];
    fireEvent.click(within(card).getByRole("button", { name: "対応完了" }));

    expect(mockUpdateOrderItemStatus).toHaveBeenCalledWith({
      orderItemId: item.id,
      status: "done",
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("更新成功直後（次回ポーリングを待たず）に該当カードが対応済み列へ移動する（本タスクの観測可能な完了条件）", async () => {
    vi.useFakeTimers();
    const item = makeItem({ name: "レモンサワー", status: "received" });
    mockListKitchenFeed.mockResolvedValue({ ok: true, value: [item] });
    mockUpdateOrderItemStatus.mockResolvedValue({
      ok: true,
      value: {
        ...item,
        status: "done",
        statusUpdatedAt: "2026-01-01T03:20:00.000Z",
      },
    });

    render(<DrinkBoard storeId="store-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.click(
      within(screen.getByTestId("drink-board-column-received")).getByRole(
        "button",
        { name: "対応完了" },
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockListKitchenFeed).toHaveBeenCalledTimes(1);

    const doneColumn = screen.getByTestId("drink-board-column-done");
    expect(within(doneColumn).getByText(/レモンサワー/)).toBeInTheDocument();
    expect(
      within(screen.getByTestId("drink-board-column-received")).queryByText(
        /レモンサワー/,
      ),
    ).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRINK_BOARD_POLL_INTERVAL_MS);
    });
    expect(mockListKitchenFeed).toHaveBeenCalledTimes(2);
  });

  it("updateOrderItemStatusが業務エラー（他端末との競合によるINVALID_TRANSITION）を返してもクラッシュせず、カードは元の列に留まる", async () => {
    const item = makeItem({ name: "レモンサワー", status: "received" });
    mockListKitchenFeed.mockResolvedValue({ ok: true, value: [item] });
    mockUpdateOrderItemStatus.mockResolvedValue({
      ok: false,
      error: { code: "INVALID_TRANSITION", from: "done", to: "done" },
    });

    render(<DrinkBoard storeId="store-1" />);

    const card = (await screen.findAllByTestId("drink-board-card"))[0];
    fireEvent.click(within(card).getByRole("button", { name: "対応完了" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ステータスの更新に失敗しました",
    );
    expect(
      within(screen.getByTestId("drink-board-column-received")).getByText(
        /レモンサワー/,
      ),
    ).toBeInTheDocument();
  });

  it("updateOrderItemStatusが例外を投げても（ドキュメント化されていない失敗）クラッシュせず案内する", async () => {
    const item = makeItem({ name: "レモンサワー", status: "received" });
    mockListKitchenFeed.mockResolvedValue({ ok: true, value: [item] });
    mockUpdateOrderItemStatus.mockRejectedValue(new Error("network error"));

    render(<DrinkBoard storeId="store-1" />);

    const card = (await screen.findAllByTestId("drink-board-card"))[0];
    fireEvent.click(within(card).getByRole("button", { name: "対応完了" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ステータスの更新に失敗しました",
    );
  });
});

// =========================================================================
// タスク7.6: 接続断表示と再同期（resyncSignalによる背景再取得）
// Requirements: 6.9
//
// FoodBoard.test.tsx（タスク7.6ブロック）と同じ検証内容・同じ理由を
// DrinkBoardに対して行う。
// =========================================================================

describe("DrinkBoard（タスク7.6: resyncSignalによる背景再取得）", () => {
  beforeEach(() => {
    idCounter = 0;
    mockListKitchenFeed.mockReset();
    mockUpdateOrderItemStatus.mockReset();
  });

  it("resyncSignalが変化すると、ローディング状態に戻さず背景でlistKitchenFeedを再呼び出しする", async () => {
    const initial = makeItem({ name: "レモンサワー", status: "received" });
    mockListKitchenFeed.mockResolvedValueOnce({ ok: true, value: [initial] });

    const { rerender } = render(
      <DrinkBoard storeId="store-1" resyncSignal={0} />,
    );
    expect(await screen.findByTestId("drink-board")).toBeInTheDocument();
    expect(mockListKitchenFeed).toHaveBeenCalledTimes(1);

    const afterResync = makeItem({ name: "烏龍茶", status: "received" });
    mockListKitchenFeed.mockResolvedValueOnce({
      ok: true,
      value: [afterResync],
    });

    rerender(<DrinkBoard storeId="store-1" resyncSignal={1} />);

    await waitFor(() => expect(mockListKitchenFeed).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByTestId("drink-board-loading"),
    ).not.toBeInTheDocument();
    expect(await screen.findByText(/烏龍茶/)).toBeInTheDocument();
  });

  it("マウント時に渡されたresyncSignalの初期値では、余分な再取得を行わない", async () => {
    mockListKitchenFeed.mockResolvedValue({ ok: true, value: [] });

    render(<DrinkBoard storeId="store-1" resyncSignal={5} />);
    await screen.findByTestId("drink-board");

    expect(mockListKitchenFeed).toHaveBeenCalledTimes(1);
  });

  it("resyncSignal変化時の背景フェッチが失敗しても、既存の表示中の品目をエラー画面へ巻き戻さない（アドバーサリアルケース）", async () => {
    const existing = makeItem({ name: "レモンサワー", status: "received" });
    mockListKitchenFeed.mockResolvedValueOnce({ ok: true, value: [existing] });

    const { rerender } = render(
      <DrinkBoard storeId="store-1" resyncSignal={0} />,
    );
    expect(await screen.findByTestId("drink-board")).toBeInTheDocument();
    expect(screen.getByText(/レモンサワー/)).toBeInTheDocument();

    mockListKitchenFeed.mockRejectedValueOnce(new Error("network blip"));

    rerender(<DrinkBoard storeId="store-1" resyncSignal={1} />);

    await waitFor(() => expect(mockListKitchenFeed).toHaveBeenCalledTimes(2));

    expect(screen.getByTestId("drink-board")).toBeInTheDocument();
    expect(screen.getByText(/レモンサワー/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("resyncSignalが渡されない場合（既存の呼び出し側）、ポーリング以外の余分な再取得は発生しない", async () => {
    mockListKitchenFeed.mockResolvedValue({ ok: true, value: [] });

    render(<DrinkBoard storeId="store-1" />);
    await screen.findByTestId("drink-board");

    expect(mockListKitchenFeed).toHaveBeenCalledTimes(1);
  });
});
