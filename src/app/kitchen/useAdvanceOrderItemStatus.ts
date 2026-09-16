import { useState } from "react";
import type { StaffOperationsGateway } from "@/lib/gateways/staffOperationsGateway";
import type { OrderItemStatus } from "@/lib/gateways/customerOrderingGateway";
import type { KitchenFeedItem } from "./FoodBoard";

/**
 * useAdvanceOrderItemStatus — フードボード（7.2）・ドリンクボード（7.3）が
 * 共通して必要とする「ステータス更新ボタンのクリック処理」をまとめた
 * 小さな共有フック。FoodBoard.tsx/DrinkBoard.tsxの両方から利用する
 * （タスク7.5）。
 *
 * Requirements: 6.1, 6.2, 6.5, 6.6
 * Design: .kiro/specs/table-order-kitchen/design.md「StaffOperationsGateway」
 *   の`updateOrderItemStatus` Service Interface（ジャンルに応じた遷移検証は
 *   RPC側の責務。本フックはUI側から確定済みの遷移先statusを渡すだけ）。
 *
 * ## 確認モーダルを設けない理由（要件6.5 vs 要件7.1/7.3）
 * requirements.md 要件6.5「厨房スタッフが品目のステータスを更新する、
 * 厨房KDSサービスは更新結果を画面に即座に反映する」には、要件7.1
 * 「実行前に確認を求め...」のような確認言及が一切無い。売り切れ登録
 * （SoldOutBoard.tsx、7.4）とは異なり、本フックは確認ステップを一切
 * 経由せずクリック直後に`updateOrderItemStatus`を呼び出す。
 *
 * ## 反映方式について（SoldOutBoard.tsxのconfirmPendingToggleと同型）
 * `setSoldOut`の呼び出し前に表示を先読みで書き換える「真の楽観的更新」は
 * 行わない。RPCが返すサーバー確定済みの`OrderItemSummary`を受け取ってから
 * 該当品目のみを`updateItems`経由でローカル一覧にマージする。この方式でも
 * タスク7.5の観測可能な完了条件（「確認や再読み込みなしで、直後に該当
 * カードが新しい列へ移動する」）は満たされる——マージは次回ポーリング
 * （FOOD_BOARD_POLL_INTERVAL_MS/DRINK_BOARD_POLL_INTERVAL_MS、5秒間隔）を
 * 待たずにRPC応答到達時点で即座に行われるため。
 *
 * ## 失敗時の方針（他端末との競合によるINVALID_TRANSITIONを含む）
 * `updateOrderItemStatus`のエラー共用体（ORDER_ITEM_NOT_FOUND /
 * INVALID_TRANSITION / FORBIDDEN）のいずれであっても、ローカル状態は
 * 一切書き換えない（＝該当カードは更新前の列に留まる）。UI上はボタンが
 * 提供する遷移のみをクリック可能にしているため、通常はRPCが拒否する
 * 遷移をUIから送信することはないが、「別の厨房端末が同じ品目を先に
 * 完了済みへ進めた直後に、この端末でも同じ品目のボタンを押す」という
 * レースでは、RPCが最終的な整合性の砦としてINVALID_TRANSITIONを返し
 * うる。この場合、案内メッセージを表示するのみでローカル状態には触れず、
 * 次回ポーリングが真のサーバー状態（＝既に他端末が進めた後の状態）へ
 * 自然に補正するのに任せる（SoldOutBoard.tsxの`confirmPendingToggle`が
 * 確立した「ドキュメント化された業務エラーも汎用メッセージ表示＋ローカル
 * 状態は不変」という方針をそのまま踏襲。エラーコードごとの個別文言分岐は
 * 本タスクの観測可能な完了条件が要求しないため行わない）。
 *
 * ## `pendingItemId`が単一の理由（品目単位の排他制御で足りる）
 * 同一品目に対する二重送信（例: 一品の「調理開始」と「直接完了」を
 * 連打）を防ぐのみが目的であり、ボード全体で同時に1件しか操作できない
 * ようにする必要はない。そのため「どの品目IDが処理中か」のみを保持し、
 * ボタン側は`pendingItemId === item.id`の場合のみ自分自身を無効化する
 * （他のカードのボタンには影響しない）。
 */

const GENERIC_STATUS_UPDATE_ERROR_MESSAGE =
  "ステータスの更新に失敗しました。画面を確認し、もう一度お試しください。";

export function useAdvanceOrderItemStatus(
  gateway: Pick<StaffOperationsGateway, "updateOrderItemStatus">,
  updateItems: (
    updater: (
      prev: ReadonlyArray<KitchenFeedItem>,
    ) => ReadonlyArray<KitchenFeedItem>,
  ) => void,
) {
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function advance(item: KitchenFeedItem, nextStatus: OrderItemStatus) {
    setActionError(null);
    setPendingItemId(item.id);

    // tasks.md Implementation Notes: updateOrderItemStatusはドキュメント化
    // された業務エラー（ORDER_ITEM_NOT_FOUND/INVALID_TRANSITION/FORBIDDEN）
    // をResultへ、それ以外（ネットワーク断等）を例外へ振り分けるため、
    // 両方を捕捉する必要がある。
    try {
      const result = await gateway.updateOrderItemStatus({
        orderItemId: item.id,
        status: nextStatus,
      });

      if (!result.ok) {
        // ファイル冒頭コメント「失敗時の方針」参照: ローカル状態は不変の
        // ままエラー表示のみ行う。
        setActionError(GENERIC_STATUS_UPDATE_ERROR_MESSAGE);
        setPendingItemId(null);
        return;
      }

      // ファイル冒頭コメント「反映方式について」参照: サーバー確定済みの
      // 応答で該当品目のみをマージする。
      updateItems((prev) =>
        prev.map((existing) =>
          existing.id === result.value.id
            ? {
                ...existing,
                status: result.value.status,
                statusUpdatedAt: result.value.statusUpdatedAt,
              }
            : existing,
        ),
      );
      setPendingItemId(null);
    } catch {
      setActionError(GENERIC_STATUS_UPDATE_ERROR_MESSAGE);
      setPendingItemId(null);
    }
  }

  return { advance, pendingItemId, actionError };
}
