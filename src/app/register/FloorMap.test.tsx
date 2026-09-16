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

// FloorMap（タスク8.1、卓マップ表示）のコンポーネントテスト。
// staffOperationsGatewayをモックし、実DBには接続しない
// （FoodBoard.test.tsx・KitchenBoardScreen.test.tsxと同じ方式）。
//
// Requirements: 2.2, 5.4

const mockListRegisterFeed = vi.fn();
const mockStartSession = vi.fn();

vi.mock("@/lib/gateways/staffOperationsGateway", () => ({
  createStaffOperationsGateway: () => ({
    listRegisterFeed: (...args: unknown[]) => mockListRegisterFeed(...args),
    startSession: (...args: unknown[]) => mockStartSession(...args),
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
    ...overrides,
  };
}

describe("FloorMap", () => {
  beforeEach(() => {
    idCounter = 0;
    mockListRegisterFeed.mockReset();
    mockStartSession.mockReset();
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
        { menuItemId: "m1", name: "唐揚げ", quantity: 1, unitPrice: 100 },
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
          { menuItemId: "m1", name: "唐揚げ", quantity: 2, unitPrice: 500 },
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
          { menuItemId: "m1", name: "ビール", quantity: 1, unitPrice: 600 },
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
});
