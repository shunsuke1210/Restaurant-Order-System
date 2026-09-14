// @vitest-environment node
//
// 0004_rpc_staff_gateway.sql のclose_session RPCを、ローカルSupabaseスタックに
// 対する実際のデバイスセッション（device_role='register'のauthenticated
// クライアント）で検証する結合テスト。startSession.integration.test.tsと
// 同じ構成: 事前に`npm run db:start`と`npm run db:reset`（0001〜0007を適用）が
// 必要。device_role claim付きクライアントの用意手順（匿名サインイン→devices
// 行追加→refreshSession）もstartSession.integration.test.tsと同一。
//
// Requirements: 3.3, 4.2, 4.3, 4.4
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. closeSession.integration.test.ts requires it ` +
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

describe("0004_rpc_staff_gateway.sql: close_session RPC（結合テスト）", () => {
  const storeId = randomUUID();
  const tableActiveId = randomUUID();
  const tableAlreadyClosedId = randomUUID();
  const tableForRoleCheckId = randomUUID();
  const tableForReopenId = randomUUID();

  const activeSessionId = randomUUID();
  const alreadyClosedSessionId = randomUUID();
  const roleCheckSessionId = randomUUID();

  const createdAuthUserIds: string[] = [];

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "close_session結合テスト用店舗",
    ]);

    await pool.query(
      `insert into tables (id, store_id, label)
       values ($1, $2, $3), ($4, $2, $5), ($6, $2, $7), ($8, $2, $9)`,
      [
        tableActiveId,
        storeId,
        "来店中卓",
        tableAlreadyClosedId,
        "会計済み卓",
        tableForRoleCheckId,
        "権限確認用卓",
        tableForReopenId,
        "再入店確認用卓",
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
        alreadyClosedSessionId,
        tableAlreadyClosedId,
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
    "アクティブなセッションを終了すると成功し、status='closed'・closed_atが設定される（要件3.3）",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "register",
        storeId,
      );
      createdAuthUserIds.push(authUserId);

      const { data, error } = await client.rpc("close_session", {
        p_session_id: activeSessionId,
      });

      expect(error).toBeNull();
      expect(data).toMatchObject({
        id: activeSessionId,
        tableId: tableActiveId,
        status: "closed",
      });
      expect(data.closedAt).toEqual(expect.any(String));

      const dbRow = await pool.query(
        "select status, closed_at from table_sessions where id = $1",
        [activeSessionId],
      );
      expect(dbRow.rows[0].status).toBe("closed");
      expect(dbRow.rows[0].closed_at).not.toBeNull();
    },
    30_000,
  );

  it(
    "既に会計済み（closed）のセッションに対して呼び出すとSESSION_NOT_ACTIVEが返り、closed_atは変化しない",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "register",
        storeId,
      );
      createdAuthUserIds.push(authUserId);

      const before = await pool.query(
        "select closed_at from table_sessions where id = $1",
        [alreadyClosedSessionId],
      );

      const { data, error } = await client.rpc("close_session", {
        p_session_id: alreadyClosedSessionId,
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(SESSION_NOT_ACTIVE);

      const after = await pool.query(
        "select closed_at from table_sessions where id = $1",
        [alreadyClosedSessionId],
      );
      expect(after.rows[0].closed_at).toEqual(before.rows[0].closed_at);
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

      const { data, error } = await client.rpc("close_session", {
        p_session_id: randomUUID(),
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

      const { data, error } = await client.rpc("close_session", {
        p_session_id: roleCheckSessionId,
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe(FORBIDDEN_DEVICE_ROLE);

      const dbRow = await pool.query(
        "select status from table_sessions where id = $1",
        [roleCheckSessionId],
      );
      expect(dbRow.rows[0].status).toBe("active");
    },
    30_000,
  );

  it(
    "セッション終了後、同じ卓に対するstart_sessionは成功し、直前に終了したセッションとは異なる新しいidが発行される（要件4.4「独立した識別子」）",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "register",
        storeId,
      );
      createdAuthUserIds.push(authUserId);

      // 前提: この卓には現在アクティブなセッションが存在する状態から始める。
      const setupSession = await pool.query(
        `insert into table_sessions (table_id, status, party_size)
         values ($1, 'active', 2)
         returning id`,
        [tableForReopenId],
      );
      const oldSessionId = setupSession.rows[0].id as string;

      const closeResult = await client.rpc("close_session", {
        p_session_id: oldSessionId,
      });
      expect(closeResult.error).toBeNull();

      const reopenResult = await client.rpc("start_session", {
        p_table_id: tableForReopenId,
        p_party_size: 5,
      });

      expect(reopenResult.error).toBeNull();
      const newSessionId = reopenResult.data.id as string;
      expect(newSessionId).not.toBe(oldSessionId);
      expect(reopenResult.data).toMatchObject({
        tableId: tableForReopenId,
        status: "active",
        closedAt: null,
        partySize: 5,
      });

      // 旧セッションは引き続きclosedのまま履歴として残っている（要件4.3）。
      const oldSessionRow = await pool.query(
        "select status from table_sessions where id = $1",
        [oldSessionId],
      );
      expect(oldSessionRow.rows[0].status).toBe("closed");
    },
    30_000,
  );
});
