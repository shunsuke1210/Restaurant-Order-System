"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  createCustomerOrderingGateway,
  type MenuItemView,
  type OrderingContext,
} from "@/lib/gateways/customerOrderingGateway";
import GenreTabs, { type GenreFilter } from "./GenreTabs";
import SubTabs, { type SubTabFilter } from "./SubTabs";
import MenuItemCard from "./MenuItemCard";
import OptionSelectionPanel, {
  type ItemSelection,
  type OptionValue,
} from "./OptionSelectionPanel";
import ConfirmedTotalBar from "./ConfirmedTotalBar";
import CartPanel, { type CartSubmissionState } from "./CartPanel";
import CallButton, { type CallButtonState } from "./CallButton";
import NoActiveSessionScreen from "./NoActiveSessionScreen";

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
      // タスク6.3で追加。呼び出しボタン（要件2.1-2.3）が「今、呼び出しが
      // 未対応で存在するか」を判定するためのサーバー側の真の状態
      // （`getOrderingContext`の`hasOpenCallRequest`）。handleCallStaffの
      // 楽観的更新（成功/CALL_ALREADY_OPEN直後）もこのフィールドを直接
      // 書き換える（下記コメント参照）。
      hasOpenCallRequest: boolean;
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
 *
 * ## タスク6.4での拡張: "no-session"状態でもポーリングを継続する設計判断
 * 6.1時点では、アクティブセッションが無い場合の画面（"no-session"）は
 * クラッシュ・空白画面を避けるための最小限の案内文のみで、ポーリングの
 * 対象にも含まれていなかった（下記のポーリング用useEffectは
 * `view.status !== "ready"`の間は何もしない実装だった）。そのため、
 * レジが入店操作（`start_session`）を行ってアクティブセッションが
 * 作成された後も、客が手動でページを再読み込みしない限り案内画面の
 * ままだった。
 *
 * これはrequirements.md 1.1「客が卓のQRコードを読み取ると、アクティブな
 * 来店セッションの有無を確認する」を一度きりのチェックとしか読んでおらず、
 * 本プロジェクトが6.2（確定注文合計のライブ更新）・6.3（呼び出し対応済みの
 * 検知）で一貫して確立してきた「サーバー側の状態変化を、客に手動再読み込みを
 * 要求せずポーリングで追随する」というUXパターンとも整合しない。
 * design.md「来店セッションのライフサイクル」図・CustomerOrderApp要約は
 * "no-session"状態でのポーリング可否について明示的な制約を置いておらず
 * （`getOrderingContext`はテーブルが存在する限りactiveSessionの有無に
 * 関わらず呼び出し可能、0003_rpc_customer_gateway.sql参照）、要件・設計と
 * 矛盾しないため、6.4の実装判断として"no-session"状態でも同じ
 * `refreshOrderingContext`・同じ5秒間隔ポーリングを継続し、レジの
 * 入店操作を検知した時点で自動的にメニュー画面（"ready"）へ遷移させる
 * （下記のポーリング用useEffectとrefreshOrderingContext内のガード条件を
 * "ready"だけでなく"no-session"も対象に含める）。新しいポーリングループは
 * 追加せず、既存の仕組みへ相乗りするだけに留める。
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
    hasOpenCallRequest: context.hasOpenCallRequest,
  };
}

/**
 * 客の卓側QR注文画面の実体（design.md CustomerOrderApp）。
 * page.tsxからtableIdを受け取り、CustomerOrderingGatewayに依存して
 * メニュー閲覧・ジャンル別タブ・オプション選択UI（タスク6.1）、
 * 注文送信・確定注文合計の常時表示・通信断ハンドリング（タスク6.2）を
 * 提供する。呼び出しボタンの表示・送信・重複防止表示（タスク6.3、
 * 要件2.1-2.3）も本コンポーネント（CallButton.tsxへ委譲）が担う。
 *
 * アクティブセッション不在時の専用案内画面（タスク6.4、要件1.1・1.3）は
 * NoActiveSessionScreen.tsxへ委譲する（CallButton/ConfirmedTotalBar等と
 * 同じ「表示専用コンポーネントへの委譲」という既存パターンを踏襲）。
 * この分岐では要件2.1により呼び出しボタンも表示しない（呼び出しボタンは
 * アクティブセッションがある間のみ表示するものであり、
 * NoActiveSessionScreen自体がその他のUI一式と共にレンダリングされない
 * ためDOM上にも存在しない）。"no-session"状態でもポーリングを継続し
 * レジの入店操作を自動検知する設計判断は上記のポーリング間隔コメント
 * （CONFIRMED_TOTAL_POLL_INTERVAL_MS直前）を参照。
 */
export default function MenuScreen({ tableId }: MenuScreenProps) {
  const gateway = useMemo(
    () => createCustomerOrderingGateway(createBrowserClient()),
    [],
  );

  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [genreFilter, setGenreFilter] = useState<GenreFilter>("all");
  // ジャンル内サブタブの選択状態（0016で追加）。ジャンルタブ自体を
  // 切り替えたときは、以前のジャンルのサブカテゴリ選択を持ち越さないよう
  // 下のhandleGenreChangeでnullへリセットする。
  const [subCategoryFilter, setSubCategoryFilter] =
    useState<SubTabFilter>(null);
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

  // 呼び出しボタン（要件2.1-2.3）の一時的なUI状態（送信中/エラー）。
  // 「今、呼び出しが未対応で存在するか」自体はUI状態ではなくViewState.
  // hasOpenCallRequest（サーバー側の真の状態＋楽観的更新の合成、下記
  // handleCallStaffコメント参照）で表現するため、ここでは含めない
  // （CartSubmissionStateがカート内容自体を持たないのと同じ設計）。
  const [callState, setCallState] = useState<CallButtonState>({
    kind: "idle",
  });

  // 独立レビューで発見されたレース条件の修正: hasOpenCallRequestに関する
  // 「今分かっている最新の真実」を単調な順序で扱うための機構。
  //
  // 問題（再現手順）: (1) ポーリング要求Nが送信される（サーバーはまだ
  // 応答していない）。(2) その応答が届く前に客が呼び出しボタンをタップし、
  // handleCallStaffがcreateCallRequestの成功/CALL_ALREADY_OPENを受けて
  // hasOpenCallRequestをtrueへ楽観的更新する。この時点で呼び出しは実際に
  // サーバー上でopenになっている。(3) ところが要求Nはタップより"前"に
  // 送信されたものであり、その応答は「タップ時点ではまだ呼び出しが
  // 無かった」というhasOpenCallRequest: falseを正しく（が古く）返す。
  // refreshOrderingContextが応答をそのままview全体へ無条件に上書きする
  // 実装だと、この古い応答が楽観的更新を巻き戻し、実際には対応済みでない
  // 呼び出しがボタンを再度「スタッフを呼ぶ」（再送可能）に戻してしまう
  // ——本タスクの観測可能な完了条件「対応済みになるまでボタンが再送不可の
  // 状態を示す」に直接違反する。
  //
  // 修正方針: 「N秒間は無視する」といった時間ベースのヒューリスティックは
  // 別のタイミングで同種のレースを再発させうるため採用しない。代わりに、
  // ポーリング要求の送信とhasOpenCallRequestの楽観的確定の両方が汲み取る
  // 単一の単調カウンタ（sequenceRef）による厳密な順序関係を導入する。
  // - ポーリング要求を送信する瞬間（refreshOrderingContext内、await前）に
  //   その要求自身の順序番号を採番する。
  // - handleCallStaffがhasOpenCallRequestをtrueへ確定させる瞬間
  //   （成功/CALL_ALREADY_OPENのいずれも）に、lastCallStateSeqRefへ
  //   新しい順序番号を採番して記録する。
  // - ポーリング応答が届いた時点で、その要求が採番された順序番号が
  //   lastCallStateSeqRef（＝直近の楽観的確定）より前であれば、その応答は
  //   「楽観的確定より古い時点のサーバー状態」を反映しているに過ぎないと
  //   判断し、hasOpenCallRequestフィールドだけは上書きせず温存する
  //   （confirmedTotal等の他フィールドは通常どおり最新化する。真に古い
  //   のはhasOpenCallRequestという1フィールドの意味だけであるため）。
  // - 逆に、楽観的確定より"後"に送信されたポーリング要求（sequenceRefは
  //   単調増加のため、要求送信時点で必ずlastCallStateSeqRefより大きい
  //   値になる）は、その時点で既にサーバーが呼び出しopenの事実を反映
  //   できているはずであり、通常どおり適用する。これにより、レジ側が
  //   対応済みにした後の正当なfalseへの更新は一切ブロックされない
  //   （「一度でも楽観的更新した後は永久に無視する」といった過剰な抑制には
  //   ならない設計）。
  const sequenceRef = useRef(0);
  const lastCallStateSeqRef = useRef(0);

  // 独立レビューで発見されたバグの修正（本タスク6.4の差し戻し対応）:
  // 卓のQRコードは客グループが入れ替わるたびに再利用されるが、要件4.4に
  // より新しい来店セッションには必ず新しい（前回とは異なる）sessionIdが
  // 割り当てられる。ところがcart/cartPanelOpen/submission/callState/
  // idempotencyKeyRef.currentはいずれも「暗黙のうちに直前にアクティブ
  // だったセッションに紐づく」ローカル状態でありながら、sessionIdが実際に
  // 変わったこと（＝別の、無関係な客グループへの入れ替わり）を検知して
  // リセットする仕組みが一切無かった。
  //
  // 再現手順（レビューで確認済み）: (1) セッションAのカートに品目を追加。
  // (2) ポーリングが来店セッション終了を検知し"no-session"へ遷移。
  // (3) さらにポーリングが、後から着席した別の客グループの新しい
  // セッションB（sessionIdはAとは別物）を検知して"ready"へ復帰。この
  // サイクルの後もセッションAのカートの中身がそのままセッションBの画面に
  // 残っており、セッションBの客がそれに気づかず送信すると、セッションA
  // の品目がセッションBの正当な注文へ紛れ込む——要件4のセッション整合性
  // が存在する目的そのものに反する、客グループ間の会計混同である。
  // 同根の問題（前のセッションの一時的なUI状態が次のセッションの画面に
  // 漏れる）が呼び出しボタンのエラー表示（callState）・カートパネルの
  // 開閉状態（cartPanelOpen）・送信結果表示（submission）についても
  // レビューで確認された。idempotencyKeyRef.currentはsubmit_orderの
  // 重複排除が(session_id, idempotency_key)の組み合わせで判定される
  // ため厳密には別セッションへ誤適用されることはないが、一貫性・
  // 防御的な観点から他の4つと合わせてリセットする。
  //
  // 修正方針: 「直近にリセット済みのsessionId」を単調に追跡する
  // lastSessionIdRefを導入し、toReadyStateの結果が"ready"かつ
  // そのsessionIdがlastSessionIdRef.currentと異なる場合
  // （"no-session"→"ready"の遷移、初回マウントでの最初の"ready"遷移、
  // および万一"ready"(A)→"ready"(B)がポーリングを跨がず直接届いた
  // 場合の防御的なケースも含む）にのみ、上記5つの状態を初期値へ一括で
  // リセットする。sessionIdが変わらない通常のポーリング
  // （confirmedTotal/hasOpenCallRequest/メニューの更新のみ）では
  // 一切発火させない（進行中のカートを不必要にクリアするという別の
  // regressionを避けるため）。判定・リセットの実行はいずれも
  // resetSessionScopedStateという単一の箇所に集約し、初回読み込み
  // （下記マウント時useEffect）とポーリング（refreshOrderingContext）の
  // 両方の呼び出し元がこれを経由することで、分岐の重複・漏れを防ぐ。
  //
  // 6.3のhasOpenCallRequest陳腐化抑制ガード（sequenceRef/
  // lastCallStateSeqRef、prev.status === "ready"での絞り込み、直上）とは
  // 独立した別の関心事であり、その既存ロジックは変更しない
  // （本リセットはその上に追加されるだけで、置き換えるものではない）。
  const lastSessionIdRef = useRef<string | null>(null);

  /**
   * per-session-scopedなクライアント状態（cart/cartPanelOpen/
   * submission/callState/idempotencyKeyRef.current）を初期値へ一括
   * リセットし、lastSessionIdRef.currentを新しいsessionIdへ更新する
   * 唯一の経路（上記lastSessionIdRefコメント参照）。呼び出し元
   * （マウント時useEffect・refreshOrderingContextの双方）が
   * 「sessionIdが実際に変わったか」を判定した上で、変わった場合にのみ
   * newSessionId（toReadyStateが返す新しい"ready"状態のsessionId）を
   * 渡して呼ぶ。
   */
  const resetSessionScopedState = useCallback((newSessionId: string) => {
    lastSessionIdRef.current = newSessionId;
    setCart([]);
    setCartPanelOpen(false);
    setSubmission({ kind: "idle" });
    setCallState({ kind: "idle" });
    idempotencyKeyRef.current = null;
  }, []);

  /**
   * handleCallStaffの成功/CALL_ALREADY_OPENの両方から呼ばれる、
   * hasOpenCallRequestをtrueへ確定させる唯一の経路（上記sequenceRefの
   * コメント参照）。ここでlastCallStateSeqRefへ新しい順序番号を記録して
   * から状態を更新することで、この確定より前に送信されていた
   * ポーリング要求の（古い）応答がこのtrueを巻き戻せないようにする。
   */
  const markCallRequestOpen = useCallback(() => {
    lastCallStateSeqRef.current = ++sequenceRef.current;
    setView((prev) =>
      prev.status === "ready" ? { ...prev, hasOpenCallRequest: true } : prev,
    );
  }, []);

  /**
   * 確定注文合計（要件1.12）と呼び出し中表示（要件2.1-2.3）の両方の
   * ライブ更新を担う背景再取得。6.2で確定した「`getOrderingContext`の
   * 定期ポーリングに相乗りする」という設計判断（ファイル冒頭コメント参照）を
   * 6.3のhasOpenCallRequestにもそのまま適用する——新しいポーリングループを
   * 追加しない（toReadyStateが両フィールドを一括して最新化するため、この
   * 関数自体は変更不要で、呼び出し元を増やすだけで済む）。
   *
   * バックグラウンド再取得（ポーリング/送信成功直後）の失敗は画面を
   * 壊さないよう握りつぶす。ネットワーク断の明示的なハンドリングは
   * 注文送信時（handleSubmit）の責務であり、ここでは「次回また
   * 取得を試みる」という単純なベストエフォートに徹する（要件1.11とは
   * 別の関心事）。
   *
   * タスク6.4での拡張: "no-session"状態からもこの関数が呼ばれるように
   * なった（下記ポーリング用useEffect参照）。"no-session"→"ready"（レジの
   * 入店操作を検知）だけでなく、"ready"→"no-session"（来店セッション終了を
   * 検知）の両方向の遷移が起こりうるが、いずれもtoReadyStateが
   * `context.activeSession`の有無だけから機械的に導出するため、本関数
   * 自体の分岐ロジックを増やす必要はない。ただしhasOpenCallRequestの
   * 楽観的確定（sequenceRef）は"ready"状態（呼び出しボタンが存在する間）
   * にしか意味を持たないため、直前の状態が"ready"だった場合に限って
   * その調停ロジックを適用する（下記ガード参照）。
   */
  const refreshOrderingContext = useCallback(async () => {
    // 上記sequenceRefのコメント参照: この要求"送信"の瞬間（await前）に
    // 順序番号を採番する。応答が届いた時点でこの値をlastCallStateSeqRef
    // と比較し、この要求がhandleCallStaffの楽観的確定より前に送信された
    // ものであれば、その応答のhasOpenCallRequestは古いとみなして温存する。
    const requestSeq = ++sequenceRef.current;
    try {
      const result = await gateway.getOrderingContext({ tableId });
      if (!result.ok) {
        return;
      }
      const next = toReadyState(result.value);

      // 独立レビューで発見されたバグの修正（上記lastSessionIdRef/
      // resetSessionScopedStateコメント参照）: sessionIdが実際に
      // 変わったかどうかは、下記setViewの関数更新子が受け取るprevには
      // 依存させず、ここでlastSessionIdRef.currentとの比較により判定
      // する。prevは"no-session"のことがあり（sessionId自体を持たない）、
      // また万一"ready"(A)→"ready"(B)が直接届いた場合でも、
      // lastSessionIdRef.currentとの比較なら一貫して検知できるため
      // （prev.sessionIdとの比較だけに頼ると、直前が"no-session"だった
      // 場合に判定できない）。
      let sessionChanged = false;
      if (next.status === "ready" && next.sessionId !== lastSessionIdRef.current) {
        sessionChanged = true;
        resetSessionScopedState(next.sessionId);
      }

      setView((prev) => {
        // タスク6.4: "ready"に加えて"no-session"の間もこの再取得結果を
        // 適用する（"no-session"→"ready"の自動遷移、および"ready"→
        // "no-session"の逆方向の両方を成立させるため）。"loading"/"error"
        // の間は6.1/6.2と同じく何もしない（初回読み込みのuseEffectと
        // 責務が競合しないようにする既存方針を維持）。
        if (prev.status !== "ready" && prev.status !== "no-session") {
          return prev;
        }
        if (next.status !== "ready") {
          return next;
        }
        if (
          !sessionChanged &&
          prev.status === "ready" &&
          requestSeq < lastCallStateSeqRef.current
        ) {
          // この要求は、直近の楽観的確定（handleCallStaff）より前に
          // 送信されていた。hasOpenCallRequestに関してはその確定より
          // 古いサーバー状態を反映しているに過ぎないため上書きしない
          // （他フィールドは通常どおり最新化する）。呼び出しボタンは
          // "ready"状態でしか存在せず楽観的確定も起こり得ないため、
          // 直前が"no-session"だった場合（＝今回が"no-session"→"ready"の
          // 遷移）はこの調停自体が無関係であり、常にnextをそのまま使う
          // （sessionChangedの条件も参照: sessionIdが変わった今回は
          // セッションBのhasOpenCallRequestがセッションAの楽観的確定とは
          // 無関係な独立した事実であるため、この調停自体を無効化し常に
          // サーバー応答をそのまま信頼する）。
          return { ...next, hasOpenCallRequest: prev.hasOpenCallRequest };
        }
        return next;
      });
    } catch {
      // 上記コメントの通り無視する。
    }
  }, [gateway, tableId, resetSessionScopedState]);

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

        const next = toReadyState(result.value);
        if (
          next.status === "ready" &&
          next.sessionId !== lastSessionIdRef.current
        ) {
          // 独立レビューで発見されたバグの修正（上記lastSessionIdRef/
          // resetSessionScopedStateコメント参照）: 初回読み込みでの
          // 最初の"ready"遷移もリセット対象に含める。マウント直後は
          // 各stateが既に初期値のため実質的な副作用はないが、ここで
          // lastSessionIdRef.currentを確定させることが重要——これにより
          // 以降のポーリング（refreshOrderingContext）が「sessionIdが
          // 変わったかどうか」を正しく判定できるようになる。
          resetSessionScopedState(next.sessionId);
        }
        setView(next);
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
  }, [gateway, tableId, resetSessionScopedState]);

  // 確定注文合計のライブ更新（要件1.12、ファイル冒頭コメントの設計判断
  // 「案A: ポーリング」参照）と、タスク6.4で追加したアクティブセッション
  // 不在時の自動遷移の両方を、同一のポーリングループで実現する。
  // "ready"（activeSessionがある）だけでなく"no-session"（無い）の間も
  // 一定間隔で再取得する（6.4の設計判断、ファイル冒頭
  // CONFIRMED_TOTAL_POLL_INTERVAL_MS直前のコメント参照）。"loading"/
  // "error"の間は行わない（初回読み込み自体がまだ完了していない、または
  // 致命的なエラー状態であり、ポーリングで自己回復させる設計にはしていない
  // ——エラー画面からの回復は要求されていない）。
  //
  // ポーリング自体が成功してもstatusが"ready"⇔"no-session"間で変化しない
  // 限りこのeffectは再実行されない（依存配列はview.statusのみ。
  // confirmedTotal等の中身の変化では依存配列は変わらないため、インターバルが
  // 不要に張り直されることはない）。"ready"⇔"no-session"間の遷移が起きた
  // 場合はeffectが再実行されクリーンアップ後に新しいインターバルが
  // 張られるが、同じ間隔・同じ関数での張り直しに過ぎず観測可能な副作用はない。
  useEffect(() => {
    if (view.status !== "ready" && view.status !== "no-session") {
      return;
    }
    const interval = setInterval(() => {
      void refreshOrderingContext();
    }, CONFIRMED_TOTAL_POLL_INTERVAL_MS);
    return () => {
      clearInterval(interval);
    };
  }, [view.status, refreshOrderingContext]);

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
      void refreshOrderingContext();
    } catch {
      setSubmission({ kind: "network-error" });
    }
  }

  /**
   * 呼び出しボタン（要件2.1-2.3）のタップハンドラ。
   *
   * tasks.md Implementation Notes: customerOrderingGatewayの各メソッドは
   * ドキュメント化されたエラーコード以外の予期しない失敗（ネットワーク断等）
   * をResultに含めず例外としてthrowするため、必ずtry/catchで捕捉する。
   *
   * 設計判断（design.mdのCallRequestError型注釈、0003_rpc_customer_gateway.sql
   * 設計判断8のコメント「将来のUIタスク（6.3）は、このエラーを『対応済みに
   * なるまで再送不可を示す』というソフトな状態表示に変換すればよく、致命的な
   * 失敗として扱う必要はない」を踏襲）: 成功時とCALL_ALREADY_OPEN時のどちらも
   * 「今、呼び出しが未対応で存在する」という同じ意味の事実を表すため、
   * ViewState.hasOpenCallRequestを同じ形でtrueへ楽観的に更新する
   * （createCallRequestの応答・エラーいずれも「呼び出しは今open」という
   * 事実を直接示しており、次のポーリングtickを待つ必要がない。6.2の
   * 「送信成功直後にrefreshOrderingContextを1回追加する」という即時反映の
   * 考え方と同じ）。対応済みへの遷移（resolved）自体はサーバー側の
   * 再検証でしか知りえないため、ここでは検知せず既存のポーリング
   * （refreshOrderingContext、5秒間隔）に委ねる。
   */
  async function handleCallStaff() {
    if (view.status !== "ready" || view.hasOpenCallRequest) {
      return;
    }

    setCallState({ kind: "submitting" });

    try {
      const result = await gateway.createCallRequest({
        sessionId: view.sessionId,
      });

      if (!result.ok) {
        if (result.error.code === "CALL_ALREADY_OPEN") {
          // 致命的なエラーではない: 客の意図（スタッフに来てほしい）は
          // 既に満たされている。警告的な文言を出さず、通常の「呼び出し中」
          // 状態へ収束させる。
          setCallState({ kind: "idle" });
          markCallRequestOpen();
          return;
        }

        // SESSION_NOT_ACTIVE: ボタンはactiveSessionがある間しか表示されない
        // ため通常は起こらないが、直前にセッションが終了した場合に発生しうる
        // （防御的ハンドリング）。専用メッセージを表示しつつ、次のポーリングで
        // 「ご案内をお待ちください」画面へ正しく遷移できるよう最新状態を
        // 明示的に取得し直す。
        setCallState({
          kind: "error",
          message:
            "このご来店セッションは既に終了しています。お手数ですが、スタッフをお呼びください。",
        });
        void refreshOrderingContext();
        return;
      }

      setCallState({ kind: "idle" });
      markCallRequestOpen();
    } catch {
      setCallState({
        kind: "error",
        message:
          "呼び出しの送信に失敗しました。ネットワーク接続をご確認のうえ、もう一度お試しください。",
      });
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
    // タスク6.4・要件1.1/1.3: 注文フォームの代わりにスタッフを呼ぶよう
    // 促す専用案内画面（NoActiveSessionScreen.tsx参照）。ここで早期return
    // するため、以降のメニュー・カート・確定注文合計バー・呼び出しボタンの
    // JSXは一切構築されない（CSSで隠すのではなく、そもそもDOM上に
    // 存在しない）。"ready"へ遷移した場合の自動再表示は上記ポーリング
    // 用useEffectが担う。
    return <NoActiveSessionScreen table={view.table} />;
  }

  // ジャンルタブでの絞り込み（サブタブの選択肢導出にも使う、subCategoryでの
  // 絞り込みより前の段階）。「おすすめ」（0016で追加）はジャンルを問わず
  // recommended: trueの品目を横断表示する（mock-preview.htmlのosusume分岐
  // `state.menu.filter(m => m.recommend)`と同じ意味）。
  const itemsInSelectedGenre =
    genreFilter === "all" || genreFilter === "recommended"
      ? view.menu
      : view.menu.filter((item) => item.genre === genreFilter);

  const visibleMenu =
    genreFilter === "recommended"
      ? view.menu.filter((item) => item.recommended)
      : itemsInSelectedGenre.filter(
          (item) =>
            subCategoryFilter === null ||
            item.subCategory === subCategoryFilter,
        );

  // ジャンルタブを切り替えたら、前のジャンルのサブカテゴリ選択を持ち越さない
  // （例: 「一品」で「おつまみ」を選んだ状態から「ドリンク」へ切り替えた際、
  // ドリンクには存在しない「おつまみ」フィルタが暗黙に残り続けるのを防ぐ）。
  function handleGenreChange(next: GenreFilter) {
    setGenreFilter(next);
    setSubCategoryFilter(null);
  }

  return (
    <main className="min-h-screen bg-white pb-20">
      <div className="sticky top-0 z-10 bg-white">
        <header className="border-b border-neutral-100 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 shrink-0 items-center gap-2">
              <h1 className="text-lg font-semibold whitespace-nowrap">
                注文メニュー
              </h1>
              <span
                data-testid="table-label"
                className="rounded bg-neutral-100 px-2 py-0.5 text-sm text-neutral-600"
              >
                {view.table.label}
              </span>
            </div>
            {/* 右上に「スタッフ呼出しボタン→選択中の品目：〇件→注文確認
                ボタン」の順で並べる（ユーザーからの指摘に基づく並び順）。
                以前は「選択中の品目」自体がクリック可能なボタンだった
                （カートが空の間はそもそもクリックできず、カート内容の
                レビュー導線が分かりづらかった）。今は常時表示・常時活性の
                「注文確認」ボタンを別に設け、テキストとボタンの役割を
                分離した。 */}
            <div className="flex shrink-0 items-center gap-2">
              <CallButton
                open={view.hasOpenCallRequest}
                state={callState}
                onCall={() => void handleCallStaff()}
              />
              <span
                data-testid="cart-count"
                className="text-xs text-neutral-500"
              >
                選択中の品目: {cart.length}件
              </span>
              <button
                type="button"
                data-testid="order-confirm-button"
                onClick={handleOpenCartPanel}
                disabled={cart.length === 0}
                className="rounded-full bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
              >
                注文確認
              </button>
            </div>
          </div>
        </header>

        <GenreTabs value={genreFilter} onChange={handleGenreChange} />
        {genreFilter !== "all" && genreFilter !== "recommended" ? (
          <SubTabs
            items={itemsInSelectedGenre}
            value={subCategoryFilter}
            onChange={setSubCategoryFilter}
          />
        ) : null}
      </div>

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
