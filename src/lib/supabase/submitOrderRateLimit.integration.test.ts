// @vitest-environment node
//
// 0003_rpc_customer_gateway.sql に追記されたsubmit_orderのセッション単位
// レート制限（タスク3.5）を、ローカルSupabaseスタックに対する実際のanonキー・
// 無サインインのsupabase-js呼び出しで検証する結合テスト。submitOrder.
// integration.test.ts（タスク3.2）と同じ構成: 事前に`npm run db:start`と
// `npm run db:reset`（0001, 0002, 0003, 0005, 0006, 0007を適用）が必要。
//
// 検証対象: design.md Security Considerations／CustomerOrderingGateway
//   Implementation Notes「Risks」、research.md Risks & Mitigations
//   「QRコードのSNS拡散等による大量不正注文...submit_orderにセッション単位の
//   レート制限（例: 1分あたりの送信回数上限）を設ける」の実装
//   （0003_rpc_customer_gateway.sqlの設計判断9・10・11参照）。
//
// 重要: レート制限の評価は「セッション有効性・空配列・売り切れ検証をすべて
// 通過した妥当な送信試行」に対してのみ行われる（設計判断10参照。PostgreSQLの
// トランザクション境界上、RAISE EXCEPTIONで最終的に失敗する呼び出しの
// カウンタ加算だけを残すことができないため）。そのため本テスト群は、閾値超過を
// 検証する際は実際に有効な品目を含む注文（submitRealOrder）を用いる。
// EMPTY_ORDER等の明らかに無効な呼び出しがこのレート制限の対象外であること
// 自体も、意図したスコープ限定として最後のテストで直接検証する。
//
// tasks.md Implementation Notes（2.3で判明した教訓）に従い、環境変数には
// ハードコードされたfallback値を持たせず、未設定ならbeforeAll等より前に
// 明確なエラーで失敗させる（fail-fast）。
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. submitOrderRateLimit.integration.test.ts requires it ` +
        "(see .env.local; vitest.config.mts loads it into process.env). " +
        "Run `npm run db:start` first if the local Supabase stack is not running.",
    );
  }
  return value;
}

const connectionString = requireEnv("SUPABASE_DB_URL");
const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supabaseAnonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

// 0003_rpc_customer_gateway.sqlのsubmit_order内で定義される閾値・SQLSTATE
// （設計判断10・11参照）と一致させる。値が変わった場合は本テストも追随して
// 更新すること。
const RATE_LIMIT_MAX = 20;
const RATE_LIMITED_SQLSTATE = "P0429";
const EMPTY_ORDER_SQLSTATE = "P0400";

const pool = new Pool({ connectionString });

function newAnonClient() {
  // 匿名サインイン（signInAnonymously）を一切呼ばない、真のanonロール経路
  // （submitOrder.integration.test.ts等と同じ前提。要件8.1）。
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function submitEmptyOrder(
  client: ReturnType<typeof newAnonClient>,
  sessionId: string,
) {
  return client.rpc("submit_order", {
    p_session_id: sessionId,
    p_idempotency_key: `rate-limit-empty-${randomUUID()}`,
    p_items: [],
  });
}

async function submitRealOrder(
  client: ReturnType<typeof newAnonClient>,
  sessionId: string,
  menuItemId: string,
  idempotencyKey: string = `rate-limit-real-${randomUUID()}`,
) {
  return client.rpc("submit_order", {
    p_session_id: sessionId,
    p_idempotency_key: idempotencyKey,
    p_items: [{ menuItemId, quantity: 1, optionSelections: {}, note: null }],
  });
}

describe("0003_rpc_customer_gateway.sql: submit_orderのセッション単位レート制限（タスク3.5、結合テスト）", () => {
  const storeId = randomUUID();
  const menuItemId = randomUUID();

  // セッションごとにレート制限の状態は独立するため、テストケースごとに専用の
  // 卓・セッションを用意し、テスト同士がお互いのカウンタに干渉しないようにする。
  const tableIds = {
    exceed: randomUUID(),
    isoA: randomUUID(),
    isoB: randomUUID(),
    normal: randomUUID(),
    window: randomUUID(),
    dedup: randomUUID(),
    invalidScope: randomUUID(),
  } as const;

  const sessionIds = {
    exceed: randomUUID(),
    isoA: randomUUID(),
    isoB: randomUUID(),
    normal: randomUUID(),
    window: randomUUID(),
    dedup: randomUUID(),
    invalidScope: randomUUID(),
  } as const;

  const createdOrderIds: string[] = [];

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "submit_orderレート制限結合テスト用店舗",
    ]);

    for (const [key, tableId] of Object.entries(tableIds)) {
      await pool.query(
        "insert into tables (id, store_id, label) values ($1, $2, $3)",
        [tableId, storeId, `レート制限検証卓(${key})`],
      );
    }

    await pool.query(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values ($1, $2, 'Rate Limit Item', 500, false, 'food', '[]'::jsonb)`,
      [menuItemId, storeId],
    );

    for (const [key, sessionId] of Object.entries(sessionIds)) {
      await pool.query(
        `insert into table_sessions (id, table_id, status, party_size)
         values ($1, $2, 'active', 2)`,
        [sessionId, tableIds[key as keyof typeof tableIds]],
      );
    }
  });

  afterAll(async () => {
    const allSessionIds = Object.values(sessionIds);

    if (createdOrderIds.length > 0) {
      await pool.query("delete from order_items where order_id = any($1)", [
        createdOrderIds,
      ]);
      await pool.query("delete from orders where id = any($1)", [
        createdOrderIds,
      ]);
    }
    await pool.query(
      `delete from order_items
       where order_id in (select id from orders where session_id = any($1))`,
      [allSessionIds],
    );
    await pool.query("delete from orders where session_id = any($1)", [
      allSessionIds,
    ]);
    // submit_order_rate_limitsはtable_sessions(id)へのon delete cascadeを
    // 持つため、table_sessions削除時に対応行も自動的に削除される
    // （0003_rpc_customer_gateway.sqlの設計判断9参照）。明示的なDELETEは不要。
    await pool.query("delete from table_sessions where id = any($1)", [
      allSessionIds,
    ]);
    await pool.query("delete from menu_items where store_id = $1", [storeId]);
    await pool.query("delete from tables where store_id = $1", [storeId]);
    await pool.query("delete from stores where id = $1", [storeId]);
    await pool.end();
  });

  it(`同一セッションから${RATE_LIMIT_MAX}回を超えて短時間に有効な注文を送信すると、${RATE_LIMIT_MAX + 1}回目以降はRATE_LIMITEDで拒否される（観測可能な完了条件）`, async () => {
    const supabase = newAnonClient();
    const errorCodes: Array<string | null> = [];

    for (let i = 0; i < RATE_LIMIT_MAX + 3; i++) {
      const { data, error } = await submitRealOrder(
        supabase,
        sessionIds.exceed,
        menuItemId,
      );
      errorCodes.push(error?.code ?? null);
      if (!error) {
        createdOrderIds.push(data.order.id);
      }
    }

    const withinLimit = errorCodes.slice(0, RATE_LIMIT_MAX);
    const overLimit = errorCodes.slice(RATE_LIMIT_MAX);

    // 閾値以内は正常に成功する。
    for (const code of withinLimit) {
      expect(code).toBeNull();
    }

    // 閾値を超えた呼び出しはRATE_LIMITEDで拒否される。
    for (const code of overLimit) {
      expect(code).toBe(RATE_LIMITED_SQLSTATE);
    }
  });

  it("通常の送信間隔（閾値を大きく下回る少数回・実際の有効な注文）は拒否されない。実運用で数人が食事の合間に数回ずつ送信する程度の量を模す（観測可能な完了条件）", async () => {
    const supabase = newAnonClient();

    for (let i = 0; i < 5; i++) {
      const { data, error } = await submitRealOrder(
        supabase,
        sessionIds.normal,
        menuItemId,
      );
      expect(error).toBeNull();
      createdOrderIds.push(data.order.id);
    }
  });

  it("あるセッションがレート制限に達しても、別のセッションからの送信には影響しない（クロスセッション独立性）", async () => {
    const supabase = newAnonClient();

    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const { data, error } = await submitRealOrder(
        supabase,
        sessionIds.isoA,
        menuItemId,
      );
      if (!error) createdOrderIds.push(data.order.id);
    }
    const { error: exhaustedError } = await submitRealOrder(
      supabase,
      sessionIds.isoA,
      menuItemId,
    );
    expect(exhaustedError?.code).toBe(RATE_LIMITED_SQLSTATE);

    // 別セッション(isoB)はこれが初回の送信であり、isoAのカウンタとは無関係に
    // 通常通り成功する。
    const { data: otherData, error: otherSessionError } =
      await submitRealOrder(supabase, sessionIds.isoB, menuItemId);
    expect(otherSessionError).toBeNull();
    createdOrderIds.push(otherData.order.id);
  });

  it("レート制限のウィンドウが経過した後は、新規の送信が再び許可される（60秒待つ代わりに、submit_order_rate_limits.window_started_atをSQLで直接過去へ書き換えて『ウィンドウ外の古い記録』を模擬する構造的検証）", async () => {
    const supabase = newAnonClient();

    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const { data, error } = await submitRealOrder(
        supabase,
        sessionIds.window,
        menuItemId,
      );
      if (!error) createdOrderIds.push(data.order.id);
    }
    const { error: limitedError } = await submitRealOrder(
      supabase,
      sessionIds.window,
      menuItemId,
    );
    expect(limitedError?.code).toBe(RATE_LIMITED_SQLSTATE);

    await pool.query(
      `update submit_order_rate_limits
       set window_started_at = now() - interval '2 minutes'
       where session_id = $1`,
      [sessionIds.window],
    );

    // ウィンドウが経過したとみなされカウンタがリセットされ、新規送信が
    // 再び許可される。
    const { data: resetData, error: resetError } = await submitRealOrder(
      supabase,
      sessionIds.window,
      menuItemId,
    );
    expect(resetError).toBeNull();
    createdOrderIds.push(resetData.order.id);
  });

  it("同一idempotencyKeyによる冪等な重複再送（新規のordersを作らない呼び出し）も、レート制限のカウント対象に含まれる（設計判断9で述べた、ordersの行数だけを数える方式との違いの直接証跡）", async () => {
    const supabase = newAnonClient();
    const idempotencyKey = `rate-limit-dedup-${randomUUID()}`;

    const first = await submitRealOrder(
      supabase,
      sessionIds.dedup,
      menuItemId,
      idempotencyKey,
    );
    expect(first.error).toBeNull();
    expect(first.data.deduplicated).toBe(false);
    createdOrderIds.push(first.data.order.id);

    // 同一idempotencyKeyでの再送を閾値回数分繰り返す。新規のorders行は
    // 増えない（deduplicated: true）が、レート制限のカウントは進む。
    for (let i = 0; i < RATE_LIMIT_MAX - 1; i++) {
      const { data, error } = await submitRealOrder(
        supabase,
        sessionIds.dedup,
        menuItemId,
        idempotencyKey,
      );
      expect(error).toBeNull();
      expect(data.deduplicated).toBe(true);
    }

    // ここまででRATE_LIMIT_MAX回分のカウントを消費している。次の呼び出し
    // （同一キーでの再送であっても）はRATE_LIMITEDで拒否される。
    const { error: limitedError } = await submitRealOrder(
      supabase,
      sessionIds.dedup,
      menuItemId,
      idempotencyKey,
    );
    expect(limitedError?.code).toBe(RATE_LIMITED_SQLSTATE);
  });

  it("空配列（EMPTY_ORDER）のような明らかに無効な呼び出しは、閾値を超えて連投してもRATE_LIMITEDにはならない（設計判断10で述べた意図的なスコープ限定の直接証跡。PostgreSQLのトランザクション境界上、最終的に例外で失敗する呼び出しのカウンタ加算だけを残せないため）", async () => {
    const supabase = newAnonClient();

    for (let i = 0; i < RATE_LIMIT_MAX + 5; i++) {
      const { error } = await submitEmptyOrder(
        supabase,
        sessionIds.invalidScope,
      );
      expect(error?.code).toBe(EMPTY_ORDER_SQLSTATE);
    }
  });
});
