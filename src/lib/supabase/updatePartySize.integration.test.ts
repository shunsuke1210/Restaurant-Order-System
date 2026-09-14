// @vitest-environment node
//
// 0004_rpc_staff_gateway.sql のupdate_party_size RPCを、ローカルSupabase
// スタックに対する実際のデバイスセッション（device_role='register'の
// authenticatedクライアント）で検証する結合テスト。startSession.
// integration.test.tsと同じ構成: 事前に`npm run db:start`と`npm run db:reset`
// （0001〜0007を適用）が必要。device_role claim付きクライアントの用意手順
// （匿名サインイン→devices行追加→refreshSession）も同一。
//
// Requirements: 3.5
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. updatePartySize.integration.test.ts requires it ` +
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
const SESSION_NOT_ACTIVE = "P0409";
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

describe("0004_rpc_staff_gateway.sql: update_party_size RPC（結合テスト）", () => {
  const storeId = randomUUID();
  const tableActiveId = randomUUID();
  const tableClosedId = randomUUID();
  const tableForRoleCheckId = randomUUID();

  const activeSessionId = randomUUID();
  const closedSessionId = randomUUID();
  const roleCheckSessionId = randomUUID();

  const createdAuthUserIds: string[] = [];

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "update_party_size結合テスト用店舗",
    ]);

    await pool.query(
      `insert into tables (id, store_id, label)
       values ($1, $2, $3), ($4, $2, $5), ($6, $2, $7)`,
      [
        tableActiveId,
        storeId,
        "来店中卓",
        tableClosedId,
        "会計済み卓",
        tableForRoleCheckId,
        "権限確認用卓",
      ],
    );

    await pool.query(
      `insert into table_sessions (id, table_id, status, party_size)
       values
         ($1, $2, 'active', 2),
         ($3, $4, 'closed', 3),
         ($5, $6, 'active', 2)`,
      [
        activeSessionId,
        tableActiveId,
        closedSessionId,
        tableClosedId,
        roleCheckSessionId,
        tableForRoleCheckId,
      ],
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
    "アクティブなセッションの人数を変更すると成功し、新しい人数が永続化される（要件3.5）",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "register",
        storeId,
      );
      createdAuthUserIds.push(authUserId);

      const { data, error } = await client.rpc("update_party_size", {
        p_session_id: activeSessionId,
        p_party_size: 6,
      });

      expect(error).toBeNull();
      expect(data).toMatchObject({
        id: activeSessionId,
        tableId: tableActiveId,
        status: "active",
        partySize: 6,
      });

      const dbRow = await pool.query(
        "select party_size from table_sessions where id = $1",
        [activeSessionId],
      );
      expect(dbRow.rows[0].party_size).toBe(6);
    },
    30_000,
  );

  it(
    "会計済み（closed）のセッションに対して呼び出すとSESSION_NOT_ACTIVEが返り、人数は変更されない（観測可能な完了条件, 要件3.5）",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "register",
        storeId,
      );
      createdAuthUserIds.push(authUserId);

      const before = await pool.query(
        "select party_size from table_sessions where id = $1",
        [closedSessionId],
      );

      const { data, error } = await client.rpc("update_party_size", {
        p_session_id: closedSessionId,
        p_party_size: 10,
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(SESSION_NOT_ACTIVE);

      const after = await pool.query(
        "select party_size from table_sessions where id = $1",
        [closedSessionId],
      );
      expect(after.rows[0].party_size).toBe(before.rows[0].party_size);
    },
    30_000,
  );

  it(
    "存在しないセッションidに対して呼び出すとSESSION_NOT_ACTIVEが返る",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "register",
        storeId,
      );
      createdAuthUserIds.push(authUserId);

      const { data, error } = await client.rpc("update_party_size", {
        p_session_id: randomUUID(),
        p_party_size: 2,
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(SESSION_NOT_ACTIVE);
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

      const before = await pool.query(
        "select party_size from table_sessions where id = $1",
        [roleCheckSessionId],
      );

      const { data, error } = await client.rpc("update_party_size", {
        p_session_id: roleCheckSessionId,
        p_party_size: 9,
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(FORBIDDEN_DEVICE_ROLE);

      const after = await pool.query(
        "select party_size from table_sessions where id = $1",
        [roleCheckSessionId],
      );
      expect(after.rows[0].party_size).toBe(before.rows[0].party_size);
    },
    30_000,
  );
});
