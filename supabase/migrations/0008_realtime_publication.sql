-- 0008_realtime_publication.sql
-- table-order-kitchen: order_items / table_sessions / call_requestsを
-- Supabase Realtimeで購読可能にする（publication登録 + 最小限の読み取りRLS）
--
-- Requirements: 1.12, 6.1, 6.8, 6.9
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "RealtimeFeed" コンポーネント（Event Contract）を参照。
--   Published events: order_itemsテーブルおよびcall_requestsテーブルへの
--   INSERT/UPDATE（Supabase postgres_changes）
--   Subscribed events: KitchenBoardは店舗全体のorder_itemsの変更を、
--   RegisterConsoleはorder_items/table_sessions/call_requestsの変更を購読する。
--   CustomerOrderApp（P1、タスク6.x・本specでは未着手）が「自身の来店セッションに
--   限定したorder_itemsの変更」を購読する件は、下部「anonへのSELECT付与を
--   見送った理由」を参照（本マイグレーションはこれを実装しない）。
--
-- スコープ: タスク5（useRealtimeFeedフック）が要求する、Realtime配信の
--   前提条件のみ。書き込み経路（INSERT/UPDATE/DELETE）は引き続き
--   SECURITY DEFINER RPC（CustomerOrderingGateway / StaffOperationsGateway）
--   経由のみであり、本マイグレーションは変更しない（0002の
--   `revoke all ... from anon, authenticated`はSELECT以外は維持される）。
--
-- =========================================================================
-- 背景（実機で独立に再検証した事実。下記はいずれも本タスク実装者が
-- ローカルSupabaseスタック（CLI 2.117.0）に対し、`@supabase/supabase-js`
-- 2.116.0の実クライアントで直接確認した。前任者（このファイルの初稿を
-- 書いた中断セッション）の調査結果を鵜呑みにせず、独立して再現した）:
--
-- 1. publication登録は必須。`supabase db reset`直後の`supabase_realtime`
--    publicationは`puballtables=false`かつ対象テーブル0件（`pg_publication_tables`
--    で確認）。`alter publication ... add table`なしでは、
--    `postgres_changes`購読は正しいGRANT/RLSがあってもサーバー側で拒否される
--    （後述の通り`CHANNEL_ERROR: RealtimeDisabledForConfiguration`という
--    明示的エラーになることを`config.postgres_changes_options.wait: true`
--    指定時に確認した）。
--
-- 2. GRANT SELECT + RLS許可ポリシーも独立して必須。`realtime.apply_rls`
--    （supabase/realtime拡張のPL/pgSQL関数、`pg_get_functiondef`で実機の
--    定義を確認済み）は、変更行を配信する前に対象ロールが
--    `has_column_privilege(role, entity, pk_column, 'SELECT')`を満たすかを
--    まずチェックし、満たさなければ該当購読には配信しない。さらにRLSが
--    有効なテーブルでは、`set_config('role', ...)`と
--    `set_config('request.jwt.claims', ...)`で購読者のJWTクレームに
--    なりすませた上で、対象行に対する実際のRLS SELECTポリシーを
--    `execute 'execute walrus_rls_stmt'`として評価し、許可された購読にのみ
--    配信する。つまりRealtimeは「publicationに乗っているから配信する」の
--    ではなく、PostgRESTのRPC呼び出しと同様に、GRANTとRLSの両方を
--    購読者ごと・変更行ごとに再評価する。publicationにテーブルを追加した
--    だけで、GRANT/RLSをそのままにした場合、`authenticated`ロール
--    （device_role='kitchen'のJWTを含む）で購読しても変更イベントは
--    一切配信されないことを、4回中3回で確認した（1回だけ配信された
--    ケースがあったが、その回のみ他条件を全く変えずに再実行しても
--    再現せず、ローカル開発コンテナ側の一過性の問題〈`walrus_rls_stmt`
--    という名前付きprepared statementの再利用に起因する可能性がある〉と
--    判断した。この一過性の揺らぎ自体が「GRANT/RLSの設定だけに依存するのは
--    リスクがある」ことを裏付けるため、下記のanon判断をより保守的にする
--    根拠として扱う）。
--
-- 3. 追加の実装上の発見（前任者の調査には含まれていなかった新知見）:
--    `channel.subscribe()`はデフォルトで、サーバー側の`postgres_changes`
--    購読登録が実際に完了する前に`SUBSCRIBED`を報告しうる
--    （`RealtimeChannel.d.ts`のコメントで確認、実機でも`realtime.subscription`
--    テーブルへの行挿入が`SUBSCRIBED`コールバックより後になるケースを
--    観測した）。この間隙で発生した変更はイベントとして配信されない
--    （サイレントに欠落する）。`config.postgres_changes_options.wait: true`
--    を指定すると、サーバーが`postgres_changes`購読の確立を確認するまで
--    `SUBSCRIBED`を保留し、確立できない場合は明示的に`CHANNEL_ERROR`
--    （例:`RealtimeDisabledForConfiguration`）を返すことを実機で確認した。
--    そのため`src/lib/realtime/useRealtimeFeed.ts`は全チャンネルでこの
--    オプションを指定する（詳細は同ファイルのコメント参照）。
-- =========================================================================

-- =========================================================
-- 1. supabase_realtime publicationへ対象3テーブルを追加する。
--    これがない限りWAL上の変更はRealtimeサーバーへ一切ストリームされない
--    （背景1参照）。
-- =========================================================
alter publication supabase_realtime add table order_items, table_sessions, call_requests;

-- =========================================================
-- 2. order_items: kitchen/register両方の職員デバイスからのSELECTを許可する。
--
--    device_role判定は0006_assert_device_role.sqlと同じ技法
--    （auth.jwt() ->> 'device_role'、セッションローカルのGUCを読むだけの
--    STABLE関数）を用いる。list_kitchen_feed/list_register_feed
--    （0004_rpc_staff_gateway.sql 設計判断21等）が「呼び出し元デバイスが
--    自店舗かどうか」を検証せずp_store_id引数をそのまま信頼する既存の
--    v1スコープの割り切りに合わせ、本ポリシーも店舗単位のスコープ絞り込みは
--    行わない（将来複数店舗展開時に見直す）。
-- =========================================================
grant select on order_items to authenticated;

create policy order_items_staff_select
  on order_items
  for select
  to authenticated
  using ((auth.jwt() ->> 'device_role') in ('kitchen', 'register'));

-- =========================================================
-- anonへのSELECT付与を見送った理由（本タスクでの独立レビュー、初稿からの変更点）
--
-- 初稿（このファイルの前身、中断セッションが残した未コミット版）は
-- `grant select on order_items to ... anon` + `using (true)`（無条件で
-- 全行許可）を提案していた。理由は「匿名客のJWTにはsession_id等の
-- 照合可能なクレームが一切ない（3.1のレビューで確認済み）ため、行を
-- 絞り込むRLS述語を書く対象が存在せず、`session_id=eq.<own session id>`
-- という絞り込みはuseRealtimeFeedのclient-supplied filterパラメータで
-- 行う設計にせざるを得ない」というもの。この判断は本タスクで独立に
-- 再評価し、**却下した**。理由は以下の通り。
--
-- (1) `using (true)`をanonに与えることは、RLSレベルでの絞り込みを行わない
--     ことと数学的に同値である。anonは識別可能なクレームを持たないため、
--     「限定的だが完全ではないRLS述語」を書く余地が原理上存在しない
--     （trueかfalseの二択）。よって「narrow」ではなく「全開放」である。
--
-- (2) filterパラメータ（`session_id=eq.<id>`）はRealtimeサーバーへの
--     購読リクエストに含まれるクライアント指定の絞り込みであり、
--     アプリのUIコードを経由しない生のwebsocket呼び出し（例:
--     ブラウザのdevtoolsからpublicなanon keyのみでRealtime APIを直接叩く）
--     からは自由に省略できる。design.mdのSecurity Considerations節、および
--     submit_order/get_ordering_context（3.1/3.2、既にコミット済み）が
--     一貫して採用してきた「クライアント指定のスコープ絞り込みをDB側で
--     信頼しない」という本specの原則と、`using (true)` + filter依存は
--     正面から矛盾する。
--
-- (3) 露出範囲の比較: 既にコミット済みのget_ordering_context（3.1）は、
--     呼び出し元が既知のtableIdを渡した場合に限り、その卓のconfirmedTotal
--     （集計済みの単一の金額）とメニュー一覧のみを返す。他卓の個々の
--     order_items明細（品目名・数量・単価・オプション・session_id・
--     status）は一切返さない。これに対し`using (true)`でのanon SELECT
--     配信は、公開されているanon keyさえあれば（このアプリのUIを一切
--     経由せずとも）**店舗内の全卓・全セッションのorder_items変更を
--     品目明細レベルでリアルタイムに恒常的に観測できてしまう**。これは
--     get_ordering_context が意図的に絞り込んでいる範囲を大幅に超える、
--     質的に異なる露出であり、「既存の露出範囲を実質的に広げるものでは
--     ない」という初稿の主張は誤りと判断した。
--
-- (4) 代替案の検討: 列を絞る（Postgres 15+のpublication列リスト）ことも
--     検討したが、`alter publication ... add table t (col1, col2)`は
--     publication単位（＝購読者ロールを問わず全員）に適用されるため、
--     kitchen/registerが必要とする列（価格・オプション等）まで一緒に
--     削られてしまい、行単位（=他卓かどうか）の露出という本質的な問題を
--     解決しない。よって却下。
--
-- (5) 結論: 匿名客（anon）に対しては、本マイグレーションでorder_itemsへの
--     SELECTを一切付与しない。design.mdのEvent Contractが記述する
--     CustomerOrderApp（P1、要件1.12「同席者の別端末からの注文への追随」）
--     のRealtime購読は、本タスクでは意図的に未実装のまま残す
--     （Components and Interfaces表でCustomerOrderApp→RealtimeFeedの
--     依存はP1＝ベストエフォートであり、UI自体もタスク6.x・本specでは
--     未着手）。将来6.xでこれに着手する際は、店舗全体のorder_itemsを
--     anonへ無制限公開する以外の経路（例: 変更行の中身を信頼せず単なる
--     「再取得しろ」という合図としてのみ使い、実際のconfirmedTotal算出は
--     必ずget_ordering_context再呼び出しに委ねた上で、その「合図」自体を
--     Realtime Broadcast + `realtime.messages`のRLS認可
--     〈postgres_changesではなくbroadcast_changesトリガー経由、
--     session_idをtopic名に含めることでRLSを「そのtopicの購読を許可
--     するか」という粒度に落とし込める〉に切り替える、または単純に
--     get_ordering_contextのポーリングに留める、など）を別途設計し、
--     必要な追加マイグレーションを新しいタスクとして起票すること。
--     本タスク（5）のスコープは「厨房/レジのuseRealtimeFeed利用に必要な
--     DB基盤を安全に用意する」までであり、客側の未実装UIのために
--     セキュリティ原則を緩めない。
-- =========================================================

-- =========================================================
-- 3. table_sessions / call_requests: RegisterConsole（registerロール限定、
--    design.mdのEvent Contract「RegisterConsoleはorder_items/table_sessions/
--    call_requestsの変更を...購読する」）のみが対象。KitchenBoardは
--    order_itemsのみを購読するためkitchenロールは含めない
--    （list_kitchen_feedがkitchen限定・list_register_feedがregister限定という
--    0004設計判断21の「相互排他的な読者」の区分と揃える）。
-- =========================================================
grant select on table_sessions, call_requests to authenticated;

create policy table_sessions_register_select
  on table_sessions
  for select
  to authenticated
  using ((auth.jwt() ->> 'device_role') = 'register');

create policy call_requests_register_select
  on call_requests
  for select
  to authenticated
  using ((auth.jwt() ->> 'device_role') = 'register');
