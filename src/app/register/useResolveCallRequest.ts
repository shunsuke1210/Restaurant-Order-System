import { useState } from "react";
import type { StaffOperationsGateway } from "@/lib/gateways/staffOperationsGateway";

/**
 * useResolveCallRequest — 卓詳細パネル（TableDetailPanel、タスク8.6）の
 * レジからの呼び出し対応操作（`resolveCallRequest`呼び出し → 成功時の
 * FloorMapローカル状態への即時マージ）をまとめた小さな共有フック。
 *
 * Requirements: 2.4
 * Design: .kiro/specs/table-order-kitchen/design.md「StaffOperationsGateway」
 *   の`resolveCallRequest` Service Interface（`ResolveCallRequestInput:
 *   {callRequestId}`、戻り値`CallRequest`、`ResolveCallRequestError:
 *   {code:"FORBIDDEN"}|{code:"CALL_REQUEST_NOT_FOUND"}`）。
 *
 * ## 確認モーダルを設けない理由（要件2.4 vs 5.5-5.7/3.3/3.5、タスク文書の指示）
 * 要件2.4「レジスタッフが呼び出しに対応済みとして操作する、呼び出し通知
 * サービスは当該呼び出し通知を対応済みとして扱い、通知表示を消去する」には、
 * 要件3.3（会計操作）・3.5（人数変更）・5.5-5.7（品目追加/削除/ステータス
 * 変更）に共通する「実行前に確認を求め」という文言が一切無い。これは
 * これまでの4つのレジ側書き込み操作（8.3〜8.5）がいずれも確認モーダルを
 * 持っていたパターンとは異なる非対称性だが、要件の文言に忠実に従う
 * ——KitchenBoardの品目ステータス更新（要件6.5、`useAdvanceOrderItemStatus.ts`、
 * タスク7.5）が同じ理由で確認モーダルを持たないのと同型の判断であり、
 * 「レジの書き込み操作は必ず確認モーダルを伴う」という表面的なパターン
 * ではなく、各要件の正確な文言（「実行前に確認を求め」の有無）が確認
 * モーダルの要否を決めるという、本specが一貫して守ってきた原則に従う。
 *
 * そのため本フックは、`useCheckIn.ts`（タスク8.2、同じく要件3.1に確認
 * モーダルの文言が無いため確認モーダルを経由しない）と同型に、呼び出し元
 * （`TableDetailPanel.tsx`の「対応済みにする」ボタン）のonClickから直接
 * 呼び出される（`useAddOrderItem.ts`/`useRemoveOrderItem.ts`/
 * `useUpdateOrderItemStatus.ts`のような「確認モーダルの応答を待つため
 * Promiseをawaitする」契約は不要）。
 *
 * ## 戻り値の構成について（`useCheckIn.ts`と`useAdvanceOrderItemStatus.ts`の両方を踏襲）
 * `{resolveCall, resolvingTableId, resolveCallError, clearResolveCallError}`
 * という構成は、RegisterConsole境界の他フック（`useCheckIn.ts`等）と同じ
 * 「呼び出し関数・エラー・クリア関数」の家族形状を保ちながら、
 * `useAdvanceOrderItemStatus.ts`（KitchenBoard、タスク7.5。確認モーダル
 * 無しで直接RPCを呼び、サーバー確定済みの応答でのみローカル状態をマージし、
 * 処理中フラグ（`pendingItemId`）で二重送信を防ぐ）が確立した「確認レス
 * だが処理中フラグで二重クリックを防ぐ」構造を最も近い直接の参考実装とする
 * （タスク文書が明示的に指示する設計判断）。`resolvingTableId`は
 * `useCheckIn.ts`の`submittingTableId`と同型（どの卓の呼び出し対応が
 * 処理中かをtableIdで保持し、呼び出し元がボタンの無効化に用いる）。
 *
 * ## `mergeResolvedCallRequest`がtableIdではなくsessionIdで対象卓を探す理由
 * `resolveCallRequest`の成功応答は`CallRequest`（`{id, sessionId, status,
 * createdAt}`）であり、`tableId`を持たない。本フックの`resolveCall`自体は
 * 呼び出し元（tableIdを既に知っているTableDetailPanel/FloorMap）から
 * `tableId`を受け取る（処理中フラグ・エラーのタグ付けに用いる、
 * `useCheckIn.ts`と同じ理由）が、実際にFloorMapの`state.tables`のどの卓を
 * 更新するかは、`mergeResolvedCallRequest`（`FloorMap.tsx`側の実装）が
 * 応答の`sessionId`と`table.activeSession?.id`が一致する卓を探して行う
 * （tasks.mdのタスク文書「design decisions D」が明示的に指示する設計判断。
 * `tableId`をそのまま信用してマッチさせるのではなく、応答が実際に運ぶ
 * 権威的な識別子（sessionId）で対象を特定する方が、この呼び出し1本の
 * 中では実害が無いとしても、`CallRequest`型の実際の形に忠実であるため）。
 *
 * ## エラー方針（要件E）
 * `CALL_REQUEST_NOT_FOUND`は、別のレジ端末が同じ呼び出しを先に対応済みに
 * した、または対応の合間に客の来店セッションが終了した、という実際に
 * 起こりうるレースである（`useCheckIn.ts`のSESSION_ALREADY_ACTIVEと同種の
 * 「二重操作/他端末競合」レース）。専用の分かりやすいメッセージを表示し、
 * `mergeResolvedCallRequest`を呼び出さない——ローカル状態（バナー・
 * バッジの表示）を強制的に消去したりはせず、次回の背景ポーリングが真の
 * サーバー状態（既に対応済み）を自然に反映するのに任せる（8.2〜8.5が
 * 確立した「ドキュメント化された業務エラーはローカル状態を不変のまま
 * 次回ポーリングに委ねる」という既存方針をそのまま踏襲）。`FORBIDDEN`は
 * `register`ロール限定という前提により防御的にしか到達せず、共有の汎用
 * メッセージへ倒す（`useCheckIn.ts`と同じ考え方）。
 */

export type ResolveCallRequestError = { tableId: string; message: string };

const GENERIC_RESOLVE_CALL_ERROR_MESSAGE =
  "呼び出し対応の処理に失敗しました。もう一度お試しください。";

// 要件E: 別端末による同一呼び出しへの先行対応・セッション終了との競合で
// 実際に起こりうるレース。useCheckIn.tsのSESSION_ALREADY_ACTIVE用メッセージ
// と同型の専用文言。
const CALL_REQUEST_NOT_FOUND_MESSAGE =
  "この呼び出しは既に対応済みか、見つかりませんでした。画面表示をご確認ください。";

export function useResolveCallRequest(
  gateway: Pick<StaffOperationsGateway, "resolveCallRequest">,
  mergeResolvedCallRequest: (sessionId: string) => void,
) {
  const [resolvingTableId, setResolvingTableId] = useState<string | null>(
    null,
  );
  const [resolveCallError, setResolveCallError] =
    useState<ResolveCallRequestError | null>(null);

  // tasks.md Implementation Notes: resolveCallRequestはドキュメント化された
  // 業務エラー（CALL_REQUEST_NOT_FOUND/FORBIDDEN）をResultへ、それ以外
  // （ネットワーク断等）を例外へ振り分けるため、両方を捕捉する必要がある。
  async function resolveCall(tableId: string, callRequestId: string) {
    setResolveCallError(null);
    setResolvingTableId(tableId);

    try {
      const result = await gateway.resolveCallRequest({ callRequestId });

      if (!result.ok) {
        setResolveCallError({
          tableId,
          message:
            result.error.code === "CALL_REQUEST_NOT_FOUND"
              ? CALL_REQUEST_NOT_FOUND_MESSAGE
              : GENERIC_RESOLVE_CALL_ERROR_MESSAGE,
        });
        setResolvingTableId(null);
        return;
      }

      mergeResolvedCallRequest(result.value.sessionId);
      setResolvingTableId(null);
    } catch {
      setResolveCallError({
        tableId,
        message: GENERIC_RESOLVE_CALL_ERROR_MESSAGE,
      });
      setResolvingTableId(null);
    }
  }

  function clearResolveCallError() {
    setResolveCallError(null);
  }

  return {
    resolveCall,
    resolvingTableId,
    resolveCallError,
    clearResolveCallError,
  };
}
