// @vitest-environment node
//
// 0004_rpc_staff_gateway.sql に追記されたset_sold_out RPCを、ローカル
// Supabaseスタックに対する実際のデバイスセッション（device_role='kitchen'の
// authenticatedクライアント）で検証する結合テスト。updateOrderItemStatus.
// integration.test.ts等と同じ構成: 事前に`npm run db:start`と
// `npm run db:reset`（0001〜0007を適用）が必要。
//
// 設計判断14（0004_rpc_staff_gateway.sql参照）: set_sold_outは要件7
// （厨房での売り切れ登録）のAcceptance Criteria（7.1, 7.3, 7.4）がいずれも
// 「厨房スタッフ」を主語とすること、design.mdのComponents and Interfaces表が
// KitchenBoard(UI)の対応要件にのみ7.1/7.3-7.4を含めRegisterConsole(UI)には
// 含めないことから、device_role='kitchen'限定のRPCと判断した。
//
// タスク4.4の観測可能な完了条件（tasks.md）:
// 「品目を売り切れ登録しても、登録前に作成されたorder_itemsの行数・statusが
// 変化しない」。本テストはこれをDBへの実際の直接問い合わせ（beforeとafterの
// 比較）で検証する。
//
// Requirements: 2.4, 7.1, 7.3, 7.4
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. setSoldOut.integration.test.ts requires it ` +
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
// ITEM_NOT_FOUNDは本タスク（4.4）で新規に割り当てる（設計判断16参照）。
const ITEM_NOT_FOUND = "P0405";
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

interface MenuItemRow {
  id: string;
  sold_out: boolean;
}

interface OrderItemRow {
  id: string;
  name_snapshot: string;
  unit_price_snapshot: string;
  quantity: number;
  status: string;
  options_selected: unknown;
  options_summary: string | null;
}

describe("0004_rpc_staff_gateway.sql: set_sold_out RPC（結合テスト）", () => {
  const storeId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();

  const menuItemId = randomUUID();
  const menuItemForNotFoundCheckId = randomUUID();

  const createdAuthUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  async function setSoldOut(
    client: SupabaseClient,
    menuItemIdArg: string,
    soldOut: boolean,
  ) {
    return client.rpc("set_sold_out", {
      p_menu_item_id: menuItemIdArg,
      p_sold_out: soldOut,
    });
  }

  async function fetchMenuItem(menuItemIdArg: string): Promise<MenuItemRow> {
    const result = await pool.query(
      "select id, sold_out from menu_items where id = $1",
      [menuItemIdArg],
    );
    return result.rows[0] as MenuItemRow;
  }

  async function fetchOrderItem(orderItemId: string): Promise<OrderItemRow> {
    const result = await pool.query(
      `select id, name_snapshot, unit_price_snapshot, quantity, status,
              options_selected, options_summary
       from order_items where id = $1`,
      [orderItemId],
    );
    return result.rows[0] as OrderItemRow;
  }

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "set_sold_out結合テスト用店舗",
    ]);

    await pool.query("insert into tables (id, store_id, label) values ($1, $2, $3)", [
      tableId,
      storeId,
      "テスト卓",
    ]);

    await pool.query(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values
         ($1, $2, 'Toggle Item', 600, false, 'food', '[]'::jsonb),
         ($3, $2, 'Not Found Check Item', 600, false, 'food', '[]'::jsonb)`,
      [menuItemId, storeId, menuItemForNotFoundCheckId],
    );

    await pool.query(
      `insert into table_sessions (id, table_id, status, party_size)
       values ($1, $2, 'active', 2)`,
      [sessionId, tableId],
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
    await pool.query("delete from table_sessions where table_id = $1", [
      tableId,
    ]);
    await pool.query("delete from menu_items where store_id = $1", [storeId]);
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

  it("品目を売り切れに切り替えると成功し、menu_items.sold_outがtrueへ更新される（要件7.1）", async () => {
    const { client, authUserId } = await createDeviceClient("kitchen", storeId);
    createdAuthUserIds.push(authUserId);

    const { data, error } = await setSoldOut(client, menuItemId, true);

    expect(error).toBeNull();
    expect(data).toMatchObject({
      id: menuItemId,
      storeId,
      name: "Toggle Item",
      soldOut: true,
    });

    const row = await fetchMenuItem(menuItemId);
    expect(row.sold_out).toBe(true);
  });

  it("売り切れ解除に切り替えると成功し、menu_items.sold_outがfalseへ戻る（要件7.3）", async () => {
    const { client, authUserId } = await createDeviceClient("kitchen", storeId);
    createdAuthUserIds.push(authUserId);

    // 直前のテストでtrueにしているため、falseへ戻す。
    const { data, error } = await setSoldOut(client, menuItemId, false);

    expect(error).toBeNull();
    expect(data).toMatchObject({ id: menuItemId, soldOut: false });

    const row = await fetchMenuItem(menuItemId);
    expect(row.sold_out).toBe(false);
  });

  it(
    "タスク4.4の観測可能な完了条件: 売り切れ登録前に作成されたorder_itemsの行数・" +
      "status・スナップショット列は、売り切れ登録後も完全に変化しない（要件7.4）",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);

      // 1. 売り切れ登録より前に、この品目を参照するorder_itemsを1件作成する
      //    （直接INSERT。submit_order/add_order_itemが行うスナップショット化を
      //    模す）。
      const orderId = randomUUID();
      await pool.query(
        "insert into orders (id, session_id, idempotency_key) values ($1, $2, $3)",
        [orderId, sessionId, `set-sold-out-test-${randomUUID()}`],
      );
      createdOrderIds.push(orderId);

      const orderItemId = randomUUID();
      await pool.query(
        `insert into order_items
           (id, order_id, menu_item_id, name_snapshot, unit_price_snapshot,
            quantity, status, options_selected, options_summary)
         values ($1, $2, $3, 'Toggle Item', 600, 2, 'in_progress', '{}'::jsonb, null)`,
        [orderItemId, orderId, menuItemId],
      );

      const before = await fetchOrderItem(orderItemId);
      const orderItemCountBefore = (
        await pool.query(
          "select count(*)::int as count from order_items where order_id = $1",
          [orderId],
        )
      ).rows[0].count as number;

      // 2. 売り切れ登録を実行する。
      const { error } = await setSoldOut(client, menuItemId, true);
      expect(error).toBeNull();

      // 3. 既存のorder_itemsの行数・内容が完全に不変であることをDBへの直接
      //    問い合わせで確認する（本タスクの観測可能な完了条件そのもの）。
      const after = await fetchOrderItem(orderItemId);
      const orderItemCountAfter = (
        await pool.query(
          "select count(*)::int as count from order_items where order_id = $1",
          [orderId],
        )
      ).rows[0].count as number;

      expect(orderItemCountAfter).toBe(orderItemCountBefore);
      expect(after).toEqual(before);
      expect(after.status).toBe("in_progress");
      expect(after.name_snapshot).toBe("Toggle Item");
      expect(after.unit_price_snapshot).toBe("600");

      // 後始末: 次のテストのためにmenu_itemsを売り切れでない状態へ戻す。
      const { error: revertError } = await setSoldOut(client, menuItemId, false);
      expect(revertError).toBeNull();
    },
  );

  it(
    "売り切れ登録後に同じ品目へ新規submit_orderするとITEM_SOLD_OUTで拒否される" +
      "（get_ordering_context/submit_orderが反映することのクロスチェック、要件7.2）",
    async () => {
      const { client: kitchenClient, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);

      const { error: soldOutError } = await setSoldOut(
        kitchenClient,
        menuItemId,
        true,
      );
      expect(soldOutError).toBeNull();

      // get_ordering_context（3.1）が新しいsoldOut状態を反映することを確認する。
      const anon = newAnonClient();
      const { data: context, error: contextError } = await anon.rpc(
        "get_ordering_context",
        { p_table_id: tableId },
      );
      expect(contextError).toBeNull();
      const menuEntry = (
        context.menu as ReadonlyArray<{ id: string; soldOut: boolean }>
      ).find((item) => item.id === menuItemId);
      expect(menuEntry).toMatchObject({ id: menuItemId, soldOut: true });

      // submit_order（3.2）が新規注文をITEM_SOLD_OUTで拒否することを確認する。
      const { data, error } = await anon.rpc("submit_order", {
        p_session_id: sessionId,
        p_idempotency_key: `sold-out-cross-check-${randomUUID()}`,
        p_items: [{ menuItemId, quantity: 1 }],
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(ITEM_SOLD_OUT);
      expect(error?.details).toBe(menuItemId);

      // 後始末: 次のテストへの影響を避けるため売り切れ状態を解除しておく。
      const { error: revertError } = await setSoldOut(
        kitchenClient,
        menuItemId,
        false,
      );
      expect(revertError).toBeNull();
    },
  );

  it("実在しないmenuItemIdに対してはITEM_NOT_FOUNDが返る", async () => {
    const { client, authUserId } = await createDeviceClient("kitchen", storeId);
    createdAuthUserIds.push(authUserId);

    const { data, error } = await setSoldOut(client, randomUUID(), true);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(ITEM_NOT_FOUND);
  });

  it("device_role='register'のデバイスから呼び出すと拒否される（kitchen限定操作であることの確認。design.md要件7がいずれも厨房スタッフの操作と明記していることに基づく判断、設計判断14）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await setSoldOut(
      client,
      menuItemForNotFoundCheckId,
      true,
    );

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(FORBIDDEN_DEVICE_ROLE);

    const row = await fetchMenuItem(menuItemForNotFoundCheckId);
    expect(row.sold_out).toBe(false);
  });
});
