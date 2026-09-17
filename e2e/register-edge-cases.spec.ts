import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect, type Page } from "@playwright/test";

// タスク10.5（E2E: エッジケース）。
//
// タスク10.5が列挙する5シナリオのうち、以下3つは既存のE2Eスペックで既に
// 実ブラウザ/実RPC層のカバレッジが確認済みである（本タスクの監査で確認、
// tasks.md 10.5 Implementation Notes参照）:
//   - 売り切れ登録の確認モーダル（要件7.1/7.2/7.3）
//     → e2e/kitchen-soldout-board.spec.ts（タスク7.4）
//   - 入店時の人数入力と卓マップ表示（要件3.1, 3.4）
//     → e2e/main-user-journey.spec.ts（タスク10.4、ステップ1）
//   - セッション終了後の旧セッションからの注文拒否（要件4.2、本タスクの1件目の
//     観測可能な完了条件そのもの）
//     → e2e/main-user-journey.spec.ts（タスク10.4、ステップ6）
//
// 残り2シナリオは、コンポーネントテスト（モックしたゲートウェイ）による
// カバレッジは厚いが（人数変更UI: タスク8.7のTableDetailPanel.test.tsx、
// 品目追加・削除UI: タスク8.3のTableDetailPanel.test.tsx）、実ブラウザ・実RPC・
// 実RLSを通す真のE2E層のテストが既存4ファイル（smoke/kitchen-soldout-board/
// realtime-propagation/main-user-journey）のいずれにも存在しない、genuineな
// ギャップだった（grepで確認: 全4ファイルに`update_party_size`・
// `add_order_item`・`remove_order_item`・`人数を変更`・`register-add`・
// `register-remove`いずれの言及も無い）。本ファイルはこの2ギャップを
// 埋める。RegisterConsole境界の同じ画面（卓詳細パネル）に属するエッジ
// ケースのため、main-user-journey.spec.ts（主要ジャーニー、単一の長い
// 通しシナリオ）を肥大化させず、kitchen-soldout-board.spec.tsが独立
// ファイルとして切り出された前例に倣い、新規ファイルへ切り出す。
//
// ## 構造上の判断（1ファイル2describe、各1test、既存ファイルと同型）
// kitchen-soldout-board.spec.ts/realtime-propagation.spec.ts/
// main-user-journey.spec.tsはいずれも「1つのdescribe内に1つの長いtest()」
// という構造を採る。本ファイルは2つの独立したシナリオ（人数変更、品目
// 追加・削除）を扱うため、2つのdescribeブロックへ分割し、各ブロックが
// 自己完結したbeforeAll/afterAll・1つのtest()を持つ（既存ファイルの
// 構造をそのまま2回反復する形。playwright.config.tsの`fullyParallel: true`
// 下では別workerが同時に各describeのbeforeAllを実行しうるため、
// describeを跨いでbeforeAll/フィクスチャを共有しない）。
//
// ## 事前状態の構築方法（direct SQL vs 実UIチェックイン）
// 両シナリオとも「来店中の卓」を前提とするが、来店操作（チェックイン）
// 自体は既にmain-user-journey.spec.tsで実UIを通して検証済みであり、
// 本シナリオの検証対象ではない。realtime-propagation.spec.ts冒頭コメント
// 「table_sessionsの作成は本テストの検証対象とは独立した前提条件であり、
// レジの実チェックインUIを介在させると本テストの本題ではない別の失敗
// 要因を混入させるため」という判断をそのまま踏襲し、`pg`直叩きで
// アクティブセッションを用意してから、各シナリオの本題（人数変更・
// 品目追加/削除の確認モーダル）のみを実UIで検証する。
//
// ## 並行実行との衝突回避
// 他specと同様、卓ラベル・品目名は`randomUUID`接頭辞で一意にし、devices
// テーブルの後始末はrole全体削除ではなく本specが実際にプロビジョニング
// したauth_user_idのみを対象にする（realtime-propagation.spec.ts /
// main-user-journey.spec.tsが確立した方式をそのまま踏襲）。

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. register-edge-cases.spec.ts requires it ` +
        "(see .env.local; playwright.config.ts loads it into process.env). " +
        "Run `npm run db:start` first if the local Supabase stack is not running.",
    );
  }
  return value;
}

const connectionString = requireEnv("SUPABASE_DB_URL");
const deviceSetupCode = requireEnv("DEVICE_SETUP_CODE");
const storeId = requireEnv("NEXT_PUBLIC_STORE_ID");

// 本ファイルは2つの独立したdescribeを持つ（ファイル冒頭コメント「構造上の
// 判断」参照）。各describeが自分自身の`Pool`インスタンスを持ち、自分の
// afterAllでのみ`end()`する——単一の`pool`をファイル全体で共有すると、
// 一方のdescribeのafterAllが呼ぶ`pool.end()`後にもう一方のdescribeの
// beforeAll/testが同じpoolを使おうとして
// `Error: Cannot use a pool after calling end on the pool`になる
// （`--workers=1`実行時に実際にこのエラーで検出した）。

/**
 * realtime-propagation.spec.ts / main-user-journey.spec.tsの同名関数と同じ
 * 実装（e2e/配下の各specファイルが自己完結するという既存の規約を踏襲し、
 * 複製する）。
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

/** このspecが実際にプロビジョニングしたregisterデバイス1台のみを後始末する
 * （role全体削除は他specのデバイス行を巻き込みうるため避ける、
 * realtime-propagation.spec.tsと同じ方針）。
 */
async function cleanupDevice(
  pool: Pool,
  deviceUserId: string | null,
): Promise<void> {
  if (!deviceUserId) {
    return;
  }
  await pool.query("delete from devices where auth_user_id = $1", [
    deviceUserId,
  ]);
  try {
    await pool.query("delete from auth.users where id = $1", [deviceUserId]);
  } catch {
    // ベストエフォート。テストの合否には影響しない（他specと同じ方針）。
  }
}

async function provisionRegisterDevice(page: Page): Promise<string> {
  await page.goto("/setup/register");
  await page.getByLabel("セットアップコード").fill(deviceSetupCode);
  await page.getByRole("button", { name: "セットアップする" }).click();
  await expect(
    page.getByRole("heading", { name: "セットアップ完了" }),
  ).toBeVisible();
  return readDeviceUserId(page);
}

test.describe("来店中の人数変更確認モーダル（タスク10.5）", () => {
  // タスクの2件目の観測可能な完了条件そのもの: 「人数変更の確認モーダルで
  // 確認すると卓マップの人数表示が変わることがテストで確認される」。
  // Requirements: 3.5
  const pool = new Pool({ connectionString });
  const tableLabel = `TPSZ${randomUUID().slice(0, 6)}`;
  const initialPartySize = 2;
  let tableId: string;
  let sessionId: string;

  test.beforeAll(async () => {
    const tableResult = await pool.query<{ id: string }>(
      "insert into tables (id, store_id, label) values (gen_random_uuid(), $1, $2) returning id",
      [storeId, tableLabel],
    );
    tableId = tableResult.rows[0].id;

    const sessionResult = await pool.query<{ id: string }>(
      "insert into table_sessions (id, table_id, status, party_size) values (gen_random_uuid(), $1, 'active', $2) returning id",
      [tableId, initialPartySize],
    );
    sessionId = sessionResult.rows[0].id;
  });

  test.afterAll(async () => {
    // FK順序（table_sessions→tables）。本シナリオは注文明細を作らないため
    // order_items/ordersの削除は不要。
    await pool.query("delete from table_sessions where id = $1", [sessionId]);
    await pool.query("delete from tables where id = $1", [tableId]);
    await pool.end();
  });

  test("人数変更ステッパー→確認モーダルの「いいえ」で変化なし、「はい」で卓マップ・卓詳細パネル双方の人数表示が更新される", async ({
    page,
  }) => {
    const deviceUserId = await provisionRegisterDevice(page);

    try {
      await page.goto("/register");
      const floorTile = page.getByTestId(`register-floor-tile-${tableLabel}`);
      await expect(floorTile).toBeVisible();
      await expect(
        floorTile.getByTestId("register-floor-tile-occupancy"),
      ).toContainText(`${initialPartySize}名`);

      await floorTile.click();
      const detailPanel = page.getByTestId("register-table-detail-panel");
      await expect(detailPanel).toBeVisible();
      const occupancyLine = page.getByTestId(
        "register-table-detail-occupancy",
      );
      await expect(occupancyLine).toContainText(`${initialPartySize}名`);

      // 1. 「人数を変更」タップでステッパーが開き、初期値はチェックイン時の
      //    既定値（2）ではなく現在の実際の人数（initialPartySize）になる
      //    （タスク8.7 design decisions F）。
      await page
        .getByTestId("register-party-size-edit-toggle")
        .click();
      const editForm = page.getByTestId("register-party-size-edit-form");
      await expect(editForm).toBeVisible();
      await expect(
        page.getByTestId("register-party-size-edit-value"),
      ).toHaveText(String(initialPartySize));

      // 2名 → 5名へ（+3）。
      const increaseButton = editForm.getByRole("button", {
        name: "人数を増やす",
      });
      await increaseButton.click();
      await increaseButton.click();
      await increaseButton.click();
      await expect(
        page.getByTestId("register-party-size-edit-value"),
      ).toHaveText("5");

      // 2. 「確定」→確認モーダル（要件3.5「実行前に確認を求め」）。
      await editForm.getByRole("button", { name: "確定" }).click();
      const confirmModal = page.getByTestId("register-party-size-confirm");
      await expect(confirmModal).toBeVisible();
      await expect(confirmModal).toContainText("人数を5名に変更しますか？");

      // 3. 「いいえ」→確認された場合にのみ更新するという要件3.5の裏面:
      //    モーダルが閉じ、ステッパーは開いたまま下書き値(5)を維持し、
      //    パネル・卓マップの人数表示・DB上のparty_sizeはいずれも不変。
      await page.getByTestId("register-party-size-confirm-cancel").click();
      await expect(confirmModal).not.toBeVisible();
      await expect(editForm).toBeVisible();
      await expect(
        page.getByTestId("register-party-size-edit-value"),
      ).toHaveText("5");
      await expect(occupancyLine).toContainText(`${initialPartySize}名`);
      await expect(
        floorTile.getByTestId("register-floor-tile-occupancy"),
      ).toContainText(`${initialPartySize}名`);

      const afterCancel = await pool.query<{ party_size: number }>(
        "select party_size from table_sessions where id = $1",
        [sessionId],
      );
      expect(afterCancel.rows[0].party_size).toBe(initialPartySize);

      // 4. 再度「確定」→確認モーダルで今度は「変更する」を選ぶ。
      await editForm.getByRole("button", { name: "確定" }).click();
      await expect(confirmModal).toBeVisible();
      await expect(confirmModal).toContainText("人数を5名に変更しますか？");
      await page.getByTestId("register-party-size-confirm-confirm").click();
      await expect(confirmModal).not.toBeVisible();

      // 観測可能な完了条件そのもの: 卓マップのタイルと卓詳細パネルの人数
      // 表示の両方が、再読み込みなしで更新される。ステッパー自体も閉じる
      // （TableDetailPanel.tsx confirmPartySizeChange参照）。
      await expect(editForm).not.toBeVisible();
      await expect(occupancyLine).toContainText("5名");
      await expect(
        floorTile.getByTestId("register-floor-tile-occupancy"),
      ).toContainText("5名");

      const afterConfirm = await pool.query<{ party_size: number }>(
        "select party_size from table_sessions where id = $1",
        [sessionId],
      );
      expect(afterConfirm.rows[0].party_size).toBe(5);
    } finally {
      await cleanupDevice(pool, deviceUserId);
    }
  });
});

test.describe("レジからの品目追加・削除確認モーダル（タスク10.5）", () => {
  // 客のQR注文（submit_order経由）やOptionSelectionPanel再利用の追加
  // （オプション付き品目）とは異なる、レジ自身の「＋品目を追加」/「削除」
  // 操作（add_order_item/remove_order_item RPC、オプション無し品目の
  // 簡易ConfirmDialog経路）を実ブラウザ・実RPC・実RLSで検証する。
  // Requirements: 5.5, 5.6
  const pool = new Pool({ connectionString });
  const tableLabel = `TAIZ${randomUUID().slice(0, 6)}`;
  const menuItemName = `E2Eレジ追加品_${randomUUID().slice(0, 8)}`;
  const menuItemPrice = 550;
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

    // オプション無しの品目（`options: []`）。TableDetailPanel.tsxの
    // requestAddItemはoptions.length===0の場合、OptionSelectionPanelを
    // 経由せず直接ConfirmDialog（register-add-confirm）を開く分岐に入る
    // ——本テストが検証したいのはまさにこの分岐（要件5.5の確認モーダル
    // そのもの）であり、オプション選択自体のUIは客側QR注文（タスク10.4）で
    // 既に実ブラウザ検証済みのため、ここでは意図的にオプション無し品目のみを
    // 使う。
    const menuItemResult = await pool.query<{ id: string }>(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, options)
       values (gen_random_uuid(), $1, $2, $3, false, 'food', '[]'::jsonb)
       returning id`,
      [storeId, menuItemName, menuItemPrice],
    );
    menuItemId = menuItemResult.rows[0].id;
  });

  test.afterAll(async () => {
    // FK順序（order_items→orders→table_sessions/menu_items→tables）。
    await pool.query(
      "delete from order_items where order_id in (select id from orders where session_id = $1)",
      [sessionId],
    );
    await pool.query("delete from orders where session_id = $1", [
      sessionId,
    ]);
    await pool.query("delete from table_sessions where id = $1", [sessionId]);
    await pool.query("delete from tables where id = $1", [tableId]);
    await pool.query("delete from menu_items where id = $1", [menuItemId]);
    await pool.end();
  });

  async function countOrderItems(): Promise<number> {
    const result = await pool.query<{ count: number }>(
      `select count(*)::int as count from order_items
       where order_id in (select id from orders where session_id = $1)`,
      [sessionId],
    );
    return result.rows[0].count;
  }

  test("品目追加の確認モーダル（いいえ/はい）と注文明細削除の確認モーダル（いいえ/はい）が実RPCに反映される", async ({
    page,
  }) => {
    const deviceUserId = await provisionRegisterDevice(page);

    try {
      await page.goto("/register");
      const floorTile = page.getByTestId(`register-floor-tile-${tableLabel}`);
      await expect(floorTile).toBeVisible();
      await floorTile.click();

      const detailPanel = page.getByTestId("register-table-detail-panel");
      await expect(detailPanel).toBeVisible();
      const itemsList = page.getByTestId("register-table-detail-items");
      await expect(itemsList).toContainText("まだ注文はありません");
      const totalAmount = page.getByTestId("register-table-detail-total");
      await expect(totalAmount).toHaveText("¥0");

      // =====================================================================
      // 品目追加（要件5.5）。
      // =====================================================================
      await page.getByTestId("register-add-menu-toggle").click();
      const addMenuList = page.getByTestId("register-add-menu-list");
      await expect(addMenuList).toBeVisible();
      const addButton = page.getByRole("button", {
        name: `${menuItemName}を追加`,
      });
      await expect(addButton).toBeVisible();

      // 1. 「＋」タップ→簡易確認モーダル（オプション無し品目、design
      //    decision「品目追加の確認ステップについて」参照）。
      await addButton.click();
      const addConfirm = page.getByTestId("register-add-confirm");
      await expect(addConfirm).toBeVisible();
      await expect(addConfirm).toContainText(
        `「${menuItemName}」を注文に追加しますか？`,
      );

      // 2. 「いいえ」→追加されず、明細一覧・合計・DBいずれも不変。
      await page.getByTestId("register-add-confirm-cancel").click();
      await expect(addConfirm).not.toBeVisible();
      await expect(itemsList).toContainText("まだ注文はありません");
      await expect(totalAmount).toHaveText("¥0");
      expect(await countOrderItems()).toBe(0);

      // 3. 再度「＋」→今度は「追加する」で確定。
      await addButton.click();
      await expect(addConfirm).toBeVisible();
      await page.getByTestId("register-add-confirm-confirm").click();
      await expect(addConfirm).not.toBeVisible();

      const addedItemRow = page.getByTestId("register-table-detail-item");
      await expect(addedItemRow).toHaveCount(1);
      await expect(addedItemRow).toContainText(menuItemName);
      const expectedUnitTotal = `¥${menuItemPrice.toLocaleString("ja-JP")}`;
      await expect(totalAmount).toHaveText(expectedUnitTotal);

      expect(await countOrderItems()).toBe(1);
      const insertedRow = await pool.query<{
        unit_price_snapshot: string;
        name_snapshot: string;
        quantity: number;
      }>(
        `select unit_price_snapshot, name_snapshot, quantity from order_items
         where order_id in (select id from orders where session_id = $1)`,
        [sessionId],
      );
      expect(insertedRow.rows[0].name_snapshot).toBe(menuItemName);
      // unit_price_snapshotはnumeric型のため、node-pgは精度保持のため文字列
      // として返す（既存のsubmitOrder.integration.test.ts等と同じ前提）。
      expect(Number(insertedRow.rows[0].unit_price_snapshot)).toBe(
        menuItemPrice,
      );
      expect(insertedRow.rows[0].quantity).toBe(1);

      // =====================================================================
      // 注文明細削除（要件5.6）。
      // =====================================================================
      const removeButton = addedItemRow.getByTestId(
        "register-table-detail-item-remove",
      );

      // 4. 「削除」タップ→確認モーダル。
      await removeButton.click();
      const removeConfirm = page.getByTestId("register-remove-confirm");
      await expect(removeConfirm).toBeVisible();
      await expect(removeConfirm).toContainText(
        `「${menuItemName}」を削除しますか？`,
      );
      await expect(removeConfirm).toContainText("この操作は取り消せません。");

      // 5. 「いいえ」→削除されず、明細一覧・合計・DBいずれも不変
      //    （タスク8.3の観測可能な完了条件と同じ主張を、実RPC/DB層で
      //    再確認する）。
      await page.getByTestId("register-remove-confirm-cancel").click();
      await expect(removeConfirm).not.toBeVisible();
      await expect(addedItemRow).toHaveCount(1);
      await expect(totalAmount).toHaveText(expectedUnitTotal);
      expect(await countOrderItems()).toBe(1);

      // 6. 再度「削除」→今度は「削除する」で確定。
      await removeButton.click();
      await expect(removeConfirm).toBeVisible();
      await page.getByTestId("register-remove-confirm-confirm").click();
      await expect(removeConfirm).not.toBeVisible();

      await expect(itemsList).toContainText("まだ注文はありません");
      await expect(totalAmount).toHaveText("¥0");
      // remove_order_itemはハード削除（0004_rpc_staff_gateway.sql 設計判断9/10
      // 参照）であることをDB直接クエリで確認する。
      expect(await countOrderItems()).toBe(0);
    } finally {
      await cleanupDevice(pool, deviceUserId);
    }
  });
});
