-- 0002_rls_policies.sql
-- table-order-kitchen: RLS（行レベルセキュリティ）の有効化と権限のロックダウン
--
-- Requirements: 8.1, 8.2, 8.3
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "Schema & RLS Foundation" コンポーネント（Responsibilities & Constraints）を参照。
--
-- スコープ: 全8テーブルでのRLS有効化と、生テーブルへの直接アクセス権限の
--   ロックダウンのみ。RPC関数（SECURITY DEFINERでRLSをバイパスする経路）は
--   タスク3.x/4.xの責務であり、本マイグレーションには含めない。
--
-- 背景（このマイグレーションが必要な理由）:
--   Supabaseのローカル/クラウドPostgresでは、`public`スキーマに`postgres`ロールが
--   作成したテーブルに対し、ALTER DEFAULT PRIVILEGESにより`anon`/`authenticated`
--   ロールへ暗黙のフルアクセス権限（SELECT/INSERT/UPDATE/DELETE等）が自動付与される。
--   これは「ALTER TABLE ... ENABLE ROW LEVEL SECURITY」だけでは打ち消されない
--   （テーブルレベルのGRANTが無い状態でのINSERT/UPDATE/DELETEは、RLSポリシーの
--   評価以前にテーブルレベル権限チェックで許可されてしまう）。
--   そのため、RLS有効化に加えて明示的なREVOKEが必須となる。
--   実機検証: `SET LOCAL ROLE anon`で切り替えたセッションから、REVOKE前は
--   INSERT/SELECTが権限チェックを素通りすることを確認済み（本タスクのテストで再現）。

-- =========================================================
-- 1. 全8テーブルでRLSを有効化する
-- =========================================================
alter table stores enable row level security;
alter table tables enable row level security;
alter table menu_items enable row level security;
alter table table_sessions enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table call_requests enable row level security;
alter table devices enable row level security;

-- =========================================================
-- 2. Deny-by-default: Supabase初期化時にpostgresロールから
--    anon/authenticatedへ付与されるデフォルト権限を明示的に剥奪する。
--    以後、`authenticated`（device_role未検証のデバイスセッションを含む）にも
--    どのテーブルへの直接書き込み権限も一切与えない。全ての書き込みは
--    将来実装されるSECURITY DEFINER RPC（CustomerOrderingGateway /
--    StaffOperationsGateway）経由のみとする。
-- =========================================================
revoke all on
  stores,
  tables,
  menu_items,
  table_sessions,
  orders,
  order_items,
  call_requests,
  devices
from anon, authenticated;

-- =========================================================
-- 3. 唯一の例外: 客側メニュー表示に必要な最小権限として、
--    `menu_items`のSELECTのみ`anon`に許可する。
--    RLSが有効な状態ではGRANTだけでは行が返らないため、
--    許可ポリシーも合わせて定義する（全行を対象。店舗単位の絞り込みは
--    呼び出し側のtable_idからのRPC経由の取得ロジックに委譲し、
--    本スペックでは単一店舗を前提とする）。
-- =========================================================
grant select on menu_items to anon;

create policy menu_items_anon_select
  on menu_items
  for select
  to anon
  using (true);
