"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  createStaffOperationsGateway,
  type MenuItemGenre,
} from "@/lib/gateways/staffOperationsGateway";
import type { OrderItemStatus } from "@/lib/gateways/customerOrderingGateway";
import type { KitchenFeedItem } from "./FoodBoard";
import { useAdvanceOrderItemStatus } from "./useAdvanceOrderItemStatus";
import OrderItemStatusActions from "./OrderItemStatusActions";

/**
 * ドリンクボード（design.md「KitchenBoard」のドリンクボードタブ実体）。
 * KitchenBoardScreen（7.1、7.2でFoodBoardを配線済み）が"drink"タブ選択中に
 * マウントする。
 *
 * Requirements: 6.4, 6.8
 * Design: .kiro/specs/table-order-kitchen/design.md「KitchenBoard」、
 *   StaffOperationsGateway.listKitchenFeed のService Interface、
 *   `updateOrderItemStatus`のジャンル別遷移ルール（「ドリンクジャンルは
 *   received → doneのみを許可する」要件6.3, 6.4, 5.7）。
 * Mock: mock-preview.html の`kanbanHtml('drink')`（`kanban-2`クラス、
 *   `DRINK_STATES`定数が定義する「未対応／対応済み」の2列、いずれも幅は
 *   均等）を参照する。フードボードの`kanban-5`（2/2/1の幅指定）とは異なり、
 *   ドリンクボードは2列とも同じ幅で構成する。
 *
 * ## 対象ジャンルについて（drink board = drink genre のみ）
 * FoodBoard.tsx（7.2）冒頭コメントの通り、フード/一品は3状態カンバンを
 * 共有する単一の「フードボード」であり、ドリンクはそれとは別の
 * 「ドリンクボード」を構成する。本コンポーネントは`genre === "drink"`の
 * 品目のみを対象とし、`genre === "food" | "ippin"`は除外する
 * （フードボードは7.2が別途実装済み）。
 *
 * ## 列構成について（in_progressが「常に空」ではなく構造上存在しない理由）
 * design.md「`update_order_item_status`はドリンクジャンルで
 * `received → in_progress`への遷移を`INVALID_TRANSITION`として拒否する
 * （6.4）」の通り、ドリンク品目のstatusは`received`と`done`の2値しか
 * 実際には取り得ない（`order_items.status`列自体はフード/一品と共有する
 * 3値のCHECK制約だが、design.md「ドリンクジャンルでは`in_progress`を
 * 単に使用しない運用とする」の通り、ドリンク品目に対して`in_progress`が
 * 書き込まれることはRPCのレベルで構造的に起こり得ない）。そのため
 * 本コンポーネントは`in_progress`列を「空の列として描画してから0件と表示する」
 * のではなく、そもそも`COLUMNS`定数に含めず、DOM上に一切出現させない
 * （観測可能な完了条件「ドリンク品目のステータス更新操作に調理中の
 * 選択肢が表示されない」を、列構造そのものによって満たす。ステータス
 * 更新操作のクリックハンドラ自体は7.5のスコープ）。
 *
 * ## 列ラベルについて（doneの表示が「対応済み」であり「調理完了」ではない）
 * requirements.md 要件6.4「Where 品目のジャンルがドリンクである、
 * 厨房KDSサービスは当該品目のステータスを『未対応』『対応済み』の
 * いずれかで管理する」、およびmock-preview.htmlの`DRINK_STATES`定数
 * （`{ key:'done', title:'対応済み' }`）の通り、ドリンクのdone状態の
 * 表示ラベルは「対応済み」である。フードボード（`FOOD_BOARD`の
 * `{ key:'done', title:'調理完了' }`）の「調理完了」とは意図的に異なる
 * 文言であり、統一しない（フードは調理という工程を経るがドリンクは
 * 提供するだけであるという業務上の違いを反映した、既存の承認済み設計）。
 *
 * ## 優先表示ルールの不在について（一品のような並び替えは行わない）
 * design.mdの未対応列優先表示ルール（要件6.7「一品ジャンルの品目を
 * 受注時刻に関わらず未対応の一覧の上部に表示する」）はフード/一品専用の
 * ルールであり、ドリンクには対応する優先表示ルールが存在しない。そのため
 * 本コンポーネントはFoodBoard.tsxのようなジャンル別ソートを一切行わず、
 * `listKitchenFeed`が返す配列順をそのまま各列へ振り分けるのみとする
 * （下記`groupByStatus`参照。0004設計判断22/tasks.md Implementation Notes
 * の「RPCが単一のORDER BYで既に正しい順序を確定させている」という前提は
 * ドリンクにもそのまま当てはまる）。
 *
 * ## 認証済みクライアントの取得方法・更新方式について
 * FoodBoard.tsx（7.2）冒頭コメントの「認証済みクライアントの取得方法」
 * 「更新方式についての設計判断（マウント時フェッチ + 簡易ポーリング）」を
 * そのまま踏襲する（同一の設計判断であり、ここでの再説明は省略する）。
 * `useRealtimeFeed`の配線・接続断表示はタスク7.6のスコープのまま。
 *
 * ## タスク7.5での更新: ステータス更新操作と即時反映
 * FoodBoard.tsx冒頭コメント「タスク7.5での更新」と同じ設計判断・同じ共有
 * フック（`useAdvanceOrderItemStatus`）・同じ描画コンポーネント
 * （`OrderItemStatusActions`）を利用する。ドリンクジャンルではreceived→done
 * の1操作のみで、一品のような直接完了ショートカットは存在しない
 * （OrderItemStatusActions.tsxの`resolveActions`がジャンルごとに分岐する）。
 */
export const DRINK_BOARD_POLL_INTERVAL_MS = 5000;

type DrinkBoardProps = {
  storeId: string;
};

type BoardState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: ReadonlyArray<KitchenFeedItem> };

const GENERIC_ERROR_MESSAGE =
  "厨房データの取得に失敗しました。ネットワーク接続をご確認のうえ、画面を再読み込みしてください。";

// design.mdの「ドリンクジャンルはreceived → doneの2状態カンバンを持つ」
// という定義そのもの（ファイル冒頭コメント参照）。フード/一品
// （FoodBoard.tsxが対象）はここに含めない。
const DRINK_BOARD_GENRES: ReadonlySet<MenuItemGenre> = new Set<MenuItemGenre>([
  "drink",
]);

// ドリンクボードのカンバン列。`in_progress`は意図的に含めない
// （ファイル冒頭コメント「列構成について」参照）。
const COLUMNS: ReadonlyArray<{
  key: Extract<OrderItemStatus, "received" | "done">;
  title: string;
  headClassName: string;
}> = [
  {
    key: "received",
    title: "未対応",
    headClassName: "bg-amber-50 text-amber-700",
  },
  {
    key: "done",
    title: "対応済み",
    headClassName: "bg-emerald-50 text-emerald-700",
  },
];

/**
 * `statusUpdatedAt`をHH:MM形式へ整形する。FoodBoard.tsxの`formatClock`と
 * 同一のロジック・同一の既知の乖離（mock-previewの`order.createdAt`表示との
 * 差異、design.md「既知の制約（要件6.8、タスク7.2で判明）」参照）である。
 */
function formatClock(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * `listKitchenFeed`が返す配列を`status`で2分割する。FoodBoard.tsxの
 * `groupByStatus`と同じ方針で、RPCが確定させた順序を信頼し、配列を1回
 * 走査してstatusごとのバケツへ振り分けるだけに留める（独自の`sort`は
 * 一切行わない）。
 */
function groupByStatus(
  items: ReadonlyArray<KitchenFeedItem>,
): Record<"received" | "done", KitchenFeedItem[]> {
  const groups: Record<"received" | "done", KitchenFeedItem[]> = {
    received: [],
    done: [],
  };
  for (const item of items) {
    if (item.status === "received" || item.status === "done") {
      groups[item.status].push(item);
    }
    // status === "in_progress"のドリンク品目は構造上存在し得ない
    // （ファイル冒頭コメント「列構成について」参照）ため、防御的に無視する。
  }
  return groups;
}

export default function DrinkBoard({ storeId }: DrinkBoardProps) {
  const gateway = useMemo(
    () => createStaffOperationsGateway(createBrowserClient()),
    [],
  );
  const [state, setState] = useState<BoardState>({ status: "loading" });

  // タスク7.5: ステータス更新後の即時反映用。FoodBoard.tsxの`updateItems`と
  // 同じ方針（"ready"の場合のみマージする）。
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

  useEffect(() => {
    let cancelled = false;

    // tasks.md Implementation Notes: listKitchenFeedはResult<T, never>
    // ——ドキュメント化されたエラーコード以外は常に例外としてthrowされる
    // ため、必ずtry/catchで捕捉する（FoodBoard.tsxと同じ規約）。
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
        const drinkItems = result.value.filter((item) =>
          DRINK_BOARD_GENRES.has(item.genre),
        );
        setState({ status: "ready", items: drinkItems });
      } catch {
        // 初回読み込みの失敗のみ明示的なエラー表示にする。バックグラウンド
        // ポーリングの失敗は画面を壊さないよう握りつぶす（FoodBoard.tsxと
        // 同じ方針）。
        if (!cancelled && isInitialLoad) {
          setState({ status: "error", message: GENERIC_ERROR_MESSAGE });
        }
      }
    }

    void load(true);

    const interval = setInterval(() => {
      void load(false);
    }, DRINK_BOARD_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gateway, storeId]);

  if (state.status === "loading") {
    return (
      <p
        className="p-4 text-sm text-neutral-500"
        data-testid="drink-board-loading"
      >
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
          data-testid="drink-board-action-error"
          className="text-xs text-red-600"
        >
          {actionError}
        </p>
      ) : null}
      <div data-testid="drink-board" className="grid grid-cols-2 gap-2">
        {COLUMNS.map((column) => {
          const columnItems = grouped[column.key];
          return (
            <div key={column.key}>
              <div
                className={`rounded px-2 py-1 text-center text-xs font-bold ${column.headClassName}`}
              >
                {column.title}（{columnItems.length}）
              </div>
              <div
                data-testid={`drink-board-column-${column.key}`}
                className="mt-2 flex flex-col gap-2"
              >
                {columnItems.length === 0 ? (
                  <p className="py-3 text-center text-xs text-neutral-400">
                    なし
                  </p>
                ) : (
                  columnItems.map((item) => (
                    <div
                      key={item.id}
                      data-testid="drink-board-card"
                      className="flex flex-col gap-1 rounded-lg border border-neutral-200 bg-white p-2 text-xs shadow-sm"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-bold text-neutral-900">
                          {item.tableLabel}
                        </span>
                        <span
                          data-testid="drink-board-card-time"
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
