import { describe, expect, it } from "vitest";
import { resolveNextOrderItemStatus } from "./orderItemStatusTransitions";
import type { OrderItemStatus } from "./gateways/customerOrderingGateway";
import type { MenuItemGenre } from "./gateways/staffOperationsGateway";

/**
 * orderItemStatusTransitions.test.ts — `resolveNextOrderItemStatus`（タスク
 * 8.4で新規追加）のテーブル駆動テスト。
 *
 * Requirements: 5.7, 6.2, 6.3, 6.4, 6.6
 * Design: .kiro/specs/table-order-kitchen/design.md「StaffOperationsGateway」
 *   Responsibilities & Constraints（`updateOrderItemStatus`の許可遷移表:
 *   フード/一品 received→in_progress→done、ドリンク received→done。
 *   一品のみreceived→doneの直接ショートカットも許可、要件6.6）。
 *
 * ## このテストが検証する範囲（「1段階分の遷移」のみ、ショートカットは対象外）
 * `resolveNextOrderItemStatus`はKitchenBoard（`OrderItemStatusActions.tsx`）と
 * RegisterConsole（`TableDetailPanel.tsx`、本タスク）が共有する、ジャンル×
 * 現在ステータス→「1段階分の次ステータス」のみを判定する関数である
 * （design.md「StaffOperationsGateway」Responsibilities & Constraints
 * 「genre×status→次ステータスの判定」参照）。一品の`received→done`直接
 * ショートカット（要件6.6）はKitchenBoard専用の速度優先UXであり、
 * RegisterConsoleは意図的に持たない（mock-preview.htmlのレジ側`nextMap`が
 * 検証済みの単純化、TableDetailPanel.tsx冒頭コメント参照）ため、本関数の
 * 責務には含めない（`OrderItemStatusActions.tsx`側がショートカットを
 * 追加で描画する）。
 *
 * ## `update_order_item_status`（0004_rpc_staff_gateway.sql）との対応
 * 以下のテーブルは、0004の`v_allowed`判定ロジックのうち「1段階分」の
 * 部分（ショートカット行を除く）と1:1で対応する（0004コメント「3. ジャンル
 * 別の許可遷移表を判定する」参照）。ドリフトを防ぐため、このテストの
 * テーブル自体をRPC側の許可遷移表の唯一の参照点として扱い、将来どちらかを
 * 変更する際は必ずもう一方とこのテストを突き合わせること。
 */

type Case = {
  genre: MenuItemGenre;
  status: OrderItemStatus;
  expected: OrderItemStatus | null;
};

const CASES: ReadonlyArray<Case> = [
  // food: received -> in_progress -> done（0004: v_genre = 'food'）
  { genre: "food", status: "received", expected: "in_progress" },
  { genre: "food", status: "in_progress", expected: "done" },
  { genre: "food", status: "done", expected: null },

  // ippin: received -> in_progress -> done（ショートカットは対象外。
  // 0004: v_genre = 'ippin'の段階的遷移部分のみ）
  { genre: "ippin", status: "received", expected: "in_progress" },
  { genre: "ippin", status: "in_progress", expected: "done" },
  { genre: "ippin", status: "done", expected: null },

  // drink: received -> done のみ（in_progressを経由しない。要件6.4、
  // 0004: v_genre = 'drink'）
  { genre: "drink", status: "received", expected: "done" },
  { genre: "drink", status: "done", expected: null },
  // ドリンクのin_progressは構造上到達しない状態だが、防御的にnullを返す
  // ことを検証する（DrinkBoard.tsx冒頭コメント「列構成について」と同じ
  // 前提）。
  { genre: "drink", status: "in_progress", expected: null },
];

describe("resolveNextOrderItemStatus", () => {
  it.each(CASES)(
    "genre=$genre, status=$status のとき次ステータスは$expected",
    ({ genre, status, expected }) => {
      expect(resolveNextOrderItemStatus(genre, status)).toBe(expected);
    },
  );

  it("全ジャンル×全ステータスの組み合わせ（3x3=9通り）を網羅していることを保証する（テーブル自体の抜け漏れ防止）", () => {
    const genres: ReadonlyArray<MenuItemGenre> = ["food", "ippin", "drink"];
    const statuses: ReadonlyArray<OrderItemStatus> = [
      "received",
      "in_progress",
      "done",
    ];
    for (const genre of genres) {
      for (const status of statuses) {
        expect(
          CASES.some((c) => c.genre === genre && c.status === status),
        ).toBe(true);
      }
    }
  });
});
