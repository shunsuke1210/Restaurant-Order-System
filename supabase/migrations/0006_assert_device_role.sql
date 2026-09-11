-- 0006_assert_device_role.sql
-- table-order-kitchen: assert_device_role() ヘルパー — StaffOperationsGatewayの
-- 各RPC関数冒頭で共通利用するdevice_role検証
--
-- Requirements: 8.2, 8.3
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "StaffOperationsGateway" コンポーネント（Responsibilities & Constraints）
--   「authenticatedロールかつJWTのdevice_roleクレームがkitchenまたはregisterである
--   場合のみ実行を許可する（関数内でauth.jwt()を検証）」と、Implementation Notes
--   「device_roleの検証は各RPC関数冒頭で共通利用する共通ヘルパー
--   （assert_device_role(text[])）として共通化する」を参照。
--
-- スコープ: assert_device_role(text[])ヘルパー関数単体の実装のみ。
--   start_session等の実際のゲートウェイRPC関数（タスク3.x/4.x）は
--   本マイグレーションの対象外。それらは将来、各関数冒頭で
--   `perform assert_device_role(array['kitchen','register']);` のように
--   本関数を呼び出す想定。
--
-- 設計判断1（SECURITY DEFINERにしない理由・実機検証済み）:
--   auth.jwt()はauth.usersを直接参照するテーブル関数ではなく、
--   current_setting('request.jwt.claims', true)というセッションローカルの
--   GUC（PostgRESTがリクエストごとに設定する）を読むだけのSTABLE SQL関数
--   （pg_get_functiondef(auth.jwt())で確認済み: `select coalesce(
--   nullif(current_setting('request.jwt.claim', true), ''),
--   nullif(current_setting('request.jwt.claims', true), ''))::jsonb`）。
--   GUCの値はロール切り替え（SECURITY DEFINER）の影響を受けないため、
--   呼び出し元関数がSECURITY DEFINERかどうかに関わらずauth.jwt()は
--   同一のclaimsを返すことを実機で確認済み（同一トランザクション内で
--   request.jwt.claims GUCを設定した上で、SECURITY INVOKER版/DEFINER版の
--   両方のラッパー関数からauth.jwt()を呼び出し、両者が完全に同一のjsonbを
--   返すことを確認した）。したがってassert_device_role自体を
--   SECURITY DEFINERにする必要はない。むしろSECURITY DEFINER化は、
--   呼び出し元の権限とは独立した実行権限を持たせることになり、単なる
--   検証専用ヘルパーには不要な複雑さと、タスク2.1のレビューで顕在化した
--   search_path起因の権限問題の再発リスクを持ち込むだけなので、意図的に
--   SECURITY INVOKER（デフォルト、指定なし）のままとする。auth.jwt()は
--   authスキーマを明示的に修飾して呼び出すため、呼び出し元の search_path
--   設定にも依存しない。
--
-- 設計判断2（PostgRESTからの直接RPC呼び出し可能性・実機検証済み）:
--   Postgresはpublicスキーマに新規作成した関数のEXECUTE権限を、デフォルトで
--   PUBLIC（=postgres/anon/authenticated/service_role等すべてのロールに
--   継承される）へ自動付与する（実機確認済み: 検証用の関数を作成し
--   information_schema.routine_privilegesを確認したところ、PUBLIC/anon/
--   authenticated/service_roleへのEXECUTEが自動的に付与されていた）。
--   これはテーブルに対する暗黙のデフォルト権限（0002がREVOKEで対処した対象）
--   とは別の仕組みであり、0002のテーブル向けREVOKEの対象外だった。
--   そのため対策しない限り、assert_device_roleもPostgREST経由で
--   `/rest/v1/rpc/assert_device_role`として匿名/認証済みクライアントから
--   直接呼び出し可能なエンドポイントとして露出してしまう。
--   実害の評価: 直接呼び出されたとしても、本関数は呼び出し元自身のJWTの
--   device_role claimを検証して「成功（void を返す）」か「例外を送出する」かの
--   いずれかを返すだけであり、他者のデータの読み書きも権限昇格も発生しない
--   （自分自身のJWTの中身に基づく判定を自分で呼べるだけであり、実害はない）。
--   とはいえ、本ヘルパーは各RPC関数の内部実装詳細であり、
--   StaffOperationsGatewayの公開契約（design.mdのService Interface）には
--   含まれない。公開APIサーフェスを必要最小限に保つという0002/0005で
--   確立した方針（「未使用・非公開の経路は明示的に塞ぐ」）に合わせ、
--   念のためanon/authenticatedからのEXECUTEを明示的に剥奪する。
create or replace function public.assert_device_role(allowed_roles text[])
returns void
language plpgsql
stable
as $$
declare
  current_device_role text;
begin
  current_device_role := auth.jwt() ->> 'device_role';

  if current_device_role is null or not (current_device_role = any (allowed_roles)) then
    -- カスタムSQLSTATE 'P0403' を使用する。
    -- SQLSTATEクラス'P0'は「PL/pgSQL Error」としてPostgreSQL本体がPL/pgSQLの
    -- ユーザー定義コード向けに予約している領域（組み込みでは'P0001'
    -- raise_exception / 'P0002' no_data_found / 'P0003' too_many_rows /
    -- 'P0004' assert_failure が既に使用済み）。そのサブクラスとして未使用の
    -- '403'（HTTPのForbiddenを想起させる数字）を割り当てることで、
    -- Postgres本体や拡張機能が発行する既存のSQLSTATEと衝突せず、かつ
    -- 呼び出し側（本タスクの結合テスト、将来の各RPC関数、PostgREST経由の
    -- クライアントが受け取るerror.code）が機械的に「FORBIDDEN相当の拒否」と
    -- 判定できるようにする。人間可読なメッセージ文字列のパターンマッチには
    -- 依存しない。
    raise exception 'device_role claim is missing or not permitted for this operation'
      using errcode = 'P0403';
  end if;
end;
$$;

comment on function public.assert_device_role(text[]) is
  '呼び出し元JWTのdevice_role claim（auth.jwt()経由）がallowed_rolesのいずれかで
   あることを検証するヘルパー。各StaffOperationsGateway RPC関数の冒頭で
   `perform assert_device_role(array[''kitchen'',''register'']);` のように呼び出す想定。
   claimが欠落しているか許可リストにない場合はカスタムSQLSTATE ''P0403''
   （FORBIDDEN相当、Postgres本体のエラーコードと衝突しない）で例外を送出する。
   auth.jwt()はセッションローカルのGUC（request.jwt.claims）を読むだけの
   STABLE関数であり、呼び出し元がSECURITY DEFINERかINVOKERかによらず同一の
   claimsを返すことを実機検証済みのため、本関数自体はSECURITY DEFINERにしない
   （意図的な選択。詳細はマイグレーションファイル冒頭のコメントを参照）。';

-- =========================================================
-- anon/authenticatedからのEXECUTEを明示的に剥奪する
-- （実害はないと評価済みだが、公開APIサーフェスを最小限に保つため。
--   0005のcustom_access_token_hookと同じ「未使用の経路を塞ぐ」パターン）
-- =========================================================
revoke execute on function public.assert_device_role(text[]) from authenticated, anon, public;
