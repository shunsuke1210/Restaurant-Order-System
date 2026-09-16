"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  createStaffOperationsGateway,
  type MenuItemGenre,
} from "@/lib/gateways/staffOperationsGateway";
import type {
  OrderItemStatus,
  OrderItemSummary,
} from "@/lib/gateways/customerOrderingGateway";
import { useAdvanceOrderItemStatus } from "./useAdvanceOrderItemStatus";
import OrderItemStatusActions from "./OrderItemStatusActions";

/**
 * フードボード（design.md「KitchenBoard」のフードボードタブ実体）。
 * KitchenBoardScreen（7.1）が"food"タブ選択中にマウントする。
 *
 * Requirements: 6.3, 6.6, 6.7, 6.8, 6.10
 * Design: .kiro/specs/table-order-kitchen/design.md「KitchenBoard」
 *   （「フードボードの未対応列は一品ジャンルを優先表示し（要件6.7、6.8）、
 *   調理完了列は直近に完了したものを上部に表示する（要件6.10）」）、
 *   StaffOperationsGateway.listKitchenFeed のService Interface。
 * Mock: mock-preview.html の`kanbanHtml('food')`（`kanban-5`クラス、
 *   `.order-card`構造、一品バッジ）を参照し、検証済みの5分割（2/2/1）
 *   レイアウトをTailwindで再現する。
 *
 * ## 対象ジャンルについて（food board = food genre AND ippin genre）
 * design.mdのStaffOperationsGateway Responsibilities & Constraints
 * 「updateOrderItemStatusは...フード/一品ジャンルは
 * received → in_progress → done...を許可する」の通り、フード/一品は
 * 同じ3状態カンバン構造を共有する単一のボード（"フードボード"）であり、
 * 一品専用の別ボードではない。一品は「未対応列の先頭優先表示」という
 * 追加ルール（要件6.7）と「未対応→調理完了への直接遷移ショートカット」
 * （要件6.6、こちらは7.5のスコープ）を持つに過ぎない。そのため本コンポーネント
 * は`genre === "food" || genre === "ippin"`の品目のみを対象とし、
 * `genre === "drink"`は除外する（ドリンクボードは7.3が別途実装する）。
 *
 * ## 認証済みクライアントの取得方法について
 * KitchenBoardScreen（7.1）は`@/lib/device/useDeviceIdentity`の
 * `ensureDeviceSession`で"kitchen"ロールの匿名デバイスセッションを既に
 * 確立済みの場合にのみ本コンポーネントをマウントする。本コンポーネントは
 * そのモジュール内部でキャッシュされているクライアントを共有せず、
 * `createBrowserClient()`（`src/app/order/[tableId]/MenuScreen.tsx`が
 * 客側画面で採用しているのと同じ、画面ごとに新規クライアントを生成する
 * 既存パターン）で独立したクライアントを生成する。これは意図的な設計判断:
 * Supabase-jsの匿名セッションは既定でlocalStorageへ永続化され、新規
 * クライアントも初期化時にそのストレージから同じセッションを読み込んでから
 * リクエストの認可ヘッダーを構成する（`.rpc()`はセッション初期化の完了を
 * 待ってから送信する）ため、`ensureDeviceSession`が確立した
 * device_role='kitchen'のJWTは新規クライアントでも正しく利用できる
 * （実ブラウザでの動作確認はタスク完了報告のEVIDENCE参照）。この方式なら
 * `@/lib/device/useDeviceIdentity`モジュールの内部実装
 * （モジュールスコープの`cachedClient`は非公開）に依存せず、
 * KitchenBoardScreen.test.tsx（7.1）が確立した
 * `vi.mock("@/lib/device/useDeviceIdentity", () => ({ ensureDeviceSession: ... }))`
 * という既存のモック（`ensureDeviceSession`のみを提供）を変更せずに
 * 済み、本コンポーネントのテストも`@/lib/gateways/staffOperationsGateway`の
 * `createStaffOperationsGateway`のみをモックする既存の
 * MenuScreen.test.tsxと同型の方式で完結する。
 *
 * ## 更新方式についての設計判断（マウント時フェッチ + 簡易ポーリング）
 * design.mdのRealtimeFeed（`useRealtimeFeed`、タスク5で実装済み）を
 * KitchenBoardへ配線し、切断検知時の再同期表示まで作り込むのはタスク7.6の
 * 明示的なスコープ（「接続断表示と再同期」、要件6.9）であり、本タスクの
 * 完了条件（一品優先表示・調理完了列の直近完了順表示・卓/時刻の可読表示）は
 * いずれも「一覧の並び替え・表示」の正しさのみを要求し、「更新の即時性」
 * 自体は要求しない。一方で、厨房KDSという製品の性質上、7.6が着手されるまでの
 * 間、一度きりの取得のみで新規注文が一切反映されない画面のまま放置するのは、
 * 実運用上望ましくない中間状態である（客が注文しても厨房タブレットを
 * 手動リロードするまで気づけない）。
 *
 * そのため、`CustomerOrderApp`の確定注文合計ライブ更新（6.2、
 * `MenuScreen.tsx`冒頭コメント参照）が既に確立した「`useRealtimeFeed`の
 * 本格導入前は定期ポーリングで代替する」という前例を踏襲し、5秒間隔の
 * 単純なポーリングを暫定的な更新手段として追加する（新規のRealtime購読・
 * 新規の接続断UIは一切追加しない）。7.6が`useRealtimeFeed`を配線した際は、
 * このポーリングは置き換え/補完される想定。バックグラウンドでのポーリング
 * 失敗は画面を壊さないよう握りつぶす（`MenuScreen.tsx`の
 * `refreshOrderingContext`と同じ方針）。初回読み込みの失敗のみ、
 * 明示的なエラー表示に反映する。
 *
 * ## タスク7.5での更新: ステータス更新操作と即時反映
 * 7.5は各カードへステータス更新ボタン（`OrderItemStatusActions`）を追加し、
 * クリック時の`updateOrderItemStatus`呼び出し・成功時のローカル状態への
 * 即時マージ（次回ポーリングを待たない反映）・失敗時の案内表示を
 * `useAdvanceOrderItemStatus`（本ディレクトリの共有フック、DrinkBoard.tsxと
 * 共通利用）へ委譲する。要件6.5に確認モーダルの言及が無いため
 * （SoldOutBoard.tsx・要件7.1/7.3の売り切れ登録/解除との意図的な非対称性、
 * useAdvanceOrderItemStatus.ts冒頭コメント参照）、確認ステップは一切
 * 経由しない。ボタン構成・文言（食/一品/ドリンクのジャンル別の差異、一品の
 * 直接完了ショートカット）はOrderItemStatusActions.tsx冒頭コメント参照。
 *
 * ## タスク7.6での更新: resyncSignal propとポーリング維持の判断
 * 7.6（接続断表示と再同期、要件6.9）はKitchenBoardScreenで一度だけ
 * `useRealtimeFeed`を配線する（"soldout"タブに切り替えてもフード/ドリンク
 * ボードの購読が消えないよう、ボード個別ではなく画面レベルで配線する。
 * 詳細はKitchenBoardScreen.tsx冒頭コメント「タスク7.6での更新」参照）。
 * `onSync`が呼ばれるたびに単調増加する`resyncToken`を、現在表示中の
 * ボードへ`resyncSignal` propとして渡す。本コンポーネントはこれを新設の
 * 独立したeffect（下記参照）で検知し、`load(false)`と全く同じ意味論
 * （成功時のみ表示を差し替え、失敗時は何もしない＝表示中のカードを
 * エラー画面へ巻き戻さない）で背景フェッチを行う。
 *
 * 上のマウント時フェッチ+ポーリングeffect（`[gateway, storeId]`が依存配列）
 * には一切手を加えていない。`resyncSignal`をそちらの依存配列へそのまま
 * 追加すると、resyncSignalが変わるたびにeffect全体が再実行されて
 * `load(true)`（失敗時に全画面エラーへ切り替える初期ロード専用の経路）が
 * 呼ばれ直してしまう退行になるため、意図的に完全に独立したeffectとして
 * 実装した（tasks.md 7.6のImplementation Notes参照）。`resyncSignal`が
 * `undefined`（本コンポーネントの利用側がまだ再同期機構を持たない場合。
 * 上記の大半の既存テストがこれに該当）の間、およびマウント時に渡された
 * 初期値のままの間は一切発火しない（`lastResyncSignalRef`の初期化が
 * 現在値そのものであるため）。
 *
 * ## ポーリングを維持する判断について（7.6着手時点の判断、DrinkBoard.tsxも同一）
 * 本ファイル冒頭「更新方式についての設計判断」が「7.6が配線した際は
 * 置き換え/補完される想定」としていた分岐点について、本タスクは「補完」を
 * 選んだ（`FOOD_BOARD_POLL_INTERVAL_MS`は5000msのまま変更しない）。理由:
 * `useRealtimeFeed`の`status === "connected"`はwebsocketの生存確認であり、
 * あらゆる見逃しイベントに対する形式的な保証ではない
 * （`postgres_changes_options: { wait: true }`により多くのエッジケースは
 * 既に塞がれているが、useRealtimeFeed.ts冒頭コメント自身が「サーバー側の
 * 購読登録が実際に完了する前にSUBSCRIBEDを報告しうる」という実機で踏んだ
 * 落とし穴を記録しており、将来的な別の見逃しパターンを完全には否定
 * できない）。厨房KDSは「画面が気づかれず古いままになる＝注文を見逃す」
 * ことが実運用上の重大な事故に直結する製品であるため、Realtimeによる
 * 即時反映（主経路）に加え、5秒間隔ポーリングを低コストな最終防衛線として
 * 残す。DrinkBoard.tsxも同一の判断を共有し両ファイルの挙動を一致させる
 * （tasks.md Implementation Notesの本タスクエントリにも記録する）。
 */
export const FOOD_BOARD_POLL_INTERVAL_MS = 5000;

type FoodBoardProps = {
  storeId: string;
  /**
   * タスク7.6: KitchenBoardScreenがuseRealtimeFeedのonSyncで発火させる
   * 単調増加カウンタ。値が変化するたびに背景での再取得（load(false)相当）を
   * 行う。省略時（呼び出し側が再同期機構を持たない場合。既存テストの
   * 大半が該当）は一切発火しない。ファイル冒頭コメント「タスク7.6での
   * 更新」参照。
   */
  resyncSignal?: number;
};

export type KitchenFeedItem = OrderItemSummary & {
  tableId: string;
  tableLabel: string;
  genre: MenuItemGenre;
};

type BoardState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: ReadonlyArray<KitchenFeedItem> };

const GENERIC_ERROR_MESSAGE =
  "厨房データの取得に失敗しました。ネットワーク接続をご確認のうえ、画面を再読み込みしてください。";

// design.mdの「フード/一品ジャンルはreceived → in_progress → doneの3状態
// カンバンを共有する」という定義そのもの（ファイル冒頭コメント参照）。
// ドリンク（7.3のドリンクボードが対象）はここに含めない。
const FOOD_BOARD_GENRES: ReadonlySet<MenuItemGenre> = new Set<MenuItemGenre>([
  "food",
  "ippin",
]);

const COLUMNS: ReadonlyArray<{
  key: OrderItemStatus;
  title: string;
  headClassName: string;
  wide: boolean;
}> = [
  {
    key: "received",
    title: "未対応",
    headClassName: "bg-amber-50 text-amber-700",
    wide: true,
  },
  {
    key: "in_progress",
    title: "調理中",
    headClassName: "bg-blue-50 text-blue-700",
    wide: true,
  },
  {
    key: "done",
    title: "調理完了",
    headClassName: "bg-emerald-50 text-emerald-700",
    wide: false,
  },
];

/**
 * `statusUpdatedAt`をHH:MM形式へ整形する。mock-preview.htmlの
 * `fmtClock(ts)`（`getHours()`/`getMinutes()`をゼロ埋め）と同じ表記に揃える。
 *
 * ## データソースについての既知の乖離（mock-preview.htmlとの差異）
 * mock-previewの`order-card-time`は`order.createdAt`（注文自体の受注時刻）を
 * 表示するが、design.mdのOrderItemSummary型は`statusUpdatedAt`
 * （直近のステータス変更時刻）のみを公開し、元の受注時刻を別フィールドとして
 * 持たない。未対応（received）列では、品目は受信時に`status_updated_at`が
 * 現在時刻で初期化されて以降まだ一度もステータス変更されていないため
 * （design.md「新規作成される注文明細のstatusは...常にreceivedから開始する」
 * 「ステータスを変更するたびにstatus_updated_atを現在時刻で更新する」）、
 * `statusUpdatedAt`は実質的に受注時刻と一致する。一方、調理中/調理完了列では
 * 「最後にステータスが変わった時刻」（＝調理開始/調理完了の時刻）を示す
 * ことになり、mock-previewが示す「常に受注時刻」とは意味が異なる。
 * design.mdのRPCがこれ以外の時刻を返さない（0004設計判断22参照）ため、
 * 実際に取得可能なこのフィールドをそのまま「時刻」として表示する
 * （要件6.8の「受注時刻が判別できる形」は、未対応列という最も重要な列では
 * 厳密に満たされ、他の列でも品目ごとの直近の動きを示す時刻として意味を持つ）。
 */
function formatClock(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * `listKitchenFeed`が返す配列を`status`で3分割する。0004設計判断22/
 * tasks.md Implementation Notesの通り、RPCが単一のORDER BY
 * （status_rank, tier_rank, sort_key）で既に正しい順序を確定させているため、
 * ここでは配列を1回走査してstatusごとのバケツへ振り分けるだけに留め、
 * 独自の`sort`/`localeCompare`等は一切行わない（RPCの並び替えロジックと
 * クライアント側の実装が将来divergeするリスクを避けるための意図的な制約）。
 */
function groupByStatus(
  items: ReadonlyArray<KitchenFeedItem>,
): Record<OrderItemStatus, KitchenFeedItem[]> {
  const groups: Record<OrderItemStatus, KitchenFeedItem[]> = {
    received: [],
    in_progress: [],
    done: [],
  };
  for (const item of items) {
    groups[item.status].push(item);
  }
  return groups;
}

export default function FoodBoard({ storeId, resyncSignal }: FoodBoardProps) {
  const gateway = useMemo(
    () => createStaffOperationsGateway(createBrowserClient()),
    [],
  );
  const [state, setState] = useState<BoardState>({ status: "loading" });

  // タスク7.6で追加: 「ローカルでの確定済み変更」が何回起きたかを数える
  // 単調増加カウンタ。7.6のレビューで発見された競合——背景フェッチ
  // （5秒ポーリングまたはresyncSignal起点の再取得）がユーザーのステータス
  // 更新クリック（advance()、7.5）より前に開始され、そのクリックの
  // サーバー確定済みマージより後に解決すると、背景フェッチが持つ古い
  // スナップショット（クリック前の状態）で該当品目のstatusを丸ごと
  // 上書きし、マージ結果を巻き戻してしまう——を防ぐために使う。
  // 6.3のImplementation Notes「タイマー/ヒューリスティックではなく
  // 単調増加するシーケンスカウンタでどちらが新しいかを判定する」という
  // 確立済みの設計をそのまま踏襲する。
  const mutationSeqRef = useRef(0);

  // タスク7.5: ステータス更新後の即時反映用。`state`が"ready"の場合のみ
  // 該当品目をマージする（読み込み中/エラー中はupdateItems自体を
  // useAdvanceOrderItemStatusから呼び出す機会が無いため、事実上到達しない）。
  // タスク7.6で追加: このマージが「ローカルでの確定済み変更」そのものの
  // ため、呼び出しのたびに`mutationSeqRef`をインクリメントする（上記コメント
  // 参照）。
  function updateItems(
    updater: (
      prev: ReadonlyArray<KitchenFeedItem>,
    ) => ReadonlyArray<KitchenFeedItem>,
  ) {
    mutationSeqRef.current += 1;
    setState((prev) =>
      prev.status === "ready"
        ? { status: "ready", items: updater(prev.items) }
        : prev,
    );
  }

  const { advance, pendingItemId, actionError } = useAdvanceOrderItemStatus(
    gateway,
    updateItems,
  );

  // MenuScreen.tsx（6.2）が確立した既存パターン——マウント時の初回取得と
  // 背景ポーリングを、1つのuseEffect内でローカルに定義した非同期関数として
  // まとめ、`cancelled`フラグでアンマウント後のsetStateを防ぐ——をそのまま
  // 踏襲する（`load`をuseCallbackとして外へ切り出しuseEffectの依存配列へ
  // 渡す構成は、eslint-plugin-react-hooksの`set-state-in-effect`ルールが
  // 「エフェクト内で直接setStateする関数を呼んでいる」と検知するため
  // 採用しない）。
  useEffect(() => {
    let cancelled = false;

    // tasks.md Implementation Notes: listKitchenFeedはResult<T, never>
    // ——ドキュメント化されたエラーコード以外（FORBIDDENを含むあらゆる
    // エラー）は常に例外としてthrowされる（Resultのエラーメンバーには
    // 決して現れない）ため、必ずtry/catchで捕捉する
    // （customerOrderingGateway/useDeviceIdentityで確立済みの既存規約）。
    async function load(isInitialLoad: boolean) {
      // タスク7.6で追加: フェッチ開始時点のmutationSeqRefを記録する
      // （ファイル冒頭のmutationSeqRef宣言コメント参照）。
      const fetchSeq = mutationSeqRef.current;
      try {
        const result = await gateway.listKitchenFeed({ storeId });
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          // design.mdの`never`エラー型（上記コメント参照）によりここへは
          // 実際には到達しない防御的分岐。
          if (isInitialLoad) {
            setState({ status: "error", message: GENERIC_ERROR_MESSAGE });
          }
          return;
        }
        if (mutationSeqRef.current !== fetchSeq) {
          // タスク7.6で追加: このフェッチが開始してから解決するまでの間に
          // advance()によるローカルマージが発生した＝このフェッチが持つ
          // スナップショットはそのマージより古い可能性がある。丸ごと
          // 上書きすると、たった今マージしたばかりの新しいstatusを古い
          // statusへ巻き戻してしまう（7.6レビューで発見された競合、
          // tasks.md Implementation Notes参照）。このフェッチの結果は
          // 破棄し、次回のポーリング/再同期に委ねる（その頃にはサーバー側の
          // 実データ自体がこのマージ結果を反映済みのため、次回フェッチは
          // 安全に適用できる）。isInitialLoadの場合は実質発生しない
          // （読み込み中はまだadvance()のボタン自体が描画されないため）。
          return;
        }
        const foodItems = result.value.filter((item) =>
          FOOD_BOARD_GENRES.has(item.genre),
        );
        setState({ status: "ready", items: foodItems });
      } catch {
        // 初回読み込みの失敗のみ明示的なエラー表示にする。バックグラウンド
        // ポーリングの失敗は画面を壊さないよう握りつぶす（ファイル冒頭
        // コメント「更新方式についての設計判断」、MenuScreen.tsxの
        // refreshOrderingContextと同じ方針）。
        if (!cancelled && isInitialLoad) {
          setState({ status: "error", message: GENERIC_ERROR_MESSAGE });
        }
      }
    }

    void load(true);

    const interval = setInterval(() => {
      void load(false);
    }, FOOD_BOARD_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gateway, storeId]);

  // タスク7.6: resyncSignal（KitchenBoardScreenがuseRealtimeFeedのonSyncで
  // 発火させる単調増加カウンタ）の変化を検知し、背景での再取得
  // （load(false)と全く同じ意味論）を行う。上のマウント時フェッチ+
  // ポーリングeffectとは意図的に完全に独立させている（ファイル冒頭コメント
  // 「タスク7.6での更新」参照。resyncSignalをそちらの依存配列へ加えると
  // effect全体が再実行されload(true)が呼ばれ直す退行になるため）。
  const lastResyncSignalRef = useRef(resyncSignal);
  useEffect(() => {
    if (
      resyncSignal === undefined ||
      resyncSignal === lastResyncSignalRef.current
    ) {
      return;
    }
    lastResyncSignalRef.current = resyncSignal;

    let cancelled = false;

    async function resync() {
      // タスク7.6レビューで追加: 上のload()と同じ理由（ファイル内
      // mutationSeqRef宣言コメント参照）。resyncSignalは店舗全体の
      // order_items変更（他卓・他端末の変更を含む）のたびに発火しうるため、
      // このガードが無いとadvance()クリック直後にほぼ確実に競合しうる
      // （load()のポーリングより遥かに高頻度で発火するため）。
      const fetchSeq = mutationSeqRef.current;
      try {
        const result = await gateway.listKitchenFeed({ storeId });
        if (cancelled || !result.ok) {
          // result.ok === falseはload(true)と同じく実際には到達しない
          // 防御的分岐だが、万一到達してもload(false)と同じく何もしない
          // （既に表示中のカードを維持する。要件C: 背景フェッチは
          // 決してエラー画面へ巻き戻さない）。
          return;
        }
        if (mutationSeqRef.current !== fetchSeq) {
          // load()と同じ理由でこのフェッチの結果は破棄する。
          return;
        }
        const foodItems = result.value.filter((item) =>
          FOOD_BOARD_GENRES.has(item.genre),
        );
        setState({ status: "ready", items: foodItems });
      } catch {
        // load(false)と同じ方針: 背景フェッチの失敗は画面を壊さないよう
        // 握りつぶす（既に表示中のカードはそのまま維持される）。
      }
    }

    void resync();
    return () => {
      cancelled = true;
    };
  }, [resyncSignal, gateway, storeId]);

  if (state.status === "loading") {
    return (
      <p className="p-4 text-sm text-neutral-500" data-testid="food-board-loading">
        読み込み中...
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <p role="alert" className="p-4 text-sm text-red-600">
        {state.message}
      </p>
    );
  }

  const grouped = groupByStatus(state.items);

  return (
    <div className="flex flex-col gap-2 p-2">
      {actionError ? (
        <p
          role="alert"
          data-testid="food-board-action-error"
          className="text-xs text-red-600"
        >
          {actionError}
        </p>
      ) : null}
      <div data-testid="food-board" className="grid grid-cols-5 gap-2">
        {COLUMNS.map((column) => {
          const columnItems = grouped[column.key];
          return (
            <div
              key={column.key}
              className={column.wide ? "col-span-2" : "col-span-1"}
            >
              <div
                className={`rounded px-2 py-1 text-center text-xs font-bold ${column.headClassName}`}
              >
                {column.title}（{columnItems.length}）
              </div>
              <div
                data-testid={`food-board-column-${column.key}`}
                className={
                  column.wide
                    ? "mt-2 grid grid-cols-2 gap-2"
                    : "mt-2 flex flex-col gap-2"
                }
              >
                {columnItems.length === 0 ? (
                  <p className="py-3 text-center text-xs text-neutral-400">
                    なし
                  </p>
                ) : (
                  columnItems.map((item) => (
                    <div
                      key={item.id}
                      data-testid="food-board-card"
                      className="flex flex-col gap-1 rounded-lg border border-neutral-200 bg-white p-2 text-xs shadow-sm"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-bold text-neutral-900">
                          {item.tableLabel}
                          {item.genre === "ippin" ? (
                            <span className="ml-1 rounded bg-blue-100 px-1 py-0.5 text-[10px] font-semibold text-blue-700">
                              一品
                            </span>
                          ) : null}
                        </span>
                        <span
                          data-testid="food-board-card-time"
                          className="shrink-0 font-mono text-[10px] tabular-nums text-neutral-400"
                        >
                          {formatClock(item.statusUpdatedAt)}
                        </span>
                      </div>
                      <div className="leading-relaxed text-neutral-600">
                        {item.name}
                        {item.optionsSummary
                          ? `（${item.optionsSummary}）`
                          : ""}{" "}
                        ×{item.quantity}
                      </div>
                      <OrderItemStatusActions
                        item={item}
                        pending={pendingItemId === item.id}
                        onAdvance={(target, nextStatus) =>
                          void advance(target, nextStatus)
                        }
                      />
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
