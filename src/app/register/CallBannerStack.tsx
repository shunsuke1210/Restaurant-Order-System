"use client";

import { elapsedMinutes } from "./FloorMap";

export type OpenCallBannerItem = {
  tableId: string;
  tableLabel: string;
  callRequestId: string;
  createdAt: string;
};

type CallBannerStackProps = {
  calls: ReadonlyArray<OpenCallBannerItem>;
  onDismiss: (tableId: string, callRequestId: string) => void;
  dismissingTableId: string | null;
};

/**
 * スタッフ呼出しを「スマホの通知」のように目立つバナーとして画面上部に
 * 表示する（spec完了後のユーザー確認で追加。要件2.2「呼び出し中の卓を
 * 認識する」・2.4「呼び出しに対応済みとして操作する」を、8.1のタイル
 * バッジ（`register-floor-tile-call-badge`）・8.2のパネル内バナー
 * （`register-table-detail-call-banner`）より気づきやすい形で満たす。
 * 既存の2つの表示は変更・削除しない——タイルバッジは卓マップを一目で
 * 見渡す用途、パネル内バナーは選択中の卓の詳細確認用途として引き続き
 * 機能する）。
 *
 * ## 表示位置（`TableDetailPanel`のモーダルより前面）
 * `TableDetailPanel.tsx`は`fixed inset-0 z-20`の全画面モーダルとして
 * 卓詳細を覆う。呼び出しは「今どの卓の対応をしていても気づける」ことに
 * 意味があるため、本コンポーネントはそれより高い`z-40`の`fixed`
 * オーバーレイとして画面上部に配置し、パネルが開いていても隠れない。
 *
 * ## 複数呼び出しの積み重ね順（古いものを上に）
 * `calls`は呼び出し元（`FloorMap.tsx`）が`openCallRequestCreatedAt`
 * 昇順（古い順）でソート済みの配列を渡す前提とし、本コンポーネント自身は
 * ソートしない（表示専用コンポーネントとして状態・順序判断を持たない、
 * `SubTabs.tsx`が並び順をpropsの配列順にそのまま従う既存方針と同型）。
 * 配列の先頭から上から下へ描画するだけで「古い呼び出しが上に来る」という
 * 要求を満たす。
 *
 * ## 解除ボタンについて（新しい確認モーダルを作らない）
 * `onDismiss`は`FloorMap.tsx`が既に持つ`resolveCall`（`useResolveCallRequest`、
 * タスク8.6）をそのまま呼び出す想定。8.6の`useResolveCallRequest.ts`冒頭
 * コメント「確認モーダルを設けない理由」が要件2.4の文言に基づき確認モーダル
 * 無しと判断済みであり、本コンポーネントも同じ判断を継承する（新しい確認
 * モーダルは追加しない）。
 */
export default function CallBannerStack({
  calls,
  onDismiss,
  dismissingTableId,
}: CallBannerStackProps) {
  if (calls.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="register-call-banner-stack"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-40 flex flex-col gap-2 p-3"
    >
      {calls.map((call) => (
        <div
          key={call.tableId}
          data-testid={`register-call-banner-${call.tableLabel}`}
          role="alert"
          className="flex items-center justify-between gap-3 rounded-xl border-l-4 border-red-600 bg-white p-3 shadow-lg ring-1 ring-black/5"
        >
          <div>
            <div className="text-sm font-bold text-red-600">
              呼び出し：{call.tableLabel}
            </div>
            <div className="text-xs text-neutral-500">
              {elapsedMinutes(call.createdAt)}分前
            </div>
          </div>
          <button
            type="button"
            data-testid={`register-call-banner-dismiss-${call.tableLabel}`}
            disabled={dismissingTableId === call.tableId}
            onClick={() => onDismiss(call.tableId, call.callRequestId)}
            className="shrink-0 rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
          >
            対応済みにする
          </button>
        </div>
      ))}
    </div>
  );
}
