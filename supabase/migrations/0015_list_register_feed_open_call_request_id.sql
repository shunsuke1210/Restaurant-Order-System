-- 0015_list_register_feed_open_call_request_id.sql
-- table-order-kitchen: list_register_feedの各卓にopenCallRequestIdを追加する
--
-- Requirements: 2.4
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "StaffOperationsGateway" コンポーネント（Service Interface:
--   TableBillingSummary、resolveCallRequestのResolveCallRequestInput:
--   {callRequestId}）を参照。本タスク（8.6、呼び出し対応UI）で改訂した
--   型定義に合わせて本マイグレーションを適用する。
--
-- =========================================================================
-- 背景（本タスクの前提作業。tasks.md 8.6 Read firstが明示的に指示する
--   マンダトリーな前提）
-- =========================================================================
-- resolveCallRequest（4.4で実装済み、0004_rpc_staff_gateway.sql）は入力に
-- callRequestId（call_requests.idそのもの）を要求するが、list_register_feed
-- （0004→0012→0014と拡張済み）は卓ごとに真偽値のhasOpenCallRequestしか
-- 返さず、対象のcall_requests.id自体を一切公開していない。レジ画面
-- （TableDetailPanel.tsx）が「対応済みにする」ボタンからresolveCallRequestを
-- 呼び出すには、この真偽値だけでは呼び出し対象を指定できず実装不能である。
--
-- 0009/0010/0011/0012/0013/0014が確立した規約（既存の適用済みマイグレーション
-- は編集せず、`create or replace function`で関数本体のみを差し替える新しい
-- 番号のファイルを追加する）をそのまま踏襲し、0004/0012/0013/0014は編集しない。
--
-- =========================================================================
-- 設計判断: hasOpenCallRequestは維持し、openCallRequestIdを追加するのみ
-- =========================================================================
-- タスク文書の指示通り、既存の`hasOpenCallRequest`（真偽値）フィールドは
-- 後方互換のため変更しない（8.1のFloorMap.tsxタイルの呼出バッジは引き続き
-- この真偽値のみを参照し、本タスクでは変更しない）。新しいフィールド
-- `openCallRequestId`（対象のcall_requests.id、無ければnull）を純粋加算する。
--
-- 実装は既存の`exists(...)`真偽値サブクエリはそのまま残し、隣に
-- スカラーサブクエリ（`select cr.id from call_requests cr where
-- cr.session_id = ts.id and cr.status = 'open' limit 1`）を追加するのみ。
-- 要件2.3（同一セッションに未対応の呼び出しは高々1件、create_call_requestの
-- 部分ユニークインデックスcall_requests_open_session_id_keyで保証済み、
-- 0003設計判断7参照）により、「あるセッションに対しstatus='open'の
-- call_requestsは高々1行」という不変条件が既に成立しているため、
-- `limit 1`は曖昧さの回避のための防御的な安全策であり、通常運用下では
-- 常に高々1行しかヒットしない。LEFT JOIN LATERALではなくスカラー
-- サブクエリを選んだ理由: 既存のhasOpenCallRequestも同じ相関サブクエリの
-- 形（設計判断24参照）であり、同一クエリ内に2つ目の似た形の小さな
-- サブクエリを追加する方が、新しいLATERAL join（既存のbillingサブクエリとは
-- 無関係の結合対象を導入する）よりも変更差分が小さく理解しやすいと判断した。
--
-- 0004からの変更点は、list_register_feedのjsonb_build_objectへ
-- 'openCallRequestId'の1行を追加するのみ。それ以外（device_role検証・
-- total集計式・activeSessionの合成・hasOpenCallRequestの判定・
-- items内のid/optionsSummary/status/genre）は一切変更しない。

create or replace function public.list_register_feed(
  p_store_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  -- 1. device_role検証（0004設計判断21: registerロール限定）を必ず先頭で行う。
  perform public.assert_device_role(array['register']);

  -- 2. 対象店舗の全卓を起点に、アクティブセッションをLEFT JOINし、
  --    明細集計をLEFT JOIN LATERALで1回だけ計算する（0004設計判断24）。
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'tableId', t.id,
        'tableLabel', t.label,
        'activeSession',
          case
            when ts.id is null then null
            else jsonb_build_object(
              'id', ts.id,
              'startedAt', ts.started_at,
              'partySize', ts.party_size
            )
          end,
        'items', coalesce(billing.items, '[]'::jsonb),
        'total', coalesce(billing.total, 0),
        'hasOpenCallRequest', exists (
          select 1
          from public.call_requests cr
          where cr.session_id = ts.id
            and cr.status = 'open'
        ),
        -- タスク8.6で追加: resolveCallRequest({callRequestId})の対象識別に
        -- 必須（本ファイル冒頭コメント「背景」参照）。要件2.3が保証する
        -- 「セッションあたりopenな呼び出しは高々1件」という不変条件により、
        -- limit 1は曖昧さ回避のための防御的な安全策に過ぎない。
        'openCallRequestId', (
          select cr.id
          from public.call_requests cr
          where cr.session_id = ts.id
            and cr.status = 'open'
          limit 1
        )
      )
      order by t.label, t.id
    ),
    '[]'::jsonb
  )
  into v_result
  from public.tables t
  left join public.table_sessions ts
    on ts.table_id = t.id and ts.status = 'active'
  left join lateral (
    select
      jsonb_agg(
        jsonb_build_object(
          -- タスク8.3で追加: removeOrderItem({orderItemId})の対象識別に必須。
          'id', oi.id,
          'menuItemId', oi.menu_item_id,
          'name', oi.name_snapshot,
          'quantity', oi.quantity,
          'unitPrice', oi.unit_price_snapshot,
          -- タスク8.3で追加。
          'optionsSummary', oi.options_summary,
          'status', oi.status,
          -- タスク8.4で追加: statusLabel(genre, status)のジャンルに応じた
          -- 日本語表示、および進めるボタンの次ステータス判定
          -- （resolveNextOrderItemStatus、src/lib/orderItemStatusTransitions.ts）
          -- の両方に必須。
          'genre', mi.genre
        )
        order by oi.id
      ) as items,
      -- 0004設計判断23: get_ordering_context（0003）のconfirmedTotalと
      -- 文字通り同一の集計式（statusによる絞り込みなし）。本タスクでは
      -- 変更しない。
      sum(oi.unit_price_snapshot * oi.quantity) as total
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    -- タスク8.4で追加: list_kitchen_feed（0004）と同一のjoinパターン。
    join public.menu_items mi on mi.id = oi.menu_item_id
    where o.session_id = ts.id
  ) billing on true
  where t.store_id = p_store_id;

  return v_result;
end;
$$;

comment on function public.list_register_feed(uuid) is
  'レジ（authenticated, device_role=''register''。0004設計判断21参照）が卓
   マップ・卓別会計確認一覧を取得する際に呼び出すStaffOperationsGatewayの
   閲覧系RPC（要件2.2, 2.4, 5.1-5.4, 5.5, 5.6, 5.7）。冒頭でassert_device_role
   (array[''register''])を検証する（それ以外のdevice_role・claim欠如は
   カスタムSQLSTATE ''P0403''、assert_device_role自身が送出。design.mdの
   `never`エラー型に対応する解釈は0004設計判断25と同じ）。対象店舗
   （store_idスコープ、アクティブセッションの有無を問わず空席卓も含む、
   要件5.4）を、design.mdのTableBillingSummary型と同じキー構成
   （tableId/tableLabel/activeSession/items/total/hasOpenCallRequest/
   openCallRequestId）のjsonb配列として返す。各itemsの要素はタスク8.3で
   id/optionsSummary/status、タスク8.4でgenreを追加し、{id, menuItemId,
   name, quantity, unitPrice, optionsSummary, status, genre}となった。
   アクティブセッションがない卓はactiveSession: null・items: []・total: 0・
   hasOpenCallRequest: false・openCallRequestId: nullとなる（要件5.2、
   0004設計判断24）。activeSessionがある卓のtotalはget_ordering_context
   （0003）のconfirmedTotalと文字通り同一の集計式（unit_price_snapshot*
   quantityの合計、statusによる絞り込みなし）で計算し、両者が常に一致
   することをlistRegisterFeed.integration.test.tsのクロスRPC検証で担保
   する（0004設計判断23）。hasOpenCallRequestは対象セッションに
   ''open''のcall_requestsが存在するかを表す（要件2.2）。openCallRequestId
   はタスク8.6で追加（本ファイル冒頭コメント参照）: 対象がある場合はその
   call_requests.id、無ければnullを返し、resolveCallRequest
   （{callRequestId}）の対象識別に用いる。要件2.3が保証する「セッション
   あたりopenな呼び出しは高々1件」という不変条件（create_call_requestの
   部分ユニークインデックス、0003設計判断7）により、スカラーサブクエリ
   （limit 1は防御的措置）で安全に取得できる。SECURITY DEFINER +
   search_path='''' + stableは他の閲覧系RPC（get_ordering_context, 0003;
   list_kitchen_feed, 0004）と同じ構成。';

revoke execute on function public.list_register_feed(uuid)
  from public, anon, authenticated;

grant execute on function public.list_register_feed(uuid) to authenticated;
