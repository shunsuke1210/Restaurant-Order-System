import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import FloorMap, { REGISTER_FLOOR_MAP_POLL_INTERVAL_MS } from "./FloorMap";
import type { TableBillingSummary } from "@/lib/gateways/staffOperationsGateway";

// FloorMap（タスク8.1、卓マップ表示）のコンポーネントテスト。
// staffOperationsGatewayをモックし、実DBには接続しない
// （FoodBoard.test.tsx・KitchenBoardScreen.test.tsxと同じ方式）。
//
// Requirements: 2.2, 5.4

const mockListRegisterFeed = vi.fn();

vi.mock("@/lib/gateways/staffOperationsGateway", () => ({
  createStaffOperationsGateway: () => ({
    listRegisterFeed: (...args: unknown[]) => mockListRegisterFeed(...args),
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
});
