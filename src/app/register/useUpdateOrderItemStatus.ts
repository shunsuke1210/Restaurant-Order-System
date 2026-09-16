import { useState } from "react";
import type { StaffOperationsGateway } from "@/lib/gateways/staffOperationsGateway";
import type { OrderItemStatus } from "@/lib/gateways/customerOrderingGateway";

/**
 * useUpdateOrderItemStatus — 卓詳細パネル（TableDetailPanel、タスク8.4）の
 * レジからの品目ステータス変更操作（`updateOrderItemStatus`呼び出し →
 * 成功時のFloorMapローカル状態への即時マージ）をまとめた小さな共有フック。
 * `useAddOrderItem.ts`/`useRemoveOrderItem.ts`（タスク8.3）が確立した
 * 「呼び出し関数・エラーメッセージ・クリア関数の構成を返す、確認済みの
 * 呼び出しのみを受け取るPromise<void>」という形をそのまま踏襲する。
 *
 * Requirements: 5.7
 * Design: .kiro/specs/table-order-kitchen/design.md「RegisterConsole」
 *   （「来店中の人数変更・品目の追加・削除・ステータス変更・会計確定は
 *   いずれも実行前に確認ダイアログを表示し、確認後にのみ対応する
 *   StaffOperationsGatewayのメソッドを呼び出す」）、StaffOperationsGateway.
 *   updateOrderItemStatus のService Interface。
 *
 * ## `useAdvanceOrderItemStatus.ts`（KitchenBoard、タスク7.5）を再利用しない理由
 * KitchenBoard側の`useAdvanceOrderItemStatus.ts`は「確認モーダルを設けない」
 * （要件6.5）という設計を前提に、クリック直後に即座に`updateOrderItemStatus`
 * を呼び出すfire-and-forget寄りの構成を取る。一方RegisterConsoleの本フックは
 * 要件5.7「実行前に確認を求め、確認された場合にのみ...更新する」により、
 * TableDetailPanel.tsxの確認モーダルが応答を待ってから閉じる必要があり
 * （`useAddOrderItem.ts`/`useRemoveOrderItem.ts`と同型）、戻り値の形
 * （`{action, error, clearError}`のうち`action`は例外を再送出せず解決する
 * `Promise<void>`）が異なる。両フックは名前こそ似るが要求する契約が違うため、
 * 共有せず`useAddOrderItem.ts`と同型の新規フックとして実装する
 * （tasks.md「Read first」6.が明示的に指示する設計判断）。
 *
 * ## 確認モーダルとの関係（本フックは「確認後」のみを担う）
 * 確認ダイアログの表示・「いいえ」でのキャンセルはUI層
 * （TableDetailPanel.tsx、`ConfirmDialog`）の責務であり、本フックの
 * `updateStatus`は既に確認済みの呼び出しのみを受け取る
 * （`useAddOrderItem.ts`の`addItem`と同じ役割分担）。
 *
 * ## 反映方式（`useAdvanceOrderItemStatus.ts`と同型、サーバー確定済み応答のみ）
 * `updateOrderItemStatus`の呼び出し前に表示を先読みで書き換える「真の
 * 楽観的更新」は行わない。RPCが返すサーバー確定済みの`OrderItemSummary`を
 * 受け取ってから、`mergeUpdatedItemStatus`（`FloorMap.tsx`）が該当明細のみを
 * ローカル状態にマージする。
 *
 * ## `INVALID_TRANSITION`（他端末との競合によるレース、要件E）
 * 別のレジ端末・厨房端末が同じ品目を先に別のステータスへ進めた直後に、
 * この端末でも同じ品目の「進める」ボタンを押すというレースでは、RPCが
 * 最終的な整合性の砦として`INVALID_TRANSITION`を返しうる
 * （`useAdvanceOrderItemStatus.ts`冒頭コメント「失敗時の方針」と同じ考え方）。
 * 汎用メッセージを表示するのみでローカル状態には触れず、次回の背景
 * ポーリングが真のサーバー状態へ自然に補正するのに任せる（要件5.7が
 * コード別の個別文言分岐を要求しないため、KitchenBoard側の既存方針を
 * そのまま踏襲する）。
 *
 * `ORDER_ITEM_NOT_FOUND`/`FORBIDDEN`は、本フックがパネル表示中の
 * `table.items`に実在する`orderItemId`に対してのみ呼ばれるという前提により
 * 防御的にしか到達しない（`useRemoveOrderItem.ts`と同じ考え方）。個別の
 * 文言分岐は行わず、共有の汎用メッセージへ倒す。
 */

export type UpdateOrderItemStatusError = { tableId: string; message: string };

export type UpdatedOrderItemStatus = {
  id: string;
  status: OrderItemStatus;
};

const GENERIC_UPDATE_STATUS_ERROR_MESSAGE =
  "ステータスの更新に失敗しました。もう一度お試しください。";

export function useUpdateOrderItemStatus(
  gateway: Pick<StaffOperationsGateway, "updateOrderItemStatus">,
  mergeUpdatedItemStatus: (
    tableId: string,
    item: UpdatedOrderItemStatus,
  ) => void,
) {
  const [updateStatusError, setUpdateStatusError] =
    useState<UpdateOrderItemStatusError | null>(null);

  async function updateStatus(
    tableId: string,
    orderItemId: string,
    status: OrderItemStatus,
  ): Promise<void> {
    setUpdateStatusError(null);

    try {
      const result = await gateway.updateOrderItemStatus({
        orderItemId,
        status,
      });

      if (!result.ok) {
        setUpdateStatusError({
          tableId,
          message: GENERIC_UPDATE_STATUS_ERROR_MESSAGE,
        });
        return;
      }

      mergeUpdatedItemStatus(tableId, {
        id: result.value.id,
        status: result.value.status,
      });
    } catch {
      setUpdateStatusError({
        tableId,
        message: GENERIC_UPDATE_STATUS_ERROR_MESSAGE,
      });
    }
  }

  function clearUpdateStatusError() {
    setUpdateStatusError(null);
  }

  return { updateStatus, updateStatusError, clearUpdateStatusError };
}
