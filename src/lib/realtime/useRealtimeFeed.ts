import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

/**
 * useRealtimeFeed — order_items/table_sessions/call_requestsへの
 * `postgres_changes`購読と、切断→再接続検知時の再同期ロジックをまとめた
 * 単一のフック。design.md「RealtimeFeed」コンポーネント（Implementation
 * Notes: 「単一のuseRealtimeFeedフックをorder/kitchen/registerの3ロールから
 * 利用し、購読対象テーブルと絞り込み条件のみパラメータ化する」）に対応する。
 *
 * Requirements: 1.12, 6.1, 6.8, 6.9
 * Design: .kiro/specs/table-order-kitchen/design.md の
 *   "RealtimeFeed" コンポーネント（Intent, Event Contract, Implementation
 *   Notes）を参照。
 *
 * ## パラメータ化の方針
 * このフック自身はどのテーブルにもどのロールにも依存しない。可変なのは
 * `subscriptions`（テーブル名＋イベント種別＋filter文字列の組。例えば
 * KitchenBoardなら`[{ table: "order_items" }]`、RegisterConsoleなら
 * `[{ table: "order_items" }, { table: "table_sessions" }, { table:
 * "call_requests" }]`、将来のCustomerOrderApp（P1）なら`[{ table:
 * "order_items", filter: "session_id=eq.<own session id>" }]`）と
 * `onSync`（呼び出し側が持つ再取得関数、例:
 * `() => listKitchenFeed(gateway, { storeId })`）の2つだけであり、
 * 特定の呼び出し元専用のロジックはフック内部に一切持たない。
 *
 * ## ペイロードを信頼しないという設計判断
 * `postgres_changes`が配信する変更行の中身（`payload.new`/`payload.old`）は
 * 一切読み取らず、画面状態の更新にも使わない。受信したイベントは
 * 「何かが変わったので最新状態を取り直せ」という合図としてのみ扱い、
 * 実際のデータは必ず呼び出し側の`onSync`（=`listKitchenFeed`/
 * `listRegisterFeed`/`getOrderingContext`という、サーバー側で権限・整合性を
 * 再検証する既存のRPCラッパー）経由で取得し直す。この方針により、
 * Realtimeペイロードの内容がどこまで信頼できるか（配信順序は保証されない
 * ことがdesign.mdのEvent Contractに明記されている）を気にする必要がなく、
 * design.mdおよびSecurity Considerations節が一貫して採用する「クライアント
 * 側で observed した内容をそのまま信用しない」という原則とも整合する。
 *
 * ## `postgres_changes_options: { wait: true }`について（本タスクの実機調査で判明）
 * `channel.subscribe()`はデフォルトでは、サーバー側の`postgres_changes`
 * 購読登録が実際に完了する前に`SUBSCRIBED`コールバックを報告しうる
 * （`@supabase/realtime-js`のRealtimeChannelOptionsの型定義コメントに明記。
 * 本タスクでローカルスタックに対する実機検証でも、`SUBSCRIBED`コールバックの
 * 直後に`realtime.subscription`テーブルへの行挿入がまだ完了していない
 * 瞬間があることを確認した）。この間隙で発生した変更はイベントとして
 * 配信されずサイレントに欠落しうる。`wait: true`を指定すると、サーバーが
 * 購読の確立を確認するまで`SUBSCRIBED`を保留し、確立できない場合
 * （例: 0008マイグレーションのpublication登録漏れ）は`CHANNEL_ERROR`
 * （`RealtimeDisabledForConfiguration`等）として明示的に失敗する
 * ことを実機で確認した。そのためこのフックは全チャンネルでこのオプションを
 * 指定し、「`SUBSCRIBED`と報告された時点＝サーバー側の購読も実際に有効」
 * という前提のもとで`onSync`を呼ぶ。
 *
 * ## 再接続時のみに限らず、SUBSCRIBEDのたびに`onSync`を呼ぶ設計
 * タスク5の観測可能な完了条件は「切断→再接続でonSyncが呼ばれ直すこと」だが、
 * 実装上は「初回購読確立時」と「切断後の再接続時」を特別扱いで区別せず、
 * `SUBSCRIBED`ステータスを受け取るたびに常に`onSync`を呼ぶ（＝初回もある種の
 * 「未接続→接続」への遷移として扱う）。これにより2つの観測可能な完了条件
 * （「初回購読時にonSyncが呼ばれる」「再接続時にも呼ばれ直す」）を単一の
 * シンプルな規則で満たす。
 */

export type RealtimeFeedStatus = "connected" | "disconnected";

/** postgres_changesで実際に発生しうるイベント種別（`*`は全種別）。 */
export type RealtimeFeedEvent = "INSERT" | "UPDATE" | "DELETE" | "*";

export interface RealtimeFeedSubscription {
  /** 購読対象テーブル（`public`スキーマ内のテーブル名、型安全のためDatabase型のテーブル名に限定する）。 */
  table: keyof Database["public"]["Tables"] & string;
  /** 対象イベント種別。省略時は`"*"`（INSERT/UPDATE/DELETEすべて）。 */
  event?: RealtimeFeedEvent;
  /**
   * Supabase Realtimeのfilter構文（例: `"session_id=eq.<uuid>"`）。
   * 省略時は絞り込みなし（テーブル全体を購読）。
   */
  filter?: string;
}

export interface UseRealtimeFeedOptions {
  /**
   * 呼び出し側が生成済みのSupabaseクライアント。他のGateway群
   * （customerOrderingGateway.ts等）と同じ依存性注入（DI）パターンを踏襲し、
   * このフック自身は`createBrowserClient()`を呼ばない
   * （テスト時にモッククライアントを注入できるようにするため）。
   */
  client: SupabaseClient<Database>;
  /**
   * Realtimeチャンネル名。呼び出し元（order/kitchen/register）ごとに
   * 一意な名前を渡すこと（例: `"kitchen-feed"`, `"register-feed"`,
   * `"customer-order-feed-<sessionId>"`）。
   */
  channelName: string;
  /**
   * 購読対象のテーブル＋絞り込み条件の組。design.mdが要求する
   * 「購読対象テーブルと絞り込み条件のみパラメータ化する」の実体。
   * 呼び出し側が毎レンダーで新しい配列リテラルを渡しても、内容
   * （JSON表現）が変わらない限り購読は張り直さない（内部でシリアライズして
   * 比較する）ため、呼び出し側での`useMemo`は必須ではない。
   */
  subscriptions: ReadonlyArray<RealtimeFeedSubscription>;
  /**
   * 初回購読確立時、および切断→再接続を検知した際に呼び出す再取得関数
   * （`listKitchenFeed`/`listRegisterFeed`/`getOrderingContext`等、
   * 呼び出し側が自身の引数を束縛済みのクロージャとして渡す）。
   * 例外はこのフックが捕捉しない（呼び出し側の責務。
   * customerOrderingGateway.tsの「未知のエラーは例外として伝播させる」
   * 方針を踏襲する）。
   */
  onSync: () => void | Promise<void>;
  /**
   * `false`の間は購読を確立しない（例: デバイスセッション確立待ち）。
   * 省略時`true`。
   */
  enabled?: boolean;
}

export interface UseRealtimeFeedResult {
  /** 現在の接続状態。design.md 要件6.9（接続断表示）向けに公開する。 */
  status: RealtimeFeedStatus;
}

export function useRealtimeFeed(
  options: UseRealtimeFeedOptions,
): UseRealtimeFeedResult {
  const { client, channelName, subscriptions, enabled = true } = options;
  // `connectionStatus`はsubscribeコールバック/クリーンアップからのみ更新する
  // （enabled=falseのケースは下部のreturn文で導出し、effect本体で同期的に
  // setStateしない。`react-hooks/set-state-in-effect`対策）。
  const [connectionStatus, setConnectionStatus] =
    useState<RealtimeFeedStatus>("disconnected");

  // onSyncは呼び出し側のレンダーごとに新しい関数参照になりうる
  // （クロージャでgateway/引数を束縛するため）。refに逃がすことで、
  // onSyncの参照が変わるたびに購読を張り直す（＝不要な再接続）ことを防ぐ。
  const onSyncRef = useRef(options.onSync);
  useEffect(() => {
    onSyncRef.current = options.onSync;
  });

  // 呼び出し側が`subscriptions`に毎レンダー新しい配列リテラルを渡しても、
  // 実質的な内容が変わらなければ購読を張り直さないよう、内容を
  // シリアライズした文字列をeffectの依存値にする。
  const subscriptionsKey = JSON.stringify(subscriptions);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    const channel = client.channel(channelName, {
      config: {
        // 実機調査で判明した「SUBSCRIBEDがpostgres_changes登録完了より
        // 早く報告されうる」問題への対処（ファイル冒頭コメント参照）。
        postgres_changes_options: { wait: true, timeout: 10000 },
      },
    });

    for (const subscription of subscriptions) {
      channel.on(
        "postgres_changes",
        {
          event: subscription.event ?? "*",
          schema: "public",
          table: subscription.table,
          ...(subscription.filter ? { filter: subscription.filter } : {}),
        },
        () => {
          // ペイロードの中身は信頼しない（ファイル冒頭コメント参照）。
          // 「何かが変わった」という合図としてonSyncを呼び直すだけ。
          if (!cancelled) {
            void onSyncRef.current();
          }
        },
      );
    }

    channel.subscribe((rawStatus: string, err?: Error) => {
      if (cancelled) {
        return;
      }
      if (rawStatus === "SUBSCRIBED") {
        setConnectionStatus("connected");
        // 初回購読確立時・再接続時のいずれも同じ扱いでonSyncを呼ぶ
        // （ファイル冒頭コメント「再接続時のみに限らず〜」参照）。
        void onSyncRef.current();
        return;
      }
      // "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR"
      // （デフォルトエクスポートされないREALTIME_SUBSCRIBE_STATES enumの
      // 値。ファイル冒頭コメント参照。エラー詳細はerrに入るが、
      // このフックは接続状態の二値化のみを責務とし、詳細なエラー内容は
      // 呼び出し側の関心事ではないため保持しない）。
      void err;
      setConnectionStatus("disconnected");
    });

    return () => {
      cancelled = true;
      setConnectionStatus("disconnected");
      void client.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscriptionsKeyがsubscriptionsの実質的な内容変化を表す
  }, [client, channelName, subscriptionsKey, enabled]);

  // enabled=falseの間は、内部状態（前回接続していた名残）に関わらず
  // 常に"disconnected"を返す（effect本体でsetStateせず導出する。
  // ファイル冒頭のconnectionStatus宣言コメント参照）。
  return { status: enabled ? connectionStatus : "disconnected" };
}
