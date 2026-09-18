-- 0016_menu_item_recommended_subcategory.sql
-- table-order-kitchen: menu_itemsにrecommended/sub_categoryを追加し、
-- get_ordering_contextへ反映する
--
-- Requirements: 1.5, 1.6（客側メニュー閲覧・オプション選択の周辺、
--   CustomerOrderApp要約「おすすめ/一品/フードのジャンル別タブ」）
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "CustomerOrderingGateway" コンポーネント（Service Interface: MenuItemView）
--   および "CustomerOrderApp" コンポーネント要約を参照。
--
-- =========================================================================
-- 背景（spec完了後のユーザー確認で判明したギャップ）
-- =========================================================================
-- mock-preview.html（検証済みUXリファレンス、GENRES/SUBTABS定数・
-- menuHeaderHtml/menuListHtml関数）は当初から「おすすめ」タブと、
-- ジャンルごとのサブタブ（一品→おつまみ/サラダ、フード→刺身/焼き物/
-- ご飯もの、ドリンク→ソフトドリンク/ノンアルコール/ビール・ハイボール/
-- サワー/その他）を持っていた。しかしタスク6.1（客側メニュー画面）着手時、
-- menu_itemsにこれらに対応する列が存在しないという理由で「おすすめ」タブは
-- 「すべて」タブに、サブタブ機能自体は未実装のまま見送られた
-- （GenreTabs.tsx冒頭コメント「CONCERNS」参照）。
--
-- spec完了後、実際にアプリを操作したユーザーからこの乖離を指摘され、
-- 今回追加する判断となった（AskUserQuestionでの確認済み）。
--
-- =========================================================================
-- 追加する列
-- =========================================================================
-- recommended: 「おすすめ」タブでの横断フィルタ用の単純なbooleanフラグ。
--   ジャンルを問わず全品目から`recommended = true`のものだけを抽出する
--   （mock-preview.htmlのosusume分岐: `state.menu.filter(m => m.recommend)`と
--   同じ意味）。
-- sub_category: ジャンル内のサブタブ表示用の自由記述テキスト（null許容）。
--   ジャンルごとに許容値をCHECK制約で縛らない判断とした理由:
--   (a) サブカテゴリの命名はメニュー内容そのもの（店主の裁量）であり、
--       DB制約で固定すると新しいサブカテゴリを追加するたびにマイグレーションが
--       必要になり、design.mdのNon-Goals「商品登録・価格変更（オーナーモード）」
--       が将来別specで担う領域に踏み込みすぎる。
--   (b) 現状のUI（GenreTabs.tsx/新設のSubTabs.tsx）はDBが返す実際の
--       sub_category値から動的にタブ一覧を導出する設計とするため
--       （後述、フロントエンド側のハードコードを避ける）、制約で
--       事前に値域を固定する必要性が薄い。
--   null（未設定）の品目はどのサブタブにも属さない（フロントエンド側で
--   「その他」等への自動振り分けは行わない。0004の他のnullable列と同じ
--   「無いものは無いまま返す」という既存方針を踏襲）。
alter table public.menu_items
  add column recommended boolean not null default false,
  add column sub_category text;

comment on column public.menu_items.recommended is
  '「おすすめ」タブ（customer UI、ジャンル横断）に表示する品目かどうか。
   タスク6.1時点ではこの列が存在せず「おすすめ」タブを「すべて」タブに
   代替していたが、spec完了後のユーザー確認で追加した（0016）。';

comment on column public.menu_items.sub_category is
  'ジャンル内のサブタブ表示用ラベル（例: 一品なら「おつまみ」「サラダ」、
   ドリンクなら「ビール・ハイボール」等）。null許容・自由記述・DB制約なし
   （本ファイル冒頭コメント「追加する列」参照）。タスク6.1時点ではこの概念
   自体が未実装だったが、spec完了後のユーザー確認で追加した（0016）。';

-- =========================================================================
-- get_ordering_contextへの反映（0010からの追加的変更）
-- =========================================================================
-- 0010からの変更点はjsonb_build_objectへの'recommended'・'subCategory'
-- キー2つの追加のみ。それ以外（コメント含む）は0010の内容をそのまま維持する
-- （create or replace functionは関数全体を置き換えるため、既存の設計判断
-- コメントも保持しつつ全文を再掲する、0009/0010で確立済みの規約）。

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
    -- hasOpenCallRequest: アクティブセッションが無い卓には呼び出しボタン
    -- 自体が表示されない（要件2.1）ため、falseで固定する（listRegisterFeed
    -- の空席卓と同じ判断）。
    v_has_open_call_request := false;
  else
    select coalesce(sum(oi.unit_price_snapshot * oi.quantity), 0)
    into v_confirmed_total
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.session_id = v_active_session_id;

    -- hasOpenCallRequest: 当該セッションに未対応(open)のcall_requestsが
    -- 存在するか。create_call_request（0003）/resolve_call_request（0004）の
    -- ライフサイクルに追随する（要件2.1-2.3）。StaffOperationsGateway.
    -- listRegisterFeed（0004）が同じ意味のフィールドに用いるexists(...)
    -- クエリと文字通り同一の判定式であり、客側の「呼び出し中」表示と
    -- レジ側の「呼び出し中バッジ」表示が常に同じ真偽値の情報源
    -- （call_requests.status = 'open'）から算出されることを保証する。
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
  -- genre（0009で追加）: 客側UIのジャンル別タブ表示に必要なため追加。
  -- recommended/subCategory（0016で追加）: 「おすすめ」タブ・ジャンル内
  -- サブタブ表示に必要（本ファイル冒頭コメント参照）。
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', mi.id,
        'name', mi.name,
        'price', mi.price,
        'soldOut', mi.sold_out,
        'imageUrl', mi.image_url,
        'options', mi.options,
        'genre', mi.genre,
        'recommended', mi.recommended,
        'subCategory', mi.sub_category
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
   （売り切れ品目もsoldOut: trueとして含める。0009でgenre、0016で
   recommended/subCategoryを追加し、客側UIの「おすすめ」タブ・ジャンル内
   サブタブ表示に対応）を、design.mdのOrderingContext型と同じキー構成の
   jsonbで返す。卓IDが存在しない場合はカスタムSQLSTATE ''P0404''
   （design.mdのOrderingContextError { code: "TABLE_NOT_FOUND" }に対応）で
   例外を送出する。SECURITY DEFINER + search_path=''''は、anonロールに
   table_sessions/orders/order_items/call_requestsへの直接権限がない
   （0002でロックダウン済み）状態でも本関数がそれらを読み取れるようにするための
   構成であり、0007と同じsearch_pathなりすまし対策を踏襲する。';

-- 権限（revoke/grant）はcreate or replace functionでは変化しないため、
-- 0003/0009/0010で既に確立済みの「anonのみEXECUTE可」をここで再宣言する
-- 必要はない。念のため明示的に維持を確認する（同一内容の再実行、冪等）。
revoke execute on function public.get_ordering_context(uuid)
  from public, anon, authenticated;

grant execute on function public.get_ordering_context(uuid) to anon;
