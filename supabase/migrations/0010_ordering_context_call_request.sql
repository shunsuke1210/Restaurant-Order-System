-- 0010_ordering_context_call_request.sql
-- table-order-kitchen: get_ordering_contextにhasOpenCallRequestを追加する
--
-- Requirements: 2.1, 2.2, 2.3
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "CustomerOrderingGateway" コンポーネント（Service Interface: OrderingContext）
--   および "CustomerOrderApp" コンポーネント要約（呼び出しボタン）を参照。
--
-- 背景（タスク6.3で判明したギャップ）: タスク6.1（メニュー画面）着手時に
-- get_ordering_contextへgenre（0009）を追加的に補ったのと同型のギャップが、
-- タスク6.3（呼び出しボタンUI）でも見つかった。design.mdのCustomerOrderApp
-- コンポーネント要約は「呼び出しボタン」を明示的に要求し、createCallRequestは
-- 呼び出し送信の直後（成功応答またはCALL_ALREADY_OPEN）については客側画面が
-- 自力で「呼び出し中」を判断できる。しかし、対応済み（resolved）になったことを
-- 検知する手段がOrderingContextに一切無く、このままでは「レジが対応済みに
-- した後も、客の画面が再読み込みされるまで永久に再送不可のまま」になり、
-- 新しい（無関係の）要望で再度呼び出したい客が呼び出せなくなってしまう
-- （要件2.1「アクティブな来店セッションが存在する間は呼び出しボタンを表示する」
-- の趣旨——ボタンは常に「今呼べるか」を正しく表す状態であるべき——に反する）。
--
-- 検討した代替案（tasks.mdの指示に基づき本タスクで比較検討済み）:
--   (a) クライアント側のローカル状態のみで「呼び出し済みフラグ」を管理する
--       ——サーバー再検証を経ない案。design.mdのSecurity Considerations
--       および3.1/3.2/6.2が一貫して採用する「クライアントの表示状態を
--       信用せず、必ずサーバー側で再検証する」という設計原則
--       （CustomerOrderingGateway Responsibilities & Constraints「注文送信時は
--       必ずサーバー側で...再検証する（クライアントの表示状態を信用しない）」）
--       と整合しない。対応済みになったことを客の画面が永久に知りえないという
--       ユーザー体験上の欠陥も残る。不採用。
--   (b) Realtimeで`call_requests`の変更を購読する——0008_realtime_publication.sql
--       が`anon`ロールに`call_requests`等へのSELECT権限を意図的に付与していない
--       （タスク5で判明した「anonにRealtime SELECT権限を広げると店舗全体の
--       注文明細が漏洩しうる」というセキュリティ判断、6.2のconfirmedTotalの
--       ときと全く同じ制約）ため、この経路は現状の権限モデルのままでは
--       成立しない。不採用。
--   (c)（本マイグレーションが採用）get_ordering_contextへの追加的
--       （additive）フィールド。6.2で確定した確定注文合計のライブ更新方式
--       （`getOrderingContext`の5秒間隔ポーリング、MenuScreen.tsx冒頭コメント
--       参照）にそのまま相乗りできる——新しいRPC・新しいポーリングループ・
--       新しいセキュリティ境界のいずれも追加する必要がない。フィールド名
--       `hasOpenCallRequest`は、StaffOperationsGateway.listRegisterFeedが
--       返すTableBillingSummary.hasOpenCallRequest（design.md、4.5で実装済み。
--       0004_rpc_staff_gateway.sqlのlist_register_feed参照）と全く同じ意味
--       （対象セッションに未対応(open)のcall_requestsが存在するか）を持つため、
--       同じ名前をそのまま踏襲する（新しい語彙を増やさない）。
--
-- 本マイグレーションは、既存のcall_requestsテーブル（スキーマ変更は不要。
-- 0003で新設済みのcall_requests_open_session_id_key部分ユニークインデックスを
-- そのまま再利用する）を参照し、get_ordering_contextのjsonb応答へ追加で
-- 含めるのみの追加的（additive）変更である。既存キー（table/activeSession/
-- confirmedTotal/menu）の形状・意味は一切変更しない。関数シグネチャ
-- （引数p_table_id・戻り値jsonb）も変更しない。0009の前例と同様、
-- design.mdのRevalidation Triggers「CustomerOrderingGateway/
-- StaffOperationsGatewayの関数シグネチャを変更する場合」には該当しないが、
-- OrderingContext型定義自体への追加であるため、design.md本文も本タスクで
-- 合わせて更新した。
--
-- アクティブセッションが無い卓（v_active_session_id is null）は、そもそも
-- 呼び出しボタン自体が表示されない（要件2.1）ため意味を持たないが、booleanの
-- 契約を守るためfalseを返す（listRegisterFeedが空席卓にhasOpenCallRequest:
-- falseを返すのと同じ判断、0004設計判断24）。
--
-- 0009からの変更点はjsonb_build_objectへの'hasOpenCallRequest'キー1つの追加と、
-- それを計算するv_has_open_call_request変数の導入のみ。それ以外
-- （コメント含む）は0009の内容をそのまま維持する（create or replace function
-- は関数全体を置き換えるため、既存の設計判断コメントも保持しつつ全文を再掲する）。

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
  v_has_open_call_request boolean;
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
    -- hasOpenCallRequest（本マイグレーションで追加）: アクティブセッションが
    -- 無い卓には呼び出しボタン自体が表示されない（要件2.1）ため、falseで
    -- 固定する（listRegisterFeedの空席卓と同じ判断）。
    v_has_open_call_request := false;
  else
    select coalesce(sum(oi.unit_price_snapshot * oi.quantity), 0)
    into v_confirmed_total
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.session_id = v_active_session_id;

    -- hasOpenCallRequest（本マイグレーションで追加）: 当該セッションに
    -- 未対応(open)のcall_requestsが存在するか。create_call_request（0003）/
    -- resolve_call_request（0004）のライフサイクルに追随する（要件2.1-2.3）。
    -- StaffOperationsGateway.listRegisterFeed（0004）が同じ意味のフィールドに
    -- 用いるexists(...)クエリと文字通り同一の判定式であり、客側の
    -- 「呼び出し中」表示とレジ側の「呼び出し中バッジ」表示が常に同じ真偽値の
    -- 情報源（call_requests.status = 'open'）から算出されることを保証する。
    select exists (
      select 1
      from public.call_requests cr
      where cr.session_id = v_active_session_id
        and cr.status = 'open'
    )
    into v_has_open_call_request;
  end if;

  -- menu: 卓が属する店舗の全メニュー品目。売り切れ品目もsoldOut: trueとして
  -- 含める（除外しない）。要件1.4「選択不可として表示」は「非表示」ではなく
  -- 「表示した上で選択不可にする」ことを求めており、クライアント側が
  -- 売り切れ品目をグレーアウト表示するためには本RPCがその存在自体を
  -- 返す必要があるため。optionsはmenu_items.optionsのjsonb列をそのまま返す
  -- （その形状の検証・変換は行わない。design.md Responsibilities &
  -- Constraints「オプション自体の作成・編集は将来のオーナーモードspecの
  -- 責務であり、本Gatewayは読み取りのみ行う」）。
  -- genre（0009で追加）: 客側UIのジャンル別タブ表示（design.md CustomerOrderApp
  -- 「おすすめ/一品/フード/ドリンクのジャンル別タブ」）に必要なため追加。値は
  -- menu_items.genre（'ippin'|'food'|'drink'、StaffOperationsGateway Service
  -- Interfaceの MenuItemGenre型と同一の値域）をそのまま返す。
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
    'hasOpenCallRequest', v_has_open_call_request,
    'menu', v_menu
  );
end;
$$;

comment on function public.get_ordering_context(uuid) is
  '客（anonロール、無ログイン）が卓QRを読み取った際に呼び出すCustomerOrderingGatewayの
   閲覧系RPC。卓の存在確認、アクティブな来店セッションの有無、当該セッションの
   confirmedTotal（listRegisterFeedのtotalと同一ロジック）、当該セッションに
   未対応(open)の呼び出しがあるかを示すhasOpenCallRequest（0010で追加。
   listRegisterFeedの同名フィールドと同一の判定式）、店舗の全メニュー品目
   （売り切れ品目もsoldOut: trueとして含める。0009でgenreを追加し、客側UIの
   ジャンル別タブ表示に対応）を、design.mdのOrderingContext型と同じキー構成の
   jsonbで返す。卓IDが存在しない場合はカスタムSQLSTATE ''P0404''
   （design.mdのOrderingContextError { code: "TABLE_NOT_FOUND" }に対応）で
   例外を送出する。SECURITY DEFINER + search_path=''''は、anonロールに
   table_sessions/orders/order_items/call_requestsへの直接権限がない
   （0002でロックダウン済み）状態でも本関数がそれらを読み取れるようにするための
   構成であり、0007と同じsearch_pathなりすまし対策を踏襲する。';

-- 権限（revoke/grant）はcreate or replace functionでは変化しないため、
-- 0003で既に確立済みの「anonのみEXECUTE可」をここで再宣言する必要はない。
-- 念のため明示的に維持を確認する（0003/0009と同一内容の再実行、冪等）。
revoke execute on function public.get_ordering_context(uuid)
  from public, anon, authenticated;

grant execute on function public.get_ordering_context(uuid) to anon;
