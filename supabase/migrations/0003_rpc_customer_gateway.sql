-- 0003_rpc_customer_gateway.sql
-- table-order-kitchen: CustomerOrderingGateway RPC群
--
-- Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.12, 7.2
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "CustomerOrderingGateway" コンポーネント（Responsibilities & Constraints,
--   Service Interface: getOrderingContext / GetOrderingContextInput /
--   OrderingContext / MenuItemView / MenuItemOption / OrderingContextError）と、
--   「注文送信〜厨房反映フロー」シーケンス図の Key Decisions
--   「get_ordering_contextとsubmit_orderを分離することで、注文送信の直前に
--   必ずセッション有効性を再検証する」を参照。
--
-- ファイル構成（design.md "File Structure Plan"）: 本ファイルは将来、
--   get_ordering_context / submit_order / create_call_request の3関数を
--   まとめて持つ想定（CustomerOrderingGatewayという単一の書き込み境界を
--   1マイグレーションファイルにまとめる設計判断）。
--   本タスク（3.1）はget_ordering_context単体のみを実装する。
--   submit_order（3.2）/create_call_request（3.3）は将来タスクで
--   本ファイルへ追記される（別ファイルへの分割はしない）。
--
-- マイグレーション適用順序についての注記: ファイル名の字句/数値順で
--   0001 -> 0002 -> 0003 -> 0005 -> 0006 -> 0007 の順に適用される
--   （0004は未使用でStaffOperationsGateway用に予約済み。タスク4.x）。
--   本関数はauth.jwt()・assert_device_role・Vault等、0005〜0007で
--   導入される機能に一切依存しない（客側は無ログインの`anon`ロール経路で
--   あり、device_role検証の対象外。design.md CustomerOrderingGateway
--   Responsibilities & Constraints「anonロールにのみEXECUTE権限を付与する」
--   参照）。0001（テーブル定義）・0002（RLS/menu_itemsのanon SELECT）にのみ
--   依存する。

-- =========================================================================
-- 設計判断1: 戻り値の形状 — jsonb一本化
-- =========================================================================
-- design.mdのOrderingContext型はネストしたオブジェクト（table, null許容の
-- activeSession, menu配列）を持つ。Postgresの複合型（composite type）で
-- 同じ形状を表現するには、ネスト用の複合型・配列型を追加で定義する必要があり、
-- 単一のRPCのためだけにスキーマオブジェクトを増やすのは過剰と判断した。
-- jsonb1本の戻り値であれば、TypeScript側（タスク3.4の
-- CustomerOrderingGatewayラッパー、本タスクのスコープ外）が
-- OrderingContext型へ直接マッピングできる形にそのまま整形できる。
-- 本関数はjsonbオブジェクトのキーをOrderingContext/MenuItemViewの
-- フィールド名と完全に一致するキャメルケース
-- （table/activeSession/confirmedTotal/menu、各menu要素は
-- id/name/price/soldOut/imageUrl/options）で構築し、将来の
-- TypeScriptラッパーが素直にマッピングできるようにする。

-- =========================================================================
-- 設計判断2: エラー通知 — RAISE EXCEPTION ... USING ERRCODEの踏襲
-- =========================================================================
-- 0006（assert_device_role）・0007（provision_device）が確立したカスタム
-- SQLSTATE規約（SQLSTATEクラス'P0'は「PL/pgSQL Error」としてPostgreSQL本体が
-- ユーザー定義コード向けに予約している領域。既存のP0403[FORBIDDEN相当]・
-- P0401[INVALID_SETUP_CODE相当]と衝突しない未使用のサブコード）を踏襲し、
-- 卓が存在しない場合はカスタムSQLSTATE 'P0404'
-- （404 Not Foundを想起させる数字）を送出する。design.mdが述べる
-- TypeScript層のResult<T,E>哲学とは、将来のCustomerOrderingGatewayラッパー
-- （タスク3.4、本タスクのスコープ外）がこのSQLSTATEをOrderingContextError
-- （{code: "TABLE_NOT_FOUND"}）へマッピングする形で接続される想定。
-- 代替案として「見つからない場合はエラーの代わりにnullを含むjsonbを返す」
-- 方式も検討したが、(a) 0006/0007との一貫性、(b) 「卓IDが存在しない」は
-- クライアントの入力ミス・不正なURLアクセスを示す明確な異常系であり、
-- 正常応答の一種として埋め込むと呼び出し側の判別ロジックが複雑になる、
-- という2点から不採用とした。

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
  -- 重要: このロジックは将来実装されるStaffOperationsGateway.listRegisterFeed
  -- のtotal計算と完全に一致させなければならない（design.md
  -- CustomerOrderingGateway Responsibilities & Constraints:
  -- 「getOrderingContextは...confirmedTotal（レジのlistRegisterFeedと
  -- 同一ロジック）を返す」、要件1.12・5.1の整合性要件。10.3の結合テストが
  -- 両者の一致を横断的に検証する）。listRegisterFeed実装時（タスク4.5）は
  -- 本関数のこの集計ロジック（対象セッションのorder_items全件について
  -- unit_price_snapshot*quantityを合計する。statusによる絞り込みは行わない）
  -- と完全に同じにすること。
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
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', mi.id,
        'name', mi.name,
        'price', mi.price,
        'soldOut', mi.sold_out,
        'imageUrl', mi.image_url,
        'options', mi.options
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
   confirmedTotal（listRegisterFeedのtotalと同一ロジック、将来実装時に一致させること）、
   店舗の全メニュー品目（売り切れ品目もsoldOut: trueとして含める）を、design.mdの
   OrderingContext型と同じキー構成のjsonbで返す。卓IDが存在しない場合はカスタム
   SQLSTATE ''P0404''（design.mdのOrderingContextError { code: "TABLE_NOT_FOUND" }に
   対応）で例外を送出する。SECURITY DEFINER + search_path=''''は、anonロールに
   table_sessions/orders/order_itemsへの直接権限がない（0002でロックダウン済み）状態でも
   本関数がそれらを読み取れるようにするための構成であり、0007と同じ
   search_pathなりすまし対策を踏襲する。';

-- =========================================================================
-- EXECUTE権限: anonのみ
-- =========================================================================
-- design.mdのArchitecture図「NextApp -->|anon key| CustomerGateway」および
-- 要件8.1「客注文サービスは客に対し認証情報の入力を要求しない」から、
-- CustomerOrderingGatewayは匿名サインインすら行わない、真の`anon`ロール経路で
-- 呼び出される（DeviceIdentityProviderの匿名認証は厨房/レジタブレット専用。
-- design.md DeviceIdentityProvider Responsibilities & Constraints参照）。
-- そのため`anon`にのみEXECUTEを許可する。
--
-- `authenticated`には意図的に付与しない: 厨房/レジタブレットは
-- authenticatedロール（device_role claim付き）を持つが、design.mdの
-- Components and Interfacesテーブルは KitchenBoard/RegisterConsoleの
-- 依存先をStaffOperationsGateway（+RealtimeFeed）のみと明記しており、
-- CustomerOrderingGatewayは両者の依存関係に含まれない。将来レジ/厨房が
-- 本RPCを呼ぶ具体的なユースケースが生じた場合は、design.mdの
-- Revalidation Triggers（Gateway関数シグネチャ変更時の再検証）に従い
-- 明示的に権限を見直す。0006/0007と同じ理由（Postgresは新規関数の
-- EXECUTEをデフォルトでPUBLICへ自動付与するため）で、まずPUBLIC/anon/
-- authenticatedから剥奪してから、anonにのみ明示的に付与し直す。
revoke execute on function public.get_ordering_context(uuid)
  from public, anon, authenticated;

grant execute on function public.get_ordering_context(uuid) to anon;
