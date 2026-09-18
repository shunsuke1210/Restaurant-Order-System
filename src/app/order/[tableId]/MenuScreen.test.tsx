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
const mockCreateCallRequest = vi.fn();

vi.mock("@/lib/gateways/customerOrderingGateway", () => ({
  createCustomerOrderingGateway: () => ({
    getOrderingContext: (...args: unknown[]) =>
      mockGetOrderingContext(...args),
    submitOrder: (...args: unknown[]) => mockSubmitOrder(...args),
    createCallRequest: (...args: unknown[]) =>
      mockCreateCallRequest(...args),
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
    recommended: false,
    subCategory: null,
  },
  {
    id: "item-drink-1",
    name: "レモンサワー",
    price: 480,
    soldOut: false,
    imageUrl: null,
    genre: "drink",
    options: [],
    recommended: false,
    subCategory: null,
  },
  {
    id: "item-soldout-1",
    name: "刺身盛り合わせ",
    price: 1280,
    soldOut: true,
    imageUrl: null,
    genre: "food",
    options: [],
    recommended: false,
    subCategory: null,
  },
  {
    id: "item-options-1",
    name: "オプション品目",
    price: 600,
    soldOut: false,
    imageUrl: null,
    genre: "ippin",
    recommended: false,
    subCategory: null,
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
  // 0016（おすすめタブ・ジャンル内サブタブ）用の追加フィクスチャ。
  {
    id: "item-recommended-1",
    name: "本日のおすすめ丼",
    price: 900,
    soldOut: false,
    imageUrl: null,
    genre: "food",
    options: [],
    recommended: true,
    subCategory: "ご飯もの",
  },
  {
    id: "item-yakimono-1",
    name: "焼き鳥",
    price: 380,
    soldOut: false,
    imageUrl: null,
    genre: "food",
    options: [],
    recommended: false,
    subCategory: "焼き物",
  },
  {
    id: "item-yakimono-2",
    name: "豚バラ串",
    price: 350,
    soldOut: false,
    imageUrl: null,
    genre: "food",
    options: [],
    recommended: false,
    subCategory: "焼き物",
  },
];

function okContext(
  menu: MenuItemView[] = baseMenu,
  confirmedTotal = 0,
  hasOpenCallRequest = false,
  // タスク6.4のレビュー修正で追加: セッション識別子変化の検知（要件4.4）を
  // テストするため、activeSession.idを差し替え可能にする。デフォルトは
  // 既存の全テストとの互換性のため"session-1"のまま維持する。
  sessionId = "session-1",
) {
  return {
    ok: true as const,
    value: {
      table: { id: "table-1", label: "1番卓" },
      activeSession: { id: sessionId },
      confirmedTotal,
      hasOpenCallRequest,
      menu,
    },
  };
}

describe("MenuScreen", () => {
  beforeEach(() => {
    mockGetOrderingContext.mockReset();
    mockSubmitOrder.mockReset();
    mockCreateCallRequest.mockReset();
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

  it("「おすすめ」タブはジャンルを問わずrecommended: trueの品目のみを横断表示する（0016で追加）", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());

    render(<MenuScreen tableId="table-1" />);
    await screen.findByText("唐揚げ");

    fireEvent.click(screen.getByRole("tab", { name: "おすすめ" }));

    expect(screen.getByText("本日のおすすめ丼")).toBeInTheDocument();
    expect(screen.queryByText("唐揚げ")).not.toBeInTheDocument();
    expect(screen.queryByText("焼き鳥")).not.toBeInTheDocument();
    // 「おすすめ」タブではサブタブ自体を表示しない
    // （ジャンル横断のため「一品/フード/ドリンク」いずれのサブカテゴリ
    // 一覧にも一意に対応しないため。SubTabs.tsx冒頭コメント参照）。
    expect(screen.queryByRole("tab", { name: "焼き物" })).not.toBeInTheDocument();
  });

  it("ジャンル内にサブカテゴリを持つ品目があればサブタブが表示され、選択すると絞り込まれる（0016で追加）", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());

    render(<MenuScreen tableId="table-1" />);
    await screen.findByText("唐揚げ");

    fireEvent.click(screen.getByRole("tab", { name: "フード" }));
    // フードジャンルには「ご飯もの」（おすすめ丼）・「焼き物」
    // （焼き鳥・豚バラ串）というsubCategoryを持つ品目と、
    // subCategoryを持たない品目（唐揚げ・刺身盛り合わせ）が混在する。
    // サブタブ未選択時はサブカテゴリの有無に関わらず全品目を表示する。
    expect(screen.getByText("唐揚げ")).toBeInTheDocument();
    expect(screen.getByText("焼き鳥")).toBeInTheDocument();
    expect(screen.getByText("本日のおすすめ丼")).toBeInTheDocument();

    const yakimonoSubTab = screen.getByRole("tab", { name: "焼き物" });
    expect(yakimonoSubTab).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "ご飯もの" }),
    ).toBeInTheDocument();

    fireEvent.click(yakimonoSubTab);
    // 「焼き物」を選ぶと、同じsubCategoryを持つ品目（複数）のみに絞り込まれ、
    // subCategoryを持たない品目や他のsubCategoryの品目は消える。
    expect(screen.getByText("焼き鳥")).toBeInTheDocument();
    expect(screen.getByText("豚バラ串")).toBeInTheDocument();
    expect(screen.queryByText("唐揚げ")).not.toBeInTheDocument();
    expect(screen.queryByText("本日のおすすめ丼")).not.toBeInTheDocument();

    // 選択中のサブタブを再度タップすると絞り込みが解除される。
    fireEvent.click(yakimonoSubTab);
    expect(screen.getByText("唐揚げ")).toBeInTheDocument();
    expect(screen.getByText("焼き鳥")).toBeInTheDocument();
  });

  it("ジャンルタブを切り替えるとサブタブの選択状態がリセットされる（0016で追加）", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());

    render(<MenuScreen tableId="table-1" />);
    await screen.findByText("唐揚げ");

    fireEvent.click(screen.getByRole("tab", { name: "フード" }));
    fireEvent.click(screen.getByRole("tab", { name: "焼き物" }));
    expect(screen.queryByText("唐揚げ")).not.toBeInTheDocument();

    // ドリンクへ切り替えると、フードの「焼き物」選択は持ち越されない
    // （持ち越されるとドリンクにも存在しないサブカテゴリが暗黙に効いた
    // ままになり、原因不明の絞り込みに見えてしまう）。
    fireEvent.click(screen.getByRole("tab", { name: "ドリンク" }));
    expect(screen.getByText("レモンサワー")).toBeInTheDocument();
    // ドリンクにはsubCategoryを持つ品目が無いため、サブタブ行自体が
    // 描画されない。
    expect(screen.queryByRole("tab", { name: "焼き物" })).not.toBeInTheDocument();

    // フードへ戻ると、サブタブの選択は解除された状態（全品目表示）に
    // 戻っている。
    fireEvent.click(screen.getByRole("tab", { name: "フード" }));
    expect(screen.getByText("唐揚げ")).toBeInTheDocument();
    expect(screen.getByText("焼き鳥")).toBeInTheDocument();
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
    // タスク6.4でNoActiveSessionScreen（見出し・本文の両方に案内文言を
    // 持つ）へ置き換わったため、/スタッフ|店員/は複数要素にマッチしうる
    // （getAllByTextで存在のみを確認する。詳細な文言検証はタスク6.4の
    // 専用describeブロックで行う）。
    expect(screen.getAllByText(/スタッフ|店員/).length).toBeGreaterThan(0);
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
  fireEvent.click(screen.getByTestId("order-confirm-button"));
  return screen.findByRole("dialog", { name: "注文カート" });
}

describe("MenuScreen（タスク6.2: 注文送信・確定注文合計表示・通信断ハンドリング）", () => {
  beforeEach(() => {
    mockGetOrderingContext.mockReset();
    mockSubmitOrder.mockReset();
    mockCreateCallRequest.mockReset();
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

// =========================================================================
// タスク6.3: 呼び出しボタンUI
// Requirements: 2.1, 2.2, 2.3
// =========================================================================

describe("MenuScreen（タスク6.3: 呼び出しボタンUI）", () => {
  beforeEach(() => {
    mockGetOrderingContext.mockReset();
    mockSubmitOrder.mockReset();
    mockCreateCallRequest.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("アクティブセッションが存在する間、呼び出しボタンが表示される（要件2.1）", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());

    render(<MenuScreen tableId="table-1" />);
    await screen.findByText("唐揚げ");

    const button = screen.getByRole("button", { name: "スタッフを呼ぶ" });
    expect(button).toBeEnabled();
  });

  it(
    "呼び出しボタンをタップすると正しいsessionIdでcreateCallRequestが呼ばれ、" +
      "成功すると『呼び出し中』の再送不可な状態になる（観測可能な完了条件）",
    async () => {
      mockGetOrderingContext.mockResolvedValue(okContext());
      mockCreateCallRequest.mockResolvedValueOnce({
        ok: true,
        value: {
          id: "call-1",
          sessionId: "session-1",
          status: "open",
          createdAt: "2026-09-15T12:00:00Z",
        },
      });

      render(<MenuScreen tableId="table-1" />);
      await screen.findByText("唐揚げ");

      fireEvent.click(
        screen.getByRole("button", { name: "スタッフを呼ぶ" }),
      );

      expect(mockCreateCallRequest).toHaveBeenCalledWith({
        sessionId: "session-1",
      });

      const calledButton = await screen.findByRole("button", {
        name: "呼び出し中",
      });
      expect(calledButton).toBeDisabled();

      // 連打しても再送はされない（重複防止表示、観測可能な完了条件そのもの）。
      fireEvent.click(calledButton);
      expect(mockCreateCallRequest).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "CALL_ALREADY_OPENはエラー表示ではなく、既に成立している『呼び出し中』状態と" +
      "して扱われる（要件2.3、致命的な失敗として扱わない）",
    async () => {
      mockGetOrderingContext.mockResolvedValue(okContext());
      mockCreateCallRequest.mockResolvedValueOnce({
        ok: false,
        error: { code: "CALL_ALREADY_OPEN" },
      });

      render(<MenuScreen tableId="table-1" />);
      await screen.findByText("唐揚げ");

      fireEvent.click(
        screen.getByRole("button", { name: "スタッフを呼ぶ" }),
      );

      const calledButton = await screen.findByRole("button", {
        name: "呼び出し中",
      });
      expect(calledButton).toBeDisabled();
      // CALL_ALREADY_OPENは客の意図（スタッフに来てほしい）が既に満たされて
      // いる状態であり、警告的なエラー表示にはしない。
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("SESSION_NOT_ACTIVEはクラッシュせず、専用のエラーメッセージを表示する（防御的エラーハンドリング）", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());
    mockCreateCallRequest.mockResolvedValueOnce({
      ok: false,
      error: { code: "SESSION_NOT_ACTIVE" },
    });

    render(<MenuScreen tableId="table-1" />);
    await screen.findByText("唐揚げ");

    fireEvent.click(screen.getByRole("button", { name: "スタッフを呼ぶ" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /終了|スタッフ/,
    );
  });

  it("想定外の例外はtry/catchで捕捉され、unhandled rejectionにならず汎用エラーメッセージを表示する", async () => {
    mockGetOrderingContext.mockResolvedValue(okContext());
    mockCreateCallRequest.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<MenuScreen tableId="table-1" />);
    await screen.findByText("唐揚げ");

    fireEvent.click(screen.getByRole("button", { name: "スタッフを呼ぶ" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /予期しないエラー|完了していません|ネットワーク/,
    );
    // 呼び出しボタン自体はローカル状態を「呼び出し済み」に固定しない
    // （サーバーが実際には受理していない可能性があるため）。
    expect(
      screen.getByRole("button", { name: "スタッフを呼ぶ" }),
    ).toBeEnabled();
  });

  it(
    "対応済み（resolved）になったことをgetOrderingContextのポーリングで検知すると、" +
      "ボタンが再び押せる状態に戻る（観測可能な完了条件: 対応済みになるまで再送不可）",
    async () => {
      vi.useFakeTimers();
      // ページ読み込み時点で既に呼び出し中（例: 送信直後の再読み込み）を模す。
      mockGetOrderingContext.mockResolvedValueOnce(
        okContext(baseMenu, 0, true),
      );

      render(<MenuScreen tableId="table-1" />);

      await act(async () => {
        await Promise.resolve();
      });
      expect(
        screen.getByRole("button", { name: "呼び出し中" }),
      ).toBeDisabled();

      // レジ側で対応済みにしたことを、次のポーリングが反映する。
      mockGetOrderingContext.mockResolvedValueOnce(
        okContext(baseMenu, 0, false),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRMED_TOTAL_POLL_INTERVAL_MS);
      });

      const reenabledButton = screen.getByRole("button", {
        name: "スタッフを呼ぶ",
      });
      expect(reenabledButton).toBeEnabled();

      // 再度呼び出せることの確認（新しい呼び出し意図を妨げない）。
      mockCreateCallRequest.mockResolvedValueOnce({
        ok: true,
        value: {
          id: "call-2",
          sessionId: "session-1",
          status: "open",
          createdAt: "2026-09-15T12:05:00Z",
        },
      });
      fireEvent.click(reenabledButton);
      expect(mockCreateCallRequest).toHaveBeenCalledWith({
        sessionId: "session-1",
      });
    },
  );

  it(
    "処理中のポーリング応答が、呼び出しボタンの楽観的な『呼び出し中』状態を" +
      "巻き戻さない（独立レビューで発見されたレース条件の再現テスト）",
    async () => {
      // 独立レビューで発見・再現されたレース条件:
      // 1. ポーリング要求（#2）が送信されるが、サーバーからの応答はまだ
      //    届いていない（in-flight）。
      // 2. その応答が届く前に客が呼び出しボタンをタップし、createCallRequest
      //    が成功する。この時点でサーバー上には実際にopenな呼び出しが
      //    存在するため、UIは楽観的に即座へ「呼び出し中」（再送不可）へ
      //    切り替わる。
      // 3. ところがポーリング要求#2は客がタップする"前"に送信されたもので
      //    あり、その応答は「タップ時点ではまだ呼び出しが無かった」という
      //    hasOpenCallRequest: falseを（応答としては正しく、しかし今となっては
      //    古い事実として）返す。
      // 4. 修正前の実装はgetOrderingContextの応答でview全体を無条件に
      //    上書きしていたため、この古い応答が楽観的な「呼び出し中」を
      //    巻き戻し、実際には対応済みでない呼び出しに対してボタンが
      //    「スタッフを呼ぶ」（再送可能）に戻ってしまっていた——本タスクの
      //    観測可能な完了条件「呼び出し送信後、対応済みになるまでボタンが
      //    再送不可の状態を示す」に違反する。
      //
      // 本テストは、(a) この古い応答が「呼び出し中」状態を巻き戻さないこと
      // （核心のリグレッション防止）と、(b) その後に送信される正当な
      // ポーリング（タップより後に送信されたもの）は通常どおり反映され、
      // レジ側の対応済み化によるfalseへの遷移も最終的には正しく検知できる
      // こと（＝古い応答を無視する仕組みが以後の更新まで永久に遮断して
      // しまっていないこと）の両方を検証する。
      vi.useFakeTimers();

      mockGetOrderingContext.mockResolvedValueOnce(
        okContext(baseMenu, 0, false),
      );

      render(<MenuScreen tableId="table-1" />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        screen.getByRole("button", { name: "スタッフを呼ぶ" }),
      ).toBeEnabled();

      // ポーリング要求#2（客のタップより"前"に送信される）を、応答未解決の
      // まま発生させる。
      let resolveStalePoll!: (value: unknown) => void;
      const stalePollPromise = new Promise((resolve) => {
        resolveStalePoll = resolve;
      });
      mockGetOrderingContext.mockReturnValueOnce(stalePollPromise);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRMED_TOTAL_POLL_INTERVAL_MS);
      });
      expect(mockGetOrderingContext).toHaveBeenCalledTimes(2);

      // ポーリング要求#2の応答がまだ届かない間に、客が呼び出しボタンを
      // タップする。
      mockCreateCallRequest.mockResolvedValueOnce({
        ok: true,
        value: {
          id: "call-1",
          sessionId: "session-1",
          status: "open",
          createdAt: "2026-09-15T12:00:00Z",
        },
      });

      fireEvent.click(
        screen.getByRole("button", { name: "スタッフを呼ぶ" }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        screen.getByRole("button", { name: "呼び出し中" }),
      ).toBeDisabled();

      // ポーリング要求#2が、タップより前の（今となっては古い）
      // hasOpenCallRequest: falseで応答する。
      await act(async () => {
        resolveStalePoll(okContext(baseMenu, 0, false));
        await vi.advanceTimersByTimeAsync(0);
      });

      // 核心のアサーション: 古いポーリング応答によって「呼び出し中」状態が
      // 巻き戻されてはならない。
      expect(
        screen.getByRole("button", { name: "呼び出し中" }),
      ).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: "スタッフを呼ぶ" }),
      ).not.toBeInTheDocument();

      // 順方向の確認その1: タップより"後"に送信されるポーリング要求#3は
      // 通常どおり適用される（trueのまま、抑制されていない）。
      mockGetOrderingContext.mockResolvedValueOnce(
        okContext(baseMenu, 0, true),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRMED_TOTAL_POLL_INTERVAL_MS);
      });
      expect(
        screen.getByRole("button", { name: "呼び出し中" }),
      ).toBeDisabled();

      // 順方向の確認その2: レジ側で対応済みにしたことを、その次の
      // ポーリング要求#4が正しく検知し、falseへの更新が反映される
      // （＝古い応答を無視する仕組みが以後の正当な更新まで永久に
      // ブロックしてしまっていないことの確認）。
      mockGetOrderingContext.mockResolvedValueOnce(
        okContext(baseMenu, 0, false),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRMED_TOTAL_POLL_INTERVAL_MS);
      });
      expect(
        screen.getByRole("button", { name: "スタッフを呼ぶ" }),
      ).toBeEnabled();
    },
  );
});

// =========================================================================
// タスク6.4: アクティブセッション不在時の案内画面
// Requirements: 1.1, 1.3
// =========================================================================

function noSessionContext(label = "1番卓") {
  return {
    ok: true as const,
    value: {
      table: { id: "table-1", label },
      activeSession: null,
      confirmedTotal: 0,
      hasOpenCallRequest: false,
      menu: baseMenu,
    },
  };
}

describe("MenuScreen（タスク6.4: アクティブセッション不在時の案内画面）", () => {
  beforeEach(() => {
    mockGetOrderingContext.mockReset();
    mockSubmitOrder.mockReset();
    mockCreateCallRequest.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("アクティブセッションが無い場合、案内画面のみが表示され、メニュー・カート・確定注文合計バー・呼び出しボタンは一切描画されない（観測可能な完了条件）", async () => {
    mockGetOrderingContext.mockResolvedValue(noSessionContext());

    render(<MenuScreen tableId="table-1" />);

    expect(
      await screen.findByTestId("no-active-session-screen"),
    ).toBeInTheDocument();
    // 要件1.3「スタッフを呼ぶよう促す」の文言（見出し・本文それぞれで
    // 個別に検証する。両方とも/スタッフ|店員/にマッチするため単純な
    // getByTextだと複数要素がヒットしてしまう）。
    expect(
      screen.getByRole("heading", { name: /スタッフ/ }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("no-active-session-message")).toHaveTextContent(
      "店員",
    );

    // 卓の識別のためラベル表示は許容される（NoActiveSessionScreen.tsx
    // 冒頭コメント参照）が、メニュー・カート・確定注文合計バー・
    // 呼び出しボタンは一切描画されない（CSSで隠すのではなく、そもそも
    // DOM上に構築されないことをqueryBy*で確認する）。
    expect(screen.getByTestId("table-label")).toHaveTextContent("1番卓");
    expect(screen.queryByText("唐揚げ")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "スタッフを呼ぶ" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("call-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cart-count")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("confirmed-total-bar"),
    ).not.toBeInTheDocument();
  });

  it(
    "アクティブセッション不在の状態からレジの入店操作（start_session）でセッションが" +
      "作成されると、案内画面はポーリングにより再読み込みなしにメニュー画面へ自動遷移する" +
      "（6.4の設計判断: ポーリングを\"no-session\"状態でも継続する）",
    async () => {
      vi.useFakeTimers();
      mockGetOrderingContext.mockResolvedValueOnce(noSessionContext());

      render(<MenuScreen tableId="table-1" />);

      await act(async () => {
        await Promise.resolve();
      });
      expect(
        screen.getByTestId("no-active-session-screen"),
      ).toBeInTheDocument();

      // レジがstart_sessionを実行し、次のポーリングでアクティブセッションが
      // 検知される。
      mockGetOrderingContext.mockResolvedValueOnce(okContext());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRMED_TOTAL_POLL_INTERVAL_MS);
      });

      expect(mockGetOrderingContext).toHaveBeenCalledTimes(2);
      expect(
        screen.queryByTestId("no-active-session-screen"),
      ).not.toBeInTheDocument();
      // 6.2/6.3のfakeTimersテストと同じ方針: fakeTimers有効時は
      // findBy*（内部でsetTimeoutベースの再試行ループを使うため、実タイマー
      // が動かない状況では待ち続けてタイムアウトする）ではなく、直前の
      // actでReactの状態更新が同期的にflush済みであることを前提に
      // 同期的なgetBy*を使う。
      expect(screen.getByText("唐揚げ")).toBeInTheDocument();
    },
  );

  it("メニュー画面の表示中に来店セッションが終了すると、ポーリングにより案内画面へ自動的に戻る", async () => {
    vi.useFakeTimers();
    mockGetOrderingContext.mockResolvedValueOnce(okContext());

    render(<MenuScreen tableId="table-1" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("唐揚げ")).toBeInTheDocument();

    // レジが会計操作でセッションを終了したことを模す。
    mockGetOrderingContext.mockResolvedValueOnce(noSessionContext());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIRMED_TOTAL_POLL_INTERVAL_MS);
    });

    expect(
      screen.getByTestId("no-active-session-screen"),
    ).toBeInTheDocument();
    expect(screen.queryByText("唐揚げ")).not.toBeInTheDocument();
  });
});

// =========================================================================
// タスク6.4のレビュー差し戻し対応: セッション識別子変化時の
// per-session-scopedなクライアント状態リセット
// Requirements: 4.4（要件4のセッション整合性の意図を直接サポートする
// 追加修正）
//
// 独立レビューで発見されたバグ: 卓のQRコードは客グループが入れ替わる
// たびに再利用されるが、要件4.4により新しい来店セッションには必ず
// 新しい（前回とは異なる）sessionIdが割り当てられる。ready(セッションA)
// → no-session → ready(セッションB、別id) というサイクルを経ても、
// cart/cartPanelOpen/submission/callState/idempotencyKeyRef.currentが
// 一切リセットされず、セッションAの状態がセッションBの画面に残っていた
// （MenuScreen.tsxのlastSessionIdRef/resetSessionScopedStateコメント
// 参照）。
//
// 本ブロックの全テストはvi.useFakeTimers()を使う（ポーリングの複数tickを
// 明示的に進める必要があるため）。既存の6.2/6.3のfakeTimersテストと同じ
// 方針（1007行目付近のコメント参照）で、findBy*（内部でsetTimeoutベースの
// 再試行ループを使うため、実タイマーが動かない状況では待ち続けて
// タイムアウトする）は使わず、直前のactでReactの状態更新が同期的に
// flush済みであることを前提に同期的なgetBy*を使う専用ヘルパーを用いる
// （ファイル冒頭のaddKaraageToCart/openCartPanelは内部でfindBy*を使う
// ため、fakeTimers下ではそのまま使えない）。
// =========================================================================

/** addKaraageToCartのfakeTimers対応版（findBy*ではなく同期的なgetBy*を使う）。 */
function addKaraageToCartSync() {
  fireEvent.click(screen.getByRole("button", { name: /唐揚げ/ }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "選択を確定" }));
}

/** openCartPanelのfakeTimers対応版（findBy*ではなく同期的なgetBy*を使う）。 */
function openCartPanelSync() {
  fireEvent.click(screen.getByTestId("order-confirm-button"));
  return screen.getByRole("dialog", { name: "注文カート" });
}

describe("MenuScreen（タスク6.4レビュー修正: セッション識別子変化時のクライアント状態リセット）", () => {
  beforeEach(() => {
    mockGetOrderingContext.mockReset();
    mockSubmitOrder.mockReset();
    mockCreateCallRequest.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "no-sessionを経由して異なるsessionIdの新しいセッションへ遷移すると、" +
      "前のセッションのカートは引き継がれない" +
      "（独立レビューで発見されたカート越境バグの再現テスト）",
    async () => {
      vi.useFakeTimers();
      mockGetOrderingContext.mockResolvedValueOnce(
        okContext(baseMenu, 0, false, "session-A"),
      );

      render(<MenuScreen tableId="table-1" />);
      await act(async () => {
        await Promise.resolve();
      });

      addKaraageToCartSync();
      expect(screen.getByTestId("cart-count")).toHaveTextContent("1");
      // カートパネルも開いたままにしておく（cartPanelOpenのリセットも
      // 併せて検証するため）。
      openCartPanelSync();
      expect(
        screen.getByRole("dialog", { name: "注文カート" }),
      ).toBeInTheDocument();

      // セッションA終了（レジの会計操作）を検知し"no-session"へ遷移。
      mockGetOrderingContext.mockResolvedValueOnce(noSessionContext());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRMED_TOTAL_POLL_INTERVAL_MS);
      });
      expect(
        screen.getByTestId("no-active-session-screen"),
      ).toBeInTheDocument();

      // 後から着席した別の客グループ（セッションB、別id）を検知。
      mockGetOrderingContext.mockResolvedValueOnce(
        okContext(baseMenu, 0, false, "session-B"),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRMED_TOTAL_POLL_INTERVAL_MS);
      });

      expect(screen.getByText("唐揚げ")).toBeInTheDocument();
      // 核心のアサーション: セッションAのカート内容・カートパネルの
      // 開閉状態がセッションBに引き継がれていない。
      expect(screen.getByTestId("cart-count")).toHaveTextContent("0");
      expect(
        screen.queryByRole("dialog", { name: "注文カート" }),
      ).not.toBeInTheDocument();
    },
  );

  it(
    "呼び出し操作でエラー状態になった直後にno-sessionを経由して異なる" +
      "sessionIdの新しいセッションへ遷移すると、前のセッションの呼び出し" +
      "エラー表示は引き継がれない" +
      "（独立レビューで発見された呼び出し状態越境バグの再現テスト）",
    async () => {
      vi.useFakeTimers();
      mockGetOrderingContext
        .mockResolvedValueOnce(okContext(baseMenu, 0, false, "session-A"))
        // handleCallStaffのSESSION_NOT_ACTIVE分岐が明示的に呼ぶ
        // refreshOrderingContextの応答（同一セッションのまま）。
        .mockResolvedValueOnce(okContext(baseMenu, 0, false, "session-A"))
        // ポーリング: セッションA終了を検知。
        .mockResolvedValueOnce(noSessionContext())
        // ポーリング: 別の客グループ（セッションB、別id）を検知。
        .mockResolvedValueOnce(okContext(baseMenu, 0, false, "session-B"));
      mockCreateCallRequest.mockResolvedValueOnce({
        ok: false,
        error: { code: "SESSION_NOT_ACTIVE" },
      });

      render(<MenuScreen tableId="table-1" />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText("唐揚げ")).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "スタッフを呼ぶ" }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole("alert")).toHaveTextContent(/終了|スタッフ/);

      // セッションA終了を検知し"no-session"へ遷移。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRMED_TOTAL_POLL_INTERVAL_MS);
      });
      expect(
        screen.getByTestId("no-active-session-screen"),
      ).toBeInTheDocument();

      // 別の客グループ（セッションB、別id）を検知。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRMED_TOTAL_POLL_INTERVAL_MS);
      });

      expect(screen.getByText("唐揚げ")).toBeInTheDocument();
      // 核心のアサーション: セッションAの呼び出しエラー表示が残っておらず、
      // 呼び出しボタンは通常の（未呼び出しの）状態を示す。
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "スタッフを呼ぶ" }),
      ).toBeEnabled();
    },
  );

  it(
    "送信エラー表示が出た状態のままno-sessionを経由して異なるsessionId" +
      "の新しいセッションへ遷移すると、前のセッションの送信状態表示は" +
      "引き継がれない（独立レビューで発見された送信状態越境バグの再現テスト）",
    async () => {
      vi.useFakeTimers();
      mockGetOrderingContext
        .mockResolvedValueOnce(okContext(baseMenu, 0, false, "session-A"))
        .mockResolvedValueOnce(noSessionContext())
        .mockResolvedValueOnce(okContext(baseMenu, 0, false, "session-B"));
      mockSubmitOrder.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      render(<MenuScreen tableId="table-1" />);
      await act(async () => {
        await Promise.resolve();
      });

      addKaraageToCartSync();
      openCartPanelSync();
      fireEvent.click(screen.getByRole("button", { name: "注文する" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole("alert")).toHaveTextContent(
        /完了していません|ネットワーク/,
      );

      // ダイアログを閉じずに（＝submissionのエラー状態を保持したまま）
      // セッションA終了を検知し"no-session"へ遷移。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRMED_TOTAL_POLL_INTERVAL_MS);
      });
      expect(
        screen.getByTestId("no-active-session-screen"),
      ).toBeInTheDocument();

      // 別の客グループ（セッションB、別id）を検知。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRMED_TOTAL_POLL_INTERVAL_MS);
      });
      expect(screen.getByText("唐揚げ")).toBeInTheDocument();

      // カートパネル自体がcartPanelOpenのリセットにより閉じているため、
      // 送信エラー表示はDOM上に存在しない。
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("dialog", { name: "注文カート" }),
      ).not.toBeInTheDocument();

      // セッションBで新たにカートへ品目を追加してカートパネルを開いても、
      // セッションAの送信エラー表示が残っていない
      // （submissionがidleへリセットされていることの確認）。
      addKaraageToCartSync();
      openCartPanelSync();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("送信完了")).not.toBeInTheDocument();
    },
  );

  it(
    "sessionIdが変わらない通常のポーリング更新では、進行中のカートは" +
      "クリアされない（過度に広い修正になっていないことを確認する" +
      "否定的リグレッションテスト）",
    async () => {
      vi.useFakeTimers();
      mockGetOrderingContext.mockResolvedValueOnce(
        okContext(baseMenu, 0, false, "session-1"),
      );

      render(<MenuScreen tableId="table-1" />);
      await act(async () => {
        await Promise.resolve();
      });

      addKaraageToCartSync();
      expect(screen.getByTestId("cart-count")).toHaveTextContent("1");

      // 同じsessionIdのまま、confirmedTotalだけが更新される通常の
      // ポーリング（同席者の別端末からの注文を模す、要件1.12）。
      mockGetOrderingContext.mockResolvedValueOnce(
        okContext(baseMenu, 1500, false, "session-1"),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRMED_TOTAL_POLL_INTERVAL_MS);
      });

      expect(screen.getByTestId("confirmed-total-amount")).toHaveTextContent(
        "¥1,500",
      );
      // 核心のアサーション: sessionIdが変わっていないため、進行中の
      // カートは一切クリアされない（このガードが無いと、5秒ごとの
      // ポーリングのたびにカートが消えてしまう重大なregressionになる）。
      expect(screen.getByTestId("cart-count")).toHaveTextContent("1");
    },
  );
});
