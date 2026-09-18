"use client";

import type { SubmitOrderError } from "@/lib/gateways/customerOrderingGateway";
import type { CartLine } from "./MenuScreen";
import { formatYen } from "./formatYen";

/**
 * 注文カートダイアログ（送信前レビュー〜送信〜結果表示）が取りうる状態。
 *
 * 設計判断（タスク6.2）: OptionSelectionPanel（6.1）が確定前レビュー用の
 * ダイアログを既に持つのと同じ考え方で、送信前レビュー・送信・結果表示を
 * 単一のダイアログ内で完結させる（mock-preview.htmlのconfirmModalHtml→
 * successModalHtmlの2段階モーダルを1つのダイアログの状態遷移として
 * 統合し、モーダルの開閉回数を減らすシンプル化）。
 *
 * - "idle": レビュー画面（カート内容・小計を表示し「注文する」を押せる）
 * - "submitting": 送信中（ボタン類を無効化）
 * - "success": 送信完了（要件1.7の観測可能な完了条件a）
 * - "business-error": submitOrderがResult.errで返した既知の業務エラー
 *   （SESSION_NOT_ACTIVE/ITEM_SOLD_OUT/EMPTY_ORDER/RATE_LIMITED）。
 *   コードごとに異なる文言を表示する（同一の汎用文言にしない）。
 * - "network-error": submitOrderが例外を投げた場合（tasks.md Implementation
 *   Notesの規約通り、ドキュメント化されていない失敗＝ネットワーク断等は
 *   例外として伝播する）。要件1.11「送信が完了していない旨の表示・再試行の
 *   案内」に対応する専用状態。
 */
export type CartSubmissionState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" }
  | {
      kind: "business-error";
      code: SubmitOrderError["code"];
      itemName?: string;
    }
  | { kind: "network-error" };

type CartPanelProps = {
  cart: ReadonlyArray<CartLine>;
  submission: CartSubmissionState;
  onClose: () => void;
  onSubmit: () => void;
};

/**
 * SubmitOrderErrorの各コードに対応する、コードごとに異なる案内文言。
 * 「一律の汎用エラー文言」にしないことが本タスクの明示的な要件
 * （tasks.md「各SubmitOrderErrorバリアントごとに専用のメッセージ」）。
 *
 * Requirements: 1.9（SESSION_NOT_ACTIVE時はスタッフを呼ぶよう促す）
 */
const BUSINESS_ERROR_MESSAGES: Record<
  SubmitOrderError["code"],
  (itemName?: string) => string
> = {
  SESSION_NOT_ACTIVE: () =>
    "このご来店セッションは既に終了しています。お手数ですが、スタッフをお呼びください。",
  ITEM_SOLD_OUT: (itemName) =>
    `${itemName ?? "選択した品目"}は売り切れになりました。内容を変更してもう一度お試しください。`,
  EMPTY_ORDER: () => "送信する品目がありません。品目を選択してください。",
  RATE_LIMITED: () =>
    "短時間に送信が集中したため、注文を受け付けできませんでした。少し時間をおいてからもう一度お試しください。",
};

const NETWORK_ERROR_MESSAGE =
  "ネットワーク接続の問題により、送信が完了していません。接続をご確認のうえ、再試行してください。";

function cartLineTotal(line: CartLine): number {
  return line.unitPrice * line.quantity;
}

function cartSubtotal(cart: ReadonlyArray<CartLine>): number {
  return cart.reduce((sum, line) => sum + cartLineTotal(line), 0);
}

/**
 * 注文カートダイアログ（design.md CustomerOrderApp、要件1.7-1.11）。
 *
 * カート内容・小計の確認（送信前レビュー）から、送信・成功/失敗結果の
 * 表示までを1つのダイアログで完結させる。実際のsubmitOrder呼び出し・
 * idempotencyKeyの生成・保持・カートのクリアはすべて呼び出し側
 * （MenuScreen）の責務であり、本コンポーネントは受け取った`submission`
 * 状態を表示し、ボタン操作を`onSubmit`/`onClose`として通知するだけの
 * 表示専用コンポーネントとする（OptionSelectionPanelと同じ責務分割）。
 *
 * 「送信する」ボタンは、network-error状態のときは同じボタンが
 * 「再試行」ラベルに変わり、同じ`onSubmit`ハンドラを呼ぶ
 * （MenuScreen側でidempotencyKeyを使い回すことで冪等性を保つ設計。
 * 詳細はMenuScreen.tsxのhandleSubmitコメント参照）。
 */
export default function CartPanel({
  cart,
  submission,
  onClose,
  onSubmit,
}: CartPanelProps) {
  const submitting = submission.kind === "submitting";

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="注文カート"
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl"
      >
        {submission.kind === "success" ? (
          <div className="py-4 text-center">
            <p className="text-base font-semibold text-neutral-900">
              送信完了
            </p>
            <p role="status" className="mt-1 text-sm text-neutral-500">
              ご注文を承りました。厨房に送信されました。
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-5 w-full rounded-lg bg-neutral-900 py-2.5 font-medium text-white"
            >
              閉じる
            </button>
          </div>
        ) : (
          <>
            <p className="mb-3 text-base font-semibold text-neutral-900">
              注文内容の確認
            </p>

            <div className="mb-4 space-y-2">
              {cart.map((line) => (
                <div
                  key={line.key}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-neutral-700">
                    {line.name} × {line.quantity}
                  </span>
                  <span className="text-neutral-500">
                    {formatYen(cartLineTotal(line))}
                  </span>
                </div>
              ))}
            </div>

            <div className="mb-4 flex items-center justify-between border-t border-neutral-100 pt-3 text-sm font-medium text-neutral-900">
              <span>小計</span>
              <span className="flex items-baseline gap-1">
                <span className="text-xs font-normal text-neutral-400">
                  （税込み）
                </span>
                <span data-testid="cart-subtotal">
                  {formatYen(cartSubtotal(cart))}
                </span>
              </span>
            </div>

            {submission.kind === "business-error" ? (
              <p role="alert" className="mb-4 text-sm text-red-600">
                {BUSINESS_ERROR_MESSAGES[submission.code](
                  submission.itemName,
                )}
              </p>
            ) : null}

            {submission.kind === "network-error" ? (
              <p role="alert" className="mb-4 text-sm text-red-600">
                {NETWORK_ERROR_MESSAGE}
              </p>
            ) : null}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="flex-1 rounded-lg border border-neutral-300 py-2.5 font-medium text-neutral-700 disabled:opacity-40"
              >
                閉じる
              </button>
              <button
                type="button"
                onClick={onSubmit}
                disabled={submitting || cart.length === 0}
                className="flex-[2] rounded-lg bg-neutral-900 py-2.5 font-medium text-white disabled:opacity-40"
              >
                {submitting
                  ? "送信中..."
                  : submission.kind === "network-error"
                    ? "再試行"
                    : "注文する"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
