import { useState } from "react";
import type { StaffOperationsGateway } from "@/lib/gateways/staffOperationsGateway";

/**
 * useUpdatePartySize — 卓詳細パネル（TableDetailPanel、タスク8.7）のレジからの
 * 人数変更操作（`updatePartySize`呼び出し → 成功時のFloorMapローカル状態への
 * 即時マージ）をまとめた小さな共有フック。`useAddOrderItem.ts`/
 * `useRemoveOrderItem.ts`/`useUpdateOrderItemStatus.ts`/`useCloseSession.ts`
 * が確立した「呼び出し関数・エラーメッセージ・クリア関数の構成を返す、
 * 確認済みの呼び出しのみを受け取るPromise<void>」という形をそのまま踏襲する
 * （タスク文書「Design decisions E」が明示的に指示する設計判断——確認モーダル
 * の応答を待つ`useAddOrderItem.ts`等と同型であり、確認レスな
 * `useResolveCallRequest.ts`とは異なる）。
 *
 * Requirements: 3.5
 * Design: .kiro/specs/table-order-kitchen/design.md「StaffOperationsGateway」
 *   の`updatePartySize` Service Interface（`UpdatePartySizeInput:
 *   {sessionId, partySize}`、戻り値`TableSession`、`UpdatePartySizeError:
 *   {code:"SESSION_NOT_ACTIVE"}|{code:"FORBIDDEN"}`）、
 *   「updatePartySizeは対象セッションがactiveである場合のみ人数を更新し...
 *   実行前確認はUI層（RegisterConsole）の責務とする（要件3.5）」。
 *
 * ## 確認モーダルとの関係、Promiseを返す理由
 * useAddOrderItem.ts/useUpdateOrderItemStatus.ts冒頭コメントと同じ理由。
 * 確認ダイアログの表示・「いいえ」でのキャンセルはTableDetailPanel.tsxの
 * 責務であり、本フックの`updatePartySize`は確認済みの呼び出しのみを受け取る。
 * TableDetailPanel.tsxが確認モーダルを開いたまま応答を待ち、応答後に閉じ
 * られるよう`Promise<void>`を返す（成功・失敗いずれの場合も例外を再送出
 * せず解決する）。
 *
 * ## 成功時のマージ（design decision C、8.x全体で最も単純なマージ）
 * `updatePartySize`が返す`TableSession.partySize`をそのまま該当卓の
 * `activeSession.partySize`へマージする（`mergePartySize`、`FloorMap.tsx`）。
 * 8.2の`mergeStartedSession`（items/total/hasOpenCallRequestの合成）や
 * 8.5の`mergeVacatedTable`（4フィールドの合成＋パネルを閉じる）のような
 * 複数フィールドの合成・副次的なUI操作が一切不要——`TableSession`が直接
 * 新しい`partySize`を返すため、単一フィールドをそのまま書き写すだけでよい。
 *
 * ## エラー方針（design decisions D、SESSION_NOT_ACTIVE/FORBIDDENいずれも汎用メッセージへ）
 * `SESSION_NOT_ACTIVE`（レジ端末が卓詳細パネルを開いてから人数変更を確定
 * するまでの間に、別のレジ端末が同じセッションを先に会計済みにした、という
 * 実際に起こりうるレース）は、`useCloseSession.ts`のように専用文言へ分岐
 * せず、`useAddOrderItem.ts`/`useUpdateOrderItemStatus.ts`が確立した
 * 「ドキュメント化された業務エラーであっても分岐せず単一の汎用メッセージへ
 * 倒す」という方針をそのまま踏襲する（タスク文書「Design decisions D」が
 * 明示的に指示する設計判断。`useCheckIn.ts`のSESSION_ALREADY_ACTIVE・
 * `useCloseSession.ts`のSESSION_NOT_ACTIVEにある専用文言とは対照的だが、
 * いずれの方針も「実際に起こりうるレースに対して分かりやすいメッセージを
 * 示す」という要件Eの目的自体は満たしており、本フックがどちらの前例に
 * 倣うかはタスク文書の明示的な指示に従う）。`FORBIDDEN`は`register`ロール
 * 限定という前提により防御的にしか到達せず、同じ汎用メッセージへ倒す。
 *
 * いずれのエラーもローカル状態（FloorMapの`state.tables`）は不変のまま
 * 次回の背景ポーリングに委ねる（`mergePartySize`を呼び出さない、8.2〜8.6が
 * 確立した既存方針をそのまま踏襲）。
 */

export type UpdatePartySizeError = { tableId: string; message: string };

const GENERIC_UPDATE_PARTY_SIZE_ERROR_MESSAGE =
  "人数の変更に失敗しました。もう一度お試しください。";

export function useUpdatePartySize(
  gateway: Pick<StaffOperationsGateway, "updatePartySize">,
  mergePartySize: (tableId: string, partySize: number) => void,
) {
  const [updatePartySizeError, setUpdatePartySizeError] =
    useState<UpdatePartySizeError | null>(null);

  async function updatePartySize(
    tableId: string,
    sessionId: string,
    partySize: number,
  ): Promise<void> {
    setUpdatePartySizeError(null);

    try {
      const result = await gateway.updatePartySize({ sessionId, partySize });

      if (!result.ok) {
        setUpdatePartySizeError({
          tableId,
          message: GENERIC_UPDATE_PARTY_SIZE_ERROR_MESSAGE,
        });
        return;
      }

      mergePartySize(tableId, result.value.partySize);
    } catch {
      setUpdatePartySizeError({
        tableId,
        message: GENERIC_UPDATE_PARTY_SIZE_ERROR_MESSAGE,
      });
    }
  }

  function clearUpdatePartySizeError() {
    setUpdatePartySizeError(null);
  }

  return {
    updatePartySize,
    updatePartySizeError,
    clearUpdatePartySizeError,
  };
}
