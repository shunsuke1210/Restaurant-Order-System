"use client";

import { useEffect, useMemo, useState } from "react";
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
 */
export const FOOD_BOARD_POLL_INTERVAL_MS = 5000;

type FoodBoardProps = {
  storeId: string;
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

export default function FoodBoard({ storeId }: FoodBoardProps) {
  const gateway = useMemo(
    () => createStaffOperationsGateway(createBrowserClient()),
    [],
  );
  const [state, setState] = useState<BoardState>({ status: "loading" });

  // タスク7.5: ステータス更新後の即時反映用。`state`が"ready"の場合のみ
  // 該当品目をマージする（読み込み中/エラー中はupdateItems自体を
  // useAdvanceOrderItemStatusから呼び出す機会が無いため、事実上到達しない）。
  function updateItems(
    updater: (
      prev: ReadonlyArray<KitchenFeedItem>,
    ) => ReadonlyArray<KitchenFeedItem>,
  ) {
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
