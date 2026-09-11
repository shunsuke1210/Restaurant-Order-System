// @vitest-environment node
//
// 0002_rls_policies.sql のRLS/権限ロックダウンを、ローカルSupabase Postgresに対する
// 実際のSQL実行で検証する結合テスト。事前に `npm run db:start`
// （初回のみ）と `npm run db:reset` でマイグレーション済みのローカルDBが
// 起動している必要がある。
//
// このテストは`postgres`スーパーユーザー接続だけでは何も証明できない
// （スーパーユーザーはRLSを常にバイパスするため）。そのため、Supabase本番で
// PostgRESTが`authenticator`ロールから`SET LOCAL ROLE anon` /
// `SET LOCAL ROLE authenticated`に切り替えてリクエストごとの権限を実効させる
// のと同じ仕組みを使い、各トランザクション内で実際に`anon`/`authenticated`
// ロールへ切り替えたセッションからSQLを実行して検証する（タスク指示書 手順5 (a)）。
//
// Requirements: 8.1（客に認証情報を要求しない＝anonロールでの直接アクセスは
//               生テーブルではなく将来のRPC経由に限定する）,
//               8.2, 8.3（厨房/レジもdevice_role未検証の状態では生テーブルに
//               書き込めない＝authenticatedロールへの広範な権限も付与しない）
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const pool = new Pool({ connectionString });

// PostgreSQLの権限不足エラーのSQLSTATEコード（RLS有効化+GRANT剥奪により発生する）
const INSUFFICIENT_PRIVILEGE = "42501";

// 0001_schema.sqlで定義された全8テーブル
const ALL_TABLES = [
  "stores",
  "tables",
  "table_sessions",
  "menu_items",
  "orders",
  "order_items",
  "call_requests",
  "devices",
] as const;

type DbRole = "anon" | "authenticated";

/**
 * 指定ロールへ`SET LOCAL ROLE`で切り替えたトランザクション内でSQLを実行する。
 * PostgRESTの`authenticator`ロールがリクエストごとに`anon`/`authenticated`へ
 * 切り替える挙動を模したヘルパー。クエリの成否に関わらず必ずROLLBACKし、
 * 呼び出し元のシード行に副作用を残さない。
 */
async function runAsRole(
  client: PoolClient,
  role: DbRole,
  sql: string,
): Promise<{ ok: true; rowCount: number } | { ok: false; code: string | undefined }> {
  await client.query("begin");
  await client.query(`set local role ${role}`);
  try {
    const result = await client.query(sql);
    return { ok: true, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { ok: false, code };
  } finally {
    // INSERT/UPDATE/DELETEが万一成功してしまっていた場合でも、ROLLBACKにより
    // シードデータや他テストへの影響を残さない。
    await client.query("rollback");
  }
}

describe("0002_rls_policies.sql: RLSと権限のロックダウン（結合テスト）", () => {
  const storeId = randomUUID();
  const menuItemId = randomUUID();
  let roleClient: PoolClient;

  beforeAll(async () => {
    // superuser（postgres）接続でSELECT許可検証用の最小データを準備する
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "RLS結合テスト用店舗",
    ]);
    await pool.query(
      "insert into menu_items (id, store_id, name, price, genre) values ($1, $2, $3, $4, $5)",
      [menuItemId, storeId, "RLSテスト用品目", 500, "food"],
    );

    roleClient = await pool.connect();
  });

  afterAll(async () => {
    roleClient.release();
    await pool.query("delete from menu_items where id = $1", [menuItemId]);
    await pool.query("delete from stores where id = $1", [storeId]);
    await pool.end();
  });

  describe("anonロール: 直接書き込みは全テーブルで拒否される", () => {
    it.each(ALL_TABLES)(
      "%s へのINSERTが拒否される",
      async (table) => {
        // DEFAULT VALUESはテーブルの列定義に関わらず構文的に有効。
        // 権限チェックはNOT NULL等の制約チェックより先に行われるため、
        // どのテーブルでも一様にINSERT試行として使える（実機確認済み）。
        const result = await runAsRole(
          roleClient,
          "anon",
          `insert into ${table} default values`,
        );
        expect(result).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
      },
    );

    it.each(ALL_TABLES)("%s へのUPDATEが拒否される", async (table) => {
      const result = await runAsRole(
        roleClient,
        "anon",
        `update ${table} set id = id`,
      );
      expect(result).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
    });

    it.each(ALL_TABLES)("%s へのDELETEが拒否される", async (table) => {
      const result = await runAsRole(roleClient, "anon", `delete from ${table}`);
      expect(result).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
    });

    // タスク1.4の観測可能な完了条件そのもの（他テーブルと同じ仕組みだが明示的に確認する）
    it("table_sessionsへの直接INSERTを試みると拒否される（観測可能な完了条件）", async () => {
      const result = await runAsRole(
        roleClient,
        "anon",
        "insert into table_sessions default values",
      );
      expect(result).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
    });
  });

  describe("anonロール: SELECTはmenu_itemsのみ許可される", () => {
    it("menu_itemsはSELECTでき、シードした行が返る", async () => {
      const result = await runAsRole(
        roleClient,
        "anon",
        `select 1 from menu_items where id = '${menuItemId}'`,
      );
      expect(result).toEqual({ ok: true, rowCount: 1 });
    });

    const otherTables = ALL_TABLES.filter((table) => table !== "menu_items");
    it.each(otherTables)("%s へのSELECTは拒否される", async (table) => {
      const result = await runAsRole(roleClient, "anon", `select 1 from ${table}`);
      expect(result).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
    });
  });

  describe("authenticatedロール（device_role未検証）: 全テーブルへの直接アクセスが拒否される", () => {
    it.each(ALL_TABLES)("%s へのINSERTが拒否される", async (table) => {
      const result = await runAsRole(
        roleClient,
        "authenticated",
        `insert into ${table} default values`,
      );
      expect(result).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
    });

    it.each(ALL_TABLES)("%s へのUPDATEが拒否される", async (table) => {
      const result = await runAsRole(
        roleClient,
        "authenticated",
        `update ${table} set id = id`,
      );
      expect(result).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
    });

    it.each(ALL_TABLES)("%s へのDELETEが拒否される", async (table) => {
      const result = await runAsRole(
        roleClient,
        "authenticated",
        `delete from ${table}`,
      );
      expect(result).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
    });

    // authenticatedにはmenu_itemsのSELECT権限も付与しない
    // （anon専用の最小例外であり、device_role未検証のauthenticatedには広げない）
    it.each(ALL_TABLES)("%s へのSELECTも拒否される（menu_items含む）", async (table) => {
      const result = await runAsRole(
        roleClient,
        "authenticated",
        `select 1 from ${table}`,
      );
      expect(result).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
    });
  });
});
