// @vitest-environment node
//
// 0011_list_menu_items.sql が新規追加するlist_menu_items RPCを、ローカル
// Supabaseスタックに対する実際のデバイスセッション（device_role='kitchen'の
// authenticatedクライアント）で検証する結合テスト。listKitchenFeed.
// integration.test.ts/setSoldOut.integration.test.tsと同じ構成: 事前に
// `npm run db:start`と`npm run db:reset`（0001〜0011を適用）が必要。
//
// タスク7.4で判明したギャップ（0011_list_menu_items.sql冒頭コメント参照）:
// StaffOperationsGatewayには「特定の1品目を切り替える」setSoldOutのみが
// 存在し、「厨房の売り切れボードが対象品目を選ぶための一覧」を返す手段が
// 無かったため新規追加した。本結合テストは、その新規RPCが
// - 店舗スコープ（他店舗の品目を含めない）
// - id/name/price/soldOut/genreの正しいキー構成
// - 名前順の安定した並び
// - kitchen限定（registerはFORBIDDEN）
// を実際のDB・実際のdevice_roleクレーム付きJWTに対して満たすことを検証する。
//
// Requirements: 7.1, 7.3, 7.4
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. listMenuItems.integration.test.ts requires it ` +
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

interface MenuItemListingRow {
  id: string;
  name: string;
  price: number;
  soldOut: boolean;
  genre: "ippin" | "food" | "drink";
}

async function callListMenuItems(
  client: SupabaseClient,
  storeId: string,
): Promise<{
  data: MenuItemListingRow[] | null;
  error: { code?: string } | null;
}> {
  const result = await client.rpc("list_menu_items", { p_store_id: storeId });
  return result as never;
}

describe("0011_list_menu_items.sql: list_menu_items RPC（結合テスト）", () => {
  const storeAId = randomUUID();
  const storeBId = randomUUID();

  const menuItemZebraId = randomUUID(); // 名前順で最後になるよう意図的に選定
  const menuItemAppleId = randomUUID(); // 名前順で最初になるよう意図的に選定
  const menuItemSoldOutId = randomUUID();
  const menuItemStoreBId = randomUUID();

  const createdAuthUserIds: string[] = [];

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2), ($3, $4)", [
      storeAId,
      "list_menu_items結合テスト用店舗A",
      storeBId,
      "list_menu_items結合テスト用店舗B",
    ]);

    await pool.query(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values
         ($1, $2, 'Zebra Item', 900, false, 'drink', '[]'::jsonb),
         ($3, $2, 'Apple Item', 300, false, 'ippin', '[]'::jsonb),
         ($4, $2, 'Sold Out Item', 700, true, 'food', '[]'::jsonb),
         ($5, $6, 'Store B Item', 500, false, 'food', '[]'::jsonb)`,
      [
        menuItemZebraId,
        storeAId,
        menuItemAppleId,
        menuItemSoldOutId,
        menuItemStoreBId,
        storeBId,
      ],
    );
  });

  afterAll(async () => {
    await pool.query("delete from menu_items where store_id = any($1)", [
      [storeAId, storeBId],
    ]);
    await pool.query("delete from devices where store_id = any($1)", [
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

  it("対象店舗の全品目を、id/name/price/soldOut/genreのキー構成で、名前順に返す（売り切れ品目も除外しない）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "kitchen",
      storeAId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await callListMenuItems(client, storeAId);
    expect(error).toBeNull();
    expect(data).not.toBeNull();

    const rows = data as MenuItemListingRow[];
    const relevantIds = [menuItemAppleId, menuItemSoldOutId, menuItemZebraId] as string[];
    const relevant = rows.filter((item) => relevantIds.includes(item.id));

    // 名前順（Apple → Sold Out → Zebra）で返ることを確認する。
    expect(relevant.map((item) => item.id)).toEqual([
      menuItemAppleId,
      menuItemSoldOutId,
      menuItemZebraId,
    ]);

    expect(relevant.find((item) => item.id === menuItemAppleId)).toEqual({
      id: menuItemAppleId,
      name: "Apple Item",
      price: 300,
      soldOut: false,
      genre: "ippin",
    });
    expect(relevant.find((item) => item.id === menuItemSoldOutId)).toMatchObject({
      name: "Sold Out Item",
      soldOut: true,
      genre: "food",
    });
  });

  it("店舗スコープ: 別店舗(storeB)の品目は一切含まれない", async () => {
    const { client, authUserId } = await createDeviceClient(
      "kitchen",
      storeAId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await callListMenuItems(client, storeAId);
    expect(error).toBeNull();

    const ids = (data as MenuItemListingRow[]).map((item) => item.id);
    expect(ids).not.toContain(menuItemStoreBId);
  });

  it("registerロールのデバイスから呼び出すとFORBIDDENで拒否される（setSoldOutと同じkitchen限定、0011冒頭コメント参照）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeAId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await callListMenuItems(client, storeAId);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(FORBIDDEN_DEVICE_ROLE);
  });

  it("anonロードから呼び出すとEXECUTE権限が無いため拒否される（authenticatedのみEXECUTE許可）", async () => {
    const anon = newAnonClient();
    const { data, error } = await callListMenuItems(anon, storeAId);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("該当する品目が0件の店舗に対しては空配列を返す（list_kitchen_feed/list_register_feedと同じ判断）", async () => {
    const emptyStoreId = randomUUID();
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      emptyStoreId,
      "list_menu_items結合テスト用空店舗",
    ]);

    try {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        emptyStoreId,
      );
      createdAuthUserIds.push(authUserId);

      const { data, error } = await callListMenuItems(client, emptyStoreId);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    } finally {
      await pool.query("delete from devices where store_id = $1", [
        emptyStoreId,
      ]);
      await pool.query("delete from stores where id = $1", [emptyStoreId]);
    }
  });
});
