-- 0003_rpc_customer_gateway.sql
-- table-order-kitchen: CustomerOrderingGateway RPC群
--
-- Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.12, 2.1, 2.2, 2.3, 7.2
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "CustomerOrderingGateway" コンポーネント（Responsibilities & Constraints,
--   Service Interface: getOrderingContext / GetOrderingContextInput /
--   OrderingContext / MenuItemView / MenuItemOption / OrderingContextError /
--   submitOrder / createCallRequest 一式）と、「注文送信〜厨房反映フロー」
--   シーケンス図の Key Decisions「get_ordering_contextとsubmit_orderを
--   分離することで、注文送信の直前に必ずセッション有効性を再検証する」を参照。
--
-- ファイル構成（design.md "File Structure Plan"）: 本ファイルは
--   get_ordering_context（3.1）/ submit_order（3.2）/ create_call_request（3.3）
--   の3関数をまとめて持つ（CustomerOrderingGatewayという単一の書き込み境界を
--   1マイグレーションファイルにまとめる設計判断）。3.3の完了により
--   CustomerOrderingGatewayのRPC層は本ファイルで完結する
--   （別ファイルへの分割はしない）。
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

-- =========================================================================
-- 設計判断9（タスク3.5で追加）: セッション単位レート制限 — 専用の追跡テーブルを
--   新設し、submit_orderの「妥当な送信試行」（新規注文としての成立、または
--   同一idempotencyKeyでの重複再送）をカウントする
-- =========================================================================
-- Context: design.md Security Considerations「submit_orderにセッション単位の
--   レート制限を設け、QRコード流出時の大量不正送信を緩和する」、
--   design.mdのCustomerOrderingGateway Implementation Notes「Risks」、
--   research.mdのRisks & Mitigations「QRコードのSNS拡散等による大量不正注文
--   ...submit_orderにセッション単位のレート制限（例: 1分あたりの送信回数上限）
--   を設ける」への対応。
--
-- Alternatives Considered:
--   1. ordersテーブルの当該session_idに対する直近作成行数を数える
--      （新規テーブル不要）。
--   2. 専用の追跡テーブル（session_id, ウィンドウ開始時刻, 件数）を新設し、
--      submit_orderの呼び出しをカウントする。
--
-- 1を不採用とした理由: ordersに実際に挿入された行数だけを数えると、
--   同一idempotencyKeyでの重複再送（設計判断3の冪等性ロジックにより新規行を
--   作らずdeduplicated: trueを返す）が一切カウントされない。同一
--   idempotencyKeyを使い回した高速な連打は新規注文を作らないため
--   「大量不正“注文”」そのものではないが、依然としてsubmit_orderの実行
--   そのもの（セッション検証・品目再検証・レスポンス組み立てを含む一連の
--   処理）を大量に誘発できてしまい、緩和したいDB負荷の一部を取りこぼす。
--   専用テーブルであればこのケースも捕捉できるため2を優先する。
--   （なお、「セッションが存在しない/closed」「空配列」「売り切れ品目を含む」
--   といった、そもそもordersへの書き込みに到達しない呼び出しについては、
--   1・2いずれの方式でもカウントできない。この点は後述の設計判断10で
--   扱う、本レート制限の意図的なスコープ限定である）。
--
-- 2を採用した理由: 「同一idempotencyKeyでの重複再送」を含めてカウントする
--   必要があるため、orders/order_itemsに現れない情報（「このセッションに
--   対してsubmit_orderが妥当な形で呼ばれた回数」）を独立に保持できる専用の
--   状態が必要である。
--
-- 方式: session_idごとに1行のみを持つ固定ウィンドウ（fixed window）カウンタ
--   とする（スライディングウィンドウ・トークンバケット等のより高精度な方式は、
--   本タスクが緩和したい脅威（短時間の大量連続呼び出し）に対しては過剰な
--   複雑さであり、Simplification原則に反する。ウィンドウ境界を跨ぐ瞬間に
--   多少のバースト超過を許し得る点は固定ウィンドウ方式の既知の限界だが、
--   research.mdの例示「1分あたりの送信回数上限」に忠実な最も単純な実装として
--   妥当と判断する）。
--
-- 行数の有界性（unbounded growthの検討）: session_id列をtable_sessions.idへの
--   外部キー・主キーとするため、本テーブルの行数は「これまでに作られた
--   table_sessionsの行数」と1:1以下に自然に有界化される（リクエストのたびに
--   新規行が増えるのではなく、既存行をUPSERTで更新するだけ）。table_sessions
--   自体が要件4.3「終了後の履歴保持」により削除されず増え続ける設計を既に
--   採用しているため、本テーブルの増加ペースはそれと同等以下であり、既存の
--   設計が既に許容している増加パターンを超えない。したがって本タスクの範囲
--   では専用のクリーンアップ処理（cronによる古い行の削除等）は過剰であり
--   実装しない。将来table_sessionsの物理削除・アーカイブ機構が導入される
--   場合は、on delete cascadeにより本テーブルの対応行も自動的に削除される。
--
-- スコープの独立性（「卓単位ではなくセッション単位」という要求への対応）:
--   主キーをtable_idではなくsession_idとすることで、同一卓での「来店Aの
--   セッション」と「来店Bのセッション」は独立したカウンタを持ち、また
--   異なる卓のセッション同士も互いに影響しない（結合テスト
--   submitOrderRateLimit.integration.test.tsのクロスセッション独立性検証を
--   参照）。1来店＝1集約ルート（design.md Domain Model）という既存の設計
--   単位ともそのまま一致する。
create table public.submit_order_rate_limits (
  session_id uuid primary key references public.table_sessions (id) on delete cascade,
  window_started_at timestamptz not null default now(),
  request_count int not null default 0
);

comment on table public.submit_order_rate_limits is
  'submit_order（本ファイル）専用のセッション単位レート制限カウンタ
   （タスク3.5、設計判断9参照）。session_idごとに1行のみを持つ固定ウィンドウ
   方式で、window_started_atから一定時間内のrequest_countを保持する。
   submit_order経由（SECURITY DEFINER）以外からの直接アクセスは想定しない
   ため、anon/authenticatedへの権限は一切付与しない（直後のGRANT/RLS設定
   参照）。';

-- Supabaseはpublicスキーマに新規作成されたテーブルへ、postgresロールからの
-- ALTER DEFAULT PRIVILEGESによりanon/authenticatedへの暗黙のフルアクセスを
-- 自動付与する（0002_rls_policies.sqlの背景コメントで実機検証済みの挙動と
-- 同一）。0002は0001時点で存在した8テーブルのみをrevoke対象としており、
-- 本テーブルは0003で新規作成されるため0002のrevoke文の対象に含まれない。
-- そのため同じ理由でRLS有効化＋明示的なrevokeをここでも行う
-- （0002の「1. RLS有効化」「2. Deny-by-default」と同じ2段構成）。
alter table public.submit_order_rate_limits enable row level security;

revoke all on public.submit_order_rate_limits from public, anon, authenticated;

-- =========================================================================
-- 設計判断10（タスク3.5で追加）: レート制限の実行タイミング — 「妥当な送信
--   試行」であることが確定した後（セッション有効性・空配列・売り切れ/
--   オプション検証の後、ordersへの冪等INSERTの直前）に評価する
-- =========================================================================
-- Context: 「レート制限チェックはactive状態検証や売り切れチェックより前に
--   置き、ペイロードの妥当性に関わらず生の呼び出し量そのものを絞るべきか、
--   それとも後に置き『それ以外は妥当な試行』だけを数えるべきか」という
--   トレードオフの検討。当初は前者（最も早い段階でチェックし、無効な
--   ペイロードの連打も含めて絞る）を採用しようとしたが、実装検証の過程で
--   PostgreSQLのトランザクション境界に起因する根本的な制約が判明し、
--   後者を採用するに至った。その経緯を以下に記す。
--
-- 却下した案（チェックを最も早い段階、ステップ1の直後に置く）とその
--   問題点: この案では、本関数が最終的にSESSION_NOT_ACTIVE/EMPTY_ORDER/
--   ITEM_SOLD_OUTのいずれかをRAISE EXCEPTIONで送出する呼び出しであっても、
--   その手前で行ったレート制限カウンタへのUPSERTは一旦「行われる」ように
--   見える。しかしPostgreSQLでは、1回のRPC呼び出し（1回のトップレベル
--   SQL文としてのsubmit_order呼び出し）全体が単一のトランザクションであり、
--   関数外へ伝播する未捕捉の例外はそのトランザクション全体をロールバックする
--   （設計判断6が既に述べている「関数全体が呼び出し元と同一のトランザクション
--   として実行される」という性質そのもの）。実装時に実機で検証した結果、
--   items: []（EMPTY_ORDER）を連続送信した場合、レート制限テーブルへの
--   UPSERTは一度も永続化されないことを確認した（RAISE EXCEPTIONによって
--   その呼び出し内で行った全ての書き込みが道連れで巻き戻されるため）。
--   つまり「エラーになる呼び出しでもカウンタへの加算だけは残したい」という
--   要求は、同一トランザクション内でRAISE EXCEPTIONを使う限り実現できない
--   （PL/pgSQLのEXCEPTIONブロックが張る暗黙のSAVEPOINTは、例外を捕捉して
--   握りつぶし関数が正常終了する場合にのみ効果を持つ。捕捉後に再送出
--   （RAISE）したり、そもそも捕捉しない場合は、そのSAVEPOINT以前の変更も
--   含めて最終的に全てロールバックされる）。回避するには、カウンタ更新を
--   dblink等の拡張機能を用いた自律トランザクション（呼び出し元とは独立に
--   即時コミットする別コネクション）にする必要があるが、v1のセキュリティ
--   緩和策としては明らかに過剰な複雑さであり、かつ本specが新規に外部拡張
--   機能への依存を追加することにもなるため不採用とした（Simplification
--   原則）。また、後続の検証失敗を「エラーを返さず握りつぶし、常に正常応答
--   を返す」ように本関数の契約自体を変更する案も検討したが、design.mdの
--   SubmitOrderError契約・3.1-3.4で既に確立したSQLSTATEベースのエラーモデル・
--   既存の結合テスト（submitOrder.integration.test.ts等）の前提を根本から
--   破壊するため、本タスクのスコープ（submit_order関数の内部ロジック追加）を
--   逸脱するとして不採用とした。
--
-- 採用した案（現在の実装）: レート制限の評価は、セッション有効性・空配列・
--   品目の売り切れ/オプション検証をすべて通過した直後、ordersへの冪等
--   INSERT（ステップ4）の直前に置く。この時点に到達した呼び出しは、
--   （設計判断6が述べる「実在しないmenuItemId」という稀な境界ケースを除けば）
--   以降で例外を送出せず必ず正常なreturnへ到達する。したがって、レート制限
--   自身がRAISE EXCEPTIONする場合を除き、この位置でのUPSERTは呼び出しの
--   最終的な成否とロールバックの巻き添えを気にする必要がない。
--
-- スコープの意図的な限定とその正当化: この配置では、セッションが実在しない/
--   closedである、items配列が空である、売り切れ品目を含む、といった
--   「明らかに無効な呼び出し」はレート制限のカウント対象に含まれない
--   （前述のPostgreSQLの制約上、技術的に含めることができないため）。
--   しかしresearch.mdが名指しする具体的リスクは「QRコードのSNS拡散等に
--   よる大量不正“注文”」であり、これが実際に成立する（厨房へ大量の偽注文が
--   投入される）ためには、攻撃者は有効なsession_id・有効なmenuItemIdを
--   使った「妥当な形の送信」を行う必要がある（無効なペイロードだけを
--   送り続けても、ordersへの書き込みは一切発生せず、design.mdが警戒する
--   「大量不正注文」は実現しない）。したがって本レート制限は、この具体的な
--   脅威像に対して直接効果を持つ範囲（妥当な送信試行、同一idempotencyKeyに
--   よる冪等な重複再送を含む）を対象とすれば要件を満たす。無効なペイロード
--   のみを大量に送り続けるような、注文の成立を伴わない一般的なDoS挙動は、
--   本タスクの対象であるアプリケーション層・セッション単位の緩和策の
--   スコープ外とし、必要であれば別途Vercel/Supabase側のネットワーク層
--   レート制限で対応すべき領域と整理する。
--
-- =========================================================================
-- 設計判断11（タスク3.5で追加）: 閾値 — 1セッションあたり60秒間に20回
-- =========================================================================
-- research.mdの例示「1分あたりの送信回数上限」に従い、ウィンドウは60秒固定
-- とする。
--
-- 閾値20回の根拠（実店舗＝居酒屋を想定した現実的な上限からの見積もり）:
--   - design.mdのCustomerOrderApp（要件1.12実装ノート）は「同席者の別端末
--     からの注文にもRealtimeで追随する」ことを明示しており、同一卓の複数人が
--     各自のスマートフォンから独立にsubmit_orderを呼ぶ運用を正式にサポート
--     している。研究で想定する卓規模（research.mdの規模感、卓10〜20の
--     一般的な居酒屋）から、1卓あたりの人数はおおよそ2〜8名程度と見積もる。
--   - 最も負荷が高い正常系は「全員がほぼ同時に一次の注文を確定する」瞬間で、
--     8名が60秒以内にそれぞれ1回ずつ送信すれば8回。通信不調によるクライアント
--     側の再試行（同一idempotencyKeyでの再送は冪等性により重複排除される
--     が、本レート制限のカウント対象には含む。設計判断9・10参照）を1人
--     あたり最大2回程度見込んでも、8名×2回=16回程度に収まる。
--   - この現実的な最大値（16回程度）に対して安全側の余裕を持たせつつ、
--     攻撃側の実効レートは大きく制限できる値として20回/60秒を採用する。
--     スクリプトによる連続送信を60秒あたり最大20回（1時間あたり最大1,200回）
--     に頭打ちさせることは、無制限の送信と比較すれば大幅な削減であり、
--     要件が求める「緩和」（完全な防止ではなく削減）の水準を満たす。
--   - 閾値・ウィンドウはsubmit_order関数内のローカル定数として直接埋め込み、
--     環境変数化・専用設定テーブル化は本タスク（v1のセキュリティ緩和策）の
--     範囲では過剰と判断する（将来運用調整が必要になった場合の変更点は、
--     この1関数内の宣言部のみに閉じる）。
--
-- SQLSTATE 'P0429': 既存のカスタムSQLSTATE規約（本ファイル冒頭・設計判断5
--   参照。SQLSTATEクラス'P0'配下で、既存のP0400/P0401/P0403/P0404/P0409/
--   P0410/P0412と衝突しない未使用のサブコード）を踏襲し、HTTPの
--   429 Too Many Requestsを想起させる'P0429'を新規に割り当てる。

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
  -- タスク3.5で追加（設計判断9・10・11）: セッション単位レート制限用。
  v_rate_limit_max constant int := 20;
  v_rate_limit_window constant interval := interval '60 seconds';
  v_rate_limit_count int;
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

  -- 3b. セッション単位のレート制限（タスク3.5で追加。設計判断9・10・11参照）。
  --     3a（品目ループ内のoptionSelections整合性チェック）とは別の、
  --     ループ終了直後のステップである。
  --     ここまでにセッションの実在・active状態・全品目の非売り切れ検証を
  --     通過しており、この呼び出しは（冪等キー重複を除けば）以降で例外を
  --     送出せず正常にreturnへ到達することがほぼ確定している（設計判断6の
  --     「実在しないmenuItemId」という稀な例外経路のみが残るが、これは既存の
  --     設計が既に許容している境界ケースであり本タスクでは特別扱いしない）。
  --     この位置に置く理由（PL/pgSQLのトランザクション境界に関する制約）:
  --     RAISE EXCEPTIONが関数外へ伝播すると、その呼び出し全体（1回のRPC
  --     呼び出し = 1トランザクション）がロールバックされ、直前に行った
  --     すべての書き込み（本テーブルへのUPSERTを含む）も巻き戻される
  --     （設計判断6のコメントで述べた「関数全体が呼び出し元と同一の
  --     トランザクションとして実行される」という既存の記述、および本タスクの
  --     実装時に実機で確認した挙動）。したがって、もしレート制限のUPSERTを
  --     ステップ1（セッション有効性検証）の直後に置いた場合、SESSION_NOT_ACTIVE/
  --     EMPTY_ORDER/ITEM_SOLD_OUTのいずれかで最終的に例外を送出する呼び出しは、
  --     その手前で行ったレート制限カウンタへの加算も道連れでロールバックされて
  --     しまい、「無効なペイロードを送り続ける呼び出しをレート制限で絞る」
  --     ことが実現できない（本関数はPL/pgSQL関数として全てのエラーをRAISE
  --     EXCEPTIONで通知する既存の規約を採用しており、後続の検証失敗を
  --     「エラーを返さず握りつぶす」方向に変更することは、design.mdの
  --     エラーモデル・SubmitOrderError契約・3.1-3.4の既存テストの前提を
  --     壊すため不採用。自律トランザクション（dblink等の拡張機能を用いて
  --     カウンタ更新だけを別コネクションで即時コミットする手法）を使えば
  --     回避できなくはないが、v1のセキュリティ緩和策としては明らかに過剰な
  --     複雑さであり、Simplification原則に反するため採用しない）。
  --     そのため本関数は、「セッションが実在しactiveであり、送信された
  --     items内に売り切れ品目がない、正当な形式の送信試行」をレート制限の
  --     対象と定義する。research.mdが名指しする脅威は「QRコードのSNS拡散
  --     等による大量不正“注文”」であり、攻撃者が実害（厨房への大量の
  --     偽注文投入）を狙う限り、このスコープの試行（新規注文としての成立、
  --     または同一idempotencyKeyでの重複再送によるdeduplicated応答の両方を
  --     含む）が実際のカウント対象になる。空配列やSESSION_NOT_ACTIVE等の
  --     「明らかに無効な呼び出し」を大量に送るだけの行為は、そもそも
  --     ordersへの書き込みを一切発生させない（設計判断4の全体ロール
  --     バック方針）ため「大量不正注文」という具体的リスクを実現し得ず、
  --     本タスクの対象外（必要であれば別途、Vercel/Supabase側のネットワーク
  --     層レート制限で対応すべき一般的なDoS対策の領域）と整理する。
  --
  --     UPSERT（INSERT ... ON CONFLICT DO UPDATE）1文で「ウィンドウ内なら
  --     件数+1、ウィンドウ外なら1へリセット」を原子的に行うため、同一
  --     セッションへの同時呼び出し間でも取りこぼし・二重カウントは起こらない
  --     （ON CONFLICT DO UPDATEの行ロックによる直列化という標準的な
  --     Postgresの保証）。閾値超過時にRAISE EXCEPTIONする際、この呼び出し
  --     自身のUPSERTもロールバックされるが、RETURNING句で取得した
  --     v_rate_limit_countの値（ロールバック前の計算結果）で閾値判定を
  --     行うため、閾値超過の判定自体はロールバックの影響を受けず、
  --     ウィンドウ内で20回目を超える呼び出しは以後すべて正しく拒否され
  --     続ける（テーブルに保存された値は20回目の呼び出し時点で固定される
  --     形になるが、閾値判定の正しさには影響しない）。
  insert into public.submit_order_rate_limits as rl (
    session_id, window_started_at, request_count
  )
  values (p_session_id, now(), 1)
  on conflict (session_id) do update
  set
    window_started_at = case
      when rl.window_started_at <= now() - v_rate_limit_window then now()
      else rl.window_started_at
    end,
    request_count = case
      when rl.window_started_at <= now() - v_rate_limit_window then 1
      else rl.request_count + 1
    end
  returning request_count into v_rate_limit_count;

  if v_rate_limit_count > v_rate_limit_max then
    raise exception 'session % exceeded submit_order rate limit (% requests within %)',
      p_session_id, v_rate_limit_count, v_rate_limit_window
      using errcode = 'P0429';
  end if;

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
   書き込み系RPC。対象セッションが実在しactiveであること・各品目が売り切れで
   ないことをサーバー側で再検証し（クライアント表示を信用しない、要件7.2）、
   いずれかを満たさない場合は何も挿入せずカスタムSQLSTATE ''P0409''
   （SESSION_NOT_ACTIVE）/ ''P0410''（ITEM_SOLD_OUT、DETAILに該当menuItemIdを
   含む）で例外を送出する。品目が0件の場合は''P0400''（EMPTY_ORDER）。
   加えて、上記の検証（セッション有効性・空配列・売り切れ）をすべて通過した
   「妥当な送信試行」に対し、ordersへの冪等INSERTの直前でsubmit_order_rate_limits
   （タスク3.5、設計判断9）によるセッション単位のレート制限を評価し、60秒間に
   20回を超える呼び出しをカスタムSQLSTATE ''P0429''（RATE_LIMITED）で拒否する。
   同一idempotencyKeyによる冪等な重複再送もこのカウント対象に含まれる。この
   評価をactive状態検証等より前に置けなかった理由（RAISE EXCEPTIONがトランザクション
   全体を巻き戻すため、後続で失敗する呼び出しのカウンタ加算だけを残すことが
   PostgreSQLの制約上できない）は設計判断10に詳述する。
   orders(session_id, idempotency_key)の一意制約違反をdeduplicated: trueの
   成功応答へ変換することで冪等性を実現し（設計判断3）、同一品目でも
   optionSelectionsが異なれば別のorder_items行として登録する（要件1.8、
   設計判断4）。optionSelectionsは品目のoptions定義に存在しないキーを無視し、
   未指定のオプションはoptions側のdefault値で補ってからoptions_selectedへ
   保存する。新規のorder_items.statusは品目のgenreによらず常に''received''
   から開始する。SECURITY DEFINER + search_path=''''はget_ordering_context
   （3.1）と同じsearch_pathなりすまし対策を踏襲する。';

-- =========================================================================
-- EXECUTE権限: anonのみ（get_ordering_contextと同じ理由。詳細は本ファイル冒頭
-- のget_ordering_context用EXECUTE権限コメントを参照。客側の真の匿名anon経路
-- 専用であり、authenticated（厨房/レジタブレット）には付与しない）
-- =========================================================================
revoke execute on function public.submit_order(uuid, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.submit_order(uuid, text, jsonb) to anon;

-- =========================================================================
-- タスク3.3: create_call_request RPC
-- =========================================================================
-- Requirements: 2.1, 2.2, 2.3
-- Design: design.mdの CustomerOrderingGateway コンポーネント（Responsibilities &
--   Constraints「呼び出し要求は同一セッションに未対応（open）のものがある場合、
--   新規作成しない（要件2.3）」、Service Interface: createCallRequest /
--   CreateCallRequestInput / CallRequest / CallRequestError）を参照。
--   get_ordering_context（3.1）・submit_order（3.2）と同じCustomerOrderingGateway
--   境界に属するため、ファイル冒頭のFile Structure Plan通り本ファイルへ追記する
--   （別ファイルへは分割しない）。

-- =========================================================================
-- 設計判断7: 未対応(open)呼び出しの重複防止をDBレベルの部分ユニークインデックス
--   で強制する（0001_schema.sqlのtable_sessions_active_table_id_keyと同じ着想）
-- =========================================================================
-- 0001_schema.sqlのcall_requestsテーブルには、要件4.1のtable_sessionsに相当する
-- 「セッションあたり未対応(open)の呼び出しは高々1件」という部分ユニーク制約が
-- まだ存在しない（1.3時点ではcreate_call_requestの実装がまだなく不要だった）。
-- submit_orderの冪等性（設計判断3、orders(session_id, idempotency_key)の
-- 一意制約）と同様に、「アプリケーション側のSELECTでの事前チェックだけに頼ると、
-- 2つの呼び出しがほぼ同時に到着した場合に両方がSELECT時点で『まだ無い』と
-- 判定してしまい、call_requestsの行が2件生成される」という競合状態が
-- 理論上あり得る。design.mdのtable_sessions Concurrency strategy
-- 「後着の呼び出しは一意制約違反を検知して処理する」という既存の設計方針を
-- そのまま踏襲し、DBレベルで「セッションあたり未対応の呼び出しは高々1件」を
-- 構造的に強制する部分ユニークインデックスをここで新設する（0001は既に
-- 適用済み・コミット済みのため変更せず、本タスクの境界である本ファイルに
-- 追加する。1.3のtable_sessions_active_table_id_keyと全く同じパターン）。
create unique index call_requests_open_session_id_key
  on public.call_requests (session_id)
  where status = 'open';

-- =========================================================================
-- 設計判断8: エラーコード — SESSION_NOT_ACTIVEはsubmit_order（3.2）の'P0409'を
--   再利用し、CALL_ALREADY_OPENには新規に'P0412'を割り当てる
-- =========================================================================
-- SESSION_NOT_ACTIVE: design.mdのSubmitOrderErrorとCallRequestErrorは、
--   どちらも全く同じ形状{ code: "SESSION_NOT_ACTIVE" }を持つ（「対象セッションが
--   activeでない」という同一の意味）。0003ファイル冒頭の設計判断5でP0409を
--   「対象セッションが期待するactive状態と矛盾する」という意味に割り当て済みで
--   あり、この意味はRPC関数をまたいでも変わらない。将来のTypeScript
--   ラッパー（3.4）やUI層のエラーハンドラは、どのRPCから返ってきたかに
--   関わらずSESSION_NOT_ACTIVEを常に同じSQLSTATEとして判別できる方が
--   一貫性があり、呼び出し元ごとに異なるコードを新設する理由もない。
--   （比較として0007のP0401は、同一関数内で意味の異なる2ケース
--   （未認証セッション／セットアップコード不一致）に使い回されており、
--   これは「異なる意味に同じコードを使う」という好ましくない例である。
--   本タスクの判断はそれとは逆に「同一の意味に同一のコードを使う」という
--   一貫した使い方であり、0006/0007のいずれもコードを意味の面で
--   RPCをまたいで共有する前例は無いが、本タスクではsubmit_orderと
--   create_call_requestが design.md 上で全く同一のエラー型を共有している
--   という強い根拠があるため、既存コードの再利用を選択する。）
--
-- CALL_ALREADY_OPEN: 一方、design.mdのCallRequestErrorはSubmitOrderErrorには
--   存在しない{ code: "CALL_ALREADY_OPEN" }という専用の型を明示的に定義して
--   おり、これはsubmit_orderの冪等性パターン（同一idempotencyKeyでの再送を
--   deduplicated: trueという「成功」応答に変換する。SubmitOrderResultの
--   Postconditionとして明記）とは意図的に異なる設計であることを示唆する。
--   submit_orderにはこのケース専用のエラーコードが存在しない（常に成功として
--   deduplicated: trueを返す）のに対し、create_call_requestの型シグネチャは
--   はっきりと専用のエラー共用体メンバーを持つ。要件2.3の文言「重複した
--   呼び出し通知を新たに作成しない」自体はエラー/成功いずれの応答形式も
--   排除していないが、design.mdの型定義がここまで明示的にCALL_ALREADY_OPENを
--   規定している以上、その設計文書に最も忠実な解釈はエラー応答として実装する
--   ことだと判断した（本タスクのタスク文書が示す判断基準と同じ理由）。
--   将来のUIタスク（6.3、呼び出しボタンUI）は、このエラーを「対応済みになる
--   まで再送不可を示す」というソフトな状態表示に変換すればよく、致命的な
--   失敗として扱う必要はない。
--   新規に'P0412'（HTTPの412 Precondition Failedを想起させる数字）を割り当てる。
--   「未対応の呼び出しが存在しないこと」という、新規作成が成立するための
--   暗黙の前提条件が満たされていない、という意味的な対応が取れるため。
--   既存のP0400/P0401/P0403/P0404/P0409/P0410とは衝突しない未使用の
--   サブコードである。design.mdのCallRequestError型は該当する既存の
--   呼び出し（call_requests.id）をDETAIL句に載せ、将来のTypeScript
--   ラッパー・UI層が追加の問い合わせなしに既存の呼び出しを参照できるように
--   する（submit_orderのITEM_SOLD_OUTがDETAILにmenu_item_idを載せる
--   パターンをそのまま踏襲）。

create or replace function public.create_call_request(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_status text;
  v_existing_call_id uuid;
  v_call_id uuid;
  v_created_at timestamptz;
begin
  -- 1. セッション有効性の検証。submit_order（3.2）と全く同じ理由・同じ
  --    'P0409'で、存在しない場合も'closed'の場合も区別せず拒否する
  --    （design.mdのPreconditions「submitOrder/createCallRequestは対象
  --    sessionIdが実在すること」を、実在しない場合も含めてこの単一の
  --    エラーコードで表現する）。
  select status
    into v_session_status
    from public.table_sessions
    where id = p_session_id;

  if not found or v_session_status <> 'active' then
    raise exception 'session % is not active', p_session_id
      using errcode = 'P0409';
  end if;

  -- 2. 重複防止の事前チェック（要件2.3）。通常の逐次呼び出し（客が呼び出し
  --    ボタンを連打する等）では、この時点でのSELECTだけで十分に重複を
  --    検知できる。真に同時到着した場合の競合は、後段のINSERTが
  --    call_requests_open_session_id_key（設計判断7）の一意制約違反を
  --    検知することで最終的に防止される（3.のexceptionブロック）。
  select id
    into v_existing_call_id
    from public.call_requests
    where session_id = p_session_id
      and status = 'open';

  if v_existing_call_id is not null then
    raise exception 'an open call request already exists for session %', p_session_id
      using errcode = 'P0412', detail = v_existing_call_id::text;
  end if;

  -- 3. 新規呼び出しの作成。call_requests_open_session_id_key（設計判断7）が
  --    真に同時到着した場合の最終防衛線となる。unique_violationを捕捉した
  --    場合は、submit_orderの冪等性パターン（deduplicated: trueへの変換）とは
  --    異なり成功へフォールバックせず、勝者側の既存行を再取得した上で
  --    上記2と同じCALL_ALREADY_OPENエラーへ変換する（設計判断8参照。
  --    本関数はこの一意制約とその意味上の帰結の両方に責任を持つ）。
  begin
    insert into public.call_requests (session_id, status)
    values (p_session_id, 'open')
    returning id, created_at into v_call_id, v_created_at;
  exception
    when unique_violation then
      select id
        into v_existing_call_id
        from public.call_requests
        where session_id = p_session_id
          and status = 'open';

      raise exception 'an open call request already exists for session %', p_session_id
        using errcode = 'P0412', detail = v_existing_call_id::text;
  end;

  return jsonb_build_object(
    'id', v_call_id,
    'sessionId', p_session_id,
    'status', 'open',
    'createdAt', v_created_at
  );
end;
$$;

comment on function public.create_call_request(uuid) is
  '客（anonロール、無ログイン）が呼び出しボタンを押した際に呼び出す
   CustomerOrderingGatewayの書き込み系RPC。対象セッションがactiveであることを
   サーバー側で再検証し、満たさない場合はカスタムSQLSTATE ''P0409''
   （SESSION_NOT_ACTIVE、submit_orderと同一の意味で同一コードを再利用。
   設計判断8参照）で例外を送出する。同一セッションに未対応(open)の呼び出しが
   既にある場合は新規行を作らずカスタムSQLSTATE ''P0412''（CALL_ALREADY_OPEN、
   design.mdのCallRequestError型に対応。DETAILに既存のcall_requests.idを含む）
   で拒否する（要件2.3）。この重複防止はcall_requests_open_session_id_key
   （セッションあたり未対応の呼び出しは高々1件という部分ユニークインデックス、
   設計判断7）によってDBレベルでも強制されるため、真に同時到着したリクエスト
   同士の競合でも2件目の行が生成されることはない。成功時はdesign.mdのCallRequest
   型と同じキー構成（id/sessionId/status/createdAt、statusは常に''open''）の
   jsonbを返す。resolved（対応済み）にする操作（StaffOperationsGateway.
   resolveCallRequest、タスク4.4）は本関数のスコープ外であり、resolved後の
   セッションへの新規呼び出しはここでの重複防止の対象外として通常どおり
   成功する。SECURITY DEFINER + search_path=''''はget_ordering_context（3.1）・
   submit_order（3.2）と同じsearch_pathなりすまし対策を踏襲する。';

-- =========================================================================
-- EXECUTE権限: anonのみ（get_ordering_context/submit_orderと同じ理由。詳細は
-- 本ファイル冒頭のget_ordering_context用EXECUTE権限コメントを参照。客側の
-- 真の匿名anon経路専用であり、authenticated（厨房/レジタブレット）には
-- 付与しない）
-- =========================================================================
revoke execute on function public.create_call_request(uuid)
  from public, anon, authenticated;

grant execute on function public.create_call_request(uuid) to anon;
