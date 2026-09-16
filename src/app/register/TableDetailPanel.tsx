"use client";

import { useState } from "react";
import type { TableBillingSummary } from "@/lib/gateways/staffOperationsGateway";
import { elapsedMinutes, formatYen } from "./FloorMap";

/**
 * 卓詳細パネル（design.md「RegisterConsole」の卓詳細パネル部分、タスク8.2）。
 * FloorMap.tsx（タスク8.1）がタイル選択中（`selectedTableId`が非null）に
 * 表示するオーバーレイモーダル。
 *
 * Requirements: 3.1, 3.2, 3.4, 5.1, 5.2, 5.3
 * Design: .kiro/specs/table-order-kitchen/design.md「RegisterConsole」
 *   （「タイルを選択すると卓の詳細...を操作するパネルを開く。入店操作は
 *   人数の入力を伴い（要件3.1, 3.4）」）。
 * Mock: mock-preview.html の`tableDetailHtml`（空席時の「空席です。」＋
 *   「入店」ボタン→人数ステッパー（デフォルト2）＋「キャンセル」/
 *   「入店する」、来店中の人数・経過時間・session-id行、注文明細一覧、
 *   合計行）を参照する。ただし本タスクのスコープは「入店」部分と、
 *   占有中ビューの読み取り専用表示のみ（品目追加・削除・ステータス変更は
 *   8.3/8.4、会計は8.5、呼び出し対応ボタンは8.6のスコープ、下記コメント
 *   「本タスクのスコープ境界」参照）。
 *
 * ## 本コンポーネントの位置づけ（純粋なプレゼンテーション、状態を持たない主要部分）
 * `table`（選択中卓の最新`TableBillingSummary`）はFloorMap.tsxが
 * `state.tables`から都度算出して渡す（FloorMap.tsx冒頭コメント
 * 「design decision D」参照）。本コンポーネント自身は`table`のコピーを
 * 保持せず、再レンダリングのたびに渡された最新値をそのまま表示する
 * ——FloorMap.tsxの5秒背景ポーリングが新しい注文・合計を取得するたびに、
 * 本コンポーネントを再マウントすることなく表示が追随する（要件5.3）。
 * 入店操作（`startSession`呼び出しとその成功時のローカル状態への
 * マージ）自体はFloorMap.tsx側（`useCheckIn`フック、design decision A/B
 * 参照）が担い、本コンポーネントは`onCheckIn`コールバック・`submitting`
 * フラグ・`checkInErrorMessage`のみを受け取る（KitchenBoardの
 * `OrderItemStatusActions.tsx`と同型の「呼び出しロジックは親のフックへ、
 * 本体は見た目のみ」という役割分担）。
 *
 * 唯一のローカル状態は、人数入力ステッパーを表示するかどうかという
 * 「エフェメラルなUI表示状態」（`startingSession`）と、その下書きの人数
 * （`partySizeDraft`）のみであり、いずれもサーバーの実際の状態とは
 * 無関係（キャンセルすれば破棄される、確定するまでFloorMap側には一切
 * 伝わらない）。
 *
 * ## 本タスクのスコープ境界
 * - 占有中ビューは読み取り専用（品目の追加・削除ボタン、ステータス
 *   変更ボタン、会計ボタンはいずれも表示しない。8.3/8.4/8.5のスコープ）。
 * - `hasOpenCallRequest`が真の場合、案内バナーのみ表示する。「対応済みに
 *   する」ボタンは呼び出し対応（8.6）のスコープのため一切表示しない
 *   （タスク文書の指示: 「wiring the actual resolve action is out of
 *   scope」）。
 * - 入店操作自体（人数ステッパー＋「入店する」）には確認モーダルを
 *   挟まない（要件3.1に3.3/3.5/5.5-5.7のような「実行前に確認を求め」の
 *   言及が無いため。useCheckIn.ts冒頭コメント参照）。
 *
 * ## 注文明細に品目オプション概要・ステータスを表示しない理由（mock-preview.htmlとの既知の乖離）
 * mock-preview.htmlの`tableDetailHtml`は各明細行にオプション概要
 * （`it.optionsSummary`）とステータスラベル（`statusLabel(genre,
 * it.status)`）を表示するが、実際の`StaffOperationsGateway.
 * listRegisterFeed`（0004_rpc_staff_gateway.sqlの`list_register_feed`、
 * 設計判断21以降）が返す`TableBillingSummary.items`は
 * `{menuItemId, name, quantity, unitPrice}`の4フィールドのみであり、
 * オプション概要・品目ID・ステータスのいずれも持たない
 * （`register`向け一覧はレジの合計金額確認用に必要最小限の集計のみを
 * 返す設計であり、`listKitchenFeed`が返す`OrderItemSummary`とは別の
 * 形状）。本タスクのGit hygiene制約によりゲートウェイ・マイグレーションの
 * 変更は対象外のため、本コンポーネントは実際に取得可能なフィールド
 * （品目名・数量・単価×数量）のみを表示し、オプション概要・ステータス
 * ラベルは表示しない（存在しないデータを表示しようがないため）。
 * この乖離はタスク完了報告のOPEN_QUESTIONSに記録する。
 */

type TableDetailPanelProps = {
  table: TableBillingSummary;
  onClose: () => void;
  onCheckIn: (partySize: number) => void;
  submitting: boolean;
  checkInErrorMessage: string | null;
};

// 要件3.1「人数の入力を求め」に対応する下書きの初期値・下限。上限は要件が
// 定めないため設けない（判断はタスク文書「design decisions E」に委ねられて
// いる。mock-preview.htmlの`ru.partySizeDraft`初期値2にそのまま合わせる）。
const DEFAULT_PARTY_SIZE = 2;
const MIN_PARTY_SIZE = 1;

export default function TableDetailPanel({
  table,
  onClose,
  onCheckIn,
  submitting,
  checkInErrorMessage,
}: TableDetailPanelProps) {
  const [startingSession, setStartingSession] = useState(false);
  const [partySizeDraft, setPartySizeDraft] = useState(DEFAULT_PARTY_SIZE);

  function beginStartSession() {
    setPartySizeDraft(DEFAULT_PARTY_SIZE);
    setStartingSession(true);
  }

  function cancelStartSession() {
    // 要件3.1・本タスクの観測可能な完了条件に関わる仕様: 「キャンセル」は
    // ここでローカルのステッパー表示を破棄するのみであり、startSession
    // （onCheckIn）は一切呼び出さない（SoldOutBoard.tsxの
    // `cancelPendingToggle`と同型の方針）。
    setStartingSession(false);
  }

  function confirmStartSession() {
    onCheckIn(partySizeDraft);
  }

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        data-testid="register-table-detail-panel"
        className="flex max-h-full w-full max-w-sm flex-col gap-3 overflow-y-auto rounded-xl bg-white p-4 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <span className="text-base font-semibold text-neutral-900">
            {table.tableLabel}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs font-semibold text-neutral-500"
          >
            閉じる
          </button>
        </div>

        {table.activeSession === null ? (
          <VacantView
            startingSession={startingSession}
            partySizeDraft={partySizeDraft}
            setPartySizeDraft={setPartySizeDraft}
            submitting={submitting}
            checkInErrorMessage={checkInErrorMessage}
            onBeginStartSession={beginStartSession}
            onCancelStartSession={cancelStartSession}
            onConfirmStartSession={confirmStartSession}
          />
        ) : (
          <OccupiedView table={table} activeSession={table.activeSession} />
        )}
      </div>
    </div>
  );
}

type VacantViewProps = {
  startingSession: boolean;
  partySizeDraft: number;
  setPartySizeDraft: (updater: (current: number) => number) => void;
  submitting: boolean;
  checkInErrorMessage: string | null;
  onBeginStartSession: () => void;
  onCancelStartSession: () => void;
  onConfirmStartSession: () => void;
};

/** 空席時のビュー（要件3.1, 5.2）。 */
function VacantView({
  startingSession,
  partySizeDraft,
  setPartySizeDraft,
  submitting,
  checkInErrorMessage,
  onBeginStartSession,
  onCancelStartSession,
  onConfirmStartSession,
}: VacantViewProps) {
  return (
    <div className="flex flex-col gap-3">
      {checkInErrorMessage ? (
        <p role="alert" className="text-sm font-semibold text-red-600">
          {checkInErrorMessage}
        </p>
      ) : null}

      {startingSession ? (
        <div data-testid="register-check-in-form" className="flex flex-col gap-3">
          <div>
            <div className="mb-1 text-xs font-semibold text-neutral-500">
              人数
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="人数を減らす"
                onClick={() =>
                  setPartySizeDraft((current) =>
                    Math.max(MIN_PARTY_SIZE, current - 1),
                  )
                }
                className="h-8 w-8 rounded-full border border-neutral-300 text-sm font-bold text-neutral-700"
              >
                −
              </button>
              <span
                data-testid="register-check-in-party-size"
                className="min-w-[2ch] text-center text-base font-semibold tabular-nums"
              >
                {partySizeDraft}
              </span>
              <button
                type="button"
                aria-label="人数を増やす"
                onClick={() => setPartySizeDraft((current) => current + 1)}
                className="h-8 w-8 rounded-full border border-neutral-300 text-sm font-bold text-neutral-700"
              >
                ＋
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancelStartSession}
              disabled={submitting}
              className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm font-semibold text-neutral-700 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={onConfirmStartSession}
              disabled={submitting}
              className="flex-1 rounded-lg bg-neutral-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {submitting ? "処理中..." : "入店する"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-neutral-500">
            空席です。会計対象がありません。
          </p>
          <button
            type="button"
            onClick={onBeginStartSession}
            className="rounded-lg bg-neutral-900 px-3 py-2 text-sm font-semibold text-white"
          >
            入店
          </button>
        </>
      )}
    </div>
  );
}

type OccupiedViewProps = {
  table: TableBillingSummary;
  activeSession: NonNullable<TableBillingSummary["activeSession"]>;
};

/** 来店中のビュー（要件5.1、読み取り専用。8.3/8.4/8.5/8.6は対象外）。 */
function OccupiedView({ table, activeSession }: OccupiedViewProps) {
  return (
    <div className="flex flex-col gap-3">
      {table.hasOpenCallRequest ? (
        <div
          data-testid="register-table-detail-call-banner"
          role="status"
          className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700"
        >
          呼び出し中
        </div>
      ) : null}

      <div
        data-testid="register-table-detail-occupancy"
        className="text-xs text-neutral-500"
      >
        {activeSession.partySize}名　・　ご来店{" "}
        {elapsedMinutes(activeSession.startedAt)}分経過
        <span className="font-mono">session #{activeSession.id}</span>
      </div>

      <div
        data-testid="register-table-detail-items"
        className="max-h-44 overflow-y-auto rounded-lg border border-neutral-200"
      >
        {table.items.length === 0 ? (
          <p className="px-3 py-3 text-xs text-neutral-400">
            まだ注文はありません
          </p>
        ) : (
          table.items.map((item, index) => (
            <div
              key={`${item.menuItemId}-${index}`}
              data-testid="register-table-detail-item"
              className="flex items-center justify-between gap-2 border-b border-neutral-100 px-3 py-2 text-sm last:border-b-0"
            >
              <span className="text-neutral-800">
                {item.name} ×{item.quantity}
              </span>
              <span className="font-mono font-semibold text-neutral-900">
                {formatYen(item.unitPrice * item.quantity)}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="flex items-baseline justify-between">
        <span className="text-xs text-neutral-500">合計</span>
        <span
          data-testid="register-table-detail-total"
          className="font-mono text-base font-bold text-neutral-900"
        >
          {formatYen(table.total)}
        </span>
      </div>
    </div>
  );
}
