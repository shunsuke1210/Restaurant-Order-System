"use client";

/**
 * ConfirmDialog — 「実行前に確認を求める」操作の汎用確認モーダル
 * （タスク8.3で新規追加、RegisterConsole境界ローカル）。
 *
 * `SoldOutBoard.tsx`（タスク7.4、KitchenBoard境界）が確立した確認モーダルの
 * 見た目・構造（`role="alertdialog"`、「いいえ」/確認ラベルの2ボタン、
 * 送信中は両ボタンを無効化）と同型だが、KitchenBoard境界からRegisterConsole
 * 境界へ直接importするのではなく、本ファイルとして複製する
 * （`formatYen`のRegisterConsole/KitchenBoard間の複製の前例と同じ理由:
 * design.mdのBoundary Contextを跨ぐ物理的なimportを避ける。7.6/8.1の
 * Implementation Notesが記録した方針を踏襲）。
 *
 * RegisterConsole境界の内部では、タスク8.3が同一形状の確認モーダルを
 * 2箇所（品目追加の簡易確認・注文明細の削除確認）で必要とするため、
 * SoldOutBoard.tsxのように都度インラインで書くのではなく、本コンポーネント
 * へ1箇所に集約する（3箇所目の重複が発生した場合に共通化を検討する、という
 * 7.6 Implementation Notesの方針に基づき、本タスクで2箇所目が生まれた
 * 時点で集約した）。
 */
export type ConfirmDialogProps = {
  testId: string;
  ariaLabel: string;
  message: string;
  confirmLabel: string;
  submittingLabel?: string;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export default function ConfirmDialog({
  testId,
  ariaLabel,
  message,
  confirmLabel,
  submittingLabel = "処理中...",
  submitting,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <div
      data-testid={testId}
      role="alertdialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-xs rounded-xl bg-white p-4 shadow-lg">
        <p className="mb-4 whitespace-pre-line text-sm font-semibold text-neutral-900">
          {message}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid={`${testId}-cancel`}
            onClick={onCancel}
            disabled={submitting}
            className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm font-semibold text-neutral-700 disabled:opacity-50"
          >
            いいえ
          </button>
          <button
            type="button"
            data-testid={`${testId}-confirm`}
            onClick={onConfirm}
            disabled={submitting}
            className="flex-1 rounded-lg bg-neutral-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {submitting ? submittingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
