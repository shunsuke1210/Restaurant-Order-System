// @vitest-environment node
//
// 0003_rpc_customer_gateway.sql に追記されたsubmit_order RPCを、ローカル
// Supabaseスタックに対する実際のanonキー・無サインインのsupabase-js呼び出しで
// 検証する結合テスト。getOrderingContext.integration.test.tsと同じ構成:
// 事前に`npm run db:start`と`npm run db:reset`（0001, 0002, 0003, 0005, 0006,
// 0007を適用）が必要。
//
// 客側の経路は要件8.1「客に対し認証情報の入力を要求しない」に基づき、
// DeviceIdentityProviderの匿名サインイン（厨房/レジタブレット専用）を一切
// 経由しない、真の`anon`ロール呼び出しである。そのため本テストも
// signInAnonymously()を一度も呼ばず、生成直後のanonキークライアントで直接
// .rpc('submit_order', ...)を呼び出す。
//
// tasks.md Implementation Notes（2.3で判明した教訓）に従い、環境変数には
// ハードコードされたfallback値を持たせず、未設定ならbeforeAll等より前に
// 明確なエラーで失敗させる（fail-fast）。ローカル開発用の既知の値は
// .env.local側に一元化し（唯一の情報源）、テストコード側では複製しない。
//
// Requirements: 1.7, 1.8, 1.9, 1.10, 7.2
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. submit_order.integration.test.ts requires it ` +
        "(see .env.local; vitest.config.mts loads it into process.env). " +
        "Run `npm run db:start` first if the local Supabase stack is not running.",
    );
  }
  return value;
}

const connectionString = requireEnv("SUPABASE_DB_URL");
const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supabaseAnonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

// 0003_rpc_customer_gateway.sqlがsubmit_orderの検証失敗時に送出するカスタム
// SQLSTATE（本タスク3.2で新規に割り当て。設計判断5参照）。
const SESSION_NOT_ACTIVE = "P0409";
const ITEM_SOLD_OUT = "P0410";
const EMPTY_ORDER = "P0400";

const pool = new Pool({ connectionString });

function newAnonClient() {
  // 匿名サインイン（signInAnonymously）を一切呼ばない。生成直後のクライアントは
  // 完全な無認証状態のPostgREST anonロールとしてリクエストする（要件8.1）。
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function countOrderItemsForOrder(orderId: string): Promise<number> {
  const result = await pool.query(
    "select count(*)::int as count from order_items where order_id = $1",
    [orderId],
  );
  return result.rows[0].count as number;
}

async function countOrdersForSession(sessionId: string): Promise<number> {
  const result = await pool.query(
    "select count(*)::int as count from orders where session_id = $1",
    [sessionId],
  );
  return result.rows[0].count as number;
}

describe("0003_rpc_customer_gateway.sql: submit_order RPC（結合テスト）", () => {
  const storeId = randomUUID();
  const tableActiveId = randomUUID();
  const tableClosedId = randomUUID();
  const tableDedupId = randomUUID();

  const activeSessionId = randomUUID();
  const closedSessionId = randomUUID();
  const dedupSessionId = randomUUID();

  const menuItemAId = randomUUID();
  const menuItemBId = randomUUID();
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

  // このdescribeブロック配下で挿入したorders行のidを収集し、afterAllで
  // order_items -> ordersの順に確実にクリーンアップする（FK制約があるため）。
  const createdOrderIds: string[] = [];

  async function submitOrder(
    client: ReturnType<typeof newAnonClient>,
    args: {
      sessionId: string;
      idempotencyKey: string;
      items: ReadonlyArray<{
        menuItemId: string;
        quantity: number;
        optionSelections?: Record<string, unknown>;
        note?: string | null;
      }>;
    },
  ) {
    const items = args.items.map((item) => ({
      menuItemId: item.menuItemId,
      quantity: item.quantity,
      optionSelections: item.optionSelections ?? {},
      note: item.note ?? null,
    }));

    return client.rpc("submit_order", {
      p_session_id: args.sessionId,
      p_idempotency_key: args.idempotencyKey,
      p_items: items,
    });
  }

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "submit_order結合テスト用店舗",
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
        tableDedupId,
        "重複送信検証卓",
      ],
    );

    await pool.query(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values
         ($1, $2, 'Item A', 500, false, 'food', '[]'::jsonb),
         ($3, $2, 'Item B', 300, false, 'drink', '[]'::jsonb),
         ($4, $2, 'Sold Out Item', 800, true, 'ippin', '[]'::jsonb),
         ($5, $2, 'Item With Options', 400, false, 'food', $6::jsonb)`,
      [
        menuItemAId,
        storeId,
        menuItemBId,
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
         ($5, $6, 'active', 4)`,
      [
        activeSessionId,
        tableActiveId,
        closedSessionId,
        tableClosedId,
        dedupSessionId,
        tableDedupId,
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
    // 念のため、テスト対象セッションに残った可能性のあるorders/order_itemsも
    // セッションID経由で一掃してからtable_sessions/menu_items/tables/storesを
    // 削除する（FK制約違反を避けるため子から親の順で削除する）。
    await pool.query(
      `delete from order_items
       where order_id in (select id from orders where session_id = any($1))`,
      [[activeSessionId, closedSessionId, dedupSessionId]],
    );
    await pool.query("delete from orders where session_id = any($1)", [
      [activeSessionId, closedSessionId, dedupSessionId],
    ]);
    await pool.query("delete from table_sessions where id = any($1)", [
      [activeSessionId, closedSessionId, dedupSessionId],
    ]);
    await pool.query("delete from menu_items where store_id = $1", [
      storeId,
    ]);
    await pool.query("delete from tables where store_id = $1", [storeId]);
    await pool.query("delete from stores where id = $1", [storeId]);
    await pool.end();
  });

  it("2つの異なる品目を送信すると、両方がorder_itemsに登録され、スナップショット値とstatus: 'received'が正しく、deduplicated: falseが返る（観測可能な完了条件, 要件1.7, 1.10）", async () => {
    const supabase = newAnonClient();
    const idempotencyKey = `happy-path-${randomUUID()}`;

    const { data, error } = await submitOrder(supabase, {
      sessionId: activeSessionId,
      idempotencyKey,
      items: [
        { menuItemId: menuItemAId, quantity: 2 },
        { menuItemId: menuItemBId, quantity: 1, note: "氷なし" },
      ],
    });

    expect(error).toBeNull();
    expect(data.deduplicated).toBe(false);
    expect(data.order.id).toEqual(expect.any(String));
    expect(data.order.createdAt).toEqual(expect.any(String));
    expect(data.order.items).toHaveLength(2);

    createdOrderIds.push(data.order.id);

    const itemA = data.order.items.find(
      (item: { menuItemId: string }) => item.menuItemId === menuItemAId,
    );
    const itemB = data.order.items.find(
      (item: { menuItemId: string }) => item.menuItemId === menuItemBId,
    );

    expect(itemA).toMatchObject({
      name: "Item A",
      unitPrice: 500,
      quantity: 2,
      status: "received",
      optionsSummary: null,
    });
    expect(itemA.id).toEqual(expect.any(String));
    expect(itemA.statusUpdatedAt).toEqual(expect.any(String));

    expect(itemB).toMatchObject({
      name: "Item B",
      unitPrice: 300,
      quantity: 1,
      status: "received",
    });

    // DBへ実際に2行登録されていることを直接クエリで確認する。
    const dbCount = await countOrderItemsForOrder(data.order.id);
    expect(dbCount).toBe(2);

    const dbRows = await pool.query(
      "select menu_item_id, name_snapshot, unit_price_snapshot, quantity, status, note from order_items where order_id = $1 order by name_snapshot",
      [data.order.id],
    );
    expect(dbRows.rows).toEqual([
      expect.objectContaining({
        menu_item_id: menuItemAId,
        name_snapshot: "Item A",
        unit_price_snapshot: "500",
        quantity: 2,
        status: "received",
        note: null,
      }),
      expect.objectContaining({
        menu_item_id: menuItemBId,
        name_snapshot: "Item B",
        unit_price_snapshot: "300",
        quantity: 1,
        status: "received",
        note: "氷なし",
      }),
    ]);
  });

  it("同一menuItemIdを異なるoptionSelectionsで2回送信すると、統合せず別々のorder_items行として登録される（要件1.8）", async () => {
    const supabase = newAnonClient();
    const idempotencyKey = `different-options-${randomUUID()}`;

    const { data, error } = await submitOrder(supabase, {
      sessionId: activeSessionId,
      idempotencyKey,
      items: [
        {
          menuItemId: menuItemWithOptionsId,
          quantity: 1,
          optionSelections: { spice: "普通" },
        },
        {
          menuItemId: menuItemWithOptionsId,
          quantity: 1,
          optionSelections: { spice: "辛口" },
        },
      ],
    });

    expect(error).toBeNull();
    expect(data.order.items).toHaveLength(2);
    createdOrderIds.push(data.order.id);

    const dbCount = await countOrderItemsForOrder(data.order.id);
    expect(dbCount).toBe(2);

    const dbRows = await pool.query(
      "select options_selected, options_summary from order_items where order_id = $1 order by options_summary",
      [data.order.id],
    );
    expect(dbRows.rows).toHaveLength(2);
    const summaries = dbRows.rows.map((row) => row.options_summary).sort();
    expect(summaries).toEqual(["辛さ: 普通", "辛さ: 辛口"]);
  });

  it("同一sessionId・idempotencyKeyで2回送信すると、2回目はdeduplicated: trueを返し、order_itemsは重複挿入されない（DBの行数を直接確認、観測可能な完了条件, 要件1.7）", async () => {
    const supabase = newAnonClient();
    const idempotencyKey = `dedup-${randomUUID()}`;

    const first = await submitOrder(supabase, {
      sessionId: dedupSessionId,
      idempotencyKey,
      items: [{ menuItemId: menuItemAId, quantity: 3 }],
    });
    expect(first.error).toBeNull();
    expect(first.data.deduplicated).toBe(false);
    const orderId = first.data.order.id as string;
    createdOrderIds.push(orderId);

    const second = await submitOrder(supabase, {
      sessionId: dedupSessionId,
      idempotencyKey,
      items: [{ menuItemId: menuItemAId, quantity: 3 }],
    });
    expect(second.error).toBeNull();
    expect(second.data.deduplicated).toBe(true);
    expect(second.data.order.id).toBe(orderId);
    expect(second.data.order.items).toHaveLength(1);

    // RPCの応答（deduplicated: true）を信頼するだけでなく、DBへ実際に
    // orders/order_itemsが重複挿入されていないことを直接クエリで確認する。
    const orderCount = await countOrdersForSession(dedupSessionId);
    expect(orderCount).toBe(1);

    const itemCount = await countOrderItemsForOrder(orderId);
    expect(itemCount).toBe(1);
  });

  it("終了済み(closed)セッションへの送信はSESSION_NOT_ACTIVEで拒否され、何も挿入されない（要件1.9）", async () => {
    const supabase = newAnonClient();
    const idempotencyKey = `closed-session-${randomUUID()}`;

    const { data, error } = await submitOrder(supabase, {
      sessionId: closedSessionId,
      idempotencyKey,
      items: [{ menuItemId: menuItemAId, quantity: 1 }],
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(SESSION_NOT_ACTIVE);

    const orderCount = await countOrdersForSession(closedSessionId);
    expect(orderCount).toBe(0);
  });

  it("売り切れ品目を含む送信はITEM_SOLD_OUT（該当menuItemId付き）で拒否され、何も挿入されない（要件7.2）", async () => {
    const supabase = newAnonClient();
    const idempotencyKey = `sold-out-${randomUUID()}`;

    const { data, error } = await submitOrder(supabase, {
      sessionId: activeSessionId,
      idempotencyKey,
      items: [
        { menuItemId: menuItemAId, quantity: 1 },
        { menuItemId: menuItemSoldOutId, quantity: 1 },
      ],
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(ITEM_SOLD_OUT);
    expect(error?.details).toBe(menuItemSoldOutId);

    // 全体ロールバック方針（設計判断4）: 売り切れでないItem Aも含め、
    // このidempotencyKeyに対応するorderが一切作られていないことを確認する。
    const result = await pool.query(
      "select count(*)::int as count from orders where session_id = $1 and idempotency_key = $2",
      [activeSessionId, idempotencyKey],
    );
    expect(result.rows[0].count).toBe(0);
  });

  it("optionSelectionsで未指定のキーには、品目のoptions定義のdefault値が補われて保存される", async () => {
    const supabase = newAnonClient();
    const idempotencyKey = `defaults-${randomUUID()}`;

    const { data, error } = await submitOrder(supabase, {
      sessionId: activeSessionId,
      idempotencyKey,
      items: [
        {
          menuItemId: menuItemWithOptionsId,
          quantity: 1,
          optionSelections: {},
        },
      ],
    });

    expect(error).toBeNull();
    createdOrderIds.push(data.order.id);

    const dbRow = await pool.query(
      "select options_selected from order_items where order_id = $1",
      [data.order.id],
    );
    expect(dbRow.rows[0].options_selected).toEqual({
      spice: "普通",
      wasabi: false,
    });
  });

  it("optionSelectionsに品目のoptions定義にない未知のキーが含まれる場合、エラーにならず静かに除外され保存もされない", async () => {
    const supabase = newAnonClient();
    const idempotencyKey = `unknown-key-${randomUUID()}`;

    const { data, error } = await submitOrder(supabase, {
      sessionId: activeSessionId,
      idempotencyKey,
      items: [
        {
          menuItemId: menuItemWithOptionsId,
          quantity: 1,
          optionSelections: { spice: "辛口", bogusKey: "should-be-dropped" },
        },
      ],
    });

    expect(error).toBeNull();
    createdOrderIds.push(data.order.id);

    const dbRow = await pool.query(
      "select options_selected from order_items where order_id = $1",
      [data.order.id],
    );
    expect(dbRow.rows[0].options_selected).toEqual({
      spice: "辛口",
      wasabi: false,
    });
    expect(dbRow.rows[0].options_selected).not.toHaveProperty("bogusKey");
  });

  it("空のitems配列で送信するとEMPTY_ORDERが返る", async () => {
    const supabase = newAnonClient();
    const idempotencyKey = `empty-${randomUUID()}`;

    const { data, error } = await submitOrder(supabase, {
      sessionId: activeSessionId,
      idempotencyKey,
      items: [],
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(EMPTY_ORDER);
  });
});
