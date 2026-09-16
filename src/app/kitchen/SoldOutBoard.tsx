"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  createStaffOperationsGateway,
  type MenuItemListing,
} from "@/lib/gateways/staffOperationsGateway";

/**
 * 売り切れボード（design.md「KitchenBoard」の売り切れボードタブ実体）。
 * KitchenBoardScreen（7.1、7.2/7.3でFoodBoard/DrinkBoardを配線済み）が
 * "soldout"タブ選択中にマウントする。
 *
 * Requirements: 7.1, 7.3, 7.4
 * Design: .kiro/specs/table-order-kitchen/design.md「KitchenBoard」
 *   （「売り切れの登録・解除操作は実行前に確認ダイアログを表示し、確認後にのみ
 *   setSoldOutを呼び出す」）、StaffOperationsGateway.setSoldOut /
 *   listMenuItems のService Interface。
 * Mock: mock-preview.html の`soldoutPanelHtml()`（現在売り切れ中サマリー・
 *   品目名検索・行ごとのトグルスイッチ）と`requestToggleSoldOut`/
 *   `pendingToggle`（確認モーダルの状態管理・文言）を参照する。
 *
 * ## CONCERN: `listMenuItems`はタスク7.4で新規追加したRPC/ゲートウェイ
 * StaffOperationsGatewayには元々「特定の1品目の状態を切り替える」
 * `setSoldOut`（menuItemIdを既に知っている前提）のみが存在し、「厨房が
 * 売り切れボードへ表示する対象品目を選ぶための一覧」を返す手段が
 * design.mdのService Interfaceのどこにも定義されていないというギャップが
 * 本タスクの着手時に判明した。詳細な検討過程・却下した代替案・design.mdの
 * 修正内容は`supabase/migrations/0011_list_menu_items.sql`冒頭コメント、
 * および`staffOperationsGateway.ts`の`MenuItemListing`型コメントを参照。
 * 要旨: `setSoldOut`と同じ理由（要件7のAcceptance Criteriaがいずれも
 * 「厨房スタッフ」を主語とすること）によりkitchenロール限定のRPCとして
 * 新設した（registerロールには開放しない。8.3「品目の追加・削除UI」が
 * 将来的に同種の一覧を必要とする可能性はあるが、現時点の要件・design.mdは
 * それを要求しておらず、投機的に先取りしない）。
 *
 * ## 確認モーダルについて（本プロジェクトで最初の「確認してから書き込む」実装）
 * requirements.md 要件7.1「厨房スタッフが品目を売り切れとして登録する操作を
 * 行う際、実行前に確認を求め、確認された場合にのみ品切れ状態に更新する」・
 * 7.3（解除も同様）の通り、タップ操作は直接`setSoldOut`を呼び出さず、
 * 必ず確認モーダル（`pendingToggle`状態）を経由する。「いいえ」を選ぶと
 * `pendingToggle`をnullへ戻すのみで`setSoldOut`は一切呼び出されない
 * （本タスクの観測可能な完了条件そのもの）。レジ側の各種確認モーダル
 * （8.x、要件3.3/3.5/5.5-5.7、本タスク時点ではまだ未着手）が将来同種の
 * 確認フローを実装する際は、本コンポーネントの
 * `requestToggle`/`cancelPendingToggle`/`confirmPendingToggle`という
 * 3関数構成（mock-preview.htmlの`requestToggleSoldOut`/
 * `cancelPendingToggle`/`confirmPendingToggle`と同型）を参考にできる。
 *
 * ## 更新反映について（サーバー確定応答での即時反映、ポーリングとの競合なし）
 * tasks.md Implementation Notes（タスク6.3）が警告する「ポーリングと楽観的
 * UI更新の併用によるレース条件」は、ここには当てはまらない。本コンポーネント
 * は`setSoldOut`の呼び出し前に表示状態を先読みで書き換える（真の楽観的更新）
 * ことをせず、`setSoldOut`が返すサーバー確定済みの`MenuItem.soldOut`を
 * 受け取ってから該当品目のみをローカル一覧内でマージする。この値は
 * 次回ポーリング（`SOLD_OUT_BOARD_POLL_INTERVAL_MS`後）で取得される値と
 * 常に一致する（同じサーバー状態を指すため）ため、6.3のような「どちらが
 * 新しいか」を判定する仕組みは不要である。
 *
 * ## 既知の制約（v1スコープの割り切り）: 確認モーダル表示中の他端末操作によるlost update
 * 確認モーダルを開いている間（ユーザーが「はい/いいえ」を選ぶまでの間）に、
 * 別の厨房端末が同じ品目の売り切れ状態を先に変更した場合、2つの問題が起こりうる。
 * (1) モーダルの文言（「売り切れにしますか？」/「解除しますか？」）はモーダルを
 * 開いた時点の状態のまま変わらず古くなる。(2) より重要な点として、確認時に
 * 送信する`soldOut`は差分ではなく「この状態にしたい」という絶対値であり、
 * モーダルを開いた時点でキャプチャされた値をそのまま使うため、確認を押すと
 * 他端末による直近の変更を上書きしてしまう（lost update）。例:
 * 端末Aがモーダルを開いた後（sold_out=false→trueにする想定で開く）、
 * 端末Bが先に売り切れをtrueにし、その後端末Aが（画面上は古い文言のまま）
 * 「はい」を押すと、Aは自分の意図通りtrueを送るため一見問題なく見えるが、
 * 逆に端末Bがfalseに戻した直後に端末Aが「はい」（trueにする）を押せば、
 * Aの操作でBの変更が上書きされる。複数端末の同時操作という頻度の低いケースであり、
 * 要件7.1/7.3の観測可能な完了条件（本タスクのスコープ）はいずれも単一操作の
 * 確認フローのみを求めるため、本タスクではこれ以上の対策（確認直前の状態再検証等）
 * を行わない。7.5/8.xで同種の「絶対値を確認モーダルで確定する」パターンを
 * 再利用する場合は、確認実行前に最新状態を再取得・検証することを検討すること。
 */
export const SOLD_OUT_BOARD_POLL_INTERVAL_MS = 5000;

type SoldOutBoardProps = {
  storeId: string;
};

type BoardState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: ReadonlyArray<MenuItemListing> };

type PendingToggle = {
  menuItemId: string;
  name: string;
  // true: これから売り切れにする（現在は売り切れでない）
  // false: これから売り切れを解除する（現在は売り切れ）
  goingSoldOut: boolean;
  submitting: boolean;
};

const GENERIC_LOAD_ERROR_MESSAGE =
  "品目一覧の取得に失敗しました。ネットワーク接続をご確認のうえ、画面を再読み込みしてください。";
const GENERIC_TOGGLE_ERROR_MESSAGE =
  "売り切れ状態の更新に失敗しました。もう一度お試しください。";
const ITEM_NOT_FOUND_MESSAGE =
  "この品目は見つかりませんでした。画面を更新してください。";

function formatPrice(price: number): string {
  return `¥${price.toLocaleString("ja-JP")}`;
}

export default function SoldOutBoard({ storeId }: SoldOutBoardProps) {
  const gateway = useMemo(
    () => createStaffOperationsGateway(createBrowserClient()),
    [],
  );
  const [state, setState] = useState<BoardState>({ status: "loading" });
  const [search, setSearch] = useState("");
  const [pendingToggle, setPendingToggle] = useState<PendingToggle | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  // FoodBoard.tsx/DrinkBoard.tsx（7.2/7.3）が確立したマウント時フェッチ +
  // 簡易ポーリングのパターンをそのまま踏襲する（ファイル冒頭コメント
  // 「更新反映について」参照）。listMenuItemsもlistKitchenFeed/
  // listRegisterFeedと同じ`Result<T, never>`——ドキュメント化された
  // エラーコード以外（FORBIDDENを含む）は常に例外としてthrowされるため、
  // 必ずtry/catchで捕捉する。
  useEffect(() => {
    let cancelled = false;

    async function load(isInitialLoad: boolean) {
      try {
        const result = await gateway.listMenuItems({ storeId });
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          // design.mdの`never`エラー型によりここへは実際には到達しない
          // 防御的分岐（FoodBoard.tsx/DrinkBoard.tsxと同じ方針）。
          if (isInitialLoad) {
            setState({ status: "error", message: GENERIC_LOAD_ERROR_MESSAGE });
          }
          return;
        }
        setState({ status: "ready", items: result.value });
      } catch {
        if (!cancelled && isInitialLoad) {
          setState({ status: "error", message: GENERIC_LOAD_ERROR_MESSAGE });
        }
      }
    }

    void load(true);

    const interval = setInterval(() => {
      void load(false);
    }, SOLD_OUT_BOARD_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gateway, storeId]);

  function requestToggle(item: MenuItemListing) {
    setActionError(null);
    setPendingToggle({
      menuItemId: item.id,
      name: item.name,
      goingSoldOut: !item.soldOut,
      submitting: false,
    });
  }

  function cancelPendingToggle() {
    // 要件7.1/7.3・本タスクの観測可能な完了条件: 「いいえ」はここで
    // pendingToggleをnullへ戻すのみであり、setSoldOutは一切呼び出さない。
    setPendingToggle(null);
  }

  async function confirmPendingToggle() {
    if (!pendingToggle || pendingToggle.submitting) {
      return;
    }
    const { menuItemId, goingSoldOut } = pendingToggle;
    setPendingToggle({ ...pendingToggle, submitting: true });

    try {
      const result = await gateway.setSoldOut({
        menuItemId,
        soldOut: goingSoldOut,
      });

      if (!result.ok) {
        setActionError(
          result.error.code === "ITEM_NOT_FOUND"
            ? ITEM_NOT_FOUND_MESSAGE
            : GENERIC_TOGGLE_ERROR_MESSAGE,
        );
        setPendingToggle(null);
        return;
      }

      // サーバー確定済みの応答で該当品目のみをマージする（ファイル冒頭
      // コメント「更新反映について」参照。楽観的更新ではない）。
      setState((prev) =>
        prev.status === "ready"
          ? {
              status: "ready",
              items: prev.items.map((item) =>
                item.id === result.value.id
                  ? { ...item, soldOut: result.value.soldOut }
                  : item,
              ),
            }
          : prev,
      );
      setPendingToggle(null);
    } catch {
      // ドキュメント化されていない失敗（ネットワーク断等）。
      setActionError(GENERIC_TOGGLE_ERROR_MESSAGE);
      setPendingToggle(null);
    }
  }

  if (state.status === "loading") {
    return (
      <p
        className="p-4 text-sm text-neutral-500"
        data-testid="soldout-board-loading"
      >
        読み込み中...
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <p role="alert" className="p-4 text-sm text-red-600">
        {state.message}
      </p>
    );
  }

  const soldOutCount = state.items.filter((item) => item.soldOut).length;
  const trimmedSearch = search.trim();
  const filteredItems = trimmedSearch
    ? state.items.filter((item) => item.name.includes(trimmedSearch))
    : state.items;

  return (
    <div data-testid="soldout-board" className="flex flex-col gap-3 p-3">
      <div
        data-testid="soldout-summary"
        className={
          "rounded-lg border px-3 py-2 text-sm font-semibold " +
          (soldOutCount > 0
            ? "border-transparent bg-amber-50 text-amber-700"
            : "border-neutral-200 bg-neutral-50 text-neutral-600")
        }
      >
        現在売り切れ中：{soldOutCount}品
      </div>

      <div>
        <label htmlFor="soldout-search" className="sr-only">
          品目名で検索
        </label>
        <input
          id="soldout-search"
          type="text"
          data-testid="soldout-search"
          placeholder="商品名で絞り込み"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
        />
      </div>

      {actionError ? (
        <p role="alert" className="text-sm text-red-600">
          {actionError}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        {filteredItems.length === 0 ? (
          <p className="py-6 text-center text-sm text-neutral-400">
            該当する品目がありません
          </p>
        ) : (
          filteredItems.map((item) => (
            <div
              key={item.id}
              data-testid="soldout-item-row"
              className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white p-3"
            >
              <div className="min-w-0">
                <p
                  className={
                    "truncate text-sm font-semibold " +
                    (item.soldOut
                      ? "text-neutral-400 line-through"
                      : "text-neutral-900")
                  }
                >
                  {item.name}
                </p>
                <p className="text-xs text-neutral-500">
                  {formatPrice(item.price)}
                </p>
              </div>
              <button
                type="button"
                data-testid="soldout-toggle"
                aria-pressed={item.soldOut}
                aria-label={
                  item.soldOut
                    ? `${item.name}の売り切れを解除する`
                    : `${item.name}を売り切れにする`
                }
                onClick={() => requestToggle(item)}
                className={
                  "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold " +
                  (item.soldOut
                    ? "bg-neutral-800 text-white"
                    : "border border-neutral-300 text-neutral-700")
                }
              >
                {item.soldOut ? "売り切れ中" : "売り切れにする"}
              </button>
            </div>
          ))
        )}
      </div>

      {pendingToggle ? (
        <div
          data-testid="soldout-confirm-modal"
          role="alertdialog"
          aria-modal="true"
          aria-label="売り切れ状態の変更確認"
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-xs rounded-xl bg-white p-4 shadow-lg">
            <p className="mb-4 text-sm font-semibold text-neutral-900">
              {pendingToggle.goingSoldOut
                ? `「${pendingToggle.name}」を売り切れにしますか？`
                : `「${pendingToggle.name}」の売り切れを解除しますか？`}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="soldout-confirm-cancel"
                onClick={cancelPendingToggle}
                disabled={pendingToggle.submitting}
                className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm font-semibold text-neutral-700 disabled:opacity-50"
              >
                いいえ
              </button>
              <button
                type="button"
                data-testid="soldout-confirm-ok"
                onClick={() => void confirmPendingToggle()}
                disabled={pendingToggle.submitting}
                className="flex-1 rounded-lg bg-neutral-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {pendingToggle.submitting
                  ? "処理中..."
                  : pendingToggle.goingSoldOut
                    ? "売り切れにする"
                    : "解除する"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
