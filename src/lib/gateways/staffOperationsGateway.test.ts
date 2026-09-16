import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../supabase/database.types";
import {
  createStaffOperationsGateway,
  type AddOrderItemError,
  type CloseSessionError,
  type MenuItemError,
  type RemoveOrderItemError,
  type ResolveCallRequestError,
  type StaffOperationsGateway,
  type StartSessionError,
  type UpdateOrderItemStatusError,
  type UpdatePartySizeError,
} from "./staffOperationsGateway";

// staffOperationsGateway.ts（本タスク4.6）のユニットテスト。
// `client.rpc`をモックし、実際のSupabase/DBに接続せずに
// - 各メソッドが正しいRPC名・snake_caseの引数で呼び出すこと
// - 各RPCの成功応答がdesign.mdの型と同じ形へ整形されること
// - 各RPCが送出するカスタムSQLSTATEが、design.mdのエラー共用体の
//   正しいメンバーへマッピングされること（activeSessionId/menuItemId/
//   {from,to}のDETAIL抽出を含む）
// - マッピングにない未知のSQLSTATEは、Resultへ押し込めず例外として
//   伝播すること
// - listKitchenFeed/listRegisterFeed（design.mdの`never`エラー型）は、
//   FORBIDDENを含むあらゆるエラーをResultにせず例外として伝播すること
// を検証する。実際のRPCが本当にこの形で応答することは
// staffOperationsGateway.integration.test.tsが実スタックに対して確認する。
//
// Requirements: 2.2, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4,
//   5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7,
//   6.8, 6.9, 6.10, 7.1, 7.3, 7.4

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

describe("createStaffOperationsGateway", () => {
  let client: SupabaseClient<Database>;
  let rpc: ReturnType<typeof vi.fn>;
  let gateway: StaffOperationsGateway;

  beforeEach(() => {
    const mock = createMockClient();
    client = mock.client;
    rpc = mock.rpc;
    gateway = createStaffOperationsGateway(client);
  });

  it("11個のメソッドを持つゲートウェイオブジェクトを返す（DIファクトリ）", () => {
    expect(typeof gateway.startSession).toBe("function");
    expect(typeof gateway.closeSession).toBe("function");
    expect(typeof gateway.updatePartySize).toBe("function");
    expect(typeof gateway.addOrderItem).toBe("function");
    expect(typeof gateway.removeOrderItem).toBe("function");
    expect(typeof gateway.updateOrderItemStatus).toBe("function");
    expect(typeof gateway.setSoldOut).toBe("function");
    expect(typeof gateway.resolveCallRequest).toBe("function");
    expect(typeof gateway.listKitchenFeed).toBe("function");
    expect(typeof gateway.listRegisterFeed).toBe("function");
    expect(typeof gateway.listMenuItems).toBe("function");
  });

  describe("startSession", () => {
    it("start_sessionをp_table_id/p_party_sizeで呼び出し、成功応答をTableSession型へ整形する", async () => {
      rpc.mockResolvedValueOnce({
        data: {
          id: "session-1",
          tableId: "table-1",
          status: "active",
          startedAt: "2026-01-01T00:00:00.000Z",
          closedAt: null,
          partySize: 4,
        },
        error: null,
      });

      const result = await gateway.startSession({
        tableId: "table-1",
        partySize: 4,
      });

      expect(rpc).toHaveBeenCalledWith("start_session", {
        p_table_id: "table-1",
        p_party_size: 4,
      });
      expect(result).toEqual({
        ok: true,
        value: {
          id: "session-1",
          tableId: "table-1",
          status: "active",
          startedAt: "2026-01-01T00:00:00.000Z",
          closedAt: null,
          partySize: 4,
        },
      });
    });

    it("SQLSTATE P0423はSESSION_ALREADY_ACTIVEへマッピングされ、error.detailsのactiveSessionIdを含む（観測可能な完了条件）", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0423", { details: "existing-session-1" }),
      });

      const result = await gateway.startSession({
        tableId: "table-1",
        partySize: 2,
      });

      expect(result).toEqual({
        ok: false,
        error: {
          code: "SESSION_ALREADY_ACTIVE",
          activeSessionId: "existing-session-1",
        },
      });
    });

    it("SQLSTATE P0404はTABLE_NOT_FOUNDへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0404"),
      });

      const result = await gateway.startSession({
        tableId: "missing-table",
        partySize: 2,
      });

      expect(result).toEqual({ ok: false, error: { code: "TABLE_NOT_FOUND" } });
    });

    it("SQLSTATE P0403はFORBIDDENへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0403"),
      });

      const result = await gateway.startSession({
        tableId: "table-1",
        partySize: 2,
      });

      expect(result).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    });

    it("マッピングにない未知のSQLSTATEはResultにならず例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("XX000", { message: "network blip" }),
      });

      await expect(
        gateway.startSession({ tableId: "table-1", partySize: 2 }),
      ).rejects.toThrow(/network blip/);
    });
  });

  describe("closeSession", () => {
    it("close_sessionをp_session_idで呼び出し、成功応答をTableSession型へ整形する", async () => {
      rpc.mockResolvedValueOnce({
        data: {
          id: "session-1",
          tableId: "table-1",
          status: "closed",
          startedAt: "2026-01-01T00:00:00.000Z",
          closedAt: "2026-01-01T01:00:00.000Z",
          partySize: 4,
        },
        error: null,
      });

      const result = await gateway.closeSession({ sessionId: "session-1" });

      expect(rpc).toHaveBeenCalledWith("close_session", {
        p_session_id: "session-1",
      });
      expect(result).toEqual({
        ok: true,
        value: {
          id: "session-1",
          tableId: "table-1",
          status: "closed",
          startedAt: "2026-01-01T00:00:00.000Z",
          closedAt: "2026-01-01T01:00:00.000Z",
          partySize: 4,
        },
      });
    });

    it("SQLSTATE P0409はSESSION_NOT_ACTIVEへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0409"),
      });

      const result = await gateway.closeSession({ sessionId: "session-1" });

      expect(result).toEqual({
        ok: false,
        error: { code: "SESSION_NOT_ACTIVE" },
      });
    });

    it("SQLSTATE P0403はFORBIDDENへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0403"),
      });

      const result = await gateway.closeSession({ sessionId: "session-1" });

      expect(result).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    });

    it("マッピングにない未知のSQLSTATEはResultにならず例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("XX000", { message: "boom" }),
      });

      await expect(
        gateway.closeSession({ sessionId: "session-1" }),
      ).rejects.toThrow(/boom/);
    });
  });

  describe("updatePartySize", () => {
    it("update_party_sizeをp_session_id/p_party_sizeで呼び出し、成功応答をTableSession型へ整形する", async () => {
      rpc.mockResolvedValueOnce({
        data: {
          id: "session-1",
          tableId: "table-1",
          status: "active",
          startedAt: "2026-01-01T00:00:00.000Z",
          closedAt: null,
          partySize: 6,
        },
        error: null,
      });

      const result = await gateway.updatePartySize({
        sessionId: "session-1",
        partySize: 6,
      });

      expect(rpc).toHaveBeenCalledWith("update_party_size", {
        p_session_id: "session-1",
        p_party_size: 6,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.partySize).toBe(6);
      }
    });

    it("SQLSTATE P0409はSESSION_NOT_ACTIVEへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0409"),
      });

      const result = await gateway.updatePartySize({
        sessionId: "session-1",
        partySize: 1,
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "SESSION_NOT_ACTIVE" },
      });
    });

    it("マッピングにない未知のSQLSTATEはResultにならず例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("XX000", { message: "unexpected" }),
      });

      await expect(
        gateway.updatePartySize({ sessionId: "session-1", partySize: 1 }),
      ).rejects.toThrow(/unexpected/);
    });
  });

  describe("addOrderItem", () => {
    const baseInput = {
      sessionId: "session-1",
      menuItemId: "item-1",
      quantity: 2,
      optionSelections: { spice: "普通" },
    };

    it("add_order_itemをsnake_caseの引数で呼び出し、成功応答をOrderItemSummary型へ整形する", async () => {
      rpc.mockResolvedValueOnce({
        data: {
          id: "order-item-1",
          menuItemId: "item-1",
          name: "Item One",
          unitPrice: 500,
          quantity: 2,
          optionsSummary: "辛さ: 普通",
          status: "received",
          statusUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
        error: null,
      });

      const result = await gateway.addOrderItem(baseInput);

      expect(rpc).toHaveBeenCalledWith("add_order_item", {
        p_session_id: "session-1",
        p_menu_item_id: "item-1",
        p_quantity: 2,
        p_option_selections: { spice: "普通" },
      });
      expect(result).toEqual({
        ok: true,
        value: {
          id: "order-item-1",
          menuItemId: "item-1",
          name: "Item One",
          unitPrice: 500,
          quantity: 2,
          optionsSummary: "辛さ: 普通",
          status: "received",
          statusUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
      });
    });

    it("SQLSTATE P0409はSESSION_NOT_ACTIVEへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0409"),
      });

      const result = await gateway.addOrderItem(baseInput);

      expect(result).toEqual({
        ok: false,
        error: { code: "SESSION_NOT_ACTIVE" },
      });
    });

    it("SQLSTATE P0410はITEM_SOLD_OUTへマッピングされ、error.detailsのmenuItemIdを含む（観測可能な完了条件）", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0410", { details: "item-sold-out-1" }),
      });

      const result = await gateway.addOrderItem(baseInput);

      expect(result).toEqual({
        ok: false,
        error: { code: "ITEM_SOLD_OUT", menuItemId: "item-sold-out-1" },
      });
    });

    it("SQLSTATE P0403はFORBIDDENへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0403"),
      });

      const result = await gateway.addOrderItem(baseInput);

      expect(result).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    });

    it("マッピングにない未知のSQLSTATEはResultにならず例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("XX000", { message: "boom" }),
      });

      await expect(gateway.addOrderItem(baseInput)).rejects.toThrow(/boom/);
    });
  });

  describe("removeOrderItem", () => {
    it("remove_order_itemをp_order_item_idで呼び出し、成功応答を{orderItemId}へ整形する", async () => {
      rpc.mockResolvedValueOnce({
        data: { orderItemId: "order-item-1" },
        error: null,
      });

      const result = await gateway.removeOrderItem({
        orderItemId: "order-item-1",
      });

      expect(rpc).toHaveBeenCalledWith("remove_order_item", {
        p_order_item_id: "order-item-1",
      });
      expect(result).toEqual({
        ok: true,
        value: { orderItemId: "order-item-1" },
      });
    });

    it("SQLSTATE P0444はORDER_ITEM_NOT_FOUNDへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0444"),
      });

      const result = await gateway.removeOrderItem({
        orderItemId: "missing-item",
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "ORDER_ITEM_NOT_FOUND" },
      });
    });

    it("SQLSTATE P0403はFORBIDDENへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0403"),
      });

      const result = await gateway.removeOrderItem({
        orderItemId: "order-item-1",
      });

      expect(result).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    });

    it("マッピングにない未知のSQLSTATEはResultにならず例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("XX000", { message: "boom" }),
      });

      await expect(
        gateway.removeOrderItem({ orderItemId: "order-item-1" }),
      ).rejects.toThrow(/boom/);
    });
  });

  describe("updateOrderItemStatus", () => {
    it("update_order_item_statusをp_order_item_id/p_statusで呼び出し、成功応答をOrderItemSummary型へ整形する", async () => {
      rpc.mockResolvedValueOnce({
        data: {
          id: "order-item-1",
          menuItemId: "item-1",
          name: "Item One",
          unitPrice: 500,
          quantity: 1,
          optionsSummary: null,
          status: "in_progress",
          statusUpdatedAt: "2026-01-01T00:00:01.000Z",
        },
        error: null,
      });

      const result = await gateway.updateOrderItemStatus({
        orderItemId: "order-item-1",
        status: "in_progress",
      });

      expect(rpc).toHaveBeenCalledWith("update_order_item_status", {
        p_order_item_id: "order-item-1",
        p_status: "in_progress",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("in_progress");
      }
    });

    it("SQLSTATE P0444はORDER_ITEM_NOT_FOUNDへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0444"),
      });

      const result = await gateway.updateOrderItemStatus({
        orderItemId: "missing-item",
        status: "done",
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "ORDER_ITEM_NOT_FOUND" },
      });
    });

    it("SQLSTATE P0422はINVALID_TRANSITIONへマッピングされ、error.details（JSON文字列）のfrom/toを含む（観測可能な完了条件）", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0422", {
          details: JSON.stringify({ from: "received", to: "done" }),
        }),
      });

      const result = await gateway.updateOrderItemStatus({
        orderItemId: "order-item-1",
        status: "done",
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "INVALID_TRANSITION", from: "received", to: "done" },
      });
    });

    it("SQLSTATE P0403はFORBIDDENへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0403"),
      });

      const result = await gateway.updateOrderItemStatus({
        orderItemId: "order-item-1",
        status: "done",
      });

      expect(result).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    });

    it("マッピングにない未知のSQLSTATEはResultにならず例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("XX000", { message: "boom" }),
      });

      await expect(
        gateway.updateOrderItemStatus({
          orderItemId: "order-item-1",
          status: "done",
        }),
      ).rejects.toThrow(/boom/);
    });
  });

  describe("setSoldOut", () => {
    it("set_sold_outをp_menu_item_id/p_sold_outで呼び出し、成功応答をMenuItem型へ整形する", async () => {
      rpc.mockResolvedValueOnce({
        data: {
          id: "item-1",
          storeId: "store-1",
          name: "Item One",
          price: 500,
          soldOut: true,
        },
        error: null,
      });

      const result = await gateway.setSoldOut({
        menuItemId: "item-1",
        soldOut: true,
      });

      expect(rpc).toHaveBeenCalledWith("set_sold_out", {
        p_menu_item_id: "item-1",
        p_sold_out: true,
      });
      expect(result).toEqual({
        ok: true,
        value: {
          id: "item-1",
          storeId: "store-1",
          name: "Item One",
          price: 500,
          soldOut: true,
        },
      });
    });

    it("SQLSTATE P0405はITEM_NOT_FOUNDへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0405"),
      });

      const result = await gateway.setSoldOut({
        menuItemId: "missing-item",
        soldOut: true,
      });

      expect(result).toEqual({ ok: false, error: { code: "ITEM_NOT_FOUND" } });
    });

    it("SQLSTATE P0403はFORBIDDENへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0403"),
      });

      const result = await gateway.setSoldOut({
        menuItemId: "item-1",
        soldOut: true,
      });

      expect(result).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    });

    it("マッピングにない未知のSQLSTATEはResultにならず例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("XX000", { message: "boom" }),
      });

      await expect(
        gateway.setSoldOut({ menuItemId: "item-1", soldOut: true }),
      ).rejects.toThrow(/boom/);
    });
  });

  describe("resolveCallRequest", () => {
    it("resolve_call_requestをp_call_request_idで呼び出し、成功応答をCallRequest型へ整形する", async () => {
      rpc.mockResolvedValueOnce({
        data: {
          id: "call-1",
          sessionId: "session-1",
          status: "resolved",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        error: null,
      });

      const result = await gateway.resolveCallRequest({
        callRequestId: "call-1",
      });

      expect(rpc).toHaveBeenCalledWith("resolve_call_request", {
        p_call_request_id: "call-1",
      });
      expect(result).toEqual({
        ok: true,
        value: {
          id: "call-1",
          sessionId: "session-1",
          status: "resolved",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });
    });

    it("SQLSTATE P0445はCALL_REQUEST_NOT_FOUNDへマッピングされる（4.4レビューで修正済みの専用エラー型）", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0445"),
      });

      const result = await gateway.resolveCallRequest({
        callRequestId: "missing-call",
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "CALL_REQUEST_NOT_FOUND" },
      });
    });

    it("SQLSTATE P0403はFORBIDDENへマッピングされる", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0403"),
      });

      const result = await gateway.resolveCallRequest({
        callRequestId: "call-1",
      });

      expect(result).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    });

    it("マッピングにない未知のSQLSTATEはResultにならず例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("XX000", { message: "boom" }),
      });

      await expect(
        gateway.resolveCallRequest({ callRequestId: "call-1" }),
      ).rejects.toThrow(/boom/);
    });
  });

  describe("listKitchenFeed", () => {
    it("list_kitchen_feedをp_store_idで呼び出し、成功応答を配列へ整形する", async () => {
      rpc.mockResolvedValueOnce({
        data: [
          {
            id: "order-item-1",
            menuItemId: "item-1",
            name: "Item One",
            unitPrice: 500,
            quantity: 1,
            optionsSummary: null,
            status: "received",
            statusUpdatedAt: "2026-01-01T00:00:00.000Z",
            tableId: "table-1",
            tableLabel: "1番卓",
            genre: "food",
          },
        ],
        error: null,
      });

      const result = await gateway.listKitchenFeed({ storeId: "store-1" });

      expect(rpc).toHaveBeenCalledWith("list_kitchen_feed", {
        p_store_id: "store-1",
      });
      expect(result).toEqual({
        ok: true,
        value: [
          {
            id: "order-item-1",
            menuItemId: "item-1",
            name: "Item One",
            unitPrice: 500,
            quantity: 1,
            optionsSummary: null,
            status: "received",
            statusUpdatedAt: "2026-01-01T00:00:00.000Z",
            tableId: "table-1",
            tableLabel: "1番卓",
            genre: "food",
          },
        ],
      });
    });

    it("design.mdの`never`エラー型: FORBIDDEN（P0403）でさえResultのエラーにならず例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0403", { message: "forbidden" }),
      });

      await expect(
        gateway.listKitchenFeed({ storeId: "store-1" }),
      ).rejects.toThrow(/forbidden/);
    });

    it("design.mdの`never`エラー型: あらゆる未知のSQLSTATEも例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("XX000", { message: "boom" }),
      });

      await expect(
        gateway.listKitchenFeed({ storeId: "store-1" }),
      ).rejects.toThrow(/boom/);
    });
  });

  describe("listRegisterFeed", () => {
    it("list_register_feedをp_store_idで呼び出し、成功応答を配列へ整形する（activeSessionがnullの卓を含む、各明細のid/optionsSummary/status/genreを含む。タスク8.3/8.4）", async () => {
      rpc.mockResolvedValueOnce({
        data: [
          {
            tableId: "table-1",
            tableLabel: "1番卓",
            activeSession: {
              id: "session-1",
              startedAt: "2026-01-01T00:00:00.000Z",
              partySize: 2,
            },
            items: [
              {
                id: "item-row-1",
                menuItemId: "item-1",
                name: "Item One",
                quantity: 2,
                unitPrice: 500,
                optionsSummary: "わさび抜き",
                status: "received",
                genre: "food",
              },
            ],
            total: 1000,
            hasOpenCallRequest: true,
          },
          {
            tableId: "table-2",
            tableLabel: "2番卓",
            activeSession: null,
            items: [],
            total: 0,
            hasOpenCallRequest: false,
          },
        ],
        error: null,
      });

      const result = await gateway.listRegisterFeed({ storeId: "store-1" });

      expect(rpc).toHaveBeenCalledWith("list_register_feed", {
        p_store_id: "store-1",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      expect(result.value[0]).toEqual({
        tableId: "table-1",
        tableLabel: "1番卓",
        activeSession: {
          id: "session-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          partySize: 2,
        },
        items: [
          {
            id: "item-row-1",
            menuItemId: "item-1",
            name: "Item One",
            quantity: 2,
            unitPrice: 500,
            optionsSummary: "わさび抜き",
            status: "received",
            genre: "food",
          },
        ],
        total: 1000,
        hasOpenCallRequest: true,
      });
      expect(result.value[1].activeSession).toBeNull();
    });

    it("design.mdの`never`エラー型: FORBIDDEN（P0403）でさえResultのエラーにならず例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0403", { message: "forbidden" }),
      });

      await expect(
        gateway.listRegisterFeed({ storeId: "store-1" }),
      ).rejects.toThrow(/forbidden/);
    });

    it("design.mdの`never`エラー型: あらゆる未知のSQLSTATEも例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("XX000", { message: "boom" }),
      });

      await expect(
        gateway.listRegisterFeed({ storeId: "store-1" }),
      ).rejects.toThrow(/boom/);
    });
  });

  describe("listMenuItems", () => {
    it("list_menu_itemsをp_store_idで呼び出し、成功応答を配列へ整形する（imageUrl/optionsを含む。タスク8.3でレジの品目追加フロー向けに追加）", async () => {
      rpc.mockResolvedValueOnce({
        data: [
          {
            id: "item-1",
            name: "唐揚げ",
            price: 600,
            soldOut: false,
            genre: "food",
            imageUrl: "https://example.com/karaage.jpg",
            options: [
              {
                id: "sauce",
                type: "choice",
                label: "タレ",
                choices: ["塩", "醤油"],
                default: "塩",
              },
            ],
          },
          {
            id: "item-2",
            name: "レモンサワー",
            price: 400,
            soldOut: true,
            genre: "drink",
            imageUrl: null,
            options: [],
          },
        ],
        error: null,
      });

      const result = await gateway.listMenuItems({ storeId: "store-1" });

      expect(rpc).toHaveBeenCalledWith("list_menu_items", {
        p_store_id: "store-1",
      });
      expect(result).toEqual({
        ok: true,
        value: [
          {
            id: "item-1",
            name: "唐揚げ",
            price: 600,
            soldOut: false,
            genre: "food",
            imageUrl: "https://example.com/karaage.jpg",
            options: [
              {
                id: "sauce",
                type: "choice",
                label: "タレ",
                choices: ["塩", "醤油"],
                default: "塩",
              },
            ],
          },
          {
            id: "item-2",
            name: "レモンサワー",
            price: 400,
            soldOut: true,
            genre: "drink",
            imageUrl: null,
            options: [],
          },
        ],
      });
    });

    it("design.mdの`never`エラー型: FORBIDDEN（P0403）でさえResultのエラーにならず例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("P0403", { message: "forbidden" }),
      });

      await expect(
        gateway.listMenuItems({ storeId: "store-1" }),
      ).rejects.toThrow(/forbidden/);
    });

    it("design.mdの`never`エラー型: あらゆる未知のSQLSTATEも例外として伝播する", async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: samplePostgrestError("XX000", { message: "boom" }),
      });

      await expect(
        gateway.listMenuItems({ storeId: "store-1" }),
      ).rejects.toThrow(/boom/);
    });
  });
});

// ===========================================================================
// 観測可能な完了条件の実証: 「全メソッドの戻り値がResult<T,E>型として型
// チェックを通過する」（tasks.md 4.6）。
//
// 以下の8関数は、design.mdが定義する各エラー共用体（listKitchenFeed/
// listRegisterFeed/listMenuItemsの`never`を除く8つ）のメンバーを漏れなく
// switchで処理し、
// default節でnever型チェック（exhaustiveCheck）を行う。共用体にメンバーを
// 追加/削除すると、default節の`const exhaustiveCheck: never = errorValue`が
// コンパイルエラーになるため、tsc --noEmit（npm run typecheck）自体が
// この完了条件の検証手段になる。加えて、下の"網羅的なswitch"describeブロック
// で各メンバーを実際に渡して実行し、型チェックが通るだけでなく実行時にも
// 正しく分岐することを実証する（customerOrderingGateway.test.tsの前例と
// 同じ技法）。
// ===========================================================================

function describeStartSessionError(errorValue: StartSessionError): string {
  switch (errorValue.code) {
    case "SESSION_ALREADY_ACTIVE":
      return `already active: ${errorValue.activeSessionId}`;
    case "TABLE_NOT_FOUND":
      return "table not found";
    case "FORBIDDEN":
      return "forbidden";
    default: {
      const exhaustiveCheck: never = errorValue;
      throw new Error(`unhandled StartSessionError: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function describeCloseSessionError(errorValue: CloseSessionError): string {
  switch (errorValue.code) {
    case "SESSION_NOT_ACTIVE":
      return "session not active";
    case "FORBIDDEN":
      return "forbidden";
    default: {
      const exhaustiveCheck: never = errorValue;
      throw new Error(`unhandled CloseSessionError: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function describeUpdatePartySizeError(errorValue: UpdatePartySizeError): string {
  switch (errorValue.code) {
    case "SESSION_NOT_ACTIVE":
      return "session not active";
    case "FORBIDDEN":
      return "forbidden";
    default: {
      const exhaustiveCheck: never = errorValue;
      throw new Error(`unhandled UpdatePartySizeError: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function describeAddOrderItemError(errorValue: AddOrderItemError): string {
  switch (errorValue.code) {
    case "SESSION_NOT_ACTIVE":
      return "session not active";
    case "ITEM_SOLD_OUT":
      return `item sold out: ${errorValue.menuItemId}`;
    case "FORBIDDEN":
      return "forbidden";
    default: {
      const exhaustiveCheck: never = errorValue;
      throw new Error(`unhandled AddOrderItemError: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function describeRemoveOrderItemError(errorValue: RemoveOrderItemError): string {
  switch (errorValue.code) {
    case "ORDER_ITEM_NOT_FOUND":
      return "order item not found";
    case "FORBIDDEN":
      return "forbidden";
    default: {
      const exhaustiveCheck: never = errorValue;
      throw new Error(`unhandled RemoveOrderItemError: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function describeUpdateOrderItemStatusError(
  errorValue: UpdateOrderItemStatusError,
): string {
  switch (errorValue.code) {
    case "ORDER_ITEM_NOT_FOUND":
      return "order item not found";
    case "INVALID_TRANSITION":
      return `invalid transition: ${errorValue.from} -> ${errorValue.to}`;
    case "FORBIDDEN":
      return "forbidden";
    default: {
      const exhaustiveCheck: never = errorValue;
      throw new Error(
        `unhandled UpdateOrderItemStatusError: ${JSON.stringify(exhaustiveCheck)}`,
      );
    }
  }
}

function describeMenuItemError(errorValue: MenuItemError): string {
  switch (errorValue.code) {
    case "ITEM_NOT_FOUND":
      return "item not found";
    case "FORBIDDEN":
      return "forbidden";
    default: {
      const exhaustiveCheck: never = errorValue;
      throw new Error(`unhandled MenuItemError: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function describeResolveCallRequestError(
  errorValue: ResolveCallRequestError,
): string {
  switch (errorValue.code) {
    case "FORBIDDEN":
      return "forbidden";
    case "CALL_REQUEST_NOT_FOUND":
      return "call request not found";
    default: {
      const exhaustiveCheck: never = errorValue;
      throw new Error(
        `unhandled ResolveCallRequestError: ${JSON.stringify(exhaustiveCheck)}`,
      );
    }
  }
}

describe("エラー共用体に対する網羅的なswitch（型チェック + 実行時の両方で実証）", () => {
  it("StartSessionErrorの全メンバーを処理できる", () => {
    expect(
      describeStartSessionError({
        code: "SESSION_ALREADY_ACTIVE",
        activeSessionId: "session-1",
      }),
    ).toBe("already active: session-1");
    expect(describeStartSessionError({ code: "TABLE_NOT_FOUND" })).toBe(
      "table not found",
    );
    expect(describeStartSessionError({ code: "FORBIDDEN" })).toBe("forbidden");
  });

  it("CloseSessionErrorの全メンバーを処理できる", () => {
    expect(describeCloseSessionError({ code: "SESSION_NOT_ACTIVE" })).toBe(
      "session not active",
    );
    expect(describeCloseSessionError({ code: "FORBIDDEN" })).toBe("forbidden");
  });

  it("UpdatePartySizeErrorの全メンバーを処理できる", () => {
    expect(describeUpdatePartySizeError({ code: "SESSION_NOT_ACTIVE" })).toBe(
      "session not active",
    );
    expect(describeUpdatePartySizeError({ code: "FORBIDDEN" })).toBe(
      "forbidden",
    );
  });

  it("AddOrderItemErrorの全メンバーを処理できる", () => {
    expect(describeAddOrderItemError({ code: "SESSION_NOT_ACTIVE" })).toBe(
      "session not active",
    );
    expect(
      describeAddOrderItemError({ code: "ITEM_SOLD_OUT", menuItemId: "item-1" }),
    ).toBe("item sold out: item-1");
    expect(describeAddOrderItemError({ code: "FORBIDDEN" })).toBe("forbidden");
  });

  it("RemoveOrderItemErrorの全メンバーを処理できる", () => {
    expect(
      describeRemoveOrderItemError({ code: "ORDER_ITEM_NOT_FOUND" }),
    ).toBe("order item not found");
    expect(describeRemoveOrderItemError({ code: "FORBIDDEN" })).toBe(
      "forbidden",
    );
  });

  it("UpdateOrderItemStatusErrorの全メンバーを処理できる", () => {
    expect(
      describeUpdateOrderItemStatusError({ code: "ORDER_ITEM_NOT_FOUND" }),
    ).toBe("order item not found");
    expect(
      describeUpdateOrderItemStatusError({
        code: "INVALID_TRANSITION",
        from: "received",
        to: "done",
      }),
    ).toBe("invalid transition: received -> done");
    expect(describeUpdateOrderItemStatusError({ code: "FORBIDDEN" })).toBe(
      "forbidden",
    );
  });

  it("MenuItemErrorの全メンバーを処理できる", () => {
    expect(describeMenuItemError({ code: "ITEM_NOT_FOUND" })).toBe(
      "item not found",
    );
    expect(describeMenuItemError({ code: "FORBIDDEN" })).toBe("forbidden");
  });

  it("ResolveCallRequestErrorの全メンバーを処理できる（4.4レビューで修正済みの専用型）", () => {
    expect(describeResolveCallRequestError({ code: "FORBIDDEN" })).toBe(
      "forbidden",
    );
    expect(
      describeResolveCallRequestError({ code: "CALL_REQUEST_NOT_FOUND" }),
    ).toBe("call request not found");
  });
});
