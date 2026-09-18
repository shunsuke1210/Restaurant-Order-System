import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { test, expect, type Page } from "@playwright/test";

// タスク10.4（E2E: 主要ユーザージャーニー）。客のQR注文（写真・オプション選択を
// 含む）→厨房のフード/ドリンクボードへの反映→ステータス更新→レジでの金額確認→
// 会計操作によるセッション終了、および終了済みセッションへの注文拒否までを
// 一つづきのシナリオとして検証する、本specで唯一「客→厨房→レジ」の全経路を
// 通しで検証するテストである。
//
// Requirements: 1.5, 1.6, 1.7, 1.9, 1.12, 3.1, 3.3, 3.4, 4.1, 4.2, 4.4, 5.1,
//   5.4, 6.1, 6.3, 6.4, 6.8
//
// ## 構造上の判断（1本の長いtest() vs test.describe.serial）
// realtime-propagation.spec.ts（タスク9.2）・kitchen-soldout-board.spec.ts
// （タスク7.4）のいずれも「1つのdescribe内に1つの長いtest()」という構造を
// 採っており、本specが検証する内容もその2つの延長線上（3ブラウザコンテキスト・
// 1つの連続したビジネスシナリオ）にあるため、既存の構造をそのまま踏襲する。
// `test.describe.serial()`で複数の小さなtest()に分割する案も検討したが、
// 本シナリオの各ステップ（入店→客注文→厨房反映→レジ確認→会計→旧セッション
// 拒否）は「前のステップが作った状態に次のステップが依存する」という一続きの
// 物語であり、Playwrightの独立したtest()に分割すると（a) 各testの間で
// 3つのブラウザコンテキストをどう引き継ぐか（beforeEach/afterEachを跨いだ
// contextの受け渡しは`test.describe.serial`でも素直ではない）、(b) 個々の
// テストが失敗した場合に「シナリオのどこで壊れたか」はtest名で分かる一方、
// 前段の状態構築ステップ自体をtest()に分けると各testが「単体では意味を
// なさない前提条件」になり、taskの観測可能な完了条件「一連のE2Eシナリオが
// グリーンで完走する」が求める「1つの通しシナリオとして完走すること」を
// 複数のtest()の合算で表現するより、1つのtest()内でステップごとに明確な
// コメント区切り（下記1〜6）を設けて表現する方が実際の意図に忠実だと判断した。
//
// ## フィクスチャの後始末について（並行実行との衝突回避）
// playwright.config.tsは`fullyParallel: true`かつ`webServer`を共有し、
// `e2e/*.spec.ts`はデフォルトで複数ワーカーが並行実行する（realtime-
// propagation.spec.tsの9.2 Implementation Notesが記録した通り）。本specは
// 他specと衝突しないよう独自のrandomUUID接頭辞で卓ラベル・品目名を生成し、
// devicesテーブルの後始末もrole全体削除ではなく本specが実際にプロビジョニング
// した2台（kitchen/register）のauth_user_idのみを対象にする
// （realtime-propagation.spec.tsが確立した方式をそのまま踏襲）。

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. main-user-journey.spec.ts requires it ` +
        "(see .env.local; playwright.config.ts loads it into process.env). " +
        "Run `npm run db:start` first if the local Supabase stack is not running.",
    );
  }
  return value;
}

const connectionString = requireEnv("SUPABASE_DB_URL");
const deviceSetupCode = requireEnv("DEVICE_SETUP_CODE");
const storeId = requireEnv("NEXT_PUBLIC_STORE_ID");
const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supabaseAnonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

const pool = new Pool({ connectionString });

// realtime-propagation.spec.tsと同じ理由・同じ値: 要件6.1の上限5000msより
// 明確な余裕を持たせつつ、5秒フォールバックポーリングが偶然アサーションを
// 通してしまう可能性を減らす値。
const PROPAGATION_ASSERTION_TIMEOUT_MS = 3000;

// 0003_rpc_customer_gateway.sqlがsubmit_orderの検証失敗時に送出するカスタム
// SQLSTATE（submitOrder.integration.test.ts / customerOrderingGateway.tsの
// SESSION_NOT_ACTIVE_SQLSTATEと同じ値。要件4.2の検証に使う）。
const SESSION_NOT_ACTIVE_SQLSTATE = "P0409";

/**
 * realtime-propagation.spec.tsの同名関数と同じ理由・同じ実装（ファイル冒頭
 * コメント「フィクスチャの後始末について」参照。e2e/配下に共有ユーティリティ
 * モジュールが存在しないという既存の規約——各specファイルが自己完結する——を
 * 踏襲し、複製する）。
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

/** 卓詳細パネルの占有中表示（「3名　・　ご来店0分経過session #<uuid>」）から
 * セッションIDを抜き出す。要件4.2の検証（旧セッションIDを再利用して拒否を
 * 確認する）に、DBへ問い合わせ直すのではなくUIが実際に表示した値をそのまま
 * 使うことで、「画面に表示されているセッション」と「拒否されるセッション」が
 * 同一であることまで一貫して検証する。
 */
function extractSessionId(occupancyText: string): string {
  const match = occupancyText.match(
    /session #([0-9a-f-]{36})/,
  );
  if (!match) {
    throw new Error(
      `session id not found in occupancy text: ${occupancyText}`,
    );
  }
  return match[1];
}

// 1x1透明PNGのdata URI。外部ネットワークに依存せず、要件1.5「品目に写真が
// 登録されている場合に表示する」を確実に（外部URLの到達性に左右されずに）
// 検証するための選択。MenuItemCard.tsxは素の<img>タグを使うため、
// next/imageのドメイン許可リスト設定も不要。
const FIXTURE_IMAGE_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test.describe("主要ユーザージャーニー（タスク10.4）", () => {
  const tableLabel = `TJRN${randomUUID().slice(0, 6)}`;
  const menuItemName = `E2E特製唐揚げ_${randomUUID().slice(0, 8)}`;
  const menuItemPrice = 780;
  // 要件6.4（独立レビュー対応で追加）: ドリンクジャンルの2状態カンバン
  // （received→doneのみ、in_progressを経由しない）を厨房ドリンクボードで
  // 実際に検証するための品目。1.5/1.6の精緻なオプション種別の検証は上記
  // food品目で既にカバー済みのため、こちらはoptions無しの最小構成に留める
  // （下記beforeAllのコメント参照）。
  const drinkItemName = `E2E生ビール_${randomUUID().slice(0, 8)}`;
  const drinkItemPrice = 480;
  let tableId: string;
  let menuItemId: string;
  let drinkItemId: string;

  // 要件1.6: choice/toggle/counterの3種のオプションすべてを実際に定義する
  // （OptionSelectionPanel.tsxが描画する3種のUIをすべて実機で検証するため。
  // 客のQR注文の一連のシナリオの中で、1回目の注文はchoiceを既定値以外へ、
  // 2回目の注文はtoggle・counterを既定値以外へ変更する——要件1.9「同一品目に
  // 異なるオプションの組み合わせで注文すると別の明細として登録される」を、
  // 実際に異なるoptionsSummaryを持つ2明細として検証するため）。
  const optionDefs = [
    {
      id: "spice",
      type: "choice",
      label: "辛さ",
      choices: ["普通", "辛口"],
      default: "普通",
    },
    { id: "sauce", type: "toggle", label: "追加ソース", default: false },
    {
      id: "rice",
      type: "counter",
      label: "ライス増量",
      min: 0,
      max: 3,
      default: 0,
    },
  ];

  test.beforeAll(async () => {
    const tableResult = await pool.query<{ id: string }>(
      "insert into tables (id, store_id, label) values (gen_random_uuid(), $1, $2) returning id",
      [storeId, tableLabel],
    );
    tableId = tableResult.rows[0].id;

    // menu_items: 要件1.5（写真）・1.6（オプション）・6.3/6.4（ジャンル別
    // ステータス体系）を実際に検証するため、2件の品目を投入する。
    //
    // 1件目（food）: image_url・options（choice/toggle/counterの3種）を持つ
    // ジャンル="food"の品目。写真・オプション選択（1.5, 1.6）に加え、
    // フード/一品が共有するreceived→in_progress→doneの3状態カンバン
    // （要件6.3）を厨房フードボードで実際にクリック操作して検証する。
    const menuItemResult = await pool.query<{ id: string }>(
      `insert into menu_items (id, store_id, name, price, sold_out, genre, image_url, options)
       values (gen_random_uuid(), $1, $2, $3, false, 'food', $4, $5::jsonb)
       returning id`,
      [
        storeId,
        menuItemName,
        menuItemPrice,
        FIXTURE_IMAGE_DATA_URI,
        JSON.stringify(optionDefs),
      ],
    );
    menuItemId = menuItemResult.rows[0].id;

    // 2件目（drink、独立レビュー対応で追加）: ジャンル="drink"の品目。
    // 要件6.4「ドリンクジャンルは『未対応』『対応済み』の2状態で管理する」を
    // 厨房ドリンクボードで実際に検証するには、ドリンクジャンルの品目自体が
    // 客の注文に含まれている必要がある。旧版は上記food品目1件だけを投入し
    // ており、received→in_progress→doneの3状態遷移（6.3）はfood品目への
    // クリック操作で実際に検証していたが、ドリンクのin_progress禁止という
    // 別の分岐（6.4）はドリンク品目自体が一度も登場しないため一切検証されて
    // いなかった（独立レビューでの指摘: advanceボタンの対象がfoodの品目
    // しかなければ、drinkのin_progress禁止が壊れるregressionをこのテストは
    // 検知できない）。1.5/1.6のオプション種別の精緻な検証は上記food品目で
    // 既にカバー済みのため、この2件目はimage_url無し・options空配列
    // （カラムのデフォルト値をそのまま使う）の最小構成に留め、本テストを
    // 不必要に肥大化させない。
    const drinkItemResult = await pool.query<{ id: string }>(
      `insert into menu_items (id, store_id, name, price, sold_out, genre)
       values (gen_random_uuid(), $1, $2, $3, false, 'drink')
       returning id`,
      [storeId, drinkItemName, drinkItemPrice],
    );
    drinkItemId = drinkItemResult.rows[0].id;
  });

  test.afterAll(async () => {
    // tableIdに紐づくすべてのセッション（本テストが作る最初のセッション、
    // および要件4.4の任意検証で作る2件目のセッションの両方）をまとめて
    // 後始末する（realtime-propagation.spec.tsのFK順序: order_items→
    // orders→table_sessions→tables→menu_items）。
    await pool.query(
      `delete from order_items
       where order_id in (
         select id from orders
         where session_id in (select id from table_sessions where table_id = $1)
       )`,
      [tableId],
    );
    await pool.query(
      `delete from orders
       where session_id in (select id from table_sessions where table_id = $1)`,
      [tableId],
    );
    await pool.query("delete from table_sessions where table_id = $1", [
      tableId,
    ]);
    await pool.query("delete from tables where id = $1", [tableId]);
    // 独立レビュー対応で追加したdrink品目（drinkItemId）も含め、本specが
    // 投入した2件の品目をまとめて後始末する。
    await pool.query("delete from menu_items where id = any($1)", [
      [menuItemId, drinkItemId],
    ]);
    await pool.end();
  });

  test("客のQR注文→厨房反映・ステータス更新→レジでの会計確認→会計操作によるセッション終了→旧セッションへの注文拒否", async ({
    browser,
  }, testInfo) => {
    // 3画面分のプロビジョニング・複数回のRPC往復・厨房での2段階ステータス
    // 更新を含むため、既定の30秒では不足しうる（realtime-propagation.spec.ts
    // の60秒よりさらに手順が多いため90秒とする）。
    testInfo.setTimeout(Math.max(testInfo.timeout, 90_000));

    const registerContext = await browser.newContext();
    const kitchenContext = await browser.newContext();
    const customerContext = await browser.newContext();
    let registerDeviceUserId: string | null = null;
    let kitchenDeviceUserId: string | null = null;

    try {
      const registerPage = await registerContext.newPage();
      const kitchenPage = await kitchenContext.newPage();
      const customerPage = await customerContext.newPage();

      // =======================================================================
      // 1. レジ: 空席卓への入店操作（要件3.1, 3.4, 4.1）。
      // =======================================================================
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
      const floorTile = registerPage.getByTestId(
        `register-floor-tile-${tableLabel}`,
      );
      await expect(floorTile).toBeVisible();
      // 要件4.1（卓ごとに同時アクティブセッションは高々1つ）を、真に空席の
      // 卓から出発することで自然に前提として満たす。
      await expect(
        floorTile.getByTestId("register-floor-tile-vacant"),
      ).toBeVisible();

      await floorTile.click();
      const detailPanel = registerPage.getByTestId(
        "register-table-detail-panel",
      );
      await expect(detailPanel).toBeVisible();
      await detailPanel.getByRole("button", { name: "入店" }).click();

      const checkInForm = registerPage.getByTestId("register-check-in-form");
      await expect(checkInForm).toBeVisible();
      // 既定値2 → 3名へ（要件3.1「人数の入力を求め」を実際に既定値から
      // 変更することで検証する）。
      await registerPage.getByRole("button", { name: "人数を増やす" }).click();
      await expect(
        registerPage.getByTestId("register-check-in-party-size"),
      ).toHaveText("3");
      await checkInForm.getByRole("button", { name: "入店する" }).click();

      // spec完了後のユーザー確認で追加: 入店確定は自動的に卓詳細パネルを
      // 閉じ卓マップへ戻す（FloorMap.tsxのmergeStartedSession冒頭コメント
      // 参照）。観測可能な完了条件そのもの——卓マップのタイル自体に
      // 人数が反映されていること——をタイルレベルで確認する。
      await expect(detailPanel).not.toBeVisible();
      await expect(
        floorTile.getByTestId("register-floor-tile-vacant"),
      ).not.toBeVisible();
      await expect(
        floorTile.getByTestId("register-floor-tile-occupancy"),
      ).toContainText("3名");

      // パネルを再度開く（design decision D、FloorMap.tsx参照: 開いた
      // パネルは背景ポーリング/Realtimeで自動的に最新化されるため、
      // 以降のステップでこのパネルを再利用できる）。以後のセッションID
      // 突合はこのタイミングで読み取る（自動で閉じた直後のパネルからは
      // 読み取れないため）。
      await floorTile.click();
      await expect(detailPanel).toBeVisible();
      const occupancyLine = registerPage.getByTestId(
        "register-table-detail-occupancy",
      );
      await expect(occupancyLine).toContainText("3名");
      const initialOccupancyText = await occupancyLine.innerText();
      const originalSessionId = extractSessionId(initialOccupancyText);

      // =======================================================================
      // 2. 厨房: デバイスプロビジョニング・Realtime購読の確立を待つ
      //    （realtime-propagation.spec.tsと同じ理由: 購読確立前に客が送信
      //    すると5秒フォールバックポーリング頼みになり、伝播がRealtime経由で
      //    あることを検証できなくなる）。
      // =======================================================================
      await kitchenPage.goto("/setup/kitchen");
      await kitchenPage.getByLabel("セットアップコード").fill(deviceSetupCode);
      await kitchenPage
        .getByRole("button", { name: "セットアップする" })
        .click();
      await expect(
        kitchenPage.getByRole("heading", { name: "セットアップ完了" }),
      ).toBeVisible();
      kitchenDeviceUserId = await readDeviceUserId(kitchenPage);

      await kitchenPage.goto("/kitchen");
      await expect(kitchenPage.getByTestId("food-board")).toBeVisible();
      await expect(
        kitchenPage.getByTestId("kitchen-connection-status"),
      ).toHaveText("リアルタイム接続中", { timeout: 10_000 });

      // レジ側もRegisterConsole（FloorMap.tsx）のregister-feedチャンネルが
      // 実際にSUBSCRIBEDになるまでの猶予を置く（RegisterConsoleには接続状態
      // インジケーターが無いため固定の短い待機で代替する、realtime-
      // propagation.spec.tsと同じトレードオフ）。
      await registerPage.waitForTimeout(1500);

      // =======================================================================
      // 3. 客: QR注文（要件1.5 写真, 1.6 オプション選択, 1.7 送信・完了表示,
      //    1.9 別オプション組み合わせは別明細）。
      // =======================================================================
      await customerPage.goto(`/order/${tableId}`);
      await expect(
        customerPage.getByRole("img", { name: menuItemName }),
      ).toBeVisible();

      const menuItemButton = customerPage.getByRole("button", {
        name: new RegExp(menuItemName),
      });

      // --- 1明細目: choiceを既定値（普通）から非既定値（辛口）へ変更する。
      await menuItemButton.click();
      const optionDialog = customerPage.getByRole("dialog", {
        name: `${menuItemName}のオプション選択`,
      });
      await optionDialog.waitFor();
      await optionDialog
        .getByRole("button", { name: "辛口", exact: true })
        .click();
      await expect(
        optionDialog.getByRole("button", { name: "辛口", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await optionDialog
        .getByRole("button", { name: "選択を確定" })
        .click();
      await expect(customerPage.getByTestId("cart-count")).toHaveText(
        "選択中の品目: 1件",
      );

      // --- 2明細目: 同じ品目を、toggle（追加ソース）とcounter（ライス増量）を
      //     既定値から変更して追加する（choiceは既定値の「普通」のまま）。
      await menuItemButton.click();
      await optionDialog.waitFor();
      await optionDialog
        .getByRole("switch", { name: "追加ソース" })
        .click();
      await expect(
        optionDialog.getByRole("switch", { name: "追加ソース" }),
      ).toHaveAttribute("aria-checked", "true");
      await optionDialog
        .getByRole("button", { name: "ライス増量を増やす" })
        .click();
      await expect(optionDialog.getByTestId("rice-count")).toHaveText("1");
      await optionDialog
        .getByRole("button", { name: "選択を確定" })
        .click();
      await expect(customerPage.getByTestId("cart-count")).toHaveText(
        "選択中の品目: 2件",
      );

      // --- 3明細目（独立レビュー対応で追加）: ドリンクジャンルの品目を、
      //     オプション無し・既定数量1件のまま追加する（要件6.4をこの
      //     ジャーニーで実際に検証するため。オプション種別自体の精緻な
      //     検証は上記1・2明細目のfood品目で既にカバー済みのため、この
      //     3明細目はOptionSelectionPanelの分岐を増やさない最小構成に
      //     留める）。
      const drinkItemButton = customerPage.getByRole("button", {
        name: new RegExp(drinkItemName),
      });
      await drinkItemButton.click();
      const drinkOptionDialog = customerPage.getByRole("dialog", {
        name: `${drinkItemName}のオプション選択`,
      });
      await drinkOptionDialog.waitFor();
      await drinkOptionDialog
        .getByRole("button", { name: "選択を確定" })
        .click();
      await expect(customerPage.getByTestId("cart-count")).toHaveText(
        "選択中の品目: 3件",
      );

      // カート内容の確認・送信（要件1.7）。3明細（food×2, drink×1）の
      // 合計を検証する。
      // spec完了後のユーザー確認で追加: 注文確認画面のヘッダーがスタッフ
      // 呼出しボタン・選択中の品目数（テキスト）・注文確認ボタンの順に
      // 並ぶよう再編された。cart-countは非対話的なテキストへ変更された
      // ため、カートを開く操作は新設のorder-confirm-buttonをクリックする
      // （MenuScreen.test.tsxのopenCartPanel/openCartPanelSyncヘルパーと
      // 同じ修正）。
      await customerPage.getByTestId("order-confirm-button").click();
      const cartDialog = customerPage.getByRole("dialog", {
        name: "注文カート",
      });
      await cartDialog.waitFor();
      const expectedSubtotal = `¥${(menuItemPrice * 2 + drinkItemPrice).toLocaleString("ja-JP")}`;
      await expect(cartDialog.getByTestId("cart-subtotal")).toHaveText(
        expectedSubtotal,
      );
      await cartDialog.getByRole("button", { name: "注文する" }).click();

      // 観測可能な完了条件（a）: 注文送信が成功すると送信完了メッセージが
      // 表示される（要件1.7）。
      await expect(cartDialog.getByText("送信完了")).toBeVisible();
      await cartDialog.getByRole("button", { name: "閉じる" }).click();

      // 要件1.12: 確定注文合計が新規のポーリングを待たず即座に反映される
      // （6.2が確立した「送信成功直後に1回追加のrefreshOrderingContext」）。
      await expect(
        customerPage.getByTestId("confirmed-total-amount"),
      ).toHaveText(expectedSubtotal);

      // =======================================================================
      // 4. 厨房: 反映確認（要件6.1 5秒以内, 6.8 卓/時刻の判別, 6.3/6.4
      //    ジャンル別ステータス）。
      // =======================================================================
      const spicyCard = kitchenPage
        .getByTestId("food-board-card")
        .filter({ hasText: tableLabel })
        .filter({ hasText: "辛さ: 辛口" });
      const sauceRiceCard = kitchenPage
        .getByTestId("food-board-card")
        .filter({ hasText: tableLabel })
        .filter({ hasText: "追加ソース" });

      // 要件6.1: 客の送信から数秒以内（5秒の上限に対し明確な余裕を持つ
      // PROPAGATION_ASSERTION_TIMEOUT_MS）に厨房フードボードへ反映される。
      await expect(spicyCard).toBeVisible({
        timeout: PROPAGATION_ASSERTION_TIMEOUT_MS,
      });
      await expect(sauceRiceCard).toBeVisible({
        timeout: PROPAGATION_ASSERTION_TIMEOUT_MS,
      });
      // 要件1.9: 異なるオプションの組み合わせが別々の明細として、
      // 実際に2枚の別カードとして厨房に表示される。フィルタは自卓の
      // tableLabelで絞り込む（storeId全体を対象とするlistKitchenFeedは、
      // 並行実行される他specが同じ店舗へ投入したfoodジャンルの品目も
      // 返しうるため、絞り込み無しのtoHaveCountは他specとの衝突で
      // 偽陽性の失敗を招きうる）。
      await expect(
        kitchenPage
          .getByTestId("food-board-card")
          .filter({ hasText: tableLabel }),
      ).toHaveCount(2);

      // 要件6.8: 卓の識別情報・受注時刻が判別できる形で表示される。
      await expect(spicyCard).toContainText(tableLabel);
      await expect(
        spicyCard.getByTestId("food-board-card-time"),
      ).toHaveText(/^\d{2}:\d{2}$/);

      // 要件6.3: フードジャンルはreceived→in_progress→doneの3状態遷移を
      // 経る（一品専用の直接完了ショートカットは使わない、通常の段階的操作）。
      await expect(
        spicyCard.getByTestId("order-item-action-advance"),
      ).toHaveText("調理開始");
      await spicyCard.getByTestId("order-item-action-advance").click();
      await expect(
        kitchenPage.getByTestId("food-board-column-in_progress"),
      ).toContainText("辛さ: 辛口");
      await expect(
        spicyCard.getByTestId("order-item-action-advance"),
      ).toHaveText("調理完了");
      await spicyCard.getByTestId("order-item-action-advance").click();
      await expect(
        kitchenPage.getByTestId("food-board-column-done"),
      ).toContainText("辛さ: 辛口");
      // もう一方の明細は未対応のまま残っている（一方だけを進めたことの対比）。
      await expect(
        kitchenPage.getByTestId("food-board-column-received"),
      ).toContainText("追加ソース");

      // 要件6.4（独立レビュー対応で追加）: ドリンクジャンルは「未対応」
      // 「対応済み」の2状態のみで管理し、in_progressへの中間遷移を経由
      // しない（food/ippinの3状態遷移とは構造的に異なる別の分岐、
      // DrinkBoard.tsx冒頭コメント「列構成について」参照）。ドリンクボード
      // タブへ切り替えて確認する。
      await kitchenPage.getByRole("tab", { name: "ドリンクボード" }).click();
      const drinkCard = kitchenPage
        .getByTestId("drink-board-card")
        .filter({ hasText: tableLabel });
      await expect(drinkCard).toBeVisible();
      await expect(drinkCard).toContainText(drinkItemName);

      // ドリンクボードにはin_progress列自体がDOM上に存在しない
      // （DrinkBoard.tsxのCOLUMNS定数がin_progressを含めない構造上の
      // 保証。「空の列として0件表示」ではなく、そもそも列そのものが
      // 無いことを確認する）。
      await expect(
        kitchenPage.getByTestId("drink-board-column-in_progress"),
      ).toHaveCount(0);

      // OrderItemStatusActionsがドリンク品目に対して描画するボタンは
      // 「対応完了」（received→doneへの1段階のみ）ただ1つであり、フードの
      // 「調理開始」のような中間ステータスへ進めるボタンは存在しない
      // （OrderItemStatusActions.tsxのresolveActionsがジャンルごとに
      // 分岐する設計、要件6.4）。
      await expect(drinkCard.locator("button")).toHaveCount(1);
      await expect(
        drinkCard.getByTestId("order-item-action-advance"),
      ).toHaveText("対応完了");
      await drinkCard.getByTestId("order-item-action-advance").click();
      await expect(
        kitchenPage.getByTestId("drink-board-column-done"),
      ).toContainText(drinkItemName);

      // =======================================================================
      // 5. レジ: 会計確認（要件5.1 卓別会計確認, 5.4 全卓一覧, 1.12
      //    客側confirmedTotalとの一致）。パネルは1で開いたまま維持しており、
      //    手動リロードなしにRealtime/ポーリングで最新化されることを検証する。
      // =======================================================================
      const items = registerPage.getByTestId("register-table-detail-item");
      await expect(items).toHaveCount(3, {
        timeout: PROPAGATION_ASSERTION_TIMEOUT_MS,
      });

      const spicyRow = items.filter({ hasText: "辛さ: 辛口" });
      const sauceRiceRow = items.filter({ hasText: "追加ソース" });
      const drinkRow = items.filter({ hasText: drinkItemName });
      await expect(spicyRow).toBeVisible();
      await expect(sauceRiceRow).toBeVisible();
      await expect(drinkRow).toBeVisible();

      // 厨房で対応完了/調理完了にした明細のステータス表示がレジ側にも
      // 反映される（画面をまたいだ一貫性、要件5.1）。ドリンク品目は
      // 厨房で「対応完了」まで進めたため、レジ側では要件6.4のドリンク専用
      // ラベル「対応済み」で表示される（TableDetailPanel.tsxの
      // DRINK_STATUS_LABELS、food/ippinの「調理完了」とは意図的に異なる
      // 文言）。
      await expect(
        spicyRow.getByTestId("register-table-detail-item-status"),
      ).toHaveText("調理完了", { timeout: PROPAGATION_ASSERTION_TIMEOUT_MS });
      await expect(
        sauceRiceRow.getByTestId("register-table-detail-item-status"),
      ).toHaveText("未対応");
      await expect(
        drinkRow.getByTestId("register-table-detail-item-status"),
      ).toHaveText("対応済み", { timeout: PROPAGATION_ASSERTION_TIMEOUT_MS });

      // 要件1.12: 客側confirmedTotalとレジ側totalが完全に一致する
      // （design.mdが要求する同一ロジック共有のクロス確認）。food×2明細＋
      // drink×1明細の合計（expectedSubtotal、上記客側フェーズ参照）が
      // ここでも一致することを確認する。
      await expect(
        registerPage.getByTestId("register-table-detail-total"),
      ).toHaveText(expectedSubtotal);

      // 要件5.4: 全卓状況一覧（卓マップ）にも同じ合計金額が反映されている
      // ことを、パネルを閉じずに卓マップ側のタイル表示でも確認する。
      await expect(
        floorTile.getByTestId("register-floor-tile-total"),
      ).toHaveText(expectedSubtotal);

      // =======================================================================
      // 6. レジ: 会計操作によるセッション終了（要件3.3, 4.2, 4.4）。
      // =======================================================================
      await registerPage
        .getByTestId("register-checkout-button")
        .click();
      const checkoutConfirm = registerPage.getByTestId(
        "register-checkout-confirm",
      );
      await expect(checkoutConfirm).toBeVisible();
      await expect(checkoutConfirm).toContainText(
        "お会計完了でよろしいですか？完了するとQRコード情報がリセットされます",
      );
      await registerPage
        .getByTestId("register-checkout-confirm-confirm")
        .click();

      // 観測可能な完了条件そのもの: 会計確認後、卓詳細パネルが閉じて
      // 卓マップ画面が表示され、対象卓が空席状態になる。
      await expect(detailPanel).not.toBeVisible();
      await expect(
        floorTile.getByTestId("register-floor-tile-vacant"),
      ).toBeVisible();

      // 要件4.2: 終了済みセッションに紐づけて送信された注文は拒否される。
      // UIが実際に表示していた旧セッションID（originalSessionId）をそのまま
      // 再利用する（新規セッションのIDではない、要件4.2の文言どおり）。
      // RPC直叩き（真のanonクライアント、submitOrder.integration.test.tsと
      // 同じ生成方法・同じ素の`.rpc()`呼び出し。e2e/配下の他specがいずれも
      // プロジェクトのsrc/を直接importしない既存の規約に倣い、本specでも
      // ラッパー関数を経由せずSQLSTATEを直接検証する）で確認する——閉じた
      // ばかりの客側ブラウザは既に"no-session"画面へ遷移済み・sessionId自体を
      // 保持していないため、実UIフローの再現よりRPC直叩きの方が「旧セッション
      // IDそのもの」を確実に再現できる。
      const orderItemCountBefore = await pool.query<{ count: number }>(
        `select count(*)::int as count from order_items
         where order_id in (select id from orders where session_id = $1)`,
        [originalSessionId],
      );
      const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: rejectedError } = await anonClient.rpc("submit_order", {
        p_session_id: originalSessionId,
        p_idempotency_key: randomUUID(),
        p_items: [
          {
            menuItemId,
            quantity: 1,
            optionSelections: {},
            note: null,
          },
        ],
      });
      expect(rejectedError).not.toBeNull();
      expect(rejectedError?.code).toBe(SESSION_NOT_ACTIVE_SQLSTATE);
      const orderItemCountAfter = await pool.query<{ count: number }>(
        `select count(*)::int as count from order_items
         where order_id in (select id from orders where session_id = $1)`,
        [originalSessionId],
      );
      expect(orderItemCountAfter.rows[0].count).toBe(
        orderItemCountBefore.rows[0].count,
      );

      // 要件4.4（任意検証）: 同じ（今は空席の）卓へ新規に入店すると、
      // 直前に終了したセッションとは独立した新しいセッションIDが割り当てられる。
      await floorTile.click();
      await expect(detailPanel).toBeVisible();
      await detailPanel.getByRole("button", { name: "入店" }).click();
      await registerPage
        .getByTestId("register-check-in-form")
        .getByRole("button", { name: "入店する" })
        .click();
      // 入店確定は自動的にパネルを閉じるため、セッションIDを読み取るには
      // 再度開く（上のオリジナルセッションのチェックインと同じ理由）。
      await expect(detailPanel).not.toBeVisible();
      await floorTile.click();
      await expect(occupancyLine).toContainText("2名");
      const newOccupancyText = await occupancyLine.innerText();
      const newSessionId = extractSessionId(newOccupancyText);
      expect(newSessionId).not.toBe(originalSessionId);
    } finally {
      await registerContext.close();
      await kitchenContext.close();
      await customerContext.close();

      const authUserIds = [registerDeviceUserId, kitchenDeviceUserId].filter(
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
            // ベストエフォート（realtime-propagation.spec.ts / kitchen-
            // soldout-board.spec.tsと同じ方針。テストの合否には影響しない）。
          }
        }
      }
    }
  });
});
