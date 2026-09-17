// @vitest-environment node
//
// 0004_rpc_staff_gateway.sql に追記されたlist_register_feed RPCを、ローカル
// Supabaseスタックに対する実際のデバイスセッション（device_role='register'の
// authenticatedクライアント）で検証する結合テスト。updateOrderItemStatus.
// integration.test.ts/resolveCallRequest.integration.test.tsと同じ構成: 事前に
// `npm run db:start`と`npm run db:reset`（0001〜0007を適用）が必要。
//
// design.md StaffOperationsGateway Responsibilities & Constraints:
// 「listRegisterFeedは各卓の現在アクティブなセッションの人数・注文明細・合計
// 金額を返す（要件5.1, 5.4）。アクティブセッションがない卓はactiveSession: null
// として返す（要件5.2）。この合計計算はCustomerOrderingGateway.
// getOrderingContextが返すconfirmedTotalと同一のロジックを共有する」
// 「listRegisterFeedは...未対応(open)の呼び出しが存在するかをhasOpenCallRequest
// として返す（要件2.2）」。タスク4.5の設計判断21により、本RPCは
// assert_device_role(array['register'])のみを許可する。
//
// タスク8.3で更新（0012_list_register_feed_item_id.sql）: 各明細に
// id（order_items.id、removeOrderItemの対象識別に必須）・optionsSummary・
// statusを追加した。本ファイルの既存テストは`toMatchObject`/
// `objectContaining`で部分一致するのみのため追加フィールドがあっても
// 元々失敗しないが、拡張そのものを直接検証する新しいテストを追加する。
//
// タスク8.4で更新（0014_list_register_feed_item_genre.sql）: 各明細に
// genre（list_kitchen_feedと同じmenu_itemsへのjoinで取得。statusの
// ジャンルに応じた日本語表示・進めるボタンの次ステータス判定に必須）を
// 追加した。0012と同じ理由で、拡張そのものを直接検証する新しいテストを
// 追加する。
//
// タスク8.6で更新（0015_list_register_feed_open_call_request_id.sql）: 卓
// レベルにopenCallRequestId（対象のcall_requests.id、無ければnull）を
// 追加した。resolveCallRequest（{callRequestId}）の対象識別に必須。
// 既存のhasOpenCallRequestの全ライフサイクルテストと対にして、
// openCallRequestIdが同じ3段階（呼び出し前null→作成後に実IDを返す→
// resolve後に再びnull）を正しく追跡することを検証する新しいテストを追加する。
//
// Requirements: 2.2, 2.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. listRegisterFeed.integration.test.ts requires it ` +
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

interface TableBillingSummary {
  tableId: string;
  tableLabel: string;
  activeSession: { id: string; startedAt: string; partySize: number } | null;
  items: ReadonlyArray<{
    id: string;
    menuItemId: string;
    name: string;
    quantity: number;
    unitPrice: number;
    optionsSummary: string | null;
    status: string;
    genre: string;
  }>;
  total: number;
  hasOpenCallRequest: boolean;
  openCallRequestId: string | null;
}

async function callListRegisterFeed(
  client: SupabaseClient,
  storeId: string,
): Promise<{
  data: TableBillingSummary[] | null;
  error: { code?: string } | null;
}> {
  const result = await client.rpc("list_register_feed", {
    p_store_id: storeId,
  });
  return result as never;
}

async function callGetOrderingContext(
  client: SupabaseClient,
  tableId: string,
): Promise<{ data: { confirmedTotal: number } | null; error: unknown }> {
  const result = await client.rpc("get_ordering_context", {
    p_table_id: tableId,
  });
  return result as never;
}

describe("0004_rpc_staff_gateway.sql: list_register_feed RPC（結合テスト）", () => {
  const storeId = randomUUID();
  const vacantTableId = randomUUID();
  const occupiedTableId = randomUUID();
  const kitchenOnlyTableId = randomUUID(); // FORBIDDENテスト専用の追加卓（無関係の副作用を避けるため独立させる）

  const occupiedSessionId = randomUUID();

  const menuItemAId = randomUUID();
  const menuItemBId = randomUUID();

  const createdAuthUserIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdCallRequestIds: string[] = [];

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "list_register_feed結合テスト用店舗",
    ]);

    await pool.query(
      `insert into tables (id, store_id, label)
       values ($1, $2, $3), ($4, $2, $5), ($6, $2, $7)`,
      [
        vacantTableId,
        storeId,
        "空席卓",
        occupiedTableId,
        "来店中卓",
        kitchenOnlyTableId,
        "予備卓",
      ],
    );

    await pool.query(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values
         ($1, $2, 'Item A', 700, false, 'food', '[]'::jsonb),
         ($3, $2, 'Item B', 300, false, 'drink', '[]'::jsonb)`,
      [menuItemAId, storeId, menuItemBId],
    );

    await pool.query(
      `insert into table_sessions (id, table_id, status, party_size)
       values ($1, $2, 'active', 3)`,
      [occupiedSessionId, occupiedTableId],
    );

    // occupiedSessionIdに2件の注文明細を投入する（総額 = 700*2 + 300*1 = 1700）。
    const orderId = randomUUID();
    await pool.query(
      "insert into orders (id, session_id, idempotency_key) values ($1, $2, $3)",
      [orderId, occupiedSessionId, `test-seed-${randomUUID()}`],
    );
    createdOrderIds.push(orderId);

    await pool.query(
      `insert into order_items
         (id, order_id, menu_item_id, name_snapshot, unit_price_snapshot, quantity, status)
       values
         ($1, $2, $3, 'Item A', 700, 2, 'received'),
         ($4, $2, $5, 'Item B', 300, 1, 'received')`,
      [randomUUID(), orderId, menuItemAId, randomUUID(), menuItemBId],
    );
  });

  afterAll(async () => {
    if (createdCallRequestIds.length > 0) {
      await pool.query("delete from call_requests where id = any($1)", [
        createdCallRequestIds,
      ]);
    }
    if (createdOrderIds.length > 0) {
      await pool.query("delete from order_items where order_id = any($1)", [
        createdOrderIds,
      ]);
      await pool.query("delete from orders where id = any($1)", [
        createdOrderIds,
      ]);
    }
    await pool.query("delete from call_requests where session_id = $1", [
      occupiedSessionId,
    ]);
    await pool.query("delete from table_sessions where table_id = any($1)", [
      [vacantTableId, occupiedTableId, kitchenOnlyTableId],
    ]);
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

  it("全卓が一覧に含まれる（空席卓も除外されない、要件5.4）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await callListRegisterFeed(client, storeId);
    expect(error).toBeNull();
    expect(data).not.toBeNull();

    const tableIds = (data as TableBillingSummary[]).map((row) => row.tableId);
    expect(tableIds).toEqual(
      expect.arrayContaining([vacantTableId, occupiedTableId, kitchenOnlyTableId]),
    );
  });

  it("空席卓はactiveSession: null, items: [], total: 0, hasOpenCallRequest: falseを返す（要件5.2）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await callListRegisterFeed(client, storeId);
    expect(error).toBeNull();

    const row = (data as TableBillingSummary[]).find(
      (r) => r.tableId === vacantTableId,
    );
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      tableId: vacantTableId,
      tableLabel: "空席卓",
      activeSession: null,
      items: [],
      total: 0,
      hasOpenCallRequest: false,
      openCallRequestId: null,
    });
  });

  it("来店中卓は正しいactiveSession・items・totalを返す（要件5.1, 5.3）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await callListRegisterFeed(client, storeId);
    expect(error).toBeNull();

    const row = (data as TableBillingSummary[]).find(
      (r) => r.tableId === occupiedTableId,
    );
    expect(row).toBeDefined();
    expect(row?.activeSession).toMatchObject({
      id: occupiedSessionId,
      partySize: 3,
    });
    expect(row?.activeSession?.startedAt).toBeDefined();
    expect(row?.items).toHaveLength(2);
    expect(row?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          menuItemId: menuItemAId,
          name: "Item A",
          quantity: 2,
          unitPrice: 700,
        }),
        expect.objectContaining({
          menuItemId: menuItemBId,
          name: "Item B",
          quantity: 1,
          unitPrice: 300,
        }),
      ]),
    );
    expect(row?.total).toBe(1700);
  });

  it("各明細にid（order_items.idそのもの、他明細と重複しない）とoptionsSummary/statusを含む（タスク8.3、要件5.5, 5.6）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await callListRegisterFeed(client, storeId);
    expect(error).toBeNull();

    const row = (data as TableBillingSummary[]).find(
      (r) => r.tableId === occupiedTableId,
    );
    expect(row).toBeDefined();
    expect(row?.items).toHaveLength(2);

    // idは実在するorder_items.idであり、明細間で重複しない
    // （removeOrderItem({orderItemId})が対象を一意に識別できることの根拠）。
    const ids = row?.items.map((item) => item.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }

    const itemA = row?.items.find((item) => item.menuItemId === menuItemAId);
    expect(itemA).toMatchObject({
      name: "Item A",
      status: "received",
    });
    // シードしたorder_itemsはoptions_summaryを指定していないためnullになる。
    expect(itemA?.optionsSummary).toBeNull();
  });

  it("各明細にmenu_items.genreをそのまま返す（タスク8.4、list_kitchen_feedと同じjoinパターン。要件5.7）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await callListRegisterFeed(client, storeId);
    expect(error).toBeNull();

    const row = (data as TableBillingSummary[]).find(
      (r) => r.tableId === occupiedTableId,
    );
    expect(row).toBeDefined();

    const itemA = row?.items.find((item) => item.menuItemId === menuItemAId);
    const itemB = row?.items.find((item) => item.menuItemId === menuItemBId);
    // beforeAllでmenuItemAは'food'、menuItemBは'drink'としてシードしている。
    expect(itemA?.genre).toBe("food");
    expect(itemB?.genre).toBe("drink");
  });

  it(
    "total は get_ordering_context の confirmedTotal と完全に一致する" +
      "（design.mdが明示的に要求する、同一ロジック共有のクロスRPC検証。1.12, 5.1）",
    async () => {
      const registerDevice = await createDeviceClient("register", storeId);
      createdAuthUserIds.push(registerDevice.authUserId);
      const anonClient = newAnonClient();

      const [registerResult, customerResult] = await Promise.all([
        callListRegisterFeed(registerDevice.client, storeId),
        callGetOrderingContext(anonClient, occupiedTableId),
      ]);

      expect(registerResult.error).toBeNull();
      expect(customerResult.error).toBeNull();

      const row = (registerResult.data as TableBillingSummary[]).find(
        (r) => r.tableId === occupiedTableId,
      );
      expect(row).toBeDefined();
      expect(customerResult.data).not.toBeNull();

      // 同一セッションについて、レジ側のtotalと客側のconfirmedTotalは
      // 常に同じ値でなければならない（design.mdの明示的な要求）。
      expect(row?.total).toBe(
        (customerResult.data as { confirmedTotal: number }).confirmedTotal,
      );
    },
  );

  it(
    "hasOpenCallRequest: 呼び出し前はfalse→create_call_request後はtrue→" +
      "resolve_call_request後は再びfalseになる（要件2.2の全ライフサイクル）",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "register",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const anonClient = newAnonClient();

      const before = await callListRegisterFeed(client, storeId);
      expect(before.error).toBeNull();
      const beforeRow = (before.data as TableBillingSummary[]).find(
        (r) => r.tableId === occupiedTableId,
      );
      expect(beforeRow?.hasOpenCallRequest).toBe(false);

      const createResult = await anonClient.rpc("create_call_request", {
        p_session_id: occupiedSessionId,
      });
      expect(createResult.error).toBeNull();
      const callRequestId = (createResult.data as { id: string }).id;
      createdCallRequestIds.push(callRequestId);

      const during = await callListRegisterFeed(client, storeId);
      expect(during.error).toBeNull();
      const duringRow = (during.data as TableBillingSummary[]).find(
        (r) => r.tableId === occupiedTableId,
      );
      expect(duringRow?.hasOpenCallRequest).toBe(true);

      const resolveResult = await client.rpc("resolve_call_request", {
        p_call_request_id: callRequestId,
      });
      expect(resolveResult.error).toBeNull();

      const after = await callListRegisterFeed(client, storeId);
      expect(after.error).toBeNull();
      const afterRow = (after.data as TableBillingSummary[]).find(
        (r) => r.tableId === occupiedTableId,
      );
      expect(afterRow?.hasOpenCallRequest).toBe(false);
    },
  );

  it(
    "openCallRequestId: 呼び出し前はnull→create_call_request後は実在の" +
      "call_requests.idを返す→resolve_call_request後は再びnullになる" +
      "（タスク8.6、要件2.4の全ライフサイクル。resolveCallRequestの対象" +
      "識別に用いる実際のIDであることをDB直接クエリで検証する）",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "register",
        storeId,
      );
      createdAuthUserIds.push(authUserId);
      const anonClient = newAnonClient();

      const before = await callListRegisterFeed(client, storeId);
      expect(before.error).toBeNull();
      const beforeRow = (before.data as TableBillingSummary[]).find(
        (r) => r.tableId === occupiedTableId,
      );
      expect(beforeRow?.openCallRequestId).toBeNull();

      const createResult = await anonClient.rpc("create_call_request", {
        p_session_id: occupiedSessionId,
      });
      expect(createResult.error).toBeNull();
      const callRequestId = (createResult.data as { id: string }).id;
      createdCallRequestIds.push(callRequestId);

      const during = await callListRegisterFeed(client, storeId);
      expect(during.error).toBeNull();
      const duringRow = (during.data as TableBillingSummary[]).find(
        (r) => r.tableId === occupiedTableId,
      );
      // list_register_feedが返すIDが、実際にDBに存在するopenなcall_requests
      // 行のidと完全に一致すること（resolveCallRequestの対象識別に安全に
      // 使えることの根拠）。
      expect(duringRow?.openCallRequestId).toBe(callRequestId);
      const dbRow = await pool.query(
        "select status from call_requests where id = $1",
        [callRequestId],
      );
      expect(dbRow.rows[0]?.status).toBe("open");

      const resolveResult = await client.rpc("resolve_call_request", {
        p_call_request_id: callRequestId,
      });
      expect(resolveResult.error).toBeNull();

      const after = await callListRegisterFeed(client, storeId);
      expect(after.error).toBeNull();
      const afterRow = (after.data as TableBillingSummary[]).find(
        (r) => r.tableId === occupiedTableId,
      );
      expect(afterRow?.openCallRequestId).toBeNull();
    },
  );

  it("kitchenロールのデバイスから呼び出すとFORBIDDENで拒否される（list_kitchen_feedとは相互排他的な読者。設計判断21）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "kitchen",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await callListRegisterFeed(client, storeId);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(FORBIDDEN_DEVICE_ROLE);
  });
});
