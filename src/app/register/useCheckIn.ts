import { useState } from "react";
import type {
  StaffOperationsGateway,
  TableSession,
} from "@/lib/gateways/staffOperationsGateway";

/**
 * useCheckIn — 卓詳細パネル（TableDetailPanel、タスク8.2）の入店操作
 * （人数入力 → `startSession`呼び出し → 成功時のFloorMapローカル状態への
 * 即時マージ）をまとめた小さな共有フック。`useAdvanceOrderItemStatus.ts`
 * （タスク7.5、KitchenBoard境界）が確立した「呼び出し関数・処理中フラグ・
 * エラーメッセージの3点セットを返す」という構成をそのまま踏襲する。
 *
 * Requirements: 3.1, 3.2, 3.4
 * Design: .kiro/specs/table-order-kitchen/design.md「RegisterConsole」
 *   （「入店操作は人数の入力を伴い（要件3.1, 3.4）」）、
 *   StaffOperationsGateway.startSession のService Interface。
 *
 * ## 確認モーダルを設けない理由（タスク文書の指示、要件3.1 vs 3.3/3.5/5.5-5.7）
 * 要件3.1には3.3（会計操作）・3.5（人数変更）・5.5-5.7（品目追加/削除/
 * ステータス変更）に共通する「実行前に確認を求め」という文言が無い。
 * 人数入力ステッパー＋「入店する」ボタン自体が既に熟慮された確定操作で
 * あり（TableDetailPanel.tsx参照）、本フックはクリック直後に`startSession`
 * を呼び出す（SoldOutBoard.tsxの確認モーダル・useAdvanceOrderItemStatus.ts
 * の確認レスな即時実行、両方の前例と対称的に「このRPCの前段に確認ダイアログ
 * を挟まない」という2つ目のクラスに属する）。
 *
 * ## SESSION_ALREADY_ACTIVE（要件3.2）の扱い方について
 * これは二重入店操作（同じ卓に対する複数レジ端末からの同時操作や、
 * 誤操作での連打）で実際に起こりうるエラーであり、単なる防御的分岐ではない。
 * 要件3.2「新しいセッションを発行せず、既存セッションが有効である旨を
 * 警告表示する」に対応する専用メッセージを表示する。この時点でこちら側は
 * 既存セッションの実際の人数・注文内容を知らないため、それらを推測して
 * ローカル状態を書き換える（＝占有中であるかのように偽装する）ことは
 * 一切行わない。`mergeStartedSession`を呼び出さずFloorMapの`state`を
 * 未変更のまま残し、次回の背景ポーリング（`REGISTER_FLOOR_MAP_POLL_
 * INTERVAL_MS`後）が実際のサーバー状態（既存の占有中セッション）を
 * 自然に反映するのに任せる（SoldOutBoard.tsxの`confirmPendingToggle`・
 * useAdvanceOrderItemStatus.tsの`advance`が確立した「ドキュメント化された
 * 業務エラーでもローカル状態は不変のまま、次回ポーリングが正しい状態へ
 * 補正する」という既存方針をそのまま踏襲）。
 *
 * `TABLE_NOT_FOUND`/`FORBIDDEN`は、`tableId`が常に`listRegisterFeed`が
 * 返した実在の卓から取得され、role-gatingが通常運用下でFORBIDDENの到達を
 * 防ぐという前提により、防御的にしか到達しない（tasks.mdのタスク文書
 * 「Design decisions B」参照）。個別の文言分岐は行わず、
 * `useAdvanceOrderItemStatus.ts`の`GENERIC_STATUS_UPDATE_ERROR_MESSAGE`と
 * 同型の共有汎用メッセージへ倒す。
 *
 * ## `checkInError`をtableIdでタグ付けする理由
 * 呼び出し元（FloorMap.tsx）は、選択中の卓（`selectedTableId`）が
 * 切り替わった際にこのエラーをクリアする責務を持つが、本フック自身も
 * どの卓に対する直近の入店操作のエラーなのかを`{tableId, message}`として
 * 保持しておくことで、呼び出し元が誤って別の卓のパネルへ古いエラーを
 * 表示してしまう事故を型レベルで防ぐ（呼び出し元はtableIdの一致を
 * 確認してから表示に使う）。
 */

export type CheckInError = { tableId: string; message: string };

const GENERIC_START_SESSION_ERROR_MESSAGE =
  "入店操作に失敗しました。もう一度お試しください。";

// 要件3.2「既存セッションが有効である旨を警告表示する」の文言をそのまま反映する。
const SESSION_ALREADY_ACTIVE_MESSAGE =
  "既に有効な来店セッションが存在します。新しい来店として登録されませんでした。卓マップの表示をご確認ください。";

export function useCheckIn(
  gateway: Pick<StaffOperationsGateway, "startSession">,
  mergeStartedSession: (
    tableId: string,
    session: Pick<TableSession, "id" | "startedAt" | "partySize">,
  ) => void,
) {
  const [submittingTableId, setSubmittingTableId] = useState<string | null>(
    null,
  );
  const [checkInError, setCheckInError] = useState<CheckInError | null>(null);

  // tasks.md Implementation Notes: startSessionはドキュメント化された業務
  // エラー（SESSION_ALREADY_ACTIVE/TABLE_NOT_FOUND/FORBIDDEN）をResultへ、
  // それ以外（ネットワーク断等）を例外へ振り分けるため、両方を捕捉する
  // 必要がある（customerOrderingGateway.ts以来の既存規約）。
  async function checkIn(tableId: string, partySize: number) {
    setCheckInError(null);
    setSubmittingTableId(tableId);

    try {
      const result = await gateway.startSession({ tableId, partySize });

      if (!result.ok) {
        setCheckInError({
          tableId,
          message:
            result.error.code === "SESSION_ALREADY_ACTIVE"
              ? SESSION_ALREADY_ACTIVE_MESSAGE
              : GENERIC_START_SESSION_ERROR_MESSAGE,
        });
        setSubmittingTableId(null);
        return;
      }

      mergeStartedSession(tableId, {
        id: result.value.id,
        startedAt: result.value.startedAt,
        partySize: result.value.partySize,
      });
      setSubmittingTableId(null);
    } catch {
      setCheckInError({
        tableId,
        message: GENERIC_START_SESSION_ERROR_MESSAGE,
      });
      setSubmittingTableId(null);
    }
  }

  function clearCheckInError() {
    setCheckInError(null);
  }

  return { checkIn, submittingTableId, checkInError, clearCheckInError };
}
