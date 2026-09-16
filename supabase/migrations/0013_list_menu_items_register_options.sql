-- 0013_list_menu_items_register_options.sql
-- table-order-kitchen: list_menu_itemsをregisterロールへも開放し、
-- imageUrl/optionsを追加する
--
-- Requirements: 5.5
-- Design: .kiro/specs/table-order-kitchen/design.md の
--   "StaffOperationsGateway" コンポーネント（Service Interface:
--   listMenuItems, MenuItemListing）を参照。本タスク（8.3）で改訂した
--   型定義に合わせて本マイグレーションを適用する。
--
-- =========================================================================
-- 背景: 0011_list_menu_items.sql冒頭コメントが明示的に本タスクへ委ねていた判断
-- =========================================================================
-- `list_menu_items`（タスク7.4で新規追加）は当初、厨房の売り切れボード
-- （SoldOutBoard.tsx）専用としてkitchenロール限定で実装された。その冒頭
-- コメント「役割の絞り込み: kitchen限定（registerは含めない）」は、
-- 「RegisterConsole（8.3「品目の追加・削除UI」）で将来的に『レジが追加する
-- 品目を選ぶための一覧』を必要とする可能性はあるが...8.3の実装者がその時点の
-- 要件・design.mdの記述に基づき『list_menu_itemsをregisterにも開放する』か
-- 『別の専用一覧を設計する』かを判断すべき」と明記し、この判断を本タスクへ
-- 委ねていた。
--
-- =========================================================================
-- 判断: 別RPCを新設せず、list_menu_itemsをregisterロールへ開放し、
--   options/imageUrlを追加する
-- =========================================================================
-- 検討した代替案:
--   (a)（本マイグレーションが採用）既存のlist_menu_itemsの
--       assert_device_role対象を['kitchen']から['kitchen','register']へ
--       拡大し、応答にimageUrl/optionsを追加する。
--   (b) レジ専用の別RPC（例: list_addable_menu_items）を新規に設計する。
--
-- (a)を採用した理由:
--   - list_kitchen_feed/list_register_feedのような「読者ごとに表示内容・
--     並び順が大きく異なる」閲覧系RPCとは異なり、list_menu_itemsが返す
--     情報（店舗の全menu_items、id/name/price/soldOut/genre）は「レジが
--     追加対象を選ぶ」ユースケースにもそのまま必要であり、読者（kitchen/
--     register）によって内容を変える理由がない（唯一の違いは、レジは
--     追加操作のためにoptions（オプション選択肢）とimageUrl（写真表示、
--     mock-preview.htmlのadd-item行自体は写真を表示しないが、既存の
--     MenuItemView型・OptionSelectionPanel.tsxとの構造的互換のため
--     一貫して含める、下記参照）も必要とする点のみ）。
--   - (b)は「全menu_itemsを店舗スコープで返す」という同一のクエリロジックを
--     複製することになり、Simplification原則（同一の関心事に同一の実装を
--     用いる）に反する。
--   - 0011冒頭コメントが検討し却下した代替案(a)「CustomerOrderingGateway.
--     get_ordering_contextをauthenticatedから呼ぶ」は、anon専用の
--     EXECUTE権限構成上そもそも実行不可能である点は変わらず、本判断には
--     影響しない。
--
-- =========================================================================
-- options/imageUrlを追加する理由（OptionSelectionPanel.tsxの直接再利用）
-- =========================================================================
-- タスク8.3のUI設計判断として、客側の`OptionSelectionPanel.tsx`
-- （タスク6.1、`{item: MenuItemView, onCancel, onConfirm}`という
-- 純粋なプレゼンテーション props のみを取るゲートウェイ非依存コンポーネント）
-- を、レジの品目追加フロー（オプション選択）にそのまま再利用することにした
-- （216行の非自明な choice/toggle/counter UI ロジックを複製せず、
-- 実装詳細はsrc/app/register/TableDetailPanel.tsx冒頭コメント参照）。
-- 直接再利用するには、レジ側の品目一覧（MenuItemListing）が
-- `MenuItemView`（{id, name, price, soldOut, imageUrl, genre, options}）と
-- 構造的に一致している必要があるため、既存のid/name/price/soldOut/genreに
-- 加えてimageUrl（menu_items.image_url）とoptions（menu_items.options）を
-- 追加する。厨房の売り切れボード（SoldOutBoard.tsx）はこれらの新フィールドを
-- 一切参照しないため、追加しても既存の挙動に影響しない
-- （TypeScript側もReadonlyArray<MenuItemListing>への追加的フィールドで
-- あり、既存の分割代入・スプレッドのみを行うコードは影響を受けない）。
--
-- =========================================================================
-- 権限モデルの再確認（タスク文書の指示: 「確認すること、前提としないこと」）
-- =========================================================================
-- 0004/0011の全StaffOperationsGateway RPCが踏襲する既存パターン
-- （`revoke ... from public, anon, authenticated;` の直後に
-- `grant execute ... to authenticated;` で広く許可し、実際のkitchen/register
-- の絞り込みは関数内の`assert_device_role`が担う）は、本ファイルでも
-- そのまま成立する。外側のGRANT/REVOKE（PostgreSQLレベルの権限）は
-- 「authenticatedかどうか」という粗い境界のみを表現し、「kitchenか
-- registerか」というきめ細かい境界は関数本体のassert_device_role呼び出しの
-- 引数配列を変更するだけで完結する（GRANT/REVOKE文自体への変更は不要）。
-- 実際に本ファイルのgrant/revoke文はto/from authenticatedのまま一切
-- 変更していない。
--
-- 0009/0010/0011が確立した規約（既存の適用済みマイグレーションは編集せず、
-- `create or replace function`で関数本体のみを差し替える新しい番号の
-- ファイルを追加する）をそのまま踏襲し、0011_list_menu_items.sqlは編集しない。

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
  -- 1. device_role検証。タスク8.3でkitchenに加えregisterも許可するよう
  --    拡大した（本ファイル冒頭コメント「背景」「判断」参照）。
  perform public.assert_device_role(array['kitchen', 'register']);

  -- 2. 対象店舗の全menu_itemsを、名前順（検索UIでの一覧安定表示のため）で
  --    抽出する。store_idに一致する品目が0件でも空配列を返す
  --    （list_kitchen_feed/list_register_feedと同じ判断）。
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', mi.id,
        'name', mi.name,
        'price', mi.price,
        'soldOut', mi.sold_out,
        'genre', mi.genre,
        -- タスク8.3で追加: レジの品目追加フローがOptionSelectionPanel.tsx
        -- （客側から直接再利用、本ファイル冒頭コメント参照）を使うために
        -- 必要。
        'imageUrl', mi.image_url,
        'options', coalesce(mi.options, '[]'::jsonb)
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
  '厨房（authenticated, device_role=''kitchen''）の売り切れボード（要件7.1,
   7.3-7.4）と、レジ（authenticated, device_role=''register''。タスク8.3で
   追加、要件5.5）の品目追加フローの両方が、対象品目を選ぶために呼び出す
   StaffOperationsGatewayの閲覧系RPC。冒頭でassert_device_role(array
   [''kitchen'', ''register''])を検証する（それ以外のdevice_role・claim
   欠如はカスタムSQLSTATE ''P0403''、assert_device_role自身が送出。
   design.mdの`never`エラー型に対応する解釈は0004設計判断25と同じ）。
   対象店舗（store_idスコープ）の全menu_itemsを、id/name/price/soldOut/
   genre/imageUrl/optionsのキー構成のjsonb配列として名前順に返す
   （imageUrl/optionsはタスク8.3で追加。レジの品目追加フローが客側の
   OptionSelectionPanel.tsxをそのまま再利用するための構造的互換性
   （MenuItemViewと同じキー構成）を満たすために必要。本ファイル冒頭コメント
   参照）。売り切れ品目も除外せず含める（売り切れボードは現在売り切れ中の
   品目も一覧・解除操作の対象とする必要があり、レジの追加フローも
   ソールドアウト表示に必要とする）。SECURITY DEFINER + search_path=''''は、
   authenticatedロールがmenu_itemsへの直接SELECT権限を持たない
   （0002でロックダウン済み。anonのみSELECT許可）状態でも本関数がそれを
   読み取れるようにするための構成であり、他のStaffOperationsGateway RPCと
   同じsearch_pathなりすまし対策を踏襲する。';

revoke execute on function public.list_menu_items(uuid)
  from public, anon, authenticated;

grant execute on function public.list_menu_items(uuid) to authenticated;
