/**
 * 判別可能なエラーを表現するための共有Result型。
 *
 * design.md（Error Handling / Error Strategy）:
 * 「すべての書き込み系RPCはResult<T, E>形式で判別可能なエラーを返し、
 * UI側はエラーコードごとに具体的な案内を表示する」という方針を、
 * TypeScript側で具体化した最初の場所（タスク2.3: DeviceIdentityProvider）。
 * 後続の CustomerOrderingGateway / StaffOperationsGateway（タスク3.x/4.x）も
 * 同じ型を再利用する想定のため、feature固有のディレクトリではなく
 * `src/lib/result.ts`という共有の場所に置く。
 *
 * 対象範囲: ここでいう「エラー」は、design.mdの各Service Interfaceが
 * 明示的にモデル化した業務エラー（例: INVALID_SETUP_CODE）のみを指す。
 * ネットワーク断や想定外のサーバーエラーのような、型で表現されていない
 * 例外的な失敗は、Result側に押し込めず呼び出し元へ例外として伝播させる
 * （Promiseをrejectする）方針とする。Result<T, E>は「起こりうることが
 * わかっている分岐」を表現するためのものであり、あらゆる例外の受け皿では
 * ない（Rustの`Result`がpanicの代替ではないのと同様の考え方）。
 */
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** 成功したResultを構築するヘルパー。 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** 失敗したResultを構築するヘルパー。 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
