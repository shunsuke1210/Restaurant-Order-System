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
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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

// resolveCallRequest.integration.test.ts / listRegisterFeed.integration.test.ts
// と同じ構成: device_role='register'のauthenticatedクライアントを、実際の
// 匿名サインイン+devices登録+セッションリフレッシュを経て組み立てる
// （resolve_call_requestを呼ぶために必要。0006_assert_device_role.sql参照）。
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

describe("0003_rpc_customer_gateway.sql: get_ordering_context RPC（結合テスト）", () => {
  const storeId = randomUUID();
  const tableNoSessionId = randomUUID();
  const tableWithSessionId = randomUUID();
  const tableActiveNoOrdersId = randomUUID();
  const tableCallLifecycleId = randomUUID();
  const menuItemId = randomUUID();
  const menuItemNoOptionsId = randomUUID();
  const soldOutMenuItemId = randomUUID();
  const activeSessionId = randomUUID();
  const activeNoOrdersSessionId = randomUUID();
  const callLifecycleSessionId = randomUUID();
  const orderId = randomUUID();
  const createdAuthUserIds: string[] = [];

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
       values ($1, $2, $3), ($4, $2, $5), ($6, $2, $7), ($8, $2, $9)`,
      [
        tableNoSessionId,
        storeId,
        "セッションなし卓",
        tableWithSessionId,
        "セッションあり卓",
        tableActiveNoOrdersId,
        "セッションあり・未注文卓",
        tableCallLifecycleId,
        "呼び出しライフサイクル検証卓",
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
       values ($1, $2, 'active', 2), ($3, $4, 'active', 4), ($5, $6, 'active', 2)`,
      [
        activeSessionId,
        tableWithSessionId,
        activeNoOrdersSessionId,
        tableActiveNoOrdersId,
        callLifecycleSessionId,
        tableCallLifecycleId,
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
    await pool.query("delete from call_requests where session_id = $1", [
      callLifecycleSessionId,
    ]);
    await pool.query(
      "delete from table_sessions where id in ($1, $2, $3)",
      [activeSessionId, activeNoOrdersSessionId, callLifecycleSessionId],
    );
    await pool.query("delete from menu_items where store_id = $1", [
      storeId,
    ]);
    await pool.query("delete from tables where store_id = $1", [storeId]);
    await pool.query("delete from devices where store_id = $1", [storeId]);
    await pool.query("delete from stores where id = $1", [storeId]);
    for (const authUserId of createdAuthUserIds) {
      try {
        await pool.query("delete from auth.users where id = $1", [
          authUserId,
        ]);
      } catch {
        // ベストエフォート。テストの合否には影響しない
        // （resolveCallRequest.integration.test.ts等と同じ後始末方針）。
      }
    }
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
    // アクティブセッションが無い卓は呼び出しボタン自体を表示しない（要件2.1）
    // ため意味を持たないが、booleanの契約を守りfalseで固定する
    // （0010_ordering_context_call_request.sql、listRegisterFeedの
    // 空席卓と同じ判断）。
    expect(data.hasOpenCallRequest).toBe(false);
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
    expect(data.hasOpenCallRequest).toBe(false);
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

  // ===========================================================================
  // タスク6.3: hasOpenCallRequestの全ライフサイクル（要件2.1, 2.2, 2.3）
  // listRegisterFeed.integration.test.tsの同名フィールドのライフサイクル
  // テスト（「呼び出し前はfalse→create_call_request後はtrue→
  // resolve_call_request後は再びfalseになる」）と全く同じ構成を、
  // get_ordering_context側（客の真のanonロール経路）に対して行う。
  // ===========================================================================
  it(
    "hasOpenCallRequest: 呼び出し前はfalse→create_call_request後はtrue→" +
      "resolve_call_request後は再びfalseになる（要件2.1, 2.2, 2.3の全ライフサイクル）",
    async () => {
      const anon = newAnonClient();

      const before = await anon.rpc("get_ordering_context", {
        p_table_id: tableCallLifecycleId,
      });
      expect(before.error).toBeNull();
      expect(before.data.hasOpenCallRequest).toBe(false);

      const createResult = await anon.rpc("create_call_request", {
        p_session_id: callLifecycleSessionId,
      });
      expect(createResult.error).toBeNull();
      const callRequestId = (createResult.data as { id: string }).id;

      const during = await anon.rpc("get_ordering_context", {
        p_table_id: tableCallLifecycleId,
      });
      expect(during.error).toBeNull();
      expect(during.data.hasOpenCallRequest).toBe(true);

      // resolve_call_request（4.4）はdevice_role='register'限定のRPCのため、
      // resolveCallRequest.integration.test.ts / listRegisterFeed.integration.
      // test.tsと同じ手順で実際のregisterデバイスセッションを組み立てて呼ぶ
      // （レジスタッフによる「対応済みにする」操作を実機同等の経路で再現する）。
      const { client: registerClient, authUserId } = await createDeviceClient(
        "register",
        storeId,
      );
      createdAuthUserIds.push(authUserId);

      const resolveResult = await registerClient.rpc("resolve_call_request", {
        p_call_request_id: callRequestId,
      });
      expect(resolveResult.error).toBeNull();

      const after = await anon.rpc("get_ordering_context", {
        p_table_id: tableCallLifecycleId,
      });
      expect(after.error).toBeNull();
      expect(after.data.hasOpenCallRequest).toBe(false);
    },
  );
});
