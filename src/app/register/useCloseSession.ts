import { useState } from "react";
import type { StaffOperationsGateway } from "@/lib/gateways/staffOperationsGateway";

/**
 * useCloseSession — 卓詳細パネル（TableDetailPanel、タスク8.5）のレジからの
 * 会計操作（`closeSession`呼び出し → 成功時のFloorMapローカル状態への
 * 即時マージ）をまとめた小さな共有フック。`useAddOrderItem.ts`/
 * `useRemoveOrderItem.ts`/`useUpdateOrderItemStatus.ts`が確立した
 * 「呼び出し関数・エラーメッセージ・クリア関数の構成を返す、確認済みの
 * 呼び出しのみを受け取るPromise<void>」という形をそのまま踏襲する
 * （tasks.md「Read first」6.が指示する設計判断）。
 *
 * Requirements: 3.3
 * Design: .kiro/specs/table-order-kitchen/design.md「RegisterConsole」
 *   （「会計確定はいずれも実行前に確認ダイアログを表示し、確認後にのみ
 *   対応するStaffOperationsGatewayのメソッドを呼び出す（要件3.3...）」）、
 *   StaffOperationsGateway.closeSession のService Interface
 *   （Postconditions: 「closeSession成功後、当該セッションIDに紐づく
 *   submitOrderは必ずSESSION_NOT_ACTIVEを返すようになる」——UI側の見た目の
 *   リセットだけでなく、実際にセッションを終了させる本物の状態遷移である
 *   ことの裏付け）。
 *
 * ## 確認モーダルとの関係（本フックは「確認後」のみを担う）
 * 確認ダイアログの表示・「いいえ」でのキャンセルはUI層
 * （TableDetailPanel.tsx、`ConfirmDialog`）の責務であり、本フックの
 * `closeSession`は既に確認済みの呼び出しのみを受け取る
 * （`useUpdateOrderItemStatus.ts`の`updateStatus`と同じ役割分担）。
 *
 * ## 成功時のマージが「空席化＋パネルを閉じる」の2つを行う理由
 * 8.2の`mergeStartedSession`（占有中への合成）の鏡像変換だが、本タスクの
 * 観測可能な完了条件「会計確認後、卓詳細パネルが閉じて卓マップ画面が表示され、
 * 対象卓が空席状態になる」は、8.2/8.3/8.4のいずれとも異なり「パネルが閉じる」
 * ことまでを要求する（8.2/8.3/8.4はいずれも成功後もパネルを開いたまま更新後の
 * 状態を表示した）。そのため本フックが呼び出す`mergeVacatedTable`
 * （`FloorMap.tsx`）は、`state.tables`の空席化（`mutationSeqRef`の
 * インクリメントを伴う）と`selectedTableId`のクリアの両方を1箇所で行う
 * （`FloorMap.tsx`冒頭コメント参照）。
 *
 * ## `SESSION_NOT_ACTIVE`（要件E、実際に起こりうるレース）について
 * 別のレジ端末が同じセッションを先に会計済みにした直後に、この端末でも
 * 同じセッションへ会計操作を確定するというレースで実際に起こりうる
 * （`useCheckIn.ts`のSESSION_ALREADY_ACTIVEと同種の「二重操作」レース）。
 * 専用メッセージを表示し、`mergeVacatedTable`を呼び出さない——ローカル状態を
 * 強制的に空席へ書き換えたり、パネルを強制的に閉じたりはせず、次回の背景
 * ポーリングが真のサーバー状態（既に会計済み、たいていは次の入店までの
 * 空席状態）を自然に反映するのに任せる（8.2/8.3/8.4が確立した「ドキュメント化
 * された業務エラーはローカル状態を不変のまま次回ポーリングに委ねる」という
 * 既存方針をそのまま踏襲）。
 *
 * `FORBIDDEN`は、`register`ロールのみが本フックを呼び出すという前提により
 * 防御的にしか到達しない（`useCheckIn.ts`と同じ考え方）。個別の文言分岐は
 * 行わず、共有の汎用メッセージへ倒す。
 */

export type CloseSessionError = { tableId: string; message: string };

const GENERIC_CLOSE_SESSION_ERROR_MESSAGE =
  "会計処理に失敗しました。もう一度お試しください。";

// 要件E: 別端末による同一セッションへの先行会計・二重操作で実際に起こりうる
// レース。useCheckIn.tsのSESSION_ALREADY_ACTIVE用メッセージと同型の専用文言。
const SESSION_NOT_ACTIVE_MESSAGE =
  "このセッションは既に会計処理済みです。卓マップの表示をご確認ください。";

export function useCloseSession(
  gateway: Pick<StaffOperationsGateway, "closeSession">,
  mergeVacatedTable: (tableId: string) => void,
) {
  const [closeSessionError, setCloseSessionError] =
    useState<CloseSessionError | null>(null);

  async function closeSession(
    tableId: string,
    sessionId: string,
  ): Promise<void> {
    setCloseSessionError(null);

    try {
      const result = await gateway.closeSession({ sessionId });

      if (!result.ok) {
        setCloseSessionError({
          tableId,
          message:
            result.error.code === "SESSION_NOT_ACTIVE"
              ? SESSION_NOT_ACTIVE_MESSAGE
              : GENERIC_CLOSE_SESSION_ERROR_MESSAGE,
        });
        return;
      }

      mergeVacatedTable(tableId);
    } catch {
      setCloseSessionError({
        tableId,
        message: GENERIC_CLOSE_SESSION_ERROR_MESSAGE,
      });
    }
  }

  function clearCloseSessionError() {
    setCloseSessionError(null);
  }

  return { closeSession, closeSessionError, clearCloseSessionError };
}
