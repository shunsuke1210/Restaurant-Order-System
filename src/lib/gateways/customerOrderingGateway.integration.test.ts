// @vitest-environment node
//
// customerOrderingGateway.ts（本タスク3.4）の結合テスト。ユニットテスト
// （customerOrderingGateway.test.ts）は`client.rpc`をモックしてマッピング
// ロジックを検証するが、実際の0003_rpc_customer_gateway.sql RPCが本当に
// この形（jsonbのキー名・SQLSTATE）で応答するかどうかまではモックでは
// 検証できない（TSマッピングとRPCの実応答の間のドリフトを検出できない）。
// 本ファイルはローカルSupabaseスタックに対する実際のanonキー・無サインインの
// supabase-js呼び出しを`createCustomerOrderingGateway`経由で行い、
// getOrderingContext/submitOrder/createCallRequestそれぞれの幸せな経路と
// 代表的なエラー経路を検証する。getOrderingContext.integration.test.ts等
// （タスク3.1/3.2/3.3）と同じ構成: 事前に`npm run db:start`と
// `npm run db:reset`（0001, 0002, 0003, 0005, 0006, 0007を適用）が必要。
//
// tasks.md Implementation Notes（2.3で判明した教訓）に従い、環境変数には
// ハードコードされたfallback値を持たせず、未設定ならbeforeAll等より前に
// 明確なエラーで失敗させる（fail-fast）。
//
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.7, 1.9, 1.12, 2.1, 2.2, 2.3, 7.2
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../supabase/database.types";
import { createCustomerOrderingGateway } from "./customerOrderingGateway";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. customerOrderingGateway.integration.test.ts requires it ` +
        "(see .env.local; vitest.config.mts loads it into process.env). " +
        "Run `npm run db:start` first if the local Supabase stack is not running.",
    );
  }
  return value;
}

const connectionString = requireEnv("SUPABASE_DB_URL");
const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supabaseAnonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

const pool = new Pool({ connectionString });

function newGateway() {
  // 匿名サインイン（signInAnonymously）を一切呼ばない、真のanonロール経路
  // （getOrderingContext.integration.test.ts等と同じ前提。要件8.1）。
  const client = createClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return createCustomerOrderingGateway(client);
}

describe("customerOrderingGateway（結合テスト、実RPCへの疎通確認）", () => {
  const storeId = randomUUID();
  const tableActiveId = randomUUID();
  const tableClosedId = randomUUID();
  const tableCallDedupId = randomUUID();

  const activeSessionId = randomUUID();
  const closedSessionId = randomUUID();
  const callDedupSessionId = randomUUID();

  const menuItemId = randomUUID();
  const soldOutMenuItemId = randomUUID();

  // このdescribeブロック配下で作られたorders行のidを収集し、afterAllで
  // order_items -> ordersの順に確実にクリーンアップする（FK制約があるため。
  // submitOrder.integration.test.tsと同じパターン）。
  const createdOrderIds: string[] = [];

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "customerOrderingGatewayラッパー結合テスト用店舗",
    ]);

    await pool.query(
      `insert into tables (id, store_id, label)
       values ($1, $2, $3), ($4, $2, $5), ($6, $2, $7)`,
      [
        tableActiveId,
        storeId,
        "ラッパー検証・アクティブ卓",
        tableClosedId,
        "ラッパー検証・終了済み卓",
        tableCallDedupId,
        "ラッパー検証・呼び出し重複卓",
      ],
    );

    await pool.query(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values
         ($1, $2, 'Wrapper Item', 600, false, 'food', '[]'::jsonb),
         ($3, $2, 'Wrapper Sold Out Item', 900, true, 'ippin', '[]'::jsonb)`,
      [menuItemId, storeId, soldOutMenuItemId],
    );

    await pool.query(
      `insert into table_sessions (id, table_id, status, party_size)
       values
         ($1, $2, 'active', 2),
         ($3, $4, 'closed', 3),
         ($5, $6, 'active', 2)`,
      [
        activeSessionId,
        tableActiveId,
        closedSessionId,
        tableClosedId,
        callDedupSessionId,
        tableCallDedupId,
      ],
    );
  });

  afterAll(async () => {
    const sessionIds = [activeSessionId, closedSessionId, callDedupSessionId];

    if (createdOrderIds.length > 0) {
      await pool.query("delete from order_items where order_id = any($1)", [
        createdOrderIds,
      ]);
      await pool.query("delete from orders where id = any($1)", [
        createdOrderIds,
      ]);
    }
    // 念のため、テスト対象セッションに残った可能性のあるorders/order_items/
    // call_requestsも一掃してからtable_sessions/menu_items/tables/storesを
    // 削除する（FK制約違反を避けるため子から親の順で削除する）。
    await pool.query(
      `delete from order_items
       where order_id in (select id from orders where session_id = any($1))`,
      [sessionIds],
    );
    await pool.query("delete from orders where session_id = any($1)", [
      sessionIds,
    ]);
    await pool.query("delete from call_requests where session_id = any($1)", [
      sessionIds,
    ]);
    await pool.query("delete from table_sessions where id = any($1)", [
      sessionIds,
    ]);
    await pool.query("delete from menu_items where store_id = $1", [storeId]);
    await pool.query("delete from tables where store_id = $1", [storeId]);
    await pool.query("delete from stores where id = $1", [storeId]);
    await pool.end();
  });

  it("getOrderingContext: 実RPCの応答をOrderingContext型として正しく整形する（幸せな経路）", async () => {
    const gateway = newGateway();
    const result = await gateway.getOrderingContext({
      tableId: tableActiveId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.table).toEqual({
      id: tableActiveId,
      label: "ラッパー検証・アクティブ卓",
    });
    expect(result.value.activeSession).toEqual({ id: activeSessionId });
    expect(result.value.confirmedTotal).toBe(0);
    const item = result.value.menu.find((m) => m.id === menuItemId);
    expect(item).toMatchObject({
      id: menuItemId,
      name: "Wrapper Item",
      price: 600,
      soldOut: false,
      imageUrl: null,
      options: [],
    });
  });

  it("getOrderingContext: 存在しない卓IDはTABLE_NOT_FOUNDエラーになる", async () => {
    const gateway = newGateway();
    const result = await gateway.getOrderingContext({
      tableId: randomUUID(),
    });

    expect(result).toEqual({ ok: false, error: { code: "TABLE_NOT_FOUND" } });
  });

  it("submitOrder: 実RPCの応答をSubmitOrderResult型として正しく整形する（幸せな経路）", async () => {
    const gateway = newGateway();
    const result = await gateway.submitOrder({
      sessionId: activeSessionId,
      idempotencyKey: `wrapper-happy-${randomUUID()}`,
      items: [
        { menuItemId, quantity: 2, optionSelections: {}, note: null },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deduplicated).toBe(false);
    createdOrderIds.push(result.value.order.id);
    expect(result.value.order.items).toHaveLength(1);
    expect(result.value.order.items[0]).toMatchObject({
      menuItemId,
      name: "Wrapper Item",
      unitPrice: 600,
      quantity: 2,
      status: "received",
    });
    expect(typeof result.value.order.id).toBe("string");
    expect(typeof result.value.order.createdAt).toBe("string");
  });

  it("submitOrder: 終了済みセッションはSESSION_NOT_ACTIVEエラーになる", async () => {
    const gateway = newGateway();
    const result = await gateway.submitOrder({
      sessionId: closedSessionId,
      idempotencyKey: `wrapper-closed-${randomUUID()}`,
      items: [{ menuItemId, quantity: 1, optionSelections: {}, note: null }],
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "SESSION_NOT_ACTIVE" },
    });
  });

  it("submitOrder: 売り切れ品目を含む送信はITEM_SOLD_OUT（menuItemId付き）エラーになる（TSマッピングとRPCのDETAIL往復を実機で確認）", async () => {
    const gateway = newGateway();
    const result = await gateway.submitOrder({
      sessionId: activeSessionId,
      idempotencyKey: `wrapper-sold-out-${randomUUID()}`,
      items: [
        {
          menuItemId: soldOutMenuItemId,
          quantity: 1,
          optionSelections: {},
          note: null,
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "ITEM_SOLD_OUT", menuItemId: soldOutMenuItemId },
    });
  });

  it("createCallRequest: 実RPCの応答をCallRequest型として正しく整形する（幸せな経路）", async () => {
    const gateway = newGateway();
    const result = await gateway.createCallRequest({
      sessionId: activeSessionId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe(activeSessionId);
    expect(result.value.status).toBe("open");
    expect(typeof result.value.id).toBe("string");
    expect(typeof result.value.createdAt).toBe("string");
  });

  it("createCallRequest: 未対応の呼び出しが既にある場合はCALL_ALREADY_OPEN（design.md通り追加ペイロードなし）エラーになる", async () => {
    const gateway = newGateway();

    const first = await gateway.createCallRequest({
      sessionId: callDedupSessionId,
    });
    expect(first.ok).toBe(true);

    const second = await gateway.createCallRequest({
      sessionId: callDedupSessionId,
    });
    expect(second).toEqual({
      ok: false,
      error: { code: "CALL_ALREADY_OPEN" },
    });
  });
});
