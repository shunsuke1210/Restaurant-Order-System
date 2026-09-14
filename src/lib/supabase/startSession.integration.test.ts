// @vitest-environment node
//
// 0004_rpc_staff_gateway.sql のstart_session RPCを、ローカルSupabaseスタックに
// 対する実際のデバイスセッション（匿名サインイン＋devices登録＋トークン
// リフレッシュでdevice_roleクレームを持たせたauthenticatedクライアント）で
// 検証する結合テスト。customAccessTokenHook.integration.test.ts /
// provisionDevice.integration.test.ts / assertDeviceRole.integration.test.ts
// と同じ「匿名サインイン→devicesテーブルへの行追加→refreshSession」の手順で
// device_role claim付きのJWTを持つクライアントを用意する。事前に
// `npm run db:start`と`npm run db:reset`（0001〜0007を適用）が必要。
//
// tasks.md Implementation Notes（2.3で判明した教訓）に従い、環境変数には
// ハードコードされたfallback値を持たせず、未設定ならbeforeAll等より前に
// 明確なエラーで失敗させる（fail-fast、submitOrder.integration.test.ts等の
// 最新の慣習に合わせる）。
//
// Requirements: 3.1, 3.2, 3.4, 4.1
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. startSession.integration.test.ts requires it ` +
        "(see .env.local; vitest.config.mts loads it into process.env). " +
        "Run `npm run db:start` first if the local Supabase stack is not running.",
    );
  }
  return value;
}

const connectionString = requireEnv("SUPABASE_DB_URL");
const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supabaseAnonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

// 0004_rpc_staff_gateway.sqlが送出するカスタムSQLSTATE（設計判断2参照）。
const TABLE_NOT_FOUND = "P0404";
const SESSION_ALREADY_ACTIVE = "P0423";
// 0006_assert_device_role.sqlが送出するカスタムSQLSTATE（FORBIDDEN相当）。
const FORBIDDEN_DEVICE_ROLE = "P0403";

const pool = new Pool({ connectionString });

function newAnonClient() {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * 匿名サインイン→devicesテーブルへの行追加→refreshSessionという、
 * このリポジトリで確立済みの手順（customAccessTokenHook.integration.test.ts等）で、
 * device_role claim付きのJWTを持つauthenticatedクライアントを用意する。
 */
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

/** 匿名サインインのみ（devices行なし＝客の匿名セッションを模す）のクライアント。 */
async function createPlainAnonSession(): Promise<SupabaseClient> {
  const client = newAnonClient();
  const signInResult = await client.auth.signInAnonymously();
  expect(signInResult.error).toBeNull();
  return client;
}

describe("0004_rpc_staff_gateway.sql: start_session RPC（結合テスト）", () => {
  const storeId = randomUUID();
  const tableNoSessionId = randomUUID();
  const tableWithActiveSessionId = randomUUID();
  const tableForRoleChecksId = randomUUID();
  const existingActiveSessionId = randomUUID();
  const createdAuthUserIds: string[] = [];

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "start_session結合テスト用店舗",
    ]);

    await pool.query(
      `insert into tables (id, store_id, label)
       values ($1, $2, $3), ($4, $2, $5), ($6, $2, $7)`,
      [
        tableNoSessionId,
        storeId,
        "空席卓",
        tableWithActiveSessionId,
        "来店中卓",
        tableForRoleChecksId,
        "権限確認用卓",
      ],
    );

    await pool.query(
      `insert into table_sessions (id, table_id, status, party_size)
       values ($1, $2, 'active', 2)`,
      [existingActiveSessionId, tableWithActiveSessionId],
    );
  });

  afterAll(async () => {
    await pool.query(
      "delete from table_sessions where table_id in (select id from tables where store_id = $1)",
      [storeId],
    );
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

  it(
    "アクティブセッションのない卓に対して呼び出すと成功し、指定したpartySizeが記録される（要件3.1, 3.4）",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "register",
        storeId,
      );
      createdAuthUserIds.push(authUserId);

      const { data, error } = await client.rpc("start_session", {
        p_table_id: tableNoSessionId,
        p_party_size: 4,
      });

      expect(error).toBeNull();
      expect(data).toMatchObject({
        tableId: tableNoSessionId,
        status: "active",
        closedAt: null,
        partySize: 4,
      });
      expect(data.id).toEqual(expect.any(String));
      expect(data.startedAt).toEqual(expect.any(String));

      const dbRow = await pool.query(
        "select status, party_size, closed_at from table_sessions where id = $1",
        [data.id],
      );
      expect(dbRow.rows).toEqual([
        { status: "active", party_size: 4, closed_at: null },
      ]);
    },
    30_000,
  );

  it(
    "既にアクティブセッションがある卓に対して呼び出すと、既存セッションのidを含むSESSION_ALREADY_ACTIVEが返り、2件目のアクティブセッションは作られない（観測可能な完了条件, 要件3.2, 4.1）",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "register",
        storeId,
      );
      createdAuthUserIds.push(authUserId);

      const { data, error } = await client.rpc("start_session", {
        p_table_id: tableWithActiveSessionId,
        p_party_size: 3,
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(SESSION_ALREADY_ACTIVE);
      expect(error?.details).toBe(existingActiveSessionId);

      // 不変条件の確認: この卓に対するアクティブセッションは依然として1件のみ。
      const activeSessions = await pool.query(
        "select id from table_sessions where table_id = $1 and status = 'active'",
        [tableWithActiveSessionId],
      );
      expect(activeSessions.rows).toEqual([{ id: existingActiveSessionId }]);
    },
    30_000,
  );

  it(
    "存在しない卓idに対して呼び出すとTABLE_NOT_FOUNDが返る",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "register",
        storeId,
      );
      createdAuthUserIds.push(authUserId);

      const { data, error } = await client.rpc("start_session", {
        p_table_id: randomUUID(),
        p_party_size: 2,
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(TABLE_NOT_FOUND);
    },
    30_000,
  );

  it(
    "device_role='kitchen'のデバイスから呼び出すと拒否される（register限定操作であることの確認）",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "kitchen",
        storeId,
      );
      createdAuthUserIds.push(authUserId);

      const { data, error } = await client.rpc("start_session", {
        p_table_id: tableForRoleChecksId,
        p_party_size: 2,
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(FORBIDDEN_DEVICE_ROLE);

      const activeSessions = await pool.query(
        "select id from table_sessions where table_id = $1 and status = 'active'",
        [tableForRoleChecksId],
      );
      expect(activeSessions.rows).toHaveLength(0);
    },
    30_000,
  );

  it(
    "device_roleクレームを持たない匿名セッション（客側と同じ経路）から呼び出すと拒否される",
    async () => {
      const client = await createPlainAnonSession();

      const { data, error } = await client.rpc("start_session", {
        p_table_id: tableForRoleChecksId,
        p_party_size: 2,
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(FORBIDDEN_DEVICE_ROLE);
    },
    30_000,
  );

  it(
    "匿名サインインすらしていない場合（真のanonロール）は呼び出し自体が失敗する",
    async () => {
      const client = newAnonClient();

      const { data, error } = await client.rpc("start_session", {
        p_table_id: tableForRoleChecksId,
        p_party_size: 2,
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    },
    30_000,
  );
});
