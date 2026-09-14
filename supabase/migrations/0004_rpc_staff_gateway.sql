-- 0004_rpc_staff_gateway.sql
-- table-order-kitchen: StaffOperationsGateway RPC群（タスク4.1）
-- start_session / close_session / update_party_size
--
-- Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "StaffOperationsGateway" コンポーネント（Responsibilities & Constraints,
--   Service Interface: startSession / StartSessionInput / TableSession /
--   StartSessionError / closeSession / CloseSessionInput / CloseSessionError /
--   updatePartySize / UpdatePartySizeInput / UpdatePartySizeError,
--   Preconditions/Postconditions/Invariants）と、「来店セッションのライフサイクル」
--   状態遷移図・Key Decisionsを参照。
--
-- スコープ: start_session / close_session / update_party_sizeの3関数のみ。
--   add_order_item / remove_order_item（4.2）、update_order_item_status（4.3）、
--   set_sold_out / resolve_call_request（4.4）、list_kitchen_feed /
--   list_register_feed（4.5）は本マイグレーションの対象外（design.mdの
--   File Structure Planはこれら全てを単一の0004ファイルに含める想定だが、
--   タスク文書のBoundary（StaffOperationsGateway、タスク4.1のみ）に従い、
--   本ファイルはタスク4.1の3関数のみを実装する。残りは4.2〜4.5で
--   本ファイルへの追記として実装される想定）。
--
-- =========================================================================
-- マイグレーション適用順序の検証（実機確認済み）:
--   「0004」というファイル名は0006（assert_device_role）より字句/数値順で
--   前に適用されるが、これは問題にならないことを実機で確認した
-- =========================================================================
-- 懸念: design.mdのFile Structure Planは
--   0001 -> 0002 -> 0003 -> 0004（本ファイル） -> 0005 -> 0006 -> 0007
--   という順序を想定して0004という名前を割り当てているが、0003
--   （0003_rpc_customer_gateway.sqlの冒頭コメント参照）が既に指摘する通り、
--   タスク2.1-2.3の実装過程でdesign.md未記載の2ファイル
--   （0006_assert_device_role.sql, 0007_provision_device.sql）が追加され、
--   実際に既に適用済み・コミット済みのマイグレーションは
--   0001 -> 0002 -> 0003 -> 0005 -> 0006 -> 0007 である（0004は歯抜けのまま
--   予約されていた）。本タスクの3関数はいずれも冒頭で
--   `perform public.assert_device_role(...)`を呼び出すため、
--   「0004という名前のファイルは、assert_device_role本体を定義する0006より
--   字句順で前に適用されるが、それは実行時エラーにならないか」を実機で
--   検証する必要があった。
--
-- 検証方法: 本ファイルを一時的に「assert_device_roleを呼び出すだけの
--   ダミー関数を定義する0004_rpc_staff_gateway.sql」に差し替えた状態で
--   `npm run db:reset`（内部的に`supabase db reset`、0001から0007まで
--   ファイル名の字句順に適用）を実行し、(a)適用全体が成功すること、
--   (b)適用完了後に生のpg接続からそのダミー関数を実際に呼び出し、
--   assert_device_role（0006で定義）まで正しく解決されて意図通り
--   カスタムSQLSTATE 'P0403'を送出することの両方を確認した。さらに
--   `show check_function_bodies;`で本環境がPostgresの既定値`on`のままで
--   あることも確認した（`check_function_bodies`を意図的に`off`にしていた
--   から通っただけ、という可能性を排除するため）。
--
-- 結論: 問題にならない。PostgreSQLはPL/pgSQL関数本体（`language plpgsql`）の
--   `CREATE [OR REPLACE] FUNCTION`時点では、`check_function_bodies = on`
--   （既定値）であっても、本体内で呼び出す他の関数が実際に存在するかどうかを
--   検証しない（構文チェックのみ行い、呼び出し先オブジェクトの解決は
--   実行時まで遅延される）。これは複数のPL/pgSQL関数が互いに前方参照・
--   相互参照することを可能にするための、Postgres本体の既知の仕様である。
--   したがって、本ファイル（0004）が定義するstart_session/close_session/
--   update_party_sizeの`CREATE FUNCTION`自体は、assert_device_role
--   （0006で後から定義される）が本ファイル適用時点でまだ存在しなくても
--   一切失敗しない。そして実際にこれらの関数が呼び出される（=クライアントが
--   PostgREST経由でRPCを叩く）のは、`supabase db reset`（または本番デプロイの
--   マイグレーション適用）が0001から0007まで完全に完了した後のみであり、
--   その時点ではファイル名の順序に関わらずassert_device_roleは既に存在する。
--   よって本ファイルはdesign.mdのFile Structure Planが定めた通りの名前
--   `0004_rpc_staff_gateway.sql`のまま、0003と0005の間（字句順）に
--   配置してよい。リネームによる回避は不要と判断した。
--
-- =========================================================================
-- 設計判断1: 3関数とも`register`ロール限定（`kitchen`は含めない）
-- =========================================================================
-- design.mdのStaffOperationsGateway Responsibilities & Constraints冒頭の
-- 「authenticatedロールかつJWTのdevice_roleクレームがkitchenまたはregisterで
-- ある場合のみ実行を許可する」は、StaffOperationsGateway全体（厨房向け・
-- レジ向けの両方を含む）が客のanon経路とは異なり何らかのスタッフデバイスで
-- なければ一切実行できない、という最も外側の粗い境界を述べたものであり、
-- 「個々のメソッドが必ずkitchen/register両方を受け付ける」ことまでは意味しない
-- （design.mdのPreconditionsも「全メソッドは呼び出し元JWTに有効なdevice_role
-- クレームがあることを要求する」という、値の種類を問わない一般的な記述に
-- 留まる）。実際にどちらのロールに絞るかは各メソッドの業務文脈で決まる。
-- 本タスクの3関数が対応する要件3（来店セッションの管理）のObjectiveは
-- 「レジスタッフとして、卓ごとに来店セッションを開始・終了したい」であり、
-- 8つのAcceptance Criteria（3.1-3.5、4.1-4.4）はいずれも主語が
-- 「レジスタッフ」または「来店セッション管理サービス」であって、厨房スタッフの
-- 関与は一切登場しない。design.mdのRequirements Traceability表でも
-- 「3.1-3.4 ... Interfaces: startSession, closeSession」
-- 「3.5 ... Interfaces: updatePartySize」として要件3系列のみに紐づく。
-- 以上から、来店セッションのライフサイクル操作（入退店・人数変更）はレジ専用の
-- 業務操作であり、厨房タブレットが呼び出せる必要はないと判断し、
-- `perform assert_device_role(array['register']);`のみを許可する
-- （`array['kitchen','register']`は採用しない）。将来、厨房から呼ぶ具体的な
-- ユースケースが生じた場合はdesign.mdのRevalidation Triggers
-- （Gateway関数シグネチャ変更時の再検証）に従って見直す。
--
-- =========================================================================
-- 設計判断2: エラーコード
-- =========================================================================
-- 既存のカスタムSQLSTATE規約（0006/0003/0007が確立。SQLSTATEクラス'P0'配下で
-- 組み込みP0001-P0004と衝突しない未使用のサブコードを選ぶ）を踏襲する。
--   TABLE_NOT_FOUND    : 'P0404'を再利用する（0003のget_ordering_contextが
--                        既に「卓が存在しない」という全く同じ意味で割り当て済み。
--                        0003冒頭の設計判断8と同じ理由で、同一の意味には
--                        同一のコードを使う）。
--   SESSION_NOT_ACTIVE : 'P0409'を再利用する（0003のsubmit_order/
--                        create_call_requestと全く同じ「対象セッションが
--                        期待するactive状態と矛盾する」という意味）。
--   SESSION_ALREADY_ACTIVE: 新規に'P0423'を割り当てる。既存のP0400/401/403/
--                        404/409/410/412/429のいずれとも意味が異なる
--                        （「対象がactiveでない」の逆で「既にactiveなものが
--                        存在するため新規作成できない」）ため使い回さない。
--                        HTTPの423 Locked（対象リソースが既に何かに
--                        ロックされていて操作できない）を想起させる数字とし、
--                        「当該卓が既存のアクティブセッションに占有されている」
--                        という意味に対応させる。design.mdのStartSessionError
--                        型が要求するactiveSessionId（衝突した既存セッションの
--                        id）はDETAIL句に載せる（submit_orderのITEM_SOLD_OUT・
--                        create_call_requestのCALL_ALREADY_OPENと同じ
--                        DETAILパターン）。
--   FORBIDDEN          : assert_device_role（0006）が送出する'P0403'を
--                        そのまま利用する（各関数は専用のFORBIDDEN処理を
--                        持たず、assert_device_roleの例外をそのまま
--                        呼び出し元へ伝播させる）。
--
-- =========================================================================
-- 設計判断3: SESSION_ALREADY_ACTIVEのactiveSessionId取得方法
-- =========================================================================
-- 部分ユニークインデックスtable_sessions_active_table_id_key（0001）の
-- 一意制約違反はPostgresの標準例外（unique_violation, SQLSTATE 23505）として
-- 検知されるが、この例外自体は「どの既存行と衝突したか」という情報を
-- 構造化した形では持たない。そのため、INSERTをネストしたBEGIN/EXCEPTIONで
-- 囲み、unique_violationを捕捉した後に改めて
-- `select id from table_sessions where table_id = p_table_id and status = 'active'`
-- で衝突相手の行を再取得する（create_call_requestの設計判断7・8と同じ
-- パターン）。この再取得は捕捉ブロック内で行われるため、直前のINSERT失敗による
-- 暗黙のSAVEPOINTロールバック後も安全に実行できる。
--
-- =========================================================================
-- 設計判断4: p_table_idの存在確認は事前SELECTで行う（FK違反への変換は行わない）
-- =========================================================================
-- table_sessions.table_id はtables(id)への外部キー（NOT NULL）であるため、
-- 実在しないp_table_idでINSERTを試みればforeign_key_violation
-- （SQLSTATE 23503）に自然になり得るが、design.mdのStartSessionErrorは
-- TABLE_NOT_FOUNDという専用コードを明示的に要求しており、FK違反をそのまま
-- 伝播させると呼び出し側がPostgRESTの生エラーから判別する必要が生じ、
-- 既存のカスタムSQLSTATE規約とも一貫しない。get_ordering_context（0003）が
-- 採用した「事前にexists確認し、なければ明示的にraise exceptionする」方式を
-- そのまま踏襲する。
--
-- =========================================================================
-- 設計判断5: SECURITY DEFINER + search_path=''
-- =========================================================================
-- authenticatedロールはtable_sessionsへの直接INSERT/UPDATE権限を持たない
-- （0002でRLS有効化・権限剥奪済み）ため、書き込みには0003のsubmit_order/
-- create_call_requestと同じSECURITY DEFINERが必須となる。search_path
-- なりすまし対策として`set search_path = ''`を設定し、本文内の全参照
-- （public.table_sessions, public.tables, public.assert_device_role）を
-- スキーマ修飾する（0003/0007と同じ構成）。

-- =========================================================================
-- start_session RPC
-- =========================================================================
create or replace function public.start_session(
  p_table_id uuid,
  p_party_size int
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table_exists boolean;
  v_new_session public.table_sessions;
  v_existing_active_session_id uuid;
begin
  -- 1. device_role検証（設計判断1: registerロール限定）を必ず先頭で行う。
  perform public.assert_device_role(array['register']);

  -- 2. 卓の実在確認（設計判断4）。
  select exists(select 1 from public.tables where id = p_table_id)
    into v_table_exists;

  if not v_table_exists then
    raise exception 'table % not found', p_table_id
      using errcode = 'P0404';
  end if;

  -- 3. 新規セッションの発行。table_sessions_active_table_id_key
  --    （0001の部分ユニークインデックス、要件4.1）の一意制約違反を
  --    SESSION_ALREADY_ACTIVEへ変換する（設計判断2・3、要件3.2）。
  --    idと started_at は0001の列defaultに委ね、closed_atは常にNULLのまま
  --    （新規セッションは必ずactiveから始まる）。
  begin
    insert into public.table_sessions (table_id, status, party_size)
    values (p_table_id, 'active', p_party_size)
    returning * into v_new_session;
  exception
    when unique_violation then
      select id
        into v_existing_active_session_id
        from public.table_sessions
        where table_id = p_table_id
          and status = 'active';

      raise exception 'table % already has an active session', p_table_id
        using errcode = 'P0423', detail = v_existing_active_session_id::text;
  end;

  return jsonb_build_object(
    'id', v_new_session.id,
    'tableId', v_new_session.table_id,
    'status', v_new_session.status,
    'startedAt', v_new_session.started_at,
    'closedAt', v_new_session.closed_at,
    'partySize', v_new_session.party_size
  );
end;
$$;

comment on function public.start_session(uuid, int) is
  'レジ（authenticated, device_role=''register''）が入店操作を行う際に呼び出す
   StaffOperationsGatewayの書き込み系RPC。冒頭でassert_device_role(array[''register''])
   により権限を検証し（それ以外のdevice_role・claim欠如はカスタムSQLSTATE ''P0403''、
   assert_device_role自身が送出）、指定卓が存在しない場合はカスタムSQLSTATE ''P0404''
   （TABLE_NOT_FOUND）を送出する。table_sessions_active_table_id_key
   （卓ごとに高々1つのactiveセッションという部分ユニークインデックス、要件4.1）の
   一意制約違反はカスタムSQLSTATE ''P0423''（SESSION_ALREADY_ACTIVE、DETAILに
   既存のアクティブセッションidを含む。design.mdのactiveSessionIdに対応）へ変換する
   （要件3.2）。成功時は新規発行されたTableSession（要件3.4の人数を含む。
   常にstatus=''active''・closedAt=null）をdesign.mdと同じキー構成のjsonbで返す。
   新規セッションは常に新しいidで発行され、旧セッションの再有効化は起こらない
   （要件4.4、0001のid列default gen_random_uuid()による）。SECURITY DEFINER +
   search_path=''''は0003/0007と同じsearch_pathなりすまし対策を踏襲する。';

-- EXECUTE権限: authenticatedのみ（anonには付与しない。粗い境界としての
-- 第一防衛線。実際のロール判定はassert_device_roleが担う）。Postgresは
-- 新規関数のEXECUTEをデフォルトでPUBLICへ自動付与するため、まずPUBLIC/anon/
-- authenticatedから剥奪してから、authenticatedにのみ明示的に付与し直す
-- （0006/0007と同じパターン）。
revoke execute on function public.start_session(uuid, int)
  from public, anon, authenticated;

grant execute on function public.start_session(uuid, int) to authenticated;

-- =========================================================================
-- close_session RPC
-- =========================================================================
create or replace function public.close_session(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.table_sessions;
begin
  -- 1. device_role検証（設計判断1: registerロール限定）。
  perform public.assert_device_role(array['register']);

  -- 2. activeなセッションのみを対象に更新する。セッションが存在しない場合も
  --    既にclosedの場合も区別せずSESSION_NOT_ACTIVEとする（0003の
  --    submit_order/create_call_requestと同じ「実在しない場合も含めて
  --    単一のエラーコードで表現する」方針）。
  update public.table_sessions
  set status = 'closed',
      closed_at = now()
  where id = p_session_id
    and status = 'active'
  returning * into v_session;

  if not found then
    raise exception 'session % is not active', p_session_id
      using errcode = 'P0409';
  end if;

  return jsonb_build_object(
    'id', v_session.id,
    'tableId', v_session.table_id,
    'status', v_session.status,
    'startedAt', v_session.started_at,
    'closedAt', v_session.closed_at,
    'partySize', v_session.party_size
  );
end;
$$;

comment on function public.close_session(uuid) is
  'レジ（authenticated, device_role=''register''）が確認済みの会計操作を確定した際に
   呼び出すStaffOperationsGatewayの書き込み系RPC（要件3.3。実行前確認自体はUI層
   RegisterConsoleの責務であり、本関数は確認済みの呼び出しのみを受け取る）。
   冒頭でassert_device_role(array[''register''])を検証する。対象セッションが
   activeでない（存在しない、または既にclosed）場合はカスタムSQLSTATE ''P0409''
   （SESSION_NOT_ACTIVE）を送出し、何も更新しない。成功時はstatus=''closed''・
   closed_at=now()に更新した後のTableSessionを返す。この成功後、当該セッションIDに
   紐づくsubmit_order（0003）は必ずSESSION_NOT_ACTIVEを返すようになる
   （design.md Postconditions）。SECURITY DEFINER + search_path=''''は
   start_sessionと同じ構成。';

revoke execute on function public.close_session(uuid)
  from public, anon, authenticated;

grant execute on function public.close_session(uuid) to authenticated;

-- =========================================================================
-- update_party_size RPC
-- =========================================================================
create or replace function public.update_party_size(
  p_session_id uuid,
  p_party_size int
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.table_sessions;
begin
  -- 1. device_role検証（設計判断1: registerロール限定）。
  perform public.assert_device_role(array['register']);

  -- 2. activeなセッションのみを対象に人数を更新する。タスク文書の観測可能な
  --    完了条件「会計済み（closed）のセッションに対するupdate_party_sizeが
  --    SESSION_NOT_ACTIVEエラーを返す」に対応（要件3.5）。close_sessionと同様、
  --    存在しない場合も区別せず単一のエラーコードとする。
  update public.table_sessions
  set party_size = p_party_size
  where id = p_session_id
    and status = 'active'
  returning * into v_session;

  if not found then
    raise exception 'session % is not active', p_session_id
      using errcode = 'P0409';
  end if;

  return jsonb_build_object(
    'id', v_session.id,
    'tableId', v_session.table_id,
    'status', v_session.status,
    'startedAt', v_session.started_at,
    'closedAt', v_session.closed_at,
    'partySize', v_session.party_size
  );
end;
$$;

comment on function public.update_party_size(uuid, int) is
  'レジ（authenticated, device_role=''register''）が来店中の卓の人数変更を確認済みで
   実行する際に呼び出すStaffOperationsGatewayの書き込み系RPC（要件3.5。実行前確認
   自体はUI層RegisterConsoleの責務）。冒頭でassert_device_role(array[''register''])を
   検証する。対象セッションがactiveでない（存在しない、または既にclosed）場合は
   カスタムSQLSTATE ''P0409''（SESSION_NOT_ACTIVE）を送出し、人数を変更しない。
   成功時は新しいparty_sizeを反映したTableSessionを返す。SECURITY DEFINER +
   search_path=''''はstart_session/close_sessionと同じ構成。';

revoke execute on function public.update_party_size(uuid, int)
  from public, anon, authenticated;

grant execute on function public.update_party_size(uuid, int) to authenticated;

-- =========================================================================
-- タスク4.2: add_order_item / remove_order_item RPC
-- =========================================================================
-- Requirements: 5.5, 5.6
-- Design: design.mdの StaffOperationsGateway コンポーネント（Responsibilities &
--   Constraints「addOrderItemはCustomerOrderingGateway.submitOrderと同じ検証
--   （セッションがactiveか、品目が売り切れでないか、optionSelectionsが品目の
--   options定義と整合しているか）をレジ/厨房起点の追加にも適用する（要件5.5）」
--   「removeOrderItemは指定された注文明細を削除する。会計後の履歴改ざんを防ぐため、
--   対象セッションが既にclosedの場合はORDER_ITEM_NOT_FOUNDとして拒否する
--   （要件5.6）」、Service Interface: addOrderItem / AddOrderItemInput /
--   AddOrderItemError / removeOrderItem / RemoveOrderItemInput /
--   RemoveOrderItemError）を参照。start_session/close_session/update_party_size
--   （4.1、本ファイル前半）と同じStaffOperationsGateway境界に属するため、
--   ファイル冒頭のスコープ注記の通り本ファイルへ追記する。
--
-- スコープ: add_order_item / remove_order_itemの2関数のみ。
--   update_order_item_status（4.3）、set_sold_out / resolve_call_request（4.4）、
--   list_kitchen_feed / list_register_feed（4.5）は本タスクの対象外
--   （4.1冒頭コメントの通り、それぞれ4.3〜4.5で本ファイルへ追記される想定）。
--
-- =========================================================================
-- 設計判断6: device_role — 両関数とも`register`ロール限定（`kitchen`は含めない）
-- =========================================================================
-- design.mdのStaffOperationsGateway Responsibilities & Constraints冒頭の一文
-- 「addOrderItemはCustomerOrderingGateway.submitOrderと同じ検証...をレジ/厨房
-- 起点の追加にも適用する」は、字面だけを見ると「レジ/厨房」の両方から呼ばれる
-- ことを示唆しているように読める。しかし、この一文が根拠として明示的に引く
-- 「（要件5.5）」を実際に参照すると、要件5.5の主語は明確に「レジスタッフ」
-- （EARS記法: "When レジスタッフが卓の注文に品目を追加する操作を行う, the
-- レジサービス shall..."）であり、厨房スタッフの関与は一切登場しない。
-- 同じくremoveOrderItemが根拠とする要件5.6も主語は「レジスタッフ」・
-- 「レジサービス」である。要件5自体のObjectiveも「レジスタッフとして、
-- 卓ごとの注文明細と合計金額を確認し、必要に応じて客の代わりに注文内容を
-- 調整したい」であり、要件5のタイトル自体が「レジでの卓別会計確認・注文管理」
-- （レジ専用）である。対照的に、厨房スタッフの操作を扱う要件6（注文受信・
-- 調理ステータス管理）・要件7（売り切れ登録）のAcceptance Criteriaには、
-- 品目の追加・削除に相当する記述が一切ない。design.mdのRequirements
-- Traceability表でも「5.5-5.7 | レジからの品目追加・削除・ステータス変更
-- （いずれも確認あり）」と、追加・削除操作を明示的に「レジから」と限定して
-- 要約している。
--
-- 4.1（本ファイル前半、設計判断1）が確立した先例と同じ判断基準
-- 「StaffOperationsGateway全体を許可するという最も粗い境界（authenticatedかつ
-- kitchen/registerのいずれか）を、各メソッドがそのまま両方に開放してよいことを
-- 意味するわけではなく、実際にどちらのロールに絞るかは各メソッドが紐づく
-- 要件の業務文脈で決まる」を、addOrderItem/removeOrderItemにも同様に適用する。
-- 以上から、「レジ/厨房起点の追加」という一文は、要件5.5/5.6という一次資料
-- （EARSの主語が一貫して「レジスタッフ」である）と矛盾する、Responsibilities
-- & Constraints側のやや緩い言い回し（design.md内の要約・パラフレーズ）である
-- と判断し、要件文書の厳密な記述を優先して`register`ロール限定とする
-- （`array['kitchen','register']`は採用しない）。
--
-- CONCERN（タスク完了報告にも記載）: この判断は本タスクの実装者が要件文書を
-- 一次資料として優先した結果であり、design.mdの当該一文自体は未修正のまま
-- 残る。将来厨房タブレットから品目追加/削除を行う具体的なユースケースが
-- 本当に必要と判明した場合（例: 厨房が客の口頭リクエストを直接追加したい等）は、
-- design.mdのRevalidation Triggers（Gateway関数シグネチャ変更時の再検証）に
-- 従い、要件5または要件6への追記を含めて明示的に見直すべきである。安全側
-- （より制限的な読み方）に倒す本判断は、4.1が既に確立した先例・セキュリティの
-- 保守的デフォルトの両方と一致する。
--
-- =========================================================================
-- 設計判断7: add_order_itemの検証ロジック — submit_order（0003）の単一品目版
-- =========================================================================
-- design.mdの指示通り、submit_order（0003_rpc_customer_gateway.sql）が確立した
-- 以下のロジックをそのまま踏襲し、複数品目のバッチではなく単一品目に適用する:
--   (a) セッション有効性検証（存在しない場合もclosedの場合も区別せず
--       SESSION_NOT_ACTIVE、'P0409'を再利用）
--   (b) クライアント表示を信用せず、現在のmenu_itemsを再取得して売り切れを
--       再検証する（ITEM_SOLD_OUT、'P0410'を再利用。DETAILにmenuItemIdを含む）
--   (c) optionSelectionsの整合性チェック（品目のoptions定義に存在しない
--       キーは無視し、未指定のキーはoptions側のdefault値で補う）と、
--       options_summaryの組み立て（choice/toggle/counterの書式もsubmit_order
--       と完全に同一にする）
-- submit_orderは「複数品目を一度に送信し、1品目でも売り切れなら全体を
-- ロールバックする」という2パス構成（設計判断4、0003参照）を取るが、
-- add_order_itemは仕様上ただ1品目のみを扱うため、この2パス構成（検証専用の
-- 中間jsonb配列を経由する設計）自体は不要であり、検証を通過した後に直接
-- order_itemsへ1行だけINSERTする単純な単一パスで足りる（Simplification原則）。
--
-- =========================================================================
-- 設計判断8: add_order_itemはレジ起点の追加専用に新規ordersコンテナ行を発行する
-- =========================================================================
-- design.mdのData Model（Logical Data Model）は、order_itemsが必ずordersに、
-- ordersが必ずtable_sessionsに属するという階層を定義する。orders(session_id,
-- idempotency_key)には一意制約があり、idempotency_key列はNOT NULL（0001_schema.sql）
-- であるため、レジ起点の単一品目追加であっても、何らかのidempotency_key値を
-- 持つordersコンテナ行が必要になる。
--
-- 検討した代替案:
--   (a) 対象セッションに既存のordersコンテナ行があればそれを再利用し、なければ
--       新規発行する。
--   (b) 呼び出しのたびに必ず新規のordersコンテナ行を発行する。
--
-- (a)を不採用とした理由: 「どの既存ordersコンテナ行を再利用するか」という基準
-- （最新のもの？最初のもの？）をdesign.mdは一切規定しておらず、複数の既存
-- ordersコンテナ行が同一セッションに存在する場合（客側submit_orderからの
-- 送信・過去のadd_order_item呼び出しの両方で既に複数存在し得る）にどれを選ぶ
-- かという恣意的なルールを追加で発明する必要がある。またレジ起点の追加は
-- 「客からの追加注文依頼を都度その場で登録する」性質の操作であり、design.md
-- Postconditions/Invariantsのいずれも「レジ起点の追加は既存orderへ集約される
-- べき」ことを要求していない。
--
-- (b)を採用した理由: idempotency_keyは本来「同一クライアントリクエストの
-- リトライ・連打による重複送信を吸収する」という客側submit_order固有の
-- 関心事（design.md CustomerOrderingGateway Responsibilities & Constraints
-- 参照）であり、レジ起点の単一品目追加には対応する概念が存在しない（レジ
-- スタッフの操作はUI層で実行前確認を経てから呼ばれる一回限りの確定操作であり、
-- design.mdのAddOrderItemInputにもidempotencyKeyに相当するフィールドは
-- 定義されていない）。したがって「常に新規のordersコンテナ行を1件発行する」が
-- 最も単純かつdesign.mdの型定義に忠実な実装である。一意制約を満たすための
-- idempotency_key値には、`'register-add:' || (乱数UUID)`という、再送デデュープ
-- を一切意図しない使い捨ての識別子を用いる（毎回一意なUUIDを生成するため、
-- orders(session_id, idempotency_key)の一意制約に抵触することは実質的にない。
-- 万一の衝突はunique_violationとして自然に失敗するが、この確率は無視できるほど
-- 小さく、専用のリトライロジックを設けるのはSimplification原則に反すると
-- 判断した）。gen_random_uuid()の呼び出しはget_ordering_context等と異なり
-- 列defaultに委ねられないため（idempotency_key列自体には0001でdefaultが
-- 定義されていない）、search_path=''下でも解決できるようextensions.gen_random_uuid()
-- とスキーマ修飾して直接呼び出す（0001冒頭コメント「pgcryptoがextensions
-- スキーマにデフォルトで有効化されている」、config.tomlのextra_search_path=
-- ["public","extensions"]を確認済み。submit_orderのコメントが述べる「search_path=''の
-- SECURITY DEFINER関数内でgen_random_uuid()をスキーマ修飾なしで直接呼ぶことを
-- 避ける」という注意点への対応として、非修飾では呼ばずスキーマ修飾する）。
--
-- 発行したordersコンテナ行が空（他に品目を持たない）まま残ること自体は、
-- design.mdのordersに対する不変条件（4.3「終了済みセッションおよびその注文
-- 履歴を削除せず保持する」）と矛盾しない。将来のlistRegisterFeed（4.5）の
-- 合計計算はorder_items単位でunit_price_snapshot*quantityを合算する設計
-- （0003のget_ordering_context冒頭コメント参照）であり、品目を持たない
-- ordersコンテナ行は合計計算に一切寄与しないため、この設計選択が金額集計へ
-- 悪影響を与えることはない。
--
-- =========================================================================
-- 設計判断9: remove_order_itemの検索とORDER_ITEM_NOT_FOUNDへの収束
-- =========================================================================
-- design.mdは「対象セッションが既にclosedの場合はORDER_ITEM_NOT_FOUNDとして
-- 拒否する」と明記しており、これは「注文明細idが実在しない」場合と全く同じ
-- エラーコードへ意図的に収束させる設計判断である（会計後、当該セッションに
-- そもそもその注文明細が存在したかどうかという情報自体を外部に漏らさない
-- ため。0003のsubmit_order/create_call_requestが「セッションが存在しない
-- 場合もclosedの場合も区別せずSESSION_NOT_ACTIVEとする」のと同型のパターン）。
-- order_items単体には所属セッションのstatusを直接持たないため、
-- order_items -> orders -> table_sessionsの2段のjoinで対象行のstatusを
-- 1クエリで取得し、
--   (i)  行が見つからない（注文明細idが実在しない）
--   (ii) 行は見つかるがtable_sessions.status <> 'active'（closed）
-- のいずれの場合もPL/pgSQLの`if not found`一本で判定できるようにする
-- （joinのwhere句に`and ts.status = 'active'`を含めれば、(i)(ii)いずれの
-- 場合も同一クエリの「該当行なし」という結果に自然に収束するため、コード分岐を
-- 増やす必要がない）。
--
-- =========================================================================
-- 設計判断10: remove_order_itemは空になったordersコンテナ行を追加で削除しない
-- =========================================================================
-- 対象の注文明細を削除した結果、その注文明細が属していたordersコンテナ行が
-- 品目0件の空行として残る可能性がある（特に設計判断8のレジ起点追加専用
-- コンテナは、追加された1品目がその後削除されると必然的に空になる）。
-- design.mdのRemoveOrderItemの契約（Service Interface, Postconditions/
-- Invariants）はordersコンテナ行自体の削除を一切要求しておらず、空のordersが
-- 存在すること自体は将来のlistRegisterFeed（4.5）の合計金額計算（品目0件は
-- 合計に0を寄与するだけで正しく処理される。0003のconfirmedTotal集計ロジック
-- 参照）にも支障がない。ordersを追加で削除する処理を持たせると、「他の
-- order_itemsから参照されている行を削除してよいかの判定」という不要な複雑さ
-- （本来ordersはorder_itemsからのみ参照される親であり、削除前の追加チェックが
-- 必要になる）が生まれるため、Simplification原則に従い実装しない。

-- =========================================================================
-- add_order_item RPC
-- =========================================================================
create or replace function public.add_order_item(
  p_session_id uuid,
  p_menu_item_id uuid,
  p_quantity int,
  p_option_selections jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_status text;
  v_client_options jsonb;
  v_menu_item public.menu_items;
  v_options_selected jsonb := '{}'::jsonb;
  v_options_summary text;
  v_summary_parts text[];
  v_opt jsonb;
  v_opt_id text;
  v_opt_type text;
  v_opt_label text;
  v_opt_value jsonb;
  v_order_id uuid;
  v_row record;
begin
  -- 1. device_role検証（設計判断6: registerロール限定）を必ず先頭で行う。
  perform public.assert_device_role(array['register']);

  -- 2. セッション有効性の検証（submit_order, 0003と同じ理由・同じ'P0409'。
  --    要件5.5）。存在しない場合もclosedの場合も区別しない。
  select status
    into v_session_status
    from public.table_sessions
    where id = p_session_id;

  if not found or v_session_status <> 'active' then
    raise exception 'session % is not active', p_session_id
      using errcode = 'P0409';
  end if;

  -- 3. クライアントの表示状態を信用せず、現在のmenu_itemsを再取得する
  --    （submit_orderと同じ、要件5.5・7.2の考え方）。
  v_client_options := coalesce(p_option_selections, '{}'::jsonb);

  select *
    into v_menu_item
    from public.menu_items
    where id = p_menu_item_id;

  -- 実在しないmenuItemIdの扱いは0003の設計判断6と同じ方針を踏襲する
  -- （専用ガードを設けず、後続のNOT NULL制約による自然な失敗に委ねる）。

  if v_menu_item.sold_out then
    raise exception 'menu item % is sold out', p_menu_item_id
      using errcode = 'P0410', detail = p_menu_item_id::text;
  end if;

  -- 4. optionSelectionsの整合性チェックとoptions_summaryの組み立て
  --    （submit_order, 0003の3aと完全に同一のロジック）。
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

  -- 5. レジ起点の追加専用のordersコンテナ行を新規発行する（設計判断8）。
  insert into public.orders (session_id, idempotency_key)
  values (p_session_id, 'register-add:' || extensions.gen_random_uuid()::text)
  returning id into v_order_id;

  -- 6. order_itemsへ1行挿入する。statusは品目のgenreによらず常に'received'
  --    から開始する（submit_orderと同じ、design.md Postconditions）。
  insert into public.order_items (
    order_id,
    menu_item_id,
    name_snapshot,
    unit_price_snapshot,
    quantity,
    status,
    options_selected,
    options_summary
  ) values (
    v_order_id,
    p_menu_item_id,
    v_menu_item.name,
    v_menu_item.price,
    p_quantity,
    'received',
    v_options_selected,
    v_options_summary
  )
  returning id, menu_item_id, name_snapshot, unit_price_snapshot, quantity, options_summary, status, status_updated_at
    into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'menuItemId', v_row.menu_item_id,
    'name', v_row.name_snapshot,
    'unitPrice', v_row.unit_price_snapshot,
    'quantity', v_row.quantity,
    'optionsSummary', v_row.options_summary,
    'status', v_row.status,
    'statusUpdatedAt', v_row.status_updated_at
  );
end;
$$;

comment on function public.add_order_item(uuid, uuid, int, jsonb) is
  'レジ（authenticated, device_role=''register''。設計判断6参照）が卓の注文へ
   品目を追加する際に呼び出すStaffOperationsGatewayの書き込み系RPC（要件5.5。
   実行前確認自体はUI層RegisterConsoleの責務であり、本関数は確認済みの呼び出しの
   みを受け取る）。冒頭でassert_device_role(array[''register''])を検証する
   （それ以外のdevice_role・claim欠如はカスタムSQLSTATE ''P0403''、
   assert_device_role自身が送出）。対象セッションがactiveでない（存在しない、
   または既にclosed）場合はカスタムSQLSTATE ''P0409''（SESSION_NOT_ACTIVE、
   submit_order/close_session/update_party_sizeと同一の意味で再利用）を送出し、
   何も挿入しない。品目が売り切れの場合はカスタムSQLSTATE ''P0410''
   （ITEM_SOLD_OUT、DETAILに該当menuItemIdを含む。submit_orderと同一の意味で
   再利用）を送出し、何も挿入しない。optionSelectionsは品目のoptions定義に
   存在しないキーを無視し、未指定のオプションはoptions側のdefault値で補って
   からoptions_selectedへ保存する（submit_order, 0003と完全に同一のロジック）。
   idempotency_keyという客側submit_order固有の冪等性概念を持たないため
   （design.mdのAddOrderItemInputにも対応するフィールドがない）、呼び出しの
   たびに使い捨てのidempotency_key（''register-add:''接頭辞＋乱数UUID）を持つ
   新規ordersコンテナ行を発行してから、その配下へ1件のorder_itemsを挿入する
   （設計判断8）。新規のorder_items.statusは品目のgenreによらず常に''received''
   から開始する。SECURITY DEFINER + search_path=''''は他のStaffOperationsGateway
   RPCと同じsearch_pathなりすまし対策を踏襲する。';

revoke execute on function public.add_order_item(uuid, uuid, int, jsonb)
  from public, anon, authenticated;

grant execute on function public.add_order_item(uuid, uuid, int, jsonb) to authenticated;

-- =========================================================================
-- remove_order_item RPC
-- =========================================================================
create or replace function public.remove_order_item(
  p_order_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found boolean;
begin
  -- 1. device_role検証（設計判断6: registerロール限定）。
  perform public.assert_device_role(array['register']);

  -- 2. 対象の注文明細を、その所属order->session経由でセッションのstatusまで
  --    1クエリのjoinで確認する（設計判断9）。注文明細idが実在しない場合と、
  --    実在するが所属セッションが既にclosedの場合の両方を、この1クエリの
  --    「該当行なし」に自然に収束させることで、同一のORDER_ITEM_NOT_FOUND
  --    エラーへ意図的に収束させる（design.md「会計後の履歴改ざんを防ぐため」
  --    という理由の通り、外部からは両者を区別させない）。
  select true
    into v_found
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join public.table_sessions ts on ts.id = o.session_id
    where oi.id = p_order_item_id
      and ts.status = 'active';

  if not found then
    raise exception 'order item % not found or its session is not active', p_order_item_id
      using errcode = 'P0444';
  end if;

  -- 3. 削除。上記2で existence + active session を確認済みのため、
  --    ここでの削除条件はidのみでよい（他セッションの同idの行と衝突する
  --    ことはあり得ない。idは主キーのため）。
  delete from public.order_items where id = p_order_item_id;

  -- 空になったordersコンテナ行を追加で削除しない方針は設計判断10を参照。
  return jsonb_build_object('orderItemId', p_order_item_id);
end;
$$;

comment on function public.remove_order_item(uuid) is
  'レジ（authenticated, device_role=''register''。設計判断6参照）が注文明細を
   削除する際に呼び出すStaffOperationsGatewayの書き込み系RPC（要件5.6。
   実行前確認自体はUI層RegisterConsoleの責務であり、本関数は確認済みの呼び出しの
   みを受け取る）。冒頭でassert_device_role(array[''register''])を検証する。
   対象のorder_item_idが実在しない場合、および実在するがその所属セッションが
   既にclosedの場合の両方について、カスタムSQLSTATE ''P0444''
   （ORDER_ITEM_NOT_FOUND）を同一のエラーコードとして送出し、何も削除しない
   （design.mdが明記する「会計後の履歴改ざんを防ぐため」の意図的な情報秘匿。
   設計判断9参照。タスクの観測可能な完了条件: 既に会計済みのセッションの注文
   明細を削除しようとするとORDER_ITEM_NOT_FOUNDが返る）。成功時は
   { orderItemId }を返す。削除後に空になり得るordersコンテナ行の追加削除は
   行わない（設計判断10）。SECURITY DEFINER + search_path=''''は他の
   StaffOperationsGateway RPCと同じsearch_pathなりすまし対策を踏襲する。';

revoke execute on function public.remove_order_item(uuid)
  from public, anon, authenticated;

grant execute on function public.remove_order_item(uuid) to authenticated;

-- =========================================================================
-- タスク4.3: update_order_item_status RPC
-- =========================================================================
-- Requirements: 5.7, 6.2, 6.3, 6.4, 6.5, 6.6, 6.10
-- Design: design.mdの StaffOperationsGateway コンポーネント（Responsibilities &
--   Constraints「updateOrderItemStatusは対象の注文明細が属する品目のジャンルを
--   見て、許可される遷移を判定する。フード/一品ジャンルはreceived → in_progress
--   → done、ドリンクジャンルはreceived → doneのみを許可する（要件6.3, 6.4, 5.7）」
--   「一品ジャンルの品目に限り、receivedからin_progressを経由せず直接doneへ
--   遷移する呼び出しも許可する（要件6.6）」、Invariants「updateOrderItemStatusは
--   対象品目のジャンルに応じた許可遷移表の範囲内でのみ遷移を許可し、それ以外は
--   INVALID_TRANSITIONとする」、Service Interface: updateOrderItemStatus /
--   UpdateOrderItemStatusInput / UpdateOrderItemStatusError）を参照。
--
-- スコープ: update_order_item_status単体のみ。set_sold_out /
--   resolve_call_request（4.4）、list_kitchen_feed / list_register_feed（4.5）は
--   本タスクの対象外（4.1冒頭コメントの通り、それぞれ4.4/4.5で本ファイルへ
--   追記される想定）。
--
-- =========================================================================
-- 設計判断11: device_role — kitchen/register両方を許可する
--   （4.1/4.2のregister限定パターンをそのまま流用しない）
-- =========================================================================
-- 4.1（設計判断1）・4.2（設計判断6）は、design.mdのResponsibilities &
-- Constraints冒頭の粗い境界（authenticatedかつdevice_roleがkitchenまたは
-- registerのいずれか）を各メソッドがそのまま両方に開放してよいわけではないと
-- 判断し、要件文書のEARS主語（いずれも「レジスタッフ」）に基づきregister限定と
-- した。updateOrderItemStatusについても同じ判断基準を適用するが、今回は
-- 要件文書・design.md双方の一次資料が明確に「両ロールから呼ばれる」ことを
-- 示しており、4.1/4.2とは結論が異なる。
--
-- 根拠(a) 要件文書: 本RPCが対応する要件は6.5（「厨房スタッフが品目のステータスを
-- 更新する」、主語は厨房スタッフ・厨房KDSサービス）と5.7（「レジスタッフが
-- 品目のステータスを更新する操作を行う」、主語はレジスタッフ・レジサービス）の
-- 両方であり、4.1/4.2の要件（3.1-3.5、5.5、5.6）がいずれも「レジスタッフ」
-- 単独主語だったのとは異なり、本RPCは要件文書レベルで最初から両ロールの操作
-- として明記されている。
--
-- 根拠(b) design.md: StaffOperationsGateway Responsibilities & Constraintsの
-- updateOrderItemStatusに関する記述（「対象の注文明細が属する品目のジャンルを
-- 見て、許可される遷移を判定する...（要件6.3, 6.4, 5.7）」）は、4.1のstart_session
-- 等の記述文（「レジスタッフの入店操作」等、明示的にレジ主体の業務文脈のみを
-- 述べる）とは異なり、根拠として引く要件番号自体に厨房系（6.3, 6.4）とレジ系
-- （5.7）の両方を含めている。Requirements Traceability表でも「5.5-5.7 | レジ
-- からの品目追加・削除・ステータス変更」と「6.1, 6.2, 6.5, 6.8, 6.9 | ...
-- StaffOperationsGateway, RealtimeFeed | listKitchenFeed, updateOrderItemStatus」
-- の両方の行にupdateOrderItemStatus（または要件5.7）が登場する。さらにdesign.md
-- のKitchenBoard UI説明「各ボードは...ジャンルに応じたステータス更新UIを提供し」、
-- RegisterConsole UI説明「...ステータス変更...はいずれも実行前に確認ダイアログを
-- 表示し、確認後にのみ対応するStaffOperationsGatewayのメソッドを呼び出す
-- （要件3.3, 3.5, 5.5-5.7）」の両方が本RPCの利用を明記する。
--
-- 4.1/4.2のCONCERN注記が「design.mdの緩い言い回しより要件文書のEARS主語を
-- 優先した」結果register限定としたのとは対照的に、本RPCは要件文書とdesign.md
-- （Responsibilities & Constraints・Requirements Traceability・UI説明の
-- いずれも）が一致して両ロールでの利用を述べており、優先すべき一次資料同士に
-- 矛盾がない。過度な制限（本来許可すべきregisterロールをFORBIDDENにしてしまう
-- こと）は過度な開放と同程度の欠陥であるため、要件・設計の記述通り
-- `assert_device_role(array['kitchen','register'])`とする。
--
-- =========================================================================
-- 設計判断12: ジャンル別許可遷移表とエラーコード
-- =========================================================================
-- order_items.status（0001のCHECK制約）は'received'/'in_progress'/'done'の
-- 3値のみを許容するが、実際にどの遷移が許可されるかはmenu_items.genreに
-- 依存するため、他テーブルを参照する条件はCHECK制約で表現できない
-- （0001 Consistency & Integrity参照）。よって本関数内でジャンル別の許可
-- 遷移表を判定ロジックとして実装する:
--   genre = 'food' : received -> in_progress, in_progress -> done のみ許可
--   genre = 'ippin': received -> in_progress, in_progress -> done に加えて
--                    received -> done の直接ショートカットも許可（要件6.6）
--   genre = 'drink': received -> done のみ許可（in_progressは経由しない、
--                    要件6.4）
-- 上記以外の要求（後退遷移、同一ステータスへの遷移、food/drinkジャンルへの
-- 誤ったショートカット要求等）はすべてINVALID_TRANSITIONとする。
--
-- ORDER_ITEM_NOT_FOUND: 4.2のremove_order_item（設計判断9）が確立した
-- カスタムSQLSTATE 'P0444'をそのまま再利用する。remove_order_itemの
-- ORDER_ITEM_NOT_FOUNDは「注文明細idが実在しない」場合と「実在するが所属
-- セッションが既にclosed」場合の両方をあえて同一コードへ収束させる設計判断
-- だったが、design.mdのUpdateOrderItemStatusErrorはORDER_ITEM_NOT_FOUNDの
-- みを定義し、セッションのactive/closed状態に関する専用のエラーコード
-- （SESSION_NOT_ACTIVE相当）を一切要求していない。本関数はセッションの
-- active/closed状態を検証条件に含めない（design.mdのInvariants・
-- Responsibilities & Constraintsのいずれもそのような検証を要求していないため。
-- 調理ステータス更新は本質的にセッションのライフサイクルとは独立した関心事
-- である）。したがってここでのORDER_ITEM_NOT_FOUNDは純粋に「指定された
-- order_item_idが実在しない」という意味のみを持ち、remove_order_itemの
-- ORDER_ITEM_NOT_FOUND（「実在しない、または実在するがセッションがclosed」）
-- とは判定条件が異なる。しかし両者は「呼び出し元が参照した注文明細を対象と
-- した操作が実行できない」という同一のエラー意味論（0003冒頭の設計判断8が
-- 確立した「同一の意味には同一のコードを使う」原則）を共有するため、新規の
-- SQLSTATEを割り当てず'P0444'を再利用する。
--
-- INVALID_TRANSITION: 既存のP0400/P0401/P0403/P0404/P0409/P0410/P0412/
-- P0423/P0429/P0444のいずれとも意味が異なる新規のエラーのため、新規に
-- 'P0422'を割り当てる。当初'P0429'（HTTPの429を想起させる番号）を検討したが、
-- 実装直前に0003_rpc_customer_gateway.sqlを確認したところ、'P0429'は既に
-- タスク3.5のRATE_LIMITED（submit_orderのセッション単位レート制限超過）に
-- 割り当て済みであることが判明した。RATE_LIMITEDとINVALID_TRANSITIONは
-- 全く異なる意味（前者は「短時間の呼び出し過多」、後者は「対象品目の現在
-- ステータス・ジャンルに対して許可されない遷移」）であり、0003冒頭の設計判断8
-- 「同一の意味には同一のコードを使う」の裏返しである「異なる意味には異なる
-- コードを使う」に従い、流用せず新規のサブコードを選び直す。'P0422'は
-- HTTPの422 Unprocessable Entity（リクエスト自体は構文的に正しいが、現在の
-- リソース状態に対して意味的に処理できない）を想起させ、「遷移として構文上は
-- 妥当なstatus値だが、対象品目の現在状態・ジャンルに対しては許可されない」
-- というINVALID_TRANSITIONの意味に合致する。既存の採番済みコード
-- （P0400/P0401/P0403/P0404/P0409/P0410/P0412/P0423/P0429/P0444）のいずれとも
-- 衝突しないことを本関数実装直前に確認した。design.mdのUpdateOrderItemStatusError型が要求する
-- { from, to }はDETAIL句にJSON文字列として載せる（既存のDETAILパターンは
-- 単一のスカラー値=文字列のみだったが、本エラーは2つのフィールドを持つ
-- オブジェクトを返す必要があるため、jsonb_build_objectの結果をtext化して
-- DETAILへ格納する。呼び出し側のTypeScriptラッパー（4.6、本タスクの対象外）
-- がJSON.parseしてfrom/toを取り出す想定）。
--
-- =========================================================================
-- 設計判断13: 対象品目のジャンルのlookupとSELECT ... FOR UPDATE
-- =========================================================================
-- order_itemsは自身のgenreを持たず、menu_item_id経由でmenu_itemsを参照する
-- 必要がある（0001 Logical/Physical Data Model参照）。1クエリのjoinで
-- 現在のstatusとgenreの両方を取得し、行ロック（FOR UPDATE）を掛けてから
-- 判定・更新することで、同一注文明細への同時更新リクエストが競合した場合に
-- 古い状態を読んだままの判定（TOCTOU）を避ける。取得できなければ
-- ORDER_ITEM_NOT_FOUND（設計判断12）。
create or replace function public.update_order_item_status(
  p_order_item_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_status text;
  v_genre text;
  v_allowed boolean := false;
  v_row record;
begin
  -- 1. device_role検証（設計判断11: kitchen/register両方を許可）。
  perform public.assert_device_role(array['kitchen', 'register']);

  -- 2. 対象の注文明細の現在のstatusと、所属品目のgenreを1クエリのjoinで取得し、
  --    行ロックする（設計判断13）。存在しない場合はORDER_ITEM_NOT_FOUND。
  select oi.status, mi.genre
    into v_current_status, v_genre
    from public.order_items oi
    join public.menu_items mi on mi.id = oi.menu_item_id
    where oi.id = p_order_item_id
    for update of oi;

  if not found then
    raise exception 'order item % not found', p_order_item_id
      using errcode = 'P0444';
  end if;

  -- 3. ジャンル別の許可遷移表を判定する（設計判断12）。
  if v_genre = 'food' then
    v_allowed :=
      (v_current_status = 'received' and p_status = 'in_progress')
      or (v_current_status = 'in_progress' and p_status = 'done');
  elsif v_genre = 'ippin' then
    v_allowed :=
      (v_current_status = 'received' and p_status = 'in_progress')
      or (v_current_status = 'in_progress' and p_status = 'done')
      -- 要件6.6: 一品ジャンルのみ received -> done の直接ショートカットを許可。
      or (v_current_status = 'received' and p_status = 'done');
  elsif v_genre = 'drink' then
    -- 要件6.4: ドリンクはin_progressを経由しない。
    v_allowed := (v_current_status = 'received' and p_status = 'done');
  end if;

  if not v_allowed then
    raise exception 'invalid status transition from % to % for order item %',
      v_current_status, p_status, p_order_item_id
      using errcode = 'P0422',
            detail = jsonb_build_object(
              'from', v_current_status,
              'to', p_status
            )::text;
  end if;

  -- 4. 許可された遷移のみ、statusとstatus_updated_atを更新する（要件6.10）。
  update public.order_items
  set status = p_status,
      status_updated_at = now()
  where id = p_order_item_id
  returning id, menu_item_id, name_snapshot, unit_price_snapshot, quantity, options_summary, status, status_updated_at
    into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'menuItemId', v_row.menu_item_id,
    'name', v_row.name_snapshot,
    'unitPrice', v_row.unit_price_snapshot,
    'quantity', v_row.quantity,
    'optionsSummary', v_row.options_summary,
    'status', v_row.status,
    'statusUpdatedAt', v_row.status_updated_at
  );
end;
$$;

comment on function public.update_order_item_status(uuid, text) is
  '厨房（device_role=''kitchen''）・レジ（device_role=''register''）の両方から
   呼び出されるStaffOperationsGatewayの書き込み系RPC（要件5.7, 6.2, 6.3, 6.4,
   6.5, 6.6, 6.10。設計判断11参照: 4.1/4.2のregister限定パターンとは異なり、
   本RPCは要件文書・design.md双方が両ロールでの利用を明記するため
   assert_device_role(array[''kitchen'',''register''])とする）。対象の注文明細が
   実在しない場合はカスタムSQLSTATE ''P0444''（ORDER_ITEM_NOT_FOUND、4.2の
   remove_order_itemと同一の意味で再利用）を送出する。対象品目のgenre
   （food/ippin/drink）に応じた許可遷移表の範囲外の遷移要求（後退遷移・
   同一ステータスへの遷移・food/drinkジャンルでのreceived->done直接
   ショートカット要求を含む）はカスタムSQLSTATE ''P0422''（INVALID_TRANSITION、
   本タスクで新規割当。P0429は3.5のRATE_LIMITEDが既に使用しているため流用せず
   選び直した。DETAILに{from,to}のJSON文字列を含む）を送出し、何も
   更新しない。許可された遷移のみstatusとstatus_updated_at=now()を更新する
   （要件6.10、調理完了列の直近完了順ソートキー）。フード/一品ジャンルは
   received -> in_progress -> doneの段階的遷移のみ、一品ジャンルのみ追加で
   received -> doneの直接ショートカットを許可し（要件6.6）、ドリンクジャンルは
   received -> doneのみを許可する（in_progressを経由しない、要件6.4）。
   SECURITY DEFINER + search_path=''''は他のStaffOperationsGateway RPCと
   同じsearch_pathなりすまし対策を踏襲する。';

revoke execute on function public.update_order_item_status(uuid, text)
  from public, anon, authenticated;

grant execute on function public.update_order_item_status(uuid, text) to authenticated;

-- =========================================================================
-- タスク4.4: set_sold_out / resolve_call_request RPC
-- =========================================================================
-- Requirements: 2.4, 7.1, 7.3, 7.4
-- Design: design.mdの StaffOperationsGateway コンポーネント（Responsibilities &
--   Constraints「`addOrderItem` / `removeOrderItem` / `updateOrderItemStatus`
--   （レジ起点）/ `setSoldOut` / `closeSession` の実行前確認...はUI層
--   （RegisterConsole / KitchenBoard）の責務とし、本Gatewayは確認済みの操作の
--   みを受け取る」「`setSoldOut`は`order_items`が既に生成済みの注文の内容・
--   ステータスを変更しない（要件7.4）」、Service Interface: setSoldOut /
--   SetSoldOutInput / MenuItem / MenuItemError / resolveCallRequest /
--   ResolveCallRequestInput）、Requirements Traceability「7.1-7.4 |
--   売り切れ登録・解除・既存注文への非影響 | StaffOperationsGateway |
--   setSoldOut」「2.1-2.4 | 呼び出しボタン送信・重複防止・レジへの通知表示・
--   対応済み処理 | CustomerOrderingGateway, StaffOperationsGateway |
--   createCallRequest, resolveCallRequest, listRegisterFeed」、
--   Components and Interfaces「KitchenBoard (UI) | Req Coverage: 6.1-6.10,
--   7.1, 7.3-7.4」「RegisterConsole (UI) | Req Coverage: 2.4, 3.1-3.5,
--   5.1-5.7」を参照。
--
-- スコープ: set_sold_out / resolve_call_requestの2関数のみ。
--   list_kitchen_feed / list_register_feed（4.5）、StaffOperationsGatewayの
--   TypeScriptラッパー（4.6）、いかなるUIも本タスクの対象外（4.1冒頭コメントの
--   通り、それぞれ4.5/4.6で別途実装される想定）。
--
-- =========================================================================
-- 設計判断14: set_sold_out — device_role = `kitchen`限定
--   （`register`は含めない）
-- =========================================================================
-- 4.1（設計判断1）・4.2（設計判断6）・4.3（設計判断11）が確立した判断基準
-- 「StaffOperationsGateway全体を許可するという最も粗い境界を、各メソッドが
-- そのまま両方に開放してよいわけではなく、実際にどちらのロールに絞るかは
-- 各メソッドが紐づく要件の業務文脈で決まる」を、setSoldOutにも同様に適用する。
--
-- 根拠(a) 要件文書: 要件7（厨房での売り切れ登録）のAcceptance Criteria
-- 7.1「厨房スタッフが品目を売り切れとして登録する操作を行う」・7.3「厨房
-- スタッフが品目の売り切れ状態を解除する操作を行う」はいずれも主語が明確に
-- 「厨房スタッフ」であり、要件7のObjective自体も「厨房スタッフとして、
-- 食材が切れた品目をすぐに売り切れとして登録したい」である。レジスタッフの
-- 関与は要件7には一切登場しない（7.2は客側`get_ordering_context`/`submit_order`
-- の責務、7.4はDB不変条件であり、いずれも本RPCの主体を規定しない）。
--
-- 根拠(b) design.md: Components and InterfacesテーブルでKitchenBoard (UI)の
-- Req Coverageは「6.1-6.10, 7.1, 7.3-7.4」と要件7系列を明示的に含むが、
-- RegisterConsole (UI)のReq Coverageは「2.4, 3.1-3.5, 5.1-5.7」であり要件7を
-- 一切含まない。KitchenBoardのUI説明も「売り切れの登録・解除操作は実行前に
-- 確認ダイアログを表示し、確認後にのみ`setSoldOut`を呼び出す（要件7.1, 7.3）」
-- と明記する一方、RegisterConsoleのUI説明には`setSoldOut`への言及が一切ない。
--
-- 以上、要件文書のEARS主語とdesign.mdのUI別Req Coverageの両方が一致して
-- 「厨房限定」を指しており（4.1/4.2のように両者が矛盾するケースではない）、
-- `perform assert_device_role(array['kitchen']);`のみを許可する
-- （`array['kitchen','register']`は採用しない）。
--
-- =========================================================================
-- 設計判断15: resolve_call_request — device_role = `register`限定
--   （`kitchen`は含めない）
-- =========================================================================
-- 根拠(a) 要件文書: 要件2.4「レジスタッフが呼び出しに対応済みとして操作する」の
-- 主語は明確に「レジスタッフ」である。要件2の他のAC（2.1-2.3）は客側の操作
-- （呼び出しボタン表示・送信・重複防止）であり、レジスタッフの操作として
-- 明記されるのは2.4のみである。
--
-- 根拠(b) design.md: Components and InterfacesテーブルでRegisterConsole (UI)の
-- Req Coverageは「2.4, 3.1-3.5, 5.1-5.7」と2.4を明示的に含むが、KitchenBoard
-- (UI)のReq Coverageは「6.1-6.10, 7.1, 7.3-7.4」であり2.4を一切含まない。
-- Requirements Traceability表の行「2.1-2.4 | ... | CustomerOrderingGateway,
-- StaffOperationsGateway | createCallRequest, resolveCallRequest,
-- listRegisterFeed（hasOpenCallRequest）」もInterfacesにlistRegisterFeed
-- （レジ専用機能、4.5）を並置しており、この行全体がレジ側の関心事として
-- 記述されていることを裏付ける。
--
-- 以上から`perform assert_device_role(array['register']);`のみを許可する。
--
-- =========================================================================
-- 設計判断16: set_sold_outのエラーコード — ITEM_NOT_FOUNDに新規'P0405'を割り当てる
-- =========================================================================
-- 「実在しないmenuItemId」は、design.mdのMenuItemErrorが明示的に定義する
-- { code: "ITEM_NOT_FOUND" }に対応する。本プロジェクトはエンティティ種別ごとに
-- NOT_FOUND系コードを使い分ける方針を既に2回確立している
-- （TABLE_NOT_FOUND='P0404' [0003 get_ordering_context / 0004 start_session] と
-- ORDER_ITEM_NOT_FOUND='P0444' [0004 remove_order_item / update_order_item_status]
-- は、どちらも「〜が実在しない」という類似の意味でありながら対象エンティティが
-- 異なるため、意図的に異なるコードとして採番されている）。ITEM_NOT_FOUND
-- （対象: menu_items）も卓・注文明細のいずれとも異なるエンティティであるため、
-- この前例に従い既存コードを再利用せず新規に割り当てる。
--
-- 既存の採番済みコード（P0400/P0401/P0403/P0404/P0409/P0410/P0412/P0422/
-- P0423/P0429/P0444。本ファイル・0003・0006・0007の全コメントを実装直前に
-- 確認済み）のいずれとも衝突しない'P0405'を選ぶ。TABLE_NOT_FOUND（'P0404'）の
-- 次のサブコードであり、「卓」（'P0404'）に続く「品目」という、どちらも
-- get_ordering_context/submit_orderが再検証する対象エンティティのNOT_FOUND系
-- であることを想起しやすい採番とした。
--
-- 実装方式: menu_itemsにはtable_sessionsのようなstatus列がないため、
-- close_session/update_party_size（4.1）と同じ「UPDATE ... WHERE id = $1
-- RETURNING * into ...; if not found then raise exception」という単一文の
-- パターンをそのまま踏襲する。存在確認と更新を1つのUPDATE文に統合することで、
-- 事前のSELECT一致確認（start_sessionのTABLE_NOT_FOUND判定パターン）を
-- 追加で持ち込む必要がない（Simplification原則）。この単一UPDATE文は
-- menu_itemsの`sold_out`列のみを変更対象とし、order_itemsには一切触れない
-- ため、タスクの観測可能な完了条件（登録前に作成されたorder_itemsの行数・
-- statusが変化しない）はSQL文の構造自体によって自明に満たされる。
--
-- =========================================================================
-- 設計判断17（CONCERN。レビューでの確認・design.md修正を要する）:
--   resolveCallRequestのエラー型 — design.mdのCallRequestError
--   （{code:"SESSION_NOT_ACTIVE"}|{code:"CALL_ALREADY_OPEN"}）をそのまま
--   再利用せず、実際に必要な{FORBIDDEN, CALL_REQUEST_NOT_FOUND}を実装する
-- =========================================================================
-- design.mdのService Interfaceは
--   `resolveCallRequest(input: ResolveCallRequestInput):
--     Promise<Result<CallRequest, CallRequestError>>;`
-- と、3.3のcreateCallRequestが定義するCallRequestError型をそのまま再利用する
-- 型注釈になっている。しかし以下の3点から、これはdesign.md作成時の
-- コピー&ペースト起因のgapであり、resolveCallRequestという操作の実際の
-- エラー面（error surface）を意図して設計されたものではないと判断した。
--
-- (1) ResolveCallRequestInputは`{ callRequestId: string }`のみを持ち、
--     sessionIdを一切含まない。SESSION_NOT_ACTIVEは「対象セッションが
--     activeであること」を検証できて初めて意味を持つエラーだが、本関数の
--     入力にはそもそも検証対象となるsessionIdが存在しない
--     （callRequestIdからsession_idをJOINで辿ることは可能だが、design.mdの
--     PreconditionsにもService Interfaceにも、resolveCallRequestが
--     セッションのactive/closed状態を検証すべきだという記述は一切ない）。
--
-- (2) CALL_ALREADY_OPENは、design.md自身が明記する通り「呼び出し要求は
--     同一セッションに未対応（open）のものがある場合、新規作成しない
--     （要件2.3）」というcreateCallRequest（新規作成操作）専用の重複防止
--     エラーである。resolveCallRequestは既存の呼び出しを対応済みに変える
--     操作であり、「新規作成しようとしたら既に別のopenな呼び出しがあった」
--     という状況そのものが発生し得ない（本関数は新規作成を一切行わない）。
--
-- (3) design.mdの他の全StaffOperationsGatewayエラー型
--     （StartSessionError, CloseSessionError, UpdatePartySizeError,
--     AddOrderItemError, RemoveOrderItemError, UpdateOrderItemStatusError,
--     MenuItemError）は例外なく`{ code: "FORBIDDEN" }`を含む
--     （Preconditions「全メソッドは呼び出し元JWTに有効なdevice_roleクレーム
--     があることを要求する。ない場合はFORBIDDENを返す」という全メソッド
--     共通の契約と整合する）。CallRequestErrorだけがFORBIDDENを持たない
--     唯一のStaffOperationsGatewayメソッド用エラー型になってしまうのは、
--     このメソッドがcreateCallRequest（CustomerOrderingGateway、anon経路で
--     呼ばれ、device_role検証を経ない）の型をそのまま流用したことの帰結
--     であると考えるのが最も自然である。
--
-- 結論・対応: 本関数はdesign.mdの文言通りのCallRequestErrorを型として
-- 実装するのではなく、resolveCallRequestという操作が実際に必要とする
-- エラー面を実装する。すなわち:
--   - FORBIDDEN: device_roleクレームが不正/欠如（assert_device_roleが
--     送出する既存の'P0403'をそのまま利用。他の全StaffOperationsGateway
--     メソッドと同一の意味・同一のコード）
--   - CALL_REQUEST_NOT_FOUND: 指定されたcallRequestIdが実在しない場合、
--     および実在するが既に'resolved'の場合の両方（設計判断18で詳述）。
--     新規に'P0445'を割り当てる。
-- 本タスクの実装者はレビュアーではないため、design.md自体の修正は行わず、
-- 実装（本コメント）でこの判断根拠を明示するに留める。design.mdの
-- resolveCallRequestのエラー型注釈（CallRequestErrorの再利用）は、レビューで
-- 確認の上、design.mdを`{ code: "FORBIDDEN" } | { code:
-- "CALL_REQUEST_NOT_FOUND" }`という専用の`ResolveCallRequestError`型へ
-- 修正することを推奨する（タスク完了報告のCONCERNSに記載）。
--
-- =========================================================================
-- 設計判断18: CALL_REQUEST_NOT_FOUND — 「実在しない」と「既にresolved」を
--   同一コードへ収束させ、新規に'P0445'を割り当てる
-- =========================================================================
-- close_session（4.1）のSESSION_NOT_ACTIVE（存在しない場合も既にclosedの
-- 場合も区別しない）、remove_order_item/update_order_item_status（4.2/4.3）の
-- ORDER_ITEM_NOT_FOUND（存在しない場合も所属セッションがclosedの場合も
-- 区別しない）と同じ前例に従い、resolve_call_requestも「対象IDが実在せず
-- 操作できない」と「対象IDは実在するが現在の状態では操作できない
-- （既にresolved）」を区別せず単一のエラーコードへ収束させる。この操作は
-- 「未対応(open)の呼び出しを対応済みにする」という一方向の状態遷移のみを
-- 意図しており、design.mdのCallRequest型・呼び出しライフサイクル
-- （open -> resolved、逆方向の遷移は存在しない）を踏まえれば、「resolved
-- からopenへの巻き戻し」も「resolved呼び出しへの再度のresolve」もどちらも
-- 許可されるべき操作ではなく、呼び出し元には「もう対応不要」という単一の
-- 意味を返せば十分である。
--
-- 実装方式: set_sold_out（設計判断16）と同じ「UPDATE ... WHERE id = $1 AND
-- status = 'open' RETURNING * into ...; if not found then raise exception」
-- という単一文パターンを踏襲する。存在しないcall_request_id・既にresolvedな
-- call_request_idのいずれも、このWHERE句の条件を満たす行が0件になることへ
-- 自然に収束するため、追加の分岐は不要である。
--
-- 新規コード'P0445': 既存の採番済みコード（P0400/P0401/P0403/P0404/P0405
-- [本ファイル、設計判断16]/P0409/P0410/P0412/P0422/P0423/P0429/P0444）の
-- いずれとも衝突しない。ORDER_ITEM_NOT_FOUND（'P0444'）の次のサブコードで
-- あり、どちらも「対象IDは実在するが、所属する親エンティティ・自身の状態が
-- 既に確定済みであるため操作を受け付けない」という同型の意味論
-- （order_items: 所属セッションがclosed / call_requests: 自身が既にresolved）
-- を持つNOT_FOUND系コード同士であることを想起しやすい採番とした。
--
-- =========================================================================
-- 設計判断19: resolve_call_requestの戻り値 — design.mdのCallRequest型
--   （resolvedAtを持たない）に忠実に、resolved_atをレスポンスに含めない
-- =========================================================================
-- design.mdのCallRequest型は`{ id: string; sessionId: string; status: "open"
-- | "resolved"; createdAt: string }`のみを定義し、`resolvedAt`フィールドを
-- 持たない（create_call_request, 0003が返すjsonbのキー構成と完全に同一の
-- 4キーのみ）。0001_schema.sqlのcall_requests.resolved_at列自体は当然DBに
-- 保持する（設計判断18のWHERE句・観測可能な完了条件の検証対象として必須）が、
-- 本関数のjsonbレスポンスにはresolvedAtキーを含めない。design.mdの型定義に
-- 明示的に無いフィールドを独自にレスポンスへ追加するのは、将来の
-- TypeScriptラッパー（4.6）が実装するCallRequest型と実際のRPCレスポンス
-- 形状との間に、design.mdだけからは読み取れない暗黙の追加フィールドを生む
-- ため、型定義に忠実に留める。
--
-- =========================================================================
-- 設計判断20: SECURITY DEFINER + search_path=''、EXECUTE権限
-- =========================================================================
-- 両関数とも、authenticatedロールが直接の書き込み権限を持たないmenu_items・
-- call_requests（いずれも0002でRLS有効化・権限剥奪済み）へ書き込む必要が
-- あるため、start_session等（4.1-4.3）と同じSECURITY DEFINERが必須となる。
-- search_pathなりすまし対策として`set search_path = ''`を設定し、本文内の
-- 全参照（public.menu_items, public.call_requests, public.assert_device_role）
-- をスキーマ修飾する。EXECUTE権限はauthenticatedにのみ付与し、anonには
-- 一切付与しない（客側の匿名anon経路専用のCustomerOrderingGatewayとは
-- 独立した、スタッフデバイス専用の書き込み経路であるため。0004の他の
-- 全StaffOperationsGateway RPCと同一のGRANT/REVOKEパターン）。

-- =========================================================================
-- set_sold_out RPC
-- =========================================================================
create or replace function public.set_sold_out(
  p_menu_item_id uuid,
  p_sold_out boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_menu_item public.menu_items;
begin
  -- 1. device_role検証（設計判断14: kitchenロール限定）を必ず先頭で行う。
  perform public.assert_device_role(array['kitchen']);

  -- 2. 存在確認と更新を単一のUPDATE文で行う（設計判断16）。menu_itemsの
  --    sold_out列のみを変更対象とし、order_itemsには一切触れない
  --    （要件7.4、タスクの観測可能な完了条件）。
  update public.menu_items
  set sold_out = p_sold_out
  where id = p_menu_item_id
  returning * into v_menu_item;

  if not found then
    raise exception 'menu item % not found', p_menu_item_id
      using errcode = 'P0405';
  end if;

  return jsonb_build_object(
    'id', v_menu_item.id,
    'storeId', v_menu_item.store_id,
    'name', v_menu_item.name,
    'price', v_menu_item.price,
    'soldOut', v_menu_item.sold_out
  );
end;
$$;

comment on function public.set_sold_out(uuid, boolean) is
  '厨房（authenticated, device_role=''kitchen''。設計判断14参照）が品目の
   売り切れ状態を切り替える際に呼び出すStaffOperationsGatewayの書き込み系RPC
   （要件7.1, 7.3。実行前確認自体はUI層KitchenBoardの責務であり、本関数は
   確認済みの呼び出しのみを受け取る）。冒頭でassert_device_role(array[''kitchen''])
   を検証する（それ以外のdevice_role・claim欠如はカスタムSQLSTATE ''P0403''、
   assert_device_role自身が送出）。対象のmenu_item_idが実在しない場合は
   カスタムSQLSTATE ''P0405''（ITEM_NOT_FOUND、本タスクで新規割当。設計判断16
   参照）を送出し、何も更新しない。成功時はmenu_items.sold_outのみを更新した
   MenuItem（id/storeId/name/price/soldOut）を返し、order_itemsには一切
   触れない（要件7.4。この非影響はSQL文の構造自体（menu_itemsのみを対象と
   する単一UPDATE文）により保証される）。SECURITY DEFINER + search_path=''''は
   他のStaffOperationsGateway RPCと同じsearch_pathなりすまし対策を踏襲する
   （設計判断20）。';

revoke execute on function public.set_sold_out(uuid, boolean)
  from public, anon, authenticated;

grant execute on function public.set_sold_out(uuid, boolean) to authenticated;

-- =========================================================================
-- resolve_call_request RPC
-- =========================================================================
create or replace function public.resolve_call_request(
  p_call_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_call_request public.call_requests;
begin
  -- 1. device_role検証（設計判断15: registerロール限定）を必ず先頭で行う。
  perform public.assert_device_role(array['register']);

  -- 2. openな呼び出しのみを対象に更新する（設計判断18）。実在しない場合も
  --    既に'resolved'の場合も区別せず単一のエラーコードへ収束させる。
  update public.call_requests
  set status = 'resolved',
      resolved_at = now()
  where id = p_call_request_id
    and status = 'open'
  returning * into v_call_request;

  if not found then
    raise exception 'call request % not found or already resolved', p_call_request_id
      using errcode = 'P0445';
  end if;

  -- design.mdのCallRequest型はresolvedAtを持たないため、レスポンスにも
  -- 含めない（設計判断19）。
  return jsonb_build_object(
    'id', v_call_request.id,
    'sessionId', v_call_request.session_id,
    'status', v_call_request.status,
    'createdAt', v_call_request.created_at
  );
end;
$$;

comment on function public.resolve_call_request(uuid) is
  'レジ（authenticated, device_role=''register''。設計判断15参照）が呼び出しを
   対応済みにする際に呼び出すStaffOperationsGatewayの書き込み系RPC（要件2.4）。
   冒頭でassert_device_role(array[''register''])を検証する（それ以外の
   device_role・claim欠如はカスタムSQLSTATE ''P0403''、assert_device_role自身が
   送出）。対象のcall_request_idが実在しない場合、および実在するが既に
   ''resolved''の場合の両方について、カスタムSQLSTATE ''P0445''
   （CALL_REQUEST_NOT_FOUND、本タスクで新規割当。設計判断18参照）を同一の
   エラーコードとして送出し、何も更新しない。成功時はstatus=''resolved''・
   resolved_at=now()に更新した後のCallRequest（id/sessionId/status/createdAt。
   design.mdのCallRequest型にresolvedAtが無いためレスポンスにも含めない、
   設計判断19）を返す。
   CONCERN（設計判断17参照）: design.mdのService Interfaceは本メソッドの
   エラー型として3.3のCallRequestError（{SESSION_NOT_ACTIVE}|
   {CALL_ALREADY_OPEN}）を再利用するよう注釈しているが、本関数の入力
   （callRequestIdのみ、sessionIdを含まない）・操作の意味（既存のopenな
   呼び出しをresolvedにする。新規作成の重複防止とは無関係）のいずれとも
   一致せず、他の全StaffOperationsGatewayエラー型が持つFORBIDDENも欠けて
   いるため、design.md作成時のコピー&ペースト起因のgapと判断した。本関数は
   その型注釈をそのまま実装せず、実際に必要な{FORBIDDEN,
   CALL_REQUEST_NOT_FOUND}を実装する。レビューでの確認の上、design.mdを
   専用の`ResolveCallRequestError`型へ修正することを推奨する。
   成功後、当該呼び出しが属していたセッションへの新規create_call_request
   （0003）は、call_requests_open_session_id_key（セッションあたり未対応の
   呼び出しは高々1件という部分ユニークインデックス、0003設計判断7）の対象から
   外れる（本行のstatusが''open''でなくなるため）ため、通常どおり成功する
   ようになる。SECURITY DEFINER + search_path=''''は他のStaffOperationsGateway
   RPCと同じsearch_pathなりすまし対策を踏襲する（設計判断20）。';

revoke execute on function public.resolve_call_request(uuid)
  from public, anon, authenticated;

grant execute on function public.resolve_call_request(uuid) to authenticated;

-- =========================================================================
-- タスク4.5: list_kitchen_feed / list_register_feed RPC
-- =========================================================================
-- Requirements: 2.2, 5.1, 5.2, 5.3, 5.4, 6.1, 6.7, 6.8, 6.9, 6.10
-- Design: design.mdの StaffOperationsGateway コンポーネント（Responsibilities &
--   Constraints「listKitchenFeedが返す未対応（received）の品目一覧は、一品
--   ジャンルを受注時刻に関わらず先頭に、それ以外は受注時刻の昇順で並べる
--   （要件6.7）」「listKitchenFeedが返す調理完了（done）の品目一覧は、
--   status_updated_atの降順（直近に完了したものが先頭）で並べる（要件6.10）」
--   「listRegisterFeedは各卓の現在アクティブなセッションの人数・注文明細・
--   合計金額を返す（要件5.1, 5.4）。アクティブセッションがない卓は
--   activeSession: nullとして返す（要件5.2）。この合計計算はCustomerOrdering
--   Gateway.getOrderingContextが返すconfirmedTotalと同一のロジックを共有する」
--   「listRegisterFeedは...未対応(open)の呼び出しが存在するかをhasOpenCall
--   Requestとして返す（要件2.2）」、Service Interface: listKitchenFeed /
--   listRegisterFeed / ListFeedInput / TableBillingSummary、Requirements
--   Traceability「5.1-5.4 | ... | listRegisterFeed」「6.1, 6.2, 6.5, 6.8, 6.9 |
--   ... | listKitchenFeed, updateOrderItemStatus」「2.1-2.4 | ... |
--   listRegisterFeed（hasOpenCallRequest）」を参照。
--
-- スコープ: list_kitchen_feed / list_register_feedの2関数のみ。
--   StaffOperationsGatewayのTypeScriptラッパー（4.6）、いかなるUI
--   （KitchenBoard/RegisterConsole、7.x/8.x）も本タスクの対象外。
--
-- 本タスクの完了により、design.mdのFile Structure Planが想定する
-- 0004_rpc_staff_gateway.sqlの全10関数（start_session, close_session,
-- update_party_size, add_order_item, remove_order_item,
-- update_order_item_status, set_sold_out, resolve_call_request,
-- list_kitchen_feed, list_register_feed）がすべて本ファイルに揃う。
--
-- =========================================================================
-- 設計判断21: device_role — list_kitchen_feedはkitchen限定、
--   list_register_feedはregister限定（両者は相互排他的な読者を持つ）
-- =========================================================================
-- 4.1（設計判断1）・4.2（設計判断6）・4.4（設計判断14・15）が確立した判断基準
-- 「StaffOperationsGateway全体を許可するという最も粗い境界を、各メソッドが
-- そのまま両方に開放してよいわけではなく、実際にどちらのロールに絞るかは
-- 各メソッドが紐づく要件の業務文脈で決まる」を、本タスクの2関数にも適用する。
-- 4.3（updateOrderItemStatus、要件文書・design.mdの双方が両ロールでの利用を
-- 明記していたため両ロール許可とした）とは対照的に、本タスクの2関数は
-- 「厨房向け一覧」「レジ向け一覧」という完全に分離した対象読者を持つ
-- （タスク文書自体が「KitchenBoardはlistKitchenFeedに依存し、RegisterConsoleは
-- listRegisterFeedに依存する。これらは対象読者ごとに分かれる、両ロールから
-- 呼ばれるべきものではない」と明記する）。
--
-- 根拠(a) 要件文書: list_kitchen_feedが対応する要件6系列は主語が一貫して
-- 「厨房KDSサービス」「厨房スタッフ」である（6.1「厨房画面へ表示する」、
-- 6.7「未対応の一覧の上部に表示する」、6.8「卓の識別情報と受注時刻が判別
-- できる形で一覧表示する」、6.10「直近に調理完了となった品目ほど一覧の上部に
-- 表示する」）。レジスタッフの関与は要件6には一切登場しない。一方
-- list_register_feedが対応する要件5系列は主語が一貫して「レジスタッフ」
-- 「レジサービス」である（5.1「レジスタッフが卓を選択する」、5.4「レジ
-- サービスは全卓について...一覧表示する」）。要件2.2（呼び出し通知を
-- レジ側の画面に表示する）も主語が明確にレジ側の画面であり、
-- hasOpenCallRequestをlistRegisterFeedのみが持つ（listKitchenFeedの戻り値
-- 型には呼び出し関連フィールドが一切ない）design.mdのService Interfaceと
-- 整合する。
--
-- 根拠(b) design.md: Requirements Traceability表の行「6.1, 6.2, 6.5, 6.8,
-- 6.9 | ... | StaffOperationsGateway, RealtimeFeed | listKitchenFeed,
-- updateOrderItemStatus」にlistRegisterFeedは一切登場せず、「5.1-5.4 |
-- レジでの卓別会計確認表示・全卓の状況一覧 | StaffOperationsGateway |
-- listRegisterFeed」にlistKitchenFeedは一切登場しない。「2.1-2.4 | ... |
-- createCallRequest, resolveCallRequest, listRegisterFeed
-- （hasOpenCallRequest）」の行にもlistKitchenFeedは登場しない。KitchenBoard
-- のUI説明文は「フードボードの未対応列は一品ジャンルを優先表示し...調理完了
-- 列は直近に完了したものを上部に表示する」とlistKitchenFeedの挙動のみに
-- 言及し、RegisterConsoleのUI説明文は「各卓のタイルに人数・経過時間・合計
-- 金額・呼び出し中バッジを表示する」とlistRegisterFeedの挙動のみに言及する。
-- どちらのUI説明文にも相手側のRPCへの言及は一切ない。
--
-- 以上、要件文書・design.mdの両方が「厨房向け一覧」「レジ向け一覧」という
-- 対象読者ごとの完全な分離を一貫して示しており（4.3のように両者の一次資料が
-- 交差するケースではない）、`list_kitchen_feed`は
-- `assert_device_role(array['kitchen'])`、`list_register_feed`は
-- `assert_device_role(array['register'])`のみを許可する
-- （いずれも`array['kitchen','register']`は採用しない）。
--
-- =========================================================================
-- 設計判断22: list_kitchen_feedの並び順
--   — 単一のCTE + 3つのランク列で、ステータスごとに異なるタイブレーク
--     ロジックを1本のORDER BYに合成する
-- =========================================================================
-- design.mdのlistKitchenFeedの戻り値型はReadonlyArray<OrderItemSummary &
-- {tableId, tableLabel, genre}>というフラットな配列であり
-- （ステータス別に事前グルーピングされたオブジェクトではない）、statusは
-- 各要素のフィールドとして含まれる。よって「未対応/調理中/調理完了の3分割
-- カンバン」への分割は将来のKitchenBoard UI（7.2、本タスクの対象外）が
-- クライアント側でstatusによってフィルタする責務であり、本RPCの責務は
-- 「クライアントがstatusでグルーピングした際、各グループ内の相対順序が
-- 正しくなるような1本のフラット配列を返す」ことに限られる。配列を
-- statusでグルーピングしても同一status同士の相対順序（＝配列内での出現順）は
-- 保たれるため、複数のstatusにまたがるグローバルなソートキーであっても、
-- 各status内の相対順序さえ正しければ要件を満たす。
--
-- 各ステータス内で必要なタイブレークが異なる:
--   - received（未対応、要件6.7）: 一品ジャンルを受注時刻に関わらず先頭、
--     それ以外は受注時刻の昇順（design.md「一品ジャンルを受注時刻に関わらず
--     先頭に、それ以外は受注時刻の昇順で並べる」）
--   - done（調理完了、要件6.10）: status_updated_atの降順（直近完了が先頭）
--   - in_progress（調理中）: design.md・要件文書のいずれも並び順を規定しない。
--     本実装は「受注時刻の昇順」を既定値として採用する（received群の
--     タイブレークと同じ基準を流用し、調理中に移った後も「先に受け付けた
--     順」という直感的な並びを保てるため。他に規定がないための実装者裁量の
--     選択であり、将来要件が明示されれば見直す）。
--
-- 「受注時刻」の実体: order_items自体は受注時刻に相当する独立の列を
-- 持たない（0001_schema.sqlのorder_itemsにはcreated_at相当の列がない）。
-- 受注時刻の一次資料はordersテーブルのcreated_at（客のsubmit_order、または
-- レジのadd_order_itemが新規ordersコンテナ行を発行した瞬間。要件6.8の
-- 「受注時刻」に対応する）である。status_updated_atは初回挿入時にdefault
-- now()でordersのcreated_atとほぼ同時刻の値を持つため、received状態の
-- 品目に限っては代用できなくもないが、意味的にはstatus_updated_atは
-- 「直近のステータス変更時刻」であり「受注時刻」そのものではない
-- （0001_schema.sqlの列コメント参照）。したがって受注時刻のタイブレークには
-- o.created_at（orders.created_at）を用い、status_updated_atはdone群専用の
-- ソートキーとしてのみ用いる、という役割分担を明確に保つ。
--
-- 実装: CTE（kitchen_feed_rows）で対象行を1回だけ抽出し、3つのランク列を
--   計算する:
--     status_rank    : received=0 / in_progress=1 / done=2（必須要件では
--                       ないが、グルーピング前の生JSONでもステータスごとに
--                       まとまった見た目になり、デバッグ・テストでの目視
--                       確認が容易になるため付与する。クライアント側の
--                       グルーピング結果には一切影響しない）
--     tier_rank      : status='received' かつ genre='ippin' の場合のみ0、
--                       それ以外は1（received群限定のippin優先。他の
--                       statusでは常に1になり無効化される＝done/
--                       in_progressの並びに一切影響しない）
--     sort_key (double precision): status='done'の場合は
--                       -extract(epoch from status_updated_at)（降順を
--                       昇順ORDER BYの中で表現するための符号反転。値が
--                       大きい＝より最近完了＝符号反転後はより小さい値に
--                       なり、ASCソートで先頭に来る）、それ以外は
--                       extract(epoch from o.created_at)（受注時刻の昇順、
--                       符号反転なし）
--   最終的に`order by status_rank, tier_rank, sort_key, id`（idは同一
--   マイクロ秒内の完全な同時刻等、理論上の同値ケースに対する決定的な最終
--   タイブレーク）で1本のORDER BYに統合する。status_rank/tier_rank/
--   sort_keyのいずれも他のステータス群の並びに影響を与えないよう定数化・
--   無効化されているため、「1つのORDER BY式で複数の異なるタイブレーク
--   ロジックを共存させる」ことがcorrectに実現される（3つの独立したソート
--   要求を、各行が属するstatusに応じて一部の列を定数化することで安全に
--   合成する、というのが本設計の要）。テストデータは意図的に「自然な挿入
--   順・id生成順とは逆」になるよう構成し（listKitchenFeed.integration.
--   test.ts参照）、挿入順やid順に依存した実装では失敗するようにしてある。
--
-- =========================================================================
-- 設計判断23: list_register_feedのtotal計算
--   — get_ordering_context（0003）のconfirmedTotalと文字通り同一の式にする
-- =========================================================================
-- design.mdは「この合計計算はCustomerOrderingGateway.getOrderingContextが
-- 返すconfirmedTotalと同一のロジックを共有する」と明示的に要求する
-- （0003_rpc_customer_gateway.sqlのget_ordering_context冒頭コメントにも
-- 「将来実装されるStaffOperationsGateway.listRegisterFeedのtotal計算と
-- 完全に一致させなければならない」と対になる注記がある）。
--
-- get_ordering_contextの実際の式（0003より）:
--   select coalesce(sum(oi.unit_price_snapshot * oi.quantity), 0)
--   from public.order_items oi
--   join public.orders o on o.id = oi.order_id
--   where o.session_id = v_active_session_id;
-- （statusによる絞り込みは行わない。received/in_progress/doneいずれの
-- 状態の品目も等しく合計に含める）。
--
-- 本関数はこれと文字通り同一の集計式（`sum(oi.unit_price_snapshot *
-- oi.quantity)`、statusによる絞り込みなし、対象はアクティブセッションの
-- order_items全件）をLATERAL副問い合わせ内に実装する。将来この2箇所の
-- いずれかを変更する場合は、他方も同時に見直すこと（design.mdの
-- Revalidation Triggers相当の注意点）。この一致は
-- listRegisterFeed.integration.test.tsが、同一セッションに対して
-- list_register_feedのtotalとget_ordering_contextのconfirmedTotalを
-- 実際に両方呼び出し、直接比較することで保証する（design.mdが明示的に
-- 要求する、本specで最も重要なクロスタスク整合性検証）。
--
-- =========================================================================
-- 設計判断24: list_register_feedの構造
--   — 全卓をLEFT JOINの起点にし、アクティブセッションの明細集計は
--     LEFT JOIN LATERALで1回の問い合わせに統合する
-- =========================================================================
-- 要件5.4「全卓について、空席/来店中の状態...を一覧表示する」に対応するため、
-- クエリの起点はtable_sessionsではなくtables（store_id = p_store_idで
-- スコープ）とし、`left join table_sessions ts on ts.table_id = t.id and
-- ts.status = 'active'`でアクティブセッションの有無を左外部結合する。
-- アクティブセッションがない卓はts.*が全列NULLになるため、
-- `case when ts.id is null then null else jsonb_build_object(...) end`で
-- design.mdの`activeSession: null`をそのまま表現できる（要件5.2）。
--
-- 明細集計（items配列とtotal）は`left join lateral (...) on true`で
-- 1回だけ計算する。集計関数（jsonb_agg/sum）はGROUP BYなしでも常に
-- ちょうど1行を返す（対象行が0件でも列値がNULLの1行を返す）ため、
-- `on true`のLATERAL結合で「アクティブセッションが存在すれば実際の
-- 明細/合計、存在しなければ（ts.idがNULLのためLATERAL内のwhere句
-- `o.session_id = ts.id`が恒偽になり）NULL」という分岐が自然に成立する。
-- 外側で`coalesce(billing.items, '[]'::jsonb)`・
-- `coalesce(billing.total, 0)`によりNULLを設計文書どおりの`[]`/`0`へ
-- 変換する。この構造により、「アクティブセッションはあるがまだ注文が
-- 0件」の卓（入店直後）も、items: []・total: 0を自然に返す
-- （設計判断23のconfirmedTotal側と同じ「セッションはあるが注文明細が
-- まだない場合は0」という挙動と一致する）。
--
-- hasOpenCallRequestはLATERALを使わず、jsonb_build_object内の相関
-- サブクエリ`exists(select 1 from call_requests where session_id = ts.id
-- and status = 'open')`として直接評価する。ts.idがNULLの場合、この
-- 相関条件は恒偽となり自然にfalseへ収束するため、活性セッションの
-- 有無による分岐を追加で書く必要がない（要件2.2・design.mdの
-- hasOpenCallRequest定義）。
--
-- items配列の各要素（menuItemId/name/quantity/unitPrice）は
-- design.mdのTableBillingSummary.items型に忠実に、order_items 1行を
-- そのまま1要素として列挙する（OrderItemSummaryのようなid/status等の
-- 追加フィールドは持たない、単純な会計明細行）。集計や重複排除は
-- 行わない（design.mdの型定義・Responsibilities & Constraintsのいずれも
-- 「同一menuItemIdの明細をまとめる」ことを要求していないため。
-- Simplification原則にも従い、order_items単位でそのまま列挙する）。
--
-- 卓の一覧順序はdesign.mdが規定しないため、get_ordering_contextの
-- メニュー一覧が採用する`order by 名前, id`という並び（0003参照）と
-- 同じ考え方で`order by t.label, t.id`とする。
--
-- =========================================================================
-- 設計判断25: エラー面 — assert_device_roleのFORBIDDEN以外は一切送出しない
--   （design.mdの`never`エラー型に対応）
-- =========================================================================
-- design.mdのService Interfaceは両関数とも
--   `Promise<Result<..., never>>`
-- と、エラー型を`never`と宣言する。TypeScriptの`never`は「値を持たない型」
-- であり、構造的に`{ code: "FORBIDDEN" }`を含む余地がない。しかし
-- design.mdのPreconditions「全メソッドは呼び出し元JWTに有効なdevice_role
-- クレームがあることを要求する。ない場合はFORBIDDENを返す」は「全
-- メソッド」に例外を設けておらず、本タスクのプランニング段階で
-- 検討した通り、assert_device_role自体がRAISE EXCEPTIONで例外を送出する
-- 経路は、本関数の`returns jsonb`という宣言や将来のTypeScriptラッパー
-- （4.6、本タスクの対象外）が採用するであろう`never`という型注釈とは
-- 独立して常に発生し得る（PL/pgSQLのRAISE EXCEPTIONは呼び出し元へ
-- 制御を戻さずトランザクション例外として即座に伝播するため、関数の
-- 宣言上の戻り値型にRETURNが到達するかどうかとは無関係。0006の
-- assert_device_role自体もvoidを返す関数として定義され、呼び出し元の
-- 戻り値型と無関係に例外を送出する）。
--
-- したがって`never`は「assert_device_roleが送出するFORBIDDEN（PostgRESTの
-- error.code経由でSupabase-jsが例外的に投げる、Resultのエラーメンバー
-- としてはモデル化されない）を除けば、本関数はいかなる業務エラーも
-- 返さない（返せない）」という意味であると解釈する。この解釈は、
-- 4.1のImplementation Notes「予期しないエラーはResultに含めず例外として
-- throwする」という既存の規約（customerOrderingGateway.ts, 3.4）とも
-- 整合する。将来のTypeScriptラッパー（4.6）は、これら2関数の呼び出しで
-- 発生したエラー（P0403を含むあらゆるerror）を、Result<T, never>という
-- 型注釈のとおりResultのエラーメンバーとしてではなく、常に例外として
-- そのままthrowする実装になる見込みである。
--
-- 本関数自体は上記の解釈に基づき、assert_device_roleの呼び出し以外に
-- 一切のRAISE EXCEPTIONを追加しない（対象店舗が存在しない場合や、
-- 該当する卓が0件の場合であっても、design.mdの型定義に対応する専用の
-- エラーコードが存在しないため、単に空配列jsonbを返す。0003の
-- get_ordering_contextのように「卓が存在しない」を専用のTABLE_NOT_FOUND
-- として扱うRPCとは異なり、本タスクの2関数の入力はp_store_id
-- （店舗全体のスコープ）であり、「その店舗に卓が1つもない」という状態は
-- 業務上の異常系ではなく単に空の一覧として自然に表現できるため、
-- 専用のガードを追加しない。Simplification原則にも従う）。
--
-- =========================================================================
-- 設計判断26: SECURITY DEFINER + stable + search_path=''、EXECUTE権限
-- =========================================================================
-- 両関数とも、authenticatedロールが直接の閲覧権限を持たないtable_sessions/
-- orders/order_items/call_requests（いずれも0002でRLS有効化・権限剥奪
-- 済み）を読み取る必要があるため、他のStaffOperationsGateway RPCと同じ
-- SECURITY DEFINERが必須となる。search_pathなりすまし対策として
-- `set search_path = ''`を設定し、本文内の全参照（public.tables,
-- public.table_sessions, public.orders, public.order_items,
-- public.menu_items, public.call_requests, public.assert_device_role）を
-- スキーマ修飾する。両関数とも書き込みを一切行わない閲覧専用RPCのため、
-- get_ordering_context（0003）と同様に`stable`を付与する。EXECUTE権限は
-- authenticatedにのみ付与し、anonには一切付与しない（0004の他の全
-- StaffOperationsGateway RPCと同一のGRANT/REVOKEパターン）。

-- =========================================================================
-- list_kitchen_feed RPC
-- =========================================================================
create or replace function public.list_kitchen_feed(
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
  -- 1. device_role検証（設計判断21: kitchenロール限定）を必ず先頭で行う。
  perform public.assert_device_role(array['kitchen']);

  -- 2. 対象店舗の全order_itemsを、卓・メニュー情報付きで1回抽出し、
  --    3つの並び替え用ランク列を計算する（設計判断22）。
  with kitchen_feed_rows as (
    select
      oi.id,
      oi.menu_item_id,
      oi.name_snapshot,
      oi.unit_price_snapshot,
      oi.quantity,
      oi.options_summary,
      oi.status,
      oi.status_updated_at,
      t.id as table_id,
      t.label as table_label,
      mi.genre,
      case oi.status
        when 'received' then 0
        when 'in_progress' then 1
        when 'done' then 2
        else 3
      end as status_rank,
      case
        when oi.status = 'received' and mi.genre = 'ippin' then 0
        else 1
      end as tier_rank,
      case
        when oi.status = 'done' then -extract(epoch from oi.status_updated_at)
        else extract(epoch from o.created_at)
      end as sort_key
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join public.table_sessions ts on ts.id = o.session_id
    join public.tables t on t.id = ts.table_id
    join public.menu_items mi on mi.id = oi.menu_item_id
    where t.store_id = p_store_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'menuItemId', menu_item_id,
        'name', name_snapshot,
        'unitPrice', unit_price_snapshot,
        'quantity', quantity,
        'optionsSummary', options_summary,
        'status', status,
        'statusUpdatedAt', status_updated_at,
        'tableId', table_id,
        'tableLabel', table_label,
        'genre', genre
      )
      order by status_rank, tier_rank, sort_key, id
    ),
    '[]'::jsonb
  )
  into v_result
  from kitchen_feed_rows;

  return v_result;
end;
$$;

comment on function public.list_kitchen_feed(uuid) is
  '厨房（authenticated, device_role=''kitchen''。設計判断21参照）が受注一覧を
   取得する際に呼び出すStaffOperationsGatewayの閲覧系RPC（要件2.2, 5.1-5.4,
   6.1, 6.7-6.10のうち厨房向けの並び替え・表示に関する部分）。冒頭で
   assert_device_role(array[''kitchen''])を検証する（それ以外のdevice_role・
   claim欠如はカスタムSQLSTATE ''P0403''、assert_device_role自身が送出。
   design.mdの`never`エラー型に対応する解釈は設計判断25参照）。対象店舗の
   全order_items（tables経由でstore_idスコープ）を、design.mdの
   OrderItemSummary型にtableId/tableLabel/genreを加えたキー構成のjsonb配列
   として返すフラットな配列であり、statusによる3分割（未対応/調理中/調理
   完了）はクライアント側の責務とする。並び順は設計判断22の3ランク列
   （status_rank, tier_rank, sort_key）による単一のORDER BYで、
   受信side（received）は一品ジャンルを受注時刻に関わらず先頭・それ以外は
   受注時刻（orders.created_at）の昇順（要件6.7）、調理完了（done）は
   status_updated_atの降順（要件6.10、直近完了が先頭）、調理中
   （in_progress）は既定値として受注時刻の昇順（要件文書に規定がないため
   実装者裁量）を、クライアントがstatusでグルーピングした後も正しい
   相対順序になるよう合成する。SECURITY DEFINER + search_path='''' +
   stableは他の閲覧系RPC（get_ordering_context, 0003）と同じ構成。';

revoke execute on function public.list_kitchen_feed(uuid)
  from public, anon, authenticated;

grant execute on function public.list_kitchen_feed(uuid) to authenticated;

-- =========================================================================
-- list_register_feed RPC
-- =========================================================================
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
  -- 1. device_role検証（設計判断21: registerロール限定）を必ず先頭で行う。
  perform public.assert_device_role(array['register']);

  -- 2. 対象店舗の全卓を起点に、アクティブセッションをLEFT JOINし、
  --    明細集計をLEFT JOIN LATERALで1回だけ計算する（設計判断24）。
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
          'menuItemId', oi.menu_item_id,
          'name', oi.name_snapshot,
          'quantity', oi.quantity,
          'unitPrice', oi.unit_price_snapshot
        )
        order by oi.id
      ) as items,
      -- 設計判断23: get_ordering_context（0003）のconfirmedTotalと
      -- 文字通り同一の集計式（statusによる絞り込みなし）。
      sum(oi.unit_price_snapshot * oi.quantity) as total
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.session_id = ts.id
  ) billing on true
  where t.store_id = p_store_id;

  return v_result;
end;
$$;

comment on function public.list_register_feed(uuid) is
  'レジ（authenticated, device_role=''register''。設計判断21参照）が卓
   マップ・卓別会計確認一覧を取得する際に呼び出すStaffOperationsGatewayの
   閲覧系RPC（要件2.2, 5.1-5.4）。冒頭でassert_device_role(array
   [''register''])を検証する（それ以外のdevice_role・claim欠如はカスタム
   SQLSTATE ''P0403''、assert_device_role自身が送出。design.mdの`never`
   エラー型に対応する解釈は設計判断25参照）。対象店舗の全卓
   （store_idスコープ、アクティブセッションの有無を問わず空席卓も含む、
   要件5.4）を、design.mdのTableBillingSummary型と同じキー構成
   （tableId/tableLabel/activeSession/items/total/hasOpenCallRequest）の
   jsonb配列として返す。アクティブセッションがない卓はactiveSession: null・
   items: []・total: 0・hasOpenCallRequest: falseとなる（要件5.2、設計判断
   24）。activeSessionがある卓のtotalはget_ordering_context（0003）の
   confirmedTotalと文字通り同一の集計式（unit_price_snapshot*quantityの
   合計、statusによる絞り込みなし）で計算し、両者が常に一致することを
   listRegisterFeed.integration.test.tsのクロスRPC検証で担保する（設計判断
   23、design.mdが明示的に要求する整合性）。hasOpenCallRequestは対象
   セッションに''open''のcall_requestsが存在するかを表し、
   create_call_request（0003）/resolve_call_request（本ファイル）の
   ライフサイクルに追随する（要件2.2）。SECURITY DEFINER +
   search_path='''' + stableは他の閲覧系RPC（get_ordering_context, 0003;
   list_kitchen_feed, 本ファイル）と同じ構成。';

revoke execute on function public.list_register_feed(uuid)
  from public, anon, authenticated;

grant execute on function public.list_register_feed(uuid) to authenticated;
