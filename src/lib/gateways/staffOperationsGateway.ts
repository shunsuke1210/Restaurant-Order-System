import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../supabase/database.types";
import {
  mapPostgrestError,
  type PostgrestErrorMapping,
} from "../supabase/mapPostgrestError";
import { type Result, ok, err } from "../result";
import type {
  CallRequest,
  MenuItemOption,
  OrderItemStatus,
  OrderItemSummary,
} from "./customerOrderingGateway";

/**
 * StaffOperationsGateway — 厨房/レジ（device_role='kitchen'|'register'の
 * authenticated匿名デバイス）向け操作の型付きTypeScriptラッパー。design.md
 * 「StaffOperationsGateway」コンポーネントのService Interfaceで定義された
 * 11メソッド（startSession / closeSession / updatePartySize / addOrderItem /
 * removeOrderItem / updateOrderItemStatus / setSoldOut / resolveCallRequest /
 * listKitchenFeed / listRegisterFeed / listMenuItems）を、
 * 0004_rpc_staff_gateway.sql（4.1〜4.5、10メソッド分）および
 * 0011_list_menu_items.sql（タスク7.4で新規追加のlistMenuItems）が実装する
 * Postgres RPC（同名のsnake_case関数）へ委譲する。
 *
 * Requirements: 2.2, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4,
 *   5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7,
 *   6.8, 6.9, 6.10, 7.1, 7.3, 7.4
 *
 * ## 型の再利用について（customerOrderingGateway.tsとの関係）
 * design.mdのStaffOperationsGateway Service Interfaceブロックは、
 * `OrderItemSummary`・`OrderItemStatus`（updateOrderItemStatusの入出力）・
 * `CallRequest`（resolveCallRequestの戻り値）という3つの型を、
 * CustomerOrderingGateway側で既に定義済みの型と全く同じ名前・同じ形で
 * 再利用しており、StaffOperationsGatewayブロック内で再定義していない
 * （design.mdの構造そのものが「これらは単一の共有型である」ことを示す）。
 * そのため本ファイルはこれらをcustomerOrderingGateway.tsからimportし、
 * 重複定義しない。
 *
 * ## エラーモデルの方針（customerOrderingGateway.ts, タスク3.4の前例を踏襲）
 * 各メソッドが返す`Result<T, E>`の`E`は、design.mdのService Interfaceが
 * 明示的にモデル化した業務エラーのみを表す。対応するRPCが送出するSQLSTATEの
 * うち、そのメソッドのエラー型が定義していないもの（ネットワーク断・想定外の
 * サーバーエラー等）は`mapPostgrestError`（src/lib/supabase/
 * mapPostgrestError.ts）が例外として投げ、Resultには決して現れない。
 *
 * ## SQLSTATEマッピングの設計（共有コードの扱い）
 * 0004_rpc_staff_gateway.sqlは、複数メソッドで意味が完全に同じSQLSTATEを
 * 意図的に使い回している（0004冒頭の設計判断2・6・16等参照）。具体的には
 * `P0403`(FORBIDDEN)がほぼ全メソッドの、`P0409`(SESSION_NOT_ACTIVE)が
 * closeSession/updatePartySize/addOrderItemの、`P0444`
 * (ORDER_ITEM_NOT_FOUND)がremoveOrderItem/updateOrderItemStatusの
 * エラー共用体にそれぞれ登場する。これをメソッドごとに独立した
 * ロジックとして複製すると「同じSQLSTATE・同じ意味」の対応関係が
 * ファイル内に散らばってしまうため、共有コード用の値ビルダー関数
 * （`forbidden`/`sessionNotActive`/`orderItemNotFound`、いずれも
 * `PostgrestErrorMapping<E>`の値スロットが要求する`(error: PostgrestError)
 * => E`という関数シグネチャに対し、引数を無視する`() => {...}`として
 * 構造的に適合する）を1箇所だけ定義し、各メソッドの
 * `PostgrestErrorMapping<E>`定数から共通の参照として使い回す。
 * `P0423`(SESSION_ALREADY_ACTIVE、startSessionのみ)・`P0410`
 * (ITEM_SOLD_OUT、addOrderItemのみ)・`P0422`(INVALID_TRANSITION、
 * updateOrderItemStatusのみ)・`P0405`(ITEM_NOT_FOUND、setSoldOutのみ)・
 * `P0445`(CALL_REQUEST_NOT_FOUND、resolveCallRequestのみ)のようなメソッド
 * 固有のコードは、そのメソッドの`PostgrestErrorMapping<E>`定数内に
 * インラインで定義する（他で再利用されないため、共有ヘルパー化する
 * 必要がない）。
 *
 * ## DETAIL抽出パターン（customerOrderingGateway.tsのITEM_SOLD_OUTと同型）
 * - `startSession`のSESSION_ALREADY_ACTIVEは、0004が`using detail =
 *   v_existing_active_session_id::text`で載せる既存アクティブセッションidを
 *   `error.details`からそのまま`activeSessionId`として抽出する。
 * - `addOrderItem`のITEM_SOLD_OUTは、`error.details`からそのまま
 *   `menuItemId`を抽出する（customerOrderingGateway.tsのSubmitOrderErrorの
 *   ITEM_SOLD_OUTと全く同じパターン）。
 * - `updateOrderItemStatus`のINVALID_TRANSITIONは、0004が`using detail =
 *   jsonb_build_object('from', ..., 'to', ...)::text`という、単一スカラー値
 *   ではなくJSON文字列としてシリアライズされたDETAILを載せる（0004設計判断12
 *   参照）唯一のケースのため、`error.details`を`JSON.parse`してから
 *   `from`/`to`を取り出す。
 *
 * ## `never`エラー型について（listKitchenFeed / listRegisterFeed）
 * design.mdのService Interfaceはこの2メソッドのエラー型を`never`と宣言する。
 * `Result<T, never>`は構造的にエラー分岐（`{ ok: false; error: never }`）を
 * 構築できない型であるため、これら2メソッドが実際に送出しうるエラー
 * （0004設計判断25が明示する通り、assert_device_roleが送出する`P0403`
 * （FORBIDDEN）を含む、あらゆるPostgresエラー）は、Resultのエラー
 * メンバーとしてではなく常に例外としてthrowしなければならない
 * （`Result<T,never>`型が要求する唯一の実装可能な形）。他の8メソッドが
 * 「ドキュメント化された業務エラーはResultへ、それ以外は例外へ」という
 * 部分的な振り分けを行うのに対し、この2メソッドは「あらゆるエラーが
 * 無条件に例外へ」という特殊ケースになる。実装上は、空の
 * `PostgrestErrorMapping<never>`（`NO_ERROR_MAPPING`）を
 * `mapPostgrestError`に渡す。`mapPostgrestError`は空のマッピングに対しては
 * 常に「マッピングにないSQLSTATE」の分岐（例外throw）を通るため、
 * FORBIDDENを含むいかなるSQLSTATEも必然的にthrowされる
 * （customerOrderingGateway.tsが確立した「未知のSQLSTATEは例外として
 * 伝播する」という既存の規約を、意図的に「既知のSQLSTATEが存在しない
 * メソッド」に適用した形）。
 *
 * ## DIファクトリという設計判断（customerOrderingGateway.tsと同じ理由）
 * design.mdのStaffOperationsGatewayはState契約を持たない純粋なService
 * 契約であり、`createStaffOperationsGateway(client): StaffOperationsGateway`
 * というDIファクトリの形を採る。ユニットテスト
 * （staffOperationsGateway.test.ts）は`client.rpc`だけをモックした素の
 * オブジェクトを渡せばよく、実アプリ（厨房/レジ画面、タスク7.x/8.x）では
 * `createStaffOperationsGateway(createBrowserClient())`という1行の組み合わせで
 * 利用する想定。
 */

// ===========================================================================
// design.md「StaffOperationsGateway」Service Interfaceの型をそのまま反映する。
// ===========================================================================

export type MenuItemGenre = "ippin" | "food" | "drink";

export interface StartSessionInput {
  tableId: string;
  partySize: number;
}

export interface TableSession {
  id: string;
  tableId: string;
  status: "active" | "closed";
  startedAt: string;
  closedAt: string | null;
  partySize: number;
}

export type StartSessionError =
  | { code: "SESSION_ALREADY_ACTIVE"; activeSessionId: string }
  | { code: "TABLE_NOT_FOUND" }
  | { code: "FORBIDDEN" };

export interface CloseSessionInput {
  sessionId: string;
}

export type CloseSessionError =
  | { code: "SESSION_NOT_ACTIVE" }
  | { code: "FORBIDDEN" };

export interface UpdatePartySizeInput {
  sessionId: string;
  partySize: number;
}

export type UpdatePartySizeError =
  | { code: "SESSION_NOT_ACTIVE" }
  | { code: "FORBIDDEN" };

export interface AddOrderItemInput {
  sessionId: string;
  menuItemId: string;
  quantity: number;
  optionSelections: Readonly<Record<string, string | boolean | number>>;
}

export type AddOrderItemError =
  | { code: "SESSION_NOT_ACTIVE" }
  | { code: "ITEM_SOLD_OUT"; menuItemId: string }
  | { code: "FORBIDDEN" };

export interface RemoveOrderItemInput {
  orderItemId: string;
}

export type RemoveOrderItemError =
  | { code: "ORDER_ITEM_NOT_FOUND" }
  | { code: "FORBIDDEN" };

export interface UpdateOrderItemStatusInput {
  orderItemId: string;
  status: OrderItemStatus;
}

export type UpdateOrderItemStatusError =
  | { code: "ORDER_ITEM_NOT_FOUND" }
  | { code: "INVALID_TRANSITION"; from: OrderItemStatus; to: OrderItemStatus }
  | { code: "FORBIDDEN" };

export interface SetSoldOutInput {
  menuItemId: string;
  soldOut: boolean;
}

export interface MenuItem {
  id: string;
  storeId: string;
  name: string;
  price: number;
  soldOut: boolean;
}

export type MenuItemError = { code: "ITEM_NOT_FOUND" } | { code: "FORBIDDEN" };

export interface ResolveCallRequestInput {
  callRequestId: string;
}

// 設計判断（タスク4.6）: design.mdのresolveCallRequestは、タスク4.4のレビューで
// 修正済みの専用エラー型を持つ（0004_rpc_staff_gateway.sqlの設計判断17参照。
// 修正前は3.3のCallRequestError（SESSION_NOT_ACTIVE/CALL_ALREADY_OPEN）を
// 誤って再利用していたが、resolveCallRequestの入力にはsessionIdが無く、
// CALL_ALREADY_OPENは新規作成専用の重複防止エラーであるため意味が合わない
// と判明し、design.mdはこの専用のResolveCallRequestError型へ修正された）。
// 本ファイルは修正後の現行design.mdの型をそのまま実装する。
export type ResolveCallRequestError =
  | { code: "FORBIDDEN" }
  | { code: "CALL_REQUEST_NOT_FOUND" };

export interface ListFeedInput {
  storeId: string;
}

export interface TableBillingSummary {
  tableId: string;
  tableLabel: string;
  activeSession: { id: string; startedAt: string; partySize: number } | null;
  // タスク8.3で拡張（0012_list_register_feed_item_id.sql）: 元々は
  // {menuItemId, name, quantity, unitPrice}の4フィールドのみで、
  // 注文明細自体の識別子を持たなかった（8.2レビューで判明、tasks.md
  // Implementation Notes参照）。removeOrderItem({orderItemId})の対象を
  // 一意に識別するため`id`（order_items.idそのもの）を追加した。あわせて
  // mock-preview.htmlとの既知の表示乖離（オプション概要・ステータスを
  // 表示できなかった）を解消するため`optionsSummary`/`status`も追加した
  // （0012冒頭コメント参照。`status`は8.3のUIでは表示せず、8.4向けに
  // 値のみ先取りする）。
  // タスク8.4で拡張（0014_list_register_feed_item_genre.sql）: 0012が
  // 明示的に本タスクへ委ねていた判断（statusのジャンルに応じた日本語表示・
  // 進めるボタンの次ステータス判定にはgenreが必須）を実行し、`genre`を
  // 追加した（list_kitchen_feedと同じmenu_itemsへのjoinで取得）。
  items: ReadonlyArray<{
    id: string;
    menuItemId: string;
    name: string;
    quantity: number;
    unitPrice: number;
    optionsSummary: string | null;
    status: OrderItemStatus;
    genre: MenuItemGenre;
  }>;
  total: number;
  hasOpenCallRequest: boolean;
  // タスク8.6で追加（0015_list_register_feed_open_call_request_id.sql）。
  // resolveCallRequest({callRequestId})の呼び出しには実際のcall_requests.id
  // が必要だが、hasOpenCallRequestは真偽値のみでその識別子を公開しない
  // （8.2レビュー〜8.5と同型のギャップ）。要件2.3が保証する「セッションあたり
  // openな呼び出しは高々1件」という不変条件（create_call_requestの部分
  // ユニークインデックス）により、対象があれば単一のcall_requests.id、
  // 無ければnullを返す。hasOpenCallRequestは後方互換のため変更せず維持する
  // （8.1のFloorMap.tsxタイルの呼出バッジが引き続き参照する）。
  openCallRequestId: string | null;
}

// タスク7.4で新規追加（design.mdのStaffOperationsGateway Responsibilities &
// Constraints「listMenuItems」参照。CONCERN: 0011_list_menu_items.sql冒頭
// コメントに詳細な判断理由あり）。setSoldOutの戻り値であるMenuItem型
// （storeIdを含む）とは異なり、一覧表示に必要な最小限のキーのみを持つ。
//
// タスク8.3で拡張（0013_list_menu_items_register_options.sql）:
// `imageUrl`・`options`を追加した。レジの品目追加フロー
// （src/app/register/TableDetailPanel.tsx）が客側の`OptionSelectionPanel`
// （src/app/order/[tableId]/OptionSelectionPanel.tsx、`{item: MenuItemView,
// onCancel, onConfirm}`という純粋なプレゼンテーションpropsのみを取る
// ゲートウェイ非依存コンポーネント）をそのまま再利用する設計判断のため、
// `MenuItemListing`を`MenuItemView`（id/name/price/soldOut/imageUrl/genre/
// options）と構造的に一致させる必要がある（0013冒頭コメント参照）。
// `options`の型`MenuItemOption`はcustomerOrderingGateway.tsからimportし
// 重複定義しない（本ファイル冒頭コメント「型の再利用について」の既存方針を
// 踏襲）。厨房の売り切れボード（SoldOutBoard.tsx、7.4）はこれら2フィールドを
// 一切参照しない。
export interface MenuItemListing {
  id: string;
  name: string;
  price: number;
  soldOut: boolean;
  genre: MenuItemGenre;
  imageUrl: string | null;
  options: ReadonlyArray<MenuItemOption>;
}

export interface StaffOperationsGateway {
  startSession(
    input: StartSessionInput,
  ): Promise<Result<TableSession, StartSessionError>>;
  closeSession(
    input: CloseSessionInput,
  ): Promise<Result<TableSession, CloseSessionError>>;
  updatePartySize(
    input: UpdatePartySizeInput,
  ): Promise<Result<TableSession, UpdatePartySizeError>>;
  addOrderItem(
    input: AddOrderItemInput,
  ): Promise<Result<OrderItemSummary, AddOrderItemError>>;
  removeOrderItem(
    input: RemoveOrderItemInput,
  ): Promise<Result<{ orderItemId: string }, RemoveOrderItemError>>;
  updateOrderItemStatus(
    input: UpdateOrderItemStatusInput,
  ): Promise<Result<OrderItemSummary, UpdateOrderItemStatusError>>;
  setSoldOut(input: SetSoldOutInput): Promise<Result<MenuItem, MenuItemError>>;
  resolveCallRequest(
    input: ResolveCallRequestInput,
  ): Promise<Result<CallRequest, ResolveCallRequestError>>;
  listKitchenFeed(
    input: ListFeedInput,
  ): Promise<
    Result<
      ReadonlyArray<
        OrderItemSummary & {
          tableId: string;
          tableLabel: string;
          genre: MenuItemGenre;
        }
      >,
      never
    >
  >;
  listRegisterFeed(
    input: ListFeedInput,
  ): Promise<Result<ReadonlyArray<TableBillingSummary>, never>>;
  // タスク7.4で新規追加。design.mdの`listMenuItems`（Service Interface内、
  // ListFeedInputを再利用）に対応する。
  listMenuItems(
    input: ListFeedInput,
  ): Promise<Result<ReadonlyArray<MenuItemListing>, never>>;
}

// ===========================================================================
// SQLSTATEマッピング（0004_rpc_staff_gateway.sqlが実際に送出するカスタム
// SQLSTATE。各コードの意味は0004ファイル冒頭の設計判断コメントを参照）。
// ===========================================================================

const FORBIDDEN_SQLSTATE = "P0403";
const TABLE_NOT_FOUND_SQLSTATE = "P0404";
const ITEM_NOT_FOUND_SQLSTATE = "P0405";
const SESSION_NOT_ACTIVE_SQLSTATE = "P0409";
const ITEM_SOLD_OUT_SQLSTATE = "P0410";
const INVALID_TRANSITION_SQLSTATE = "P0422";
const SESSION_ALREADY_ACTIVE_SQLSTATE = "P0423";
const ORDER_ITEM_NOT_FOUND_SQLSTATE = "P0444";
const CALL_REQUEST_NOT_FOUND_SQLSTATE = "P0445";

// 複数メソッドのエラー共用体にまたがって登場する、意味が完全に同じSQLSTATEの
// 値ビルダー。`PostgrestErrorMapping<E>`の値スロットは`(error: PostgrestError)
// => E`という関数型を要求するが、引数を使わない関数はその部分型として
// 構造的に適合するため、各メソッドの追加ペイロードを持たないメンバーに
// そのまま割り当てられる。
function forbidden(): { code: "FORBIDDEN" } {
  return { code: "FORBIDDEN" };
}

function sessionNotActive(): { code: "SESSION_NOT_ACTIVE" } {
  return { code: "SESSION_NOT_ACTIVE" };
}

function orderItemNotFound(): { code: "ORDER_ITEM_NOT_FOUND" } {
  return { code: "ORDER_ITEM_NOT_FOUND" };
}

const START_SESSION_ERROR_MAPPING: PostgrestErrorMapping<StartSessionError> =
  {
    [FORBIDDEN_SQLSTATE]: forbidden,
    [TABLE_NOT_FOUND_SQLSTATE]: () => ({ code: "TABLE_NOT_FOUND" }),
    [SESSION_ALREADY_ACTIVE_SQLSTATE]: (error) => ({
      code: "SESSION_ALREADY_ACTIVE",
      activeSessionId: error.details,
    }),
  };

const CLOSE_SESSION_ERROR_MAPPING: PostgrestErrorMapping<CloseSessionError> =
  {
    [FORBIDDEN_SQLSTATE]: forbidden,
    [SESSION_NOT_ACTIVE_SQLSTATE]: sessionNotActive,
  };

const UPDATE_PARTY_SIZE_ERROR_MAPPING: PostgrestErrorMapping<UpdatePartySizeError> =
  {
    [FORBIDDEN_SQLSTATE]: forbidden,
    [SESSION_NOT_ACTIVE_SQLSTATE]: sessionNotActive,
  };

const ADD_ORDER_ITEM_ERROR_MAPPING: PostgrestErrorMapping<AddOrderItemError> =
  {
    [FORBIDDEN_SQLSTATE]: forbidden,
    [SESSION_NOT_ACTIVE_SQLSTATE]: sessionNotActive,
    [ITEM_SOLD_OUT_SQLSTATE]: (error) => ({
      code: "ITEM_SOLD_OUT",
      menuItemId: error.details,
    }),
  };

const REMOVE_ORDER_ITEM_ERROR_MAPPING: PostgrestErrorMapping<RemoveOrderItemError> =
  {
    [FORBIDDEN_SQLSTATE]: forbidden,
    [ORDER_ITEM_NOT_FOUND_SQLSTATE]: orderItemNotFound,
  };

// 設計判断（タスク4.6）: INVALID_TRANSITIONのDETAILは0004設計判断12の通り
// `jsonb_build_object('from', ..., 'to', ...)::text`というJSON文字列で
// あり、他のDETAILパターン（単一スカラー値）とは異なりJSON.parseが必要。
const UPDATE_ORDER_ITEM_STATUS_ERROR_MAPPING: PostgrestErrorMapping<UpdateOrderItemStatusError> =
  {
    [FORBIDDEN_SQLSTATE]: forbidden,
    [ORDER_ITEM_NOT_FOUND_SQLSTATE]: orderItemNotFound,
    [INVALID_TRANSITION_SQLSTATE]: (error) => {
      const detail = JSON.parse(error.details) as {
        from: OrderItemStatus;
        to: OrderItemStatus;
      };
      return { code: "INVALID_TRANSITION", from: detail.from, to: detail.to };
    },
  };

const MENU_ITEM_ERROR_MAPPING: PostgrestErrorMapping<MenuItemError> = {
  [FORBIDDEN_SQLSTATE]: forbidden,
  [ITEM_NOT_FOUND_SQLSTATE]: () => ({ code: "ITEM_NOT_FOUND" }),
};

const RESOLVE_CALL_REQUEST_ERROR_MAPPING: PostgrestErrorMapping<ResolveCallRequestError> =
  {
    [FORBIDDEN_SQLSTATE]: forbidden,
    [CALL_REQUEST_NOT_FOUND_SQLSTATE]: () => ({
      code: "CALL_REQUEST_NOT_FOUND",
    }),
  };

// listKitchenFeed / listRegisterFeed用。design.mdの`never`エラー型に対応する
// 空のマッピング（上のファイル冒頭コメント「`never`エラー型について」参照）。
// `mapPostgrestError`は空のマッピングに対して常に「マッピングにない
// SQLSTATE」の分岐を通るため、FORBIDDENを含むあらゆるエラーが必然的に
// 例外としてthrowされる。
const NO_ERROR_MAPPING: PostgrestErrorMapping<never> = {};

// ===========================================================================
// RPCのjsonb応答 → design.md型への整形。customerOrderingGateway.tsの設計判断
// （`data`をそのまま型アサーションして返さず、フィールドを1つずつ明示的に
// 取り出す）を踏襲する。
// ===========================================================================

function toTableSession(data: Json): TableSession {
  const raw = data as unknown as {
    id: string;
    tableId: string;
    status: "active" | "closed";
    startedAt: string;
    closedAt: string | null;
    partySize: number;
  };

  return {
    id: raw.id,
    tableId: raw.tableId,
    status: raw.status,
    startedAt: raw.startedAt,
    closedAt: raw.closedAt,
    partySize: raw.partySize,
  };
}

function toOrderItemSummary(data: Json): OrderItemSummary {
  const raw = data as unknown as {
    id: string;
    menuItemId: string;
    name: string;
    unitPrice: number;
    quantity: number;
    optionsSummary: string | null;
    status: OrderItemStatus;
    statusUpdatedAt: string;
  };

  return {
    id: raw.id,
    menuItemId: raw.menuItemId,
    name: raw.name,
    unitPrice: raw.unitPrice,
    quantity: raw.quantity,
    optionsSummary: raw.optionsSummary,
    status: raw.status,
    statusUpdatedAt: raw.statusUpdatedAt,
  };
}

function toRemoveOrderItemResult(data: Json): { orderItemId: string } {
  const raw = data as unknown as { orderItemId: string };
  return { orderItemId: raw.orderItemId };
}

function toMenuItem(data: Json): MenuItem {
  const raw = data as unknown as {
    id: string;
    storeId: string;
    name: string;
    price: number;
    soldOut: boolean;
  };

  return {
    id: raw.id,
    storeId: raw.storeId,
    name: raw.name,
    price: raw.price,
    soldOut: raw.soldOut,
  };
}

function toCallRequest(data: Json): CallRequest {
  const raw = data as unknown as {
    id: string;
    sessionId: string;
    status: "open" | "resolved";
    createdAt: string;
  };

  return {
    id: raw.id,
    sessionId: raw.sessionId,
    status: raw.status,
    createdAt: raw.createdAt,
  };
}

function toKitchenFeed(
  data: Json,
): ReadonlyArray<
  OrderItemSummary & {
    tableId: string;
    tableLabel: string;
    genre: MenuItemGenre;
  }
> {
  const raw = data as unknown as ReadonlyArray<{
    id: string;
    menuItemId: string;
    name: string;
    unitPrice: number;
    quantity: number;
    optionsSummary: string | null;
    status: OrderItemStatus;
    statusUpdatedAt: string;
    tableId: string;
    tableLabel: string;
    genre: MenuItemGenre;
  }>;

  return raw.map((item) => ({
    id: item.id,
    menuItemId: item.menuItemId,
    name: item.name,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    optionsSummary: item.optionsSummary,
    status: item.status,
    statusUpdatedAt: item.statusUpdatedAt,
    tableId: item.tableId,
    tableLabel: item.tableLabel,
    genre: item.genre,
  }));
}

function toMenuItemListing(data: Json): ReadonlyArray<MenuItemListing> {
  const raw = data as unknown as ReadonlyArray<{
    id: string;
    name: string;
    price: number;
    soldOut: boolean;
    genre: MenuItemGenre;
    imageUrl: string | null;
    options: ReadonlyArray<MenuItemOption>;
  }>;

  return raw.map((item) => ({
    id: item.id,
    name: item.name,
    price: item.price,
    soldOut: item.soldOut,
    genre: item.genre,
    imageUrl: item.imageUrl,
    options: item.options,
  }));
}

function toRegisterFeed(data: Json): ReadonlyArray<TableBillingSummary> {
  const raw = data as unknown as ReadonlyArray<{
    tableId: string;
    tableLabel: string;
    activeSession: {
      id: string;
      startedAt: string;
      partySize: number;
    } | null;
    items: ReadonlyArray<{
      id: string;
      menuItemId: string;
      name: string;
      quantity: number;
      unitPrice: number;
      optionsSummary: string | null;
      status: OrderItemStatus;
      genre: MenuItemGenre;
    }>;
    total: number;
    hasOpenCallRequest: boolean;
    // タスク8.6で追加。
    openCallRequestId: string | null;
  }>;

  return raw.map((table) => ({
    tableId: table.tableId,
    tableLabel: table.tableLabel,
    activeSession: table.activeSession
      ? {
          id: table.activeSession.id,
          startedAt: table.activeSession.startedAt,
          partySize: table.activeSession.partySize,
        }
      : null,
    items: table.items.map((item) => ({
      id: item.id,
      menuItemId: item.menuItemId,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      optionsSummary: item.optionsSummary,
      status: item.status,
      genre: item.genre,
    })),
    total: table.total,
    hasOpenCallRequest: table.hasOpenCallRequest,
    openCallRequestId: table.openCallRequestId,
  }));
}

/**
 * design.mdのStaffOperationsGateway Service Interfaceを実装するファクトリ。
 * `client`は呼び出し元（実アプリでは`device_role`クレーム付きのセッションを
 * 持つ`createBrowserClient()`、テストでは`client.rpc`だけをモックした
 * フェイク）が注入する。
 */
export function createStaffOperationsGateway(
  client: SupabaseClient<Database>,
): StaffOperationsGateway {
  return {
    async startSession(input) {
      const { data, error } = await client.rpc("start_session", {
        p_table_id: input.tableId,
        p_party_size: input.partySize,
      });

      if (error) {
        return err(
          mapPostgrestError(error, START_SESSION_ERROR_MAPPING, "start_session"),
        );
      }

      return ok(toTableSession(data));
    },

    async closeSession(input) {
      const { data, error } = await client.rpc("close_session", {
        p_session_id: input.sessionId,
      });

      if (error) {
        return err(
          mapPostgrestError(error, CLOSE_SESSION_ERROR_MAPPING, "close_session"),
        );
      }

      return ok(toTableSession(data));
    },

    async updatePartySize(input) {
      const { data, error } = await client.rpc("update_party_size", {
        p_session_id: input.sessionId,
        p_party_size: input.partySize,
      });

      if (error) {
        return err(
          mapPostgrestError(
            error,
            UPDATE_PARTY_SIZE_ERROR_MAPPING,
            "update_party_size",
          ),
        );
      }

      return ok(toTableSession(data));
    },

    async addOrderItem(input) {
      const { data, error } = await client.rpc("add_order_item", {
        p_session_id: input.sessionId,
        p_menu_item_id: input.menuItemId,
        p_quantity: input.quantity,
        p_option_selections: input.optionSelections as unknown as Json,
      });

      if (error) {
        return err(
          mapPostgrestError(error, ADD_ORDER_ITEM_ERROR_MAPPING, "add_order_item"),
        );
      }

      return ok(toOrderItemSummary(data));
    },

    async removeOrderItem(input) {
      const { data, error } = await client.rpc("remove_order_item", {
        p_order_item_id: input.orderItemId,
      });

      if (error) {
        return err(
          mapPostgrestError(
            error,
            REMOVE_ORDER_ITEM_ERROR_MAPPING,
            "remove_order_item",
          ),
        );
      }

      return ok(toRemoveOrderItemResult(data));
    },

    async updateOrderItemStatus(input) {
      const { data, error } = await client.rpc("update_order_item_status", {
        p_order_item_id: input.orderItemId,
        p_status: input.status,
      });

      if (error) {
        return err(
          mapPostgrestError(
            error,
            UPDATE_ORDER_ITEM_STATUS_ERROR_MAPPING,
            "update_order_item_status",
          ),
        );
      }

      return ok(toOrderItemSummary(data));
    },

    async setSoldOut(input) {
      const { data, error } = await client.rpc("set_sold_out", {
        p_menu_item_id: input.menuItemId,
        p_sold_out: input.soldOut,
      });

      if (error) {
        return err(
          mapPostgrestError(error, MENU_ITEM_ERROR_MAPPING, "set_sold_out"),
        );
      }

      return ok(toMenuItem(data));
    },

    async resolveCallRequest(input) {
      const { data, error } = await client.rpc("resolve_call_request", {
        p_call_request_id: input.callRequestId,
      });

      if (error) {
        return err(
          mapPostgrestError(
            error,
            RESOLVE_CALL_REQUEST_ERROR_MAPPING,
            "resolve_call_request",
          ),
        );
      }

      return ok(toCallRequest(data));
    },

    async listKitchenFeed(input) {
      const { data, error } = await client.rpc("list_kitchen_feed", {
        p_store_id: input.storeId,
      });

      if (error) {
        // design.mdの`never`エラー型（ファイル冒頭コメント参照）: 空の
        // マッピングに対しmapPostgrestErrorは常に例外を投げる。
        throw mapPostgrestError(error, NO_ERROR_MAPPING, "list_kitchen_feed");
      }

      return ok(toKitchenFeed(data));
    },

    async listRegisterFeed(input) {
      const { data, error } = await client.rpc("list_register_feed", {
        p_store_id: input.storeId,
      });

      if (error) {
        throw mapPostgrestError(
          error,
          NO_ERROR_MAPPING,
          "list_register_feed",
        );
      }

      return ok(toRegisterFeed(data));
    },

    async listMenuItems(input) {
      const { data, error } = await client.rpc("list_menu_items", {
        p_store_id: input.storeId,
      });

      if (error) {
        // design.mdの`never`エラー型（listKitchenFeed/listRegisterFeedと
        // 同じ理由。ファイル冒頭コメント参照）: 空のマッピングに対し
        // mapPostgrestErrorは常に例外を投げる。
        throw mapPostgrestError(error, NO_ERROR_MAPPING, "list_menu_items");
      }

      return ok(toMenuItemListing(data));
    },
  };
}
