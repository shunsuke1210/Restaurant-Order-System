import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import MenuScreen, { CONFIRMED_TOTAL_POLL_INTERVAL_MS } from "./MenuScreen";
import type { MenuItemView } from "@/lib/gateways/customerOrderingGateway";

// MenuScreen（タスク6.1）のコンポーネントテスト。
// tasks.md Implementation Notes「customerOrderingGatewayの各メソッドは
// ドキュメント化されたエラーコード以外の予期しないエラーをResultに含めず
// 例外としてthrowする」という規約を踏まえ、MenuScreenが必ずtry/catchで
// 捕捉していることをテストで実証する（想定外の例外がunhandled rejectionに
// ならず、画面に汎用エラーメッセージが表示されること）。
//
// customerOrderingGatewayはモックし、実DBには接続しない
// （src/app/setup/[role]/SetupForm.test.tsxと同じ方針）。
//
// タスク6.2（注文送信・確定注文合計表示・通信断ハンドリング）のテストも
// 本ファイルへ追記する（6.1同様、GenreTabs/MenuItemCard/OptionSelectionPanel/
// CartPanel/ConfirmedTotalBarはいずれも専用のtestファイルを持たず、
// MenuScreen経由で検証する既存方針を踏襲する）。
//
// Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12, 7.2

const mockGetOrderingContext = vi.fn();
const mockSubmitOrder = vi.fn();

vi.mock("@/lib/gateways/customerOrderingGateway", () => ({
  createCustomerOrderingGateway: () => ({
    getOrderingContext: (...args: unknown[]) =>
      mockGetOrderingContext(...args),
    submitOrder: (...args: unknown[]) => mockSubmitOrder(...args),
    createCallRequest: vi.fn(),
  }),
}));

const baseMenu: MenuItemView[] = [
  {
    id: "item-food-1",
    name: "唐揚げ",
    price: 500,
    soldOut: false,
    imageUrl: "https://example.com/karaage.jpg",
    genre: "food",
    options: [],
  },
  {
    id: "item-drink-1",
    name: "レモンサワー",
    price: 480,
    soldOut: false,
    imageUrl: null,
    genre: "drink",
    options: [],
  },
  {
    id: "item-soldout-1",
    name: "刺身盛り合わせ",
    price: 1280,
    soldOut: true,
    imageUrl: null,
    genre: "food",
    options: [],
  },
  {
    id: "item-options-1",
    name: "オプション品目",
    price: 600,
    soldOut: false,
    imageUrl: null,
    genre: "ippin",
    options: [
      {
        id: "sauce",
        type: "choice",
        label: "味付け",
        choices: ["たれ", "塩"],
        default: "たれ",
      },
      { id: "wasabi", type: "toggle", label: "わさび抜き", default: false },
      {
        id: "rice",
        type: "counter",
        label: "ライス増量",
        min: 0,
        max: 3,
        default: 0,
      },
    ],
  },
];

function okContext(
  menu: MenuItemView[] = baseMenu,
  confirmedTotal = 0,
) {
  return {
    ok: true as const,
    value: {
      table: { id: "table-1", label: "1番卓" },
      activeSession: { id: "session-1" },
      confirmedTotal,
      menu,
    },
  };
}

describe("MenuScreen", () => {
  beforeEach(() => {
    mockGetOrderingContext.mockReset();
    mockSubmitOrder.mockReset();
  });

  it("成功応答からメニュー（品目名・価格・写真）を描画する", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());

    render(<MenuScreen tableId="table-1" />);

    expect(await screen.findByText("唐揚げ")).toBeInTheDocument();
    expect(screen.getByText("¥500")).toBeInTheDocument();
    const photo = screen.getByAltText("唐揚げ") as HTMLImageElement;
    expect(photo.src).toBe("https://example.com/karaage.jpg");

    // imageUrlがnullの品目はプレースホルダーを表示する
    expect(screen.queryByAltText("レモンサワー")).not.toBeInTheDocument();
    const drinkRow = screen.getByRole("button", { name: /レモンサワー/ });
    expect(
      drinkRow.querySelector('[data-testid="photo-placeholder"]'),
    ).toBeInTheDocument();
  });

  it("売り切れ品目はグレーアウトされ、無効化されて操作できない（観測可能な完了条件）", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());

    render(<MenuScreen tableId="table-1" />);

    const soldOutButton = await screen.findByRole("button", {
      name: /刺身盛り合わせ/,
    });
    expect(soldOutButton).toBeDisabled();
    expect(screen.getByText("売り切れ")).toBeInTheDocument();

    fireEvent.click(soldOutButton);

    // 無効化されたbuttonはクリックしてもonClickが発火しないため
    // オプション選択ダイアログは開かない。
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ジャンルタブで表示品目が絞り込まれる", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());

    render(<MenuScreen tableId="table-1" />);
    await screen.findByText("唐揚げ");

    fireEvent.click(screen.getByRole("tab", { name: "一品" }));

    expect(screen.getByText("オプション品目")).toBeInTheDocument();
    expect(screen.queryByText("唐揚げ")).not.toBeInTheDocument();
    expect(screen.queryByText("レモンサワー")).not.toBeInTheDocument();
    expect(screen.queryByText("刺身盛り合わせ")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "ドリンク" }));
    expect(screen.getByText("レモンサワー")).toBeInTheDocument();
    expect(screen.queryByText("オプション品目")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "すべて" }));
    expect(screen.getByText("唐揚げ")).toBeInTheDocument();
    expect(screen.getByText("レモンサワー")).toBeInTheDocument();
    expect(screen.getByText("オプション品目")).toBeInTheDocument();
  });

  it("品目タップでオプション選択パネルが開き、choice/toggle/counterの各操作が状態に反映される", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());

    render(<MenuScreen tableId="table-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /オプション品目/ }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();

    // choice: デフォルト「たれ」が選択済み、「塩」を選ぶと切り替わる
    const tareButton = screen.getByRole("button", { name: "たれ" });
    const shioButton = screen.getByRole("button", { name: "塩" });
    expect(tareButton).toHaveAttribute("aria-pressed", "true");
    expect(shioButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(shioButton);
    expect(shioButton).toHaveAttribute("aria-pressed", "true");
    expect(tareButton).toHaveAttribute("aria-pressed", "false");

    // toggle: デフォルトfalse（希望しない）、押すとtrue（希望する）
    const toggle = screen.getByRole("switch", { name: "わさび抜き" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");

    // counter: min0/max3/default0。上限を超えて増加せず、下限を下回って減少しない
    const increment = screen.getByRole("button", { name: "ライス増量を増やす" });
    const decrement = screen.getByRole("button", { name: "ライス増量を減らす" });
    expect(screen.getByTestId("rice-count")).toHaveTextContent("0");
    expect(decrement).toBeDisabled();

    fireEvent.click(increment);
    fireEvent.click(increment);
    fireEvent.click(increment);
    expect(screen.getByTestId("rice-count")).toHaveTextContent("3");
    expect(increment).toBeDisabled();

    fireEvent.click(increment); // 上限を超えない
    expect(screen.getByTestId("rice-count")).toHaveTextContent("3");

    fireEvent.click(decrement);
    expect(screen.getByTestId("rice-count")).toHaveTextContent("2");
  });

  it("キャンセルするとダイアログが閉じ、選択内容は破棄される", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());

    render(<MenuScreen tableId="table-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /オプション品目/ }));
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("選択を確定するとダイアログが閉じ、選択済み件数が増える（6.2で消費するローカル状態）", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());

    render(<MenuScreen tableId="table-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /オプション品目/ }));
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "選択を確定" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("cart-count")).toHaveTextContent("1");
  });

  it("アクティブセッションが無い場合はメニューを表示せず、簡易な案内を表示する", async () => {
    mockGetOrderingContext.mockResolvedValue({
      ok: true,
      value: {
        table: { id: "table-1", label: "1番卓" },
        activeSession: null,
        confirmedTotal: 0,
        menu: baseMenu,
      },
    });

    render(<MenuScreen tableId="table-1" />);

    await waitFor(() => {
      expect(screen.queryByText("唐揚げ")).not.toBeInTheDocument();
    });
    expect(screen.getByText(/スタッフ|店員/)).toBeInTheDocument();
  });

  it("TABLE_NOT_FOUNDエラーはクラッシュせず、エラーメッセージを表示する", async () => {
    mockGetOrderingContext.mockResolvedValue({
      ok: false,
      error: { code: "TABLE_NOT_FOUND" },
    });

    render(<MenuScreen tableId="missing-table" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "見つかりません",
    );
  });

  it("想定外の例外はtry/catchで捕捉され、unhandled rejectionにならず汎用エラーメッセージを表示する", async () => {
    mockGetOrderingContext.mockRejectedValue(new Error("network down"));

    render(<MenuScreen tableId="table-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "予期しないエラー",
    );
  });
});

// =========================================================================
// タスク6.2: 注文送信・確定注文合計表示・通信断ハンドリング
// Requirements: 1.7, 1.8, 1.9, 1.10, 1.11, 1.12
// =========================================================================

/** 唐揚げ（オプションなし）をカートへ1点追加する共通手順。 */
async function addKaraageToCart() {
  fireEvent.click(await screen.findByRole("button", { name: /唐揚げ/ }));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "選択を確定" }));
}

/** カートを開いて注文カートダイアログを表示する共通手順。 */
async function openCartPanel() {
  fireEvent.click(screen.getByTestId("cart-count"));
  return screen.findByRole("dialog", { name: "注文カート" });
}

describe("MenuScreen（タスク6.2: 注文送信・確定注文合計表示・通信断ハンドリング）", () => {
  beforeEach(() => {
    mockGetOrderingContext.mockReset();
    mockSubmitOrder.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("確定注文合計がgetOrderingContextのconfirmedTotalから画面下部に常時表示される", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext(baseMenu, 1500));

    render(<MenuScreen tableId="table-1" />);
    await screen.findByText("唐揚げ");

    expect(screen.getByTestId("confirmed-total-amount")).toHaveTextContent(
      "¥1,500",
    );
  });

  it("注文送信が成功すると送信完了メッセージが表示され、カートがクリアされる（観測可能な完了条件a）", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());
    mockSubmitOrder.mockResolvedValueOnce({
      ok: true,
      value: {
        deduplicated: false,
        order: {
          id: "order-1",
          createdAt: "2026-09-15T12:00:00Z",
          items: [],
        },
      },
    });

    render(<MenuScreen tableId="table-1" />);
    await addKaraageToCart();
    expect(screen.getByTestId("cart-count")).toHaveTextContent("1");

    await openCartPanel();
    fireEvent.click(screen.getByRole("button", { name: "注文する" }));

    expect(await screen.findByText("送信完了")).toBeInTheDocument();

    expect(mockSubmitOrder).toHaveBeenCalledTimes(1);
    const call = mockSubmitOrder.mock.calls[0][0];
    expect(call.sessionId).toBe("session-1");
    expect(call.items).toEqual([
      {
        menuItemId: "item-food-1",
        quantity: 1,
        optionSelections: {},
        note: null,
      },
    ]);
    expect(typeof call.idempotencyKey).toBe("string");
    expect(call.idempotencyKey.length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.getByTestId("cart-count")).toHaveTextContent("0");
  });

  it("SESSION_NOT_ACTIVEは専用のメッセージを表示する", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());
    mockSubmitOrder.mockResolvedValueOnce({
      ok: false,
      error: { code: "SESSION_NOT_ACTIVE" },
    });

    render(<MenuScreen tableId="table-1" />);
    await addKaraageToCart();
    await openCartPanel();
    fireEvent.click(screen.getByRole("button", { name: "注文する" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /終了|スタッフ/,
    );
  });

  it("ITEM_SOLD_OUTは対象品目名を含む専用のメッセージを表示する", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());
    mockSubmitOrder.mockResolvedValueOnce({
      ok: false,
      error: { code: "ITEM_SOLD_OUT", menuItemId: "item-food-1" },
    });

    render(<MenuScreen tableId="table-1" />);
    await addKaraageToCart();
    await openCartPanel();
    fireEvent.click(screen.getByRole("button", { name: "注文する" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("唐揚げ");
    expect(alert).toHaveTextContent("売り切れ");
  });

  it("EMPTY_ORDERは専用のメッセージを表示する", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());
    mockSubmitOrder.mockResolvedValueOnce({
      ok: false,
      error: { code: "EMPTY_ORDER" },
    });

    render(<MenuScreen tableId="table-1" />);
    await addKaraageToCart();
    await openCartPanel();
    fireEvent.click(screen.getByRole("button", { name: "注文する" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /品目を選択/,
    );
  });

  it("RATE_LIMITEDは専用のメッセージを表示する", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());
    mockSubmitOrder.mockResolvedValueOnce({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });

    render(<MenuScreen tableId="table-1" />);
    await addKaraageToCart();
    await openCartPanel();
    fireEvent.click(screen.getByRole("button", { name: "注文する" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /時間をおいて|集中/,
    );
  });

  it("4種のSubmitOrderErrorはそれぞれ異なる文言を表示する（一律の汎用文言ではない）", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());
    mockSubmitOrder
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "SESSION_NOT_ACTIVE" },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "ITEM_SOLD_OUT", menuItemId: "item-food-1" },
      })
      .mockResolvedValueOnce({ ok: false, error: { code: "EMPTY_ORDER" } })
      .mockResolvedValueOnce({ ok: false, error: { code: "RATE_LIMITED" } });

    const messages: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { unmount } = render(<MenuScreen tableId="table-1" />);
      await addKaraageToCart();
      await openCartPanel();
      fireEvent.click(screen.getByRole("button", { name: "注文する" }));
      const alert = await screen.findByRole("alert");
      messages.push(alert.textContent ?? "");
      unmount();
    }

    expect(new Set(messages).size).toBe(4);
  });

  it("送信中にネットワーク接続が失われると送信未完了の旨を表示し、再試行は同一のidempotencyKeyで送信する（観測可能な完了条件c）", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());
    mockSubmitOrder.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<MenuScreen tableId="table-1" />);
    await addKaraageToCart();
    await openCartPanel();
    fireEvent.click(screen.getByRole("button", { name: "注文する" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /完了していません|ネットワーク/,
    );

    mockSubmitOrder.mockResolvedValueOnce({
      ok: true,
      value: {
        deduplicated: false,
        order: { id: "order-1", createdAt: "2026-09-15T12:00:00Z", items: [] },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "再試行" }));

    expect(await screen.findByText("送信完了")).toBeInTheDocument();

    expect(mockSubmitOrder).toHaveBeenCalledTimes(2);
    const firstKey = mockSubmitOrder.mock.calls[0][0].idempotencyKey;
    const secondKey = mockSubmitOrder.mock.calls[1][0].idempotencyKey;
    expect(secondKey).toBe(firstKey);
  });

  it("送信失敗後にカートへ品目を追加してから再送信すると、新しい冥等性キーで送信され、追加前後の全品目が欠落なく送信される（独立レビューで発見されたバグの再現テスト）", async () => {
    // レビューで発見されたバグの再現手順:
    // 1. 唐揚げのみをカートに入れて送信 → ネットワーク断で「未完了」と表示される。
    // 2. 客は「未完了だ」と誤認し、カートにレモンサワーを追加する
    //    （カートは[唐揚げ, レモンサワー]になる）。
    // 3. 再試行すると、修正前の実装は1回目と同じidempotencyKeyを使い回して
    //    しまい、submit_order RPCの(session_id, idempotency_key)重複排除に
    //    より2回目のRPC呼び出し自体が「1回目と同じ送信」とみなされる
    //    （0003_rpc_customer_gateway.sqlはitemsの中身までは比較しない）。
    //    その結果レモンサワーは一切サーバーへ送信されないのに、UIは
    //    「送信完了」を表示してしまう（サイレントなデータ消失）。
    // 本テストは、修正後は2回目の送信が「新しい」idempotencyKeyを使い、
    // 追加前後の全品目（唐揚げ・レモンサワー両方）を実際にRPC呼び出しの
    // 引数として送信することを検証する（＝修正前は失敗し、修正後に
    // 通過するレグレッションテスト）。
    mockGetOrderingContext.mockResolvedValue(okContext());
    mockSubmitOrder.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<MenuScreen tableId="table-1" />);
    await addKaraageToCart();
    await openCartPanel();
    fireEvent.click(screen.getByRole("button", { name: "注文する" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /完了していません|ネットワーク/,
    );

    // カート内容(唐揚げ)は送信失敗によって破棄されない
    // （冥等性キーの破棄とカートのクリアは別の関心事、という規約の確認）。
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.getByTestId("cart-count")).toHaveTextContent("1");

    // 「未完了だ」と誤認した客がレモンサワーを追加する。
    fireEvent.click(screen.getByRole("button", { name: /レモンサワー/ }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "選択を確定" }));
    expect(screen.getByTestId("cart-count")).toHaveTextContent("2");

    mockSubmitOrder.mockResolvedValueOnce({
      ok: true,
      value: {
        deduplicated: false,
        order: {
          id: "order-2",
          createdAt: "2026-09-15T12:00:05Z",
          items: [],
        },
      },
    });

    await openCartPanel();
    fireEvent.click(screen.getByRole("button", { name: "注文する" }));

    expect(await screen.findByText("送信完了")).toBeInTheDocument();

    expect(mockSubmitOrder).toHaveBeenCalledTimes(2);
    const firstCall = mockSubmitOrder.mock.calls[0][0];
    const secondCall = mockSubmitOrder.mock.calls[1][0];

    // 核心のアサーション: カート内容が変わった後の再送信は、1回目の
    // 送信試行と同じidempotencyKeyを使い回してはならない。
    expect(secondCall.idempotencyKey).not.toBe(firstCall.idempotencyKey);

    // 2回目の送信には、追加前(唐揚げ)・追加後(レモンサワー)の両方の品目が
    // 含まれていなければならない（品目のサイレントロス防止）。
    const submittedMenuItemIds = (
      secondCall.items as ReadonlyArray<{ menuItemId: string }>
    )
      .map((item) => item.menuItemId)
      .sort();
    expect(submittedMenuItemIds).toEqual(
      ["item-drink-1", "item-food-1"].sort(),
    );
  });

  it("別端末からの注文後、確定注文合計表示が再読み込みなしに更新される（観測可能な完了条件b・ポーリング）", async () => {
    vi.useFakeTimers();
    mockGetOrderingContext.mockResolvedValueOnce(okContext(baseMenu, 0));

    render(<MenuScreen tableId="table-1" />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("confirmed-total-amount")).toHaveTextContent(
      "¥0",
    );

    // 別端末が注文を送信し、confirmedTotalが更新されたことを模す。
    mockGetOrderingContext.mockResolvedValueOnce(okContext(baseMenu, 2400));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIRMED_TOTAL_POLL_INTERVAL_MS);
    });

    expect(mockGetOrderingContext).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("confirmed-total-amount")).toHaveTextContent(
      "¥2,400",
    );
  });
});
