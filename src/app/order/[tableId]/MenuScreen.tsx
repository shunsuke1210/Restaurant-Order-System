"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  createCustomerOrderingGateway,
  type MenuItemView,
  type OrderingContext,
} from "@/lib/gateways/customerOrderingGateway";
import GenreTabs, { type GenreFilter } from "./GenreTabs";
import MenuItemCard from "./MenuItemCard";
import OptionSelectionPanel, {
  type ItemSelection,
  type OptionValue,
} from "./OptionSelectionPanel";
import ConfirmedTotalBar from "./ConfirmedTotalBar";
import CartPanel, { type CartSubmissionState } from "./CartPanel";

type MenuScreenProps = {
  tableId: string;
};

type TableInfo = { id: string; label: string };

type ViewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "no-session"; table: TableInfo }
  | {
      status: "ready";
      table: TableInfo;
      sessionId: string;
      menu: ReadonlyArray<MenuItemView>;
      confirmedTotal: number;
    };

/**
 * 確定注文合計のライブ更新方式についての設計判断（タスク6.2）。
 *
 * 要件1.12「同席者の別端末からの注文にもRealtimeで追随して更新する」を
 * 実現する方式として、以下3案を検討した（tasks.md Implementation Notes
 * 「タスク5で判明」の節、および0008_realtime_publication.sqlの
 * 「anonへのSELECT付与を見送った理由」を踏まえる）。
 *
 * - 案A（本実装が採用）: `getOrderingContext`のポーリング
 * - 案B: Realtime Broadcast + `realtime.messages`をsession_idトピックで
 *   RLSスコープする方式（`realtime.broadcast_changes()`等のトリガー実装が
 *   別途必要）
 * - 案C: `order_items`をpublicationにのみ追加しGRANTを与えない、
 *   中身の無い「変更があった」シグナルのみを配信する方式
 *
 * 採用理由:
 * 1. 案Cは0008マイグレーションのコメント（背景2）が既に実機で検証済み
 *    ——publicationに登録してもGRANT/RLSが無いロールには
 *    `realtime.apply_rls`の`has_column_privilege`チェックで一切配信されない
 *    ことを4回中3回で確認し、残り1回だけ配信された例外は
 *    「ローカル開発コンテナ側の一過性の問題」と判断されている。つまり
 *    このプロジェクト自身の実機調査が「案Cは信頼できない
 *    （たとえcontent-freeでも配信自体が保証されない）」ことを裏付けており、
 *    改めて独立に再検証するまでもなく採用を見送るのが妥当と判断した。
 * 2. 案Bは新しいDBインフラ（broadcastトリガー・トピック別RLS）を要し、
 *    実際に動作証明するまで作り込む必要がある「本物の非自明な追加作業」
 *    （tasks.md本タスクの指示より）。design.mdのComponents and Interfaces表で
 *    CustomerOrderApp→RealtimeFeedの依存は明示的にP1（ベストエフォート、
 *    P0ではない）と位置付けられており、案Bのために新規インフラを追加する
 *    ことは「Simplification原則」（design.md Performance & Scalability:
 *    「追加のキャッシュ層やスケーリング設計は本規模では不要と判断する」）
 *    およびtech.mdの「一人での開発・保守を前提に、運用の手間とコストを
 *    最小化するBaaS中心の構成を採用する」という全体方針と整合しない。
 * 3. 案Aは新しいセキュリティ境界・DBインフラを一切追加せず、
 *    `getOrderingContext`という既存の権限検証済みRPC（3.1で実装済み、
 *    RLSではなくRPC自体がtableId単位でconfirmedTotalのみを返す設計）を
 *    そのまま再利用できる。厨房/レジのRealtime（`useRealtimeFeed`）は
 *    店舗全体の即時反映が要件（6.1/6.9）だが、客側の確定注文合計は
 *    「自分がいつでも確認できる」（要件1.12）程度の即時性で十分であり、
 *    ポーリングの数秒の遅延は許容範囲と判断した。
 *
 * ポーリング間隔（5秒）の根拠: 本プロジェクトの想定規模（個人経営の居酒屋、
 * 満席時30-40人・卓数目安10-20卓）では、同時にこの画面を開く客側デバイス数は
 * 多くとも20台程度である。5秒間隔なら定常時で最大4リクエスト/秒程度にしか
 * ならず、単純な単一行SELECT中心のRPCに対して無視できる負荷である。一方、
 * 飲食店で「他の同席者が送った注文の合計が数秒後に反映される」ことは、
 * チャットアプリのような即時性が求められる用途と異なり体感上ほぼ問題にならない
 * （客が画面を注視し続けて更新を待つような操作ではないため）。
 *
 * なお`useRealtimeFeed`（タスク5）は本タスクでは利用しない
 * （0008マイグレーションが客側`anon`ロールに`order_items`等へのSELECTを
 * 一切許可していないため、`postgres_changes`購読自体が原理的に成立しない。
 * 上記の通りRealtimeへ穴を開けるより、`useRealtimeFeed`の設計思想
 * ——「ペイロードを信頼せず、必ずサーバー側RPCで再取得する」——を
 * ポーリングという形でそのまま踏襲する）。
 */
export const CONFIRMED_TOTAL_POLL_INTERVAL_MS = 5000;

/**
 * 送信前の1品目分の選択内容。実際の注文送信（submitOrder呼び出し、
 * design.mdのSubmitOrderInput.items相当への変換）は6.2の責務のため、
 * ここではCustomerOrderingGateway.submitOrderのitems要素にほぼ対応する形
 * （menuItemId/quantity/optionSelections/note）でローカルに保持するだけに
 * 留める。keyはカート内での一意な行識別用（同一品目でもオプション別に
 * 別明細として扱う要件1.8を6.2が実装しやすいよう、行ごとに独立させる）。
 */
export type CartLine = {
  key: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  optionSelections: Readonly<Record<string, OptionValue>>;
  note: string | null;
};

const GENERIC_ERROR_MESSAGE =
  "予期しないエラーが発生しました。ネットワーク接続をご確認のうえ、もう一度お試しください。";

/**
 * `getOrderingContext`の成功応答からViewStateの"ready"/"no-session"分岐を
 * 導出する。初回読み込み（マウント時のuseEffect）とポーリングによる
 * バックグラウンド再取得の両方から呼ばれる（重複ロジック排除）。
 * セッションがアクティブな間だけ意味を持つ`sessionId`をここで確定させる
 * （submitOrder呼び出しに必須。6.1時点ではactiveSession.idを一切
 * ViewStateへ保持していなかったギャップを6.2で埋める）。
 */
function toReadyState(context: OrderingContext): ViewState {
  if (!context.activeSession) {
    return { status: "no-session", table: context.table };
  }
  return {
    status: "ready",
    table: context.table,
    sessionId: context.activeSession.id,
    menu: context.menu,
    confirmedTotal: context.confirmedTotal,
  };
}

/**
 * 客の卓側QR注文画面の実体（design.md CustomerOrderApp）。
 * page.tsxからtableIdを受け取り、CustomerOrderingGatewayに依存して
 * メニュー閲覧・ジャンル別タブ・オプション選択UI（タスク6.1）、
 * 注文送信・確定注文合計の常時表示・通信断ハンドリング（タスク6.2）を
 * 提供する。
 *
 * 呼び出しボタン・アクティブセッション不在時の専用案内画面はそれぞれ
 * 6.3/6.4の責務であり、本コンポーネントはそれらを実装しない。
 * アクティブセッションが無い場合はクラッシュや空白画面を避けるための
 * 最小限の案内文のみを表示する（6.4が正式なUIを実装する前提）。
 */
export default function MenuScreen({ tableId }: MenuScreenProps) {
  const gateway = useMemo(
    () => createCustomerOrderingGateway(createBrowserClient()),
    [],
  );

  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [genreFilter, setGenreFilter] = useState<GenreFilter>("all");
  const [selectedItem, setSelectedItem] = useState<MenuItemView | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartPanelOpen, setCartPanelOpen] = useState(false);
  const [submission, setSubmission] = useState<CartSubmissionState>({
    kind: "idle",
  });

  // 送信試行1回分の冪等性キー。design.mdのsubmit_order設計意図（同一の
  // idempotencyKeyでの再送は新規行を作らず既存注文を返す）を活かすには、
  // 「本当に成功したがレスポンスだけ失われた」ケースの再試行が同じキーを
  // 使う必要がある。tasks.mdの指示通り、ネットワーク断後の再試行で
  // 新しいキーを生成しないことが本タスクの核心的な制約。refに保持し、
  // 成功した時にのみnullへ戻す（＝次の送信サイクルへ進む）。
  // 業務エラー（SESSION_NOT_ACTIVE等）でRPCが例外を送出した場合も
  // トランザクションはロールバックされ当該キーの行は作られないため、
  // 同じキーを使い回しても安全（新規に正常挿入される）。よって
  // 「成功するまでキーを使い回す」という単純な規則に統一し、
  // エラー種別ごとにキー破棄/再生成を分岐させない。
  //
  // 重要な補足（独立レビューで発見されたバグの修正、以下「本注記」）:
  // 上記の「成功するまで使い回す」規則は、無条件に成り立つわけではない。
  // idempotencyKeyは本来「このカート内容ちょうどの送信試行1回分」を表す
  // べきものであり、「このセッションが現在再試行待ちである」という状態
  // だけを表すものではない。submit_orderの重複排除は
  // (session_id, idempotency_key)の組み合わせのみで判定し、実際に
  // 送信されたitemsの中身までは一切比較しない
  // （0003_rpc_customer_gateway.sql参照）。そのため、送信が失敗した
  // （と客が認識した）後にカートの中身が変わった状態で同じキーを
  // 使い回すと、RPCは「1回目と同じ送信の再試行」とみなして1回目の
  // 注文（＝変更前の中身）をそのまま返してしまい、追加された品目が
  // サーバーに一切送信されないままUIだけが「送信完了」を表示する、
  // というサイレントなデータ消失が発生する（実際に発見された再現手順:
  // 唐揚げのみ送信→ネットワーク断表示→カートにレモンサワーを追加→
  // 同じキーで再送信→レモンサワーが黙って消える）。
  //
  // よって「キーを使い回してよいのは、そのキーを発行した時点のカート内容
  // からカートが一切変わっていない場合に限る」という制約を追加する。
  // 具体的には、カートの中身を変更するあらゆる操作
  // （現時点ではhandleConfirmSelectionのみ。setCartを呼ぶ全箇所は
  // このファイル冒頭でgrep済み——送信成功時のsetCart([])は成功と同時に
  // このrefも既にnullへ戻るためこの制約の対象外）で、保留中の
  // idempotencyKeyRef.currentを明示的にnullへリセットする。これにより
  // 次のhandleSubmitは新しいカート内容に対応する新しいキーを生成する。
  // 一方、カートが変わっていない単純なネットワーク再試行（承認済みの
  // 挙動）では、このrefは触られないため引き続き同じキーが再利用され、
  // submit_orderの重複排除が意図通り機能する。
  const idempotencyKeyRef = useRef<string | null>(null);

  const refreshConfirmedTotal = useCallback(async () => {
    // バックグラウンド再取得（ポーリング/送信成功直後）の失敗は画面を
    // 壊さないよう握りつぶす。ネットワーク断の明示的なハンドリングは
    // 注文送信時（handleSubmit）の責務であり、ここでは「次回また
    // 取得を試みる」という単純なベストエフォートに徹する（要件1.11とは
    // 別の関心事）。
    try {
      const result = await gateway.getOrderingContext({ tableId });
      if (!result.ok) {
        return;
      }
      setView((prev) =>
        prev.status === "ready" ? toReadyState(result.value) : prev,
      );
    } catch {
      // 上記コメントの通り無視する。
    }
  }, [gateway, tableId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // tasks.md Implementation Notes: customerOrderingGatewayの各メソッドは
      // ドキュメント化されたエラーコード以外の予期しない失敗（ネットワーク断等）
      // をResultに含めず例外としてthrowする。Reactのイベントハンドラ/エフェクト
      // 内の非同期例外はエラーバウンダリが自動捕捉しないため、必ずここで
      // try/catchし、汎用エラーメッセージへ変換する。
      try {
        const result = await gateway.getOrderingContext({ tableId });
        if (cancelled) {
          return;
        }

        if (!result.ok) {
          // OrderingContextErrorは現時点で{code: "TABLE_NOT_FOUND"}の
          // 1メンバーのみの共用体。将来メンバーが増えた場合にも汎用エラーへ
          // フォールバックできるよう、既知のコードだけを個別メッセージへ
          // マッピングし、それ以外は汎用エラーメッセージにする
          // （網羅的switchではなくif/elseにしているのは、TypeScriptの
          // 制御フロー解析がswitch内のreturnだけでは`result`をこのif文の
          // 直後でok:trueへ確実に絞り込めない場合があるため。ここでは
          // if文自体が必ずreturnすることを単純な形で保証する）。
          const message =
            result.error.code === "TABLE_NOT_FOUND"
              ? "指定された卓が見つかりません。店員にお問い合わせください。"
              : GENERIC_ERROR_MESSAGE;
          setView({ status: "error", message });
          return;
        }

        setView(toReadyState(result.value));
      } catch {
        if (!cancelled) {
          setView({ status: "error", message: GENERIC_ERROR_MESSAGE });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [gateway, tableId]);

  // 確定注文合計のライブ更新（要件1.12、ファイル冒頭コメントの設計判断
  // 「案A: ポーリング」参照）。activeSessionがある間（status==="ready"）
  // のみ一定間隔で再取得する。ポーリング自体が成功してもstatusが
  // "ready"のまま変わらない限りこのeffectは再実行されない
  // （依存配列はview.statusのみ。confirmedTotal等の中身の変化では
  // 依存配列は変わらないため、インターバルが不要に張り直されることはない）。
  useEffect(() => {
    if (view.status !== "ready") {
      return;
    }
    const interval = setInterval(() => {
      void refreshConfirmedTotal();
    }, CONFIRMED_TOTAL_POLL_INTERVAL_MS);
    return () => {
      clearInterval(interval);
    };
  }, [view.status, refreshConfirmedTotal]);

  function handleSelectItem(item: MenuItemView) {
    setSelectedItem(item);
  }

  function handleCancelSelection() {
    setSelectedItem(null);
  }

  function handleConfirmSelection(selection: ItemSelection) {
    if (!selectedItem) {
      return;
    }
    setCart((prev) => [
      ...prev,
      {
        key: `${selectedItem.id}-${prev.length}-${Date.now()}`,
        menuItemId: selectedItem.id,
        name: selectedItem.name,
        unitPrice: selectedItem.price,
        quantity: selection.quantity,
        optionSelections: selection.optionSelections,
        note: null,
      },
    ]);
    setSelectedItem(null);
    // 独立レビューで発見されたバグの修正本体（上記refコメント「本注記」参照）:
    // カートの中身がこの時点で変わるため、保留中のidempotencyKeyRef.current
    // （もしあれば）はもう「このカート内容ちょうどの送信試行1回分」を
    // 表さなくなる。ここで明示的に破棄し、次回のhandleSubmitが新しい
    // カート内容に対応する新しいキーを発行するようにする。
    //
    // 既知の残存リスク（レビューで発見・許容済み、要件外の追加インフラなしでは
    // 解消不可）: 直前の送信が実はサーバー側で成功していたがレスポンスだけが
    // 失われた場合（ネットワーク断の典型例の一つ）に、ここでカートへ品目を
    // 追加してから再送信すると、新しいキーによる別注文が発行され、直前の
    // 注文と品目が重複しうる（二重注文・二重調理のリスク）。「送信未完了」
    // 表示自体は不正確ではない（今回の送信試行についての正確な結果を示す）が、
    // 直前の試行が実際には成立していた場合の重複は防げない。解消には
    // 再送信前に既存キーでの結果を確認する調停処理が必要で、本タスクの
    // スコープ外（レジ側で重複に気づいた場合はremoveOrderItemで対応可能）。
    idempotencyKeyRef.current = null;
  }

  function handleOpenCartPanel() {
    setCartPanelOpen(true);
  }

  function handleCloseCartPanel() {
    setCartPanelOpen(false);
    // ダイアログを閉じる時点でUI上のエラー/成功表示はリセットする
    // （idempotencyKeyRef自体はここでは触らない。冪等性キーの破棄は
    // 「送信が成功した時」のみに限定するという上記refコメントの規則を
    // 維持するため、パネルの開閉では変化させない）。
    setSubmission({ kind: "idle" });
  }

  async function handleSubmit() {
    if (view.status !== "ready" || cart.length === 0) {
      return;
    }
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }

    setSubmission({ kind: "submitting" });

    // tasks.md Implementation Notes: customerOrderingGatewayの各メソッドは
    // ドキュメント化されたエラーコード以外の予期しない失敗（ネットワーク断等）
    // をResultに含めず例外としてthrowする。ここでの例外＝要件1.11の
    // 「送信が完了していない旨の表示・再試行の案内」の対象そのもの。
    try {
      const result = await gateway.submitOrder({
        sessionId: view.sessionId,
        idempotencyKey: idempotencyKeyRef.current,
        items: cart.map((line) => ({
          menuItemId: line.menuItemId,
          quantity: line.quantity,
          optionSelections: line.optionSelections,
          note: line.note,
        })),
      });

      if (!result.ok) {
        // SubmitOrderErrorの4メンバーそれぞれをCartPanelが個別の文言へ
        // マッピングする（1つの汎用エラーメッセージに丸めない、という
        // 本タスクの明示的な要件）。ITEM_SOLD_OUTのみ対象品目名を
        // 表示中のメニューから解決して添える（design.mdのSubmitOrderError
        // 型自体はmenuItemIdのみを持ち品目名を持たないため）。
        // ローカル変数へ束縛してから判別する（`result.error`という
        // ネストしたプロパティ参照のままだと、`.find`コールバック内
        // ——クロージャ境界を越えた先——でTypeScriptの制御フロー解析による
        // 絞り込みが効かず、`menuItemId`が存在しない他メンバー込みの
        // 共用体型のままになる。ローカルconstへ一度取り出すことで
        // 絞り込みがクロージャを越えて保持される）。
        const error = result.error;
        const itemName =
          error.code === "ITEM_SOLD_OUT"
            ? view.menu.find((item) => item.id === error.menuItemId)?.name
            : undefined;
        setSubmission({
          kind: "business-error",
          code: error.code,
          itemName,
        });
        return;
      }

      // 成功: 冪等性キーを破棄し（次回は新しいキーで新しい送信サイクルへ）、
      // カートをクリアして次の注文ラウンドへ備える（要件1.7）。
      idempotencyKeyRef.current = null;
      setCart([]);
      setSubmission({ kind: "success" });
      // 自端末の送信結果を確定注文合計へ即時反映する（要件1.12。
      // 次回のポーリングtickを待たず、自分の送信は即座に確認できる方が
      // 体験として自然なため、成功直後に明示的な再取得を1回追加する）。
      void refreshConfirmedTotal();
    } catch {
      setSubmission({ kind: "network-error" });
    }
  }

  if (view.status === "loading") {
    return (
      <main className="p-4">
        <p>読み込み中...</p>
      </main>
    );
  }

  if (view.status === "error") {
    return (
      <main className="p-4">
        <h1 className="text-lg font-semibold">注文メニュー</h1>
        <p role="alert" className="mt-2 text-red-600">
          {view.message}
        </p>
      </main>
    );
  }

  if (view.status === "no-session") {
    // 要件1.3の完全な案内画面は6.4の責務。ここではクラッシュ・空白画面を
    // 避ける最小限の文言のみ表示する（tasks.md 6.1の指示に基づく意図的な
    // 割り切り）。
    return (
      <main className="p-4">
        <h1 className="text-lg font-semibold">ご案内をお待ちください</h1>
        <p className="mt-2 text-neutral-600">
          この卓はまだご案内前です。店員がご案内するまで少々お待ちください。
        </p>
      </main>
    );
  }

  const visibleMenu = view.menu.filter(
    (item) => genreFilter === "all" || item.genre === genreFilter,
  );

  return (
    <main className="min-h-screen bg-white pb-20">
      <header className="border-b border-neutral-100 px-4 py-3">
        <h1 className="text-lg font-semibold">注文メニュー</h1>
        <div className="mt-1 flex items-center gap-2">
          <span
            data-testid="table-label"
            className="rounded bg-neutral-100 px-2 py-0.5 text-sm text-neutral-600"
          >
            {view.table.label}
          </span>
          {cart.length > 0 ? (
            <button
              type="button"
              data-testid="cart-count"
              onClick={handleOpenCartPanel}
              className="rounded-full bg-neutral-900 px-2 py-0.5 text-xs text-white"
            >
              選択中の品目: {cart.length}件
            </button>
          ) : (
            <span
              data-testid="cart-count"
              className="text-xs text-neutral-400"
            >
              選択中の品目: {cart.length}件
            </span>
          )}
        </div>
      </header>

      <GenreTabs value={genreFilter} onChange={setGenreFilter} />

      <div>
        {visibleMenu.length === 0 ? (
          <p className="px-4 py-6 text-sm text-neutral-500">
            該当する品目がありません。
          </p>
        ) : (
          visibleMenu.map((item) => (
            <MenuItemCard key={item.id} item={item} onSelect={handleSelectItem} />
          ))
        )}
      </div>

      <ConfirmedTotalBar amount={view.confirmedTotal} />

      {selectedItem ? (
        <OptionSelectionPanel
          item={selectedItem}
          onCancel={handleCancelSelection}
          onConfirm={handleConfirmSelection}
        />
      ) : null}

      {cartPanelOpen ? (
        <CartPanel
          cart={cart}
          submission={submission}
          onClose={handleCloseCartPanel}
          onSubmit={() => void handleSubmit()}
        />
      ) : null}
    </main>
  );
}
