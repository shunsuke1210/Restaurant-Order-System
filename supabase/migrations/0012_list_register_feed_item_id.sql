-- 0012_list_register_feed_item_id.sql
-- table-order-kitchen: list_register_feedの各明細にid/optionsSummary/statusを追加する
--
-- Requirements: 5.5, 5.6
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "StaffOperationsGateway" コンポーネント（Service Interface:
--   TableBillingSummary）を参照。本タスク（8.3）で改訂した型定義に
--   合わせて本マイグレーションを適用する。
--
-- =========================================================================
-- 背景（タスク8.2 Implementation Notesが明示的にタスク8.3の必須前提として
--   記録していたギャップ）
-- =========================================================================
-- タスク8.2完了時点の`list_register_feed`（0004_rpc_staff_gateway.sql、
-- 設計判断21以降）が返す`TableBillingSummary.items`は
-- `{menuItemId, name, quantity, unitPrice}`の4フィールドのみであり、
-- 注文明細自体の識別子（`order_items.id`）を一切含んでいなかった
-- （`menuItemId`は同一注文内で同じ品目を複数回追加した場合に重複しうるため
-- 一意識別子として使えない）。タスク8.3（品目の追加・削除UI）は
-- `removeOrderItem({orderItemId})`の呼び出しにこの`id`を必要とするため、
-- この拡張なしには8.3は実装不能である（tasks.md Implementation Notes、
-- 8.2ブロック最終段落を参照）。
--
-- 0009_ordering_context_menu_genre.sql/0010_ordering_context_call_request.sql/
-- 0011_list_menu_items.sqlが確立した「既存の適用済みマイグレーションは
-- 編集せず、`create or replace function`で関数本体のみを差し替える新しい
-- 番号のファイルを追加する」という規約をそのまま踏襲する
-- （0004_rpc_staff_gateway.sqlは編集しない）。
--
-- =========================================================================
-- 追加するフィールドの範囲についての判断
-- =========================================================================
-- 最低限必要なのは`id`（削除操作の対象識別に必須）のみだが、タスク8.2
-- Implementation Notesは「optionsSummary/statusも併せて追加するかは
-- 実装者の判断」としていた。本タスクでは以下の理由により両方とも
-- 同じマイグレーション・同じjsonb_build_objectへ追加する（対応する
-- コスト・リスクが実質ゼロで、mock-preview.htmlの`tableDetailHtml`が
-- 検証済みの表示（品目名の後ろにオプション概要を括弧書きで表示する）との
-- 既知の乖離を追加コストなしで解消できるため）:
--   - `optionsSummary`（`order_items.options_summary`）: タスク8.3のUI
--     （削除確認モーダルの対象品目ラベル、追加された品目の表示）で、
--     同一品目でもオプション違いの複数明細を利用者が区別できるようにする
--     ために表示する。
--   - `status`（`order_items.status`）: 8.4（品目ステータス変更UI）が
--     必要とする値を先取りして返しておく。ただし本タスク（8.3）のUI自体は
--     ジャンル情報（`menu_items.genre`）を持たないため、mock-preview.htmlの
--     `statusLabel(genre, status)`のようなジャンルに応じた正確な日本語
--     ラベル変換はできない（ドリンクにも「調理中」があるかのような誤った
--     表示になりかねない）。よって本タスクのUIは`status`の値を取得はするが
--     画面には表示しない、という意図的な部分対応にとどめる
--     （TableDetailPanel.tsx冒頭コメント参照。8.4がジャンルも必要とする
--     形で改めてこのRPCを拡張するか判断すべき）。
-- `genre`は追加しない（8.3のいかなる観測可能な完了条件にも必要とされず、
-- 追加すると8.4の設計判断を先取りしてしまうため。YAGNI/Simplification
-- 原則）。
--
-- 0004からの変更点は、list_register_feedのLATERAL集計サブクエリの
-- jsonb_build_objectへ'id'・'optionsSummary'・'status'の3行を追加するのみ。
-- それ以外（device_role検証・total集計式・activeSessionの合成・
-- hasOpenCallRequestの判定等）は一切変更しない。

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
          -- タスク8.3で追加: removeOrderItem({orderItemId})の対象識別に
          -- 必須（本ファイル冒頭コメント「背景」参照）。
          'id', oi.id,
          'menuItemId', oi.menu_item_id,
          'name', oi.name_snapshot,
          'quantity', oi.quantity,
          'unitPrice', oi.unit_price_snapshot,
          -- タスク8.3で追加: mock-preview.htmlとの既知の表示乖離を解消する
          -- （本ファイル冒頭コメント「追加するフィールドの範囲についての
          -- 判断」参照）。
          'optionsSummary', oi.options_summary,
          'status', oi.status
        )
        order by oi.id
      ) as items,
      -- 0004設計判断23: get_ordering_context（0003）のconfirmedTotalと
      -- 文字通り同一の集計式（statusによる絞り込みなし）。本タスクでは
      -- 変更しない。
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
  'レジ（authenticated, device_role=''register''。0004設計判断21参照）が卓
   マップ・卓別会計確認一覧を取得する際に呼び出すStaffOperationsGatewayの
   閲覧系RPC（要件2.2, 5.1-5.4, 5.5, 5.6）。冒頭でassert_device_role(array
   [''register''])を検証する（それ以外のdevice_role・claim欠如はカスタム
   SQLSTATE ''P0403''、assert_device_role自身が送出。design.mdの`never`
   エラー型に対応する解釈は0004設計判断25と同じ）。対象店舗
   （store_idスコープ、アクティブセッションの有無を問わず空席卓も含む、
   要件5.4）を、design.mdのTableBillingSummary型と同じキー構成
   （tableId/tableLabel/activeSession/items/total/hasOpenCallRequest）の
   jsonb配列として返す。各itemsの要素はタスク8.3でid/optionsSummary/status
   を追加し、{id, menuItemId, name, quantity, unitPrice, optionsSummary,
   status}となった（本ファイル冒頭コメント参照。idはremoveOrderItemの
   対象識別に必須、optionsSummaryはmock-preview.htmlとの表示乖離解消、
   statusは8.4向けに値のみ先取り）。アクティブセッションがない卓は
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
