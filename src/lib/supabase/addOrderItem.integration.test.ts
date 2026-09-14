// @vitest-environment node
//
// 0004_rpc_staff_gateway.sql に追記されたadd_order_item RPCを、ローカル
// Supabaseスタックに対する実際のデバイスセッション（device_role='register'の
// authenticatedクライアント）で検証する結合テスト。updatePartySize.
// integration.test.tsと同じ構成: 事前に`npm run db:start`と`npm run db:reset`
// （0001〜0007を適用）が必要。device_role claim付きクライアントの用意手順
// （匿名サインイン→devices行追加→refreshSession）も同一。
//
// add_order_itemはsubmit_order（0003_rpc_customer_gateway.sql）と同等の検証
// （セッション有効性・売り切れ再検証・optionSelectionsの整合性チェック/
// デフォルト値補完）を単一品目に対して適用するため、submitOrder.
// integration.test.tsのoptions関連テストケースを流用・単一品目版に翻案する。
//
// Requirements: 5.5
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. addOrderItem.integration.test.ts requires it ` +
        "(see .env.local; vitest.config.mts loads it into process.env). " +
        "Run `npm run db:start` first if the local Supabase stack is not running.",
    );
  }
  return value;
}

const connectionString = requireEnv("SUPABASE_DB_URL");
const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supabaseAnonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

// 0004_rpc_staff_gateway.sqlが送出するカスタムSQLSTATE。
const SESSION_NOT_ACTIVE = "P0409"; // submit_order（0003）と同一の意味で再利用
const ITEM_SOLD_OUT = "P0410"; // submit_order（0003）と同一の意味で再利用
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

async function countOrderItemsForSession(sessionId: string): Promise<number> {
  const result = await pool.query(
    `select count(*)::int as count
     from order_items oi
     join orders o on o.id = oi.order_id
     where o.session_id = $1`,
    [sessionId],
  );
  return result.rows[0].count as number;
}

describe("0004_rpc_staff_gateway.sql: add_order_item RPC（結合テスト）", () => {
  const storeId = randomUUID();
  const tableActiveId = randomUUID();
  const tableClosedId = randomUUID();
  const tableRoleCheckId = randomUUID();

  const activeSessionId = randomUUID();
  const closedSessionId = randomUUID();
  const roleCheckSessionId = randomUUID();

  const menuItemAId = randomUUID();
  const menuItemSoldOutId = randomUUID();
  const menuItemWithOptionsId = randomUUID();

  const menuItemWithOptionsDef = [
    {
      id: "spice",
      type: "choice",
      label: "辛さ",
      choices: ["普通", "辛口"],
      default: "普通",
    },
    {
      id: "wasabi",
      type: "toggle",
      label: "わさび抜き",
      default: false,
    },
  ];

  const createdAuthUserIds: string[] = [];

  async function addOrderItem(
    client: ReturnType<typeof newAnonClient>,
    args: {
      sessionId: string;
      menuItemId: string;
      quantity: number;
      optionSelections?: Record<string, unknown>;
    },
  ) {
    return client.rpc("add_order_item", {
      p_session_id: args.sessionId,
      p_menu_item_id: args.menuItemId,
      p_quantity: args.quantity,
      p_option_selections: args.optionSelections ?? {},
    });
  }

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "add_order_item結合テスト用店舗",
    ]);

    await pool.query(
      `insert into tables (id, store_id, label)
       values ($1, $2, $3), ($4, $2, $5), ($6, $2, $7)`,
      [
        tableActiveId,
        storeId,
        "アクティブ卓",
        tableClosedId,
        "終了済みセッション卓",
        tableRoleCheckId,
        "権限確認用卓",
      ],
    );

    await pool.query(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values
         ($1, $2, 'Item A', 500, false, 'food', '[]'::jsonb),
         ($3, $2, 'Sold Out Item', 800, true, 'ippin', '[]'::jsonb),
         ($4, $2, 'Item With Options', 400, false, 'food', $5::jsonb)`,
      [
        menuItemAId,
        storeId,
        menuItemSoldOutId,
        menuItemWithOptionsId,
        JSON.stringify(menuItemWithOptionsDef),
      ],
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
    await pool.query(
      `delete from order_items
       where order_id in (select id from orders where session_id = any($1))`,
      [[activeSessionId, closedSessionId, roleCheckSessionId]],
    );
    await pool.query("delete from orders where session_id = any($1)", [
      [activeSessionId, closedSessionId, roleCheckSessionId],
    ]);
    await pool.query("delete from table_sessions where table_id in (select id from tables where store_id = $1)", [
      storeId,
    ]);
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

  it("アクティブなセッションへの品目追加は成功し、スナップショット・status:'received'が正しくDBへ登録される（観測可能な完了条件, 要件5.5）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const before = await countOrderItemsForSession(activeSessionId);

    const { data, error } = await addOrderItem(client, {
      sessionId: activeSessionId,
      menuItemId: menuItemAId,
      quantity: 3,
    });

    expect(error).toBeNull();
    expect(data).toMatchObject({
      menuItemId: menuItemAId,
      name: "Item A",
      unitPrice: 500,
      quantity: 3,
      status: "received",
      optionsSummary: null,
    });
    expect(data.id).toEqual(expect.any(String));
    expect(data.statusUpdatedAt).toEqual(expect.any(String));

    const after = await countOrderItemsForSession(activeSessionId);
    expect(after).toBe(before + 1);

    const dbRow = await pool.query(
      "select menu_item_id, name_snapshot, unit_price_snapshot, quantity, status from order_items where id = $1",
      [data.id],
    );
    expect(dbRow.rows[0]).toMatchObject({
      menu_item_id: menuItemAId,
      name_snapshot: "Item A",
      unit_price_snapshot: "500",
      quantity: 3,
      status: "received",
    });
  });

  it("終了済み(closed)セッションへの追加はSESSION_NOT_ACTIVEで拒否され、何も挿入されない（要件5.5）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const before = await countOrderItemsForSession(closedSessionId);

    const { data, error } = await addOrderItem(client, {
      sessionId: closedSessionId,
      menuItemId: menuItemAId,
      quantity: 1,
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(SESSION_NOT_ACTIVE);

    const after = await countOrderItemsForSession(closedSessionId);
    expect(after).toBe(before);
  });

  it("存在しないセッションidに対する追加はSESSION_NOT_ACTIVEで拒否される", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await addOrderItem(client, {
      sessionId: randomUUID(),
      menuItemId: menuItemAId,
      quantity: 1,
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(SESSION_NOT_ACTIVE);
  });

  it("売り切れ品目の追加はITEM_SOLD_OUT（該当menuItemId付き）で拒否され、何も挿入されない（要件5.5）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const before = await countOrderItemsForSession(activeSessionId);

    const { data, error } = await addOrderItem(client, {
      sessionId: activeSessionId,
      menuItemId: menuItemSoldOutId,
      quantity: 1,
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(ITEM_SOLD_OUT);
    expect(error?.details).toBe(menuItemSoldOutId);

    const after = await countOrderItemsForSession(activeSessionId);
    expect(after).toBe(before);
  });

  it("optionSelectionsで未指定のキーには、品目のoptions定義のdefault値が補われて保存される（submit_orderと同一のロジック）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await addOrderItem(client, {
      sessionId: activeSessionId,
      menuItemId: menuItemWithOptionsId,
      quantity: 1,
      optionSelections: {},
    });

    expect(error).toBeNull();

    const dbRow = await pool.query(
      "select options_selected, options_summary from order_items where id = $1",
      [data.id],
    );
    expect(dbRow.rows[0].options_selected).toEqual({
      spice: "普通",
      wasabi: false,
    });
    // choiceタイプはデフォルト値で補われた場合でも要約に含まれる（submit_order
    // と同一のロジック。toggleはデフォルトfalseなら要約に含まれないため、
    // ここではspiceのデフォルト値のみが要約される）。
    expect(dbRow.rows[0].options_summary).toBe("辛さ: 普通");
  });

  it("optionSelectionsに品目のoptions定義にない未知のキーが含まれる場合、エラーにならず静かに除外され保存もされない（submit_orderと同一のロジック）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await addOrderItem(client, {
      sessionId: activeSessionId,
      menuItemId: menuItemWithOptionsId,
      quantity: 1,
      optionSelections: { spice: "辛口", bogusKey: "should-be-dropped" },
    });

    expect(error).toBeNull();

    const dbRow = await pool.query(
      "select options_selected, options_summary from order_items where id = $1",
      [data.id],
    );
    expect(dbRow.rows[0].options_selected).toEqual({
      spice: "辛口",
      wasabi: false,
    });
    expect(dbRow.rows[0].options_selected).not.toHaveProperty("bogusKey");
    expect(dbRow.rows[0].options_summary).toBe("辛さ: 辛口");
  });

  it("device_role='kitchen'のデバイスから呼び出すと拒否される（register限定操作であることの確認。design.md要件5.5がレジスタッフの操作と明記していることに基づく判断）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "kitchen",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const before = await countOrderItemsForSession(roleCheckSessionId);

    const { data, error } = await addOrderItem(client, {
      sessionId: roleCheckSessionId,
      menuItemId: menuItemAId,
      quantity: 1,
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(FORBIDDEN_DEVICE_ROLE);

    const after = await countOrderItemsForSession(roleCheckSessionId);
    expect(after).toBe(before);
  });
});
