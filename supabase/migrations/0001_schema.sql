-- 0001_schema.sql
-- table-order-kitchen: コアスキーマ定義
--
-- Requirements: 1.5, 1.6, 3.4, 4.1, 6.2, 6.3, 6.4, 6.10, 7.4
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "Data Models" (Domain Model / Logical Data Model / Physical Data Model) を参照。
--
-- スコープ: テーブル定義・制約・インデックスのみ。
-- RLS（行レベルセキュリティ）の有効化は次のマイグレーション（0002）で行うため、
-- 本ファイルでは ALTER TABLE ... ENABLE ROW LEVEL SECURITY を含めない。
--
-- UUIDのデフォルト生成には gen_random_uuid()（pgcryptoが提供）を使用する。
-- Supabaseのローカル/クラウドPostgresでは pgcrypto が `extensions` スキーマに
-- デフォルトで有効化されており、config.toml の extra_search_path に
-- `extensions` が含まれるため、スキーマ修飾なしで呼び出せる。

-- =========================================================
-- stores: 店舗（全テーブルの起点。将来の複数店舗展開に備える）
-- =========================================================
create table stores (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

-- =========================================================
-- tables: 卓（店舗に属する固定の物理単位。QRコードは卓に対して固定発行）
-- =========================================================
create table tables (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id),
  label text not null
);

-- =========================================================
-- menu_items: メニュー品目（要件1.5 写真, 1.6 オプション, 7.4 売り切れ非影響の前提）
-- =========================================================
create table menu_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id),
  name text not null,
  price numeric not null,
  sold_out boolean not null default false,
  -- ジャンルに応じて調理ステータスの許可遷移が変わる（要件6.3, 6.4）
  genre text not null check (genre in ('ippin', 'food', 'drink')),
  -- 要件1.5: 品目に写真が登録されている場合に表示する
  image_url text,
  -- 要件1.6: 味付け選択・トグル・個数指定等のオプション定義
  -- 形式: [{ id, type: "choice"|"toggle"|"counter", label, choices?, min?, max?, default }]
  options jsonb not null default '[]'::jsonb
);

-- =========================================================
-- table_sessions: 来店セッション（1来店＝1集約ルート）
-- =========================================================
create table table_sessions (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references tables (id),
  status text not null check (status in ('active', 'closed')),
  -- 要件3.4: 各来店セッションに記録された人数を保持する
  party_size int not null,
  started_at timestamptz not null default now(),
  closed_at timestamptz
);

-- 要件4.1: 卓ごとに同時にアクティブな来店セッションを高々1つに保つ。
-- 観測可能な完了条件: 同一卓に対して2件目のアクティブセッションをINSERTすると
-- 一意制約違反になる。
create unique index table_sessions_active_table_id_key
  on table_sessions (table_id)
  where status = 'active';

-- =========================================================
-- orders: 注文（来店セッションに紐づく送信単位）
-- =========================================================
create table orders (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references table_sessions (id),
  -- 冪等性キー。同一キーでの再送は新規行を作らず既存注文を返す（submit_order側の責務）
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  constraint orders_session_id_idempotency_key_key unique (session_id, idempotency_key)
);

create index orders_session_id_idx on orders (session_id);

-- =========================================================
-- order_items: 注文明細（品目単位でステータスを保持する。要件6.2）
-- =========================================================
create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id),
  menu_item_id uuid not null references menu_items (id),
  -- 要件7.4: menu_itemsの以後の変更（価格改定・売り切れ）から独立させるためのスナップショット
  name_snapshot text not null,
  unit_price_snapshot numeric not null,
  quantity int not null,
  -- 許可遷移はmenu_items.genreに依存するためCHECK制約では表現せず、
  -- update_order_item_status関数側で検証する（design.md Consistency & Integrity参照）
  status text not null check (status in ('received', 'in_progress', 'done')),
  -- 要件6.10: 調理完了列を直近完了順（降順）に並べるためのソートキー
  status_updated_at timestamptz not null default now(),
  -- 要件7.4: 客が選択したオプションの生データ。注文時点で確定し以後不変
  options_selected jsonb not null default '{}'::jsonb,
  -- 厨房/レジ表示用の短い要約文字列（例:「塩」「わさび抜き」）。オプション未選択時はnull
  options_summary text,
  note text
);

create index order_items_order_id_idx on order_items (order_id);
create index order_items_status_idx on order_items (status);

-- 要件6.10: 調理完了列のソート（status_updated_at降順）に用いる複合インデックス
create index order_items_status_status_updated_at_idx
  on order_items (status, status_updated_at);

-- =========================================================
-- call_requests: 呼び出し要求
-- =========================================================
create table call_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references table_sessions (id),
  status text not null check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index call_requests_session_id_idx on call_requests (session_id);

-- =========================================================
-- devices: 厨房/レジタブレットの匿名デバイス識別
-- =========================================================
create table devices (
  id uuid primary key default gen_random_uuid(),
  -- 1匿名ユーザー＝1デバイス
  auth_user_id uuid not null unique,
  store_id uuid not null references stores (id),
  role text not null check (role in ('kitchen', 'register'))
);
