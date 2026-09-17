import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// タスク7.6: 接続断表示と再同期。useRealtimeFeed（タスク5で実装済み・
// 単体テスト済み）はモックし、`status`を任意に操作し`onSync`を手動で
// 発火できるようにする（本タスクのプロンプトが指示する
// 「module-level vi.mock、既存のensureDeviceSession/
// createStaffOperationsGatewayモックと同じパターン」）。実Supabase
// クライアント（`createBrowserClient()`）はKitchenBoardScreen内部で
// useMemo経由で生成されるがuseRealtimeFeed自体をモックするため未使用となり、
// 実際にwebsocket接続を試みることはない。
const mockUseRealtimeFeed = vi.fn();

vi.mock("@/lib/realtime/useRealtimeFeed", () => ({
  useRealtimeFeed: (...args: unknown[]) => mockUseRealtimeFeed(...args),
}));

describe("KitchenBoardScreen", () => {
  beforeEach(() => {
    mockEnsureDeviceSession.mockReset();
    mockListKitchenFeed.mockReset();
    mockListKitchenFeed.mockResolvedValue({ ok: true, value: [] });
    mockListMenuItems.mockReset();
    mockListMenuItems.mockResolvedValue({ ok: true, value: [] });
    mockUseRealtimeFeed.mockReset();
    // 既定値: 接続済み・onSyncは何もしない。接続断関連の振る舞いに
    // 関心のない既存テストへ影響を与えないための最小限のデフォルト。
    mockUseRealtimeFeed.mockReturnValue({ status: "connected" });
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

    // タスク9.1: NOT_PROVISIONEDの場合のみ、/setup/kitchenへの実際の
    // ナビゲーション導線（<Link>のhref）を表示する（プレーンテキストでの
    // URL言及だけに留めない）。
    expect(
      screen.getByRole("link", { name: "セットアップ画面へ進む" }),
    ).toHaveAttribute("href", "/setup/kitchen");
  });

  it("ensureDeviceSessionが例外を投げても（ドキュメント化されていない失敗）、クラッシュせず案内メッセージを表示する", async () => {
    mockEnsureDeviceSession.mockRejectedValue(new Error("network error"));

    render(<KitchenBoardScreen />);

    expect(
      await screen.findByTestId("kitchen-device-unavailable"),
    ).toBeInTheDocument();
    // タスク9.1: 汎用デバイスエラー（ドキュメント化されていない失敗）は
    // 本タスクのスコープ外——NOT_PROVISIONED専用のセットアップ導線を
    // 表示しない（回帰確認）。
    expect(
      screen.queryByRole("link", { name: "セットアップ画面へ進む" }),
    ).not.toBeInTheDocument();
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
    // タスク9.1: WRONG_ROLE（デバイスは既にプロビジョニング済みで
    // 「未プロビジョニング」ではない）は本タスクのスコープ外——セットアップ
    // 導線を表示しない（回帰確認）。
    expect(
      screen.queryByRole("link", { name: "セットアップ画面へ進む" }),
    ).not.toBeInTheDocument();
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

// =========================================================================
// タスク7.6: 接続断表示と再同期
// Requirements: 6.9
//
// mock-preview.html（renderKitchen関数・toggleKitchenConnection関数）が
// 検証済みのUXをそのまま実装する: 常時表示の接続状態インジケーター、
// disconnected中のみ表示する永続的な警告バナー、disconnected→connectedへの
// 「真の遷移」でのみ表示する一時的な再接続バナー（2200ms後に自動的に
// 消える）。useRealtimeFeed自体は単体テスト済み（useRealtimeFeed.test.ts）
// のためモックし、`status`の変化とonSyncの発火をこのテストから直接
// 制御する。
// =========================================================================

describe("KitchenBoardScreen（タスク7.6: 接続断表示と再同期）", () => {
  let currentStatus: "connected" | "disconnected";
  let capturedOnSync: (() => void) | null;

  // このdescribeはトップレベルの兄弟ブロックであり、上の
  // describe("KitchenBoardScreen", ...)のbeforeEach（モックのリセット・
  // デフォルト値設定）を継承しない。モックはファイル内で共有される
  // モジュールスコープの`vi.fn()`のため、他ブロックの残留状態に依存せず
  // このブロック単独でも（`-t`等でのフィルタ実行時も）成立するよう、
  // 必要なリセット・デフォルト値をここで明示的に行う。
  beforeEach(() => {
    mockEnsureDeviceSession.mockReset();
    mockEnsureDeviceSession.mockResolvedValue({
      ok: true,
      value: { deviceUserId: "user-1", role: "kitchen", storeId: "store-1" },
    });
    mockListKitchenFeed.mockReset();
    mockListKitchenFeed.mockResolvedValue({ ok: true, value: [] });
    mockListMenuItems.mockReset();
    mockListMenuItems.mockResolvedValue({ ok: true, value: [] });

    currentStatus = "connected";
    capturedOnSync = null;
    mockUseRealtimeFeed.mockReset();
    mockUseRealtimeFeed.mockImplementation(
      (options: { onSync: () => void }) => {
        capturedOnSync = options.onSync;
        return { status: currentStatus };
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("マウント直後の初回接続では、接続中の表示のみで再接続バナーは表示されない", async () => {
    render(<KitchenBoardScreen />);
    await screen.findByTestId("food-board");

    expect(screen.getByTestId("kitchen-connection-status")).toHaveTextContent(
      "リアルタイム接続中",
    );
    expect(
      screen.queryByTestId("kitchen-reconnected-banner"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("kitchen-disconnected-banner"),
    ).not.toBeInTheDocument();
  });

  it("disconnectedへ遷移すると、接続状態表示が切り替わり永続的な警告バナー（role=alert）が表示される", async () => {
    const { rerender } = render(<KitchenBoardScreen />);
    await screen.findByTestId("food-board");

    currentStatus = "disconnected";
    rerender(<KitchenBoardScreen />);

    expect(screen.getByTestId("kitchen-connection-status")).toHaveTextContent(
      "接続が切れています",
    );
    const banner = screen.getByTestId("kitchen-disconnected-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent(
      "接続が切断されました。最新の注文が届いていない可能性があります。",
    );
    // mock-preview.html固有の「再接続する」ボタンは実際の製品UIに含めない
    // （実際のRealtimeクライアントは自動的に再接続するため）。
    expect(
      screen.queryByRole("button", { name: /再接続する/ }),
    ).not.toBeInTheDocument();
  });

  it("disconnected→connectedへの真の遷移でのみ再接続バナーが表示され、2200ms後に自動的に消える", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<KitchenBoardScreen />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("food-board")).toBeInTheDocument();

    // 切断。
    currentStatus = "disconnected";
    rerender(<KitchenBoardScreen />);
    expect(
      screen.getByTestId("kitchen-disconnected-banner"),
    ).toBeInTheDocument();

    // 再接続（真の遷移）。
    currentStatus = "connected";
    rerender(<KitchenBoardScreen />);

    expect(screen.getByTestId("kitchen-reconnected-banner")).toHaveTextContent(
      "再接続しました。最新の注文一覧を取得しました。",
    );
    expect(
      screen.queryByTestId("kitchen-disconnected-banner"),
    ).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2199);
    });
    expect(screen.getByTestId("kitchen-reconnected-banner")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(
      screen.queryByTestId("kitchen-reconnected-banner"),
    ).not.toBeInTheDocument();
  });

  it("useRealtimeFeedのonSyncが呼ばれると、現在表示中のボードが背景で再取得する（ローディング状態には戻らない）", async () => {
    render(<KitchenBoardScreen />);
    await screen.findByTestId("food-board");
    expect(mockListKitchenFeed).toHaveBeenCalledTimes(1);

    await act(async () => {
      capturedOnSync?.();
    });

    await waitFor(() => expect(mockListKitchenFeed).toHaveBeenCalledTimes(2));
    // 背景フェッチのため、ローディング表示に戻らずfood-boardが表示され続ける。
    expect(screen.getByTestId("food-board")).toBeInTheDocument();
    expect(
      screen.queryByTestId("food-board-loading"),
    ).not.toBeInTheDocument();
  });

  // 以下3件は7.6レビューで追加されたアドバーサリアルケース。

  it("マウント直後からずっとdisconnectedのまま（一度も接続に至らない）でもクラッシュせず、永続的な警告バナーのみを表示する（再接続バナーは出さない）", async () => {
    currentStatus = "disconnected";
    render(<KitchenBoardScreen />);
    await screen.findByTestId("food-board");

    expect(screen.getByTestId("kitchen-connection-status")).toHaveTextContent(
      "接続が切れています",
    );
    expect(
      screen.getByTestId("kitchen-disconnected-banner"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("kitchen-reconnected-banner"),
    ).not.toBeInTheDocument();
  });

  it("statusがconnectedのまま変化せずonSyncだけが繰り返し発火しても（通常のorder_items変更イベント）、再接続バナーは一切表示されない（resyncTokenとバナー表示の分離）", async () => {
    render(<KitchenBoardScreen />);
    await screen.findByTestId("food-board");
    expect(
      screen.queryByTestId("kitchen-reconnected-banner"),
    ).not.toBeInTheDocument();

    await act(async () => {
      capturedOnSync?.();
      capturedOnSync?.();
      capturedOnSync?.();
    });

    expect(
      screen.queryByTestId("kitchen-reconnected-banner"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("kitchen-connection-status")).toHaveTextContent(
      "リアルタイム接続中",
    );
  });

  it("2200msの自動非表示より速いdisconnect→connect→disconnect→connectの連続切り替えでも、バナーが誤った状態のまま固着しない", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<KitchenBoardScreen />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("food-board")).toBeInTheDocument();

    // 切断。
    currentStatus = "disconnected";
    rerender(<KitchenBoardScreen />);
    expect(
      screen.getByTestId("kitchen-disconnected-banner"),
    ).toBeInTheDocument();

    // 再接続#1（真の遷移。再接続バナー表示、2200msタイマー開始）。
    currentStatus = "connected";
    rerender(<KitchenBoardScreen />);
    expect(
      screen.getByTestId("kitchen-reconnected-banner"),
    ).toBeInTheDocument();

    // 2200msのタイムアウトよりずっと早い300ms後に再び切断。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    currentStatus = "disconnected";
    rerender(<KitchenBoardScreen />);
    // 警告バナーへ即座に切り替わり、再接続バナーが居残らないこと。
    expect(
      screen.getByTestId("kitchen-disconnected-banner"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("kitchen-reconnected-banner"),
    ).not.toBeInTheDocument();

    // すぐに再接続#2。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    currentStatus = "connected";
    rerender(<KitchenBoardScreen />);
    expect(
      screen.getByTestId("kitchen-reconnected-banner"),
    ).toBeInTheDocument();

    // 再接続#1由来の古いタイマー（2200-300=1900ms分の残り）が誤って
    // 先に発火し、再接続#2のバナーを早期に消してしまわないことを確認する
    // （古いタイマーは再接続#2の際にclearTimeoutされているはず）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1900);
    });
    expect(
      screen.getByTestId("kitchen-reconnected-banner"),
    ).toBeInTheDocument();

    // 再接続#2自身の2200ms（1900+300=2200ms）が経過すると消える。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(
      screen.queryByTestId("kitchen-reconnected-banner"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("kitchen-disconnected-banner"),
    ).not.toBeInTheDocument();
  });
});
