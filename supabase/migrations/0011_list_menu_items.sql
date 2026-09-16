-- 0011_list_menu_items.sql
-- table-order-kitchen: list_menu_items RPC（新規追加）
--
-- Requirements: 7.1, 7.3, 7.4
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "StaffOperationsGateway" コンポーネント（Service Interface）、
--   "KitchenBoard" コンポーネント要約（「売り切れの登録・解除操作は実行前に
--   確認ダイアログを表示し、確認後にのみsetSoldOutを呼び出す」）を参照。
--
-- =========================================================================
-- 背景（タスク7.4で判明したギャップ。CONCERN。レビューでのdesign.md確認を
--   要する）: StaffOperationsGatewayに「厨房が売り切れボードへ表示する
--   全メニュー品目一覧を取得する」RPCが存在しない
-- =========================================================================
-- タスク7.4（売り切れボード: 検索・確認モーダル）着手時に判明したギャップ。
-- design.mdのStaffOperationsGateway Service Interfaceを全文確認したが、
-- `setSoldOut(input: SetSoldOutInput)`は既に`menuItemId`を知っている前提の
-- 「特定の1品目の状態を切り替える」操作であり、「厨房スタッフがどの品目を
-- 対象に切り替え操作をするかを選ぶための一覧」を返すメソッドが
-- StaffOperationsGateway/CustomerOrderingGatewayのいずれにも存在しない。
--
-- 検討した代替案:
--   (a) CustomerOrderingGateway.get_ordering_context（anon専用、0003/0009/0010）
--       を厨房画面からも呼び出す。0002_rls_policies.sqlの通りget_ordering_context
--       はanonロールにのみEXECUTE権限を付与しており、authenticated（kitchen/
--       register）ロールのJWTを持つクライアントから呼び出した場合、Postgres
--       自体のGRANT/REVOKE機構によりPostgRESTの権限エラー（PGRST/42501相当）で
--       拒否される（authenticatedへのEXECUTE権限がそもそも存在しないため、
--       assert_device_role以前の問題であり実行不可能）。加えて、意味的にも
--       「客が卓QRを読んだ際に見るメニュー」と「厨房が売り切れ管理のために
--       見る全品目一覧」を同一の関数に混在させると、将来customerOrderingGateway
--       側にのみ必要な変更（例: 卓固有の表示制御）が厨房側の関心事に漏れ出す
--       リスクがある。不採用。
--   (b)（本マイグレーションが採用）StaffOperationsGatewayに新規RPC
--       `list_menu_items`を追加する。厨房専用の書き込み経路である
--       StaffOperationsGatewayと対になる、厨房専用の閲覧経路として
--       list_kitchen_feed（4.5）と同じ設計（device_role検証・
--       store_idスコープ・jsonb配列応答）に倣う。
--
-- 新規マイグレーションファイルとして追加する理由（0004へ直接追記しない）:
--   0009_ordering_context_menu_genre.sql/0010_ordering_context_call_request.sql
--   はいずれも「既存関数get_ordering_contextへの追加的（additive）な
--   フィールド拡張」であり、`create or replace function`で既存の関数
--   シグネチャ・関数名を保ったまま本体のみを差し替える形を取っている。
--   これに対し本タスクが必要とするのは「既存のいかなる関数の追加的拡張でも
--   説明できない、全く新しい関数（list_menu_items）」であり、0009/0010が
--   確立した「既存関数の追加的拡張は新しい番号のマイグレーションファイルで
--   create or replace function する」という前例よりもさらに単純なケース
--   （新規関数の追加）である。0004_rpc_staff_gateway.sqlを直接編集しない
--   理由も同じ前例に基づく: 0004は4.1〜4.5であらかじめ計画された関数群を
--   一度に実装したファイルであり、4.6完了時点で「このタスク群のスコープの
--   関数を列挙し終えた」ファイルとして扱われてきた（0004ファイル冒頭の
--   スコープコメント参照）。7.4というその後のタスクで判明した新規ニーズを
--   0004へ書き戻すと、0004を読んだ将来の実装者が「4.1〜4.6のどのタスクで
--   list_menu_itemsが追加されたのか」をコメントの通し番号から追えなくなる
--   （0009/0010が0003を直接編集しなかったのと同じ理由）。
--
-- 役割の絞り込み: kitchen限定（registerは含めない）
--   本RPCの用途は現時点では「厨房の売り切れボード（7.4）が表示対象の品目を
--   選ぶための一覧」のみであり、design.md Components and Interfaces表の
--   KitchenBoard (UI) Req Coverage（6.1-6.10, 7.1, 7.3-7.4）にのみ関連する。
--   RegisterConsole (UI)（8.3「品目の追加・削除UI」で将来的に「レジが
--   追加する品目を選ぶための一覧」を必要とする可能性はあるが、要件文書
--   ・design.mdのいずれにも現時点でその一覧取得手段は明記されておらず、
--   8.3自体もまだ未着手（tasks.md確認済み）。set_sold_out（設計判断14。
--   要件7がいずれも「厨房スタッフ」を主語とすることに基づきkitchen限定と
--   判断した前例）と全く同じ理由づけにより、本RPCも要件7の文脈（厨房の
--   売り切れ管理）に閉じたkitchen限定として実装する。registerが将来
--   同種の一覧を必要とした場合、8.3の実装者がその時点の要件・design.mdの
--   記述に基づき「list_menu_itemsをregisterにも開放する」か「別の専用
--   一覧を設計する」かを判断すべきであり、本タスクの時点で投機的に
--   register向けアクセスを追加することはYAGNI/Simplification原則に反する
--   ため行わない。
--
-- 戻り値の形状: design.mdのMenuItem型（{id, storeId, name, price, soldOut}、
--   setSoldOutの戻り値として既に定義済み）をそのまま流用せず、一覧表示に
--   必要な最小限のキー（id/name/price/soldOut/genre）のみを持つ新しい
--   キー構成で返す。storeIdは呼び出し時の入力（p_store_id）と同一値になり
--   各要素へ繰り返し含める意味がないため省略する（Simplification原則）。
--   genreは既存のMenuItem型には無いフィールドだが、mock-preview.html
--   （soldoutPanelHtml関数）の検証済みUXがジャンル別に品目をグルーピング
--   表示することに対応できるよう含める（本タスクのSoldOutBoard.tsx自体は
--   ジャンル別グルーピングまでは実装しないが、フィールド自体をRPCから
--   除外する理由もないため含めておく）。
--
-- エラー面: design.mdのlistKitchenFeed/listRegisterFeedと同じ`never`型
--   （0004設計判断25）を踏襲する。本RPCは特定のエンティティを対象とする
--   書き込みRPCではなく、store_idスコープの純粋な一覧取得であり、
--   ITEM_NOT_FOUND等のドキュメント化すべき業務エラーが存在しない
--   （store_idに一致する品目が0件でも、単に空配列を返せば十分——
--   list_kitchen_feed/list_register_feedと同じ判断）。assert_device_roleが
--   送出するFORBIDDENを含むあらゆるエラーは、TypeScriptラッパー
--   （staffOperationsGateway.ts）が例外として伝播させる。
--
-- 権限（SECURITY DEFINER + search_path=''）: menu_itemsはauthenticatedへの
-- 直接SELECT権限を持たない（0002_rls_policies.sqlでロックダウン済み。
-- anonのみSELECT許可）ため、他のStaffOperationsGateway RPCと同じ
-- SECURITY DEFINERが必須。search_pathなりすまし対策として
-- `set search_path = ''`を設定し、本文内の全参照
-- （public.menu_items, public.assert_device_role）をスキーマ修飾する。
-- 書き込みを一切行わない閲覧専用RPCのため`stable`を付与する。EXECUTE権限は
-- authenticatedにのみ付与し、anonには一切付与しない（0004の全
-- StaffOperationsGateway RPCと同一のGRANT/REVOKEパターン。実際のkitchen/
-- register限定はauthenticated内部でassert_device_roleが行う）。

create or replace function public.list_menu_items(
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
  -- 1. device_role検証（kitchen限定、上記コメント参照）を必ず先頭で行う。
  perform public.assert_device_role(array['kitchen']);

  -- 2. 対象店舗の全menu_itemsを、名前順（検索UIでの一覧安定表示のため）で
  --    抽出する。store_idに一致する品目が0件でも空配列を返す
  --    （list_kitchen_feed/list_register_feedと同じ判断、上記コメント参照）。
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', mi.id,
        'name', mi.name,
        'price', mi.price,
        'soldOut', mi.sold_out,
        'genre', mi.genre
      )
      order by mi.name, mi.id
    ),
    '[]'::jsonb
  )
  into v_result
  from public.menu_items mi
  where mi.store_id = p_store_id;

  return v_result;
end;
$$;

comment on function public.list_menu_items(uuid) is
  '厨房（authenticated, device_role=''kitchen''。ファイル冒頭コメント
   「役割の絞り込み」参照）が売り切れボード（要件7.1, 7.3-7.4、KitchenBoard
   UIのSoldOutBoard.tsx、タスク7.4で新規追加）へ表示する対象品目を選ぶために
   呼び出すStaffOperationsGatewayの閲覧系RPC。冒頭でassert_device_role(
   array[''kitchen''])を検証する（それ以外のdevice_role・claim欠如は
   カスタムSQLSTATE ''P0403''、assert_device_role自身が送出。design.mdの
   `never`エラー型に対応する解釈は0004設計判断25と同じ）。対象店舗
   （store_idスコープ）の全menu_itemsを、id/name/price/soldOut/genreの
   キー構成のjsonb配列として名前順に返す。売り切れ品目も除外せず含める
   （売り切れボードは現在売り切れ中の品目も一覧・解除操作の対象とする
   必要があるため）。SECURITY DEFINER + search_path=''''は、authenticated
   ロールがmenu_itemsへの直接SELECT権限を持たない（0002でロックダウン済み。
   anonのみSELECT許可）状態でも本関数がそれを読み取れるようにするための
   構成であり、他のStaffOperationsGateway RPCと同じsearch_pathなりすまし
   対策を踏襲する。';

revoke execute on function public.list_menu_items(uuid)
  from public, anon, authenticated;

grant execute on function public.list_menu_items(uuid) to authenticated;
