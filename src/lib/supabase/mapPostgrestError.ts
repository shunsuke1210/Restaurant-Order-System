import type { PostgrestError } from "@supabase/supabase-js";

/**
 * SQLSTATE（`PostgrestError.code`）から、design.mdが定義する型付きエラー
 * バリアントへのマッピングテーブル。キーはRPC関数が`raise exception ...
 * using errcode = '...'`で送出するカスタムSQLSTATE（例: 'P0404'）、値は
 * その`PostgrestError`から対応するエラー値を組み立てる関数
 * （`ITEM_SOLD_OUT`のように`error.details`から追加フィールドを
 * 抽出する場合があるため、値ではなく関数として持つ）。
 */
export type PostgrestErrorMapping<E> = Record<string, (error: PostgrestError) => E>;

/**
 * `PostgrestError`を、呼び出し元が渡したSQLSTATE→型付きエラーの
 * マッピングに従って変換する共有ヘルパー。
 *
 * `CustomerOrderingGateway`（本タスク3.4）と、将来の
 * `StaffOperationsGateway`ラッパー（design.mdのFile Structure Plan、
 * タスク4.6）はいずれも「RPCが返したSQLSTATEを、design.mdのService
 * Interfaceが定義する判別可能なエラー共用体の1メンバーへ変換する」という
 * 同じ形のロジックを必要とするため、gatewayごとに複製せずここへ集約する。
 *
 * ## 未知のSQLSTATEの扱い（src/lib/result.tsの方針を踏襲）
 * マッピングに存在しないSQLSTATE（ネットワーク断、想定外のサーバーエラー等）は
 * 「型でモデル化されていない失敗」であり、design.mdの各Error型（例:
 * `SubmitOrderError`）はこれをモデル化していない。src/lib/result.tsの
 * ファイル冒頭コメントおよびuseDeviceIdentity.ts（provisionDevice）の前例と
 * 同じ方針で、Resultへ押し込めず例外として呼び出し元へ伝播させる
 * （Promiseをreject）。これにより、呼び出し側がエラー共用体に対して
 * 網羅的なswitchを書いても、未知のSQLSTATEをswitch文の既知のケースとして
 * 誤って扱うことは起こり得ない（switch自体に到達する前に例外が伝播するため）。
 */
export function mapPostgrestError<E>(
  error: PostgrestError,
  mapping: PostgrestErrorMapping<E>,
  rpcName: string,
): E {
  const build = mapping[error.code];
  if (build) {
    return build(error);
  }

  throw new Error(
    `${rpcName} RPC failed with an unmapped error (code=${error.code}): ${error.message}`,
  );
}
