import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect } from "@playwright/test";

// タスク7.4（売り切れボード: 検索・確認モーダル）の実ブラウザ検証。
// FoodBoard/DrinkBoard（7.2/7.3）にはこの種のE2Eは無いが、本タスクは
// プロジェクト初の「確認してから書き込む」実装であり、かつ新規RPC
// （list_menu_items, 0011_list_menu_items.sql）を追加しているため、
// タブレットの実プロビジョニング（/setup/kitchen）→売り切れボードでの
// 検索・トグル・確認モーダル（いいえ/はい）→サーバー側（DB直接問い合わせ）
// での永続化確認、までを通しで検証する。
//
// 前提: `npm run db:start` + `npm run db:reset`済みのローカルSupabaseスタック。
// .env.localのNEXT_PUBLIC_STORE_ID（開発用に手動投入したstores行）を
// 対象店舗として使う（SetupForm.tsxのgetConfiguredStoreId()参照）。
//
// Requirements: 7.1, 7.3, 7.4

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. kitchen-soldout-board.spec.ts requires it ` +
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

test.describe("売り切れボード（タスク7.4）", () => {
  const availableItemId = randomUUID();
  const availableItemName = `E2E唐揚げ_${randomUUID().slice(0, 8)}`;
  const soldOutItemId = randomUUID();
  const soldOutItemName = `E2Eレモンサワー_${randomUUID().slice(0, 8)}`;

  test.beforeAll(async () => {
    await pool.query(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values
         ($1, $2, $3, 650, false, 'food', '[]'::jsonb),
         ($4, $2, $5, 450, true, 'drink', '[]'::jsonb)`,
      [availableItemId, storeId, availableItemName, soldOutItemId, soldOutItemName],
    );
  });

  test.afterAll(async () => {
    await pool.query("delete from menu_items where id = any($1)", [
      [availableItemId, soldOutItemId],
    ]);

    // このテストが/setup/kitchen経由で新規プロビジョニングしたkitchenデバイス
    // （匿名サインインのauth_user_id）を後始末する。結合テスト
    // （setSoldOut.integration.test.ts等）と同じベストエフォート方式。
    const devicesResult = await pool.query<{ auth_user_id: string }>(
      "select auth_user_id from devices where store_id = $1 and role = 'kitchen'",
      [storeId],
    );
    if (devicesResult.rows.length > 0) {
      const authUserIds = devicesResult.rows.map((row) => row.auth_user_id);
      await pool.query("delete from devices where auth_user_id = any($1)", [
        authUserIds,
      ]);
      for (const authUserId of authUserIds) {
        try {
          await pool.query("delete from auth.users where id = $1", [
            authUserId,
          ]);
        } catch {
          // ベストエフォート。テストの合否には影響しない。
        }
      }
    }

    await pool.end();
  });

  test("プロビジョニング→検索→トグル→確認モーダル（いいえ/はい）→サーバー側永続化", async ({
    page,
  }) => {
    // 1. 厨房タブレットの初回プロビジョニング（/setup/kitchen）。
    await page.goto("/setup/kitchen");
    await expect(
      page.getByRole("heading", { name: "デバイスセットアップ（厨房）" }),
    ).toBeVisible();

    await page.getByLabel("セットアップコード").fill(deviceSetupCode);
    await page.getByRole("button", { name: "セットアップする" }).click();

    await expect(
      page.getByRole("heading", { name: "セットアップ完了" }),
    ).toBeVisible();

    // 2. 厨房画面 → 売り切れボードタブ。
    await page.goto("/kitchen");
    await page.getByRole("tab", { name: "売り切れボード" }).click();

    const board = page.getByTestId("soldout-board");
    await expect(board).toBeVisible();

    // 3. 検索: availableItemNameで絞り込むと、他の品目（soldOutItemName含む）
    //    は表示されなくなる。
    await page.getByTestId("soldout-search").fill(availableItemName);
    await expect(page.getByText(availableItemName)).toBeVisible();
    await expect(page.getByText(soldOutItemName)).not.toBeVisible();

    const availableRow = page
      .getByTestId("soldout-item-row")
      .filter({ hasText: availableItemName });
    await expect(availableRow).toHaveCount(1);
    await expect(availableRow.getByTestId("soldout-toggle")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // 4. トグルをタップ → 確認モーダルが開く。
    await availableRow.getByTestId("soldout-toggle").click();
    const modal = page.getByTestId("soldout-confirm-modal");
    await expect(modal).toBeVisible();
    await expect(
      page.getByText(`「${availableItemName}」を売り切れにしますか？`),
    ).toBeVisible();

    // 5. 「いいえ」を選ぶ → モーダルが閉じ、状態は変化しない
    //    （タスク7.4の観測可能な完了条件）。サーバー側（DB直接問い合わせ）でも
    //    未変更であることを確認する。
    await page.getByTestId("soldout-confirm-cancel").click();
    await expect(modal).not.toBeVisible();
    await expect(availableRow.getByTestId("soldout-toggle")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    const afterCancel = await pool.query<{ sold_out: boolean }>(
      "select sold_out from menu_items where id = $1",
      [availableItemId],
    );
    expect(afterCancel.rows[0].sold_out).toBe(false);

    // 6. トグルを再度タップし、今度は「売り切れにする」（はい相当）で確定する。
    await availableRow.getByTestId("soldout-toggle").click();
    await expect(modal).toBeVisible();
    await page.getByTestId("soldout-confirm-ok").click();
    await expect(modal).not.toBeVisible();

    // 表示状態がサーバー確定応答で更新される。
    await expect(availableRow.getByTestId("soldout-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(availableRow.getByTestId("soldout-toggle")).toHaveText(
      "売り切れ中",
    );

    // 7. サーバー側の実際の永続化を、クライアント表示とは独立にDB直接
    //    問い合わせで確認する（本タスクの自己レビュー観点そのもの）。
    const afterConfirm = await pool.query<{ sold_out: boolean }>(
      "select sold_out from menu_items where id = $1",
      [availableItemId],
    );
    expect(afterConfirm.rows[0].sold_out).toBe(true);

    // 8. 新しいRPC呼び出し（get_ordering_context相当ではなくlist_menu_items）
    //    でも新しい状態が反映されていることを、画面をリロードして再確認する
    //    （クライアントのローカル状態のみが変化したのではないことの追加確認）。
    await page.reload();
    await page.getByRole("tab", { name: "売り切れボード" }).click();
    await page.getByTestId("soldout-search").fill(availableItemName);
    const reloadedRow = page
      .getByTestId("soldout-item-row")
      .filter({ hasText: availableItemName });
    await expect(reloadedRow.getByTestId("soldout-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
