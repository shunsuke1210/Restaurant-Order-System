-- 0017_list_register_feed_open_call_request_created_at.sql
-- table-order-kitchen: list_register_feedの各卓にopenCallRequestCreatedAtを追加する
--
-- Requirements: 2.2, 2.4（spec完了後のユーザー確認で追加した要求。
--   「複数卓からスタッフ呼出しがあった場合、レジ画面へスマートフォンの
--   通知のように目立つバナーを表示し、複数呼び出しが重なった場合は
--   古い呼び出しを上に積み重ねて表示する」）
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "StaffOperationsGateway" コンポーネント（Service Interface:
--   TableBillingSummary）。0015が追加したopenCallRequestIdの隣に、
--   ソートキーとなる作成時刻を追加する。
--
-- =========================================================================
-- 背景
-- =========================================================================
-- 0015でopenCallRequestId（resolveCallRequestの対象識別用）を追加したが、
-- 「呼び出しが複数の卓から同時に来た場合、古い呼び出しを上に積む」という
-- 新しいバナーUIの要求には、呼び出しごとの実際の発生時刻が必要になる。
-- list_register_feedはcall_requests.created_atを一切公開していないため、
-- クライアント側（FloorMap.tsx）では呼び出しの新旧を判定できない
-- （クライアントのローカル時計・取得順はサーバー側の実際の発生順を
-- 保証しない）。
--
-- 0009/.../0016が確立した規約（既存の適用済みマイグレーションは編集せず、
-- `create or replace function`で関数本体のみを差し替える新しい番号の
-- ファイルを追加する）をそのまま踏襲し、0004/0012/0013/0014/0015は
-- 編集しない。
--
-- =========================================================================
-- 設計判断: openCallRequestIdの隣にopenCallRequestCreatedAtを追加するのみ
-- =========================================================================
-- 0015のスカラーサブクエリ（`select cr.id from call_requests cr where
-- cr.session_id = ts.id and cr.status = 'open' limit 1`）と全く同じ
-- WHERE条件で`cr.created_at`を選択する2つ目のスカラーサブクエリを追加する。
-- 別のLATERAL joinを導入せず、0015と同型の小さなサブクエリを1つ追加する
-- だけにとどめた理由も0015と同じ（変更差分を小さく保つ）。
--
-- 0015からの変更点は、list_register_feedのjsonb_build_objectへ
-- 'openCallRequestCreatedAt'の1行を追加するのみ。それ以外
-- （device_role検証・total集計式・activeSessionの合成・
-- hasOpenCallRequest/openCallRequestIdの判定・itemsの各フィールド）は
-- 一切変更しない。

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
        'openCallRequestId', (
          select cr.id
          from public.call_requests cr
          where cr.session_id = ts.id
            and cr.status = 'open'
          limit 1
        ),
        -- タスク（spec完了後のバナーUI追加）で追加: 複数卓からの呼び出しを
        -- 「古いものを上に」積み重ねて表示するためのソートキー。0015の
        -- openCallRequestIdと全く同じWHERE条件のスカラーサブクエリ。
        'openCallRequestCreatedAt', (
          select cr.created_at
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
          'id', oi.id,
          'menuItemId', oi.menu_item_id,
          'name', oi.name_snapshot,
          'quantity', oi.quantity,
          'unitPrice', oi.unit_price_snapshot,
          'optionsSummary', oi.options_summary,
          'status', oi.status,
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
   openCallRequestId/openCallRequestCreatedAt）のjsonb配列として返す。
   各itemsの要素はタスク8.3でid/optionsSummary/status、タスク8.4でgenreを
   追加し、{id, menuItemId, name, quantity, unitPrice, optionsSummary,
   status, genre}となった。アクティブセッションがない卓はactiveSession:
   null・items: []・total: 0・hasOpenCallRequest: false・
   openCallRequestId: null・openCallRequestCreatedAt: nullとなる（要件5.2、
   0004設計判断24）。activeSessionがある卓のtotalはget_ordering_context
   （0003）のconfirmedTotalと文字通り同一の集計式（unit_price_snapshot*
   quantityの合計、statusによる絞り込みなし）で計算し、両者が常に一致
   することをlistRegisterFeed.integration.test.tsのクロスRPC検証で担保
   する（0004設計判断23）。hasOpenCallRequestは対象セッションに
   ''open''のcall_requestsが存在するかを表す（要件2.2）。openCallRequestId
   はタスク8.6で追加: 対象がある場合はその call_requests.id、無ければnullを
   返し、resolveCallRequest（{callRequestId}）の対象識別に用いる。
   openCallRequestCreatedAtは0017で追加: 同じ対象のcall_requests.created_at
   （無ければnull）を返し、レジ画面が複数卓の呼び出しバナーを「古いものを
   上に」並べるためのソートキーとして用いる。要件2.3が保証する「セッション
   あたりopenな呼び出しは高々1件」という不変条件（create_call_requestの
   部分ユニークインデックス、0003設計判断7）により、いずれもスカラー
   サブクエリ（limit 1は防御的措置）で安全に取得できる。SECURITY DEFINER +
   search_path='''' + stableは他の閲覧系RPC（get_ordering_context, 0003;
   list_kitchen_feed, 0004）と同じ構成。';

revoke execute on function public.list_register_feed(uuid)
  from public, anon, authenticated;

grant execute on function public.list_register_feed(uuid) to authenticated;
