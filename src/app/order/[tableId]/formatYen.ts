/**
 * 金額表示の共通フォーマッタ。mock-preview.htmlのyen()関数
 * （`'¥' + n.toLocaleString('ja-JP')`）と同じ表記に揃える。
 */
export function formatYen(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}
