// @vitest-environment node
//
// 0003_rpc_customer_gateway.sql に追記されたcreate_call_request RPCを、ローカル
// Supabaseスタックに対する実際のanonキー・無サインインのsupabase-js呼び出しで
// 検証する結合テスト。submitOrder.integration.test.tsと同じ構成: 事前に
// `npm run db:start`と`npm run db:reset`（0001, 0002, 0003, 0005, 0006, 0007を
// 適用）が必要。
//
// 客側の経路は要件8.1「客に対し認証情報の入力を要求しない」に基づき、
// DeviceIdentityProviderの匿名サインイン（厨房/レジタブレット専用）を一切
// 経由しない、真の`anon`ロール呼び出しである。そのため本テストも
// signInAnonymously()を一度も呼ばず、生成直後のanonキークライアントで直接
// .rpc('create_call_request', ...)を呼び出す。
//
// tasks.md Implementation Notes（2.3で判明した教訓）に従い、環境変数には
// ハードコードされたfallback値を持たせず、未設定ならbeforeAll等より前に
// 明確なエラーで失敗させる（fail-fast）。ローカル開発用の既知の値は
// .env.local側に一元化し（唯一の情報源）、テストコード側では複製しない。
//
// Requirements: 2.1, 2.2, 2.3
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. createCallRequest.integration.test.ts requires it ` +
        "(see .env.local; vitest.config.mts loads it into process.env). " +
        "Run `npm run db:start` first if the local Supabase stack is not running.",
    );
  }
  return value;
}

const connectionString = requireEnv("SUPABASE_DB_URL");
const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supabaseAnonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

// 0003_rpc_customer_gateway.sqlがcreate_call_requestの検証失敗時に送出する
// カスタムSQLSTATE（本タスク3.3で新規に割り当て。設計判断参照）。
// SESSION_NOT_ACTIVEはsubmit_order（3.2）と同一の条件（対象セッションが
// activeでない）を表すため、submit_orderが確立した'P0409'をそのまま再利用する。
const SESSION_NOT_ACTIVE = "P0409";
const CALL_ALREADY_OPEN = "P0412";

const pool = new Pool({ connectionString });

function newAnonClient() {
  // 匿名サインイン（signInAnonymously）を一切呼ばない。生成直後のクライアントは
  // 完全な無認証状態のPostgREST anonロールとしてリクエストする（要件8.1）。
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function countCallRequestsForSession(sessionId: string): Promise<number> {
  const result = await pool.query(
    "select count(*)::int as count from call_requests where session_id = $1",
    [sessionId],
  );
  return result.rows[0].count as number;
}

async function createCallRequest(
  client: ReturnType<typeof newAnonClient>,
  sessionId: string,
) {
  return client.rpc("create_call_request", { p_session_id: sessionId });
}

describe("0003_rpc_customer_gateway.sql: create_call_request RPC（結合テスト）", () => {
  const storeId = randomUUID();
  const tableActiveId = randomUUID();
  const tableClosedId = randomUUID();
  const tableDedupId = randomUUID();
  const tableResolvedThenNewId = randomUUID();

  const activeSessionId = randomUUID();
  const closedSessionId = randomUUID();
  const dedupSessionId = randomUUID();
  const resolvedThenNewSessionId = randomUUID();

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "create_call_request結合テスト用店舗",
    ]);

    await pool.query(
      `insert into tables (id, store_id, label)
       values ($1, $2, $3), ($4, $2, $5), ($6, $2, $7), ($8, $2, $9)`,
      [
        tableActiveId,
        storeId,
        "アクティブ卓",
        tableClosedId,
        "終了済みセッション卓",
        tableDedupId,
        "重複呼び出し検証卓",
        tableResolvedThenNewId,
        "対応済み後の再呼び出し検証卓",
      ],
    );

    await pool.query(
      `insert into table_sessions (id, table_id, status, party_size)
       values
         ($1, $2, 'active', 2),
         ($3, $4, 'closed', 3),
         ($5, $6, 'active', 2),
         ($7, $8, 'active', 2)`,
      [
        activeSessionId,
        tableActiveId,
        closedSessionId,
        tableClosedId,
        dedupSessionId,
        tableDedupId,
        resolvedThenNewSessionId,
        tableResolvedThenNewId,
      ],
    );
  });

  afterAll(async () => {
    await pool.query("delete from call_requests where session_id = any($1)", [
      [activeSessionId, closedSessionId, dedupSessionId, resolvedThenNewSessionId],
    ]);
    await pool.query("delete from table_sessions where id = any($1)", [
      [activeSessionId, closedSessionId, dedupSessionId, resolvedThenNewSessionId],
    ]);
    await pool.query("delete from tables where store_id = $1", [storeId]);
    await pool.query("delete from stores where id = $1", [storeId]);
    await pool.end();
  });

  it("未対応の呼び出しがないセッションへの1回目の呼び出しは成功し、status: 'open'の新規行が作られる（要件2.1, 2.2）", async () => {
    const supabase = newAnonClient();

    const { data, error } = await createCallRequest(supabase, activeSessionId);

    expect(error).toBeNull();
    expect(data.id).toEqual(expect.any(String));
    expect(data.sessionId).toBe(activeSessionId);
    expect(data.status).toBe("open");
    expect(data.createdAt).toEqual(expect.any(String));

    const dbRows = await pool.query(
      "select id, status from call_requests where session_id = $1",
      [activeSessionId],
    );
    expect(dbRows.rows).toEqual([
      expect.objectContaining({ id: data.id, status: "open" }),
    ]);
  });

  it("未対応の呼び出しが既に存在するセッションへ連続して呼び出すと、call_requestsの行が1件のまま増えず、CALL_ALREADY_OPENが返る（観測可能な完了条件, 要件2.3）", async () => {
    const supabase = newAnonClient();

    const first = await createCallRequest(supabase, dedupSessionId);
    expect(first.error).toBeNull();

    const beforeCount = await countCallRequestsForSession(dedupSessionId);

    const second = await createCallRequest(supabase, dedupSessionId);

    expect(second.data).toBeNull();
    expect(second.error).not.toBeNull();
    expect(second.error?.code).toBe(CALL_ALREADY_OPEN);
    expect(second.error?.details).toBe(first.data.id);

    // RPCの応答だけでなく、DBへ実際に2件目のcall_requestsが挿入されていない
    // ことを直接クエリで確認する（本タスクの観測可能な完了条件そのもの）。
    const afterCount = await countCallRequestsForSession(dedupSessionId);
    expect(afterCount).toBe(beforeCount);
    expect(afterCount).toBe(1);
  });

  it("終了済み(closed)セッションへの呼び出しはSESSION_NOT_ACTIVEで拒否され、何も挿入されない", async () => {
    const supabase = newAnonClient();

    const { data, error } = await createCallRequest(supabase, closedSessionId);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(SESSION_NOT_ACTIVE);

    const count = await countCallRequestsForSession(closedSessionId);
    expect(count).toBe(0);
  });

  it("存在しないsessionIdへの呼び出しはSESSION_NOT_ACTIVEで拒否される", async () => {
    const supabase = newAnonClient();

    const { data, error } = await createCallRequest(supabase, randomUUID());

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe(SESSION_NOT_ACTIVE);
  });

  it("既存の呼び出しがresolvedになった後の新規呼び出しは、未対応(open)の重複とはみなされず成功し、2件目(合計)の行が作られる", async () => {
    const supabase = newAnonClient();

    const first = await createCallRequest(supabase, resolvedThenNewSessionId);
    expect(first.error).toBeNull();

    // resolveCallRequest（4.4, 本タスクのスコープ外）はまだ実装されていないため、
    // 「対応済みにする」操作を直接SQLで再現する。
    await pool.query(
      "update call_requests set status = 'resolved', resolved_at = now() where id = $1",
      [first.data.id],
    );

    const second = await createCallRequest(supabase, resolvedThenNewSessionId);

    expect(second.error).toBeNull();
    expect(second.data.id).not.toBe(first.data.id);
    expect(second.data.status).toBe("open");

    const rows = await pool.query(
      "select id, status from call_requests where session_id = $1 order by created_at",
      [resolvedThenNewSessionId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ id: first.data.id, status: "resolved" });
    expect(rows.rows[1]).toMatchObject({ id: second.data.id, status: "open" });
  });
});
