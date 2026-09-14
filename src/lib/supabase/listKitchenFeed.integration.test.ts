// @vitest-environment node
//
// 0004_rpc_staff_gateway.sql に追記されたlist_kitchen_feed RPCを、ローカル
// Supabaseスタックに対する実際のデバイスセッション（device_role='kitchen'の
// authenticatedクライアント）で検証する結合テスト。updateOrderItemStatus.
// integration.test.ts/setSoldOut.integration.test.tsと同じ構成: 事前に
// `npm run db:start`と`npm run db:reset`（0001〜0007を適用）が必要。
//
// design.md StaffOperationsGateway Responsibilities & Constraints:
// 「listKitchenFeedが返す未対応（received）の品目一覧は、一品ジャンルを受注
// 時刻に関わらず先頭に、それ以外は受注時刻の昇順で並べる（要件6.7）」
// 「listKitchenFeedが返す調理完了（done）の品目一覧は、status_updated_atの
// 降順（直近に完了したものが先頭）で並べる（要件6.10）」。
// タスク4.5の設計判断21により、本RPCはassert_device_role(array['kitchen'])
// のみを許可する（list_register_feedとは相互排他的な読者を持つ）。
//
// Requirements: 2.2, 5.1, 5.2, 5.3, 5.4, 6.1, 6.7, 6.8, 6.9, 6.10
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. listKitchenFeed.integration.test.ts requires it ` +
        "(see .env.local; vitest.config.mts loads it into process.env). " +
        "Run `npm run db:start` first if the local Supabase stack is not running.",
    );
  }
  return value;
}

const connectionString = requireEnv("SUPABASE_DB_URL");
const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supabaseAnonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

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

interface KitchenFeedItem {
  id: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  optionsSummary: string | null;
  status: "received" | "in_progress" | "done";
  statusUpdatedAt: string;
  tableId: string;
  tableLabel: string;
  genre: "ippin" | "food" | "drink";
}

async function callListKitchenFeed(
  client: SupabaseClient,
  storeId: string,
): Promise<{ data: KitchenFeedItem[] | null; error: { code?: string } | null }> {
  const result = await client.rpc("list_kitchen_feed", { p_store_id: storeId });
  return result as never;
}

describe("0004_rpc_staff_gateway.sql: list_kitchen_feed RPC（結合テスト）", () => {
  const storeAId = randomUUID();
  const storeBId = randomUUID();
  const tableAId = randomUUID();
  const tableBId = randomUUID();
  const sessionAId = randomUUID();
  const sessionBId = randomUUID();

  const menuItemFoodId = randomUUID();
  const menuItemIppinId = randomUUID();
  const menuItemDrinkId = randomUUID();
  const menuItemStoreBId = randomUUID();

  const createdAuthUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  // 直接pool経由でorders/order_itemsを挿入し、受注時刻(orders.created_at)や
  // 調理完了時刻(order_items.status_updated_at)を明示的に制御する。RPC経由の
  // 通常フロー（submit_order/update_order_item_status）では実行順序どおりの
  // タイムスタンプしか作れず、「自然な順序と逆にしてもRPCが正しく並べ替える」
  // ことを検証できないため、意図的にDB直接操作でタイムスタンプを制御する。
  async function insertOrderItem(params: {
    sessionId: string;
    menuItemId: string;
    status: "received" | "in_progress" | "done";
    orderCreatedAt: Date;
    statusUpdatedAt?: Date;
  }): Promise<string> {
    const orderId = randomUUID();
    await pool.query(
      "insert into orders (id, session_id, idempotency_key, created_at) values ($1, $2, $3, $4)",
      [orderId, params.sessionId, `test-seed-${randomUUID()}`, params.orderCreatedAt],
    );
    createdOrderIds.push(orderId);

    const orderItemId = randomUUID();
    const statusUpdatedAt = params.statusUpdatedAt ?? params.orderCreatedAt;
    await pool.query(
      `insert into order_items
         (id, order_id, menu_item_id, name_snapshot, unit_price_snapshot, quantity, status, status_updated_at)
       values ($1, $2, $3, 'Item', 500, 1, $4, $5)`,
      [orderItemId, orderId, params.menuItemId, params.status, statusUpdatedAt],
    );
    return orderItemId;
  }

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2), ($3, $4)", [
      storeAId,
      "list_kitchen_feed結合テスト用店舗A",
      storeBId,
      "list_kitchen_feed結合テスト用店舗B",
    ]);

    await pool.query(
      "insert into tables (id, store_id, label) values ($1, $2, $3), ($4, $5, $6)",
      [tableAId, storeAId, "A卓", tableBId, storeBId, "B卓"],
    );

    await pool.query(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values
         ($1, $2, 'Food Item', 800, false, 'food', '[]'::jsonb),
         ($3, $2, 'Ippin Item', 400, false, 'ippin', '[]'::jsonb),
         ($4, $2, 'Drink Item', 300, false, 'drink', '[]'::jsonb),
         ($5, $6, 'Store B Item', 500, false, 'food', '[]'::jsonb)`,
      [
        menuItemFoodId,
        storeAId,
        menuItemIppinId,
        menuItemDrinkId,
        menuItemStoreBId,
        storeBId,
      ],
    );

    await pool.query(
      `insert into table_sessions (id, table_id, status, party_size)
       values ($1, $2, 'active', 2), ($3, $4, 'active', 1)`,
      [sessionAId, tableAId, sessionBId, tableBId],
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
    await pool.query("delete from table_sessions where table_id = any($1)", [
      [tableAId, tableBId],
    ]);
    await pool.query("delete from menu_items where store_id = any($1)", [
      [storeAId, storeBId],
    ]);
    await pool.query("delete from devices where store_id = any($1)", [
      [storeAId, storeBId],
    ]);
    await pool.query("delete from tables where store_id = any($1)", [
      [storeAId, storeBId],
    ]);
    await pool.query("delete from stores where id = any($1)", [
      [storeAId, storeBId],
    ]);
    for (const authUserId of createdAuthUserIds) {
      try {
        await pool.query("delete from auth.users where id = $1", [authUserId]);
      } catch {
        // ベストエフォート。テストの合否には影響しない。
      }
    }
    await pool.end();
  });

  it(
    "未対応(received)一覧: 一品ジャンルは受注時刻に関わらず先頭、それ以外は受注時刻の昇順（要件6.7）。" +
      "ippinを意図的に最後に注文させ、自然な挿入順とは逆の結果になることを確認する",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeAId,
      );
      createdAuthUserIds.push(authUserId);

      const base = new Date("2026-01-01T10:00:00Z");
      // 挿入順序: food(最古)→drink(中間)→ippin(最新)。もし実装がippin優先を
      // 無視して単純に受注時刻昇順のみで並べていたら、結果はfood, drink,
      // ippinの順になるはずである。正しい実装ではippinが先頭に来る。
      const foodItemId = await insertOrderItem({
        sessionId: sessionAId,
        menuItemId: menuItemFoodId,
        status: "received",
        orderCreatedAt: new Date(base.getTime()),
      });
      const drinkItemId = await insertOrderItem({
        sessionId: sessionAId,
        menuItemId: menuItemDrinkId,
        status: "received",
        orderCreatedAt: new Date(base.getTime() + 60_000),
      });
      const ippinItemId = await insertOrderItem({
        sessionId: sessionAId,
        menuItemId: menuItemIppinId,
        status: "received",
        orderCreatedAt: new Date(base.getTime() + 120_000),
      });

      const { data, error } = await callListKitchenFeed(client, storeAId);
      expect(error).toBeNull();
      expect(data).not.toBeNull();

      const receivedIds = (data as KitchenFeedItem[])
        .filter((item) => item.status === "received")
        .map((item) => item.id);

      const relevantOrder = receivedIds.filter((id) =>
        [foodItemId, drinkItemId, ippinItemId].includes(id),
      );

      expect(relevantOrder).toEqual([ippinItemId, foodItemId, drinkItemId]);
    },
  );

  it(
    "調理完了(done)一覧: status_updated_atの降順（直近完了が先頭、要件6.10）。" +
      "先に挿入した行のほうが新しいstatus_updated_atを持つように意図的に逆転させ、" +
      "挿入順ではなくタイムスタンプで並んでいることを確認する",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeAId,
      );
      createdAuthUserIds.push(authUserId);

      const base = new Date("2026-01-02T10:00:00Z");
      // 挿入順序: olderDone(先に挿入。DBの行順・idの生成順としては1番目)だが
      // status_updated_atは新しい(直近完了)。newerDone(2番目に挿入)だが
      // status_updated_atは古い(先に完了)。もし実装が挿入順やid順で並べて
      // いたら結果はolderDone, newerDoneの順になってしまうが、正しい実装は
      // status_updated_at降順で並べるためnewerDoneが先頭に来るべきである
      // ……という命名が紛らわしいため、変数名をタイムスタンプの意味で揃える。
      const completedEarlierId = await insertOrderItem({
        sessionId: sessionAId,
        menuItemId: menuItemFoodId,
        status: "done",
        orderCreatedAt: new Date(base.getTime()),
        statusUpdatedAt: new Date(base.getTime() + 10 * 60_000), // 10分後に完了
      });
      const completedLaterId = await insertOrderItem({
        sessionId: sessionAId,
        menuItemId: menuItemDrinkId,
        status: "done",
        orderCreatedAt: new Date(base.getTime() + 60_000),
        statusUpdatedAt: new Date(base.getTime() + 5 * 60_000), // completedEarlierより前に完了させた行だが挿入は後
      });
      // 挿入順序としてはcompletedEarlier→completedLaterだが、完了時刻
      // (status_updated_at)としてはcompletedLaterのほうが先(古い)。
      // つまり実際に「後から完了した」のはcompletedEarlier側である。

      const { data, error } = await callListKitchenFeed(client, storeAId);
      expect(error).toBeNull();

      const doneIds = (data as KitchenFeedItem[])
        .filter((item) => item.status === "done")
        .map((item) => item.id);

      const relevantOrder = doneIds.filter((id) =>
        [completedEarlierId, completedLaterId].includes(id),
      );

      // completedEarlierId (status_updated_atが新しい=直近完了) が先頭。
      expect(relevantOrder).toEqual([completedEarlierId, completedLaterId]);
    },
  );

  it(
    "調理完了一覧: 実際のupdate_order_item_status呼び出しを時間差で連続実行しても、" +
      "後から完了させた品目が先頭に返る（タスクの観測可能な完了条件そのもの）",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeAId,
      );
      createdAuthUserIds.push(authUserId);

      const base = new Date("2026-01-03T10:00:00Z");
      const firstCompletedId = await insertOrderItem({
        sessionId: sessionAId,
        menuItemId: menuItemDrinkId,
        status: "received",
        orderCreatedAt: base,
      });
      const secondCompletedId = await insertOrderItem({
        sessionId: sessionAId,
        menuItemId: menuItemDrinkId,
        status: "received",
        orderCreatedAt: base,
      });

      const firstResult = await client.rpc("update_order_item_status", {
        p_order_item_id: firstCompletedId,
        p_status: "done",
      });
      expect(firstResult.error).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 50));

      const secondResult = await client.rpc("update_order_item_status", {
        p_order_item_id: secondCompletedId,
        p_status: "done",
      });
      expect(secondResult.error).toBeNull();

      const { data, error } = await callListKitchenFeed(client, storeAId);
      expect(error).toBeNull();

      const doneIds = (data as KitchenFeedItem[])
        .filter((item) => item.status === "done")
        .map((item) => item.id);

      const relevantOrder = doneIds.filter((id) =>
        [firstCompletedId, secondCompletedId].includes(id),
      );

      expect(relevantOrder).toEqual([secondCompletedId, firstCompletedId]);
    },
  );

  it("調理中(in_progress)一覧: 既定の並び順として受注時刻の昇順で返る（要件文書に規定はないため実装者裁量のデフォルト挙動の確認）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "kitchen",
      storeAId,
    );
    createdAuthUserIds.push(authUserId);

    const base = new Date("2026-01-04T10:00:00Z");
    const olderId = await insertOrderItem({
      sessionId: sessionAId,
      menuItemId: menuItemFoodId,
      status: "in_progress",
      orderCreatedAt: new Date(base.getTime() + 60_000),
    });
    const newerId = await insertOrderItem({
      sessionId: sessionAId,
      menuItemId: menuItemFoodId,
      status: "in_progress",
      orderCreatedAt: new Date(base.getTime()),
    });
    // olderIdの方が受注時刻(orderCreatedAt)が後、newerIdの方が受注時刻が先。
    // 変数名が実際の時系列と逆になっている点に注意（意図的: 挿入順序と
    // 受注時刻の前後関係を一致させないことで、実装が受注時刻を見ているか
    // 挿入順を見ているかを区別できるようにするため）。期待される昇順の結果は
    // newerId（受注時刻が先＝古い）が先頭。

    const { data, error } = await callListKitchenFeed(client, storeAId);
    expect(error).toBeNull();

    const inProgressIds = (data as KitchenFeedItem[])
      .filter((item) => item.status === "in_progress")
      .map((item) => item.id);

    const relevantOrder = inProgressIds.filter((id) =>
      [olderId, newerId].includes(id),
    );

    expect(relevantOrder).toEqual([newerId, olderId]);
  });

  it("店舗スコープ: 別店舗(storeB)の品目は一切含まれない", async () => {
    const { client, authUserId } = await createDeviceClient(
      "kitchen",
      storeAId,
    );
    createdAuthUserIds.push(authUserId);

    const storeBItemId = await insertOrderItem({
      sessionId: sessionBId,
      menuItemId: menuItemStoreBId,
      status: "received",
      orderCreatedAt: new Date(),
    });

    const { data, error } = await callListKitchenFeed(client, storeAId);
    expect(error).toBeNull();

    const ids = (data as KitchenFeedItem[]).map((item) => item.id);
    expect(ids).not.toContain(storeBItemId);

    const tableIds = new Set((data as KitchenFeedItem[]).map((item) => item.tableId));
    expect(tableIds.has(tableBId)).toBe(false);
  });

  it("返却される各要素はtableId/tableLabel/genreを含む（要件6.8）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "kitchen",
      storeAId,
    );
    createdAuthUserIds.push(authUserId);

    const itemId = await insertOrderItem({
      sessionId: sessionAId,
      menuItemId: menuItemIppinId,
      status: "received",
      orderCreatedAt: new Date(),
    });

    const { data, error } = await callListKitchenFeed(client, storeAId);
    expect(error).toBeNull();

    const found = (data as KitchenFeedItem[]).find((item) => item.id === itemId);
    expect(found).toBeDefined();
    expect(found).toMatchObject({
      tableId: tableAId,
      tableLabel: "A卓",
      genre: "ippin",
      menuItemId: menuItemIppinId,
      status: "received",
    });
  });

  it("registerロールのデバイスから呼び出すとFORBIDDENで拒否される（list_register_feedとは相互排他的な読者。設計判断21）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeAId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await callListKitchenFeed(client, storeAId);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(FORBIDDEN_DEVICE_ROLE);
  });
});
