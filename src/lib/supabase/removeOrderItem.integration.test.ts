// @vitest-environment node
//
// 0004_rpc_staff_gateway.sql に追記されたremove_order_item RPCを、ローカル
// Supabaseスタックに対する実際のデバイスセッション（device_role='register'の
// authenticatedクライアント）で検証する結合テスト。updatePartySize.
// integration.test.tsと同じ構成: 事前に`npm run db:start`と`npm run db:reset`
// （0001〜0007を適用）が必要。
//
// design.md StaffOperationsGateway Responsibilities & Constraints
// 「removeOrderItemは指定された注文明細を削除する。会計後の履歴改ざんを防ぐため、
// 対象セッションが既にclosedの場合はORDER_ITEM_NOT_FOUNDとして拒否する」の通り、
// (a) 注文明細idが実在しない場合 と (b) 実在するが所属セッションが既にclosedの場合
// の両方が、区別なく同一のORDER_ITEM_NOT_FOUNDへ収束することをタスクの観測可能な
// 完了条件として検証する。
//
// Requirements: 5.6
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. removeOrderItem.integration.test.ts requires it ` +
        "(see .env.local; vitest.config.mts loads it into process.env). " +
        "Run `npm run db:start` first if the local Supabase stack is not running.",
    );
  }
  return value;
}

const connectionString = requireEnv("SUPABASE_DB_URL");
const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supabaseAnonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

// 0004_rpc_staff_gateway.sqlが送出するカスタムSQLSTATE（本タスク4.2で新規割当）。
const ORDER_ITEM_NOT_FOUND = "P0444";
// 0006_assert_device_role.sqlが送出するカスタムSQLSTATE（FORBIDDEN相当）。
const FORBIDDEN_DEVICE_ROLE = "P0403";

const pool = new Pool({ connectionString });

function newAnonClient() {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function createDeviceClient(
  role: "kitchen" | "register",
  storeId: string,
): Promise<{ client: SupabaseClient; authUserId: string }> {
  const client = newAnonClient();
  const signInResult = await client.auth.signInAnonymously();
  expect(signInResult.error).toBeNull();
  const authUserId = signInResult.data.user?.id;
  const refreshToken = signInResult.data.session?.refresh_token;
  expect(authUserId).toBeDefined();
  expect(refreshToken).toBeDefined();

  await pool.query(
    "insert into devices (auth_user_id, store_id, role) values ($1, $2, $3)",
    [authUserId, storeId, role],
  );

  const refreshResult = await client.auth.refreshSession({
    refresh_token: refreshToken as string,
  });
  expect(refreshResult.error).toBeNull();

  return { client, authUserId: authUserId as string };
}

async function orderItemExists(orderItemId: string): Promise<boolean> {
  const result = await pool.query(
    "select 1 from order_items where id = $1",
    [orderItemId],
  );
  return (result.rowCount ?? 0) > 0;
}

describe("0004_rpc_staff_gateway.sql: remove_order_item RPC（結合テスト）", () => {
  const storeId = randomUUID();
  const tableActiveId = randomUUID();
  const tableClosedId = randomUUID();
  const tableRoleCheckId = randomUUID();

  const activeSessionId = randomUUID();
  const closedSessionId = randomUUID();
  const roleCheckSessionId = randomUUID();

  const menuItemAId = randomUUID();

  const createdAuthUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  async function removeOrderItem(
    client: ReturnType<typeof newAnonClient>,
    orderItemId: string,
  ) {
    return client.rpc("remove_order_item", { p_order_item_id: orderItemId });
  }

  async function insertOrderWithItem(sessionId: string): Promise<{
    orderId: string;
    orderItemId: string;
  }> {
    const orderId = randomUUID();
    await pool.query(
      "insert into orders (id, session_id, idempotency_key) values ($1, $2, $3)",
      [orderId, sessionId, `test-seed-${randomUUID()}`],
    );
    createdOrderIds.push(orderId);

    const orderItemId = randomUUID();
    await pool.query(
      `insert into order_items
         (id, order_id, menu_item_id, name_snapshot, unit_price_snapshot, quantity, status)
       values ($1, $2, $3, 'Item A', 500, 1, 'received')`,
      [orderItemId, orderId, menuItemAId],
    );

    return { orderId, orderItemId };
  }

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "remove_order_item結合テスト用店舗",
    ]);

    await pool.query(
      `insert into tables (id, store_id, label)
       values ($1, $2, $3), ($4, $2, $5), ($6, $2, $7)`,
      [
        tableActiveId,
        storeId,
        "アクティブ卓",
        tableClosedId,
        "会計済み卓",
        tableRoleCheckId,
        "権限確認用卓",
      ],
    );

    await pool.query(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values ($1, $2, 'Item A', 500, false, 'food', '[]'::jsonb)`,
      [menuItemAId, storeId],
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
        roleCheckSessionId,
        tableRoleCheckId,
      ],
    );
  });

  afterAll(async () => {
    if (createdOrderIds.length > 0) {
      await pool.query("delete from order_items where order_id = any($1)", [
        createdOrderIds,
      ]);
      await pool.query("delete from orders where id = any($1)", [
        createdOrderIds,
      ]);
    }
    await pool.query(
      "delete from table_sessions where table_id in (select id from tables where store_id = $1)",
      [storeId],
    );
    await pool.query("delete from menu_items where store_id = $1", [
      storeId,
    ]);
    await pool.query("delete from devices where store_id = $1", [storeId]);
    await pool.query("delete from tables where store_id = $1", [storeId]);
    await pool.query("delete from stores where id = $1", [storeId]);
    for (const authUserId of createdAuthUserIds) {
      try {
        await pool.query("delete from auth.users where id = $1", [
          authUserId,
        ]);
      } catch {
        // ベストエフォート。テストの合否には影響しない。
      }
    }
    await pool.end();
  });

  it("アクティブなセッションに属する注文明細の削除は成功し、行が削除される", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { orderItemId } = await insertOrderWithItem(activeSessionId);
    expect(await orderItemExists(orderItemId)).toBe(true);

    const { data, error } = await removeOrderItem(client, orderItemId);

    expect(error).toBeNull();
    expect(data).toEqual({ orderItemId });

    expect(await orderItemExists(orderItemId)).toBe(false);
  });

  it("既に会計済み（closed）のセッションに属する注文明細の削除はORDER_ITEM_NOT_FOUNDで拒否され、行は削除されない（観測可能な完了条件, 要件5.6）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { orderItemId } = await insertOrderWithItem(closedSessionId);
    expect(await orderItemExists(orderItemId)).toBe(true);

    const { data, error } = await removeOrderItem(client, orderItemId);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(ORDER_ITEM_NOT_FOUND);

    // 削除されていないことをDBへ直接問い合わせて確認する。
    expect(await orderItemExists(orderItemId)).toBe(true);
  });

  it("実在しないorderItemIdに対する削除もORDER_ITEM_NOT_FOUND（closedセッションのケースと同一コードに収束することの確認）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const nonExistentId = randomUUID();
    expect(await orderItemExists(nonExistentId)).toBe(false);

    const { data, error } = await removeOrderItem(client, nonExistentId);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(ORDER_ITEM_NOT_FOUND);
  });

  it("device_role='kitchen'のデバイスから呼び出すと拒否される（register限定操作であることの確認）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "kitchen",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { orderItemId } = await insertOrderWithItem(roleCheckSessionId);

    const { data, error } = await removeOrderItem(client, orderItemId);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(FORBIDDEN_DEVICE_ROLE);

    expect(await orderItemExists(orderItemId)).toBe(true);
  });
});
