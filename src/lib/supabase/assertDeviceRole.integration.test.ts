// @vitest-environment node
//
// 0006_assert_device_role.sql のassert_device_role(text[])ヘルパーを、
// ローカルSupabase Postgresに対する実際のSQL実行で検証する結合テスト。
// 事前に `npm run db:start`（初回のみ）と `npm run db:reset`
//（0001, 0002, 0005, 0006適用）が必要。
//
// auth.jwt()はPostgREST/GoTrueが認証済みリクエストごとに設定する
// セッションローカルのGUC（request.jwt.claims）をcurrent_setting()で読むだけの
// STABLE SQL関数である（pg_get_functiondefで実機確認済み）。そのため、
// 生のpg接続でも同じGUCをトランザクション内で`select set_config(
// 'request.jwt.claims', ..., true)`により再現すれば、PostgRESTを経由せずに
// assert_device_roleの挙動を直接検証できる（第三者のロール切り替えを要する
// rlsPolicies.integration.test.tsのSET LOCAL ROLEパターンと異なり、こちらは
// GUCの再現のみで済む）。各テストはBEGIN後にGUCを設定し、必ずROLLBACKすることで
// 他テストへの副作用を残さない。
//
// Requirements: 8.2（厨房スタッフに個人認証を要求しない＝device_role claimによる
//               デバイス単位の識別が唯一の認可根拠であること）,
//               8.3（レジスタッフについても同様）
import { createClient } from "@supabase/supabase-js";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";

const pool = new Pool({ connectionString });

// assert_device_roleが送出するカスタムSQLSTATE（0006_assert_device_role.sqlで定義）。
// SQLSTATEクラス'P0'（PL/pgSQL Error）配下の未使用サブコードで、
// Postgres本体・拡張機能のエラーコードと衝突しない。
const FORBIDDEN_DEVICE_ROLE = "P0403";

type AssertResult =
  | { ok: true }
  | { ok: false; code: string | undefined; message: string };

/**
 * 指定したclaims（nullの場合はGUCを一切設定しない＝JWTコンテキストなしを模す）を
 * トランザクションローカルのrequest.jwt.claims GUCとして再現した上で、
 * public.assert_device_role(allowedRoles)を呼び出す。
 * 副作用を残さないよう必ずROLLBACKする。
 */
async function callAssertDeviceRole(
  client: PoolClient,
  claims: Record<string, unknown> | null,
  allowedRoles: readonly string[],
): Promise<AssertResult> {
  await client.query("begin");
  try {
    if (claims !== null) {
      await client.query(
        "select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify(claims)],
      );
    }
    await client.query("select public.assert_device_role($1::text[])", [
      allowedRoles,
    ]);
    return { ok: true };
  } catch (error) {
    const pgError = error as { code?: string; message: string };
    return { ok: false, code: pgError.code, message: pgError.message };
  } finally {
    await client.query("rollback");
  }
}

describe("0006_assert_device_role.sql: assert_device_role()ヘルパー（結合テスト）", () => {
  let roleClient: PoolClient;

  beforeAll(async () => {
    roleClient = await pool.connect();
  });

  afterAll(async () => {
    roleClient.release();
    await pool.end();
  });

  describe("許可されたdevice_roleでは成功する（観測可能な完了条件: 例外を送出しない）", () => {
    it("device_role='kitchen'を['kitchen','register']で呼び出すと成功する", async () => {
      const result = await callAssertDeviceRole(
        roleClient,
        { device_role: "kitchen" },
        ["kitchen", "register"],
      );
      expect(result).toEqual({ ok: true });
    });

    it("device_role='register'を['register']（register限定操作）で呼び出すと成功する", async () => {
      const result = await callAssertDeviceRole(
        roleClient,
        { device_role: "register" },
        ["register"],
      );
      expect(result).toEqual({ ok: true });
    });
  });

  describe("許可されていないdevice_roleでは例外が送出される（観測可能な完了条件）", () => {
    it("device_role='register'をkitchen限定の許可リストで呼び出すと拒否される", async () => {
      const result = await callAssertDeviceRole(
        roleClient,
        { device_role: "register" },
        ["kitchen"],
      );
      expect(result).toEqual({
        ok: false,
        code: FORBIDDEN_DEVICE_ROLE,
        message: expect.any(String),
      });
    });

    it("許可リストにないランダムなdevice_role文字列で呼び出すと拒否される", async () => {
      const result = await callAssertDeviceRole(
        roleClient,
        { device_role: "some-unexpected-role" },
        ["kitchen", "register"],
      );
      expect(result).toEqual({
        ok: false,
        code: FORBIDDEN_DEVICE_ROLE,
        message: expect.any(String),
      });
    });

    it("device_roleクレーム自体が存在しないJWT（客の匿名セッションを模す）では拒否される", async () => {
      // 客の匿名セッションはdevicesテーブルに一致する行がないため、
      // custom_access_token_hook（0005）がdevice_roleクレームを一切追加しない。
      // その状態を、device_roleキーを含まないclaimsとして再現する。
      const result = await callAssertDeviceRole(
        roleClient,
        { sub: "11111111-1111-1111-1111-111111111111" },
        ["kitchen", "register"],
      );
      expect(result).toEqual({
        ok: false,
        code: FORBIDDEN_DEVICE_ROLE,
        message: expect.any(String),
      });
    });

    it("JWTコンテキストが全く存在しない場合（request.jwt.claims GUC未設定）は拒否される", async () => {
      // GUCを一切設定しない＝auth.jwt()はNULLを返す（現地確認済み: current_setting
      // はmissing_ok=trueのため未設定でもエラーにならずNULLを返す）。
      const result = await callAssertDeviceRole(roleClient, null, [
        "kitchen",
        "register",
      ]);
      expect(result).toEqual({
        ok: false,
        code: FORBIDDEN_DEVICE_ROLE,
        message: expect.any(String),
      });
    });
  });

  describe("PostgRESTからの直接RPC呼び出し可能性（設計判断2の実機検証）", () => {
    it(
      "anonロールで/rpc/assert_device_roleを呼び出すと、EXECUTE権限がないため失敗する",
      async () => {
        // Postgresはpublicスキーマの新規関数にEXECUTEをPUBLICへ自動付与するため、
        // 0006マイグレーションが明示的にanon/authenticated/publicからEXECUTEを
        // 剥奪していなければ、この呼び出しは（device_role claim自体を持たない
        // anonキーであっても）関数自体には到達してしまう。
        // 剥奪が効いていれば、PostgRESTは権限のない関数をスキーマキャッシュから
        // 隠すため「関数が見つからない」旨のエラー（404相当）を返す。
        const supabase = createClient(supabaseUrl, supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        const { data, error } = await supabase.rpc("assert_device_role", {
          allowed_roles: ["kitchen", "register"],
        });

        expect(data).toBeNull();
        expect(error).not.toBeNull();
      },
      30_000,
    );
  });
});
