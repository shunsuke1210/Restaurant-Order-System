import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect, type Page } from "@playwright/test";

// タスク9.2（3画面へのRealtimeFeed接続と再接続時再取得の統合確認）の
// 実ブラウザ検証。要件6.1・本タスクの観測可能な完了条件そのもの
// 「客側画面から注文を送信すると、5秒以内に厨房画面とレジ画面の両方に
// 反映される」を、3つの独立したブラウザコンテキスト（客・厨房・レジ、
// それぞれ独立したlocalStorage/セッション）・実Postgres・実Supabase
// Realtimeに対して検証する。
//
// 恒久テストとして追加した理由（tasks.md 9.2 Implementation Notes参照）:
// 各画面のuseRealtimeFeed配線自体はコンポーネントテスト
// （KitchenBoardScreen.test.tsxの7.6ブロック、FloorMap.test.tsxの
// 「FloorMapのタスク9.2」ブロック）でuseRealtimeFeed自体をモックして
// 検証済みだが、それらは「onSyncが呼ばれたらload(false)を呼び直す」という
// アプリ側ロジックのみを検証しており、0008マイグレーション（publication
// 登録・GRANT・RLS）・useRealtimeFeed自身の`wait: true`購読確立ロジック・
// 実際のsubmit_orderが発火するorder_items INSERTという、DB層〜Realtime
// サーバー層の実配線は原理的に検証できない（モックしているため）。
// この配線は今後のマイグレーション変更等（例: RLSポリシーの書き換え、
// publicationからのテーブル除外）で静かに壊れうるにもかかわらず、他の
// どのテストにもカバーされない。kitchen-soldout-board.spec.ts（タスク7.4）
// が「新規RPC + 初の確認モーダル」という固有のリスクを理由に恒久E2Eとして
// 残された前例に倣い、本テストもこの固有のリグレッションリスクを恒久的な
// E2Eで保護する価値があると判断した。
//
// 前提: `npm run db:start` + `npm run db:reset`済みのローカルSupabaseスタック。
// .env.localのSUPABASE_DB_URL/DEVICE_SETUP_CODE/NEXT_PUBLIC_STORE_IDを使う
// （kitchen-soldout-board.spec.tsと同じ規約）。
//
// Requirements: 1.12, 6.1, 6.9

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. realtime-propagation.spec.ts requires it ` +
        "(see .env.local; playwright.config.ts loads it into process.env). " +
        "Run `npm run db:start` first if the local Supabase stack is not running.",
    );
  }
  return value;
}

const connectionString = requireEnv("SUPABASE_DB_URL");
const deviceSetupCode = requireEnv("DEVICE_SETUP_CODE");
const storeId = requireEnv("NEXT_PUBLIC_STORE_ID");

const pool = new Pool({ connectionString });

// 実際の伝播を検証するアサーションのタイムアウト。要件6.1・本タスクの
// 観測可能な完了条件が定める上限（5秒）そのものではなく、明確な余裕
// （ちょうど5秒ぎりぎりを狙う不安定なテストにしない）を持たせつつ、
// 5秒フォールバックポーリング（KITCHEN_BOARD_POLL_INTERVAL_MS /
// REGISTER_FLOOR_MAP_POLL_INTERVAL_MSいずれも5000ms）が偶然のタイミングで
// アサーションを通してしまう可能性を減らすため、5000msより十分短い値
// とする（tasks.mdタスク文書「a few seconds, not the full 5s ceiling」）。
const PROPAGATION_ASSERTION_TIMEOUT_MS = 3000;

/**
 * 指定した`page`のlocalStorageから、`ensureDeviceSession`/`provisionDevice`
 * （src/lib/device/useDeviceIdentity.ts）がキャッシュしたデバイス識別情報
 * （`deviceUserId`は`devices.auth_user_id`と同じ値）を読み取る。
 *
 * devicesテーブルへのクエリで「役割ごとに全件削除する」前例
 * （kitchen-soldout-board.spec.tsのafterAll）は、本テストのように同じ
 * store・同じ役割のkitchen/registerデバイスを他のE2Eスペックが並行して
 * プロビジョニングしうる状況（Playwrightのデフォルト並列実行）では、
 * 他スペックが今まさに使用中のデバイス行を後始末で消してしまう恐れが
 * ある。本テストは実際にプロビジョニングした自分自身のデバイスの
 * auth_user_idをブラウザのlocalStorageから直接読み取り、その特定の行
 * だけを削除することで、この衝突を避ける。
 */
async function readDeviceUserId(page: Page): Promise<string> {
  const raw = await page.evaluate(() =>
    window.localStorage.getItem("table-order-kitchen:device-identity"),
  );
  if (!raw) {
    throw new Error(
      "table-order-kitchen:device-identity was not found in localStorage after provisioning.",
    );
  }
  const parsed = JSON.parse(raw) as { deviceUserId: string };
  return parsed.deviceUserId;
}

test.describe("客→厨房/レジのRealtime伝播（タスク9.2）", () => {
  const tableLabel = `T9E2E${randomUUID().slice(0, 6)}`;
  const menuItemName = `E2E牛丼_${randomUUID().slice(0, 8)}`;
  let tableId: string;
  let sessionId: string;
  let menuItemId: string;

  test.beforeAll(async () => {
    const tableResult = await pool.query<{ id: string }>(
      "insert into tables (id, store_id, label) values (gen_random_uuid(), $1, $2) returning id",
      [storeId, tableLabel],
    );
    tableId = tableResult.rows[0].id;

    const sessionResult = await pool.query<{ id: string }>(
      "insert into table_sessions (id, table_id, status, party_size) values (gen_random_uuid(), $1, 'active', 2) returning id",
      [tableId],
    );
    sessionId = sessionResult.rows[0].id;

    const menuItemResult = await pool.query<{ id: string }>(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values (gen_random_uuid(), $1, $2, 780, false, 'food', '[]'::jsonb)
       returning id`,
      [storeId, menuItemName],
    );
    menuItemId = menuItemResult.rows[0].id;
  });

  test.afterAll(async () => {
    // FK順序（order_items→orders→table_sessions/menu_items）を守って削除する
    // （8.5 Implementation Notesが記録する「FK違反→削除順序修正」と同型の
    // 教訓を踏まえ、最初から正しい順序で書く）。
    await pool.query(
      "delete from order_items where order_id in (select id from orders where session_id = $1)",
      [sessionId],
    );
    await pool.query("delete from orders where session_id = $1", [sessionId]);
    await pool.query("delete from table_sessions where id = $1", [sessionId]);
    await pool.query("delete from tables where id = $1", [tableId]);
    await pool.query("delete from menu_items where id = $1", [menuItemId]);
    await pool.end();
  });

  test("客側画面から注文を送信すると、厨房画面とレジ画面の両方に数秒以内に反映される", async ({
    browser,
  }, testInfo) => {
    // 3画面分のプロビジョニング・購読確立待ちを含むため、既定の30秒では
    // 不足しうる。
    testInfo.setTimeout(Math.max(testInfo.timeout, 60_000));

    const kitchenContext = await browser.newContext();
    const registerContext = await browser.newContext();
    const customerContext = await browser.newContext();
    let kitchenDeviceUserId: string | null = null;
    let registerDeviceUserId: string | null = null;

    try {
      const kitchenPage = await kitchenContext.newPage();
      const registerPage = await registerContext.newPage();
      const customerPage = await customerContext.newPage();

      // 1. 厨房タブレットの実プロビジョニング（/setup/kitchen）→/kitchen。
      await kitchenPage.goto("/setup/kitchen");
      await kitchenPage.getByLabel("セットアップコード").fill(deviceSetupCode);
      await kitchenPage.getByRole("button", { name: "セットアップする" }).click();
      await expect(
        kitchenPage.getByRole("heading", { name: "セットアップ完了" }),
      ).toBeVisible();
      kitchenDeviceUserId = await readDeviceUserId(kitchenPage);

      await kitchenPage.goto("/kitchen");
      await expect(kitchenPage.getByTestId("food-board")).toBeVisible();
      // 実際にRealtimeチャンネルがSUBSCRIBEDになった（=onSyncが少なくとも
      // 一度呼ばれた）ことを、KitchenBoardScreenの接続状態インジケーターで
      // 確認してから注文を送信する。購読確立前に送信すると、Realtime
      // イベントを取りこぼして5秒フォールバックポーリング頼みになり、
      // 本テストが検証したい「伝播がポーリングではなくRealtime経由で
      // 起きていること」という前提が崩れてしまう。
      await expect(
        kitchenPage.getByTestId("kitchen-connection-status"),
      ).toHaveText("リアルタイム接続中", { timeout: 10_000 });

      // 2. レジタブレットの実プロビジョニング（/setup/register）→/register→
      //    対象卓の詳細パネルを開く。
      await registerPage.goto("/setup/register");
      await registerPage
        .getByLabel("セットアップコード")
        .fill(deviceSetupCode);
      await registerPage
        .getByRole("button", { name: "セットアップする" })
        .click();
      await expect(
        registerPage.getByRole("heading", { name: "セットアップ完了" }),
      ).toBeVisible();
      registerDeviceUserId = await readDeviceUserId(registerPage);

      await registerPage.goto("/register");
      await registerPage
        .getByTestId(`register-floor-tile-${tableLabel}`)
        .click();
      await expect(
        registerPage.getByTestId("register-table-detail-panel"),
      ).toBeVisible();
      // RegisterConsoleにはKitchenBoardのような接続状態インジケーターが
      // 無い（tasks.md 9.2 Implementation Notes「接続状態UIを追加しない」
      // 参照——要件5に相当する受入基準が無く、検証済みUXリファレンス
      // （mock-preview.htmlのrenderRegister）にも存在しないという設計
      // 判断）。そのためここでは、確認可能なUIシグナルの代わりに短い
      // 固定の猶予時間でRealtimeチャンネルのSUBSCRIBED確立を待つ
      // （厨房側の実測——プロビジョニング後、/kitchen遷移から接続表示
      // までは通常1秒未満——を踏まえた余裕を見た値）。
      await registerPage.waitForTimeout(1500);

      // 3. 客側画面から実際に注文を送信する（実UIフロー、RPC直叩きではない）。
      await customerPage.goto(`/order/${tableId}`);
      await customerPage
        .getByRole("button", { name: new RegExp(menuItemName) })
        .click();
      await customerPage.getByRole("dialog").waitFor();
      await customerPage
        .getByRole("button", { name: "選択を確定" })
        .click();
      await customerPage.getByTestId("cart-count").click();
      await customerPage
        .getByRole("dialog", { name: "注文カート" })
        .waitFor();
      await customerPage.getByRole("button", { name: "注文する" }).click();
      await expect(customerPage.getByText("送信完了")).toBeVisible();

      // 4. 要件6.1・本タスクの観測可能な完了条件そのもの: 厨房・レジの
      //    両方へ数秒以内に反映される。
      await expect(
        kitchenPage.getByTestId("food-board").getByText(menuItemName),
      ).toBeVisible({ timeout: PROPAGATION_ASSERTION_TIMEOUT_MS });
      await expect(
        registerPage
          .getByTestId("register-table-detail-items")
          .getByText(menuItemName),
      ).toBeVisible({ timeout: PROPAGATION_ASSERTION_TIMEOUT_MS });
    } finally {
      await kitchenContext.close();
      await registerContext.close();
      await customerContext.close();

      // このテストが実際にプロビジョニングした2台（kitchen/register）
      // だけを後始末する（ファイル冒頭のreadDeviceUserId関数コメント
      // 参照——役割ごと全件削除は他の並行実行スペックのデバイスを
      // 巻き込みうるため避ける）。
      const authUserIds = [kitchenDeviceUserId, registerDeviceUserId].filter(
        (id): id is string => id !== null,
      );
      if (authUserIds.length > 0) {
        await pool.query("delete from devices where auth_user_id = any($1)", [
          authUserIds,
        ]);
        for (const authUserId of authUserIds) {
          try {
            await pool.query("delete from auth.users where id = $1", [
              authUserId,
            ]);
          } catch {
            // ベストエフォート。テストの合否には影響しない
            // （kitchen-soldout-board.spec.tsと同じ方針）。
          }
        }
      }
    }
  });
});
