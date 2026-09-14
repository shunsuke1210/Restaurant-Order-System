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
