import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../supabase/database.types";
import {
  createCustomerOrderingGateway,
  type CallRequestError,
  type CustomerOrderingGateway,
  type OrderingContextError,
  type SubmitOrderError,
} from "./customerOrderingGateway";

// customerOrderingGateway.ts（本タスク3.4）のユニットテスト。
// `client.rpc`をモックし、実際のSupabase/DBに接続せずに
// - 各メソッドが正しいRPC名・snake_caseの引数で呼び出すこと
// - 各RPCの成功応答がdesign.mdの型と同じ形へ整形されること
// - 各RPCが送出するカスタムSQLSTATEが、design.mdのエラー共用体の
//   正しいメンバーへマッピングされること（ITEM_SOLD_OUTのmenuItemId抽出、
//   CALL_ALREADY_OPENが追加ペイロードを持たないことを含む）
// - マッピングにない未知のSQLSTATEは、Resultへ押し込めず例外として
//   伝播すること
// を検証する。実際のRPCが本当にこの形で応答することは
// customerOrderingGateway.integration.test.tsが実スタックに対して確認する。
//
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.12,
//   2.1, 2.2, 2.3, 7.2

function createMockClient() {
  const rpc = vi.fn();
  const client = { rpc } as unknown as SupabaseClient<Database>;
  return { client, rpc };
}

function samplePostgrestError(
  code: string,
  overrides: Partial<{ message: string; details: string; hint: string }> = {},
) {
  return {
    name: "PostgrestError",
    message: overrides.message ?? `error ${code}`,
    details: overrides.details ?? "",
    hint: overrides.hint ?? "",
    code,
  };
}

describe("createCustomerOrderingGateway", () => {
  let client: SupabaseClient<Database>;
  let rpc: ReturnType<typeof vi.fn>;
  let gateway: CustomerOrderingGateway;

  beforeEach(() => {
    const mock = createMockClient();
    client = mock.client;
    rpc = mock.rpc;
    gateway = createCustomerOrderingGateway(client);
  });

  it("3つのメソッドを持つゲートウェイオブジェクトを返す（DIファクトリ）", () => {
    expect(typeof gateway.getOrderingContext).toBe("function");
    expect(typeof gateway.submitOrder).toBe("function");
    expect(typeof gateway.createCallRequest).toBe("function");
  });

  describe("getOrderingContext", () => {
    it("get_ordering_contextをp_table_idで呼び出し、成功応答をOrderingContext型へ整形する", async () => {
      rpc.mockResolvedValueOnce({
        data: {
          table: { id: "table-1", label: "1番卓" },
          activeSession: { id: "session-1" },
          confirmedTotal: 1300,
          menu: [
            {
              id: "item-1",
              name: "Item One",
              price: 500,
              soldOut: false,
              imageUrl: "https://example.com/item-one.jpg",
              options: [
                {
                  id: "spice",
                  type: "choice",
                  label: "辛さ",
                  choices: ["普通", "辛口"],
                  default: "普通",
                },
              ],
            },
          ],
        },
        error: null,
      });

      const result = await gateway.getOrderingContext({ tableId: "table-1" });

      expect(rpc).toHaveBeenCalledWith("get_ordering_context", {
        p_table_id: "table-1",
      });
      expect(result).toEqual({
        ok: true,
        value: {
          table: { id: "table-1", label: "1番卓" },
          activeSession: { id: "session-1" },
          confirmedTotal: 1300,
          menu: [
            {
              id: "item-1",
              name: "Item One",
              price: 500,
              soldOut: false,
              imageUrl: "https://example.com/item-one.jpg",
              options: [
                {
                  id: "spice",
                  type: "choice",
                  label: "辛さ",
                  choices: ["普通", "辛口"],
                  default: "普通",
                },
              ],
            },
          ],
        },
      });
    });

    it("activeSessionがnullの応答はnullのまま（undefinedにならず）整形する", async () => {
      rpc.mockResolvedValueOnce({
        data: {
          table: { id: "table-1", label: "1番卓" },
          activeSession: null,
          confirmedTotal: 0,
          menu: [],
        },
        error: null,
      });

      const result = await gateway.getOrderingContext({ tableId: "table-1" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.activeSession).toBeNull();
      }
    });

    it("SQLSTATE P0404はTABLE_NOT_FOUNDへマッピングされる（観測可能な完了条件）", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0404"),
      });

      const result = await gateway.getOrderingContext({
        tableId: "missing-table",
      });

      expect(result).toEqual({ ok: false, error: { code: "TABLE_NOT_FOUND" } });
    });

    it("マッピングにない未知のSQLSTATEはResultにならず例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("XX000", { message: "network blip" }),
      });

      await expect(
        gateway.getOrderingContext({ tableId: "table-1" }),
      ).rejects.toThrow(/network blip/);
    });
  });

  describe("submitOrder", () => {
    const baseInput = {
      sessionId: "session-1",
      idempotencyKey: "key-1",
      items: [
        {
          menuItemId: "item-1",
          quantity: 2,
          optionSelections: { spice: "普通" },
          note: null,
        },
      ],
    };

    it("submit_orderをsnake_caseの引数（camelCaseなitems）で呼び出し、成功応答をSubmitOrderResult型へ整形する", async () => {
      rpc.mockResolvedValueOnce({
        data: {
          order: {
            id: "order-1",
            createdAt: "2026-01-01T00:00:00.000Z",
            items: [
              {
                id: "order-item-1",
                menuItemId: "item-1",
                name: "Item One",
                unitPrice: 500,
                quantity: 2,
                optionsSummary: "辛さ: 普通",
                status: "received",
                statusUpdatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
          deduplicated: false,
        },
        error: null,
      });

      const result = await gateway.submitOrder(baseInput);

      expect(rpc).toHaveBeenCalledWith("submit_order", {
        p_session_id: "session-1",
        p_idempotency_key: "key-1",
        p_items: [
          {
            menuItemId: "item-1",
            quantity: 2,
            optionSelections: { spice: "普通" },
            note: null,
          },
        ],
      });
      expect(result).toEqual({
        ok: true,
        value: {
          deduplicated: false,
          order: {
            id: "order-1",
            createdAt: "2026-01-01T00:00:00.000Z",
            items: [
              {
                id: "order-item-1",
                menuItemId: "item-1",
                name: "Item One",
                unitPrice: 500,
                quantity: 2,
                optionsSummary: "辛さ: 普通",
                status: "received",
                statusUpdatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        },
      });
    });

    it("SQLSTATE P0409はSESSION_NOT_ACTIVEへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0409"),
      });

      const result = await gateway.submitOrder(baseInput);

      expect(result).toEqual({
        ok: false,
        error: { code: "SESSION_NOT_ACTIVE" },
      });
    });

    it("SQLSTATE P0400はEMPTY_ORDERへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0400"),
      });

      const result = await gateway.submitOrder({ ...baseInput, items: [] });

      expect(result).toEqual({ ok: false, error: { code: "EMPTY_ORDER" } });
    });

    it("SQLSTATE P0410はITEM_SOLD_OUTへマッピングされ、error.detailsのmenuItemIdを含む（観測可能な完了条件）", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0410", { details: "item-sold-out-1" }),
      });

      const result = await gateway.submitOrder(baseInput);

      expect(result).toEqual({
        ok: false,
        error: { code: "ITEM_SOLD_OUT", menuItemId: "item-sold-out-1" },
      });
    });

    it("マッピングにない未知のSQLSTATEはResultにならず例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("XX000", { message: "unexpected db error" }),
      });

      await expect(gateway.submitOrder(baseInput)).rejects.toThrow(
        /unexpected db error/,
      );
    });
  });

  describe("createCallRequest", () => {
    it("create_call_requestをp_session_idで呼び出し、成功応答をCallRequest型へ整形する", async () => {
      rpc.mockResolvedValueOnce({
        data: {
          id: "call-1",
          sessionId: "session-1",
          status: "open",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        error: null,
      });

      const result = await gateway.createCallRequest({
        sessionId: "session-1",
      });

      expect(rpc).toHaveBeenCalledWith("create_call_request", {
        p_session_id: "session-1",
      });
      expect(result).toEqual({
        ok: true,
        value: {
          id: "call-1",
          sessionId: "session-1",
          status: "open",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });
    });

    it("SQLSTATE P0409はSESSION_NOT_ACTIVEへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0409"),
      });

      const result = await gateway.createCallRequest({
        sessionId: "session-1",
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "SESSION_NOT_ACTIVE" },
      });
    });

    it("SQLSTATE P0412はCALL_ALREADY_OPENへマッピングされ、design.mdの型通り追加ペイロードを持たない（既存呼び出しidをdetailsから抽出しない）", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0412", { details: "existing-call-1" }),
      });

      const result = await gateway.createCallRequest({
        sessionId: "session-1",
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "CALL_ALREADY_OPEN" },
      });
      if (!result.ok) {
        expect(Object.keys(result.error)).toEqual(["code"]);
      }
    });

    it("マッピングにない未知のSQLSTATEはResultにならず例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("XX000", { message: "boom" }),
      });

      await expect(
        gateway.createCallRequest({ sessionId: "session-1" }),
      ).rejects.toThrow(/boom/);
    });
  });
});

// ===========================================================================
// 観測可能な完了条件の実証: 「各RPCのエラーコードがユニオン型として型チェックを
// 通過し、呼び出し側で網羅的なswitchができる」（tasks.md 3.4）。
//
// 以下の3関数は、design.mdが定義する各エラー共用体のメンバーを漏れなく
// switchで処理し、default節でnever型チェック（exhaustiveCheck）を行う。
// 共用体にメンバーを追加/削除すると、default節の`const exhaustiveCheck: never
// = errorValue`がコンパイルエラーになるため、tsc --noEmit
// （npm run typecheck）自体がこの完了条件の検証手段になる。
// 加えて、下の"網羅的なswitch"describeブロックで各メンバーを実際に渡して
// 実行し、型チェックが通るだけでなく実行時にも正しく分岐することを実証する。
// ===========================================================================

function describeOrderingContextError(errorValue: OrderingContextError): string {
  switch (errorValue.code) {
    case "TABLE_NOT_FOUND":
      return "table not found";
    default: {
      // OrderingContextErrorは現時点でメンバーが1つのみだが、`errorValue.code`
      // （switchの判別対象そのもの）が`never`へ narrow されることをtscで
      // 検証する。design.mdが将来このユニオンにメンバーを追加した場合、
      // 対応するcaseを追加しない限りここが型エラーになる。
      const exhaustiveCheck: never = errorValue.code;
      throw new Error(`unhandled OrderingContextError: ${String(exhaustiveCheck)}`);
    }
  }
}

function describeSubmitOrderError(errorValue: SubmitOrderError): string {
  switch (errorValue.code) {
    case "SESSION_NOT_ACTIVE":
      return "session not active";
    case "ITEM_SOLD_OUT":
      return `item sold out: ${errorValue.menuItemId}`;
    case "EMPTY_ORDER":
      return "empty order";
    case "RATE_LIMITED":
      // RPCはまだこのコードを送出しないが（本ファイル冒頭コメント参照）、
      // 型としては存在するため呼び出し側は網羅的に処理できなければならない。
      return "rate limited";
    default: {
      const exhaustiveCheck: never = errorValue;
      throw new Error(`unhandled SubmitOrderError: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function describeCallRequestError(errorValue: CallRequestError): string {
  switch (errorValue.code) {
    case "SESSION_NOT_ACTIVE":
      return "session not active";
    case "CALL_ALREADY_OPEN":
      return "call already open";
    default: {
      const exhaustiveCheck: never = errorValue;
      throw new Error(`unhandled CallRequestError: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

describe("エラー共用体に対する網羅的なswitch（型チェック + 実行時の両方で実証）", () => {
  it("OrderingContextErrorの全メンバーを処理できる", () => {
    expect(describeOrderingContextError({ code: "TABLE_NOT_FOUND" })).toBe(
      "table not found",
    );
  });

  it("SubmitOrderErrorの全メンバー（RATE_LIMITEDを含む）を処理できる", () => {
    expect(describeSubmitOrderError({ code: "SESSION_NOT_ACTIVE" })).toBe(
      "session not active",
    );
    expect(
      describeSubmitOrderError({ code: "ITEM_SOLD_OUT", menuItemId: "item-1" }),
    ).toBe("item sold out: item-1");
    expect(describeSubmitOrderError({ code: "EMPTY_ORDER" })).toBe(
      "empty order",
    );
    expect(describeSubmitOrderError({ code: "RATE_LIMITED" })).toBe(
      "rate limited",
    );
  });

  it("CallRequestErrorの全メンバーを処理できる", () => {
    expect(describeCallRequestError({ code: "SESSION_NOT_ACTIVE" })).toBe(
      "session not active",
    );
    expect(describeCallRequestError({ code: "CALL_ALREADY_OPEN" })).toBe(
      "call already open",
    );
  });
});
