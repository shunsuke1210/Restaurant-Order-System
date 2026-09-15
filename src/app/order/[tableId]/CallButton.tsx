"use client";

/**
 * 呼び出しボタン（design.md CustomerOrderApp要約、タスク6.3、要件2.1-2.3）。
 *
 * ## 表示状態の情報源が2種類ある理由
 * このボタンが示す「呼び出し中」表示は、2つの異なる情報源のどちらかによって
 * 決まる（呼び出し元のMenuScreen.tsxが両方を合成して`open`として渡す）。
 * - サーバー側の`hasOpenCallRequest`（`getOrderingContext`の応答、6.3で追加。
 *   0010_ordering_context_call_request.sql）: 対応済み（resolved）への遷移を
 *   検知できる唯一の経路（design.mdのSecurity Considerations「クライアントの
 *   表示状態を信用しない」という一貫方針に従い、6.2で確立済みの5秒間隔
 *   ポーリングにそのまま相乗りする）。
 * - `createCallRequest`呼び出し直後のローカル状態: 成功応答または
 *   `CALL_ALREADY_OPEN`エラーのいずれも「今まさに呼び出しが未対応で存在する」
 *   ことを直接示すため、次のポーリングtick（最大5秒）を待たずに即座に
 *   「呼び出し中」へ切り替える（6.2のconfirmedTotal即時反映と同じ考え方）。
 *
 * 本コンポーネント自体はこの合成結果（`open`）と、送信中/エラーの一時的な
 * UI状態（`state`）を受け取って表示するだけの表示専用コンポーネントとする
 * （CartPanel/ConfirmedTotalBarと同じ責務分割。実際のcreateCallRequest
 * 呼び出し・状態の合成はすべてMenuScreen.tsxの責務）。
 */
export type CallButtonState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string };

type CallButtonProps = {
  /**
   * サーバー側の真の状態（`hasOpenCallRequest`）とローカルの楽観的状態
   * （直近の呼び出し成功/CALL_ALREADY_OPEN）を合成した「今、呼び出しが
   * 未対応で存在するか」。trueの間はボタンを無効化し「呼び出し中」を表示する
   * （観測可能な完了条件: 対応済みになるまでボタンが再送不可の状態を示す）。
   */
  open: boolean;
  state: CallButtonState;
  onCall: () => void;
};

export default function CallButton({ open, state, onCall }: CallButtonProps) {
  const submitting = state.kind === "submitting";
  const disabled = open || submitting;

  const label = open ? "呼び出し中" : submitting ? "送信中..." : "スタッフを呼ぶ";

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        data-testid="call-button"
        aria-pressed={open}
        onClick={onCall}
        disabled={disabled}
        className={
          "shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed " +
          (open
            ? "bg-neutral-200 text-neutral-500"
            : "bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-60")
        }
      >
        {label}
      </button>
      {state.kind === "error" ? (
        <p role="alert" className="max-w-[10rem] text-right text-[11px] text-red-600">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
