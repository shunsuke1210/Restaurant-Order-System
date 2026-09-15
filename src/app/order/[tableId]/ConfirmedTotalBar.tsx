"use client";

import { formatYen } from "./formatYen";

type ConfirmedTotalBarProps = {
  amount: number;
};

/**
 * 画面下部に固定表示する確定注文合計バー（要件1.12）。
 *
 * design.md「CustomerOrderApp」要約が要求する「確定注文合計の表示」を、
 * mock-preview.html（`orderTotalBarHtml`関数）が検証済みのUIパターン
 * （画面下部固定・「ご注文合計」ラベル＋金額）に沿って実装する。
 *
 * `amount`は`getOrderingContext`の`confirmedTotal`（当該来店セッションで
 * 送信済みの注文の合計金額。自端末・同席者の別端末の送信を問わず
 * サーバー側で集計済みの値）をそのまま渡す想定で、この値自体を
 * 最新に保つ責務（ポーリングによるライブ更新、6.2の設計判断）は
 * 呼び出し側（MenuScreen）が持つ。本コンポーネント自身は表示専用。
 */
export default function ConfirmedTotalBar({ amount }: ConfirmedTotalBarProps) {
  return (
    <div
      data-testid="confirmed-total-bar"
      className="fixed inset-x-0 bottom-0 z-0 flex items-center justify-between border-t border-neutral-200 bg-white px-4 py-3 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]"
    >
      <span className="text-sm text-neutral-500">ご注文合計</span>
      <span
        data-testid="confirmed-total-amount"
        className="font-mono text-base font-semibold text-neutral-900"
      >
        {formatYen(amount)}
      </span>
    </div>
  );
}
