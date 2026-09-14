// @vitest-environment node
//
// 0004_rpc_staff_gateway.sql に追記されたupdate_order_item_status RPCを、ローカル
// Supabaseスタックに対する実際のデバイスセッション（device_role='kitchen'または
// 'register'のauthenticatedクライアント）で検証する結合テスト。addOrderItem.
// integration.test.ts/removeOrderItem.integration.test.tsと同じ構成: 事前に
// `npm run db:start`と`npm run db:reset`（0001〜0007を適用）が必要。
//
// design.md StaffOperationsGateway Responsibilities & Constraints・Invariants:
// 「updateOrderItemStatusは対象の注文明細が属する品目のジャンルを見て、許可される
// 遷移を判定する。フード/一品ジャンルはreceived → in_progress → done、ドリンク
// ジャンルはreceived → doneのみを許可する（要件6.3, 6.4, 5.7）」「一品ジャンルの
// 品目に限り、receivedからin_progressを経由せず直接doneへ遷移する呼び出しも
// 許可する（要件6.6）」。startSession/addOrderItem等（4.1/4.2）とは異なり、
// このRPCはKitchenBoard（厨房、要件6.1/6.2/6.5）とRegisterConsole（レジ、
// 要件5.7）の両方から呼ばれる業務操作である。design.mdのResponsibilities &
// Constraints冒頭でstartSession等を明示的に「registerロール限定」と個別に
// 述べているのに対し、updateOrderItemStatusの記述にはそのような限定が一切なく、
// むしろ要件5.7（レジ）と要件6.2/6.5（厨房）の両方を根拠として引いている。
// よって本RPCはassert_device_role(array['kitchen','register'])で両ロールを
// 許可する（addOrderItem等のregister限定パターンをそのまま流用しない）。
//
// Requirements: 5.7, 6.2, 6.3, 6.4, 6.5, 6.6, 6.10
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. updateOrderItemStatus.integration.test.ts requires it ` +
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
// ORDER_ITEM_NOT_FOUNDは4.2のremove_order_itemが確立した'P0444'を、同一の
// 意味（参照した注文明細が実在しない）として再利用する。
const ORDER_ITEM_NOT_FOUND = "P0444";
// INVALID_TRANSITIONは本タスク（4.3）で新規に割り当てるカスタムSQLSTATE。
// 当初検討した'P0429'は既に3.5のRATE_LIMITEDが使用しているため、'P0422'
// （HTTPの422 Unprocessable Entityを想起させる番号）を採用する。
const INVALID_TRANSITION = "P0422";
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

async function createAnonymousNoRoleClient(): Promise<{
  client: SupabaseClient;
  authUserId: string;
}> {
  // deviceRoleクレームを一切持たない匿名セッション（客側と同型）。
  const client = newAnonClient();
  const signInResult = await client.auth.signInAnonymously();
  expect(signInResult.error).toBeNull();
  const authUserId = signInResult.data.user?.id;
  expect(authUserId).toBeDefined();
  return { client, authUserId: authUserId as string };
}

interface OrderItemRow {
  id: string;
  status: string;
  status_updated_at: string;
}

describe("0004_rpc_staff_gateway.sql: update_order_item_status RPC（結合テスト）", () => {
  const storeId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();

  const menuItemFoodId = randomUUID();
  const menuItemIppinId = randomUUID();
  const menuItemDrinkId = randomUUID();

  const createdAuthUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  async function updateOrderItemStatus(
    client: SupabaseClient,
    orderItemId: string,
    status: "received" | "in_progress" | "done",
  ) {
    return client.rpc("update_order_item_status", {
      p_order_item_id: orderItemId,
      p_status: status,
    });
  }

  async function insertOrderItem(
    menuItemId: string,
    initialStatus: "received" | "in_progress" | "done",
  ): Promise<OrderItemRow> {
    const orderId = randomUUID();
    await pool.query(
      "insert into orders (id, session_id, idempotency_key) values ($1, $2, $3)",
      [orderId, sessionId, `test-seed-${randomUUID()}`],
    );
    createdOrderIds.push(orderId);

    const orderItemId = randomUUID();
    const result = await pool.query(
      `insert into order_items
         (id, order_id, menu_item_id, name_snapshot, unit_price_snapshot, quantity, status)
       values ($1, $2, $3, 'Item', 500, 1, $4)
       returning id, status, status_updated_at`,
      [orderItemId, orderId, menuItemId, initialStatus],
    );
    return result.rows[0] as OrderItemRow;
  }

  async function fetchOrderItem(orderItemId: string): Promise<OrderItemRow> {
    const result = await pool.query(
      "select id, status, status_updated_at from order_items where id = $1",
      [orderItemId],
    );
    return result.rows[0] as OrderItemRow;
  }

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "update_order_item_status結合テスト用店舗",
    ]);

    await pool.query("insert into tables (id, store_id, label) values ($1, $2, $3)", [
      tableId,
      storeId,
      "テスト卓",
    ]);

    await pool.query(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values
         ($1, $2, 'Food Item', 800, false, 'food', '[]'::jsonb),
         ($3, $2, 'Ippin Item', 400, false, 'ippin', '[]'::jsonb),
         ($4, $2, 'Drink Item', 300, false, 'drink', '[]'::jsonb)`,
      [menuItemFoodId, storeId, menuItemIppinId, menuItemDrinkId],
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

  describe("foodジャンル: 段階的遷移のみ許可（ショートカット不可）", () => {
    it("received → in_progress は成功する", async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const row = await insertOrderItem(menuItemFoodId, "received");

      const { data, error } = await updateOrderItemStatus(
        client,
        row.id,
        "in_progress",
      );

      expect(error).toBeNull();
      expect(data).toMatchObject({
        id: row.id,
        menuItemId: menuItemFoodId,
        status: "in_progress",
      });

      const after = await fetchOrderItem(row.id);
      expect(after.status).toBe("in_progress");
    });

    it("in_progress → done は成功する", async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const row = await insertOrderItem(menuItemFoodId, "in_progress");

      const { data, error } = await updateOrderItemStatus(
        client,
        row.id,
        "done",
      );

      expect(error).toBeNull();
      expect(data).toMatchObject({ id: row.id, status: "done" });

      const after = await fetchOrderItem(row.id);
      expect(after.status).toBe("done");
    });

    it("received → done への直接遷移はINVALID_TRANSITIONで拒否される（foodはippinと異なりショートカットが許可されない）", async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const row = await insertOrderItem(menuItemFoodId, "received");

      const { data, error } = await updateOrderItemStatus(
        client,
        row.id,
        "done",
      );

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(INVALID_TRANSITION);
      // DETAILはPostgres側でjsonb_build_object(...)::textとしてシリアライズ
      // されるため、キーの出力順序はJSON.stringifyの引数順とは限らない
      // （jsonbはキー長→辞書順で内部順序を持つ）。構造的な等価性で比較する。
      expect(JSON.parse(error?.details as string)).toEqual({
        from: "received",
        to: "done",
      });

      const after = await fetchOrderItem(row.id);
      expect(after.status).toBe("received");
    });
  });

  describe("ippinジャンル: 段階的遷移に加え、received→doneの直接ショートカットも許可（要件6.6）", () => {
    it("received → in_progress は成功する", async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const row = await insertOrderItem(menuItemIppinId, "received");

      const { data, error } = await updateOrderItemStatus(
        client,
        row.id,
        "in_progress",
      );

      expect(error).toBeNull();
      expect(data).toMatchObject({ id: row.id, status: "in_progress" });
    });

    it("in_progress → done は成功する", async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const row = await insertOrderItem(menuItemIppinId, "in_progress");

      const { data, error } = await updateOrderItemStatus(
        client,
        row.id,
        "done",
      );

      expect(error).toBeNull();
      expect(data).toMatchObject({ id: row.id, status: "done" });
    });

    it("received → done への直接遷移（ショートカット）は成功する（観測可能な完了条件の対となる正常系, 要件6.6）", async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const row = await insertOrderItem(menuItemIppinId, "received");

      const { data, error } = await updateOrderItemStatus(
        client,
        row.id,
        "done",
      );

      expect(error).toBeNull();
      expect(data).toMatchObject({ id: row.id, status: "done" });

      const after = await fetchOrderItem(row.id);
      expect(after.status).toBe("done");
    });
  });

  describe("drinkジャンル: received → done のみ許可、in_progressは存在しない状態（タスクの観測可能な完了条件, 要件6.4）", () => {
    it("received → done は直接成功する", async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const row = await insertOrderItem(menuItemDrinkId, "received");

      const { data, error } = await updateOrderItemStatus(
        client,
        row.id,
        "done",
      );

      expect(error).toBeNull();
      expect(data).toMatchObject({ id: row.id, status: "done" });
    });

    it("received → in_progress はINVALID_TRANSITIONで拒否される（ドリンクはin_progress状態を持たない。タスクの観測可能な完了条件）", async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const row = await insertOrderItem(menuItemDrinkId, "received");

      const { data, error } = await updateOrderItemStatus(
        client,
        row.id,
        "in_progress",
      );

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(INVALID_TRANSITION);
      expect(JSON.parse(error?.details as string)).toEqual({
        from: "received",
        to: "in_progress",
      });

      const after = await fetchOrderItem(row.id);
      expect(after.status).toBe("received");
    });

    it("（防御的テスト）通常運用では到達し得ないin_progress状態のドリンク品目に対するdoneへの遷移要求もINVALID_TRANSITIONで拒否される", async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      // 正規のRPC経由では到達不可能な状態を、テスト専用に直接DBへ作り出す。
      const row = await insertOrderItem(menuItemDrinkId, "in_progress");

      const { data, error } = await updateOrderItemStatus(
        client,
        row.id,
        "done",
      );

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(INVALID_TRANSITION);

      const after = await fetchOrderItem(row.id);
      expect(after.status).toBe("in_progress");
    });
  });

  describe("後退遷移はいずれのジャンルもINVALID_TRANSITION", () => {
    it("food: done → received は拒否される", async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const row = await insertOrderItem(menuItemFoodId, "done");

      const { data, error } = await updateOrderItemStatus(
        client,
        row.id,
        "received",
      );

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(INVALID_TRANSITION);
      expect(JSON.parse(error?.details as string)).toEqual({
        from: "done",
        to: "received",
      });
    });

    it("food: in_progress → received は拒否される", async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const row = await insertOrderItem(menuItemFoodId, "in_progress");

      const { data, error } = await updateOrderItemStatus(
        client,
        row.id,
        "received",
      );

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(INVALID_TRANSITION);
    });

    it("drink: done → received は拒否される", async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const row = await insertOrderItem(menuItemDrinkId, "done");

      const { data, error } = await updateOrderItemStatus(
        client,
        row.id,
        "received",
      );

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(INVALID_TRANSITION);
    });

    it("ippin: done → in_progress は拒否される", async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const row = await insertOrderItem(menuItemIppinId, "done");

      const { data, error } = await updateOrderItemStatus(
        client,
        row.id,
        "in_progress",
      );

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(INVALID_TRANSITION);
    });

    it("同一ステータスへの遷移要求（received → received）も拒否される", async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const row = await insertOrderItem(menuItemFoodId, "received");

      const { data, error } = await updateOrderItemStatus(
        client,
        row.id,
        "received",
      );

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(INVALID_TRANSITION);
    });
  });

  it("status_updated_atは成功した遷移のたびに新しいタイムスタンプへ更新される（要件6.10。DBへの直接問い合わせで前後比較）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "kitchen",
      storeId,
    );
    createdAuthUserIds.push(authUserId);
    const row = await insertOrderItem(menuItemFoodId, "received");
    const before = await fetchOrderItem(row.id);

    // 前回のstatus_updated_atとの差が計測可能になるよう、わずかに待機する。
    await new Promise((resolve) => setTimeout(resolve, 20));

    const { error } = await updateOrderItemStatus(
      client,
      row.id,
      "in_progress",
    );
    expect(error).toBeNull();

    const afterFirst = await fetchOrderItem(row.id);
    expect(new Date(afterFirst.status_updated_at).getTime()).toBeGreaterThan(
      new Date(before.status_updated_at).getTime(),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    const { error: secondError } = await updateOrderItemStatus(
      client,
      row.id,
      "done",
    );
    expect(secondError).toBeNull();

    const afterSecond = await fetchOrderItem(row.id);
    expect(new Date(afterSecond.status_updated_at).getTime()).toBeGreaterThan(
      new Date(afterFirst.status_updated_at).getTime(),
    );
  });

  it("device_role='register'のデバイスからも成功する（本RPCはkitchen/register両方の業務操作であることの確認, 要件5.7）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);
    const row = await insertOrderItem(menuItemFoodId, "received");

    const { data, error } = await updateOrderItemStatus(
      client,
      row.id,
      "in_progress",
    );

    expect(error).toBeNull();
    expect(data).toMatchObject({ id: row.id, status: "in_progress" });
  });

  it("device_role='kitchen'のデバイスからも成功する（重複確認だが、両ロール許可の対称性を明示する）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "kitchen",
      storeId,
    );
    createdAuthUserIds.push(authUserId);
    const row = await insertOrderItem(menuItemDrinkId, "received");

    const { data, error } = await updateOrderItemStatus(
      client,
      row.id,
      "done",
    );

    expect(error).toBeNull();
    expect(data).toMatchObject({ id: row.id, status: "done" });
  });

  it("device_roleクレームを持たない匿名セッション（客側相当）からの呼び出しはFORBIDDENで拒否される", async () => {
    const { client, authUserId } = await createAnonymousNoRoleClient();
    createdAuthUserIds.push(authUserId);
    const row = await insertOrderItem(menuItemFoodId, "received");

    const { data, error } = await updateOrderItemStatus(
      client,
      row.id,
      "in_progress",
    );

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(FORBIDDEN_DEVICE_ROLE);

    const after = await fetchOrderItem(row.id);
    expect(after.status).toBe("received");
  });

  it("実在しないorderItemIdに対してはORDER_ITEM_NOT_FOUNDが返る（4.2のremove_order_itemと同一コードの再利用）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "kitchen",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await updateOrderItemStatus(
      client,
      randomUUID(),
      "in_progress",
    );

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(ORDER_ITEM_NOT_FOUND);
  });
});
