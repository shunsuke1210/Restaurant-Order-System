"use client";

type NoActiveSessionScreenProps = {
  table: { id: string; label: string };
};

/**
 * アクティブセッション不在時の案内画面（タスク6.4、要件1.1・1.3）。
 *
 * 要件1.1「客が卓のQRコードを読み取ると、客注文サービスは当該卓に紐づく
 * アクティブな来店セッションの有無を確認する」を受け、要件1.3「卓に
 * アクティブな来店セッションが存在しない場合、注文フォームの代わりに
 * スタッフを呼ぶよう促す案内を表示する」を実装する専用コンポーネント。
 *
 * ## 「エラーではなく通常の状態」という位置づけ
 * この状態は例外的な失敗（"error" ViewState）とは異なり、来店客の入れ替わり
 * 待ちという居酒屋の営業上ごく普通の状態である（design.md 来店セッションの
 * ライフサイクル図の`NoActiveSession`状態そのもの）。そのため`role="alert"`
 * のような警告的な表現は用いず、CallButton.tsxのエラー表示や
 * MenuScreen.tsxの"error" ViewStateと視覚的に区別する（赤系の配色を使わない）。
 *
 * ## mock-preview.htmlとの関係
 * mock-preview.html（`renderCustomer`関数、`!session`分岐）はこの状態を
 * 「ただいまご案内をお待ちください／この卓はまだご案内前です。スタッフが
 * 伺いますので、少々お待ちください。」という受動的な待機文言で表現している。
 * これは要件1.3が明示的に求める「スタッフを呼ぶよう促す」（客側からの
 * 能動的なアクションを促す）という表現までは踏み込んでいない
 * （モックはデモ用に最初からアクティブセッション有りの卓を前提に作られており、
 * 空き卓としての客画面はモック上で厳密に検証されたパターンではない）。
 * 本コンポーネントはmock-preview.htmlの基本レイアウト（タイトル・アイコン付き
 * 案内文というempty-stateパターン）を踏襲しつつ、文言は要件1.3の文言
 * （「スタッフを呼ぶよう促す」）に忠実に、客が能動的にスタッフへ声をかける
 * よう促す表現に改める。
 *
 * ## 卓ラベルを表示する理由
 * design.mdのOrderingContext.tableはこの状態でも常に返される
 * （`get_ordering_context`はテーブル自体が存在しさえすればactiveSessionの
 * 有無に関わらずtable情報を返す設計、0003_rpc_customer_gateway.sql参照）。
 * 客がスタッフへ声をかける際に自分の卓を正しく伝えられるよう、"ready"状態と
 * 同じ`data-testid="table-label"`で表示する（害がなく、有用なため）。
 *
 * ## 表示しないもの
 * メニュー一覧・カート・確定注文合計バー・呼び出しボタンはいずれも
 * 表示しない。呼び出しボタンは要件2.1により「卓にアクティブな来店セッションが
 * 存在する間」のみ表示するものであり、本状態はその対象外（MenuScreen.tsxの
 * "no-session"分岐はこのコンポーネントのみを描画してreturnするため、
 * 他のUIはそもそもDOM上に構築されない＝CSSで隠すのではなく到達不能）。
 */
export default function NoActiveSessionScreen({
  table,
}: NoActiveSessionScreenProps) {
  return (
    <main
      data-testid="no-active-session-screen"
      className="flex min-h-screen flex-col items-center justify-center gap-3 bg-white px-6 text-center"
    >
      <span
        data-testid="table-label"
        className="rounded bg-neutral-100 px-2 py-0.5 text-sm text-neutral-600"
      >
        {table.label}
      </span>
      <h1 className="text-lg font-semibold text-neutral-900">
        スタッフをお呼びください
      </h1>
      <p
        data-testid="no-active-session-message"
        className="max-w-xs text-sm leading-relaxed text-neutral-600"
      >
        この卓は現在、ご注文を承っておりません（来店受付前、またはお会計後の
        通常の状態です）。恐れ入りますが、お近くの店員にお声がけください。
      </p>
    </main>
  );
}
