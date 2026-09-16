import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import TableDetailPanel from "./TableDetailPanel";
import type { TableBillingSummary } from "@/lib/gateways/staffOperationsGateway";

// TableDetailPanel（タスク8.2）のコンポーネントテスト。
// FloorMap（親、タスク8.1）が保持する`state.tables`から都度算出される
// `TableBillingSummary`と、check-in操作のコールバック(`onCheckIn`)・
// 処理中フラグ・エラーメッセージのみをpropsとして受け取る純粋な
// プレゼンテーションコンポーネントとして、FloorMapから切り離してテストする
// （FloorMap.test.tsxはstartSessionの実際の呼び出し・マージ・ポーリングとの
// 競合など、FloorMap側の状態管理に関わる結合的な振る舞いを担当する）。
//
// Requirements: 3.1, 3.2, 3.4, 5.1, 5.2, 5.3

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

describe("TableDetailPanel", () => {
  afterEach(() => {
    vi.useRealTimers();
    idCounter = 0;
  });

  describe("空席の卓（要件3.1, 5.2）", () => {
    it("「空席です」の案内と入店ボタンを表示する", () => {
      const table = makeTable({ tableLabel: "T1", activeSession: null });
      render(
        <TableDetailPanel
          table={table}
          onClose={vi.fn()}
          onCheckIn={vi.fn()}
          submitting={false}
          checkInErrorMessage={null}
        />,
      );

      expect(screen.getByText(/空席です/)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "入店" }),
      ).toBeInTheDocument();
      // 会計対象の明細・合計は表示されない
      expect(
        screen.queryByTestId("register-table-detail-items"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("register-table-detail-total"),
      ).not.toBeInTheDocument();
    });

    it("「入店」を押すと人数入力ステッパー（デフォルト2）が表示される", () => {
      const table = makeTable({ activeSession: null });
      render(
        <TableDetailPanel
          table={table}
          onClose={vi.fn()}
          onCheckIn={vi.fn()}
          submitting={false}
          checkInErrorMessage={null}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "入店" }));

      expect(screen.getByTestId("register-check-in-party-size")).toHaveTextContent(
        "2",
      );
      expect(
        screen.getByRole("button", { name: "キャンセル" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "入店する" }),
      ).toBeInTheDocument();
    });

    it("＋/−で人数を増減でき、1未満にはならない", () => {
      const table = makeTable({ activeSession: null });
      render(
        <TableDetailPanel
          table={table}
          onClose={vi.fn()}
          onCheckIn={vi.fn()}
          submitting={false}
          checkInErrorMessage={null}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "入店" }));
      const partySize = screen.getByTestId("register-check-in-party-size");
      expect(partySize).toHaveTextContent("2");

      fireEvent.click(screen.getByRole("button", { name: "人数を増やす" }));
      expect(partySize).toHaveTextContent("3");

      fireEvent.click(screen.getByRole("button", { name: "人数を減らす" }));
      fireEvent.click(screen.getByRole("button", { name: "人数を減らす" }));
      expect(partySize).toHaveTextContent("1");

      // 下限（1）に到達した後、さらに減らそうとしても1のまま
      fireEvent.click(screen.getByRole("button", { name: "人数を減らす" }));
      expect(partySize).toHaveTextContent("1");
    });

    it("キャンセルを押すとonCheckInを呼び出さずに空席の初期表示へ戻る", () => {
      const onCheckIn = vi.fn();
      const table = makeTable({ activeSession: null });
      render(
        <TableDetailPanel
          table={table}
          onClose={vi.fn()}
          onCheckIn={onCheckIn}
          submitting={false}
          checkInErrorMessage={null}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "入店" }));
      fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

      expect(onCheckIn).not.toHaveBeenCalled();
      expect(screen.getByText(/空席です/)).toBeInTheDocument();
      expect(
        screen.queryByTestId("register-check-in-party-size"),
      ).not.toBeInTheDocument();
    });

    it("入店するを押すと現在の人数でonCheckInを呼び出す", () => {
      const onCheckIn = vi.fn();
      const table = makeTable({ activeSession: null });
      render(
        <TableDetailPanel
          table={table}
          onClose={vi.fn()}
          onCheckIn={onCheckIn}
          submitting={false}
          checkInErrorMessage={null}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "入店" }));
      fireEvent.click(screen.getByRole("button", { name: "人数を増やす" }));
      fireEvent.click(screen.getByRole("button", { name: "入店する" }));

      expect(onCheckIn).toHaveBeenCalledTimes(1);
      expect(onCheckIn).toHaveBeenCalledWith(3);
    });

    it("submitting中はキャンセル・入店するボタンが無効化される", () => {
      const table = makeTable({ activeSession: null });
      render(
        <TableDetailPanel
          table={table}
          onClose={vi.fn()}
          onCheckIn={vi.fn()}
          submitting={true}
          checkInErrorMessage={null}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "入店" }));

      expect(screen.getByRole("button", { name: "キャンセル" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "処理中..." }),
      ).toBeDisabled();
    });

    it("checkInErrorMessageが指定されると警告として表示する（要件3.2）", () => {
      const table = makeTable({ activeSession: null });
      render(
        <TableDetailPanel
          table={table}
          onClose={vi.fn()}
          onCheckIn={vi.fn()}
          submitting={false}
          checkInErrorMessage="既に有効な来店セッションが存在します。"
        />,
      );

      expect(screen.getByRole("alert")).toHaveTextContent(
        "既に有効な来店セッションが存在します。",
      );
    });
  });

  describe("来店中の卓（要件5.1, 読み取り専用）", () => {
    it("人数・経過時間・セッションIDを表示する", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T12:30:00.000Z"));

      const table = makeTable({
        activeSession: {
          id: "session-abc",
          startedAt: "2026-01-01T12:00:00.000Z",
          partySize: 4,
        },
      });
      render(
        <TableDetailPanel
          table={table}
          onClose={vi.fn()}
          onCheckIn={vi.fn()}
          submitting={false}
          checkInErrorMessage={null}
        />,
      );

      expect(
        screen.getByTestId("register-table-detail-occupancy"),
      ).toHaveTextContent("4名");
      expect(
        screen.getByTestId("register-table-detail-occupancy"),
      ).toHaveTextContent("30分");
      expect(screen.getByText(/session-abc/)).toBeInTheDocument();
    });

    it("注文明細（品目名・数量・単価×数量）と合計をtotalの値そのまま表示する（再計算しない）", () => {
      const table = makeTable({
        activeSession: {
          id: "s1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [
          { menuItemId: "m1", name: "唐揚げ", quantity: 2, unitPrice: 500 },
          { menuItemId: "m2", name: "ビール", quantity: 1, unitPrice: 600 },
        ],
        // items単純合計（500*2+600=1600）とは意図的に異なる値。
        total: 9999,
      });
      render(
        <TableDetailPanel
          table={table}
          onClose={vi.fn()}
          onCheckIn={vi.fn()}
          submitting={false}
          checkInErrorMessage={null}
        />,
      );

      const items = screen.getAllByTestId("register-table-detail-item");
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveTextContent("唐揚げ");
      expect(items[0]).toHaveTextContent("2");
      expect(items[0]).toHaveTextContent("¥1,000");
      expect(items[1]).toHaveTextContent("ビール");
      expect(items[1]).toHaveTextContent("¥600");

      expect(
        screen.getByTestId("register-table-detail-total"),
      ).toHaveTextContent("¥9,999");
      // 品目の追加・削除・ステータス変更ボタンは8.3/8.4のスコープであり
      // 本タスクでは一切表示しない。
      expect(screen.queryByRole("button", { name: "削除" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "進める" })).not.toBeInTheDocument();
    });

    it("注文明細が無い場合はその旨を表示する", () => {
      const table = makeTable({
        activeSession: {
          id: "s1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [],
        total: 0,
      });
      render(
        <TableDetailPanel
          table={table}
          onClose={vi.fn()}
          onCheckIn={vi.fn()}
          submitting={false}
          checkInErrorMessage={null}
        />,
      );

      expect(screen.getByText(/まだ注文はありません/)).toBeInTheDocument();
    });

    it("呼び出し中の場合、案内バナーを表示する（対応ボタンは8.6のスコープのため表示しない）", () => {
      const table = makeTable({
        activeSession: {
          id: "s1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        hasOpenCallRequest: true,
      });
      render(
        <TableDetailPanel
          table={table}
          onClose={vi.fn()}
          onCheckIn={vi.fn()}
          submitting={false}
          checkInErrorMessage={null}
        />,
      );

      expect(screen.getByTestId("register-table-detail-call-banner")).toHaveTextContent(
        "呼び出し中",
      );
      expect(
        screen.queryByRole("button", { name: "対応済みにする" }),
      ).not.toBeInTheDocument();
    });

    it("呼び出しが無い場合バナーを表示しない", () => {
      const table = makeTable({
        activeSession: {
          id: "s1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        hasOpenCallRequest: false,
      });
      render(
        <TableDetailPanel
          table={table}
          onClose={vi.fn()}
          onCheckIn={vi.fn()}
          submitting={false}
          checkInErrorMessage={null}
        />,
      );

      expect(
        screen.queryByTestId("register-table-detail-call-banner"),
      ).not.toBeInTheDocument();
    });
  });

  it("閉じるボタンでonCloseを呼び出す", () => {
    const onClose = vi.fn();
    const table = makeTable({ activeSession: null });
    render(
      <TableDetailPanel
        table={table}
        onClose={onClose}
        onCheckIn={vi.fn()}
        submitting={false}
        checkInErrorMessage={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("卓ラベルをヘッダーに表示する", () => {
    const table = makeTable({ tableLabel: "C2", activeSession: null });
    render(
      <TableDetailPanel
        table={table}
        onClose={vi.fn()}
        onCheckIn={vi.fn()}
        submitting={false}
        checkInErrorMessage={null}
      />,
    );

    expect(within(screen.getByTestId("register-table-detail-panel")).getByText("C2")).toBeInTheDocument();
  });
});
