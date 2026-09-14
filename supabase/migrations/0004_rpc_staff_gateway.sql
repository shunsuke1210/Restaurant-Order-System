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
