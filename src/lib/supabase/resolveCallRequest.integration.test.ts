// @vitest-environment node
//
// 0004_rpc_staff_gateway.sql に追記されたresolve_call_request RPCを、ローカル
// Supabaseスタックに対する実際のデバイスセッション（device_role='register'の
// authenticatedクライアント）で検証する結合テスト。updateOrderItemStatus.
// integration.test.ts等と同じ構成: 事前に`npm run db:start`と
// `npm run db:reset`（0001〜0007を適用）が必要。
//
// 設計判断15（0004_rpc_staff_gateway.sql参照）: resolve_call_requestは要件2.4
// 「When レジスタッフが呼び出しに対応済みとして操作する」の主語が明確に
// 「レジスタッフ」であること、design.mdのComponents and Interfaces表が
// RegisterConsole(UI)の対応要件にのみ2.4を含めKitchenBoard(UI)には含めない
// ことから、device_role='register'限定のRPCと判断した。
//
// 【CONCERN、設計判断17参照】design.mdのService Interfaceはresolve_call_requestの
// エラー型として3.3のCallRequestError（{code:"SESSION_NOT_ACTIVE"}|
// {code:"CALL_ALREADY_OPEN"}）をそのまま再利用するよう指定しているが、本関数が
// 実際に送出するのはFORBIDDEN（P0403）とCALL_REQUEST_NOT_FOUND（P0445、本タスク
// で新規割当）のみであり、design.mdが指定するCallRequestErrorの2メンバーの
// どちらとも意味が一致しない（design.mdの型定義自体のgapと判断。レビューでの
// 確認を要する）。
//
// Requirements: 2.4
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. resolveCallRequest.integration.test.ts requires it ` +
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
// CALL_REQUEST_NOT_FOUNDは本タスク（4.4）で新規に割り当てる（設計判断17参照）。
const CALL_REQUEST_NOT_FOUND = "P0445";
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

interface CallRequestRow {
  id: string;
  status: string;
  resolved_at: string | null;
}

describe("0004_rpc_staff_gateway.sql: resolve_call_request RPC（結合テスト）", () => {
  const storeId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const sessionForCrossCheckId = randomUUID();

  const createdAuthUserIds: string[] = [];

  async function resolveCallRequest(client: SupabaseClient, callRequestId: string) {
    return client.rpc("resolve_call_request", {
      p_call_request_id: callRequestId,
    });
  }

  async function createCallRequestDirectly(
    targetSessionId: string,
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      "insert into call_requests (id, session_id, status) values ($1, $2, 'open')",
      [id, targetSessionId],
    );
    return id;
  }

  async function fetchCallRequest(callRequestId: string): Promise<CallRequestRow> {
    const result = await pool.query(
      "select id, status, resolved_at from call_requests where id = $1",
      [callRequestId],
    );
    return result.rows[0] as CallRequestRow;
  }

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "resolve_call_request結合テスト用店舗",
    ]);

    await pool.query(
      `insert into tables (id, store_id, label) values ($1, $2, $3), ($4, $2, $5)`,
      [tableId, storeId, "テスト卓", randomUUID(), "クロスチェック用卓"],
    );

    await pool.query(
      `insert into table_sessions (id, table_id, status, party_size)
       values ($1, $2, 'active', 2)`,
      [sessionId, tableId],
    );

    await pool.query(
      `insert into table_sessions (id, table_id, status, party_size)
       values ($1, (select id from tables where store_id = $2 and label = 'クロスチェック用卓'), 'active', 2)`,
      [sessionForCrossCheckId, storeId],
    );
  });

  afterAll(async () => {
    await pool.query("delete from call_requests where session_id = any($1)", [
      [sessionId, sessionForCrossCheckId],
    ]);
    await pool.query("delete from table_sessions where id = any($1)", [
      [sessionId, sessionForCrossCheckId],
    ]);
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

  it("openな呼び出しを対応済みにすると成功し、statusが'resolved'・resolved_atが設定される（要件2.4）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);
    const callRequestId = await createCallRequestDirectly(sessionId);

    const before = await fetchCallRequest(callRequestId);
    expect(before.status).toBe("open");
    expect(before.resolved_at).toBeNull();

    const { data, error } = await resolveCallRequest(client, callRequestId);

    expect(error).toBeNull();
    expect(data).toMatchObject({
      id: callRequestId,
      sessionId,
      status: "resolved",
    });
    expect(data.createdAt).toEqual(expect.any(String));
    // design.mdのCallRequest型はresolvedAtを持たないため、レスポンスにも
    // 含まれないことを確認する（設計判断18）。
    expect(data.resolvedAt).toBeUndefined();

    // DBへの直接問い合わせで実際の状態変化を確認する（観測可能な完了条件）。
    const after = await fetchCallRequest(callRequestId);
    expect(after.status).toBe("resolved");
    expect(after.resolved_at).not.toBeNull();
  });

  it("既にresolvedな呼び出しへ再度対応済み操作を行うとCALL_REQUEST_NOT_FOUNDで拒否される（設計判断17のCONCERN対応）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);
    const callRequestId = await createCallRequestDirectly(sessionId);

    const first = await resolveCallRequest(client, callRequestId);
    expect(first.error).toBeNull();

    const second = await resolveCallRequest(client, callRequestId);

    expect(second.data).toBeNull();
    expect(second.error).not.toBeNull();
    expect(second.error?.code).toBe(CALL_REQUEST_NOT_FOUND);

    const row = await fetchCallRequest(callRequestId);
    expect(row.status).toBe("resolved");
  });

  it("実在しないcallRequestIdに対してはCALL_REQUEST_NOT_FOUNDが返る", async () => {
    const { client, authUserId } = await createDeviceClient(
      "register",
      storeId,
    );
    createdAuthUserIds.push(authUserId);

    const { data, error } = await resolveCallRequest(client, randomUUID());

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(CALL_REQUEST_NOT_FOUND);
  });

  it("device_role='kitchen'のデバイスから呼び出すと拒否される（register限定操作であることの確認。design.md要件2.4がレジスタッフの操作と明記していることに基づく判断、設計判断15）", async () => {
    const { client, authUserId } = await createDeviceClient(
      "kitchen",
      storeId,
    );
    createdAuthUserIds.push(authUserId);
    const callRequestId = await createCallRequestDirectly(sessionId);

    const { data, error } = await resolveCallRequest(client, callRequestId);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(FORBIDDEN_DEVICE_ROLE);

    const row = await fetchCallRequest(callRequestId);
    expect(row.status).toBe("open");
  });

  it(
    "呼び出しを対応済みにした後、同一セッションへの新規create_call_requestが" +
      "成功するようになる（3.3のcall_requests_open_session_id_keyとの統合確認）",
    async () => {
      const { client, authUserId } = await createDeviceClient(
        "register",
        storeId,
      );
      createdAuthUserIds.push(authUserId);

      const anon = newAnonClient();

      const first = await anon.rpc("create_call_request", {
        p_session_id: sessionForCrossCheckId,
      });
      expect(first.error).toBeNull();

      // 対応済みになる前は、重複防止（CALL_ALREADY_OPEN）により2件目の
      // 新規作成が拒否されることを確認しておく（3.3の既存挙動の再確認）。
      const blocked = await anon.rpc("create_call_request", {
        p_session_id: sessionForCrossCheckId,
      });
      expect(blocked.data).toBeNull();
      expect(blocked.error?.code).toBe("P0412");

      const resolved = await resolveCallRequest(client, first.data.id);
      expect(resolved.error).toBeNull();

      const second = await anon.rpc("create_call_request", {
        p_session_id: sessionForCrossCheckId,
      });

      expect(second.error).toBeNull();
      expect(second.data.status).toBe("open");
      expect(second.data.id).not.toBe(first.data.id);

      const rows = await pool.query(
        "select id, status from call_requests where session_id = $1 order by created_at",
        [sessionForCrossCheckId],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]).toMatchObject({ id: first.data.id, status: "resolved" });
      expect(rows.rows[1]).toMatchObject({ id: second.data.id, status: "open" });
    },
  );
});
