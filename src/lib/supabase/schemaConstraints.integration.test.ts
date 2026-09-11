// @vitest-environment node
//
// 0001_schema.sql の制約を、ローカルSupabase Postgresに対する実際のINSERTで検証する
// 結合テスト。事前に `npm run db:start` （初回のみ）と `npm run db:reset` で
// マイグレーション済みのローカルDBが起動している必要がある。
//
// Requirements: 4.1（卓ごとに同時にアクティブな来店セッションを高々1つに保つ）,
//               1.9/4.2（idempotency_keyによる注文の冪等性の土台となるユニーク制約）
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const pool = new Pool({ connectionString });

// PostgreSQLのユニーク制約違反のSQLSTATEコード
const UNIQUE_VIOLATION = "23505";

interface IdRow {
  id: string;
}

describe("0001_schema.sql: コアスキーマの制約（結合テスト）", () => {
  const storeId = randomUUID();

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "結合テスト用店舗",
    ]);
  });

  afterAll(async () => {
    // 生成した行をFK順（子→親）に後始末する
    await pool.query(
      `delete from order_items where order_id in (
         select id from orders where session_id in (
           select id from table_sessions where table_id in (
             select id from tables where store_id = $1
           )
         )
       )`,
      [storeId],
    );
    await pool.query(
      `delete from orders where session_id in (
         select id from table_sessions where table_id in (
           select id from tables where store_id = $1
         )
       )`,
      [storeId],
    );
    await pool.query(
      `delete from table_sessions where table_id in (
         select id from tables where store_id = $1
       )`,
      [storeId],
    );
    await pool.query("delete from tables where store_id = $1", [storeId]);
    await pool.query("delete from stores where id = $1", [storeId]);
    await pool.end();
  });

  it("同一卓に対して2件目のアクティブセッションをINSERTすると一意制約違反になる（要件4.1）", async () => {
    const tableId = randomUUID();
    await pool.query(
      "insert into tables (id, store_id, label) values ($1, $2, $3)",
      [tableId, storeId, "T-session-test"],
    );

    const firstSessionId = randomUUID();
    await pool.query(
      "insert into table_sessions (id, table_id, status, party_size) values ($1, $2, 'active', 2)",
      [firstSessionId, tableId],
    );

    await expect(
      pool.query(
        "insert into table_sessions (id, table_id, status, party_size) values ($1, $2, 'active', 4)",
        [randomUUID(), tableId],
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

    const { rows } = await pool.query<IdRow>(
      "select id from table_sessions where table_id = $1",
      [tableId],
    );
    expect(rows.map((row) => row.id)).toEqual([firstSessionId]);
  });

  it("同一セッション・同一idempotency_keyで2件目のordersをINSERTすると一意制約違反になる", async () => {
    const tableId = randomUUID();
    await pool.query(
      "insert into tables (id, store_id, label) values ($1, $2, $3)",
      [tableId, storeId, "T-order-test"],
    );

    const sessionId = randomUUID();
    await pool.query(
      "insert into table_sessions (id, table_id, status, party_size) values ($1, $2, 'active', 2)",
      [sessionId, tableId],
    );

    const firstOrderId = randomUUID();
    await pool.query(
      "insert into orders (id, session_id, idempotency_key) values ($1, $2, $3)",
      [firstOrderId, sessionId, "idem-key-1"],
    );

    await expect(
      pool.query(
        "insert into orders (id, session_id, idempotency_key) values ($1, $2, $3)",
        [randomUUID(), sessionId, "idem-key-1"],
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

    const { rows } = await pool.query<IdRow>(
      "select id from orders where session_id = $1",
      [sessionId],
    );
    expect(rows.map((row) => row.id)).toEqual([firstOrderId]);
  });
});
