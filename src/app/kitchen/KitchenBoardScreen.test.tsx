import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import KitchenBoardScreen from "./KitchenBoardScreen";

// ensureDeviceSessionをモックし、KitchenBoardScreenのロジック（デバイス
// セッション確認の分岐・タブ切り替え・固定ヘッダー構造）を実際のSupabase/DBに
// 接続せずに検証する（src/app/setup/[role]/SetupForm.test.tsxと同じ
// モック方式）。
const mockEnsureDeviceSession = vi.fn();

vi.mock("@/lib/device/useDeviceIdentity", () => ({
  ensureDeviceSession: (...args: unknown[]) => mockEnsureDeviceSession(...args),
}));

// タスク7.2: デフォルトタブが"food"のため、デバイスセッション確立済み
// （"ready"）の全テストで必ずFoodBoardがマウントされ
// `createStaffOperationsGateway(...).listKitchenFeed`を呼び出す。
// FoodBoard自体の詳細な振る舞い（ジャンル絞り込み・並び順保持・カード表示・
// エラー処理）はFoodBoard.test.tsxで専用に検証するため、ここでは
// KitchenBoardScreen固有の関心事（タブ切り替え・固定ヘッダー構造）を
// 阻害しないよう空配列を返す最小限のモックに留める
// （MenuScreen.test.tsxのcustomerOrderingGatewayモックと同型の方式）。
// タスク7.4: 同じ理由でlistMenuItems（SoldOutBoardが使用）も空配列を返す
// 最小限のモックを追加する。SoldOutBoard自体の詳細な振る舞い（検索・
// サマリー・確認モーダル）はSoldOutBoard.test.tsxで専用に検証する。
const mockListKitchenFeed = vi.fn();
const mockListMenuItems = vi.fn();

vi.mock("@/lib/gateways/staffOperationsGateway", () => ({
  createStaffOperationsGateway: () => ({
    listKitchenFeed: (...args: unknown[]) => mockListKitchenFeed(...args),
    listMenuItems: (...args: unknown[]) => mockListMenuItems(...args),
  }),
}));

describe("KitchenBoardScreen", () => {
  beforeEach(() => {
    mockEnsureDeviceSession.mockReset();
    mockListKitchenFeed.mockReset();
    mockListKitchenFeed.mockResolvedValue({ ok: true, value: [] });
    mockListMenuItems.mockReset();
    mockListMenuItems.mockResolvedValue({ ok: true, value: [] });
  });

  it("デバイスが未プロビジョニング（NOT_PROVISIONED）の場合、クラッシュせず案内メッセージを表示する", async () => {
    mockEnsureDeviceSession.mockResolvedValue({
      ok: false,
      error: { code: "NOT_PROVISIONED" },
    });

    render(<KitchenBoardScreen />);

    expect(
      await screen.findByTestId("kitchen-device-unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("セットアップ");
    // 未プロビジョニング時はタブ・ヘッダー・プレースホルダーのいずれも
    // 描画されない（9.1が正式な導線を実装するまでの最小限の案内に留める）。
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("ensureDeviceSessionが例外を投げても（ドキュメント化されていない失敗）、クラッシュせず案内メッセージを表示する", async () => {
    mockEnsureDeviceSession.mockRejectedValue(new Error("network error"));

    render(<KitchenBoardScreen />);

    expect(
      await screen.findByTestId("kitchen-device-unavailable"),
    ).toBeInTheDocument();
  });

  it("kitchen以外のroleでプロビジョニング済みの場合も、クラッシュせず案内メッセージを表示する", async () => {
    mockEnsureDeviceSession.mockResolvedValue({
      ok: true,
      value: { deviceUserId: "user-1", role: "register", storeId: "store-1" },
    });

    render(<KitchenBoardScreen />);

    expect(
      await screen.findByTestId("kitchen-device-unavailable"),
    ).toBeInTheDocument();
  });

  describe("kitchenデバイスとしてプロビジョニング済みの場合", () => {
    beforeEach(() => {
      mockEnsureDeviceSession.mockResolvedValue({
        ok: true,
        value: { deviceUserId: "user-1", role: "kitchen", storeId: "store-1" },
      });
    });

    it("初期表示はフードボードのタブが選択され、FoodBoard（実データ表示、タスク7.2）が表示される", async () => {
      render(<KitchenBoardScreen />);

      // タスク7.2でフードボードのプレースホルダーはFoodBoardへ置き換わった。
      // FoodBoard自体の中身の検証（ジャンル絞り込み・並び順保持・カード
      // 表示等）はFoodBoard.test.tsxが専用に担うため、ここではKitchenBoard
      // Screenの責務——正しいタブ選択状態でFoodBoardがマウントされること
      // ——のみを検証する。
      expect(await screen.findByTestId("food-board")).toBeInTheDocument();
      expect(
        screen.getByRole("tab", { name: "フードボード" }),
      ).toHaveAttribute("aria-selected", "true");
      expect(mockListKitchenFeed).toHaveBeenCalledWith({ storeId: "store-1" });
    });

    it("3つのタブ（フード／ドリンク／売り切れ）が表示され、クリックで表示内容が切り替わる（他のタブの内容は表示されない）", async () => {
      render(<KitchenBoardScreen />);
      await screen.findByTestId("food-board");

      const foodTab = screen.getByRole("tab", { name: "フードボード" });
      const drinkTab = screen.getByRole("tab", { name: "ドリンクボード" });
      const soldoutTab = screen.getByRole("tab", { name: "売り切れボード" });

      fireEvent.click(drinkTab);
      // タスク7.3でドリンクボードのプレースホルダーはDrinkBoardへ置き換わった。
      // DrinkBoard自体の中身の検証（ジャンル絞り込み・並び順保持・カード
      // 表示等）はDrinkBoard.test.tsxが専用に担うため、ここではKitchenBoard
      // Screenの責務——正しいタブ選択状態でDrinkBoardがマウントされること
      // ——のみを検証する。
      expect(await screen.findByTestId("drink-board")).toBeInTheDocument();
      expect(screen.queryByTestId("food-board")).not.toBeInTheDocument();
      expect(drinkTab).toHaveAttribute("aria-selected", "true");
      expect(foodTab).toHaveAttribute("aria-selected", "false");

      fireEvent.click(soldoutTab);
      // タスク7.4でソールドアウトボードのプレースホルダーはSoldOutBoardへ
      // 置き換わった。SoldOutBoard自体の中身の検証（検索・サマリー・確認
      // モーダル等）はSoldOutBoard.test.tsxが専用に担うため、ここでは
      // KitchenBoardScreenの責務——正しいタブ選択状態でSoldOutBoardが
      // マウントされること——のみを検証する。
      expect(await screen.findByTestId("soldout-board")).toBeInTheDocument();
      expect(screen.queryByTestId("drink-board")).not.toBeInTheDocument();
      expect(soldoutTab).toHaveAttribute("aria-selected", "true");
      expect(mockListMenuItems).toHaveBeenCalledWith({ storeId: "store-1" });

      fireEvent.click(foodTab);
      expect(await screen.findByTestId("food-board")).toBeInTheDocument();
      expect(screen.queryByTestId("soldout-board")).not.toBeInTheDocument();
    });

    it("固定ヘッダー（タブバー含む）とスクロール領域は兄弟要素であり、タブバーはスクロール領域の子孫ではない", async () => {
      render(<KitchenBoardScreen />);
      await screen.findByTestId("food-board");

      const header = screen.getByTestId("kitchen-fixed-header");
      const scrollArea = screen.getByTestId("kitchen-scroll-area");
      const tablist = screen.getByRole("tablist");

      // ヘッダーとスクロール領域は同じ親を持つ兄弟要素（どちらかがもう
      // 一方の子孫ではない）。mock-preview.htmlの`.screen-header`/`.tabs`
      // （flex-shrink:0）と`.scroll-area`の関係と同じ構造。
      expect(header.parentElement).toBe(scrollArea.parentElement);
      expect(scrollArea.contains(header)).toBe(false);
      expect(header.contains(scrollArea)).toBe(false);

      // タブバー自体はヘッダー（固定領域）の子孫であり、スクロール領域の
      // 子孫ではない——観測可能な完了条件「スクロールしてもタブ・ヘッダーが
      // 画面上部に固定表示され続ける」が構造上成立するための前提。
      expect(header.contains(tablist)).toBe(true);
      expect(scrollArea.contains(tablist)).toBe(false);
    });
  });
});
