// @vitest-environment node
//
// 0003_rpc_customer_gateway.sql のget_ordering_context RPCを、ローカル
// Supabaseスタックに対する実際のanonキー・無サインインのsupabase-js呼び出しで
// 検証する結合テスト。customAccessTokenHook.integration.test.ts /
// provisionDevice.integration.test.ts と同じ構成: 事前に`npm run db:start`と
// `npm run db:reset`（0001, 0002, 0003, 0005, 0006, 0007を適用）が必要。
//
// 客側の経路は要件8.1「客に対し認証情報の入力を要求しない」に基づき、
// DeviceIdentityProviderの匿名サインイン（厨房/レジタブレット専用）を一切
// 経由しない、真の`anon`ロール呼び出しである。そのため本テストは
// signInAnonymously()を一度も呼ばず、生成直後のanonキークライアントで
// 直接.rpc('get_ordering_context', ...)を呼び出す（design.md Architecture
// 「NextApp -->|anon key| CustomerGateway」を実機で裏付ける）。
//
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.12, 7.2
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";

// 0003_rpc_customer_gateway.sqlが卓未検出時に送出するカスタムSQLSTATE。
const TABLE_NOT_FOUND = "P0404";

const pool = new Pool({ connectionString });

function newAnonClient() {
  // 匿名サインイン（signInAnonymously）を一切呼ばない。生成直後のクライアントは
  // 完全な無認証状態のPostgREST anonロールとしてリクエストする（要件8.1）。
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

describe("0003_rpc_customer_gateway.sql: get_ordering_context RPC（結合テスト）", () => {
  const storeId = randomUUID();
  const tableNoSessionId = randomUUID();
  const tableWithSessionId = randomUUID();
  const tableActiveNoOrdersId = randomUUID();
  const menuItemId = randomUUID();
  const menuItemNoOptionsId = randomUUID();
  const soldOutMenuItemId = randomUUID();
  const activeSessionId = randomUUID();
  const activeNoOrdersSessionId = randomUUID();
  const orderId = randomUUID();

  const menuItemOptions = [
    {
      id: "spice",
      type: "choice",
      label: "辛さ",
      choices: ["normal", "hot"],
      default: "normal",
    },
  ];

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "get_ordering_context結合テスト用店舗",
    ]);

    await pool.query(
      `insert into tables (id, store_id, label)
       values ($1, $2, $3), ($4, $2, $5), ($6, $2, $7)`,
      [
        tableNoSessionId,
        storeId,
        "セッションなし卓",
        tableWithSessionId,
        "セッションあり卓",
        tableActiveNoOrdersId,
        "セッションあり・未注文卓",
      ],
    );

    await pool.query(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, image_url, options)
       values
         ($1, $2, 'Item One', 500, false, 'food', 'https://example.com/item-one.jpg', $3::jsonb),
         ($4, $2, 'Item Two', 300, false, 'drink', null, '[]'::jsonb),
         ($5, $2, 'Item Three SoldOut', 800, true, 'ippin', null, '[]'::jsonb)`,
      [
        menuItemId,
        storeId,
        JSON.stringify(menuItemOptions),
        menuItemNoOptionsId,
        soldOutMenuItemId,
      ],
    );

    await pool.query(
      `insert into table_sessions (id, table_id, status, party_size)
       values ($1, $2, 'active', 2), ($3, $4, 'active', 4)`,
      [
        activeSessionId,
        tableWithSessionId,
        activeNoOrdersSessionId,
        tableActiveNoOrdersId,
      ],
    );

    await pool.query(
      "insert into orders (id, session_id, idempotency_key) values ($1, $2, 'test-key-1')",
      [orderId, activeSessionId],
    );

    await pool.query(
      `insert into order_items
         (order_id, menu_item_id, name_snapshot, unit_price_snapshot, quantity, status, options_selected, options_summary)
       values
         ($1, $2, 'Item One', 500, 2, 'received', '{}'::jsonb, null),
         ($1, $3, 'Item Two', 300, 1, 'received', '{}'::jsonb, null)`,
      [orderId, menuItemId, menuItemNoOptionsId],
    );
  });

  afterAll(async () => {
    await pool.query("delete from order_items where order_id = $1", [
      orderId,
    ]);
    await pool.query("delete from orders where id = $1", [orderId]);
    await pool.query("delete from table_sessions where id in ($1, $2)", [
      activeSessionId,
      activeNoOrdersSessionId,
    ]);
    await pool.query("delete from menu_items where store_id = $1", [
      storeId,
    ]);
    await pool.query("delete from tables where store_id = $1", [storeId]);
    await pool.query("delete from stores where id = $1", [storeId]);
    await pool.end();
  });

  it("アクティブセッションのない卓IDで呼び出すと、activeSession: null・confirmedTotal: 0が返り、メニューは返る（観測可能な完了条件）", async () => {
    const supabase = newAnonClient();
    const { data, error } = await supabase.rpc("get_ordering_context", {
      p_table_id: tableNoSessionId,
    });

    expect(error).toBeNull();
    expect(data.activeSession).toBeNull();
    expect(data.confirmedTotal).toBe(0);
    expect(data.table).toEqual({
      id: tableNoSessionId,
      label: "セッションなし卓",
    });
    expect(data.menu).toHaveLength(3);
  });

  it("アクティブセッションはあるが未注文の卓は、activeSession.idを返しconfirmedTotalは0になる", async () => {
    const supabase = newAnonClient();
    const { data, error } = await supabase.rpc("get_ordering_context", {
      p_table_id: tableActiveNoOrdersId,
    });

    expect(error).toBeNull();
    expect(data.activeSession).toEqual({ id: activeNoOrdersSessionId });
    expect(data.confirmedTotal).toBe(0);
  });

  it("アクティブセッションに確定注文がある卓は、正しいconfirmedTotalを返す（500*2 + 300*1 = 1300）", async () => {
    const supabase = newAnonClient();
    const { data, error } = await supabase.rpc("get_ordering_context", {
      p_table_id: tableWithSessionId,
    });

    expect(error).toBeNull();
    expect(data.activeSession).toEqual({ id: activeSessionId });
    expect(data.confirmedTotal).toBe(1300);
  });

  it("売り切れ品目はmenuから除外されず、soldOut: trueとして含まれる（要件1.4, 7.2）", async () => {
    const supabase = newAnonClient();
    const { data, error } = await supabase.rpc("get_ordering_context", {
      p_table_id: tableNoSessionId,
    });

    expect(error).toBeNull();
    const menu = data.menu as Array<Record<string, unknown>>;
    const soldOutItem = menu.find((item) => item.id === soldOutMenuItemId);
    expect(soldOutItem).toMatchObject({
      id: soldOutMenuItemId,
      name: "Item Three SoldOut",
      soldOut: true,
      imageUrl: null,
    });
  });

  it("imageUrl・optionsが設定/未設定の品目それぞれで元のjsonb値がそのまま往復する（要件1.5, 1.6）", async () => {
    const supabase = newAnonClient();
    const { data, error } = await supabase.rpc("get_ordering_context", {
      p_table_id: tableNoSessionId,
    });

    expect(error).toBeNull();
    const menu = data.menu as Array<Record<string, unknown>>;

    const withImageAndOptions = menu.find((item) => item.id === menuItemId);
    expect(withImageAndOptions).toMatchObject({
      imageUrl: "https://example.com/item-one.jpg",
      options: menuItemOptions,
    });

    const withoutImageOrOptions = menu.find(
      (item) => item.id === menuItemNoOptionsId,
    );
    expect(withoutImageOrOptions).toMatchObject({
      imageUrl: null,
      options: [],
    });
  });

  it("存在しない卓IDで呼び出すと、カスタムSQLSTATE P0404（TABLE_NOT_FOUND相当）で拒否される", async () => {
    const supabase = newAnonClient();
    const { data, error } = await supabase.rpc("get_ordering_context", {
      p_table_id: randomUUID(),
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(TABLE_NOT_FOUND);
  });
});
