-- 0005_custom_access_token_hook.sql
-- table-order-kitchen: Custom Access Token Hook — device_role クレームの付与
--
-- Requirements: 8.2, 8.3
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "DeviceIdentityProvider" コンポーネント（Responsibilities & Constraints）
--   「Custom Access Token Hookがdevicesテーブルを参照し、JWT発行のたびに
--   device_roleクレームを埋め込む」を参照。
--
-- スコープ: JWT発行時にdevicesテーブルを参照し、device_roleクレームを埋め込む
--   Custom Access Token Hook関数の実装と、GoTrueがこれを安全に実行できる
--   ようにする最小権限のGRANT/RLSポリシーのみ。
--   assert_device_role()ヘルパー（タスク2.2）や/setup/[role]画面（タスク2.3）は
--   本マイグレーションの対象外。
--
-- 背景（実機検証済み・Supabase CLI 2.117.0 / ローカルスタック）:
--   Supabase Authは、JWT発行（サインイン・トークンリフレッシュ双方）のたびに
--   supabase/config.tomlの[auth.hook.custom_access_token]に登録された
--   Postgres関数を呼び出す。この呼び出しはsuperuserではない
--   `supabase_auth_admin`ロールとして実行されるため、SECURITY DEFINERなし
--   （invoker権限のまま）ではdevicesテーブルへの読み取りにテーブルレベルの
--   GRANTと、0002で有効化済みのRLSを通過するための専用ポリシーが必要になる
--   （公式ドキュメントのCustom Access Token Hook/RBAC例と同じ構成）。
--   本関数はSECURITY DEFINERを使わず、supabase_auth_admin向けの限定的な
--   GRANT/RLSポリシーでdevicesへの読み取りのみを許可する（最小権限の原則）。
--   客の匿名セッションにはdevices行が存在しないため、その場合はclaimsを
--   一切変更せず、エラーも発生させない（要件8.2, 8.3は厨房/レジ双方が対象だが、
--   客側の匿名セッションも同じフックを通るため、無害に素通りする必要がある）。

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb;
  matched_device_role text;
begin
  claims := event->'claims';

  select role
  into matched_device_role
  from public.devices
  where auth_user_id = (event->'claims'->>'sub')::uuid;

  -- 一致するdevices行がある場合のみdevice_roleクレームを追加する。
  -- 一致しない場合（客の匿名セッション）はclaimsを無変更のまま返す。
  if matched_device_role is not null then
    claims := jsonb_set(claims, '{device_role}', to_jsonb(matched_device_role));
    event := jsonb_set(event, '{claims}', claims);
  end if;

  return event;
end;
$$;

comment on function public.custom_access_token_hook(jsonb) is
  'Custom Access Token Hook（Supabase Auth）。devicesテーブルにauth_user_idが一致する行があればJWTのclaimsにdevice_roleクレームを追加する。一致する行がない（客の匿名セッション）場合はclaimsを無変更のまま返す。SECURITY DEFINERは使わず、supabase_auth_admin向けの限定的なGRANT/RLSポリシーでdevicesへの読み取りのみを許可する（最小権限の原則）。';

-- =========================================================
-- supabase_auth_admin（GoTrueがフック実行に使うロール）への最小権限付与
-- =========================================================
grant usage on schema public to supabase_auth_admin;

grant execute
  on function public.custom_access_token_hook(jsonb)
  to supabase_auth_admin;

revoke execute
  on function public.custom_access_token_hook(jsonb)
  from authenticated, anon, public;

-- devicesは0002でRLSを有効化済み・anon/authenticatedへの全権限を剥奪済み。
-- フック実行ロールのsupabase_auth_adminはスーパーユーザーでもテーブル所有者
-- でもないためRLSをバイパスしない。読み取りに必要な最小権限のみ明示的に
-- 付与し、それ専用のSELECTポリシーを作成する（anon/authenticatedの
-- ロックダウン状態には手を加えない）。
grant select on table public.devices to supabase_auth_admin;

create policy devices_auth_admin_select
  on public.devices
  for select
  to supabase_auth_admin
  using (true);
