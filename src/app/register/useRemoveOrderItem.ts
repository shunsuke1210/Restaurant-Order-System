import { useState } from "react";
import type { StaffOperationsGateway } from "@/lib/gateways/staffOperationsGateway";

/**
 * useRemoveOrderItem — 卓詳細パネル（TableDetailPanel、タスク8.3）のレジからの
 * 注文明細削除操作（`removeOrderItem`呼び出し → 成功時のFloorMapローカル
 * 状態への即時マージ）をまとめた小さな共有フック。`useCheckIn.ts`/
 * `useAddOrderItem.ts`と同じ構成（呼び出し関数・エラーメッセージ・クリア
 * 関数を返す）を踏襲する。
 *
 * Requirements: 5.6
 * Design: .kiro/specs/table-order-kitchen/design.md「RegisterConsole」
 *   （「注文明細を削除する...実行前に確認ダイアログを表示し、確認された
 *   場合にのみ当該注文明細を削除する」）、StaffOperationsGateway.
 *   removeOrderItem のService Interface。
 *
 * ## 確認モーダルとの関係、Promiseを返す理由
 * useAddOrderItem.ts冒頭コメントと同じ理由。確認ダイアログの表示・
 * 「いいえ」でのキャンセルはTableDetailPanel.tsxの責務であり、本フックの
 * `removeItem`は確認済みの呼び出しのみを受け取る。TableDetailPanel.tsxが
 * 確認モーダルを開いたまま応答を待ち、応答後に閉じられるよう`Promise<void>`
 * を返す。
 *
 * ## `ORDER_ITEM_NOT_FOUND`/`FORBIDDEN`（防御的にのみ到達）
 * 本フックはパネルが現在表示している`table.items`に実在する`orderItemId`
 * に対してのみ呼ばれるため、これらのエラーは通常運用下では到達しない
 * （useCheckIn.tsの`TABLE_NOT_FOUND`/`FORBIDDEN`と同じ考え方）。個別の
 * 文言分岐は行わず、共有の汎用メッセージへ倒す。
 */

export type RemoveOrderItemError = { tableId: string; message: string };

const GENERIC_REMOVE_ITEM_ERROR_MESSAGE =
  "品目の削除に失敗しました。もう一度お試しください。";

export function useRemoveOrderItem(
  gateway: Pick<StaffOperationsGateway, "removeOrderItem">,
  mergeRemovedItem: (tableId: string, orderItemId: string) => void,
) {
  const [removeItemError, setRemoveItemError] =
    useState<RemoveOrderItemError | null>(null);

  async function removeItem(
    tableId: string,
    orderItemId: string,
  ): Promise<void> {
    setRemoveItemError(null);

    try {
      const result = await gateway.removeOrderItem({ orderItemId });

      if (!result.ok) {
        setRemoveItemError({
          tableId,
          message: GENERIC_REMOVE_ITEM_ERROR_MESSAGE,
        });
        return;
      }

      mergeRemovedItem(tableId, result.value.orderItemId);
    } catch {
      setRemoveItemError({
        tableId,
        message: GENERIC_REMOVE_ITEM_ERROR_MESSAGE,
      });
    }
  }

  function clearRemoveItemError() {
    setRemoveItemError(null);
  }

  return { removeItem, removeItemError, clearRemoveItemError };
}
