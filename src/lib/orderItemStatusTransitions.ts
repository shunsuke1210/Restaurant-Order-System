import type { OrderItemStatus } from "./gateways/customerOrderingGateway";
import type { MenuItemGenre } from "./gateways/staffOperationsGateway";

/**
 * orderItemStatusTransitions.ts — 品目のジャンル×現在ステータスから
 * 「1段階分の次ステータス」を判定する共有の純粋関数（タスク8.4で新規追加）。
 * KitchenBoard（`src/app/kitchen/OrderItemStatusActions.tsx`、タスク7.5）と
 * RegisterConsole（`src/app/register/TableDetailPanel.tsx`、タスク8.4）の
 * 両方から利用する、Boundary Contextを跨ぐ`src/lib/`配置の共有モジュール。
 *
 * Requirements: 5.7, 6.2, 6.3, 6.4, 6.6
 * Design: .kiro/specs/table-order-kitchen/design.md「StaffOperationsGateway」
 *   Responsibilities & Constraints（`updateOrderItemStatus`の許可遷移表:
 *   フード/一品 received→in_progress→done、ドリンク received→done）。
 *
 * ## なぜ共有するのか（tasks.mdが要求する「ドリフトリスク」への対応）
 * `update_order_item_status`（0004_rpc_staff_gateway.sql）の許可遷移表は
 * サーバー側の真実の源泉であり、UI側のボタン表示可否がこれより緩いと
 * `INVALID_TRANSITION`エラーの温床になる（tasks.md 7.5 Implementation
 * Notes）。KitchenBoardの`OrderItemStatusActions.tsx`は既にこの対応表を
 * 実装済み・レビュー済みだったが、RegisterConsole（本タスク）にも同じ
 * 判定が必要になった。`OptionSelectionPanel`（216行、8.3で直接re-use）ほど
 * 大きなロジックではないため複製という選択肢もあったが、「サーバー側の
 * 許可遷移表と1:1で対応するUIロジック」というまさにドリフトが起きやすい
 * 種類のコードであるため、コピーではなく1箇所の共有関数として抽出し、
 * KitchenBoard側もこの関数を呼ぶよう改修した（両者が同じ実装を参照する
 * ことで「コピーしたが片方だけ更新し忘れる」という失敗モードを構造的に
 * 排除する）。
 *
 * ## 対象範囲: 「1段階分」のみ（一品の直接ショートカットは含まない）
 * 一品ジャンルの`received→done`直接ショートカット（要件6.6）は、KDSの
 * 現場スタッフ向け速度優先UXとして厨房側にのみ存在する追加ボタンであり、
 * RegisterConsoleは意図的に持たない（mock-preview.htmlのレジ側
 * `tableDetailHtml`の`nextMap`が検証済みの単純化——`isFoodGenre`ジャンルは
 * 常にreceived→in_progress→doneの2段階のみで、ショートカットに相当する
 * ボタンが無い。TableDetailPanel.tsx冒頭コメント参照）。そのため本関数は
 * 「常にちょうど1段階だけ進める」遷移のみを返し、ショートカットの判定は
 * 呼び出し側（`OrderItemStatusActions.tsx`）が自身のローカルロジックとして
 * 追加で持つ。
 *
 * 戻り値: 次のステータス、または遷移先が無い場合（`done`、もしくは構造上
 * 到達しないドリンクの`in_progress`）は`null`。
 */
export function resolveNextOrderItemStatus(
  genre: MenuItemGenre,
  status: OrderItemStatus,
): OrderItemStatus | null {
  if (genre === "drink") {
    // 要件6.4: ドリンクはin_progressを経由しない。in_progressは構造上
    // 到達しない状態だが、防御的にnullを返す
    // （DrinkBoard.tsx冒頭コメント「列構成について」と同じ前提）。
    return status === "received" ? "done" : null;
  }

  // food または ippin ジャンル: received -> in_progress -> done。
  if (status === "received") {
    return "in_progress";
  }
  if (status === "in_progress") {
    return "done";
  }
  return null;
}
