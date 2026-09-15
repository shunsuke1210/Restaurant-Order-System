import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import MenuScreen from "./MenuScreen";
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
// Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 7.2

const mockGetOrderingContext = vi.fn();

vi.mock("@/lib/gateways/customerOrderingGateway", () => ({
  createCustomerOrderingGateway: () => ({
    getOrderingContext: (...args: unknown[]) =>
      mockGetOrderingContext(...args),
    submitOrder: vi.fn(),
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

function okContext(menu: MenuItemView[] = baseMenu) {
  return {
    ok: true as const,
    value: {
      table: { id: "table-1", label: "1番卓" },
      activeSession: { id: "session-1" },
      confirmedTotal: 0,
      menu,
    },
  };
}

describe("MenuScreen", () => {
  beforeEach(() => {
    mockGetOrderingContext.mockReset();
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
