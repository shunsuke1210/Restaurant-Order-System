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

-- =========================================================================
-- タスク3.2: submit_order RPC
-- =========================================================================
-- Requirements: 1.7, 1.8, 1.9, 1.10, 7.2
-- Design: design.mdの CustomerOrderingGateway コンポーネント（Responsibilities &
--   Constraints「注文送信時は必ずサーバー側で...再検証する（クライアントの表示
--   状態を信用しない）」「同一品目でもオプションの選択内容が異なれば別の注文明細
--   として登録する（要件1.8）」、Service Interface: submitOrder /
--   SubmitOrderInput / SubmitOrderResult / OrderWithItems / OrderItemSummary /
--   SubmitOrderError、Preconditions/Postconditions/Invariants、
--   Implementation Notes）と、「注文送信〜厨房反映フロー」シーケンス図の
--   Key Decisions「get_ordering_contextとsubmit_orderを分離することで、注文
--   送信の直前に必ずセッション有効性を再検証する」を参照。get_ordering_context
--   （3.1）と同じCustomerOrderingGateway境界に属するため、ファイル冒頭の
--   File Structure Plan通り本ファイルへ追記する（別ファイルへは分割しない）。

-- =========================================================================
-- 設計判断3: 冪等性 — orders(session_id, idempotency_key)の一意制約違反を
--   deduplicated: trueの成功応答へ変換する
-- =========================================================================
-- design.md Implementation Notes「orders(session_id, idempotency_key)にユニーク
-- 制約を張り、submit_order関数内でこの制約違反をdeduplicated: trueの成功応答に
-- 変換する」（0001_schema.sqlのorders_session_id_idempotency_key_key制約）を
-- そのまま実装する。ordersへのINSERTをネストしたBEGIN/EXCEPTIONブロックで囲み、
-- unique_violation（SQLSTATE 23505）だけを捕捉した場合に限り、新規の
-- order_itemsを挿入せず、同一(session_id, idempotency_key)の既存orderと
-- その明細を再取得して返す。PL/pgSQLのEXCEPTIONブロックは暗黙のSAVEPOINTを
-- 張る標準機能であり、本関数はordersへのINSERTより前には一切DBへ書き込みを
-- 行わない（品目検証は後述のとおりメモリ上のjsonbに蓄積するのみ）ため、
-- 捕捉によって巻き戻される変更は実質存在しない。二重送信を招く典型例（通信
-- リトライ、送信ボタンの連打）だけでなく、同一(session_id, idempotency_key)の
-- リクエストが真に同時に到着した場合も、後着側がこの一意制約違反を検知して
-- 自然にdeduplicated: trueへフォールバックするため、追加のアプリケーション側
-- ロックなしで冪等性が成立する（research.mdのDesign Decisions「RPC集約方式」で
-- 業務ルールを関数内に集約する方針とも一致する）。

-- =========================================================================
-- 設計判断4: 売り切れ品目を1件でも含む場合は送信全体を拒否する（全体ロール
--   バック。部分成功は行わない）
-- =========================================================================
-- design.mdのsubmitOrderはPromise<Result<SubmitOrderResult, SubmitOrderError>>
-- という単一のResultを返す形で定義されており、items配列の要素ごとに個別の
-- Resultを返す型（例: ReadonlyArray<Result<OrderItemSummary, ...>>）にはなって
-- いない。つまりAPI契約自体が「送信は丸ごと成功/丸ごと失敗のいずれかである」
-- ことを前提にしている。加えてTesting Strategyは「submit_orderは売り切れ品目を
-- 含む場合にITEM_SOLD_OUTを返す（1.4, 7.2）」と、"含む場合"という言い回しで
-- 送信全体に対する単一のエラーとして書かれており、Invariants「SESSION_NOT_ACTIVE
-- が返る場合、DBには何も書き込まれない」と対になる形で「ITEM_SOLD_OUTが返る
-- 場合も同様に何も書き込まれない」と読むのが設計文書に最も忠実な解釈である。
-- 以上から、1品目でも売り切れであれば送信全体を拒否し、売り切れでない他の
-- 品目だけを部分的に受理することはしないという、より安全側かつ設計文書の
-- 文言・型シグネチャの両方に忠実な解釈を採用する。
-- 実装上は、全品目のoptions整合性チェック・スナップショット取得までを完了させた
-- 中間結果（v_prepared_items、jsonb配列）を先に組み立ててから、その後で初めて
-- ordersへのINSERTに着手する2パス構成にすることで、検証失敗時にDBへ一切
-- 書き込まれていないことを保証する（3.1の設計判断1「jsonb一本化」と同じ方針で、
-- このためだけの複合型は追加しない）。

-- =========================================================================
-- 設計判断5: エラーコード — 'P0400'（EMPTY_ORDER）・'P0409'（SESSION_NOT_ACTIVE）
--   ・'P0410'（ITEM_SOLD_OUT）を新規に割り当てる
-- =========================================================================
-- 既存のカスタムSQLSTATE規約（本ファイル冒頭・0006・0007のコメント参照。
-- SQLSTATEクラス'P0'配下で、組み込みのP0001-P0004、および既存のP0401・P0403・
-- P0404と衝突しない未使用のサブコードを選ぶ）を踏襲する。
--   'P0400' EMPTY_ORDER   : 400 Bad Requestを想起させる数字（品目0件は呼び出し
--                           側の入力不備）
--   'P0409' SESSION_NOT_ACTIVE: 409 Conflictを想起させる数字（対象セッションが
--                           期待する'active'状態と矛盾する）
--   'P0410' ITEM_SOLD_OUT : 410 Goneを想起させる数字（品目がもはや注文可能では
--                           ない）。design.mdのSubmitOrderError型は
--                           { code: "ITEM_SOLD_OUT"; menuItemId: string }と
--                           menuItemIdを伴う構造を要求するため、RAISE EXCEPTIONの
--                           USING DETAIL句に該当menu_item_idを文字列として
--                           載せる（supabase-jsのPostgrestErrorはPostgres側の
--                           DETAILフィールドを.detailsとして公開するため、将来の
--                           TypeScriptラッパー（タスク3.4、本タスクのスコープ外）
--                           はerror.detailsからmenuItemIdを取り出せる）。

-- =========================================================================
-- 設計判断6: 実在しないmenuItemIdに専用のエラーコードを割り当てない
-- =========================================================================
-- design.mdのSubmitOrderError型はSESSION_NOT_ACTIVE/ITEM_SOLD_OUT/EMPTY_ORDERの
-- 3種のみを定義しており、「実在しないmenuItemId」というケースをモデル化して
-- いない（客側UIは必ずgetOrderingContextが返したメニュー一覧からmenuItemIdを
-- 選ぶ設計であり、通常操作では到達し得ない入力である）。0007の設計判断
-- （p_roleが'kitchen'/'register'以外の場合をdevices.roleのCHECK制約による
-- 自然なcheck_violationに委ね、専用バリデーションを追加しなかった）と同じ方針を
-- 踏襲し、本関数でも専用ガードは追加しない。実在しないmenu_item_idに対しては
-- v_menu_item（%rowtype変数）が全列NULLのまま後続処理へ進み、最終的に
-- order_items.name_snapshot / unit_price_snapshotのNOT NULL制約（0001）に
-- よって自然にnot_null_violationとして拒否される。この失敗は2パス構成の
-- 2パス目（order_itemsへの実INSERT時点、ordersへの冪等INSERTより後）で
-- 起きるが、関数全体が呼び出し元と同一のトランザクションとして実行される
-- （PL/pgSQL関数から捕捉されない例外が伝播すると、そのトランザクション全体が
-- 中断される）ため、直前に成功していたordersへのINSERTを含め、本呼び出しで
-- 行ったすべての変更が破棄される。したがってこの経路でも「送信全体が失敗すれば
-- 何も残らない」という不変条件（設計判断4）は保たれる。

create or replace function public.submit_order(
  p_session_id uuid,
  p_idempotency_key text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_status text;
  v_prepared_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_menu_item_id uuid;
  v_quantity int;
  v_note text;
  v_client_options jsonb;
  v_menu_item public.menu_items;
  v_options_selected jsonb;
  v_options_summary text;
  v_summary_parts text[];
  v_opt jsonb;
  v_opt_id text;
  v_opt_type text;
  v_opt_label text;
  v_opt_value jsonb;
  v_order_id uuid;
  v_order_created_at timestamptz;
  v_deduplicated boolean := false;
  v_items_result jsonb := '[]'::jsonb;
  v_prepared jsonb;
  v_row record;
begin
  -- 1. セッション有効性の検証（要件1.9）。存在しない場合も'closed'の場合も
  --    区別せずSESSION_NOT_ACTIVEとして拒否する（design.mdのSubmitOrderError
  --    型に「セッションが存在しない」ための別コードがないため。Preconditions
  --    「submitOrder/createCallRequestは対象sessionIdが実在すること」を、
  --    実在しない場合も含めてこの単一エラーコードで表現する）。
  select status
    into v_session_status
    from public.table_sessions
    where id = p_session_id;

  if not found or v_session_status <> 'active' then
    raise exception 'session % is not active', p_session_id
      using errcode = 'P0409';
  end if;

  -- 2. 空配列の検証
  if p_items is null
     or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'order must contain at least one item'
      using errcode = 'P0400';
  end if;

  -- 3. 品目ごとの検証・スナップショット作成（2パス構成の1パス目）。ここでは
  --    DBへの書き込みを一切行わず、挿入予定データをv_prepared_itemsへ蓄積する
  --    だけに留める（設計判断4: 全体ロールバック方針）。
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_menu_item_id := (v_item ->> 'menuItemId')::uuid;
    v_quantity := (v_item ->> 'quantity')::int;
    v_note := v_item ->> 'note';
    v_client_options := coalesce(v_item -> 'optionSelections', '{}'::jsonb);

    -- クライアントの表示状態を信用せず、現在のmenu_itemsを再取得する
    -- （要件7.2、design.md「クライアントの表示状態を信用しない」原則）。
    select *
      into v_menu_item
      from public.menu_items
      where id = v_menu_item_id;

    -- 実在しないmenuItemIdの扱いは設計判断6を参照（専用ガードを設けず、
    -- 後続のNOT NULL制約による自然な失敗に委ねる）。

    if v_menu_item.sold_out then
      raise exception 'menu item % is sold out', v_menu_item_id
        using errcode = 'P0410', detail = v_menu_item_id::text;
    end if;

    -- 3a. optionSelectionsの整合性チェック（要件1.6, 1.8、design.md
    --     Validation「optionSelectionsのキーが当該品目のoptions定義に存在
    --     しない場合は無視し、必須ではない選択が欠けている場合はoptions側の
    --     default値で補う」）と、厨房/レジ表示用options_summaryの組み立て
    --     （design.md Consistency & Integrityの例「塩」「わさび抜き」を参考に、
    --     choiceは「ラベル: 選択値」、toggleはオンの場合のみラベル単独、
    --     counterは0でない場合のみ「ラベル×値」の形式とする。厳密な
    --     フォーマットはdesign.mdで規定されておらず実装者の裁量に委ねられて
    --     いる部分）。
    v_options_selected := '{}'::jsonb;
    v_summary_parts := array[]::text[];

    for v_opt in select * from jsonb_array_elements(coalesce(v_menu_item.options, '[]'::jsonb)) loop
      v_opt_id := v_opt ->> 'id';
      v_opt_type := v_opt ->> 'type';
      v_opt_label := v_opt ->> 'label';

      if v_client_options ? v_opt_id then
        v_opt_value := v_client_options -> v_opt_id;
      else
        v_opt_value := v_opt -> 'default';
      end if;

      v_options_selected := v_options_selected || jsonb_build_object(v_opt_id, v_opt_value);

      if v_opt_type = 'choice' then
        if v_opt_value is not null then
          v_summary_parts := array_append(v_summary_parts, v_opt_label || ': ' || (v_opt_value #>> '{}'));
        end if;
      elsif v_opt_type = 'toggle' then
        if v_opt_value is not null and (v_opt_value #>> '{}')::boolean then
          v_summary_parts := array_append(v_summary_parts, v_opt_label);
        end if;
      elsif v_opt_type = 'counter' then
        if v_opt_value is not null and coalesce((v_opt_value #>> '{}')::numeric, 0) <> 0 then
          v_summary_parts := array_append(v_summary_parts, v_opt_label || '×' || (v_opt_value #>> '{}'));
        end if;
      end if;
    end loop;

    if array_length(v_summary_parts, 1) is null then
      v_options_summary := null;
    else
      v_options_summary := array_to_string(v_summary_parts, '、');
    end if;

    -- menu_item_id単位で集約せず、p_itemsの配列要素ごとに1件ずつ
    -- v_prepared_itemsへ追加する（同一品目でもoptionSelectionsが異なれば
    -- 別明細として登録する要件1.8を満たすため。ここでグルーピングしない
    -- ことが本要件の実装そのものである）。
    v_prepared_items := v_prepared_items || jsonb_build_array(
      jsonb_build_object(
        'menuItemId', v_menu_item_id,
        'name', v_menu_item.name,
        'unitPrice', v_menu_item.price,
        'quantity', v_quantity,
        'note', v_note,
        'optionsSelected', v_options_selected,
        'optionsSummary', v_options_summary
      )
    );
  end loop;

  -- 4. 冪等性: ordersへのINSERTを試みる。一意制約違反（同一session_id +
  --    idempotency_keyの既存注文）を検知した場合のみ、新規のorder_items挿入を
  --    行わず既存注文を再取得する（設計判断3参照）。idにはgen_random_uuid()を
  --    明示的に呼ばず、0001_schema.sqlのorders.id列のdefault式に委ねる
  --    （search_path=''のSECURITY DEFINER関数内でpgcryptoの
  --    gen_random_uuid()をスキーマ修飾なしで直接呼ぶことを避けるため。
  --    列のdefault式はテーブル定義時に解決済みのため、この関数のsearch_path
  --    設定の影響を受けない）。
  begin
    insert into public.orders (session_id, idempotency_key)
    values (p_session_id, p_idempotency_key)
    returning id, created_at into v_order_id, v_order_created_at;

    v_deduplicated := false;
  exception
    when unique_violation then
      select id, created_at
        into v_order_id, v_order_created_at
        from public.orders
        where session_id = p_session_id
          and idempotency_key = p_idempotency_key;

      v_deduplicated := true;
  end;

  if v_deduplicated then
    -- 5a. 重複送信: 新規にorder_itemsを挿入せず、既存の明細をそのまま返す
    --     （design.md Postconditions「同一idempotencyKeyでの再送は新規行を
    --     作らず既存注文を返す（deduplicated: true）」）。挿入時点の自然順序の
    --     近似としてstatus_updated_at（挿入時にdefault now()が入る列）で
    --     並べる。
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', oi.id,
          'menuItemId', oi.menu_item_id,
          'name', oi.name_snapshot,
          'unitPrice', oi.unit_price_snapshot,
          'quantity', oi.quantity,
          'optionsSummary', oi.options_summary,
          'status', oi.status,
          'statusUpdatedAt', oi.status_updated_at
        )
        order by oi.status_updated_at, oi.id
      ),
      '[]'::jsonb
    )
    into v_items_result
    from public.order_items oi
    where oi.order_id = v_order_id;
  else
    -- 5b. 新規送信（2パス構成の2パス目）: v_prepared_itemsの各要素を1行ずつ
    --     order_itemsへ挿入する。新規行のstatusは品目のgenreによらず常に
    --     'received'から開始する（design.md Postconditions。genreは後続の
    --     ステータス遷移許可にのみ影響し、初期状態には影響しない）。idと
    --     status_updated_atは明示せず、0001_schema.sqlの列defaultに委ねる
    --     （上記4番のコメントと同じ理由）。
    for v_prepared in select * from jsonb_array_elements(v_prepared_items) loop
      insert into public.order_items (
        order_id,
        menu_item_id,
        name_snapshot,
        unit_price_snapshot,
        quantity,
        status,
        options_selected,
        options_summary,
        note
      ) values (
        v_order_id,
        (v_prepared ->> 'menuItemId')::uuid,
        v_prepared ->> 'name',
        (v_prepared ->> 'unitPrice')::numeric,
        (v_prepared ->> 'quantity')::int,
        'received',
        v_prepared -> 'optionsSelected',
        v_prepared ->> 'optionsSummary',
        v_prepared ->> 'note'
      )
      returning id, menu_item_id, name_snapshot, unit_price_snapshot, quantity, options_summary, status, status_updated_at
        into v_row;

      v_items_result := v_items_result || jsonb_build_array(
        jsonb_build_object(
          'id', v_row.id,
          'menuItemId', v_row.menu_item_id,
          'name', v_row.name_snapshot,
          'unitPrice', v_row.unit_price_snapshot,
          'quantity', v_row.quantity,
          'optionsSummary', v_row.options_summary,
          'status', v_row.status,
          'statusUpdatedAt', v_row.status_updated_at
        )
      );
    end loop;
  end if;

  return jsonb_build_object(
    'order', jsonb_build_object(
      'id', v_order_id,
      'createdAt', v_order_created_at,
      'items', v_items_result
    ),
    'deduplicated', v_deduplicated
  );
end;
$$;

comment on function public.submit_order(uuid, text, jsonb) is
  '客（anonロール、無ログイン）が注文を送信するCustomerOrderingGatewayの
   書き込み系RPC。対象セッションがactiveであること・各品目が売り切れでないことを
   サーバー側で再検証し（クライアント表示を信用しない、要件7.2）、いずれかを
   満たさない場合は何も挿入せずカスタムSQLSTATE ''P0409''（SESSION_NOT_ACTIVE）/
   ''P0410''（ITEM_SOLD_OUT、DETAILに該当menuItemIdを含む）で例外を送出する。
   品目が0件の場合は''P0400''（EMPTY_ORDER）。orders(session_id, idempotency_key)
   の一意制約違反をdeduplicated: trueの成功応答へ変換することで冪等性を実現し
   （設計判断3）、同一品目でもoptionSelectionsが異なれば別のorder_items行として
   登録する（要件1.8、設計判断4）。optionSelectionsは品目のoptions定義に存在
   しないキーを無視し、未指定のオプションはoptions側のdefault値で補ってから
   options_selectedへ保存する。新規のorder_items.statusは品目のgenreに
   よらず常に''received''から開始する。SECURITY DEFINER + search_path=''''は
   get_ordering_context（3.1）と同じsearch_pathなりすまし対策を踏襲する。';

-- =========================================================================
-- EXECUTE権限: anonのみ（get_ordering_contextと同じ理由。詳細は本ファイル冒頭
-- のget_ordering_context用EXECUTE権限コメントを参照。客側の真の匿名anon経路
-- 専用であり、authenticated（厨房/レジタブレット）には付与しない）
-- =========================================================================
revoke execute on function public.submit_order(uuid, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.submit_order(uuid, text, jsonb) to anon;
