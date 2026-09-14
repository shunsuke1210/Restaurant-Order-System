// @vitest-environment node
//
// staffOperationsGateway.ts（本タスク4.6）の結合テスト。ユニットテスト
// （staffOperationsGateway.test.ts）は`client.rpc`をモックしてマッピング
// ロジックを検証するが、実際の0004_rpc_staff_gateway.sql RPCが本当に
// この形（jsonbのキー名・SQLSTATE）で応答するかどうかまではモックでは
// 検証できない（TSマッピングとRPCの実応答の間のドリフトを検出できない）。
// 本ファイルはローカルSupabaseスタックに対する実際のdeviceセッション
// （匿名サインイン→devicesテーブルへの行追加→refreshSessionで
// device_role claim付きのJWTを持たせたauthenticatedクライアント。
// startSession.integration.test.ts等（タスク4.1-4.5）と同じ手順）で
// createStaffOperationsGateway経由の呼び出しを行い、10メソッドそれぞれの
// 幸せな経路と、DETAIL抽出（activeSessionId/menuItemId/{from,to}）・
// listKitchenFeed/listRegisterFeedの`never`エラー型（FORBIDDENでさえ
// Resultにならず例外として伝播する）という本ラッパー固有のリスクが高い
// 箇所を検証する。各RPC自体の網羅的なエラー分岐は
// supabase/*.integration.test.ts（タスク4.1-4.5）が既に検証済みのため、
// ここでは重複させない。事前に`npm run db:start`と`npm run db:reset`
// （0001〜0007を適用）が必要。
//
// tasks.md Implementation Notes（2.3で判明した教訓）に従い、環境変数には
// ハードコードされたfallback値を持たせず、未設定ならbeforeAll等より前に
// 明確なエラーで失敗させる（fail-fast）。
//
// Requirements: 2.2, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4,
//   5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7,
//   6.8, 6.9, 6.10, 7.1, 7.3, 7.4
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../supabase/database.types";
import { createStaffOperationsGateway } from "./staffOperationsGateway";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. staffOperationsGateway.integration.test.ts requires it ` +
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

function newAnonClient() {
  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * 匿名サインイン→devicesテーブルへの行追加→refreshSessionという、
 * このリポジトリで確立済みの手順（startSession.integration.test.ts等、
 * タスク4.1-4.5）で、device_role claim付きのJWTを持つauthenticated
 * クライアントを用意する。
 */
async function createDeviceClient(
  role: "kitchen" | "register",
  storeId: string,
): Promise<{ client: SupabaseClient<Database>; authUserId: string }> {
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

describe("staffOperationsGateway（結合テスト、実RPCへの疎通確認）", () => {
  const storeId = randomUUID();

  const tableStart = randomUUID();
  const tableAlreadyActive = randomUUID();
  const tableClose = randomUUID();
  const tablePartySize = randomUUID();
  const tableClosedForChecks = randomUUID();
  const tableItems = randomUUID();
  const tableCallRequest = randomUUID();

  const existingActiveSessionId = randomUUID();
  const sessionToClose = randomUUID();
  const sessionForPartySize = randomUUID();
  const sessionClosed = randomUUID();
  const sessionForItems = randomUUID();
  const sessionForCallRequest = randomUUID();

  const menuItemNormal = randomUUID();
  const menuItemSoldOut = randomUUID();
  const menuItemToggle = randomUUID();

  const openCallRequestId = randomUUID();

  const createdAuthUserIds: string[] = [];
  const sessionIds = [
    existingActiveSessionId,
    sessionToClose,
    sessionForPartySize,
    sessionClosed,
    sessionForItems,
    sessionForCallRequest,
  ];
  // startSession（幸せな経路）が新規発行するセッションidをafterAllで
  // 掃除するために収集する。
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "staffOperationsGatewayラッパー結合テスト用店舗",
    ]);

    await pool.query(
      `insert into tables (id, store_id, label)
       values ($1, $2, $3), ($4, $2, $5), ($6, $2, $7), ($8, $2, $9),
              ($10, $2, $11), ($12, $2, $13), ($14, $2, $15)`,
      [
        tableStart,
        storeId,
        "ラッパー検証・空席卓",
        tableAlreadyActive,
        "ラッパー検証・来店中卓",
        tableClose,
        "ラッパー検証・会計対象卓",
        tablePartySize,
        "ラッパー検証・人数変更卓",
        tableClosedForChecks,
        "ラッパー検証・終了済みチェック卓",
        tableItems,
        "ラッパー検証・品目操作卓",
        tableCallRequest,
        "ラッパー検証・呼び出し卓",
      ],
    );

    await pool.query(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values
         ($1, $2, 'Wrapper Food Item', 700, false, 'food', '[]'::jsonb),
         ($3, $2, 'Wrapper Sold Out Item', 900, true, 'ippin', '[]'::jsonb),
         ($4, $2, 'Wrapper Toggle Item', 400, false, 'drink', '[]'::jsonb)`,
      [menuItemNormal, storeId, menuItemSoldOut, menuItemToggle],
    );

    await pool.query(
      `insert into table_sessions (id, table_id, status, party_size)
       values
         ($1, $2, 'active', 2),
         ($3, $4, 'active', 2),
         ($5, $6, 'active', 2),
         ($7, $8, 'closed', 2),
         ($9, $10, 'active', 2),
         ($11, $12, 'active', 2)`,
      [
        existingActiveSessionId,
        tableAlreadyActive,
        sessionToClose,
        tableClose,
        sessionForPartySize,
        tablePartySize,
        sessionClosed,
        tableClosedForChecks,
        sessionForItems,
        tableItems,
        sessionForCallRequest,
        tableCallRequest,
      ],
    );

    await pool.query(
      `insert into call_requests (id, session_id, status) values ($1, $2, 'open')`,
      [openCallRequestId, sessionForCallRequest],
    );
  });

  afterAll(async () => {
    const allSessionIds = [...sessionIds, ...createdSessionIds];

    await pool.query(
      `delete from order_items
       where order_id in (select id from orders where session_id = any($1))`,
      [allSessionIds],
    );
    await pool.query("delete from orders where session_id = any($1)", [
      allSessionIds,
    ]);
    await pool.query("delete from call_requests where session_id = any($1)", [
      allSessionIds,
    ]);
    await pool.query("delete from table_sessions where id = any($1)", [
      allSessionIds,
    ]);
    await pool.query(
      "delete from table_sessions where table_id in (select id from tables where store_id = $1)",
      [storeId],
    );
    await pool.query("delete from menu_items where store_id = $1", [storeId]);
    await pool.query("delete from devices where store_id = $1", [storeId]);
    await pool.query("delete from tables where store_id = $1", [storeId]);
    await pool.query("delete from stores where id = $1", [storeId]);
    for (const authUserId of createdAuthUserIds) {
      try {
        await pool.query("delete from auth.users where id = $1", [authUserId]);
      } catch {
        // ベストエフォート。テストの合否には影響しない。
      }
    }
    await pool.end();
  });

  it("startSession: 実RPCの応答をTableSession型として正しく整形する（幸せな経路、要件3.1, 3.4）", async () => {
    const { client, authUserId } = await createDeviceClient("register", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.startSession({
      tableId: tableStart,
      partySize: 5,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdSessionIds.push(result.value.id);
    expect(result.value).toMatchObject({
      tableId: tableStart,
      status: "active",
      closedAt: null,
      partySize: 5,
    });
    expect(typeof result.value.id).toBe("string");
    expect(typeof result.value.startedAt).toBe("string");
  });

  it("startSession: 既にアクティブセッションがある卓はSESSION_ALREADY_ACTIVE（activeSessionId付き）になる（TSマッピングとRPCのDETAIL往復を実機で確認、要件3.2, 4.1）", async () => {
    const { client, authUserId } = await createDeviceClient("register", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.startSession({
      tableId: tableAlreadyActive,
      partySize: 3,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "SESSION_ALREADY_ACTIVE",
        activeSessionId: existingActiveSessionId,
      },
    });
  });

  it("startSession: device_role='kitchen'から呼び出すとFORBIDDENになる（register限定操作、0004設計判断1）", async () => {
    const { client, authUserId } = await createDeviceClient("kitchen", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.startSession({
      tableId: tableStart,
      partySize: 2,
    });

    expect(result).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("closeSession: 実RPCの応答をTableSession型として正しく整形する（幸せな経路、要件3.3）", async () => {
    const { client, authUserId } = await createDeviceClient("register", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.closeSession({ sessionId: sessionToClose });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("closed");
    expect(typeof result.value.closedAt).toBe("string");
  });

  it("closeSession: 既にclosedのセッションはSESSION_NOT_ACTIVEになる", async () => {
    const { client, authUserId } = await createDeviceClient("register", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.closeSession({ sessionId: sessionClosed });

    expect(result).toEqual({
      ok: false,
      error: { code: "SESSION_NOT_ACTIVE" },
    });
  });

  it("updatePartySize: 実RPCの応答をTableSession型として正しく整形する（幸せな経路、要件3.5）", async () => {
    const { client, authUserId } = await createDeviceClient("register", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.updatePartySize({
      sessionId: sessionForPartySize,
      partySize: 8,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.partySize).toBe(8);
  });

  it("updatePartySize: closedなセッションはSESSION_NOT_ACTIVEになり、人数を変更しない", async () => {
    const { client, authUserId } = await createDeviceClient("register", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.updatePartySize({
      sessionId: sessionClosed,
      partySize: 1,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "SESSION_NOT_ACTIVE" },
    });
  });

  it("addOrderItem: 実RPCの応答をOrderItemSummary型として正しく整形する（幸せな経路、要件5.5）", async () => {
    const { client, authUserId } = await createDeviceClient("register", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.addOrderItem({
      sessionId: sessionForItems,
      menuItemId: menuItemNormal,
      quantity: 2,
      optionSelections: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      menuItemId: menuItemNormal,
      name: "Wrapper Food Item",
      unitPrice: 700,
      quantity: 2,
      status: "received",
    });
    expect(typeof result.value.id).toBe("string");

    // removeOrderItemの幸せな経路のテストがこの品目を対象にする。
    const removeResult = await gateway.removeOrderItem({
      orderItemId: result.value.id,
    });
    expect(removeResult).toEqual({
      ok: true,
      value: { orderItemId: result.value.id },
    });
  });

  it("addOrderItem: closedなセッションはSESSION_NOT_ACTIVEになり、何も挿入しない", async () => {
    const { client, authUserId } = await createDeviceClient("register", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.addOrderItem({
      sessionId: sessionClosed,
      menuItemId: menuItemNormal,
      quantity: 1,
      optionSelections: {},
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "SESSION_NOT_ACTIVE" },
    });
  });

  it("addOrderItem: 売り切れ品目はITEM_SOLD_OUT（menuItemId付き）になる（TSマッピングとRPCのDETAIL往復を実機で確認）", async () => {
    const { client, authUserId } = await createDeviceClient("register", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.addOrderItem({
      sessionId: sessionForItems,
      menuItemId: menuItemSoldOut,
      quantity: 1,
      optionSelections: {},
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "ITEM_SOLD_OUT", menuItemId: menuItemSoldOut },
    });
  });

  it("removeOrderItem: 実在しない注文明細IDはORDER_ITEM_NOT_FOUNDになる（要件5.6）", async () => {
    const { client, authUserId } = await createDeviceClient("register", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.removeOrderItem({
      orderItemId: randomUUID(),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "ORDER_ITEM_NOT_FOUND" },
    });
  });

  it("updateOrderItemStatus: 実RPCの応答をOrderItemSummary型として正しく整形する（幸せな経路、received->in_progress、要件6.2, 6.3）", async () => {
    const { client: registerClient, authUserId: registerAuthUserId } =
      await createDeviceClient("register", storeId);
    createdAuthUserIds.push(registerAuthUserId);
    const registerGateway = createStaffOperationsGateway(registerClient);

    const added = await registerGateway.addOrderItem({
      sessionId: sessionForItems,
      menuItemId: menuItemNormal,
      quantity: 1,
      optionSelections: {},
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const { client: kitchenClient, authUserId: kitchenAuthUserId } =
      await createDeviceClient("kitchen", storeId);
    createdAuthUserIds.push(kitchenAuthUserId);
    const kitchenGateway = createStaffOperationsGateway(kitchenClient);

    const result = await kitchenGateway.updateOrderItemStatus({
      orderItemId: added.value.id,
      status: "in_progress",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("in_progress");
  });

  it("updateOrderItemStatus: フードジャンルでreceived->doneの直接遷移はINVALID_TRANSITION（{from,to}付き）になる（TSマッピングとRPCのJSON DETAIL往復を実機で確認、要件6.3）", async () => {
    const { client: registerClient, authUserId: registerAuthUserId } =
      await createDeviceClient("register", storeId);
    createdAuthUserIds.push(registerAuthUserId);
    const registerGateway = createStaffOperationsGateway(registerClient);

    const added = await registerGateway.addOrderItem({
      sessionId: sessionForItems,
      menuItemId: menuItemNormal,
      quantity: 1,
      optionSelections: {},
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const { client: kitchenClient, authUserId: kitchenAuthUserId } =
      await createDeviceClient("kitchen", storeId);
    createdAuthUserIds.push(kitchenAuthUserId);
    const kitchenGateway = createStaffOperationsGateway(kitchenClient);

    const result = await kitchenGateway.updateOrderItemStatus({
      orderItemId: added.value.id,
      status: "done",
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_TRANSITION", from: "received", to: "done" },
    });
  });

  it("updateOrderItemStatus: 実在しない注文明細IDはORDER_ITEM_NOT_FOUNDになる", async () => {
    const { client, authUserId } = await createDeviceClient("kitchen", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.updateOrderItemStatus({
      orderItemId: randomUUID(),
      status: "in_progress",
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "ORDER_ITEM_NOT_FOUND" },
    });
  });

  it("setSoldOut: 実RPCの応答をMenuItem型として正しく整形する（幸せな経路、要件7.1, 7.3）", async () => {
    const { client, authUserId } = await createDeviceClient("kitchen", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.setSoldOut({
      menuItemId: menuItemToggle,
      soldOut: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        id: menuItemToggle,
        storeId,
        name: "Wrapper Toggle Item",
        price: 400,
        soldOut: true,
      },
    });
  });

  it("setSoldOut: 実在しない品目IDはITEM_NOT_FOUNDになる", async () => {
    const { client, authUserId } = await createDeviceClient("kitchen", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.setSoldOut({
      menuItemId: randomUUID(),
      soldOut: true,
    });

    expect(result).toEqual({ ok: false, error: { code: "ITEM_NOT_FOUND" } });
  });

  it("resolveCallRequest: 実RPCの応答をCallRequest型として正しく整形する（幸せな経路、要件2.4）", async () => {
    const { client, authUserId } = await createDeviceClient("register", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.resolveCallRequest({
      callRequestId: openCallRequestId,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        id: openCallRequestId,
        sessionId: sessionForCallRequest,
        status: "resolved",
        createdAt: expect.any(String),
      },
    });
  });

  it("resolveCallRequest: 実在しない/既にresolved済みの呼び出しはCALL_REQUEST_NOT_FOUNDになる（4.4レビューで修正済みの専用エラー型）", async () => {
    const { client, authUserId } = await createDeviceClient("register", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.resolveCallRequest({
      callRequestId: randomUUID(),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "CALL_REQUEST_NOT_FOUND" },
    });
  });

  it("listKitchenFeed: 実RPCの応答を配列として正しく整形する（幸せな経路、要件6.1, 6.8）", async () => {
    const { client: registerClient, authUserId: registerAuthUserId } =
      await createDeviceClient("register", storeId);
    createdAuthUserIds.push(registerAuthUserId);
    const registerGateway = createStaffOperationsGateway(registerClient);

    const added = await registerGateway.addOrderItem({
      sessionId: sessionForItems,
      menuItemId: menuItemNormal,
      quantity: 3,
      optionSelections: {},
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const { client: kitchenClient, authUserId: kitchenAuthUserId } =
      await createDeviceClient("kitchen", storeId);
    createdAuthUserIds.push(kitchenAuthUserId);
    const kitchenGateway = createStaffOperationsGateway(kitchenClient);

    const result = await kitchenGateway.listKitchenFeed({ storeId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.value.find((i) => i.id === added.value.id);
    expect(item).toMatchObject({
      menuItemId: menuItemNormal,
      quantity: 3,
      tableId: tableItems,
      tableLabel: "ラッパー検証・品目操作卓",
      genre: "food",
    });
  });

  it("listKitchenFeed: design.mdの`never`エラー型 — register専用デバイスから呼び出すとFORBIDDENがResultにならず例外として伝播する（0004設計判断21, 25）", async () => {
    const { client, authUserId } = await createDeviceClient("register", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    await expect(gateway.listKitchenFeed({ storeId })).rejects.toThrow();
  });

  it("listRegisterFeed: 実RPCの応答を配列として正しく整形する（幸せな経路、空席卓のactiveSession:nullを含む、要件5.1, 5.2, 5.4）", async () => {
    const { client, authUserId } = await createDeviceClient("register", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    const result = await gateway.listRegisterFeed({ storeId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const activeTable = result.value.find((t) => t.tableId === tableCallRequest);
    expect(activeTable).toMatchObject({
      tableLabel: "ラッパー検証・呼び出し卓",
      activeSession: {
        id: sessionForCallRequest,
        partySize: 2,
      },
      hasOpenCallRequest: false, // resolveCallRequestのテストで既にresolved済みのため
    });

    // アクティブセッションのない卓（例: tableClosedForChecksは常にclosedな
    // セッションしか持たない）は、activeSession: null・items: []・total: 0・
    // hasOpenCallRequest: falseという設計判断24の形状を満たすはずである。
    const noSessionTable = result.value.find(
      (t) => t.tableId === tableClosedForChecks,
    );
    expect(noSessionTable?.activeSession).toBeNull();
    for (const table of result.value) {
      if (table.activeSession === null) {
        expect(table.items).toEqual([]);
        expect(table.total).toBe(0);
        expect(table.hasOpenCallRequest).toBe(false);
      }
    }
  });

  it("listRegisterFeed: design.mdの`never`エラー型 — kitchen専用デバイスから呼び出すとFORBIDDENがResultにならず例外として伝播する（0004設計判断21, 25）", async () => {
    const { client, authUserId } = await createDeviceClient("kitchen", storeId);
    createdAuthUserIds.push(authUserId);
    const gateway = createStaffOperationsGateway(client);

    await expect(gateway.listRegisterFeed({ storeId })).rejects.toThrow();
  });
});
