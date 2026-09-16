import { useState } from "react";
import type {
  StaffOperationsGateway,
  AddOrderItemInput,
} from "@/lib/gateways/staffOperationsGateway";
import type { OrderItemSummary } from "@/lib/gateways/customerOrderingGateway";

/**
 * useAddOrderItem — 卓詳細パネル（TableDetailPanel、タスク8.3）のレジからの
 * 品目追加操作（`addOrderItem`呼び出し → 成功時のFloorMapローカル状態への
 * 即時マージ）をまとめた小さな共有フック。`useCheckIn.ts`（タスク8.2）が
 * 確立した「呼び出し関数・エラーメッセージ・クリア関数の構成を返す」という
 * 形をそのまま踏襲する。
 *
 * Requirements: 5.5
 * Design: .kiro/specs/table-order-kitchen/design.md「RegisterConsole」
 *   （「品目の追加...はいずれも実行前に確認ダイアログを表示し、確認後にのみ
 *   対応するStaffOperationsGatewayのメソッドを呼び出す」）、
 *   StaffOperationsGateway.addOrderItem のService Interface。
 *
 * ## 確認モーダルとの関係（本フックは「確認後」のみを担う）
 * 要件5.5「実行前に確認を求め、確認された場合にのみ...品目を追加する」の
 * うち、確認ダイアログの表示・「いいえ」でのキャンセルはUI層
 * （TableDetailPanel.tsx、OptionSelectionPanelの「選択を確定」ボタン、
 * または簡易確認モーダルの「追加する」ボタン）の責務であり、本フックの
 * `addItem`は既に確認済みの呼び出しのみを受け取る（SoldOutBoard.tsxの
 * `confirmPendingToggle`と同じ役割分担）。
 *
 * ## 戻り値をPromiseにする理由（`useCheckIn`のfire-and-forgetとの違い）
 * `useCheckIn.ts`の`checkIn`は呼び出し側（VacantView）から`await`されない
 * fire-and-forget関数だが、本フックの`addItem`はTableDetailPanel.tsxの
 * 確認モーダル・OptionSelectionPanelが「送信中」表示を出し、応答が返って
 * から初めてローカルの確認UI状態（`pendingSimpleAdd`/`optionItem`）を
 * 閉じるために`await`する必要がある（SoldOutBoard.tsxの
 * `confirmPendingToggle`が確認モーダルを開いたまま応答を待つのと同型）。
 * そのため`addItem`は明示的に`Promise<void>`を返し、成功・失敗のいずれの
 * 場合も例外を再送出せず解決する（エラー自体は`addItemError`として公開する）。
 *
 * ## ITEM_SOLD_OUT（要件E、レース条件）
 * レジ端末が品目追加リストを開いてから確定するまでの間に、厨房端末が
 * 当該品目を売り切れにする競合が起こりうる。専用メッセージを表示し、
 * ローカル状態への追加（マージ）は一切行わない（サーバーが拒否した追加を
 * クライアント側で偽装しない）。
 *
 * `SESSION_NOT_ACTIVE`/`FORBIDDEN`は、本フックがパネル表示中の
 * アクティブセッションに対してのみ呼ばれる（パネルが表示されている時点で
 * `activeSession`は非null）という前提により、防御的にしか到達しない
 * （`useCheckIn.ts`と同じ考え方）。個別の文言分岐は行わず、共有の汎用
 * メッセージへ倒す。
 */

export type AddOrderItemError = { tableId: string; message: string };

const GENERIC_ADD_ITEM_ERROR_MESSAGE =
  "品目の追加に失敗しました。もう一度お試しください。";

const ITEM_SOLD_OUT_MESSAGE =
  "この品目は現在売り切れのため追加できませんでした。品目一覧をご確認ください。";

export function useAddOrderItem(
  gateway: Pick<StaffOperationsGateway, "addOrderItem">,
  mergeAddedItem: (tableId: string, item: OrderItemSummary) => void,
) {
  const [addItemError, setAddItemError] = useState<AddOrderItemError | null>(
    null,
  );

  async function addItem(
    tableId: string,
    input: AddOrderItemInput,
  ): Promise<void> {
    setAddItemError(null);

    try {
      const result = await gateway.addOrderItem(input);

      if (!result.ok) {
        setAddItemError({
          tableId,
          message:
            result.error.code === "ITEM_SOLD_OUT"
              ? ITEM_SOLD_OUT_MESSAGE
              : GENERIC_ADD_ITEM_ERROR_MESSAGE,
        });
        return;
      }

      mergeAddedItem(tableId, result.value);
    } catch {
      setAddItemError({ tableId, message: GENERIC_ADD_ITEM_ERROR_MESSAGE });
    }
  }

  function clearAddItemError() {
    setAddItemError(null);
  }

  return { addItem, addItemError, clearAddItemError };
}
