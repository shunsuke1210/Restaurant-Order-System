"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  createStaffOperationsGateway,
  type TableBillingSummary,
} from "@/lib/gateways/staffOperationsGateway";

/**
 * 卓マップ（design.md「RegisterConsole」の卓マップ表示部分）。
 * RegisterConsoleScreen（タスク8.1）が"ready"状態でマウントする。
 *
 * Requirements: 2.2, 5.4
 * Design: .kiro/specs/table-order-kitchen/design.md「RegisterConsole」
 *   （「全卓を「テーブル」「カウンター」のエリアに分けたマップ表示とし、
 *   各卓のタイルに人数・経過時間・合計金額・呼び出し中バッジを表示する」）、
 *   StaffOperationsGateway.listRegisterFeed のService Interface
 *   （`TableBillingSummary`: tableId/tableLabel/activeSession/items/total/
 *   hasOpenCallRequest）。
 * Mock: mock-preview.html の`floorSectionHtml`/`renderRegister`
 *   （`/^T/`→テーブル区分・`/^C/`→カウンター区分、`elapsedMin(ts) =
 *   Math.max(0, Math.floor((Date.now() - ts) / 60000))`という経過分数の
 *   算出式、呼出バッジ・空席/来店中タイルのレイアウト）を参照する。
 *
 * ## 本タスク（8.1）のスコープ（display-onlyの境界）
 * 8.1は「卓マップ表示」のみを担う（タイルは情報表示専用で、クリック
 * ハンドラ・詳細パネル・入店/会計/呼び出し対応等のいずれの書き込み操作も
 * 実装しない）。タイル選択で開く卓詳細パネルと入店操作（人数入力）は8.2の
 * スコープであり、8.2が本コンポーネントへクリックハンドラを追加する際に
 * 迷わず拡張できるよう、タイルは意図的に`<button>`ではなく非対話的な
 * `<div>`として実装する（KitchenBoardのFoodBoard.tsx、7.2時点でステータス
 * 更新ボタンを一切持たなかったのと同じ「段階的な充実」パターン）。
 *
 * ## エリア分けについて（design decision A）
 * `tables`テーブルには専用のエリア/ゾーン列が存在しない
 * （`0001_schema.sql`の`create table tables`は`id`/`store_id`/`label`の
 * みを持つ）。テーブル/カウンターの区分はスキーマで保証されたものではなく、
 * `tableLabel`の接頭辞（`/^T/`→テーブル、`/^C/`→カウンター）から導出する
 * 純粋なクライアント側の慣習であり、mock-preview.htmlの`renderRegister`と
 * `supabase/seed.sql`の実際の開発用ラベル（T1/T2/C1/C2）に一致させる。
 * どちらの接頭辞にも一致しないラベル（スキーマ上は許容されうる）が来ても
 * クラッシュしないよう、本コンポーネントは3つ目の「その他」区分を設け、
 * 該当する卓が1件も無い場合はその区分自体を描画しない（実際の開発データが
 * T/C以外のラベルを持たない前提のもとで、通常運用時に空の区分が常に
 * 表示され続ける違和感を避けるため）。
 *
 * ## 合計金額について（design decision B、confirmedTotalとの関係）
 * `TableBillingSummary.total`はサーバー側（`list_register_feed`）が
 * 確定させた合計であり、design.mdの通り`CustomerOrderingGateway.
 * getOrderingContext`が返す`confirmedTotal`と同一ロジックを共有する。
 * 本コンポーネントは`items`から金額を再計算せず、`total`をそのまま表示する
 * （クライアント側での再計算は、サーバー側ロジックとの将来的な乖離
 * リスクを生むため意図的に避ける）。
 *
 * ## 金額フォーマットについて
 * `src/app/order/[tableId]/formatYen.ts`は`CustomerOrderApp`境界の
 * ファイルであり、design.mdのBoundary Context上`RegisterConsole`は別の
 * 境界として扱われる。SoldOutBoard.tsx（KitchenBoard境界）が同じ理由で
 * `formatYen`を独自に複製した前例（`formatPrice`）を踏襲し、本ファイルも
 * 同じ表記（`'¥' + n.toLocaleString('ja-JP')`）をローカルに複製する
 * （境界をまたぐ物理的なimportを避ける）。
 *
 * ## 更新方式についての設計判断（マウント時フェッチ + 簡易ポーリング）
 * design.mdのRealtimeFeed（`useRealtimeFeed`、タスク5で実装済み）を
 * RegisterConsoleへ配線するのはタスク9.2の明示的なスコープ
 * （「3画面へのRealtimeFeed接続と再接続時再取得の統合確認」、8.1-8.7全体が
 * 完成した後の横断タスク）であり、本タスクの完了条件（エリア分け・
 * タイルの表示内容・呼び出しバッジの表示/消去）はいずれも「表示の正しさ」を
 * 要求するのみで、Realtimeによる即時反映自体は要求しない。
 *
 * 一方、レジ画面という製品の性質上、9.2が着手されるまでの間、一度きりの
 * 取得のみで新規注文・呼び出し・人数変更が一切反映されない画面のまま放置
 * するのは実運用上望ましくない中間状態である。そのため、FoodBoard.tsx
 * （タスク7.2）・DrinkBoard.tsx（7.3）が確立した「`useRealtimeFeed`の
 * 本格導入前は定期ポーリングで代替する」という前例をそのまま踏襲し、
 * `REGISTER_FLOOR_MAP_POLL_INTERVAL_MS`（5000ms、FOOD_BOARD_POLL_INTERVAL_MS
 * と同じ値）間隔の単純なポーリングを暫定的な更新手段として追加する
 * （新規のRealtime購読・新規の接続断UIは一切追加しない）。9.2が
 * `useRealtimeFeed`を配線した際は、このポーリングは（KitchenBoardの
 * 7.6が選んだ判断と同様に）置き換えではなく補完される想定
 * ——見落としに対する低コストな二重の安全網として残すか、9.2着手時に
 * 再検討する。
 *
 * ## mutationSeqRefを導入しない理由（7.6 Implementation Notes参照）
 * tasks.md Implementation Notes（7.6）は「背景フェッチが確定済みローカル
 * 状態全体を無条件で置き換えるパターン」と「ユーザー操作起点の即時ローカル
 * マージパターン」が同一コンポーネントに共存する場合の競合
 * （`mutationSeqRef`による対策）を記録しているが、本タスク（8.1）は
 * 表示専用でありローカルマージを行う書き込み操作を一切持たないため、
 * その競合は本コンポーネントには存在しない。8.2以降が本コンポーネント
 * （またはその後継）へローカル即時マージ（例: 人数変更後の即時反映）を
 * 追加する場合は、追加する時点でこの設計判断の再検討・`mutationSeqRef`
 * 相当のガード導入を行うこと（tasks.md 7.6 Implementation Notesの注意書き
 * 「事後発見ではなく設計時点で織り込む」に従う）。
 */
export const REGISTER_FLOOR_MAP_POLL_INTERVAL_MS = 5000;

type FloorMapProps = {
  storeId: string;
};

type BoardState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; tables: ReadonlyArray<TableBillingSummary> };

const GENERIC_ERROR_MESSAGE =
  "卓の情報の取得に失敗しました。ネットワーク接続をご確認のうえ、画面を再読み込みしてください。";

// design decision A（ファイル冒頭コメント参照）。mock-preview.htmlの
// renderRegister関数の`/^T/`・`/^C/`とそのまま一致させる。
const TABLE_AREA_LABEL_PATTERN = /^T/;
const COUNTER_AREA_LABEL_PATTERN = /^C/;

const AREA_SECTIONS: ReadonlyArray<{
  key: "table" | "counter" | "other";
  title: string;
}> = [
  { key: "table", title: "テーブル" },
  { key: "counter", title: "カウンター" },
  { key: "other", title: "その他" },
];

/** ファイル冒頭コメント「金額フォーマットについて」参照。 */
function formatYen(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}

/**
 * mock-preview.htmlの`elapsedMin(ts) = Math.max(0, Math.floor((Date.now() -
 * ts) / 60000))`と同じ算出式（`ts`はISO文字列のため`Date.parse`相当で
 * ミリ秒へ変換してから適用する）。
 */
function elapsedMinutes(startedAtIso: string): number {
  const startedAtMs = new Date(startedAtIso).getTime();
  return Math.max(0, Math.floor((Date.now() - startedAtMs) / 60000));
}

/** design decision A参照。ラベル接頭辞で3区分へ振り分ける。 */
function groupByArea(
  tables: ReadonlyArray<TableBillingSummary>,
): Record<"table" | "counter" | "other", TableBillingSummary[]> {
  const groups: Record<"table" | "counter" | "other", TableBillingSummary[]> =
    {
      table: [],
      counter: [],
      other: [],
    };
  for (const table of tables) {
    if (TABLE_AREA_LABEL_PATTERN.test(table.tableLabel)) {
      groups.table.push(table);
    } else if (COUNTER_AREA_LABEL_PATTERN.test(table.tableLabel)) {
      groups.counter.push(table);
    } else {
      groups.other.push(table);
    }
  }
  return groups;
}

export default function FloorMap({ storeId }: FloorMapProps) {
  const gateway = useMemo(
    () => createStaffOperationsGateway(createBrowserClient()),
    [],
  );
  const [state, setState] = useState<BoardState>({ status: "loading" });

  // FoodBoard.tsx（7.2）が確立した既存パターン——マウント時の初回取得と
  // 背景ポーリングを、1つのuseEffect内でローカルに定義した非同期関数として
  // まとめ、`cancelled`フラグでアンマウント後のsetStateを防ぐ——をそのまま
  // 踏襲する。
  useEffect(() => {
    let cancelled = false;

    // tasks.md Implementation Notes: listRegisterFeedはResult<T, never>
    // ——ドキュメント化されたエラーコード以外（FORBIDDENを含むあらゆる
    // エラー）は常に例外としてthrowされる（Resultのエラーメンバーには
    // 決して現れない）ため、必ずtry/catchで捕捉する。
    async function load(isInitialLoad: boolean) {
      try {
        const result = await gateway.listRegisterFeed({ storeId });
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          // design.mdの`never`エラー型によりここへは実際には到達しない
          // 防御的分岐。
          if (isInitialLoad) {
            setState({ status: "error", message: GENERIC_ERROR_MESSAGE });
          }
          return;
        }
        setState({ status: "ready", tables: result.value });
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
    }, REGISTER_FLOOR_MAP_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gateway, storeId]);

  if (state.status === "loading") {
    return (
      <p
        className="p-4 text-sm text-neutral-500"
        data-testid="register-floor-map-loading"
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

  const grouped = groupByArea(state.tables);

  return (
    <div data-testid="register-floor-map" className="flex flex-col gap-3 p-3">
      <div className="flex items-baseline justify-between">
        <h1 className="text-base font-semibold text-neutral-900">卓マップ</h1>
        <span
          data-testid="register-floor-map-count"
          className="text-xs text-neutral-500"
        >
          全{state.tables.length}卓
        </span>
      </div>

      {AREA_SECTIONS.map((section) => {
        const tables = grouped[section.key];
        if (section.key === "other" && tables.length === 0) {
          // design decision A参照: T/Cいずれにも一致する卓が無ければ
          // 「その他」区分自体を描画しない。
          return null;
        }
        return (
          <div key={section.key} data-testid={`register-floor-section-${section.key}`}>
            <div className="mb-1 text-xs font-bold text-neutral-500">
              {section.title}
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {tables.length === 0 ? (
                <p className="col-span-full py-2 text-xs text-neutral-400">
                  卓がありません
                </p>
              ) : (
                tables.map((table) => (
                  <div
                    key={table.tableId}
                    data-testid={`register-floor-tile-${table.tableLabel}`}
                    className={
                      "relative flex flex-col gap-1 rounded-lg border p-2 text-xs shadow-sm " +
                      (table.activeSession
                        ? "border-neutral-300 bg-white"
                        : "border-neutral-200 bg-neutral-50")
                    }
                  >
                    {table.hasOpenCallRequest ? (
                      <span
                        data-testid="register-floor-tile-call-badge"
                        className="absolute -top-2 -right-2 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white shadow"
                      >
                        呼出
                      </span>
                    ) : null}
                    <div className="font-bold text-neutral-900">
                      {table.tableLabel}
                    </div>
                    {table.activeSession === null ? (
                      <div
                        data-testid="register-floor-tile-vacant"
                        className="text-neutral-400"
                      >
                        空席
                      </div>
                    ) : (
                      <>
                        <div
                          data-testid="register-floor-tile-occupancy"
                          className="text-neutral-600"
                        >
                          {table.activeSession.partySize}名・
                          {elapsedMinutes(table.activeSession.startedAt)}分
                        </div>
                        <div
                          data-testid="register-floor-tile-total"
                          className="font-mono font-semibold text-neutral-900"
                        >
                          {formatYen(table.total)}
                        </div>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
