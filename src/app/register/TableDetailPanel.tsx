"use client";

import { useState } from "react";
import type {
  MenuItemGenre,
  MenuItemListing,
  TableBillingSummary,
} from "@/lib/gateways/staffOperationsGateway";
import type { OrderItemStatus } from "@/lib/gateways/customerOrderingGateway";
import { resolveNextOrderItemStatus } from "@/lib/orderItemStatusTransitions";
import { elapsedMinutes, formatYen } from "./FloorMap";
import ConfirmDialog from "./ConfirmDialog";
import OptionSelectionPanel, {
  type ItemSelection,
  type OptionValue,
} from "@/app/order/[tableId]/OptionSelectionPanel";

/**
 * 卓詳細パネル（design.md「RegisterConsole」の卓詳細パネル部分、タスク8.2/8.3）。
 * FloorMap.tsx（タスク8.1）がタイル選択中（`selectedTableId`が非null）に
 * 表示するオーバーレイモーダル。
 *
 * Requirements: 3.1, 3.2, 3.4, 5.1, 5.2, 5.3, 5.5, 5.6, 5.7
 * Design: .kiro/specs/table-order-kitchen/design.md「RegisterConsole」
 *   （「タイルを選択すると卓の詳細...を操作するパネルを開く。入店操作は
 *   人数の入力を伴い（要件3.1, 3.4）」「品目の追加・削除...はいずれも
 *   実行前に確認ダイアログを表示し、確認後にのみ対応する
 *   StaffOperationsGatewayのメソッドを呼び出す（要件5.5, 5.6）」）。
 * Mock: mock-preview.html の`tableDetailHtml`（空席時の「空席です。」＋
 *   「入店」ボタン→人数ステッパー（デフォルト2）＋「キャンセル」/
 *   「入店する」、来店中の人数・経過時間・session-id行、注文明細一覧
 *   （行ごとの「削除」ボタン）、合計行、「＋ 品目を追加」トグル→
 *   ジャンル別グループの品目一覧（売り切れは`disabled`）＋「＋」ボタン）
 *   と`requestAddStaffItem`/`requestRemoveItem`/`confirmPendingAction`
 *   （確認モーダルの文言・確定操作）を参照する。
 *
 * ## 本コンポーネントの位置づけ（純粋なプレゼンテーション、状態を持たない主要部分）
 * `table`（選択中卓の最新`TableBillingSummary`）はFloorMap.tsxが
 * `state.tables`から都度算出して渡す（FloorMap.tsx冒頭コメント
 * 「design decision D」参照）。本コンポーネント自身は`table`のコピーを
 * 保持せず、再レンダリングのたびに渡された最新値をそのまま表示する。
 * 入店操作（8.2）と同じ役割分担を品目の追加・削除（8.3）にも適用する:
 * 実際のRPC呼び出しとFloorMap状態へのマージはFloorMap.tsx側
 * （`useAddOrderItem`/`useRemoveOrderItem`フック）が担い、本コンポーネントは
 * `onAddItem`/`onRemoveItem`コールバック（いずれも`Promise<void>`を返す。
 * 下記「Promiseを返すコールバックについて」参照）と、対応するエラー
 * メッセージのみを受け取る。
 *
 * 唯一のローカル状態は、いずれも「エフェメラルなUI表示状態」
 * （人数入力ステッパーの開閉・下書き人数、品目追加リストの開閉、確認
 * モーダルの開閉）であり、いずれもサーバーの実際の状態とは無関係
 * （キャンセルすれば破棄される）。
 *
 * ## Promiseを返すコールバックについて（`onCheckIn`のfire-and-forgetとの違い）
 * `onCheckIn`（8.2）はfire-and-forgetで呼び出され、パネル側は
 * `submitting`propで送信中状態を表示するのみで、いつ完了したかを
 * 自分では判定しない（人数ステッパーは明示的に閉じられず、`table.
 * activeSession`が非nullになることで自然にOccupiedViewへ切り替わる）。
 * 一方、品目追加・削除の確認モーダルはSoldOutBoard.tsx（タスク7.4）が
 * 確立した「確認モーダルを開いたまま応答を待ち、応答後に閉じる」という
 * パターンをそのまま踏襲する必要がある（`requestToggle`/
 * `cancelPendingToggle`/`confirmPendingToggle`という3関数構成、タスク文書が
 * 明示的に「本タスクでも踏襲するように」と指示する参照実装）。しかし
 * 実際のRPC呼び出し・マージはFloorMap側のフックが担うため、本コンポーネント
 * 自身が「いつ応答が返ったか」を知るには、`onAddItem`/`onRemoveItem`が
 * `Promise<void>`を返し、本コンポーネントの確認ハンドラがそれを`await`
 * してから確認モーダルの状態を閉じる、という構成を採用した（両フックの
 * `addItem`/`removeItem`は成功・失敗いずれの場合も例外を再送出せず解決する
 * ため、`await`で待つだけでよく、`try/catch`は不要）。
 *
 * ## 品目追加の確認ステップについて（design decision、要件5.5）
 * mock-preview.htmlの`requestAddStaffItem`はオプション選択を経由せず
 * 「＋」タップ→汎用確認モーダル（「『品目名』を注文に追加しますか？」）
 * →確定、という一律のフローだが、実際のmenu_itemsはオプション
 * （`options`列）を持ちうる。タスク文書が明示的に許容する設計判断として、
 * 品目にオプションがある場合は客側の`OptionSelectionPanel`
 * （src/app/order/[tableId]/OptionSelectionPanel.tsx、タスク6.1で確立済みの
 * ゲートウェイ非依存な純粋プレゼンテーションコンポーネント）をそのまま
 * 再利用し、その「選択を確定」ボタン自体を要件5.5が求める確認ステップとして
 * 扱う（オプション選択という熟慮を伴う操作の後に、さらに二重の確認モーダルを
 * 挟むことはUX上冗長と判断した）。オプションを持たない品目については、
 * 「＋」タップが即座に追加を実行する「サイレントな1タップ操作」にならない
 * よう、mock-preview.htmlと同型の簡易確認モーダル（`ConfirmDialog`、
 * 「『品目名』を注文に追加しますか？」/「追加する」）を挟む。
 *
 * ### OptionSelectionPanel再利用の判断（重複せず直接importする）
 * `OptionSelectionPanel`は216行の非自明なchoice/toggle/counter UIロジックを
 * 持つが、`{item: MenuItemView, onCancel, onConfirm}`という純粋なprops
 * のみを取り、ゲートウェイ呼び出し・ルート固有の状態を一切持たない
 * （`formatYen`のような1行ヘルパーの複製前例とは性質が異なり、これほどの
 * 量のロジックを複製するとメンテナンス上の負債になる）。再利用するには
 * レジ側の品目一覧（`MenuItemListing`）が`MenuItemView`（{id, name, price,
 * soldOut, imageUrl, genre, options}）と構造的に一致している必要があるため、
 * `list_menu_items`（0013_list_menu_items_register_options.sql）へ
 * `imageUrl`/`options`を追加した（staffOperationsGateway.ts参照）。これに
 * より`MenuItemListing`は`MenuItemView`のスーパーセットとなり、
 * TypeScriptの構造的型付けにより`<OptionSelectionPanel item={menuItem} .../>`
 * がそのまま型チェックを通過する（アダプタ層は不要）。
 *
 * ## 削除確認について（要件5.6、本タスクの観測可能な完了条件）
 * 「削除」ボタン→確認モーダル（「『品目名（オプション概要）』を削除しますか？
 * この操作は取り消せません。」、mock-preview.htmlの`requestRemoveItem`と
 * 同じ文言パターン）→「いいえ」は`onRemoveItem`を一切呼び出さずモーダルを
 * 閉じるのみ（タスクの観測可能な完了条件そのもの。「はい」相当の
 * 「削除する」を確認してから初めて`onRemoveItem(orderItemId)`を呼び出す。
 *
 * ## ステータス表示・変更UI（タスク8.4、要件5.7）
 * 8.3時点では`list_register_feed`の`items`がジャンル情報を持たず
 * `status`をジャンルに応じて正しくラベル変換できなかったため、
 * `status`の値は取得するのみで画面には表示していなかった（0012冒頭
 * コメント参照）。本タスクで`list_register_feed`に`genre`を追加した
 * （`0014_list_register_feed_item_genre.sql`）ことで、mock-preview.htmlの
 * `statusLabel(genre, status)`と同じジャンルに応じた日本語ラベル変換
 * （ドリンクは「未対応」「対応済み」の2値、フード/一品は「未対応」
 * 「調理中」「調理完了」の3値）を各明細に表示できるようになった
 * （`orderItemStatusLabel`関数、本タスクの観測可能な完了条件そのもの:
 * 「注文明細のステータス表示が更新される」の前提となる表示）。
 *
 * 次ステータスが存在する品目（`done`以外）には、単一の「進める」ボタンを
 * 表示する（mock-preview.htmlのレジ側`tableDetailHtml`が検証済みの、
 * KitchenBoardより単純な1ボタン/1品目デザインを踏襲——一品の未対応→
 * 調理完了直接ショートカットはKitchenBoard専用の速度優先UXであり、
 * RegisterConsoleは意図的に持たない。design.decision C相当の判断、
 * `src/lib/orderItemStatusTransitions.ts`冒頭コメント「対象範囲」参照）。
 * 次ステータスの判定は`resolveNextOrderItemStatus`
 * （`src/lib/orderItemStatusTransitions.ts`、KitchenBoardの
 * `OrderItemStatusActions.tsx`と共有）を用いる——`update_order_item_status`
 * の許可遷移表と1:1対応させる必要があるロジックをKitchenBoard/
 * RegisterConsoleの2箇所へ複製するとドリフトのリスクがあるため
 * （tasks.md 7.5/8.4 Implementation Notes参照）。
 *
 * 「進める」タップ→`ConfirmDialog`（要件5.7「実行前に確認を求め」、
 * 品目追加・削除（8.3）と同型の確認フロー）→確認すると
 * `onUpdateItemStatus(orderItemId, nextStatus)`を呼び出す。「いいえ」は
 * 呼び出さずモーダルを閉じるのみ（削除確認（8.3）と対称的な完了条件、
 * tasks.md「Design decisions A」参照）。
 */

type TableDetailPanelProps = {
  table: TableBillingSummary;
  onClose: () => void;
  onCheckIn: (partySize: number) => void;
  submitting: boolean;
  checkInErrorMessage: string | null;
  // タスク8.3で追加。
  menuItems: ReadonlyArray<MenuItemListing>;
  menuItemsLoadError: boolean;
  onAddItem: (input: {
    menuItemId: string;
    quantity: number;
    optionSelections: Readonly<Record<string, OptionValue>>;
  }) => Promise<void>;
  addItemErrorMessage: string | null;
  onRemoveItem: (orderItemId: string) => Promise<void>;
  removeItemErrorMessage: string | null;
  // タスク8.4で追加。
  onUpdateItemStatus: (
    orderItemId: string,
    status: OrderItemStatus,
  ) => Promise<void>;
  updateStatusErrorMessage: string | null;
};

// 要件3.1「人数の入力を求め」に対応する下書きの初期値・下限。上限は要件が
// 定めないため設けない（判断はタスク文書「design decisions E」に委ねられて
// いる。mock-preview.htmlの`ru.partySizeDraft`初期値2にそのまま合わせる）。
const DEFAULT_PARTY_SIZE = 2;
const MIN_PARTY_SIZE = 1;

// タスク8.3で追加。「おすすめ」を持たないgenre値域（design.mdの
// MenuItemGenre）をmock-preview.htmlのGENRES表示順（一品→フード→
// ドリンク）で表示するためのローカル定義。GenreTabs.tsx
// （CustomerOrderApp境界）と同じラベル対応だが、境界を跨ぐimportを避け
// （formatYenの複製前例と同じ理由）ローカルに複製する。
const ADD_MENU_GENRE_ORDER: ReadonlyArray<MenuItemGenre> = [
  "ippin",
  "food",
  "drink",
];
const ADD_MENU_GENRE_LABELS: Record<MenuItemGenre, string> = {
  ippin: "一品",
  food: "フード",
  drink: "ドリンク",
};

function groupMenuItemsByGenre(
  items: ReadonlyArray<MenuItemListing>,
): ReadonlyArray<{ genre: MenuItemGenre; items: ReadonlyArray<MenuItemListing> }> {
  const byGenre: Partial<Record<MenuItemGenre, MenuItemListing[]>> = {};
  for (const item of items) {
    const bucket = byGenre[item.genre];
    if (bucket) {
      bucket.push(item);
    } else {
      byGenre[item.genre] = [item];
    }
  }
  return ADD_MENU_GENRE_ORDER.filter(
    (genre) => (byGenre[genre]?.length ?? 0) > 0,
  ).map((genre) => ({ genre, items: byGenre[genre] as MenuItemListing[] }));
}

/** 品目名の後ろにオプション概要を括弧書きで付す（mock-preview.htmlと同じ表記）。 */
function itemDisplayLabel(item: TableBillingSummary["items"][number]): string {
  return item.optionsSummary
    ? `${item.name}（${item.optionsSummary}）`
    : item.name;
}

// タスク8.4で追加。mock-preview.htmlの`statusLabel(genre, status)`
// （~line 732）と同じジャンルに応じた日本語ラベル対応表（ファイル冒頭
// コメント「ステータス表示・変更UI」参照）。フード/一品は3値、ドリンクは
// 2値のみを取りうる。
const FOOD_GENRE_STATUS_LABELS: Record<OrderItemStatus, string> = {
  received: "未対応",
  in_progress: "調理中",
  done: "調理完了",
};
const DRINK_STATUS_LABELS: Partial<Record<OrderItemStatus, string>> = {
  received: "未対応",
  done: "対応済み",
};

/** ジャンルに応じた品目ステータスの日本語表示。 */
function orderItemStatusLabel(
  genre: MenuItemGenre,
  status: OrderItemStatus,
): string {
  if (genre === "drink") {
    // ドリンクのin_progressは構造上到達しないが、防御的にstatusそのものを
    // フォールバック表示する（DrinkBoard.tsx冒頭コメントと同じ前提）。
    return DRINK_STATUS_LABELS[status] ?? status;
  }
  return FOOD_GENRE_STATUS_LABELS[status];
}

export default function TableDetailPanel({
  table,
  onClose,
  onCheckIn,
  submitting,
  checkInErrorMessage,
  menuItems,
  menuItemsLoadError,
  onAddItem,
  addItemErrorMessage,
  onRemoveItem,
  removeItemErrorMessage,
  onUpdateItemStatus,
  updateStatusErrorMessage,
}: TableDetailPanelProps) {
  const [startingSession, setStartingSession] = useState(false);
  const [partySizeDraft, setPartySizeDraft] = useState(DEFAULT_PARTY_SIZE);

  function beginStartSession() {
    setPartySizeDraft(DEFAULT_PARTY_SIZE);
    setStartingSession(true);
  }

  function cancelStartSession() {
    // 要件3.1・本タスクの観測可能な完了条件に関わる仕様: 「キャンセル」は
    // ここでローカルのステッパー表示を破棄するのみであり、startSession
    // （onCheckIn）は一切呼び出さない（SoldOutBoard.tsxの
    // `cancelPendingToggle`と同型の方針）。
    setStartingSession(false);
  }

  function confirmStartSession() {
    onCheckIn(partySizeDraft);
  }

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        data-testid="register-table-detail-panel"
        className="flex max-h-full w-full max-w-sm flex-col gap-3 overflow-y-auto rounded-xl bg-white p-4 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <span className="text-base font-semibold text-neutral-900">
            {table.tableLabel}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs font-semibold text-neutral-500"
          >
            閉じる
          </button>
        </div>

        {table.activeSession === null ? (
          <VacantView
            startingSession={startingSession}
            partySizeDraft={partySizeDraft}
            setPartySizeDraft={setPartySizeDraft}
            submitting={submitting}
            checkInErrorMessage={checkInErrorMessage}
            onBeginStartSession={beginStartSession}
            onCancelStartSession={cancelStartSession}
            onConfirmStartSession={confirmStartSession}
          />
        ) : (
          <OccupiedView
            table={table}
            activeSession={table.activeSession}
            menuItems={menuItems}
            menuItemsLoadError={menuItemsLoadError}
            onAddItem={onAddItem}
            addItemErrorMessage={addItemErrorMessage}
            onRemoveItem={onRemoveItem}
            removeItemErrorMessage={removeItemErrorMessage}
            onUpdateItemStatus={onUpdateItemStatus}
            updateStatusErrorMessage={updateStatusErrorMessage}
          />
        )}
      </div>
    </div>
  );
}

type VacantViewProps = {
  startingSession: boolean;
  partySizeDraft: number;
  setPartySizeDraft: (updater: (current: number) => number) => void;
  submitting: boolean;
  checkInErrorMessage: string | null;
  onBeginStartSession: () => void;
  onCancelStartSession: () => void;
  onConfirmStartSession: () => void;
};

/** 空席時のビュー（要件3.1, 5.2）。 */
function VacantView({
  startingSession,
  partySizeDraft,
  setPartySizeDraft,
  submitting,
  checkInErrorMessage,
  onBeginStartSession,
  onCancelStartSession,
  onConfirmStartSession,
}: VacantViewProps) {
  return (
    <div className="flex flex-col gap-3">
      {checkInErrorMessage ? (
        <p role="alert" className="text-sm font-semibold text-red-600">
          {checkInErrorMessage}
        </p>
      ) : null}

      {startingSession ? (
        <div data-testid="register-check-in-form" className="flex flex-col gap-3">
          <div>
            <div className="mb-1 text-xs font-semibold text-neutral-500">
              人数
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="人数を減らす"
                onClick={() =>
                  setPartySizeDraft((current) =>
                    Math.max(MIN_PARTY_SIZE, current - 1),
                  )
                }
                className="h-8 w-8 rounded-full border border-neutral-300 text-sm font-bold text-neutral-700"
              >
                −
              </button>
              <span
                data-testid="register-check-in-party-size"
                className="min-w-[2ch] text-center text-base font-semibold tabular-nums"
              >
                {partySizeDraft}
              </span>
              <button
                type="button"
                aria-label="人数を増やす"
                onClick={() => setPartySizeDraft((current) => current + 1)}
                className="h-8 w-8 rounded-full border border-neutral-300 text-sm font-bold text-neutral-700"
              >
                ＋
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancelStartSession}
              disabled={submitting}
              className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm font-semibold text-neutral-700 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={onConfirmStartSession}
              disabled={submitting}
              className="flex-1 rounded-lg bg-neutral-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {submitting ? "処理中..." : "入店する"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-neutral-500">
            空席です。会計対象がありません。
          </p>
          <button
            type="button"
            onClick={onBeginStartSession}
            className="rounded-lg bg-neutral-900 px-3 py-2 text-sm font-semibold text-white"
          >
            入店
          </button>
        </>
      )}
    </div>
  );
}

type OccupiedViewProps = {
  table: TableBillingSummary;
  activeSession: NonNullable<TableBillingSummary["activeSession"]>;
  menuItems: ReadonlyArray<MenuItemListing>;
  menuItemsLoadError: boolean;
  onAddItem: (input: {
    menuItemId: string;
    quantity: number;
    optionSelections: Readonly<Record<string, OptionValue>>;
  }) => Promise<void>;
  addItemErrorMessage: string | null;
  onRemoveItem: (orderItemId: string) => Promise<void>;
  removeItemErrorMessage: string | null;
  // タスク8.4で追加。
  onUpdateItemStatus: (
    orderItemId: string,
    status: OrderItemStatus,
  ) => Promise<void>;
  updateStatusErrorMessage: string | null;
};

type PendingSimpleAdd = { menuItemId: string; name: string };
type PendingRemoval = { orderItemId: string; label: string };
// タスク8.4で追加。
type PendingStatusChange = {
  orderItemId: string;
  label: string;
  nextStatus: OrderItemStatus;
  nextStatusLabel: string;
};

/**
 * 来店中のビュー（要件5.1, 5.5, 5.6, 5.7）。品目の追加・削除・ステータス
 * 変更を扱う（会計・呼び出し対応は8.5/8.6のスコープのため引き続き対象外）。
 */
function OccupiedView({
  table,
  activeSession,
  menuItems,
  menuItemsLoadError,
  onAddItem,
  addItemErrorMessage,
  onRemoveItem,
  removeItemErrorMessage,
  onUpdateItemStatus,
  updateStatusErrorMessage,
}: OccupiedViewProps) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [optionItem, setOptionItem] = useState<MenuItemListing | null>(null);
  const [pendingSimpleAdd, setPendingSimpleAdd] =
    useState<PendingSimpleAdd | null>(null);
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(
    null,
  );
  const [removeSubmitting, setRemoveSubmitting] = useState(false);
  // タスク8.4で追加。
  const [pendingStatusChange, setPendingStatusChange] =
    useState<PendingStatusChange | null>(null);
  const [statusChangeSubmitting, setStatusChangeSubmitting] = useState(false);

  function requestAddItem(item: MenuItemListing) {
    // 売り切れの品目は「＋」ボタン自体がdisabledのため通常到達しないが、
    // 防御的に二重チェックする（要件G）。
    if (item.soldOut) {
      return;
    }
    if (item.options.length > 0) {
      setOptionItem(item);
    } else {
      setPendingSimpleAdd({ menuItemId: item.id, name: item.name });
    }
  }

  async function confirmOptionSelection(selection: ItemSelection) {
    if (!optionItem) {
      return;
    }
    setAddSubmitting(true);
    await onAddItem({
      menuItemId: optionItem.id,
      quantity: selection.quantity,
      optionSelections: selection.optionSelections,
    });
    setAddSubmitting(false);
    setOptionItem(null);
  }

  async function confirmSimpleAdd() {
    if (!pendingSimpleAdd) {
      return;
    }
    setAddSubmitting(true);
    await onAddItem({
      menuItemId: pendingSimpleAdd.menuItemId,
      quantity: 1,
      optionSelections: {},
    });
    setAddSubmitting(false);
    setPendingSimpleAdd(null);
  }

  function requestRemoveItem(item: TableBillingSummary["items"][number]) {
    setPendingRemoval({
      orderItemId: item.id,
      label: itemDisplayLabel(item),
    });
  }

  async function confirmPendingRemoval() {
    if (!pendingRemoval) {
      return;
    }
    setRemoveSubmitting(true);
    await onRemoveItem(pendingRemoval.orderItemId);
    setRemoveSubmitting(false);
    setPendingRemoval(null);
  }

  // タスク8.4で追加（要件5.7）。「進める」ボタンは次ステータスが存在する
  // 品目にのみ描画される（ファイル冒頭コメント「ステータス表示・変更UI」
  // 参照）ため、ここでのnextStatus===nullは通常到達しない防御的分岐。
  function requestStatusChange(item: TableBillingSummary["items"][number]) {
    const nextStatus = resolveNextOrderItemStatus(item.genre, item.status);
    if (!nextStatus) {
      return;
    }
    setPendingStatusChange({
      orderItemId: item.id,
      label: itemDisplayLabel(item),
      nextStatus,
      nextStatusLabel: orderItemStatusLabel(item.genre, nextStatus),
    });
  }

  async function confirmPendingStatusChange() {
    if (!pendingStatusChange) {
      return;
    }
    setStatusChangeSubmitting(true);
    await onUpdateItemStatus(
      pendingStatusChange.orderItemId,
      pendingStatusChange.nextStatus,
    );
    setStatusChangeSubmitting(false);
    setPendingStatusChange(null);
  }

  const genreGroups = groupMenuItemsByGenre(menuItems);

  return (
    <div className="flex flex-col gap-3">
      {table.hasOpenCallRequest ? (
        <div
          data-testid="register-table-detail-call-banner"
          role="status"
          className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700"
        >
          呼び出し中
        </div>
      ) : null}

      <div
        data-testid="register-table-detail-occupancy"
        className="text-xs text-neutral-500"
      >
        {activeSession.partySize}名　・　ご来店{" "}
        {elapsedMinutes(activeSession.startedAt)}分経過
        <span className="font-mono">session #{activeSession.id}</span>
      </div>

      <div
        data-testid="register-table-detail-items"
        className="max-h-44 overflow-y-auto rounded-lg border border-neutral-200"
      >
        {table.items.length === 0 ? (
          <p className="px-3 py-3 text-xs text-neutral-400">
            まだ注文はありません
          </p>
        ) : (
          table.items.map((item) => {
            const nextStatus = resolveNextOrderItemStatus(
              item.genre,
              item.status,
            );
            return (
              <div
                key={item.id}
                data-testid="register-table-detail-item"
                className="flex flex-col gap-1 border-b border-neutral-100 px-3 py-2 text-sm last:border-b-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-neutral-800">
                    {itemDisplayLabel(item)} ×{item.quantity}
                  </span>
                  <span
                    data-testid="register-table-detail-item-status"
                    className="shrink-0 text-xs font-semibold text-neutral-500"
                  >
                    {orderItemStatusLabel(item.genre, item.status)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold text-neutral-900">
                    {formatYen(item.unitPrice * item.quantity)}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    {nextStatus ? (
                      <button
                        type="button"
                        data-testid="register-table-detail-item-advance"
                        aria-label={`${item.name}のステータスを進める`}
                        onClick={() => requestStatusChange(item)}
                        className="rounded px-2 py-1 text-xs font-semibold text-neutral-700"
                      >
                        進める
                      </button>
                    ) : null}
                    <button
                      type="button"
                      data-testid="register-table-detail-item-remove"
                      aria-label={`${item.name}を削除`}
                      onClick={() => requestRemoveItem(item)}
                      className="rounded px-2 py-1 text-xs font-semibold text-neutral-500"
                    >
                      削除
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {removeItemErrorMessage ? (
        <p
          role="alert"
          data-testid="register-remove-item-error"
          className="text-sm text-red-600"
        >
          {removeItemErrorMessage}
        </p>
      ) : null}

      {updateStatusErrorMessage ? (
        <p
          role="alert"
          data-testid="register-update-status-error"
          className="text-sm text-red-600"
        >
          {updateStatusErrorMessage}
        </p>
      ) : null}

      <div className="flex items-baseline justify-between">
        <span className="text-xs text-neutral-500">合計</span>
        <span
          data-testid="register-table-detail-total"
          className="font-mono text-base font-bold text-neutral-900"
        >
          {formatYen(table.total)}
        </span>
      </div>

      <button
        type="button"
        data-testid="register-add-menu-toggle"
        onClick={() => setAddMenuOpen((open) => !open)}
        className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-semibold text-neutral-700"
      >
        {addMenuOpen ? "品目の追加を閉じる" : "＋ 品目を追加"}
      </button>

      {addItemErrorMessage ? (
        <p
          role="alert"
          data-testid="register-add-item-error"
          className="text-sm text-red-600"
        >
          {addItemErrorMessage}
        </p>
      ) : null}

      {addMenuOpen ? (
        <div
          data-testid="register-add-menu-list"
          className="max-h-40 overflow-y-auto rounded-lg border border-neutral-200"
        >
          {menuItemsLoadError ? (
            <p role="alert" className="px-3 py-3 text-xs text-red-600">
              品目一覧の取得に失敗しました。
            </p>
          ) : null}
          {!menuItemsLoadError && menuItems.length === 0 ? (
            <p className="px-3 py-3 text-xs text-neutral-400">
              品目がありません
            </p>
          ) : null}
          {genreGroups.map((group) => (
            <div key={group.genre}>
              <div className="bg-neutral-50 px-3 py-1 text-xs font-bold text-neutral-500">
                {ADD_MENU_GENRE_LABELS[group.genre]}
              </div>
              {group.items.map((item) => (
                <div
                  key={item.id}
                  data-testid="register-add-menu-item"
                  className="flex items-center justify-between gap-2 border-b border-neutral-100 px-3 py-2 text-sm last:border-b-0"
                >
                  <span
                    className={
                      item.soldOut
                        ? "text-neutral-400 line-through"
                        : "text-neutral-800"
                    }
                  >
                    {item.name} {formatYen(item.price)}
                  </span>
                  <button
                    type="button"
                    data-testid="register-add-menu-item-button"
                    aria-label={`${item.name}を追加`}
                    disabled={item.soldOut}
                    onClick={() => requestAddItem(item)}
                    className="shrink-0 rounded-full bg-neutral-900 px-3 py-1 text-xs font-semibold text-white disabled:opacity-30"
                  >
                    ＋
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {optionItem ? (
        <OptionSelectionPanel
          item={optionItem}
          onCancel={() => setOptionItem(null)}
          onConfirm={(selection) => void confirmOptionSelection(selection)}
        />
      ) : null}

      {pendingSimpleAdd ? (
        <ConfirmDialog
          testId="register-add-confirm"
          ariaLabel="品目追加の確認"
          message={`「${pendingSimpleAdd.name}」を注文に追加しますか？`}
          confirmLabel="追加する"
          submitting={addSubmitting}
          onCancel={() => setPendingSimpleAdd(null)}
          onConfirm={() => void confirmSimpleAdd()}
        />
      ) : null}

      {pendingStatusChange ? (
        <ConfirmDialog
          testId="register-status-confirm"
          ariaLabel="品目ステータス変更の確認"
          message={`「${pendingStatusChange.label}」のステータスを「${pendingStatusChange.nextStatusLabel}」に更新しますか？`}
          confirmLabel="進める"
          submitting={statusChangeSubmitting}
          onCancel={() => setPendingStatusChange(null)}
          onConfirm={() => void confirmPendingStatusChange()}
        />
      ) : null}

      {pendingRemoval ? (
        <ConfirmDialog
          testId="register-remove-confirm"
          ariaLabel="注文明細の削除確認"
          message={`「${pendingRemoval.label}」を削除しますか？\nこの操作は取り消せません。`}
          confirmLabel="削除する"
          submitting={removeSubmitting}
          onCancel={() => setPendingRemoval(null)}
          onConfirm={() => void confirmPendingRemoval()}
        />
      ) : null}
    </div>
  );
}
