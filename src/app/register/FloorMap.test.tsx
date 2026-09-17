import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import FloorMap, { REGISTER_FLOOR_MAP_POLL_INTERVAL_MS } from "./FloorMap";
import type { TableBillingSummary } from "@/lib/gateways/staffOperationsGateway";

// FloorMap（タスク8.1/8.2/8.3、卓マップ表示・入店操作・品目の追加/削除）の
// コンポーネントテスト。staffOperationsGatewayをモックし、実DBには接続しない
// （FoodBoard.test.tsx・KitchenBoardScreen.test.tsxと同じ方式）。
//
// タスク8.3で追加したテストは、FloorMap側の状態管理に関わる結合的な
// 振る舞い（実際のaddOrderItem/removeOrderItem呼び出し・ローカルマージ・
// mutationSeqRefによる背景ポーリングとの競合防止）のみを担当し、確認モーダル
// の文言・オプション選択UIの詳細等はTableDetailPanel.test.tsxが担当する
// （8.2確立の役割分担をそのまま踏襲）。
//
// Requirements: 2.2, 5.4, 5.5, 5.6

const mockListRegisterFeed = vi.fn();
const mockStartSession = vi.fn();
const mockAddOrderItem = vi.fn();
const mockRemoveOrderItem = vi.fn();
const mockListMenuItems = vi.fn();
const mockUpdateOrderItemStatus = vi.fn();
const mockCloseSession = vi.fn();
const mockResolveCallRequest = vi.fn();

vi.mock("@/lib/gateways/staffOperationsGateway", () => ({
  createStaffOperationsGateway: () => ({
    listRegisterFeed: (...args: unknown[]) => mockListRegisterFeed(...args),
    startSession: (...args: unknown[]) => mockStartSession(...args),
    addOrderItem: (...args: unknown[]) => mockAddOrderItem(...args),
    removeOrderItem: (...args: unknown[]) => mockRemoveOrderItem(...args),
    listMenuItems: (...args: unknown[]) => mockListMenuItems(...args),
    updateOrderItemStatus: (...args: unknown[]) =>
      mockUpdateOrderItemStatus(...args),
    closeSession: (...args: unknown[]) => mockCloseSession(...args),
    resolveCallRequest: (...args: unknown[]) =>
      mockResolveCallRequest(...args),
  }),
}));

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
    // タスク8.6で追加（0015_list_register_feed_open_call_request_id.sql）。
    openCallRequestId: null,
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

describe("FloorMap", () => {
  beforeEach(() => {
    idCounter = 0;
    itemIdCounter = 0;
    mockListRegisterFeed.mockReset();
    mockStartSession.mockReset();
    mockAddOrderItem.mockReset();
    mockRemoveOrderItem.mockReset();
    mockListMenuItems.mockReset();
    mockUpdateOrderItemStatus.mockReset();
    mockCloseSession.mockReset();
    mockResolveCallRequest.mockReset();
    // タスク8.3で追加: FloorMapはマウント時に常にlistMenuItemsを呼び出す
    // ため、それを検証しないテストのための既定値（空配列）を用意する。
    mockListMenuItems.mockResolvedValue({ ok: true, value: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("テーブル/カウンターの2エリアに、ラベルの接頭辞（T/C）に応じて卓を振り分けて表示する", async () => {
    const t1 = makeTable({ tableLabel: "T1" });
    const t2 = makeTable({ tableLabel: "T2" });
    const c1 = makeTable({ tableLabel: "C1" });
    mockListRegisterFeed.mockResolvedValue({ ok: true, value: [t1, t2, c1] });

    render(<FloorMap storeId="store-1" />);

    const tableSection = await screen.findByTestId(
      "register-floor-section-table",
    );
    const counterSection = screen.getByTestId("register-floor-section-counter");

    expect(within(tableSection).getByText("T1")).toBeInTheDocument();
    expect(within(tableSection).getByText("T2")).toBeInTheDocument();
    expect(within(counterSection).getByText("C1")).toBeInTheDocument();
    expect(within(counterSection).queryByText("T1")).not.toBeInTheDocument();
    expect(within(tableSection).queryByText("C1")).not.toBeInTheDocument();
  });

  it("T/Cいずれの接頭辞にも一致しないラベルの卓があってもクラッシュせず、「その他」区分に表示する", async () => {
    const weird = makeTable({ tableLabel: "VIP" });
    mockListRegisterFeed.mockResolvedValue({ ok: true, value: [weird] });

    render(<FloorMap storeId="store-1" />);

    const otherSection = await screen.findByTestId(
      "register-floor-section-other",
    );
    expect(within(otherSection).getByText("VIP")).toBeInTheDocument();
  });

  it("「その他」区分に該当する卓が無い場合、その他区分自体を表示しない", async () => {
    mockListRegisterFeed.mockResolvedValue({
      ok: true,
      value: [makeTable({ tableLabel: "T1" })],
    });

    render(<FloorMap storeId="store-1" />);

    await screen.findByTestId("register-floor-section-table");
    expect(
      screen.queryByTestId("register-floor-section-other"),
    ).not.toBeInTheDocument();
  });

  it("空席の卓には「空席」を表示し、人数・経過時間・金額は表示しない", async () => {
    const vacant = makeTable({ tableLabel: "T1", activeSession: null });
    mockListRegisterFeed.mockResolvedValue({ ok: true, value: [vacant] });

    render(<FloorMap storeId="store-1" />);

    const tile = await screen.findByTestId("register-floor-tile-T1");
    expect(within(tile).getByTestId("register-floor-tile-vacant")).toHaveTextContent(
      "空席",
    );
    expect(
      within(tile).queryByTestId("register-floor-tile-occupancy"),
    ).not.toBeInTheDocument();
    expect(
      within(tile).queryByTestId("register-floor-tile-total"),
    ).not.toBeInTheDocument();
  });

  it("来店中の卓には人数・経過時間・合計金額（サーバー確定値）を表示する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:30:00.000Z"));

    const occupied = makeTable({
      tableLabel: "T1",
      activeSession: {
        id: "session-1",
        startedAt: "2026-01-01T12:15:00.000Z",
        partySize: 4,
      },
      // itemsの単純合計（100）とは意図的に異なる値をtotalへ与え、
      // コンポーネントがitemsから再計算せずtotalをそのまま表示することを検証する。
      items: [
        makeBillingItem({ name: "唐揚げ", quantity: 1, unitPrice: 100 }),
      ],
      total: 3200,
    });
    mockListRegisterFeed.mockResolvedValue({ ok: true, value: [occupied] });

    render(<FloorMap storeId="store-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const tile = screen.getByTestId("register-floor-tile-T1");
    expect(
      within(tile).getByTestId("register-floor-tile-occupancy"),
    ).toHaveTextContent("4名・15分");
    expect(within(tile).getByTestId("register-floor-tile-total")).toHaveTextContent(
      "¥3,200",
    );
  });

  it("呼び出し中の卓には呼出バッジを表示し、対応済みになると（次のポーリングで）消える（本タスクの観測可能な完了条件）", async () => {
    vi.useFakeTimers();
    const withCall = makeTable({
      tableLabel: "T1",
      activeSession: {
        id: "s1",
        startedAt: "2026-01-01T00:00:00.000Z",
        partySize: 2,
      },
      hasOpenCallRequest: true,
    });
    mockListRegisterFeed.mockResolvedValueOnce({ ok: true, value: [withCall] });

    render(<FloorMap storeId="store-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      within(screen.getByTestId("register-floor-tile-T1")).getByTestId(
        "register-floor-tile-call-badge",
      ),
    ).toBeInTheDocument();

    const resolved = { ...withCall, hasOpenCallRequest: false };
    mockListRegisterFeed.mockResolvedValueOnce({ ok: true, value: [resolved] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REGISTER_FLOOR_MAP_POLL_INTERVAL_MS);
    });

    expect(
      within(screen.getByTestId("register-floor-tile-T1")).queryByTestId(
        "register-floor-tile-call-badge",
      ),
    ).not.toBeInTheDocument();
  });

  it("呼び出しが無い卓には呼出バッジを表示しない", async () => {
    const noCall = makeTable({ tableLabel: "T1", hasOpenCallRequest: false });
    mockListRegisterFeed.mockResolvedValue({ ok: true, value: [noCall] });

    render(<FloorMap storeId="store-1" />);

    const tile = await screen.findByTestId("register-floor-tile-T1");
    expect(
      within(tile).queryByTestId("register-floor-tile-call-badge"),
    ).not.toBeInTheDocument();
  });

  it("背景ポーリングでは読み込み中表示に戻らず、卓の状態を更新する", async () => {
    vi.useFakeTimers();
    const initial = makeTable({ tableLabel: "T1", total: 100 });
    mockListRegisterFeed.mockResolvedValueOnce({ ok: true, value: [initial] });

    render(<FloorMap storeId="store-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("register-floor-map")).toBeInTheDocument();

    const updated = makeTable({
      tableLabel: "T1",
      total: 500,
      activeSession: {
        id: "s1",
        startedAt: "2026-01-01T00:00:00.000Z",
        partySize: 2,
      },
    });
    mockListRegisterFeed.mockResolvedValueOnce({ ok: true, value: [updated] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REGISTER_FLOOR_MAP_POLL_INTERVAL_MS);
    });

    expect(
      screen.queryByTestId("register-floor-map-loading"),
    ).not.toBeInTheDocument();
    const tile = screen.getByTestId("register-floor-tile-T1");
    expect(within(tile).getByTestId("register-floor-tile-total")).toHaveTextContent(
      "¥500",
    );
  });

  it("背景ポーリングが失敗しても、既存の表示中の卓をエラー画面へ巻き戻さない", async () => {
    vi.useFakeTimers();
    const initial = makeTable({ tableLabel: "T1" });
    mockListRegisterFeed.mockResolvedValueOnce({ ok: true, value: [initial] });

    render(<FloorMap storeId="store-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("register-floor-map")).toBeInTheDocument();

    mockListRegisterFeed.mockRejectedValueOnce(new Error("network blip"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REGISTER_FLOOR_MAP_POLL_INTERVAL_MS);
    });

    expect(screen.getByTestId("register-floor-map")).toBeInTheDocument();
    expect(screen.getByTestId("register-floor-tile-T1")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("listRegisterFeedが例外を投げても（ドキュメント化されていない失敗）、クラッシュせず案内メッセージを表示する", async () => {
    mockListRegisterFeed.mockRejectedValue(new Error("network error"));

    render(<FloorMap storeId="store-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "卓の情報の取得に失敗しました",
    );
    expect(screen.queryByTestId("register-floor-map")).not.toBeInTheDocument();
  });

  it("ヘッダーに卓の総数を表示する", async () => {
    mockListRegisterFeed.mockResolvedValue({
      ok: true,
      value: [makeTable({ tableLabel: "T1" }), makeTable({ tableLabel: "C1" })],
    });

    render(<FloorMap storeId="store-1" />);

    expect(await screen.findByTestId("register-floor-map-count")).toHaveTextContent(
      "全2卓",
    );
  });

  it("マウント時にstoreIdを指定してlistRegisterFeedを呼び出す", async () => {
    mockListRegisterFeed.mockResolvedValue({ ok: true, value: [] });

    render(<FloorMap storeId="store-42" />);

    await waitFor(() =>
      expect(mockListRegisterFeed).toHaveBeenCalledWith({ storeId: "store-42" }),
    );
  });

  // タスク8.2: 卓詳細パネルと入店操作（人数入力）。
  // Requirements: 3.1, 3.2, 3.4, 5.1, 5.2, 5.3
  describe("卓詳細パネルと入店操作（タスク8.2）", () => {
    it("空席タイルを選択すると詳細パネルが開き「空席です」と入店ボタンを表示する", async () => {
      const vacant = makeTable({ tableLabel: "T1", activeSession: null });
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [vacant] });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));

      expect(
        screen.getByTestId("register-table-detail-panel"),
      ).toBeInTheDocument();
      expect(screen.getByText(/空席です/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "入店" })).toBeInTheDocument();
    });

    it("閉じるボタンで詳細パネルが閉じる", async () => {
      const vacant = makeTable({ tableLabel: "T1", activeSession: null });
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [vacant] });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));
      fireEvent.click(screen.getByRole("button", { name: "閉じる" }));

      expect(
        screen.queryByTestId("register-table-detail-panel"),
      ).not.toBeInTheDocument();
    });

    it("入店操作で人数を入力し確定すると、startSessionを正しい引数で呼び出し、卓マップのタイルにその人数が表示される（本タスクの観測可能な完了条件）", async () => {
      const vacant = makeTable({ tableLabel: "T1", activeSession: null });
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [vacant] });
      mockStartSession.mockResolvedValueOnce({
        ok: true,
        value: {
          id: "session-new",
          tableId: vacant.tableId,
          status: "active",
          startedAt: "2026-01-01T00:00:00.000Z",
          closedAt: null,
          partySize: 3,
        },
      });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));
      fireEvent.click(screen.getByRole("button", { name: "入店" }));
      fireEvent.click(screen.getByRole("button", { name: "人数を増やす" }));
      fireEvent.click(screen.getByRole("button", { name: "入店する" }));

      await waitFor(() =>
        expect(mockStartSession).toHaveBeenCalledWith({
          tableId: vacant.tableId,
          partySize: 3,
        }),
      );

      // パネルを閉じた後もタイル自体が人数を表示すること（タイルレベルで
      // 検証することが本タスクの観測可能な完了条件そのもの）。
      fireEvent.click(await screen.findByRole("button", { name: "閉じる" }));
      const tile = screen.getByTestId("register-floor-tile-T1");
      expect(
        within(tile).getByTestId("register-floor-tile-occupancy"),
      ).toHaveTextContent("3名");
      expect(
        within(tile).queryByTestId("register-floor-tile-vacant"),
      ).not.toBeInTheDocument();
    });

    it("SESSION_ALREADY_ACTIVEエラー時は専用の警告文を表示し、ローカル状態は空席のまま変化しない（要件3.2）", async () => {
      const vacant = makeTable({ tableLabel: "T1", activeSession: null });
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [vacant] });
      mockStartSession.mockResolvedValueOnce({
        ok: false,
        error: { code: "SESSION_ALREADY_ACTIVE", activeSessionId: "existing-1" },
      });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));
      fireEvent.click(screen.getByRole("button", { name: "入店" }));
      fireEvent.click(screen.getByRole("button", { name: "入店する" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "既に有効な来店セッションが存在します",
      );

      fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
      const tile = screen.getByTestId("register-floor-tile-T1");
      expect(
        within(tile).getByTestId("register-floor-tile-vacant"),
      ).toBeInTheDocument();
    });

    it("TABLE_NOT_FOUND/FORBIDDEN等の未定義エラーは汎用メッセージを表示する", async () => {
      const vacant = makeTable({ tableLabel: "T1", activeSession: null });
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [vacant] });
      mockStartSession.mockResolvedValueOnce({
        ok: false,
        error: { code: "FORBIDDEN" },
      });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));
      fireEvent.click(screen.getByRole("button", { name: "入店" }));
      fireEvent.click(screen.getByRole("button", { name: "入店する" }));

      const alert = await screen.findByRole("alert");
      expect(alert).not.toHaveTextContent("既に有効な来店セッションが存在します");
      expect(alert.textContent).toBeTruthy();
    });

    it("来店中の卓タイルを選択すると、注文明細・合計（サーバー確定値のまま）・人数・経過時間を読み取り専用で表示する", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T12:30:00.000Z"));
      const occupied = makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T12:00:00.000Z",
          partySize: 4,
        },
        items: [
          makeBillingItem({ name: "唐揚げ", quantity: 2, unitPrice: 500 }),
        ],
        total: 12345,
      });
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [occupied] });

      render(<FloorMap storeId="store-1" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByTestId("register-floor-tile-T1"));

      expect(
        screen.getByTestId("register-table-detail-occupancy"),
      ).toHaveTextContent("4名");
      expect(screen.getByTestId("register-table-detail-occupancy")).toHaveTextContent(
        "30分",
      );
      expect(screen.getAllByTestId("register-table-detail-item")).toHaveLength(1);
      expect(screen.getByTestId("register-table-detail-total")).toHaveTextContent(
        "¥12,345",
      );
    });

    it("パネルを開いたまま次のポーリングで新しい注文・合計が届くと、パネル表示も更新される（要件5.3）", async () => {
      vi.useFakeTimers();
      const occupied = makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [],
        total: 0,
      });
      mockListRegisterFeed.mockResolvedValueOnce({ ok: true, value: [occupied] });

      render(<FloorMap storeId="store-1" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByTestId("register-floor-tile-T1"));
      expect(screen.getByText(/まだ注文はありません/)).toBeInTheDocument();

      const updated = {
        ...occupied,
        items: [
          makeBillingItem({ name: "ビール", quantity: 1, unitPrice: 600 }),
        ],
        total: 600,
      };
      mockListRegisterFeed.mockResolvedValueOnce({ ok: true, value: [updated] });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REGISTER_FLOOR_MAP_POLL_INTERVAL_MS);
      });

      expect(screen.getByTestId("register-table-detail-total")).toHaveTextContent(
        "¥600",
      );
      expect(screen.getAllByTestId("register-table-detail-item")).toHaveLength(1);
    });

    it("check-in成功より前に開始した背景ポーリングが、成功のマージより後に解決しても、マージ結果を巻き戻さない（7.6と同型の回帰テスト）", async () => {
      vi.useFakeTimers();
      const vacant = makeTable({ tableLabel: "T1", activeSession: null });
      mockListRegisterFeed.mockResolvedValueOnce({ ok: true, value: [vacant] });

      render(<FloorMap storeId="store-1" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // 背景ポーリングが発火し、解決を意図的に保留する（他端末からの
      // 変更が無いままの、まだ空席の古いスナップショットを表す）。
      let resolveStalePoll!: (value: {
        ok: true;
        value: TableBillingSummary[];
      }) => void;
      const stalePoll = new Promise<{ ok: true; value: TableBillingSummary[] }>(
        (resolve) => {
          resolveStalePoll = resolve;
        },
      );
      mockListRegisterFeed.mockReturnValueOnce(stalePoll);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REGISTER_FLOOR_MAP_POLL_INTERVAL_MS);
      });
      expect(mockListRegisterFeed).toHaveBeenCalledTimes(2);

      // このポーリングが解決するより前に、チェックインが完了し即座に
      // マージされる。
      mockStartSession.mockResolvedValueOnce({
        ok: true,
        value: {
          id: "session-new",
          tableId: vacant.tableId,
          status: "active",
          startedAt: "2026-01-01T00:00:00.000Z",
          closedAt: null,
          partySize: 2,
        },
      });
      fireEvent.click(screen.getByTestId("register-floor-tile-T1"));
      fireEvent.click(screen.getByRole("button", { name: "入店" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "入店する" }));
        await Promise.resolve();
        await Promise.resolve();
      });

      fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
      expect(
        within(screen.getByTestId("register-floor-tile-T1")).getByTestId(
          "register-floor-tile-occupancy",
        ),
      ).toHaveTextContent("2名");

      // 保留していた古いポーリング応答（空席のまま）が今になって解決する。
      await act(async () => {
        resolveStalePoll({ ok: true, value: [vacant] });
        await Promise.resolve();
        await Promise.resolve();
      });

      // マージ結果（来店中）が古いスナップショットに巻き戻らないこと。
      const tile = screen.getByTestId("register-floor-tile-T1");
      expect(
        within(tile).queryByTestId("register-floor-tile-vacant"),
      ).not.toBeInTheDocument();
      expect(
        within(tile).getByTestId("register-floor-tile-occupancy"),
      ).toHaveTextContent("2名");
    });
  });

  // タスク8.3: 品目の追加・削除UI（確認モーダル）。
  // Requirements: 5.5, 5.6
  describe("品目の追加・削除（タスク8.3）", () => {
    it("マウント時にstoreIdを指定してlistMenuItemsを呼び出す", async () => {
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [] });

      render(<FloorMap storeId="store-77" />);

      await waitFor(() =>
        expect(mockListMenuItems).toHaveBeenCalledWith({
          storeId: "store-77",
        }),
      );
    });

    it("品目追加（オプション無し）: 確認後にaddOrderItemを正しい引数で呼び出し、成功時に品目が追加され合計が増える", async () => {
      const occupied = makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [],
        total: 0,
      });
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [occupied] });
      mockListMenuItems.mockResolvedValue({
        ok: true,
        value: [
          {
            id: "menu-1",
            name: "唐揚げ",
            price: 600,
            soldOut: false,
            genre: "food",
            imageUrl: null,
            options: [],
          },
        ],
      });
      mockAddOrderItem.mockResolvedValueOnce({
        ok: true,
        value: {
          id: "order-item-new",
          menuItemId: "menu-1",
          name: "唐揚げ",
          unitPrice: 600,
          quantity: 1,
          optionsSummary: null,
          status: "received",
          statusUpdatedAt: "2026-01-01T00:00:01.000Z",
        },
      });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));
      fireEvent.click(await screen.findByTestId("register-add-menu-toggle"));
      fireEvent.click(
        await screen.findByRole("button", { name: "唐揚げを追加" }),
      );
      fireEvent.click(screen.getByTestId("register-add-confirm-confirm"));

      await waitFor(() =>
        expect(mockAddOrderItem).toHaveBeenCalledWith({
          sessionId: "session-1",
          menuItemId: "menu-1",
          quantity: 1,
          optionSelections: {},
        }),
      );

      fireEvent.click(await screen.findByRole("button", { name: "閉じる" }));
      const tile = screen.getByTestId("register-floor-tile-T1");
      expect(
        within(tile).getByTestId("register-floor-tile-total"),
      ).toHaveTextContent("¥600");
    });

    it("品目削除: 確認後にremoveOrderItemを正しいidで呼び出し、成功時に品目が消え合計が減る", async () => {
      const item = makeBillingItem({
        name: "唐揚げ",
        quantity: 1,
        unitPrice: 600,
      });
      const occupied = makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [item],
        total: 600,
      });
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [occupied] });
      mockRemoveOrderItem.mockResolvedValueOnce({
        ok: true,
        value: { orderItemId: item.id },
      });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));
      fireEvent.click(
        await screen.findByRole("button", { name: "唐揚げを削除" }),
      );
      fireEvent.click(screen.getByTestId("register-remove-confirm-confirm"));

      await waitFor(() =>
        expect(mockRemoveOrderItem).toHaveBeenCalledWith({
          orderItemId: item.id,
        }),
      );

      fireEvent.click(await screen.findByRole("button", { name: "閉じる" }));
      const tile = screen.getByTestId("register-floor-tile-T1");
      expect(
        within(tile).getByTestId("register-floor-tile-total"),
      ).toHaveTextContent("¥0");
    });

    it("削除確認モーダルの「いいえ」を選ぶと、removeOrderItemが呼ばれず注文明細（画面表示）が変化しない（本タスクの観測可能な完了条件、要件5.6）", async () => {
      const item = makeBillingItem({
        name: "唐揚げ",
        quantity: 1,
        unitPrice: 600,
      });
      const occupied = makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [item],
        total: 600,
      });
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [occupied] });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));
      fireEvent.click(
        await screen.findByRole("button", { name: "唐揚げを削除" }),
      );
      fireEvent.click(screen.getByTestId("register-remove-confirm-cancel"));

      expect(mockRemoveOrderItem).not.toHaveBeenCalled();
      expect(
        screen.getAllByTestId("register-table-detail-item"),
      ).toHaveLength(1);
      expect(
        screen.getByTestId("register-table-detail-total"),
      ).toHaveTextContent("¥600");

      fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
      const tile = screen.getByTestId("register-floor-tile-T1");
      expect(
        within(tile).getByTestId("register-floor-tile-total"),
      ).toHaveTextContent("¥600");
    });

    it("品目追加成功より前に開始した背景ポーリングが、成功のマージより後に解決しても、マージ結果を巻き戻さない（mutationSeqRefガード、7.6/8.2と同型の回帰テスト）", async () => {
      vi.useFakeTimers();
      const occupied = makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [],
        total: 0,
      });
      mockListRegisterFeed.mockResolvedValueOnce({ ok: true, value: [occupied] });
      mockListMenuItems.mockResolvedValue({
        ok: true,
        value: [
          {
            id: "menu-1",
            name: "唐揚げ",
            price: 600,
            soldOut: false,
            genre: "food",
            imageUrl: null,
            options: [],
          },
        ],
      });

      render(<FloorMap storeId="store-1" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // 背景ポーリングが発火し、解決を意図的に保留する（品目追加前の
      // 古いスナップショット: items:[]・total:0のまま）。
      let resolveStalePoll!: (value: {
        ok: true;
        value: TableBillingSummary[];
      }) => void;
      const stalePoll = new Promise<{ ok: true; value: TableBillingSummary[] }>(
        (resolve) => {
          resolveStalePoll = resolve;
        },
      );
      mockListRegisterFeed.mockReturnValueOnce(stalePoll);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REGISTER_FLOOR_MAP_POLL_INTERVAL_MS);
      });
      expect(mockListRegisterFeed).toHaveBeenCalledTimes(2);

      // このポーリングが解決するより前に、品目追加が完了し即座にマージされる。
      mockAddOrderItem.mockResolvedValueOnce({
        ok: true,
        value: {
          id: "order-item-new",
          menuItemId: "menu-1",
          name: "唐揚げ",
          unitPrice: 600,
          quantity: 1,
          optionsSummary: null,
          status: "received",
          statusUpdatedAt: "2026-01-01T00:00:01.000Z",
        },
      });

      fireEvent.click(screen.getByTestId("register-floor-tile-T1"));
      fireEvent.click(screen.getByTestId("register-add-menu-toggle"));
      fireEvent.click(screen.getByRole("button", { name: "唐揚げを追加" }));
      await act(async () => {
        fireEvent.click(screen.getByTestId("register-add-confirm-confirm"));
        await Promise.resolve();
        await Promise.resolve();
      });

      fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
      expect(
        within(screen.getByTestId("register-floor-tile-T1")).getByTestId(
          "register-floor-tile-total",
        ),
      ).toHaveTextContent("¥600");

      // 保留していた古いポーリング応答（追加前の空のまま）が今になって解決する。
      await act(async () => {
        resolveStalePoll({ ok: true, value: [occupied] });
        await Promise.resolve();
        await Promise.resolve();
      });

      // マージ結果（追加後）が古いスナップショットに巻き戻らないこと。
      expect(
        within(screen.getByTestId("register-floor-tile-T1")).getByTestId(
          "register-floor-tile-total",
        ),
      ).toHaveTextContent("¥600");
    });

    it("品目削除成功より前に開始した背景ポーリングが、成功のマージより後に解決しても、マージ結果を巻き戻さない（mutationSeqRefガード、7.6/8.2と同型の回帰テスト）", async () => {
      vi.useFakeTimers();
      const item = makeBillingItem({
        name: "唐揚げ",
        quantity: 1,
        unitPrice: 600,
      });
      const occupied = makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [item],
        total: 600,
      });
      mockListRegisterFeed.mockResolvedValueOnce({ ok: true, value: [occupied] });

      render(<FloorMap storeId="store-1" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // 背景ポーリングが発火し、解決を意図的に保留する（削除前の古い
      // スナップショット: itemsが残ったまま）。
      let resolveStalePoll!: (value: {
        ok: true;
        value: TableBillingSummary[];
      }) => void;
      const stalePoll = new Promise<{ ok: true; value: TableBillingSummary[] }>(
        (resolve) => {
          resolveStalePoll = resolve;
        },
      );
      mockListRegisterFeed.mockReturnValueOnce(stalePoll);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REGISTER_FLOOR_MAP_POLL_INTERVAL_MS);
      });
      expect(mockListRegisterFeed).toHaveBeenCalledTimes(2);

      // このポーリングが解決するより前に、品目削除が完了し即座にマージされる。
      mockRemoveOrderItem.mockResolvedValueOnce({
        ok: true,
        value: { orderItemId: item.id },
      });

      fireEvent.click(screen.getByTestId("register-floor-tile-T1"));
      fireEvent.click(screen.getByRole("button", { name: "唐揚げを削除" }));
      await act(async () => {
        fireEvent.click(screen.getByTestId("register-remove-confirm-confirm"));
        await Promise.resolve();
        await Promise.resolve();
      });

      fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
      expect(
        within(screen.getByTestId("register-floor-tile-T1")).getByTestId(
          "register-floor-tile-total",
        ),
      ).toHaveTextContent("¥0");

      // 保留していた古いポーリング応答（削除前のitemsが残ったまま）が
      // 今になって解決する。
      await act(async () => {
        resolveStalePoll({ ok: true, value: [occupied] });
        await Promise.resolve();
        await Promise.resolve();
      });

      // マージ結果（削除後）が古いスナップショットに巻き戻らないこと。
      expect(
        within(screen.getByTestId("register-floor-tile-T1")).getByTestId(
          "register-floor-tile-total",
        ),
      ).toHaveTextContent("¥0");
    });
  });

  // タスク8.4: 品目ステータス変更UI（確認モーダル）。
  // Requirements: 5.7
  describe("品目のステータス変更（タスク8.4）", () => {
    it("確認後にupdateOrderItemStatusを正しい引数で呼び出し、成功時にステータス表示が更新される（本タスクの観測可能な完了条件）", async () => {
      const item = makeBillingItem({
        name: "唐揚げ",
        genre: "food",
        status: "received",
      });
      const occupied = makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [item],
        total: item.unitPrice,
      });
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [occupied] });
      mockUpdateOrderItemStatus.mockResolvedValueOnce({
        ok: true,
        value: {
          id: item.id,
          menuItemId: item.menuItemId,
          name: item.name,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          optionsSummary: null,
          status: "in_progress",
          statusUpdatedAt: "2026-01-01T00:00:01.000Z",
        },
      });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));
      expect(
        screen.getByTestId("register-table-detail-item-status"),
      ).toHaveTextContent("未対応");

      fireEvent.click(
        screen.getByRole("button", { name: "唐揚げのステータスを進める" }),
      );
      fireEvent.click(screen.getByTestId("register-status-confirm-confirm"));

      await waitFor(() =>
        expect(mockUpdateOrderItemStatus).toHaveBeenCalledWith({
          orderItemId: item.id,
          status: "in_progress",
        }),
      );

      // ステータス表示が「未対応」→「調理中」へ更新される（完了条件そのもの）。
      expect(
        await screen.findByTestId("register-table-detail-item-status"),
      ).toHaveTextContent("調理中");
    });

    it("確認モーダルの「いいえ」を選ぶと、updateOrderItemStatusが呼ばれずステータス表示が変化しない（要件5.7）", async () => {
      const item = makeBillingItem({
        name: "唐揚げ",
        genre: "food",
        status: "received",
      });
      const occupied = makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [item],
        total: item.unitPrice,
      });
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [occupied] });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));
      fireEvent.click(
        await screen.findByRole("button", {
          name: "唐揚げのステータスを進める",
        }),
      );
      fireEvent.click(screen.getByTestId("register-status-confirm-cancel"));

      expect(mockUpdateOrderItemStatus).not.toHaveBeenCalled();
      expect(
        screen.getByTestId("register-table-detail-item-status"),
      ).toHaveTextContent("未対応");
    });

    it("INVALID_TRANSITION等の失敗時は汎用エラーメッセージを表示し、ローカル状態（ステータス表示）を変更しない", async () => {
      const item = makeBillingItem({
        name: "唐揚げ",
        genre: "food",
        status: "received",
      });
      const occupied = makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [item],
        total: item.unitPrice,
      });
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [occupied] });
      mockUpdateOrderItemStatus.mockResolvedValueOnce({
        ok: false,
        error: {
          code: "INVALID_TRANSITION",
          from: "received",
          to: "in_progress",
        },
      });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));
      fireEvent.click(
        await screen.findByRole("button", {
          name: "唐揚げのステータスを進める",
        }),
      );
      fireEvent.click(screen.getByTestId("register-status-confirm-confirm"));

      expect(await screen.findByTestId("register-update-status-error")).toHaveTextContent(
        "ステータスの更新に失敗しました",
      );
      expect(
        screen.getByTestId("register-table-detail-item-status"),
      ).toHaveTextContent("未対応");
    });

    it("ステータス変更成功より前に開始した背景ポーリングが、成功のマージより後に解決しても、マージ結果を巻き戻さない（mutationSeqRefガード、7.6/8.2/8.3と同型の回帰テスト）", async () => {
      vi.useFakeTimers();
      const item = makeBillingItem({
        name: "唐揚げ",
        genre: "food",
        status: "received",
      });
      const occupied = makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [item],
        total: item.unitPrice,
      });
      mockListRegisterFeed.mockResolvedValueOnce({ ok: true, value: [occupied] });

      render(<FloorMap storeId="store-1" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByTestId("register-floor-tile-T1"));

      // 背景ポーリングが発火し、解決を意図的に保留する（ステータス変更前の
      // 古いスナップショット: statusが"received"のまま）。
      let resolveStalePoll!: (value: {
        ok: true;
        value: TableBillingSummary[];
      }) => void;
      const stalePoll = new Promise<{ ok: true; value: TableBillingSummary[] }>(
        (resolve) => {
          resolveStalePoll = resolve;
        },
      );
      mockListRegisterFeed.mockReturnValueOnce(stalePoll);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REGISTER_FLOOR_MAP_POLL_INTERVAL_MS);
      });
      expect(mockListRegisterFeed).toHaveBeenCalledTimes(2);

      // このポーリングが解決するより前に、ステータス変更が完了し即座に
      // マージされる。
      mockUpdateOrderItemStatus.mockResolvedValueOnce({
        ok: true,
        value: {
          id: item.id,
          menuItemId: item.menuItemId,
          name: item.name,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          optionsSummary: null,
          status: "in_progress",
          statusUpdatedAt: "2026-01-01T00:00:01.000Z",
        },
      });

      fireEvent.click(
        screen.getByRole("button", { name: "唐揚げのステータスを進める" }),
      );
      await act(async () => {
        fireEvent.click(screen.getByTestId("register-status-confirm-confirm"));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(
        screen.getByTestId("register-table-detail-item-status"),
      ).toHaveTextContent("調理中");

      // 保留していた古いポーリング応答（変更前のreceivedのまま）が今になって
      // 解決する。
      await act(async () => {
        resolveStalePoll({ ok: true, value: [occupied] });
        await Promise.resolve();
        await Promise.resolve();
      });

      // マージ結果（調理中）が古いスナップショットに巻き戻らないこと。
      expect(
        screen.getByTestId("register-table-detail-item-status"),
      ).toHaveTextContent("調理中");
    });
  });

  // タスク8.5: 会計操作（確認モーダル・セッション終了）。
  // Requirements: 3.3
  describe("会計操作（タスク8.5）", () => {
    it("会計確認後、closeSessionを正しいsessionIdで呼び出し、卓詳細パネルが閉じて対象卓が空席状態になる（本タスクの観測可能な完了条件）", async () => {
      const occupied = makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [makeBillingItem({ name: "唐揚げ", unitPrice: 600 })],
        total: 600,
      });
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [occupied] });
      mockCloseSession.mockResolvedValueOnce({
        ok: true,
        value: {
          id: "session-1",
          tableId: occupied.tableId,
          status: "closed",
          startedAt: "2026-01-01T00:00:00.000Z",
          closedAt: "2026-01-01T01:00:00.000Z",
          partySize: 2,
        },
      });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));
      fireEvent.click(screen.getByRole("button", { name: "会計（退店）" }));
      fireEvent.click(screen.getByTestId("register-checkout-confirm-confirm"));

      await waitFor(() =>
        expect(mockCloseSession).toHaveBeenCalledWith({
          sessionId: "session-1",
        }),
      );

      // 完了条件その1: 卓詳細パネルが閉じて卓マップ画面が表示される。
      expect(
        await screen.findByTestId("register-floor-map"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("register-table-detail-panel"),
      ).not.toBeInTheDocument();

      // 完了条件その2: 対象卓が空席状態になる（タイルレベルで検証、
      // 8.2の観測可能な完了条件テストと同型）。
      const tile = screen.getByTestId("register-floor-tile-T1");
      expect(
        within(tile).getByTestId("register-floor-tile-vacant"),
      ).toBeInTheDocument();
      expect(
        within(tile).queryByTestId("register-floor-tile-occupancy"),
      ).not.toBeInTheDocument();
      expect(
        within(tile).queryByTestId("register-floor-tile-total"),
      ).not.toBeInTheDocument();
    });

    it("SESSION_NOT_ACTIVEエラー時は汎用の警告文を表示し、パネルは開いたまま卓は来店中のまま変化しない（要件E）", async () => {
      const occupied = makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [],
        total: 0,
      });
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [occupied] });
      mockCloseSession.mockResolvedValueOnce({
        ok: false,
        error: { code: "SESSION_NOT_ACTIVE" },
      });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));
      fireEvent.click(screen.getByRole("button", { name: "会計（退店）" }));
      fireEvent.click(screen.getByTestId("register-checkout-confirm-confirm"));

      expect(await screen.findByTestId("register-checkout-error")).toBeInTheDocument();

      // パネルは開いたままで、卓はローカル状態では来店中のまま
      // （強制的に空席へ書き換えない、次回ポーリングに委ねる）。
      expect(
        screen.getByTestId("register-table-detail-panel"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("register-table-detail-occupancy"),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
      const tile = screen.getByTestId("register-floor-tile-T1");
      expect(
        within(tile).getByTestId("register-floor-tile-occupancy"),
      ).toBeInTheDocument();
      expect(
        within(tile).queryByTestId("register-floor-tile-vacant"),
      ).not.toBeInTheDocument();
    });

    it("会計成功より前に開始した背景ポーリングが、成功のマージより後に解決しても、空席化した結果を巻き戻さない（mutationSeqRefガード、5個目の適用箇所、7.6/8.2/8.3/8.4と同型の回帰テスト）", async () => {
      vi.useFakeTimers();
      const occupied = makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [],
        total: 0,
      });
      mockListRegisterFeed.mockResolvedValueOnce({ ok: true, value: [occupied] });

      render(<FloorMap storeId="store-1" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByTestId("register-floor-tile-T1"));

      // 背景ポーリングが発火し、解決を意図的に保留する（会計前の古い
      // スナップショット: activeSessionが残ったまま来店中）。
      let resolveStalePoll!: (value: {
        ok: true;
        value: TableBillingSummary[];
      }) => void;
      const stalePoll = new Promise<{ ok: true; value: TableBillingSummary[] }>(
        (resolve) => {
          resolveStalePoll = resolve;
        },
      );
      mockListRegisterFeed.mockReturnValueOnce(stalePoll);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REGISTER_FLOOR_MAP_POLL_INTERVAL_MS);
      });
      expect(mockListRegisterFeed).toHaveBeenCalledTimes(2);

      // このポーリングが解決するより前に、会計（closeSession）が完了し
      // 即座にマージ（空席化＋パネルを閉じる）される。
      mockCloseSession.mockResolvedValueOnce({
        ok: true,
        value: {
          id: "session-1",
          tableId: occupied.tableId,
          status: "closed",
          startedAt: "2026-01-01T00:00:00.000Z",
          closedAt: "2026-01-01T01:00:00.000Z",
          partySize: 2,
        },
      });

      fireEvent.click(screen.getByRole("button", { name: "会計（退店）" }));
      await act(async () => {
        fireEvent.click(
          screen.getByTestId("register-checkout-confirm-confirm"),
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(
        screen.queryByTestId("register-table-detail-panel"),
      ).not.toBeInTheDocument();
      expect(
        within(screen.getByTestId("register-floor-tile-T1")).getByTestId(
          "register-floor-tile-vacant",
        ),
      ).toBeInTheDocument();

      // 保留していた古いポーリング応答（会計前の来店中のまま）が
      // 今になって解決する。
      await act(async () => {
        resolveStalePoll({ ok: true, value: [occupied] });
        await Promise.resolve();
        await Promise.resolve();
      });

      // マージ結果（空席）が古いスナップショット（来店中）に巻き戻らないこと。
      const tile = screen.getByTestId("register-floor-tile-T1");
      expect(within(tile).getByTestId("register-floor-tile-vacant")).toBeInTheDocument();
      expect(
        within(tile).queryByTestId("register-floor-tile-occupancy"),
      ).not.toBeInTheDocument();
    });
  });

  // タスク8.6: 呼び出し対応UI（確認モーダル無し、要件2.4）。
  // Requirements: 2.4
  describe("呼び出し対応（タスク8.6）", () => {
    function occupiedTableWithCall(
      overrides: Partial<TableBillingSummary> = {},
    ): TableBillingSummary {
      return makeTable({
        tableLabel: "T1",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        hasOpenCallRequest: true,
        openCallRequestId: "call-1",
        ...overrides,
      });
    }

    it("対応済みにするをタップすると、resolveCallRequestを正しいcallRequestIdで呼び出し、パネルのバナーと卓マップの呼出バッジの両方が消える（本タスクの観測可能な完了条件、要件2.4）", async () => {
      const occupied = occupiedTableWithCall();
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [occupied] });
      mockResolveCallRequest.mockResolvedValueOnce({
        ok: true,
        value: {
          id: "call-1",
          sessionId: "session-1",
          status: "resolved",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));

      // 完了条件その1（対応前）: 卓マップの呼出バッジ・パネルのバナーの
      // 両方が表示されている（同一のstate.tablesを共有していることの前提確認）。
      expect(
        within(screen.getByTestId("register-floor-tile-T1")).getByTestId(
          "register-floor-tile-call-badge",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("register-table-detail-call-banner"),
      ).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "対応済みにする" }),
      );

      await waitFor(() =>
        expect(mockResolveCallRequest).toHaveBeenCalledWith({
          callRequestId: "call-1",
        }),
      );

      // 完了条件その2（対応後、確認や再読み込み無しで即座に）: パネルの
      // バナーが消える。
      await waitFor(() =>
        expect(
          screen.queryByTestId("register-table-detail-call-banner"),
        ).not.toBeInTheDocument(),
      );

      // 完了条件その3: 卓マップの呼出バッジも同時に消える（同一の
      // state.tablesを共有しているため、ファイル冒頭の指示通り両方を
      // 独立にアサートする）。
      expect(
        within(screen.getByTestId("register-floor-tile-T1")).queryByTestId(
          "register-floor-tile-call-badge",
        ),
      ).not.toBeInTheDocument();
    });

    it("CALL_REQUEST_NOT_FOUND時は専用メッセージを表示し、バナー・バッジのいずれも消去しない（要件E、実際に起こりうるレース）", async () => {
      const occupied = occupiedTableWithCall();
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [occupied] });
      mockResolveCallRequest.mockResolvedValueOnce({
        ok: false,
        error: { code: "CALL_REQUEST_NOT_FOUND" },
      });

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));
      fireEvent.click(
        screen.getByRole("button", { name: "対応済みにする" }),
      );

      expect(
        await screen.findByTestId("register-resolve-call-error"),
      ).toHaveTextContent("既に対応済み");

      // ローカル状態は強制的に変更しない（次回ポーリングに委ねる）ため、
      // バナー・バッジのいずれも表示され続ける。
      expect(
        screen.getByTestId("register-table-detail-call-banner"),
      ).toBeInTheDocument();
      expect(
        within(screen.getByTestId("register-floor-tile-T1")).getByTestId(
          "register-floor-tile-call-badge",
        ),
      ).toBeInTheDocument();
    });

    it("resolveCallRequestの応答中は対応ボタンが無効化され、二重タップしてもresolveCallRequestは1回しか呼ばれない（確認モーダルが無いための二重送信防止）", async () => {
      const occupied = occupiedTableWithCall();
      mockListRegisterFeed.mockResolvedValue({ ok: true, value: [occupied] });

      let resolveRpc!: (value: {
        ok: true;
        value: { id: string; sessionId: string; status: string; createdAt: string };
      }) => void;
      const pendingResolve = new Promise((resolve) => {
        resolveRpc = resolve as never;
      });
      mockResolveCallRequest.mockReturnValueOnce(pendingResolve);

      render(<FloorMap storeId="store-1" />);
      fireEvent.click(await screen.findByTestId("register-floor-tile-T1"));

      const button = screen.getByRole("button", { name: "対応済みにする" });
      fireEvent.click(button);
      await waitFor(() => expect(mockResolveCallRequest).toHaveBeenCalledTimes(1));

      // 応答が返る前に再度タップしても、ボタンが無効化されているため
      // 追加のRPC呼び出しは発生しない。
      fireEvent.click(screen.getByRole("button", { name: "処理中..." }));
      expect(mockResolveCallRequest).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveRpc({
          ok: true,
          value: {
            id: "call-1",
            sessionId: "session-1",
            status: "resolved",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockResolveCallRequest).toHaveBeenCalledTimes(1);
    });

    it("呼び出し対応成功より前に開始した背景ポーリングが、成功のマージより後に解決しても、対応済みの結果を巻き戻さない（mutationSeqRefガード、6個目の適用箇所、7.6/8.2/8.3/8.4/8.5と同型の回帰テスト）", async () => {
      vi.useFakeTimers();
      const occupied = occupiedTableWithCall();
      mockListRegisterFeed.mockResolvedValueOnce({ ok: true, value: [occupied] });

      render(<FloorMap storeId="store-1" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByTestId("register-floor-tile-T1"));

      // 背景ポーリングが発火し、解決を意図的に保留する（対応前の古い
      // スナップショット: hasOpenCallRequest/openCallRequestIdが残ったまま）。
      let resolveStalePoll!: (value: {
        ok: true;
        value: TableBillingSummary[];
      }) => void;
      const stalePoll = new Promise<{ ok: true; value: TableBillingSummary[] }>(
        (resolve) => {
          resolveStalePoll = resolve;
        },
      );
      mockListRegisterFeed.mockReturnValueOnce(stalePoll);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REGISTER_FLOOR_MAP_POLL_INTERVAL_MS);
      });
      expect(mockListRegisterFeed).toHaveBeenCalledTimes(2);

      // このポーリングが解決するより前に、呼び出し対応が完了し即座に
      // マージ（バナー・バッジの消去）される。
      mockResolveCallRequest.mockResolvedValueOnce({
        ok: true,
        value: {
          id: "call-1",
          sessionId: "session-1",
          status: "resolved",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });

      fireEvent.click(
        screen.getByRole("button", { name: "対応済みにする" }),
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(
        screen.queryByTestId("register-table-detail-call-banner"),
      ).not.toBeInTheDocument();
      expect(
        within(screen.getByTestId("register-floor-tile-T1")).queryByTestId(
          "register-floor-tile-call-badge",
        ),
      ).not.toBeInTheDocument();

      // 保留していた古いポーリング応答（対応前の呼び出し中のまま）が
      // 今になって解決する。
      await act(async () => {
        resolveStalePoll({ ok: true, value: [occupied] });
        await Promise.resolve();
        await Promise.resolve();
      });

      // マージ結果（対応済み・バッジ無し）が古いスナップショット（呼び出し中）
      // に巻き戻らないこと。
      expect(
        screen.queryByTestId("register-table-detail-call-banner"),
      ).not.toBeInTheDocument();
      expect(
        within(screen.getByTestId("register-floor-tile-T1")).queryByTestId(
          "register-floor-tile-call-badge",
        ),
      ).not.toBeInTheDocument();
    });
  });
});
