"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ensureDeviceSession } from "@/lib/device/useDeviceIdentity";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  useRealtimeFeed,
  type RealtimeFeedSubscription,
} from "@/lib/realtime/useRealtimeFeed";
import KitchenTabs, { KITCHEN_TABS, type KitchenTabId } from "./KitchenTabs";
import FoodBoard from "./FoodBoard";
import DrinkBoard from "./DrinkBoard";
import SoldOutBoard from "./SoldOutBoard";

/**
 * 厨房KDS画面の実体（design.md「KitchenBoard」コンポーネント）。
 *
 * Requirements: 6.8（固定ヘッダー・サブタブ領域）
 * Design: .kiro/specs/table-order-kitchen/design.md の「KitchenBoard」
 *   （Presentation Layer summary）を参照。
 *
 * ## 本タスク（7.1）のスコープ（歴史的経緯）
 * タスク7.1は当初「3タブ共通シェルと固定ヘッダー」のみを担い、各タブの
 * 内容は簡易なプレースホルダー文言のみだった。7.2/7.3/7.4が順に
 * フード/ドリンク/売り切れの各ボードの実データ表示を実装し、7.1時点の
 * プレースホルダーはすべて置き換え済みである（下記「タスク7.2/7.3/7.4での
 * 更新」参照）。以下は本コンポーネント自体は依然として行わない
 * （tasks.mdの後続タスクが担当）:
 * - ステータス更新操作（7.5、フード/ドリンクボードの品目カードのクリック）
 *
 * ## タスク7.2での更新: フードボードタブの実データ表示への置き換え
 * 7.2は上記スコープのうち「フードボードの実データ表示」のみを実装する
 * （ドリンク/売り切れは引き続きプレースホルダーのまま、7.3/7.4のスコープ）。
 * "food"タブ選択中は、7.1時点のプレースホルダー文言の代わりに
 * `FoodBoard`（`./FoodBoard.tsx`）へ委譲する。`FoodBoard`は
 * `view.status === "ready"`（＝kitchenロールのデバイスセッション確立済み）
 * の場合にのみマウントされ、`ensureDeviceSession`が返した
 * `DeviceIdentity.storeId`をpropsとして受け取る。
 *
 * ## タスク7.3での更新: ドリンクボードタブの実データ表示への置き換え
 * 7.3は「ドリンクボードの実データ表示」を実装する（売り切れは引き続き
 * プレースホルダーのまま、7.4のスコープ）。"drink"タブ選択中は、7.1時点の
 * プレースホルダー文言の代わりに`DrinkBoard`（`./DrinkBoard.tsx`）へ
 * 委譲する。配線方法・propsは"food"タブの`FoodBoard`と全く同型。
 *
 * ## タスク7.4での更新: 売り切れボードタブの実データ表示への置き換え
 * 7.4は「売り切れボードの実データ表示（品目検索・サマリー・売り切れ切り替えの
 * 確認モーダル）」を実装する。"soldout"タブ選択中は、7.1時点のプレースホルダー
 * 文言の代わりに`SoldOutBoard`（`./SoldOutBoard.tsx`）へ委譲する。配線方法・
 * propsは"food"/"drink"タブと全く同型。これで3タブすべてが実データ表示に
 * 置き換わったため、プレースホルダー分岐（`PLACEHOLDER_TEXT`）は不要になり
 * 削除した。
 *
 * ## タスク7.6での更新: 接続断表示とuseRealtimeFeedの配線
 * 7.6は「接続断表示と再接続後の最新一覧への同期」（要件6.9）を実装する。
 * 上記「本タスク（7.1）のスコープ」に記載していた「useRealtimeFeedの配線・
 * 接続断表示（7.6）」はこれで解消し、本コンポーネントが3タブ共通で
 * RealtimeFeed（design.md P0依存）に接続する唯一の場所になった。
 *
 * ### なぜKitchenBoardScreenレベルで一度だけ配線するか
 * 接続状態インジケーターは固定ヘッダー（`data-testid="kitchen-fixed-header"`）
 * に常時表示する必要があり、mock-preview.htmlの`renderKitchen`関数が組み立てる
 * `fixedTop`（`.screen-header`の`conn-dot`、タブ内容とは別の兄弟要素）が
 * それを裏付ける。仮にFoodBoard/DrinkBoard/SoldOutBoard各々が独自に
 * `useRealtimeFeed`を呼ぶ設計にすると、"soldout"タブへ切り替えた瞬間に
 * フード/ドリンクボードがアンマウントされてそのフックごと消え、
 * インジケーターが画面から消えてしまう（mockの検証済み挙動と矛盾する）。
 * そのため`useRealtimeFeed`は本コンポーネントで一度だけ呼び出し、
 * `channelName: "kitchen-feed"`・`subscriptions: [{ table: "order_items" }]`
 * （0008マイグレーションが実際にpublicationへ登録・kitchenロールへSELECT
 * 許可している3テーブルのうちorder_itemsのみ。table_sessions/
 * call_requestsはregisterロール限定のRLSであり、kitchenが購読しても
 * 配信されないため購読対象に含めない）を指定し、`enabled: view.status ===
 * "ready"`で他のボードと同じく「kitchenロールのデバイスセッション確立済み」
 * の場合のみ有効化する。
 *
 * ### 接続状態表示（要件6.9、mock-preview.htmlで検証済みの文言をそのまま流用）
 * 固定ヘッダー内に3つの要素を追加する。いずれもヘッダー（固定領域）の
 * 子孫でありスクロール領域の子孫にはしない（KitchenBoardScreen.test.tsxの
 * 既存の構造検証「固定ヘッダーとスクロール領域は兄弟要素」を壊さないため）。
 * 1. `data-testid="kitchen-connection-status"` — 常時表示の小さなインジ
 *    ケーター。文言はmock-preview.htmlの`renderKitchen`関数（`conn-dot`
 *    要素）と完全に一致させる: connected→「リアルタイム接続中」、
 *    disconnected→「接続が切れています」。
 * 2. `data-testid="kitchen-disconnected-banner"`（`role="alert"`） —
 *    disconnected中のみ表示する永続的な警告バナー。文言はmock-preview.html
 *    の`.banner.warn`と同じ「接続が切断されました。最新の注文が届いて
 *    いない可能性があります。」だが、mock固有の「再接続する」ボタンは
 *    含めない（mock-preview.html冒頭`foot-note`が明記する通り、破線で
 *    囲った操作＝プレビュー確認用の補助であり実際の製品UIには含まれない。
 *    実際の`@supabase/supabase-js`のRealtimeクライアントは自動的に再接続を
 *    試みるため、手動再接続ボタン自体が不要）。
 * 3. `data-testid="kitchen-reconnected-banner"` — disconnected→connectedへの
 *    「真の遷移」でのみ表示する一時的なバナー（mock-previewの
 *    `reconnectNotice`と同じ「再接続しました。最新の注文一覧を取得
 *    しました。」）。マウント直後の最初の接続確立はこの遷移に該当しない
 *    ——`useRealtimeFeed`自身は「初回SUBSCRIBED」と「切断後の再接続」を
 *    区別しない設計（useRealtimeFeed.ts冒頭コメント「## 再接続時のみに
 *    限らず〜」参照。呼び出し側の責務）であるため、本コンポーネントが
 *    `hasConnectedOnceRef`で「一度でもconnectedに到達したか」を保持し
 *    判定する。表示後`RECONNECTED_BANNER_DURATION_MS`（2200ms、
 *    mock-preview.htmlの`toggleKitchenConnection`が使うタイムアウトと
 *    同じ値。実機UXレビュー済みの値をそのまま踏襲する）で自動的に
 *    非表示にする。disconnectedへ再度遷移した場合は、表示中の再接続
 *    バナーを待たずに即座に消す（「再接続しました」と「接続が切れて
 *    います」が同時に表示される矛盾を避けるため）。
 *
 * ### 再同期のフード/ドリンクボードへの配線について（`resyncSignal` prop）
 * `useRealtimeFeed`の`onSync`は「初回SUBSCRIBED時・切断からの再接続時・
 * 購読中のorder_items変更検知時」のいずれでも呼ばれる（useRealtimeFeed.ts
 * 冒頭コメント参照）。これを単調増加するカウンタ`resyncToken`（タスク6.3で
 * 確立した「タイマー/ヒューリスティックではなく単調増加するシーケンス
 * カウンタでどちらが新しいかを判定する」設計方針の再利用）として
 * FoodBoard/DrinkBoardへ`resyncSignal` propで渡す。SoldOutBoardには渡さず
 * 本タスクでも一切変更しない（`menu_items`は0008マイグレーションで
 * publicationに登録されておらずRealtime配信の対象ではないため、そもそも
 * 再同期すべきシグナルが存在しない）。FoodBoard/DrinkBoard側が
 * `resyncSignal`をどう扱うか（既存のマウント時フェッチ+ポーリングeffectとは
 * 別の独立したeffectにする理由を含む）はFoodBoard.tsx/DrinkBoard.tsx冒頭
 * コメント「タスク7.6での更新」を参照。
 *
 * ### ポーリングを維持する判断について（tasks.md Implementation Notes参照）
 * FoodBoard.tsx/DrinkBoard.tsxの5秒間隔ポーリングは「7.6が着手したら
 * 置き換え/補完される想定」という暫定コメント付きだったが、本タスクでは
 * 「補完」を選択し、ポーリング自体は変更しない（両ファイルとも
 * `*_BOARD_POLL_INTERVAL_MS`は5000msのまま）。理由: `useRealtimeFeed`の
 * `status === "connected"`はwebsocketの生存確認に過ぎず、あらゆる見逃し
 * イベントに対する形式的な保証ではない。厨房KDSという「画面が気づかれず
 * 古いままになる＝注文の見逃し」が実運用上の重大事故に直結する製品に
 * おいて、低コストな二重の安全網（Realtimeによる即時反映を主経路とし、
 * ポーリングを最終防衛線として残す）を選ぶ。
 *
 * ## デバイスセッション確認について（タスク9.1との役割分担）
 * `/kitchen`はデバイス識別基盤（タスク2.1-2.3）が要求するkitchen-role
 * 認証済みセッションを前提とする画面である。9.1は「未プロビジョニングの
 * 場合は/setup/[role]へ誘導する」導線を正式に実装するタスクだが、それまでの
 * 間もこの画面がクラッシュしたり空白のまま固まったりしないよう、本タスクでも
 * マウント時に`ensureDeviceSession()`を呼び、失敗時は最小限の案内文を
 * 表示するに留める（本タスクの完了条件はタブ/固定ヘッダーの構造であり、
 * セットアップ画面への自動遷移導線までは作り込まない。CustomerOrderAppが
 * 6.1で最小限の案内画面を出し、6.4で正式な画面を実装した「段階的な充実」と
 * 同じパターン）。`ensureDeviceSession`はNOT_PROVISIONED以外の想定外の
 * 失敗（ネットワーク断等）をResultではなく例外として投げる設計のため
 * （useDeviceIdentity.ts冒頭コメント参照）、必ずtry/catchで捕捉する。
 * 併せて、万一`register`役割のデバイスで`/kitchen`を開いた場合も
 * （将来7.2+がlistKitchenFeedを呼び出せばサーバー側のassert_device_role
 * がFORBIDDENで拒否するが、本タスクの時点ではまだRPC呼び出しが無いため）
 * クラッシュせず同様の案内文を表示する防御的な分岐を設ける。
 *
 * ## レイアウト構造について（mock-preview.html #kitchenScreen参照）
 * mock-preview.htmlの`renderKitchen`関数・関連CSS
 * （`.screen-inner{display:flex;flex-direction:column}`、
 * `.scroll-area{overflow-y:auto;flex:1;min-height:0}`、`.screen-header`/
 * `.tabs`はいずれも`flex-shrink:0`でスクロール領域の外）が検証済みの構造を
 * そのままTailwindで再現する: 画面全体を`flex flex-col`の縦積み
 * コンテナとし、タイトル＋タブバーを`shrink-0`（スクロールしても動かない）、
 * 実際のボード内容はその下の`flex-1 overflow-y-auto`な領域（スクロールする側）
 * に閉じ込める。固定ヘッダーとスクロール領域は兄弟要素であり、タブバーが
 * スクロール領域の子になることはない
 * （観測可能な完了条件「ボード内をスクロールしてもタブ・ヘッダーが画面上部に
 * 固定表示され続ける」の実現方法。KitchenBoardScreen.test.tsxの構造検証と、
 * 実ブラウザでのスクロール確認の両方で裏付ける）。
 */

type ViewState =
  | { status: "checking-device" }
  | { status: "device-unavailable"; message: string }
  | { status: "ready"; storeId: string };

const NOT_PROVISIONED_MESSAGE =
  "このタブレットは厨房用デバイスとしてセットアップされていません。店舗スタッフにご確認のうえ、/setup/kitchen からセットアップしてください。";

const WRONG_ROLE_MESSAGE =
  "このタブレットは厨房用デバイスとして登録されていません（別の役割のデバイスとして登録済みです）。店舗スタッフにご確認ください。";

const GENERIC_DEVICE_ERROR_MESSAGE =
  "デバイスの確認中に予期しないエラーが発生しました。ネットワーク接続をご確認のうえ、画面を再読み込みしてください。";

// タスク7.6: mock-preview.htmlのtoggleKitchenConnection関数が使うタイムアウト
// 値（実機UXレビュー済み）と同じ2200msを踏襲する。
const RECONNECTED_BANNER_DURATION_MS = 2200;

// タスク7.6: kitchen-feedチャンネルの購読対象。0008マイグレーションで
// kitchenロールがSELECT可能なのはorder_itemsのみ（上記コメント参照）。
const KITCHEN_REALTIME_SUBSCRIPTIONS: ReadonlyArray<RealtimeFeedSubscription> =
  [{ table: "order_items" }];

// タスク7.6: mock-preview.htmlの`conn-dot`と完全に一致させる文言。
const CONNECTION_STATUS_LABEL: Record<"connected" | "disconnected", string> = {
  connected: "リアルタイム接続中",
  disconnected: "接続が切れています",
};

const DISCONNECTED_BANNER_MESSAGE =
  "接続が切断されました。最新の注文が届いていない可能性があります。";
const RECONNECTED_BANNER_MESSAGE =
  "再接続しました。最新の注文一覧を取得しました。";

export default function KitchenBoardScreen() {
  const [view, setView] = useState<ViewState>({ status: "checking-device" });
  const [activeTab, setActiveTab] = useState<KitchenTabId>("food");

  useEffect(() => {
    let cancelled = false;

    async function checkDevice() {
      // ensureDeviceSessionはNOT_PROVISIONED以外の想定外の失敗（ネットワーク断等）
      // をResultではなく例外として投げる（useDeviceIdentity.ts冒頭コメント参照）ため、
      // 必ずtry/catchで捕捉する（tasks.md Implementation Notesが確立した
      // 「ドキュメント化されたエラーコード以外は例外」規約への対応）。
      try {
        const result = await ensureDeviceSession();
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setView({
            status: "device-unavailable",
            message: NOT_PROVISIONED_MESSAGE,
          });
          return;
        }
        if (result.value.role !== "kitchen") {
          setView({
            status: "device-unavailable",
            message: WRONG_ROLE_MESSAGE,
          });
          return;
        }
        setView({ status: "ready", storeId: result.value.storeId });
      } catch {
        if (!cancelled) {
          setView({
            status: "device-unavailable",
            message: GENERIC_DEVICE_ERROR_MESSAGE,
          });
        }
      }
    }

    void checkDevice();
    return () => {
      cancelled = true;
    };
  }, []);

  // タスク7.6: kitchen-feedチャンネルへ接続するSupabaseクライアント。
  // FoodBoard.tsx等と同じDIパターン（画面ごとに1つ生成し、useMemoで
  // 安定させてuseRealtimeFeedの購読が不要に張り直されないようにする）。
  const realtimeClient = useMemo(() => createBrowserClient(), []);

  // タスク7.6: onSyncが呼ばれるたびにインクリメントする単調増加カウンタ。
  // 6.3で確立した「どちらが新しいかをタイマーではなくシーケンスカウンタで
  // 判定する」設計を再利用し、現在表示中のボード（FoodBoard/DrinkBoard）へ
  // `resyncSignal`として渡す（上記ファイル冒頭コメント「再同期の
  // フード/ドリンクボードへの配線について」参照）。
  const [resyncToken, setResyncToken] = useState(0);

  // タスク7.6: 「一度でもconnectedに到達したか」を保持する。再接続バナーは
  // 真のdisconnected→connected遷移でのみ表示し、マウント直後の初回接続では
  // 表示しない（useRealtimeFeed自身はこの区別をしないため、呼び出し側——
  // 本コンポーネント——の責務。上記ファイル冒頭コメント参照）。
  const hasConnectedOnceRef = useRef(false);
  const [showReconnectedBanner, setShowReconnectedBanner] = useState(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const { status: connectionStatus } = useRealtimeFeed({
    client: realtimeClient,
    channelName: "kitchen-feed",
    subscriptions: KITCHEN_REALTIME_SUBSCRIPTIONS,
    enabled: view.status === "ready",
    onSync: () => {
      setResyncToken((token) => token + 1);
    },
  });

  useEffect(() => {
    if (connectionStatus === "connected") {
      if (hasConnectedOnceRef.current) {
        // 真の再接続（マウント直後の初回接続ではない）。
        setShowReconnectedBanner(true);
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
        reconnectTimeoutRef.current = setTimeout(() => {
          setShowReconnectedBanner(false);
          reconnectTimeoutRef.current = null;
        }, RECONNECTED_BANNER_DURATION_MS);
      }
      hasConnectedOnceRef.current = true;
      return;
    }

    // disconnected: 表示中の再接続バナーがあれば即座に消す（持続的な警告
    // バナーに表示を譲り、「再接続しました」と「接続が切れています」が
    // 同時に表示される矛盾した状態を避ける）。タイマーが残っている＝
    // バナー表示中の場合にのみsetStateする（react-hooks/set-state-in-effect
    // 対策。useRealtimeFeed.ts冒頭コメント「connectionStatusは...effect本体で
    // 同期的にsetStateしない」と同種の配慮。タイマーが無ければバナーは
    // 既に非表示のため、無条件のsetState呼び出しを避けられる）。
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
      setShowReconnectedBanner(false);
    }
  }, [connectionStatus]);

  // アンマウント時に保留中の再接続バナー非表示タイマーを片付ける。
  useEffect(() => {
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  if (view.status === "checking-device") {
    return (
      <main className="flex h-screen items-center justify-center bg-white">
        <p className="text-sm text-neutral-500">確認中...</p>
      </main>
    );
  }

  if (view.status === "device-unavailable") {
    return (
      <main
        data-testid="kitchen-device-unavailable"
        className="flex h-screen flex-col items-center justify-center gap-3 bg-white px-6 text-center"
      >
        <h1 className="text-lg font-semibold text-neutral-900">
          厨房画面を利用できません
        </h1>
        <p
          role="alert"
          className="max-w-sm text-sm leading-relaxed text-neutral-600"
        >
          {view.message}
        </p>
      </main>
    );
  }

  const activeTabLabel =
    KITCHEN_TABS.find((tab) => tab.id === activeTab)?.label ?? "";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white">
      <header data-testid="kitchen-fixed-header" className="shrink-0">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-base font-semibold text-neutral-900">
            {activeTabLabel}
          </h1>
          <span
            data-testid="kitchen-connection-status"
            className={
              "flex items-center gap-1.5 text-xs font-semibold " +
              (connectionStatus === "connected"
                ? "text-emerald-600"
                : "text-red-600")
            }
          >
            <span
              aria-hidden="true"
              className={
                "h-2 w-2 rounded-full " +
                (connectionStatus === "connected"
                  ? "bg-emerald-500"
                  : "bg-red-500")
              }
            />
            {CONNECTION_STATUS_LABEL[connectionStatus]}
          </span>
        </div>
        <KitchenTabs value={activeTab} onChange={setActiveTab} />
        {connectionStatus === "disconnected" ? (
          <p
            role="alert"
            data-testid="kitchen-disconnected-banner"
            className="bg-red-50 px-4 py-2 text-xs font-semibold text-red-700"
          >
            {DISCONNECTED_BANNER_MESSAGE}
          </p>
        ) : showReconnectedBanner ? (
          <p
            data-testid="kitchen-reconnected-banner"
            className="bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-700"
          >
            {RECONNECTED_BANNER_MESSAGE}
          </p>
        ) : null}
      </header>

      <div
        data-testid="kitchen-scroll-area"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        {activeTab === "food" ? (
          <FoodBoard storeId={view.storeId} resyncSignal={resyncToken} />
        ) : activeTab === "drink" ? (
          <DrinkBoard storeId={view.storeId} resyncSignal={resyncToken} />
        ) : (
          <SoldOutBoard storeId={view.storeId} />
        )}
      </div>
    </div>
  );
}
