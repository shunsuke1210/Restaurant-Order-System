import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../supabase/database.types";
import { mapPostgrestError, type PostgrestErrorMapping } from "../supabase/mapPostgrestError";
import { type Result, ok, err } from "../result";

/**
 * CustomerOrderingGateway — 客（匿名・無ログイン）向け操作の型付きTypeScript
 * ラッパー。design.md「CustomerOrderingGateway」コンポーネントの
 * Service Interfaceで定義された3メソッド（getOrderingContext / submitOrder /
 * createCallRequest）を、0003_rpc_customer_gateway.sqlが実装するPostgres RPC
 * （get_ordering_context / submit_order / create_call_request、いずれも
 * タスク3.1/3.2/3.3で実装済み・本タスクのスコープ外＝読み取り専用の参照先）へ
 * 委譲する。
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.12,
 *   2.1, 2.2, 2.3, 7.2
 *
 * ## エラーモデルの方針（src/lib/result.tsの前例を踏襲）
 * 各メソッドが返す`Result<T, E>`の`E`は、design.mdのService Interfaceが
 * 明示的にモデル化した業務エラー（例: `TABLE_NOT_FOUND`）のみを表す。
 * 対応するRPCが送出するSQLSTATEのうち、そのメソッドのエラー型が
 * 定義していないもの（ネットワーク断・想定外のサーバーエラー等）は
 * `mapPostgrestError`（src/lib/supabase/mapPostgrestError.ts）が例外として
 * 投げ、Resultには決して現れない。呼び出し側がエラー共用体に対して
 * 網羅的なswitchを書いても、未知のエラーを既知のケースとして誤って
 * 扱うことはできない（customerOrderingGateway.test.tsの
 * 「網羅的なswitch」テストと、「想定外のエラーは例外として伝播する」
 * テストの両方で実証する）。
 *
 * ## RATE_LIMITEDについて（SubmitOrderError）
 * design.mdのSubmitOrderError型は、タスク3.2のレビューで追加された
 * `{ code: "RATE_LIMITED" }`を含む。セッション単位のレート制限自体は
 * タスク3.5（本タスクの直後に意図的に後続配置）でsubmit_order関数に
 * 実装される予定であり、現時点のRPCはこのSQLSTATEを一切送出しない
 * （0003_rpc_customer_gateway.sqlは変更していない。本ファイル下部の
 * SUBMIT_ORDER_ERROR_MAPPINGにも対応するエントリはまだ存在しない）。
 * それでも型としては現時点からRATE_LIMITEDをユニオンに含めておくことで、
 * 3.5がSQLSTATEを1つ追加するだけでこのラッパーの型定義を変更せずに
 * 済むようにする（design.mdの型定義をそのまま反映するという本タスクの
 * 方針）。呼び出し側の網羅的なswitchは、3.5が着地するまでは到達しない
 * ケースとしてRATE_LIMITEDを扱うことになるが、これは型として妥当であり
 * エラーではない。
 *
 * ## DIファクトリという設計判断（useDeviceIdentity.tsとの違い）
 * useDeviceIdentity.ts（タスク2.3）は、DeviceIdentityProviderの
 * Service Interfaceが同期的な`getCurrentDevice()`という内部状態（State
 * 契約）を持つため、モジュールスコープの単一クライアント
 * （`createBrowserClient()`を1度だけ呼びキャッシュする）という設計を
 * 採用していた。一方design.mdのCustomerOrderingGatewayはState契約を
 * 持たない純粋なService契約であり、本タスクの指示自体が
 * `createCustomerOrderingGateway(client): CustomerOrderingGateway`という
 * 依存性注入（DI）ファクトリの形を明示している。DI方式にすることで
 * ユニットテスト（customerOrderingGateway.test.ts）は`client.rpc`だけを
 * モックした素のオブジェクトを渡せばよく、モジュールのモック
 * （`vi.mock("../supabase/client", ...)`）が不要になる。実アプリ側
 * （客向け注文画面、タスク6.x）では`createCustomerOrderingGateway(
 * createBrowserClient())`という1行の組み合わせで利用する想定。
 */

// ===========================================================================
// design.md「CustomerOrderingGateway」Service Interfaceの型をそのまま反映する。
// ===========================================================================

export interface GetOrderingContextInput {
  tableId: string;
}

export interface OrderingContext {
  table: { id: string; label: string };
  activeSession: { id: string } | null;
  confirmedTotal: number;
  menu: ReadonlyArray<MenuItemView>;
}

export interface MenuItemView {
  id: string;
  name: string;
  price: number;
  soldOut: boolean;
  imageUrl: string | null;
  options: ReadonlyArray<MenuItemOption>;
}

export type MenuItemOption =
  | {
      id: string;
      type: "choice";
      label: string;
      choices: ReadonlyArray<string>;
      default: string;
    }
  | { id: string; type: "toggle"; label: string; default: boolean }
  | {
      id: string;
      type: "counter";
      label: string;
      min: number;
      max: number;
      default: number;
    };

export type OrderingContextError = { code: "TABLE_NOT_FOUND" };

export interface SubmitOrderInput {
  sessionId: string;
  idempotencyKey: string;
  items: ReadonlyArray<{
    menuItemId: string;
    quantity: number;
    optionSelections: Readonly<Record<string, string | boolean | number>>;
    note: string | null;
  }>;
}

export interface SubmitOrderResult {
  order: OrderWithItems;
  deduplicated: boolean;
}

export interface OrderWithItems {
  id: string;
  createdAt: string;
  items: ReadonlyArray<OrderItemSummary>;
}

export interface OrderItemSummary {
  id: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  optionsSummary: string | null;
  status: OrderItemStatus;
  statusUpdatedAt: string;
}

export type OrderItemStatus = "received" | "in_progress" | "done";

export type SubmitOrderError =
  | { code: "SESSION_NOT_ACTIVE" }
  | { code: "ITEM_SOLD_OUT"; menuItemId: string }
  | { code: "EMPTY_ORDER" }
  | { code: "RATE_LIMITED" };

export interface CreateCallRequestInput {
  sessionId: string;
}

export interface CallRequest {
  id: string;
  sessionId: string;
  status: "open" | "resolved";
  createdAt: string;
}

export type CallRequestError =
  | { code: "SESSION_NOT_ACTIVE" }
  | { code: "CALL_ALREADY_OPEN" };

export interface CustomerOrderingGateway {
  getOrderingContext(
    input: GetOrderingContextInput,
  ): Promise<Result<OrderingContext, OrderingContextError>>;
  submitOrder(
    input: SubmitOrderInput,
  ): Promise<Result<SubmitOrderResult, SubmitOrderError>>;
  createCallRequest(
    input: CreateCallRequestInput,
  ): Promise<Result<CallRequest, CallRequestError>>;
}

// ===========================================================================
// SQLSTATEマッピング（0003_rpc_customer_gateway.sqlが実際に送出するカスタム
// SQLSTATE。各コードの意味は0003ファイル冒頭の設計判断コメントを参照）。
// ===========================================================================

const TABLE_NOT_FOUND_SQLSTATE = "P0404";
const SESSION_NOT_ACTIVE_SQLSTATE = "P0409";
const EMPTY_ORDER_SQLSTATE = "P0400";
const ITEM_SOLD_OUT_SQLSTATE = "P0410";
const CALL_ALREADY_OPEN_SQLSTATE = "P0412";

// 設計判断（タスク3.4）: 各マッピング定数には明示的に
// `PostgrestErrorMapping<E>`型を注釈する。こうすることでオブジェクト
// リテラル内の各関数（`(error) => ...`）がその位置の期待型から
// `error: PostgrestError`というコンテキスト型を得られる（TypeScriptの
// contextual typingは、リテラルが代入される変数の型注釈がある場合にのみ
// 関数式の引数型を逆算するため、注釈を省略すると`error`が暗黙の`any`に
// なりtsc --noEmitが失敗する）。
const GET_ORDERING_CONTEXT_ERROR_MAPPING: PostgrestErrorMapping<OrderingContextError> =
  {
    [TABLE_NOT_FOUND_SQLSTATE]: () => ({ code: "TABLE_NOT_FOUND" }),
  };

// 設計判断（タスク3.4）: ITEM_SOLD_OUTはerror.details（0003が
// `using detail = v_menu_item_id::text`で載せるmenu_item_id）から
// menuItemIdを抽出する。design.mdのSubmitOrderError型がこのフィールドを
// 要求しているため。RATE_LIMITEDに対応するSQLSTATEはまだ存在しない
// （ファイル冒頭コメント参照。タスク3.5でSQLSTATEが割り当てられ次第、
// ここへエントリを追加する想定）。
const SUBMIT_ORDER_ERROR_MAPPING: PostgrestErrorMapping<SubmitOrderError> = {
  [SESSION_NOT_ACTIVE_SQLSTATE]: () => ({ code: "SESSION_NOT_ACTIVE" }),
  [EMPTY_ORDER_SQLSTATE]: () => ({ code: "EMPTY_ORDER" }),
  [ITEM_SOLD_OUT_SQLSTATE]: (error) => ({
    code: "ITEM_SOLD_OUT",
    menuItemId: error.details,
  }),
};

// 設計判断（タスク3.4）: design.mdのCallRequestError型は
// `{ code: "CALL_ALREADY_OPEN" }`という追加ペイロードのないバリアントを
// 定義しており、SubmitOrderErrorのITEM_SOLD_OUTのような専用フィールドは
// 持たない。0003は既存の呼び出しのidをerror.detailsに載せているが
// （create_call_request関数コメント参照）、design.mdの型契約に忠実に
// 従い、ここでは意図的に抽出・公開しない（CONCERNS: 将来の呼び出し
// ボタンUI（6.3）が「誰の呼び出しが未対応か」を示したくなった場合、
// design.mdのCallRequestError型自体の改訂が必要になる）。
const CREATE_CALL_REQUEST_ERROR_MAPPING: PostgrestErrorMapping<CallRequestError> =
  {
    [SESSION_NOT_ACTIVE_SQLSTATE]: () => ({ code: "SESSION_NOT_ACTIVE" }),
    [CALL_ALREADY_OPEN_SQLSTATE]: () => ({ code: "CALL_ALREADY_OPEN" }),
  };

// ===========================================================================
// RPCのjsonb応答 → design.md型への整形。
// 0003_rpc_customer_gateway.sqlの設計判断1「jsonbオブジェクトのキーを
// OrderingContext/MenuItemViewのフィールド名と完全に一致するキャメルケースで
// 構築する」を前提に、フィールドを1つずつ明示的に取り出す（`data`をそのまま
// `as`で型アサーションして返さない）。これにより、
// - activeSessionがnull（undefinedではない）であることを実際のRPC応答の形で
//   検証できる（getOrderingContext.integration.test.tsが
//   `expect(data.activeSession).toBeNull()`で確認済みの形をそのまま反映）、
// - 将来RPC側の応答キーが変わった場合、このマッピング関数の型エラーとして
//   ずれを検出しやすい、という2つの利点がある。
// ===========================================================================

function toOrderingContext(data: Json): OrderingContext {
  const raw = data as unknown as {
    table: { id: string; label: string };
    activeSession: { id: string } | null;
    confirmedTotal: number;
    menu: ReadonlyArray<{
      id: string;
      name: string;
      price: number;
      soldOut: boolean;
      imageUrl: string | null;
      options: ReadonlyArray<MenuItemOption>;
    }>;
  };

  return {
    table: { id: raw.table.id, label: raw.table.label },
    activeSession: raw.activeSession ? { id: raw.activeSession.id } : null,
    confirmedTotal: raw.confirmedTotal,
    menu: raw.menu.map((item) => ({
      id: item.id,
      name: item.name,
      price: item.price,
      soldOut: item.soldOut,
      imageUrl: item.imageUrl,
      options: item.options,
    })),
  };
}

function toOrderItemSummary(item: {
  id: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  optionsSummary: string | null;
  status: OrderItemStatus;
  statusUpdatedAt: string;
}): OrderItemSummary {
  return {
    id: item.id,
    menuItemId: item.menuItemId,
    name: item.name,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    optionsSummary: item.optionsSummary,
    status: item.status,
    statusUpdatedAt: item.statusUpdatedAt,
  };
}

function toSubmitOrderResult(data: Json): SubmitOrderResult {
  const raw = data as unknown as {
    order: {
      id: string;
      createdAt: string;
      items: ReadonlyArray<{
        id: string;
        menuItemId: string;
        name: string;
        unitPrice: number;
        quantity: number;
        optionsSummary: string | null;
        status: OrderItemStatus;
        statusUpdatedAt: string;
      }>;
    };
    deduplicated: boolean;
  };

  return {
    deduplicated: raw.deduplicated,
    order: {
      id: raw.order.id,
      createdAt: raw.order.createdAt,
      items: raw.order.items.map(toOrderItemSummary),
    },
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

/**
 * submit_orderのp_items引数を組み立てる。0003_rpc_customer_gateway.sqlは
 * 各要素を`menuItemId`/`quantity`/`optionSelections`/`note`という
 * キャメルケースのキーで読み取る（submit_order関数本体のjsonb取り出し
 * `v_item ->> 'menuItemId'`等を参照）。TypeScript側のSubmitOrderInputも
 * 同じキー名のため、フィールド名の変換は不要（camelCase→camelCaseの
 * まま渡す。他の2メソッドのp_table_id/p_session_idのような
 * camelCase→snake_caseの変換が必要なのはトップレベルのRPCパラメータ名のみ）。
 * `Database`生成型のsubmit_order.Args.p_itemsはJson型で表現されている
 * （0003の設計判断1: RPCの戻り値・引数はjsonb1本化）ため、具体的な
 * フィールド名を持つオブジェクト配列はここで明示的にJsonへキャストする
 * （Jsonのインデックスシグネチャに対し、名前付きプロパティのみを持つ
 * オブジェクト型は構造的に十分縮小できないため、TypeScriptは暗黙の
 * 代入を許可しない。値そのものはJSON互換であることが自明なため、
 * 実行時の変換は行わずキャストのみで済ませる）。
 */
function toSubmitOrderItemsJson(
  items: SubmitOrderInput["items"],
): Json {
  return items.map((item) => ({
    menuItemId: item.menuItemId,
    quantity: item.quantity,
    optionSelections: item.optionSelections,
    note: item.note,
  })) as unknown as Json;
}

/**
 * design.mdのCustomerOrderingGateway Service Interfaceを実装するファクトリ。
 * `client`は呼び出し元（実アプリでは`createBrowserClient()`、テストでは
 * `client.rpc`だけをモックしたフェイク）が注入する。
 */
export function createCustomerOrderingGateway(
  client: SupabaseClient<Database>,
): CustomerOrderingGateway {
  return {
    async getOrderingContext(input) {
      const { data, error } = await client.rpc("get_ordering_context", {
        p_table_id: input.tableId,
      });

      if (error) {
        return err(
          mapPostgrestError(
            error,
            GET_ORDERING_CONTEXT_ERROR_MAPPING,
            "get_ordering_context",
          ),
        );
      }

      return ok(toOrderingContext(data));
    },

    async submitOrder(input) {
      const { data, error } = await client.rpc("submit_order", {
        p_session_id: input.sessionId,
        p_idempotency_key: input.idempotencyKey,
        p_items: toSubmitOrderItemsJson(input.items),
      });

      if (error) {
        return err(
          mapPostgrestError(error, SUBMIT_ORDER_ERROR_MAPPING, "submit_order"),
        );
      }

      return ok(toSubmitOrderResult(data));
    },

    async createCallRequest(input) {
      const { data, error } = await client.rpc("create_call_request", {
        p_session_id: input.sessionId,
      });

      if (error) {
        return err(
          mapPostgrestError(
            error,
            CREATE_CALL_REQUEST_ERROR_MAPPING,
            "create_call_request",
          ),
        );
      }

      return ok(toCallRequest(data));
    },
  };
}
