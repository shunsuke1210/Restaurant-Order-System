-- supabase/seed.sql
-- table-order-kitchen: ローカル開発専用のシードデータ。
--
-- Supabase CLIは`supabase db reset`のたびに全マイグレーション適用後、本ファイルが
-- 存在すれば自動的に実行する（`supabase/config.toml`の既定動作）。
--
-- 背景（このファイルが必要と判明した経緯）:
--   design.mdのNon-Goals「卓自体の登録・QRコード発行機能。stores/tablesの
--   初期データは本spec範囲外の手動投入作業として扱う」の通り、本specは
--   store/table登録機能を実装しない。そのためタスク2.3（DeviceIdentityProvider）
--   以降、`/setup/[role]`でのデバイスプロビジョニングや`/order/[tableId]`の
--   動作確認には、`.env.local`の`NEXT_PUBLIC_STORE_ID`と一致する`stores`行が
--   事前に存在している必要があった。これまで各タスクの実装者・レビュアーは
--   `db:reset`のたびに手動で`pg`スクリプト等によりstore行を都度再投入していた
--   （2.3のコメント、4.5のレビューで`WARN: no files matched pattern:
--   supabase/seed.sql`が指摘された経緯、7.4で初めて自動テスト
--   （`e2e/kitchen-soldout-board.spec.ts`）がこの手動投入に依存し、CI/初回
--   セットアップでは再現できないことが判明）。
--
--   本ファイルは、この「store行が無いと動作確認できない」という繰り返し発生する
--   摩擦を解消するための、決定論的なローカル開発専用データである。卓自体の
--   登録・QRコード発行機能そのものを実装するものではなく（design.mdの
--   Non-Goalsに抵触しない）、単に開発・検証を始められる最低限の1店舗・
--   数卓分のデータを`db:reset`後に自動投入するだけの、開発体験改善である。
--
-- 注意: `id`はいずれも固定UUID（`.env.local`の`NEXT_PUBLIC_STORE_ID`と一致させる
-- ため）。本番/ステージング環境ではこのファイルは実行されない
-- （`supabase db reset`はローカル開発専用のコマンドであり、Supabase CLIは
-- リンク済みのリモートプロジェクトに対して`seed.sql`を自動実行しない）。

insert into stores (id, name)
values ('d7c26e3a-c0c6-4db6-b6ba-d913b3145562', 'たくみ屋（開発用）')
on conflict (id) do nothing;

insert into tables (id, store_id, label)
values
  ('11111111-1111-4111-8111-111111111101', 'd7c26e3a-c0c6-4db6-b6ba-d913b3145562', 'C1'),
  ('11111111-1111-4111-8111-111111111102', 'd7c26e3a-c0c6-4db6-b6ba-d913b3145562', 'C2'),
  ('11111111-1111-4111-8111-111111111103', 'd7c26e3a-c0c6-4db6-b6ba-d913b3145562', 'T1'),
  ('11111111-1111-4111-8111-111111111104', 'd7c26e3a-c0c6-4db6-b6ba-d913b3145562', 'T2')
on conflict (id) do nothing;
