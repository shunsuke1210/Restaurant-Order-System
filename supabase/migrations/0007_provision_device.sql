-- 0007_provision_device.sql
-- table-order-kitchen: provision_device RPC — DeviceIdentityProviderの
-- タブレット初回プロビジョニング専用エンドポイント
--
-- Requirements: 8.2, 8.3
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "DeviceIdentityProvider" コンポーネント（Responsibilities & Constraints:
--   「初回セットアップ時のみ/setup/[role]画面でセットアップコード（環境変数で
--   管理する共有シークレット）を入力し、匿名サインイン＋devicesテーブルへの
--   登録を行う」、Service Interface: provisionDevice(input: ProvisionDeviceInput)、
--   Implementation Notes: 「セットアップコードは環境変数として保持し、
--   店舗ごとに使い回す想定」）を参照。
--
-- スコープ: 匿名サインイン済みクライアントが、セットアップコードを提示して
--   自分自身のdevicesテーブルの行を作成/更新するためのSECURITY DEFINER RPC
--   関数 provision_device(text, text, uuid) 単体の実装のみ。
--   StaffOperationsGateway/CustomerOrderingGatewayのRPC関数（タスク3.x/4.x）は
--   本マイグレーションの対象外。design.mdのComponents and Interfacesでは
--   DeviceIdentityProviderは両Gatewayとは独立した行として定義されており
--   （Contracts: Service [x] / State [x]）、プロビジョニング専用のRPCを
--   両Gatewayとは別に持つ設計とする（タスク2.3のタスク文書で明示された方針）。
--
-- =========================================================================
-- 設計判断1: セットアップコードの保管先にSupabase Vaultを採用する
-- =========================================================================
-- design.mdはセットアップコードを「環境変数として保持」すると述べているが、
-- 本アーキテクチャはNext.js API Route等の独自バックエンドサーバーを持たない
-- BaaS構成（tech.md「自前でのサーバー構築・保守は行わない」）であり、
-- 検証は必ずPostgres関数の内部で完結させる必要がある。Next.jsのprocess.env
-- （DEVICE_SETUP_CODE、NEXT_PUBLIC_接頭辞なし）はNext.jsサーバー側実行時にしか
-- 読めず、かつクライアントブラウザから直接Postgresの関数を検証させる以外の
-- 経路がないため、「Postgres自身が環境変数由来の値を検証できる」仕組みが必要になる。
--
-- Supabase CLI 2.117.0で実機確認済み: supabase/config.tomlの[db.vault]セクションは
-- `env(VAR)`構文をサポートしており、`supabase start` / `supabase db reset`の
-- たびにプロジェクトルートの.env.local（Next.js標準のローカル用dotenvファイルを
-- そのまま利用でき、Supabase CLI専用の別名.envファイルを追加で用意する必要は
-- ないことを実機確認済み）からDEVICE_SETUP_CODEを読み取り、Supabase Vault
-- （pgsodiumで暗号化保存されるvault.secretsテーブル）へ名前`device_setup_code`
-- （小文字化される。既知の挙動: supabase/cli#3242）としてupsertする。
-- 実機検証ログ: `supabase db reset`実行時に「Updating vault secrets...」が
-- 出力され、その後
-- `select decrypted_secret from vault.decrypted_secrets where name = 'device_setup_code'`
-- が.env.localのDEVICE_SETUP_CODEに設定した値と一致する平文を返すことを確認した。
-- さらにエンドツーエンドでも実機確認済み: .env.localのDEVICE_SETUP_CODEに設定した
-- 値でprovision_deviceを呼び出すとデバイスが正常にプロビジョニングされ、
-- 誤った値では下記「設計判断4」のカスタムSQLSTATE 'P0401'で拒否されることを確認した
-- （このコメント自体には値そのものを記載しない。git管理下のファイルへ平文の
-- シークレット値を書かないという本設計判断の趣旨に反するため）。
--
-- current_setting('app.settings.*')のようなカスタムGUCではなくVaultを選んだ理由:
-- GUCをgit管理下のマイグレーションで設定するには`ALTER DATABASE ... SET
-- app.settings.x = '<平文の値>'`のように実際のシークレット値をSQLファイルへ
-- 直接埋め込む必要があり、本番のシークレットをgitへコミットすることになって
-- しまう。Vault + config.tomlのenv()の組み合わせであれば、ローカル開発・
-- 本番運用のいずれでも平文値をgit管理対象ファイルに一切書かずに済む。
--
-- 本番/クラウドSupabase向けの運用メモ（CONCERNSとしてタスク完了報告にも記載）:
-- config.tomlのenv()置換はSupabase CLIのローカル開発機能であり、クラウド環境には
-- 適用されない。本番では、プロジェクトの初回セットアップ時に一度だけ、Supabase
-- ダッシュボードのSQL Editor等から
-- `select vault.create_secret('<実際のセットアップコード>', 'device_setup_code', '...')`
-- を手動実行してVaultシークレットを投入する運用作業が別途必要になる。これは
-- design.mdのNon-Goalsが「卓自体の登録・QRコード発行機能（初期データは移行作業
-- として本spec範囲外で投入する）」と明記しているのと同種の、本spec範囲外の
-- 初期投入作業として扱う。
--
-- =========================================================================
-- 設計判断2: SECURITY DEFINERとsearch_path固定
-- =========================================================================
-- 0006はassert_device_roleを意図的にSECURITY INVOKERのまま実装した
-- （auth.jwt()がGUCを読むだけのSTABLE関数であり、DEFINER化が不要な複雑さを
-- 持ち込むと判断したため）。しかし本関数は
--   (a) authenticatedロールには直接grantされていないdevicesテーブルへの
--       INSERT/UPDATE（0002でRLS有効化・grant全剥奪済み）、
--   (b) authenticated/anonには一切grantされていないvault.decrypted_secretsの
--       読み取り（実機確認済み: role_table_grantsにはpostgres/service_roleのみ）
-- の両方を行う必要があり、呼び出し元（authenticated）自身の権限では実行
-- 不可能なため、0006のケースとは異なりSECURITY DEFINERが必須となる。
--
-- SECURITY DEFINER関数はsearch_path経由のなりすまし攻撃（呼び出し元が同名の
-- オブジェクトを自分のsearch_path上の別スキーマに用意し、関数本体の非修飾参照を
-- 乗っ取る攻撃）を防ぐため、`set search_path = ''`で実行時のsearch_pathを
-- 明示的に空にし、本文内の全参照（public.devices, vault.decrypted_secrets,
-- auth.uid()）をスキーマ修飾する。
--
-- =========================================================================
-- 設計判断3: 再プロビジョニング時はエラーにせずupsertする
-- =========================================================================
-- devices(auth_user_id)にはユニーク制約があり（0001）、「1匿名ユーザー＝
-- 1デバイス」という不変条件を表す。同一タブレット（同一の永続化された匿名
-- セッション）で/setup/[role]を再度開いた場合（例: 初回セットアップ時の
-- ロール選択ミスの訂正、店舗IDの変更）、既存devices行をエラーにせず
-- 更新する（`on conflict (auth_user_id) do update`）ことを選択した。
-- design.mdはこの再実行ケースを明記していないが、「デバイス単位の識別」という
-- State Managementの意図（プロビジョニング前/済みの2状態モデル。Persistence &
-- consistency「タブレットのストレージが消去された場合は再度/setup/[role]が
-- 必要」）と矛盾せず、運用上「セットアップは常に安全に再実行できる」方が、
-- 一人運用の店舗オペレーションでは使いにくいエラーを返すより適切と判断した。
--
-- =========================================================================
-- 設計判断4: エラーコードにカスタムSQLSTATE 'P0401'を割り当てる
-- =========================================================================
-- 0006が確立したカスタムSQLSTATE規約（SQLSTATEクラス'P0'は「PL/pgSQL Error」
-- としてPostgreSQL本体がPL/pgSQLユーザー定義コード向けに予約している領域。
-- 組み込み済みのP0001-P0004、および0006が割り当てたP0403と衝突しない未使用の
-- サブコードを選ぶ）を踏襲する。本関数の「セットアップコード不一致」には
-- 未使用の'P0401'（401 Unauthorized/認証情報不正を想起させる数字）を割り当てる。
-- フロントエンド（src/lib/device/useDeviceIdentity.ts）はこのSQLSTATEを
-- design.mdのDeviceProvisioningError型の{code: "INVALID_SETUP_CODE"}へ
-- マッピングする。
create or replace function public.provision_device(
  p_setup_code text,
  p_role text,
  p_store_id uuid
)
returns public.devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expected_setup_code text;
  v_auth_user_id uuid;
  v_device public.devices;
begin
  -- 呼び出し元は事前に匿名サインイン済みでなければならない
  -- （/setup/[role]画面はensureDeviceSession()を先に呼び、その後で
  -- provisionDevice()を呼ぶ想定。design.md Preconditions参照）。
  -- authenticatedロールへのEXECUTE権限のみで到達可能なため、通常はauth.uid()が
  -- nullになることはないが、防御的に検証する。
  v_auth_user_id := auth.uid();
  if v_auth_user_id is null then
    raise exception 'provision_device requires an authenticated session'
      using errcode = 'P0401';
  end if;

  select decrypted_secret
    into v_expected_setup_code
    from vault.decrypted_secrets
    where name = 'device_setup_code';

  -- vault.decrypted_secretsに該当シークレットが存在しない場合（未設定環境）も
  -- v_expected_setup_codeはnullのままとなり、以下のIS DISTINCT FROM比較により
  -- fail-closed（常に不一致扱い）となる。設定漏れが「誰でも通過できる」方向に
  -- 倒れないようにするための意図的な挙動。
  if p_setup_code is null or p_setup_code is distinct from v_expected_setup_code then
    raise exception 'invalid setup code'
      using errcode = 'P0401';
  end if;

  -- p_roleが'kitchen'/'register'以外の場合はdevices.roleのCHECK制約
  -- （0001_schema.sql）により標準のcheck_violation（SQLSTATE 23514）として
  -- 自然に拒否される。design.mdのDeviceProvisioningError型はこのケースを
  -- モデル化しておらず（/setup/[role]画面のルートパラメータ自体がkitchen/register
  -- 以外を受け付けない想定のため到達し得ない）、追加のバリデーションは行わない。
  insert into public.devices (auth_user_id, store_id, role)
  values (v_auth_user_id, p_store_id, p_role)
  on conflict (auth_user_id) do update
    set store_id = excluded.store_id,
        role = excluded.role
  returning * into v_device;

  return v_device;
end;
$$;

comment on function public.provision_device(text, text, uuid) is
  '匿名サインイン済みクライアント（authenticated, auth.uid()で識別）が、
   セットアップコード（Supabase Vaultのシークレット device_setup_code と照合）を
   提示して自分自身のdevicesテーブルの行を作成/更新するSECURITY DEFINER RPC。
   セットアップコード不一致の場合はカスタムSQLSTATE ''P0401''で例外を送出する
   （design.mdのDeviceProvisioningError型の{code: "INVALID_SETUP_CODE"}に対応）。
   devices(auth_user_id)の一意制約により、同一デバイスでの再実行は
   upsert（on conflict do update）として扱い、エラーにしない（設計判断3参照）。';

-- =========================================================
-- authenticatedロールにのみEXECUTEを許可する
-- （0006の「設計判断2」と同じ理由でPostgresは新規関数のEXECUTEをデフォルトで
-- PUBLICへ自動付与するため、まずPUBLICから剥奪し、authenticatedにのみ
-- 明示的に付与し直す。anonは匿名サインインすら行っていない客側の経路であり、
-- 「先に匿名サインインしてから、その後provisionDeviceを呼ぶ」というUIフロー
-- （タスク文書のIMPORTANT design decision参照）と一致させ、EXECUTE権限を
-- 与えない）。
-- =========================================================
revoke execute on function public.provision_device(text, text, uuid) from public, anon;
grant execute on function public.provision_device(text, text, uuid) to authenticated;
