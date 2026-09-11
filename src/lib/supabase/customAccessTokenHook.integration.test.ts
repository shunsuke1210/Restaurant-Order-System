// @vitest-environment node
//
// 0005_custom_access_token_hook.sql のCustom Access Token Hookを、
// ローカルSupabaseスタックに対する実際の匿名サインインで検証する結合テスト。
// 事前に `npm run db:start` と、config.toml変更を反映させるための
// スタック再起動（`npm run db:stop && npm run db:start`）、および
// `npm run db:reset`（0001, 0002, 0005適用）が必要。
//
// このテストは`@supabase/supabase-js`の`signInAnonymously()`で実際に
// GoTrue経由のJWT発行を行い、発行されたaccess_tokenをデコードして
// `device_role`クレームの有無を検証する（モックやSQL直接呼び出しでは、
// GoTrueが実際にフックを呼び出すこと自体は証明できないため）。
//
// 匿名サインインは毎回新規のランダムなauth_user_idを発行するため、
// devices行を事前には仕込めない。そのため各テストは
// (a) まず匿名サインインしてauth_user_idを確定させ、
// (b) その後`devices`行を`postgres`スーパーユーザー接続（RLSバイパス、
//     テストセットアップとして許容）でINSERTし、
// (c) refreshSession()で新しいトークンを発行させ直す（フックはトークン発行の
//     たびに実行されるため、最初のサインイン時点のトークンには反映されない）
// という順序で行う。
//
// Requirements: 8.2（厨房スタッフに個人認証を要求しない）,
//               8.3（レジスタッフに個人認証を要求しない）
//               — device_roleクレームがデバイス単位の識別を成立させる土台であることの検証
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
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

const pool = new Pool({ connectionString });

/**
 * JWTのペイロード部分（第2セグメント）をbase64url→JSONへデコードする。
 * JWTライブラリを追加導入せず、テスト内で自己完結させる。
 */
function decodeJwtPayload(accessToken: string): Record<string, unknown> {
  const segments = accessToken.split(".");
  const payloadSegment = segments[1];
  if (!payloadSegment) {
    throw new Error(
      `Invalid JWT: expected 3 dot-separated segments, got ${segments.length}`,
    );
  }
  const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(paddingLength);
  const json = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

describe("0005_custom_access_token_hook.sql: Custom Access Token Hook（結合テスト）", () => {
  const storeId = randomUUID();
  const createdAuthUserIds: string[] = [];
  const createdDeviceIds: string[] = [];

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "Custom Access Token Hook結合テスト用店舗",
    ]);
  });

  afterAll(async () => {
    for (const deviceId of createdDeviceIds) {
      await pool.query("delete from devices where id = $1", [deviceId]);
    }
    await pool.query("delete from stores where id = $1", [storeId]);
    // 匿名サインインで作成されたauth.usersは後始末しておく
    // （関連するauth.identities/auth.sessions等はGoTrueのスキーマ定義により
    // カスケード削除される）。テスト対象の挙動そのものではないため、
    // 失敗してもテスト結果には影響させない。
    for (const authUserId of createdAuthUserIds) {
      try {
        await pool.query("delete from auth.users where id = $1", [authUserId]);
      } catch {
        // ベストエフォートの後始末。失敗してもテストの合否には影響しない。
      }
    }
    await pool.end();
  });

  it(
    "devices行が存在しない匿名セッション（客の経路）はdevice_roleクレームを持たない",
    async () => {
      const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { data, error } = await supabase.auth.signInAnonymously();
      expect(error).toBeNull();
      expect(data.session).not.toBeNull();

      const authUserId = data.user?.id;
      expect(authUserId).toBeDefined();
      if (authUserId) {
        createdAuthUserIds.push(authUserId);
      }

      const accessToken = data.session?.access_token;
      expect(accessToken).toBeDefined();
      const claims = decodeJwtPayload(accessToken as string);

      expect(claims).not.toHaveProperty("device_role");
    },
    30_000,
  );

  it(
    "devices行が紐づく匿名セッション（厨房デバイスの経路）は再発行後のJWTにdevice_role='kitchen'クレームを持つ",
    async () => {
      const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      // (a) まず匿名サインインしてauth_user_idを確定させる
      const signInResult = await supabase.auth.signInAnonymously();
      expect(signInResult.error).toBeNull();
      const authUserId = signInResult.data.user?.id;
      const refreshToken = signInResult.data.session?.refresh_token;
      expect(authUserId).toBeDefined();
      expect(refreshToken).toBeDefined();
      if (authUserId) {
        createdAuthUserIds.push(authUserId);
      }

      // サインイン直後（devices行INSERT前）に発行されたJWTには
      // device_roleクレームが含まれないことを前提として確認しておく
      const initialClaims = decodeJwtPayload(
        signInResult.data.session?.access_token as string,
      );
      expect(initialClaims).not.toHaveProperty("device_role");

      // (b) devices行をpostgresスーパーユーザー接続でINSERTする
      //     （RLSバイパスはテストセットアップとして許容。実際のプロビジョニング
      //     経路[タスク2.3]の代わりに、フックの入力データを直接用意する）
      const deviceId = randomUUID();
      await pool.query(
        "insert into devices (id, auth_user_id, store_id, role) values ($1, $2, $3, $4)",
        [deviceId, authUserId, storeId, "kitchen"],
      );
      createdDeviceIds.push(deviceId);

      // (c) refreshSession()で新しいトークンを発行させ直す
      //     （フックはトークン発行のたびに実行されるため、devices行INSERT前に
      //     発行済みのaccess_tokenには反映されない）
      const refreshResult = await supabase.auth.refreshSession({
        refresh_token: refreshToken as string,
      });
      expect(refreshResult.error).toBeNull();
      const refreshedAccessToken = refreshResult.data.session?.access_token;
      expect(refreshedAccessToken).toBeDefined();

      const refreshedClaims = decodeJwtPayload(refreshedAccessToken as string);
      expect(refreshedClaims.device_role).toBe("kitchen");
    },
    30_000,
  );
});
