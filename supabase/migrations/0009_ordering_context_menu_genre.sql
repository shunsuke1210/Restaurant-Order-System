-- 0009_ordering_context_menu_genre.sql
-- table-order-kitchen: get_ordering_contextのmenu要素にgenreを追加する
--
-- Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 7.2
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "CustomerOrderingGateway" コンポーネント（Service Interface: MenuItemView）
--   および "CustomerOrderApp" コンポーネント要約
--   （「おすすめ/一品/フード/ドリンクのジャンル別タブ」）を参照。
--
-- 背景（タスク6.1で判明したギャップ）: タスク3.1で実装済みのget_ordering_context
-- （0003_rpc_customer_gateway.sql）が返すmenu要素は、design.mdのMenuItemView型
-- （id/name/price/soldOut/imageUrl/options）に厳密に一致する形で実装されていた。
-- しかしタスク6.1（客側メニュー画面のジャンル別タブUI）の実装に着手したところ、
-- ジャンル別に品目をグループ化するために必要な`genre`（menu_items.genre列、
-- 0001_schema.sqlで既に'ippin'|'food'|'drink'のcheck制約付きで定義済み）が
-- MenuItemViewに含まれておらず、クライアント側だけではジャンル別タブを
-- 実装できないというギャップが判明した（design.mdのCustomerOrderApp要約は
-- ジャンル別タブを明示的に要求しているにもかかわらず、MenuItemView型定義には
-- 反映されていなかった）。
--
-- 本マイグレーションは、既存のmenu_items.genre列（既にNOT NULL・値域制約あり、
-- スキーマ変更は不要）をget_ordering_contextのjsonb応答へ追加で含めるのみの
-- 追加的（additive）変更である。既存キー（id/name/price/soldOut/imageUrl/
-- options）の形状・意味は一切変更しない。関数シグネチャ（引数p_table_id・
-- 戻り値jsonb）も変更しない。design.mdのRevalidation Triggers
-- 「CustomerOrderingGateway / StaffOperationsGatewayの関数シグネチャを
-- 変更する場合」には該当しない（シグネチャは不変、応答jsonbのキー追加のみ）が、
-- MenuItemView型定義自体への追加であるため、design.md本文も本タスクで
-- 合わせて更新した（レビュー時に再検証してほしい変更点として明記する）。
--
-- 0003からの変更点は関数本体のjsonb_build_objectへの'genre', mi.genreの
-- 1行追加のみ。それ以外（コメント含む）は0003の内容をそのまま維持する
-- （create or replace functionは関数全体を置き換えるため、既存の設計判断
-- コメントも保持しつつ全文を再掲する）。

create or replace function public.get_ordering_context(p_table_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_table public.tables;
  v_active_session_id uuid;
  v_confirmed_total numeric;
  v_menu jsonb;
begin
  select *
  into v_table
  from public.tables
  where id = p_table_id;

  if not found then
    raise exception 'table % not found', p_table_id
      using errcode = 'P0404';
  end if;

  -- アクティブセッションの有無を、0001の部分ユニークインデックス
  -- （table_sessions_active_table_id_key: (table_id) WHERE status = 'active'）
  -- が保証する「卓あたり高々1件」の前提で照会する。
  select id
  into v_active_session_id
  from public.table_sessions
  where table_id = p_table_id
    and status = 'active';

  -- confirmedTotal: 現在アクティブなセッションに属するorder_itemsの
  -- (unit_price_snapshot * quantity)の合計。アクティブセッションがない場合、
  -- またはセッションに送信済みの注文がまだない場合は0。
  --
  -- 重要: このロジックはStaffOperationsGateway.listRegisterFeedのtotal計算と
  -- 完全に一致させなければならない（design.md CustomerOrderingGateway
  -- Responsibilities & Constraints:「getOrderingContextは...confirmedTotal
  -- （レジのlistRegisterFeedと同一ロジック）を返す」、要件1.12・5.1の
  -- 整合性要件。10.3の結合テストが両者の一致を横断的に検証する）。
  if v_active_session_id is null then
    v_confirmed_total := 0;
  else
    select coalesce(sum(oi.unit_price_snapshot * oi.quantity), 0)
    into v_confirmed_total
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.session_id = v_active_session_id;
  end if;

  -- menu: 卓が属する店舗の全メニュー品目。売り切れ品目もsoldOut: trueとして
  -- 含める（除外しない）。要件1.4「選択不可として表示」は「非表示」ではなく
  -- 「表示した上で選択不可にする」ことを求めており、クライアント側が
  -- 売り切れ品目をグレーアウト表示するためには本RPCがその存在自体を
  -- 返す必要があるため。optionsはmenu_items.optionsのjsonb列をそのまま返す
  -- （その形状の検証・変換は行わない。design.md Responsibilities &
  -- Constraints「オプション自体の作成・編集は将来のオーナーモードspecの
  -- 責務であり、本Gatewayは読み取りのみ行う」）。
  -- genre（本マイグレーションで追加）: 客側UIのジャンル別タブ表示
  -- （design.md CustomerOrderApp「おすすめ/一品/フード/ドリンクのジャンル別
  -- タブ」）に必要なため追加。値はmenu_items.genre（'ippin'|'food'|'drink'、
  -- StaffOperationsGateway Service Interfaceの MenuItemGenre型と同一の値域）
  -- をそのまま返す。
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', mi.id,
        'name', mi.name,
        'price', mi.price,
        'soldOut', mi.sold_out,
        'imageUrl', mi.image_url,
        'options', mi.options,
        'genre', mi.genre
      )
      order by mi.name, mi.id
    ),
    '[]'::jsonb
  )
  into v_menu
  from public.menu_items mi
  where mi.store_id = v_table.store_id;

  return jsonb_build_object(
    'table', jsonb_build_object('id', v_table.id, 'label', v_table.label),
    'activeSession',
      case
        when v_active_session_id is null then null
        else jsonb_build_object('id', v_active_session_id)
      end,
    'confirmedTotal', v_confirmed_total,
    'menu', v_menu
  );
end;
$$;

comment on function public.get_ordering_context(uuid) is
  '客（anonロール、無ログイン）が卓QRを読み取った際に呼び出すCustomerOrderingGatewayの
   閲覧系RPC。卓の存在確認、アクティブな来店セッションの有無、当該セッションの
   confirmedTotal（listRegisterFeedのtotalと同一ロジック）、店舗の全メニュー品目
   （売り切れ品目もsoldOut: trueとして含める。0009でgenreを追加し、客側UIの
   ジャンル別タブ表示に対応）を、design.mdのOrderingContext型と同じキー構成の
   jsonbで返す。卓IDが存在しない場合はカスタムSQLSTATE ''P0404''
   （design.mdのOrderingContextError { code: "TABLE_NOT_FOUND" }に対応）で
   例外を送出する。SECURITY DEFINER + search_path=''''は、anonロールに
   table_sessions/orders/order_itemsへの直接権限がない（0002でロックダウン済み）状態でも
   本関数がそれらを読み取れるようにするための構成であり、0007と同じ
   search_pathなりすまし対策を踏襲する。';

-- 権限（revoke/grant）はcreate or replace functionでは変化しないため、
-- 0003で既に確立済みの「anonのみEXECUTE可」をここで再宣言する必要はない。
-- 念のため明示的に維持を確認する（0003と同一内容の再実行、冪等）。
revoke execute on function public.get_ordering_context(uuid)
  from public, anon, authenticated;

grant execute on function public.get_ordering_context(uuid) to anon;
