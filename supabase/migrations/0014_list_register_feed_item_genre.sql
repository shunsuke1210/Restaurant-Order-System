-- 0014_list_register_feed_item_genre.sql
-- table-order-kitchen: list_register_feedの各明細にgenreを追加する
--
-- Requirements: 5.7
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "StaffOperationsGateway" コンポーネント（Service Interface:
--   TableBillingSummary）を参照。本タスク（8.4）で改訂した型定義に
--   合わせて本マイグレーションを適用する。
--
-- =========================================================================
-- 背景（0012_list_register_feed_item_id.sql冒頭コメントが本タスクへ
--   明示的に委ねていた判断——「マンダトリーな前提」）
-- =========================================================================
-- 0012（タスク8.3）はlist_register_feedの各明細にid/optionsSummary/statusを
-- 追加したが、genreは意図的に含めなかった。0012冒頭コメントはその理由を
-- 「statusは8.4向けの値の先取りであり、本タスク（8.3）のUI自体はジャンル
-- 情報を持たないため、mock-preview.htmlのstatusLabel(genre, status)のような
-- ジャンルに応じた正確な日本語ラベル変換はできない...よってstatusは値を
-- 取得はするが画面には表示しない、という意図的な部分対応にとどめる。
-- 8.4がジャンルも必要とする形で改めてこのRPCを拡張するか判断すべき」と
-- 明記していた。
--
-- 本タスク（8.4、品目ステータス変更UI）は要件5.7「実行前に確認を求め...
-- 品目のステータスを更新する」の実装に、以下の2つが必須:
--   (a) statusLabel(genre, status)によるジャンルに応じた正確な日本語表示
--       （観測可能な完了条件そのもの: 「注文明細のステータス表示が更新
--       される」）
--   (b) genre×status→次ステータスの判定（進めるボタンの表示可否・次に
--       送信するstatus値の決定。design.mdのupdateOrderItemStatay
--       Invariants「フード/一品: received→in_progress→done、ドリンク:
--       received→done」と1:1で対応させる必要がある）
-- のいずれもgenreを必要とするため、0012が委ねた判断を実行し、genreを追加する
-- ことが本タスクの必須前提（マンダトリーな前提作業）である。
--
-- 0009/0010/0011/0012/0013が確立した規約（既存の適用済みマイグレーションは
-- 編集せず、`create or replace function`で関数本体のみを差し替える新しい
-- 番号のファイルを追加する）をそのまま踏襲し、0004/0012は編集しない。
--
-- =========================================================================
-- 実装: list_kitchen_feed（0004）と同じjoinパターンをmirrorする
-- =========================================================================
-- list_register_feedのLATERAL集計サブクエリは現在
-- `order_items oi join orders o on o.id = oi.order_id`のみをjoinしており
-- menu_itemsを参照していない。list_kitchen_feed（0004）が確立した
-- `join public.menu_items mi on mi.id = oi.menu_item_id`という同一の
-- joinパターンをそのまま追加し、jsonb_build_objectへ'genre', mi.genreを
-- 1行追加する。それ以外（device_role検証・total集計式・activeSessionの
-- 合成・hasOpenCallRequestの判定・id/optionsSummary/statusの既存フィールド）
-- は一切変更しない。

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
          -- タスク8.3で追加: removeOrderItem({orderItemId})の対象識別に必須。
          'id', oi.id,
          'menuItemId', oi.menu_item_id,
          'name', oi.name_snapshot,
          'quantity', oi.quantity,
          'unitPrice', oi.unit_price_snapshot,
          -- タスク8.3で追加。
          'optionsSummary', oi.options_summary,
          'status', oi.status,
          -- タスク8.4で追加: statusLabel(genre, status)のジャンルに応じた
          -- 日本語表示、および進めるボタンの次ステータス判定
          -- （resolveNextOrderItemStatus、src/lib/orderItemStatusTransitions.ts）
          -- の両方に必須（本ファイル冒頭コメント「背景」参照）。
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
    -- タスク8.4で追加: list_kitchen_feed（0004）と同一のjoinパターン
    -- （本ファイル冒頭コメント「実装」参照）。
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
   閲覧系RPC（要件2.2, 5.1-5.4, 5.5, 5.6, 5.7）。冒頭でassert_device_role(array
   [''register''])を検証する（それ以外のdevice_role・claim欠如はカスタム
   SQLSTATE ''P0403''、assert_device_role自身が送出。design.mdの`never`
   エラー型に対応する解釈は0004設計判断25と同じ）。対象店舗
   （store_idスコープ、アクティブセッションの有無を問わず空席卓も含む、
   要件5.4）を、design.mdのTableBillingSummary型と同じキー構成
   （tableId/tableLabel/activeSession/items/total/hasOpenCallRequest）の
   jsonb配列として返す。各itemsの要素はタスク8.3でid/optionsSummary/status、
   タスク8.4でgenreを追加し、{id, menuItemId, name, quantity, unitPrice,
   optionsSummary, status, genre}となった（本ファイル冒頭コメント参照。
   idはremoveOrderItemの対象識別に必須、optionsSummaryはmock-preview.htmlとの
   表示乖離解消、genreはステータス表示・進めるボタンの次ステータス判定に
   必須。list_kitchen_feed（0004）と同じ`join public.menu_items mi on mi.id
   = oi.menu_item_id`パターンで取得する）。アクティブセッションがない卓は
   activeSession: null・items: []・total: 0・hasOpenCallRequest: falseとなる
   （要件5.2、0004設計判断24）。activeSessionがある卓のtotalは
   get_ordering_context（0003）のconfirmedTotalと文字通り同一の集計式
   （unit_price_snapshot*quantityの合計、statusによる絞り込みなし）で
   計算し、両者が常に一致することをlistRegisterFeed.integration.test.tsの
   クロスRPC検証で担保する（0004設計判断23、design.mdが明示的に要求する
   整合性）。hasOpenCallRequestは対象セッションに''open''のcall_requestsが
   存在するかを表す（要件2.2）。SECURITY DEFINER + search_path='''' +
   stableは他の閲覧系RPC（get_ordering_context, 0003; list_kitchen_feed,
   0004）と同じ構成。';

revoke execute on function public.list_register_feed(uuid)
  from public, anon, authenticated;

grant execute on function public.list_register_feed(uuid) to authenticated;
