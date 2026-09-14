// useRealtimeFeed.ts（本タスク5）の結合テスト。単体テスト
// （useRealtimeFeed.test.ts）はSupabaseクライアントをモックしてフック自身の
// ロジック（パラメータ化・接続状態遷移・onSyncの呼び出しタイミング・
// クリーンアップ）を検証するが、それだけでは
// 0008_realtime_publication.sqlが実際にイベントを流すかどうか
// （publication登録とRLSポリシーの組み合わせが本当に機能するか）までは
// 検証できない。
//
// 本ファイルはローカルSupabaseスタックに対し、
//   1. kitchen deviceとして本物のRealtimeチャンネルをuseRealtimeFeed経由で
//      購読し（`postgres_changes`, table: order_items）、
//   2. 客側の書き込み経路であるcustomerOrderingGateway.submitOrder
//      （生SQLではなく実際のRPC呼び出し。design.mdが定める唯一の書き込み
//      経路）で本物のorder_items行を挿入し、
//   3. useRealtimeFeedのonSyncコールバックが実際に呼び出し直されること
// を検証する。staffOperationsGateway.integration.test.ts（タスク4.6）と
// 同じ「匿名サインイン→devicesテーブルへの行追加→refreshSession」手順で
// device_role='kitchen'のJWTを持つauthenticatedクライアントを用意する。
//
// tasks.md Implementation Notes（2.3で判明した教訓）に従い、環境変数には
// ハードコードされたfallback値を持たせず、未設定ならbeforeAll等より前に
// 明確なエラーで失敗させる（fail-fast）。
//
// Requirements: 1.12, 6.1, 6.8, 6.9
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { renderHook, waitFor } from "@testing-library/react";
import { Pool } from "pg";
import WS from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "../supabase/database.types";
import { createCustomerOrderingGateway } from "../gateways/customerOrderingGateway";
import { useRealtimeFeed } from "./useRealtimeFeed";

/**
 * このテストファイルはjsdom環境（vitest.config.mtsの既定値。
 * `renderHook`がDOMを要求するため、他の結合テストのようにnode環境を指定する
 * pragmaコメントには切り替えられない）で動く。jsdomはグローバルな
 * `Event`/`EventTarget`をjsdom自身の実装で
 * 上書きするため、Node組み込み（undici由来）の`WebSocket`をそのまま
 * 使うと、内部でNode本来の`Event`クラスとjsdomの`Event`クラスが
 * 一致せず`dispatchEvent`が`TypeError: The "event" argument must be an
 * instance of Event`で失敗することを実機で確認した（jsdom環境と
 * Node/undiciのネイティブWebSocket実装の既知の非互換）。
 * `@supabase/realtime-js`のRealtimeClientOptionsが公式に用意する
 * `transport`オプション（「Supply a compatible implementation (native
 * WebSocket, `ws`, etc) when running outside the browser」）を使い、
 * `ws`パッケージ（DOMのEventTarget実装に依存しない独自実装）を明示的に
 * 注入することでこれを回避する。フック本体（useRealtimeFeed.ts）や
 * 本番コード（src/lib/supabase/client.ts）は変更しない
 * （ブラウザ実行時はこの問題自体が発生しないため）。
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. useRealtimeFeed.integration.test.ts requires it ` +
        "(see .env.local; vitest.config.mts loads it into process.env). " +
        "Run `npm run db:start` first if the local Supabase stack is not running.",
    );
  }
  return value;
}

const connectionString = requireEnv("SUPABASE_DB_URL");
const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supabaseAnonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

const pool = new Pool({ connectionString });

function newAnonClient(): SupabaseClient<Database> {
  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * staffOperationsGateway.integration.test.tsと同じ手順
 * （匿名サインイン→devicesテーブルへの行追加→refreshSession）で、
 * device_role claim付きのJWTを持つauthenticatedクライアントを用意する。
 * 0008_realtime_publication.sqlのorder_items_staff_selectポリシーが
 * kitchen/registerロールにSELECTを許可しているため、これがRealtime購読で
 * 実際にイベントを受け取れる唯一のロール（本specの範囲内では）である。
 */
async function createKitchenDeviceClient(
  storeId: string,
): Promise<SupabaseClient<Database>> {
  // ファイル冒頭コメントの通り、jsdom環境でNode組み込みWebSocketを使うと
  // 壊れるため、Realtimeを実際に使うこのクライアントだけ`ws`パッケージを
  // transportとして明示的に注入する。
  const client = createClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: {
      // `ws`はrealtime-jsの`WebSocketLikeConstructor`と互換の型を持つが、
      // このテストファイルは`@supabase/realtime-js`を直接の依存関係として
      // 宣言していない（`@supabase/supabase-js`の推移的依存）ため、
      // そこから型をimportせずWebSocket互換の最小限の形にキャストする。
      transport: WS as unknown as typeof WebSocket,
    },
  });
  const signInResult = await client.auth.signInAnonymously();
  expect(signInResult.error).toBeNull();
  const authUserId = signInResult.data.user?.id;
  const refreshToken = signInResult.data.session?.refresh_token;
  expect(authUserId).toBeDefined();
  expect(refreshToken).toBeDefined();

  await pool.query(
    "insert into devices (auth_user_id, store_id, role) values ($1, $2, 'kitchen')",
    [authUserId, storeId],
  );

  const refreshResult = await client.auth.refreshSession({
    refresh_token: refreshToken as string,
  });
  expect(refreshResult.error).toBeNull();

  return client;
}

describe("useRealtimeFeed（結合テスト、実Realtime配信の疎通確認）", () => {
  const storeId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const menuItemId = randomUUID();
  const createdOrderIds: string[] = [];

  beforeAll(async () => {
    await pool.query("insert into stores (id, name) values ($1, $2)", [
      storeId,
      "useRealtimeFeed結合テスト用店舗",
    ]);
    await pool.query(
      "insert into tables (id, store_id, label) values ($1, $2, $3)",
      [tableId, storeId, "useRealtimeFeed結合テスト用卓"],
    );
    await pool.query(
      "insert into table_sessions (id, table_id, status, party_size) values ($1, $2, 'active', 2)",
      [sessionId, tableId],
    );
    await pool.query(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values ($1, $2, 'Realtime Test Item', 700, false, 'food', '[]'::jsonb)`,
      [menuItemId, storeId],
    );
  }, 30000);

  afterAll(async () => {
    if (createdOrderIds.length > 0) {
      await pool.query("delete from order_items where order_id = any($1)", [
        createdOrderIds,
      ]);
      await pool.query("delete from orders where id = any($1)", [
        createdOrderIds,
      ]);
    }
    await pool.query("delete from call_requests where session_id = $1", [
      sessionId,
    ]);
    await pool.query("delete from table_sessions where id = $1", [
      sessionId,
    ]);
    await pool.query("delete from menu_items where store_id = $1", [
      storeId,
    ]);
    await pool.query("delete from devices where store_id = $1", [storeId]);
    await pool.query("delete from tables where store_id = $1", [storeId]);
    await pool.query("delete from stores where id = $1", [storeId]);
    await pool.end();
  });

  it(
    "kitchen deviceとしてorder_itemsを購読すると、submit_order経由の本物の注文でonSyncが呼び直される",
    async () => {
      const kitchenClient = await createKitchenDeviceClient(storeId);
      const onSync = vi.fn<() => Promise<void>>(async () => {});

      const { result, unmount } = renderHook(() =>
        useRealtimeFeed({
          client: kitchenClient,
          channelName: `kitchen-feed-integration-${randomUUID()}`,
          subscriptions: [{ table: "order_items" }],
          onSync,
        }),
      );

      // 0008マイグレーションのpublication登録＋RLSが正しく機能していれば
      // 購読は実際に確立し、statusがconnectedになる
      // （0008マイグレーションのコメントで説明した`wait: true`により、
      // これはサーバー側のpostgres_changes登録が完了したことを意味する）。
      await waitFor(() => expect(result.current.status).toBe("connected"), {
        timeout: 45000,
      });
      // 初回購読確立でonSyncが呼ばれる。0008マイグレーションのコメントで
      // 説明した通りkitchenロールのSELECTポリシーは店舗単位に絞り込まない
      // （既存のv1スコープの割り切り、0004設計判断21と同じ）ため、
      // `npm test`のフルスイート実行時は他の結合テストファイルが並行して
      // order_itemsへ書き込むイベントも同じ購読に届きうる。そのため
      // 「ちょうど1回」ではなく「少なくとも1回」で検証し、後段も
      // 送信前後の差分（厳密な増加）で判定することでフルスイート下の
      // 並行実行に対して頑健にする。
      await waitFor(() => expect(onSync).toHaveBeenCalled(), {
        timeout: 45000,
      });

      const callCountBeforeSubmit = onSync.mock.calls.length;

      // 生SQLではなく、design.mdが定める唯一の書き込み経路
      // （customerOrderingGateway.submitOrder、実RPC呼び出し）で本物の
      // order_items行を挿入する。
      const gateway = createCustomerOrderingGateway(newAnonClient());
      const submitResult = await gateway.submitOrder({
        sessionId,
        idempotencyKey: `realtime-integration-${randomUUID()}`,
        items: [
          { menuItemId, quantity: 1, optionSelections: {}, note: null },
        ],
      });
      expect(submitResult.ok).toBe(true);
      if (submitResult.ok) {
        createdOrderIds.push(submitResult.value.order.id);
      }

      // 本物のDB変更によりpostgres_changesイベントが配信され、onSyncが
      // 呼び直されることを確認する（タスク5の観測可能な完了条件の核心：
      // 「一覧が最新状態に再取得される」＝onSyncが再度呼ばれること）。
      // 送信前の呼び出し回数からの厳密な増加で判定する（上のコメント参照）。
      await waitFor(
        () =>
          expect(onSync.mock.calls.length).toBeGreaterThan(
            callCountBeforeSubmit,
          ),
        { timeout: 45000 },
      );

      // タスク5の観測可能な完了条件を文字通り実機で再現する:
      // 「購読中にネットワークを切断し再接続すると、一覧が最新状態に
      // 再取得される」。`client.realtime.disconnect()`でWebSocket接続を
      // 強制的に切断すると、実機調査で確認した通りチャンネルは
      // `CHANNEL_ERROR`（"socket closed"）を報告する。その後
      // `client.realtime.connect()`で再接続すると、`@supabase/realtime-js`が
      // 既存のチャンネル購読を自動的に再joinし`SUBSCRIBED`を再度報告する
      // ことを実機で確認済み。フックはSUBSCRIBEDを受け取るたびonSyncを
      // 呼ぶ設計（useRealtimeFeed.ts参照）のため、この一連の流れで
      // onSyncが呼び直されることを検証する。
      await waitFor(() => expect(result.current.status).toBe("connected"), {
        timeout: 15000,
      });
      const callCountBeforeReconnect = onSync.mock.calls.length;

      await kitchenClient.realtime.disconnect();
      await waitFor(() => expect(result.current.status).toBe("disconnected"), {
        timeout: 15000,
      });

      kitchenClient.realtime.connect();
      await waitFor(() => expect(result.current.status).toBe("connected"), {
        timeout: 90000,
      });
      await waitFor(
        () =>
          expect(onSync.mock.calls.length).toBeGreaterThan(
            callCountBeforeReconnect,
          ),
        { timeout: 15000 },
      );

      unmount();
    },
    // `npm test`のフルスイート実行時は30ファイル分のvitestワーカーが
    // 同時にローカルSupabaseスタックへアクセスするため、単体実行時より
    // WebSocketハンドシェイク/postgres_changes登録確認が遅くなることを
    // 実機で確認した（単体実行時は2秒未満で完了する）。実際の切断→再接続
    // シナリオ（disconnect→connect→再SUBSCRIBED確認）は単体実行でも
    // 40秒前後かかることを実機で確認したため、フルスイート下の余裕を
    // 見て120秒とする。本番のkitchen/registerタブレット運用
    // （同時1〜3台）はこの負荷を想定しないためuseRealtimeFeed.ts側の
    // タイムアウト値は変更せず、テスト側の猶予だけを広げる。
    120000,
  );
});
