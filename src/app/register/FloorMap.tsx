"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  useRealtimeFeed,
  type RealtimeFeedSubscription,
} from "@/lib/realtime/useRealtimeFeed";
import {
  createStaffOperationsGateway,
  type MenuItemListing,
  type TableBillingSummary,
} from "@/lib/gateways/staffOperationsGateway";
import type { OrderItemSummary } from "@/lib/gateways/customerOrderingGateway";
import { useCheckIn } from "./useCheckIn";
import { useAddOrderItem } from "./useAddOrderItem";
import { useRemoveOrderItem } from "./useRemoveOrderItem";
import { useUpdateOrderItemStatus } from "./useUpdateOrderItemStatus";
import { useCloseSession } from "./useCloseSession";
import { useResolveCallRequest } from "./useResolveCallRequest";
import { useUpdatePartySize } from "./useUpdatePartySize";
import TableDetailPanel from "./TableDetailPanel";
import CallBannerStack from "./CallBannerStack";

/**
 * 卓マップ（design.md「RegisterConsole」の卓マップ表示部分）。
 * RegisterConsoleScreen（タスク8.1）が"ready"状態でマウントする。
 *
 * Requirements: 2.2, 5.4
 * Design: .kiro/specs/table-order-kitchen/design.md「RegisterConsole」
 *   （「全卓を「テーブル」「カウンター」のエリアに分けたマップ表示とし、
 *   各卓のタイルに人数・経過時間・合計金額・呼び出し中バッジを表示する」）、
 *   StaffOperationsGateway.listRegisterFeed のService Interface
 *   （`TableBillingSummary`: tableId/tableLabel/activeSession/items/total/
 *   hasOpenCallRequest）。
 * Mock: mock-preview.html の`floorSectionHtml`/`renderRegister`
 *   （`/^T/`→テーブル区分・`/^C/`→カウンター区分、`elapsedMin(ts) =
 *   Math.max(0, Math.floor((Date.now() - ts) / 60000))`という経過分数の
 *   算出式、呼出バッジ・空席/来店中タイルのレイアウト）を参照する。
 *
 * ## 本タスク（8.1）のスコープ（display-onlyの境界）
 * 8.1は「卓マップ表示」のみを担う（タイルは情報表示専用で、クリック
 * ハンドラ・詳細パネル・入店/会計/呼び出し対応等のいずれの書き込み操作も
 * 実装しない）。タイル選択で開く卓詳細パネルと入店操作（人数入力）は8.2の
 * スコープであり、8.2が本コンポーネントへクリックハンドラを追加する際に
 * 迷わず拡張できるよう、タイルは意図的に`<button>`ではなく非対話的な
 * `<div>`として実装する（KitchenBoardのFoodBoard.tsx、7.2時点でステータス
 * 更新ボタンを一切持たなかったのと同じ「段階的な充実」パターン）。
 *
 * ## エリア分けについて（design decision A）
 * `tables`テーブルには専用のエリア/ゾーン列が存在しない
 * （`0001_schema.sql`の`create table tables`は`id`/`store_id`/`label`の
 * みを持つ）。テーブル/カウンターの区分はスキーマで保証されたものではなく、
 * `tableLabel`の接頭辞（`/^T/`→テーブル、`/^C/`→カウンター）から導出する
 * 純粋なクライアント側の慣習であり、mock-preview.htmlの`renderRegister`と
 * `supabase/seed.sql`の実際の開発用ラベル（T1/T2/C1/C2）に一致させる。
 * どちらの接頭辞にも一致しないラベル（スキーマ上は許容されうる）が来ても
 * クラッシュしないよう、本コンポーネントは3つ目の「その他」区分を設け、
 * 該当する卓が1件も無い場合はその区分自体を描画しない（実際の開発データが
 * T/C以外のラベルを持たない前提のもとで、通常運用時に空の区分が常に
 * 表示され続ける違和感を避けるため）。
 *
 * ## 合計金額について（design decision B、confirmedTotalとの関係）
 * `TableBillingSummary.total`はサーバー側（`list_register_feed`）が
 * 確定させた合計であり、design.mdの通り`CustomerOrderingGateway.
 * getOrderingContext`が返す`confirmedTotal`と同一ロジックを共有する。
 * 本コンポーネントは`items`から金額を再計算せず、`total`をそのまま表示する
 * （クライアント側での再計算は、サーバー側ロジックとの将来的な乖離
 * リスクを生むため意図的に避ける）。
 *
 * ## 金額フォーマットについて
 * `src/app/order/[tableId]/formatYen.ts`は`CustomerOrderApp`境界の
 * ファイルであり、design.mdのBoundary Context上`RegisterConsole`は別の
 * 境界として扱われる。SoldOutBoard.tsx（KitchenBoard境界）が同じ理由で
 * `formatYen`を独自に複製した前例（`formatPrice`）を踏襲し、本ファイルも
 * 同じ表記（`'¥' + n.toLocaleString('ja-JP')`）をローカルに複製する
 * （境界をまたぐ物理的なimportを避ける）。
 *
 * ## 更新方式についての設計判断（マウント時フェッチ + 簡易ポーリング）
 * design.mdのRealtimeFeed（`useRealtimeFeed`、タスク5で実装済み）を
 * RegisterConsoleへ配線するのはタスク9.2の明示的なスコープ
 * （「3画面へのRealtimeFeed接続と再接続時再取得の統合確認」、8.1-8.7全体が
 * 完成した後の横断タスク）であり、本タスクの完了条件（エリア分け・
 * タイルの表示内容・呼び出しバッジの表示/消去）はいずれも「表示の正しさ」を
 * 要求するのみで、Realtimeによる即時反映自体は要求しない。
 *
 * 一方、レジ画面という製品の性質上、9.2が着手されるまでの間、一度きりの
 * 取得のみで新規注文・呼び出し・人数変更が一切反映されない画面のまま放置
 * するのは実運用上望ましくない中間状態である。そのため、FoodBoard.tsx
 * （タスク7.2）・DrinkBoard.tsx（7.3）が確立した「`useRealtimeFeed`の
 * 本格導入前は定期ポーリングで代替する」という前例をそのまま踏襲し、
 * `REGISTER_FLOOR_MAP_POLL_INTERVAL_MS`（5000ms、FOOD_BOARD_POLL_INTERVAL_MS
 * と同じ値）間隔の単純なポーリングを暫定的な更新手段として追加する
 * （新規のRealtime購読・新規の接続断UIは一切追加しない）。9.2が
 * `useRealtimeFeed`を配線した際は、このポーリングは（KitchenBoardの
 * 7.6が選んだ判断と同様に）置き換えではなく補完される想定
 * ——見落としに対する低コストな二重の安全網として残すか、9.2着手時に
 * 再検討する。→ 9.2で実際に「補完」を選択した（下記「タスク9.2での更新」
 * 参照）。ポーリング自体（間隔・実装）は本節時点から変更していない。
 *
 * ## タスク9.2での更新: useRealtimeFeedの配線（RegisterConsole）
 * design.mdのRealtimeFeed Event Contract（「RegisterConsoleはorder_items/
 * table_sessions/call_requestsの変更を購読する」）を実装する。tasks.mdの
 * 9.2タスク文書自身の依存関係（`_Depends: 6.2, 7.5, 8.2_`、9.1やタスク5
 * 以後の知見を含まない）が示す通り、この文言はタスク5（0008マイグレーション
 * の`anon`除外判断の確定）より前に起草されたものであり、
 * `CustomerOrderApp`/`MenuScreen.tsx`への配線は意図的に対象外とする
 * （タスク6.2で確定済み・0008マイグレーション「anonへのSELECT付与を
 * 見送った理由」で独立に再評価・却下済みのセキュリティ判断を、本タスクで
 * 覆さない。詳細は本ファイル冒頭「更新方式についての設計判断」、
 * および0008マイグレーション・design.mdのEvent Contractを参照）。
 * 本タスクの実際のスコープは「KitchenBoard（7.6で完了済み・本タスクでは
 * 一切変更しない）に対しRegisterConsoleを追いつかせる」ことに限られる。
 *
 * ### 配線場所について（FloorMap.tsx、RegisterConsoleScreen.tsxではない）
 * KitchenBoardScreen.tsx（7.6）は「フード/ドリンク/売り切れの3タブが
 * それぞれ独自に`useRealtimeFeed`を持つと、タブ切り替えでの子ボードの
 * アンマウントのたびに接続状態インジケーターが消える」という理由で、
 * 画面レベル（KitchenBoardScreen）へ`useRealtimeFeed`を巻き上げ、
 * `resyncSignal`propで子ボードへ再同期シグナルを配った。RegisterConsoleは
 * この事情に該当しない——`RegisterConsoleScreen.tsx`はデバイスゲートのみの
 * 薄いラッパーであり、"ready"状態になった後は本コンポーネント
 * （`FloorMap.tsx`）がアンマウントされることなく卓マップ・詳細パネルの
 * 両方を自己完結して描画し続ける（8.1 Implementation Notes「8.1で確立」
 * 参照）。よって画面レベルへ巻き上げる理由付け自体が存在せず、
 * `useRealtimeFeed`は本コンポーネントに直接配線する（RegisterConsoleScreen
 * 側の変更は一切不要）。
 *
 * ### `onSync`の実装について（新しい再同期機構を作らない）
 * KitchenBoardの`onSync`は`resyncToken`という単調増加カウンタをFoodBoard/
 * DrinkBoardへpropとして渡す方式を採ったが、これは「画面（親）と実際に
 * フェッチする側（子ボード）が別コンポーネント」という構造上の理由による
 * 間接的な配線である。本コンポーネントは`state.tables`のフェッチ処理
 * （`load`関数、マウント時+5秒ポーリングのuseEffect内にローカルに存在する）
 * を自分自身で直接持っているため、`onSync`から`load(false)`を直接呼び出す
 * だけでよく、`resyncToken`のような中継用のstate・propは一切不要
 * （tasks.mdタスク文書が「do not build a parallel/different resync
 * mechanism, reuse the exact existing one」と指示する通り）。
 *
 * `load`自体は当初`useCallback`へ引き上げてuseRealtimeFeedのeffectから
 * 直接呼び出す設計を検討したが、`react-hooks/set-state-in-effect`
 * （eslint-plugin-react-hooksのESLint rule）が「useEffect本体から
 * `useCallback`で作った関数を直接呼び出す」形を、内部でいずれ`setState`へ
 * 到達する経路として静的に検出し、「effect内での同期的なsetState」の
 * 疑いとして誤検知した（`load`は`await`を挟むため実際には非同期であり、
 * このルールが問題視する「effect本体が同期的にsetStateする」パターンには
 * 該当しないが、ルールの静的解析はそこまで踏み込まない）。8.2-8.7が
 * 確立してきた「`load`はeffectのローカル関数のまま」という既存の形は
 * このルールに一切引っかからないため、`load`自体の定義場所・シグネチャは
 * 変更せず、その関数への参照だけを`loadRef`（ref）へ橋渡しし、
 * `onSync`（effect本体の外側にあるコールバック）側は`loadRef.current`
 * 経由で呼び出す設計にした。これにより、(a) マウント時初回フェッチ、
 * (b) 5秒間隔の背景ポーリング、(c) onSync起点の背景フェッチ、の3つの
 * 呼び出し元がすべて同一の`load`関数・同一の`mutationSeqRef`ガードを
 * 共有する（8.2-8.7で確立した「新しい局所的な再取得経路は既存の
 * mutationSeqRefガードをそのまま適用すること」という既存方針の、最も
 * 直接的な適用——新しいガードを増やすのではなく、既存のガード付き関数の
 * 呼び出し元を1つ増やすだけで済んだ）。
 *
 * ### 購読対象（3テーブルすべて）
 * `REGISTER_REALTIME_SUBSCRIPTIONS`は`order_items`/`table_sessions`/
 * `call_requests`の3テーブル（0008マイグレーションがregisterロールへ
 * SELECTを許可する全テーブル。KitchenBoardは`order_items`のみ——
 * table_sessions/call_requestsはregister限定のRLSのため購読しても
 * 配信されない）。`event`・`filter`はいずれも指定しない（絞り込みなし。
 * `list_register_feed`は店舗全体の卓を返すため、絞り込む理由が無い）。
 *
 * ### 接続状態UIを追加しない（design decision、KitchenBoardの7.6と対称的な判断）
 * KitchenBoardScreen.tsx（7.6）は要件6.9（「サーバーとの接続が切断される、
 * 接続が切断された旨を画面に表示し、再接続後に最新の品目一覧へ同期する」）
 * という明示的な受入基準に基づき、接続状態インジケーター・disconnected
 * バナー・reconnectedバナーの3点を実装した。要件5（RegisterConsoleの
 * 要件群）には同等の受入基準が存在しない（5.3「表示中の注文明細と合計
 * 金額を更新する」は更新そのものを求めるのみで、接続状態の可視化までは
 * 求めない）。加えて、本specがこれまで一貫して検証済みUXリファレンスとして
 * 扱ってきたmock-preview.htmlの`renderRegister`関数には、`renderKitchen`
 * 関数が持つ`conn-dot`（接続状態インジケーター）に相当する要素がそもそも
 * 存在しない（`grep`で確認済み）。以上3点（要件不在・検証済みUXリファレンス
 * 不在・本タスクの観測可能な完了条件がタイミングのみを問う）から、
 * RegisterConsoleには接続状態UIを追加しないと判断した。5秒ポーリングという
 * 既存の安全網（7.6と同じ理由——`status === "connected"`はwebsocketの
 * 生存確認に過ぎず、あらゆる見逃しイベントへの形式的な保証ではないため、
 * 二重の安全網として維持する）は変更せずそのまま残す。将来
 * RegisterConsole固有の接続状態表示が必要になった場合は、新しい要件として
 * 起票した上で改めて設計すること（要件が無いまま実装を先回りしない）。
 *
 * ## タスク8.2での更新: 卓詳細パネルと入店操作（人数入力）
 * 8.1時点の本コメント「mutationSeqRefを導入しない理由」が予告していた通り、
 * 8.2は本コンポーネントへローカル即時マージ（入店操作＝`startSession`の
 * 成功応答マージ）を追加するため、tasks.md 7.6 Implementation Notesの
 * 設計判断（`mutationSeqRef`という単調増加カウンタで「背景フェッチ」と
 * 「ユーザー操作起点の即時ローカルマージ」の競合を判定する）を、設計時点から
 * 織り込んで導入する（`FoodBoard.tsx`/`DrinkBoard.tsx`と同型）。
 *
 * ### 起こりうる競合とその対策
 * 本コンポーネントは5秒間隔の背景ポーリング（`load(false)`）を持つ。
 * 入店操作（人数入力→「入店する」）による`startSession`呼び出しがポーリング
 * と競合するタイミング——ポーリングのfetchがin-flightの間に`startSession`が
 * 解決してローカル状態へマージされ、その後にポーリングの「チェックイン前の
 * 古いスナップショット（空席のまま）」が届く——では、対策が無いとポーリング
 * 側が丸ごと`setState`し、たった今マージした来店中の状態を空席へ巻き戻して
 * しまう。これは本タスクの観測可能な完了条件
 * 「入店操作で人数を入力し確定すると、卓マップのタイルにその人数が表示
 * される」が暗に要求する「その表示が一瞬で消えたりしない」という性質を
 * 破る重大なバグになる。対策は`mutationSeqRef`（`startSession`成功時の
 * マージのたびにインクリメント）と、`load()`内でフェッチ開始時点の値を
 * 記録し解決時に不一致なら結果を破棄する、という7.6の設計をそのまま
 * 再利用する（回帰テストはFloorMap.test.tsxの「check-in成功より前に
 * 開始した背景ポーリングが...」を参照）。
 *
 * ### `startSession`応答からのローカル状態合成について（design decision A）
 * `startSession`が返す`TableSession`（`{id, tableId, status, startedAt,
 * closedAt, partySize}`）は`TableBillingSummary`（`items`/`total`/
 * `hasOpenCallRequest`を持つ）より情報が少ない。しかし「たった今新規発行
 * されたセッション」は定義上まだ注文（`items`）も呼び出し
 * （`hasOpenCallRequest`）も持ちえない（`start_session`は新しい
 * `table_sessions`行をINSERTするのみで、`order_items`/`call_requests`との
 * 関連は一切生成しない）ため、`items: []`・`total: 0`・
 * `hasOpenCallRequest: false`を安全に合成できる（`mergeStartedSession`
 * 参照）。次回の背景ポーリングが、その間に発生した実際の注文・呼び出しを
 * 自然に反映する。
 *
 * ### SESSION_ALREADY_ACTIVE（要件3.2）の扱いについて（design decision B）
 * 二重入店操作（複数レジ端末・誤操作の連打）で実際に起こりうるエラーで
 * あり、単なる防御的分岐ではない。既存セッションの実際の人数・注文内容を
 * 知らないため、それらを推測してローカル状態を占有中へ書き換えることは
 * せず（`useCheckIn.ts`が`mergeStartedSession`を呼び出さない）、次回の
 * 背景ポーリングが真のサーバー状態を自然に反映するのに任せる
 * （SoldOutBoard.tsx/useAdvanceOrderItemStatus.tsが確立した「ドキュメント化
 * された業務エラーはローカル状態を不変のまま次回ポーリングに委ねる」という
 * 既存方針をそのまま踏襲）。専用メッセージの文言・`TABLE_NOT_FOUND`/
 * `FORBIDDEN`の汎用フォールバックへの割り当ては`useCheckIn.ts`冒頭コメント
 * を参照。
 *
 * ### 確認モーダルを設けない理由（design decision C）
 * 要件3.1には3.3（会計操作）・3.5（人数変更）・5.5-5.7（品目追加/削除/
 * ステータス変更）に共通する「実行前に確認を求め」という文言が無い。
 * 人数入力ステッパー＋「入店する」ボタン自体が既に確定操作であるため、
 * 二重の確認ダイアログは追加しない（`TableDetailPanel.tsx`冒頭コメント
 * 参照）。
 *
 * ### パネルが常に最新の`state.tables`を参照する理由（design decision D、要件5.3）
 * `TableDetailPanel`へ渡す`table`は、`selectedTableId`をキーに
 * `state.tables`から都度`find`した値であり、選択時点のスナップショットを
 * 保持しない。既存の5秒背景ポーリングが`state.tables`を更新するたびに
 * 親（本コンポーネント）が再レンダリングされ、開いたままのパネルにも
 * 新しい注文・合計が新規のfetch呼び出しを伴わずに反映される
 * （要件5.3「選択中の卓に新たな注文が追加されたら表示中の明細・合計を
 * 更新する」を、新規のポーリング機構を増やさずに満たす）。
 *
 * ## タスク8.3での更新: 品目の追加・削除（確認モーダル）
 * 8.2が確立した「実際のRPC呼び出し・ローカル状態へのマージはFloorMap側
 * （フック）が担い、TableDetailPanel.tsxは確認モーダル等のUI状態のみを
 * 持つ純粋なプレゼンテーションに徹する」という役割分担を、`addOrderItem`/
 * `removeOrderItem`にもそのまま適用する（`useAddOrderItem`/
 * `useRemoveOrderItem`、`useCheckIn`と同型の小さな共有フック）。
 *
 * ### `mutationSeqRef`の適用（8.2と同型、7.6が確立した設計の再利用）
 * 品目追加成功時のローカルマージ（`mergeAddedItem`）・削除成功時のローカル
 * マージ（`mergeRemovedItem`）は、いずれも既存の5秒背景ポーリングと
 * 同一コンポーネント内で共存するため、8.2の`mergeStartedSession`と全く同じ
 * `mutationSeqRef`（インクリメント）＋`load()`内のフェッチ開始時点の値の
 * 記録・解決時の不一致検出、という競合防止をそのまま適用する（tasks.md
 * 8.2 Implementation Notesが「新しい局所的マージ経路はいずれも同じ競合に
 * さらされるため、必ず同じガードを適用すること」と予告していた通り）。
 * 回帰テストは`FloorMap.test.tsx`に「品目追加成功より前に開始した背景
 * ポーリングが...」「品目削除成功より前に開始した背景ポーリングが...」を
 * 追加した（8.2のcheck-in成功の回帰テストと同型）。
 *
 * ### 合計金額の再計算方法（design decision、tasks.mdの指示）
 * `list_register_feed`の`total`は`unit_price_snapshot*quantity`の単純合計
 * （statusによる絞り込みなし、0004設計判断23参照）であるため、ローカル
 * マージでも同じ式（`total + unitPrice*quantity`で加算、`total -
 * unitPrice*quantity`で減算）を用いる。次回の背景ポーリングがサーバー側の
 * 真の値で自然に上書きするため、クライアント側の再計算が将来サーバー側の
 * 計算式と乖離しても実害は次回ポーリングまでに限定される。
 *
 * ## タスク8.4での更新: 品目ステータス変更UI（確認モーダル）
 * 8.2/8.3が確立した「実際のRPC呼び出し・ローカル状態へのマージはFloorMap側
 * （フック）が担い、TableDetailPanel.tsxは確認モーダル等のUI状態のみを
 * 持つ純粋なプレゼンテーションに徹する」という役割分担を、
 * `updateOrderItemStatus`にもそのまま適用する（`useUpdateOrderItemStatus`、
 * `useAddOrderItem`/`useRemoveOrderItem`と同型の小さな共有フック。
 * `useUpdateOrderItemStatus.ts`冒頭コメント「`useAdvanceOrderItemStatus.ts`
 * を再利用しない理由」参照——KitchenBoard版は確認モーダル無し前提のため
 * 契約が異なる）。
 *
 * ### `mutationSeqRef`の適用（4つ目のローカルマージ経路、8.2/8.3と同型）
 * ステータス変更成功時のローカルマージ（`mergeUpdatedItemStatus`）も、
 * 既存の5秒背景ポーリング・check-in・品目追加・品目削除と同一コンポーネント
 * 内で共存するため、同じ`mutationSeqRef`（インクリメント）＋`load()`内の
 * フェッチ開始時点の値の記録・解決時の不一致検出という競合防止をそのまま
 * 適用する（tasks.md 7.6/8.2 Implementation Notesが「新しい局所的マージ
 * 経路はいずれも同じ競合にさらされるため、必ず同じガードを適用すること」と
 * 予告していた通り）。回帰テストは`FloorMap.test.tsx`に「ステータス変更
 * 成功より前に開始した背景ポーリングが...」を追加した（8.2/8.3の回帰
 * テストと同型）。
 *
 * ### 次ステータスの判定について
 * `resolveNextOrderItemStatus`（`src/lib/orderItemStatusTransitions.ts`、
 * KitchenBoardの`OrderItemStatusActions.tsx`と共有）を`TableDetailPanel.tsx`
 * 側で呼び出し、「進める」ボタンが送信する`status`を決定する
 * （design.mdのStaffOperationsGateway Responsibilities & Constraints
 * 「updateOrderItemStatus（レジ起点）」参照）。本ファイル（FloorMap.tsx）は
 * その決定済みの`status`を受け取って`updateOrderItemStatus`を呼ぶのみで、
 * 遷移判定ロジック自体は持たない。
 *
 * ### 品目一覧（`listMenuItems`）の取得方法
 * 品目追加リストは選択中の卓に依存しない店舗全体のデータのため、
 * `selectedTableId`とは独立した別のuseEffectでマウント時取得＋
 * `REGISTER_FLOOR_MAP_POLL_INTERVAL_MS`間隔のポーリングを行う
 * （FoodBoard.tsx/DrinkBoard.tsx/SoldOutBoard.tsxが確立した「本格的な
 * Realtime配線（9.2）までの間は定期ポーリングで代替する」という既存の
 * 前例をそのまま踏襲。新しいポーリング間隔定数は増やさず、卓マップと同じ
 * 間隔を再利用する）。品目一覧はローカルな楽観的更新の対象ではない
 * （追加・削除操作は`state.tables`側のみをマージし、`menuItems`側の
 * `soldOut`フラグ等は変更しない）ため、`mutationSeqRef`のような競合防止は
 * 不要（「背景フェッチが確定済みローカル状態を丸ごと置き換える」パターンと
 * 「ユーザー操作起点の即時ローカルマージ」パターンが同じ状態スロットで
 * 共存する場合にのみ必要な対策であり、`menuItems`はマージされないため
 * 該当しない）。
 *
 * ## タスク8.5での更新: 会計操作（確認モーダル・セッション終了）
 * 8.2/8.3/8.4が確立した役割分担（実際のRPC呼び出し・ローカル状態への
 * マージはFloorMap側のフックが担い、TableDetailPanel.tsxは確認モーダル等の
 * UI状態のみを持つ）を`closeSession`にもそのまま適用する
 * （`useCloseSession`、他の3フックと同型）。
 *
 * ### `mergeVacatedTable`が「空席化」と「パネルを閉じる」の両方を行う理由
 * 本タスクの観測可能な完了条件「会計確認後、卓詳細パネルが閉じて卓マップ
 * 画面が表示され、対象卓が空席状態になる」は、8.2/8.3/8.4のいずれとも異なり
 * 「パネルが閉じる」ことまでを要求する（8.2の`mergeStartedSession`・8.3の
 * `mergeAddedItem`/`mergeRemovedItem`・8.4の`mergeUpdatedItemStatus`は
 * いずれも成功後もパネルを開いたまま更新後の状態を表示した）。そのため
 * `mergeVacatedTable`は、`mergeStartedSession`の鏡像変換（占有中→空席、
 * `activeSession: null`・`items: []`・`total: 0`・
 * `hasOpenCallRequest: false`への合成）に加えて`setSelectedTableId(null)`を
 * 1箇所で併せて行う（`useCloseSession.ts`冒頭コメント参照）。
 *
 * ### `mutationSeqRef`の適用（5つ目のローカルマージ経路）
 * 会計成功時のローカルマージ（`mergeVacatedTable`）も、既存の5秒背景
 * ポーリング・check-in・品目追加・品目削除・ステータス変更と同一
 * コンポーネント内で共存するため、同じ`mutationSeqRef`（インクリメント）＋
 * `load()`内のフェッチ開始時点の値の記録・解決時の不一致検出という競合
 * 防止をそのまま適用する（7.6/8.2/8.3/8.4 Implementation Notesが「新しい
 * 局所的マージ経路はいずれも同じ競合にさらされるため、必ず同じガードを
 * 適用すること」と予告していた通り）。回帰テストは`FloorMap.test.tsx`に
 * 「会計成功より前に開始した背景ポーリングが...」を追加した（7.6/8.2/8.3/8.4
 * の回帰テストと同型）。
 *
 * ## タスク8.6での更新: 呼び出し対応UI（確認モーダル無し、要件2.4）
 * 8.2が実装した卓詳細パネルの呼び出し中バナーへ、本タスクで「対応済みに
 * する」ボタンを追加する（`TableDetailPanel.tsx`冒頭コメント参照）。
 * 8.1のタイルの呼出バッジ（`hasOpenCallRequest`）と8.2のパネルバナーは
 * いずれも同じ`state.tables`（本コンポーネントが保持する唯一の状態）を
 * 参照しているため、`mergeResolvedCallRequest`が`state.tables`を更新すれば
 * 両方が単一の変更で同時に消える——本タスクの観測可能な完了条件
 * 「呼び出し対応操作を行うと通知表示が消える」を、新しい同期機構なしに
 * 満たす（`FloorMap.test.tsx`で両方を独立にアサートする）。
 *
 * ### 確認モーダルを設けない（要件2.4に「実行前に確認を求め」の文言が無い）
 * 8.3〜8.5のレジ側書き込み操作はいずれも確認モーダルを経由したが、要件2.4
 * にはその文言が一切無い。`useResolveCallRequest.ts`冒頭コメント参照。
 *
 * ### `mergeResolvedCallRequest`がsessionIdで対象卓を探す理由
 * `resolveCallRequest`の成功応答（`CallRequest`）は`sessionId`を持つが
 * `tableId`を持たない。他の5つのマージ関数（`mergeStartedSession`等）は
 * いずれも呼び出し元から渡された`tableId`をそのままキーに`state.tables`を
 * 更新するが、本関数は応答が実際に運ぶ権威的な識別子（`sessionId`）と
 * `table.activeSession?.id`が一致する卓を探して更新する
 * （`useResolveCallRequest.ts`冒頭コメント「`mergeResolvedCallRequest`が
 * tableIdではなくsessionIdで対象卓を探す理由」参照。tasks.mdのタスク文書
 * 「design decisions D」が明示的に指示する設計判断）。
 *
 * ### `mutationSeqRef`の適用（6つ目のローカルマージ経路）
 * 呼び出し対応成功時のローカルマージ（`mergeResolvedCallRequest`）も、
 * 既存の5秒背景ポーリング・check-in・品目追加・品目削除・ステータス変更・
 * 会計と同一コンポーネント内で共存するため、同じ`mutationSeqRef`
 * （インクリメント）＋`load()`内のフェッチ開始時点の値の記録・解決時の
 * 不一致検出という競合防止をそのまま適用する（7.6/8.2/8.3/8.4/8.5
 * Implementation Notesが「新しい局所的マージ経路はいずれも同じ競合に
 * さらされるため、必ず同じガードを適用すること」と予告していた通り）。
 * 回帰テストは`FloorMap.test.tsx`に「呼び出し対応成功より前に開始した
 * 背景ポーリングが...」を追加した（7.6/8.2/8.3/8.4/8.5の回帰テストと同型）。
 *
 * ## タスク8.7での更新: 人数変更UI（確認モーダル、要件3.5）
 * 8.2〜8.6が確立した役割分担（実際のRPC呼び出し・ローカル状態への
 * マージはFloorMap側のフックが担い、TableDetailPanel.tsxは確認モーダル等の
 * UI状態のみを持つ）を`updatePartySize`にもそのまま適用する
 * （`useUpdatePartySize`、`useAddOrderItem`/`useCloseSession`と同型の
 * 小さな共有フック）。本タスクはStaffOperationsGatewayの拡張が一切不要
 * だった唯一の8.xタスクである（`updatePartySize`は4.1で実装済み）。
 *
 * ### `mergePartySize`（design decision C、8.x全体で最も単純なマージ）
 * `updatePartySize`が返す`TableSession.partySize`をそのまま該当卓の
 * `activeSession.partySize`へ書き写す。8.2の`mergeStartedSession`や8.5の
 * `mergeVacatedTable`のような複数フィールドの合成・副次的な状態操作
 * （パネルを閉じる等）が一切不要——`partySize`という単一フィールドの
 * 単純な置き換えのみで、本タスクの観測可能な完了条件（卓マップのタイルと
 * 卓詳細パネルの両方の人数表示が更新される）を満たす。両者はいずれも
 * 同じ`state.tables`（本コンポーネントが保持する唯一の状態）を参照して
 * いるため、この単一の更新で両方が同時に反映される（8.1のタイルバッジと
 * 8.2のパネルバナーが単一の更新で同時に消えたのと同型の構造）。
 *
 * ### `mutationSeqRef`の適用（7つ目のローカルマージ経路）
 * 人数変更成功時のローカルマージ（`mergePartySize`）も、既存の5秒背景
 * ポーリング・check-in・品目追加・品目削除・ステータス変更・会計・呼び出し
 * 対応と同一コンポーネント内で共存するため、同じ`mutationSeqRef`
 * （インクリメント）＋`load()`内のフェッチ開始時点の値の記録・解決時の
 * 不一致検出という競合防止をそのまま適用する（7.6/8.2/8.3/8.4/8.5/8.6
 * Implementation Notesが「新しい局所的マージ経路はいずれも同じ競合に
 * さらされるため、必ず同じガードを適用すること」と予告していた通り）。
 * 回帰テストは`FloorMap.test.tsx`に「人数変更成功より前に開始した背景
 * ポーリングが...」を追加した（7.6/8.2/8.3/8.4/8.5/8.6の回帰テストと同型）。
 *
 * ### エラー方針（design decisions D）
 * `SESSION_NOT_ACTIVE`/`FORBIDDEN`のいずれも単一の汎用メッセージへ倒す
 * （`useCloseSession.ts`のSESSION_NOT_ACTIVE専用文言とは異なり、
 * `useAddOrderItem.ts`/`useUpdateOrderItemStatus.ts`の「分岐しない」方針を
 * 踏襲する。`useUpdatePartySize.ts`冒頭コメント参照）。
 */
export const REGISTER_FLOOR_MAP_POLL_INTERVAL_MS = 5000;

// タスク9.2: register-feedチャンネルの購読対象。0008マイグレーションで
// registerロールがSELECT可能な3テーブルすべて（order_items/table_sessions/
// call_requests、design.mdのRealtimeFeed Event Contract参照。KitchenBoardは
// このうちorder_itemsのみを購読する——table_sessions/call_requestsは
// registerロール限定のRLSのため、kitchenロールで購読しても配信されない）。
const REGISTER_REALTIME_SUBSCRIPTIONS: ReadonlyArray<RealtimeFeedSubscription> =
  [
    { table: "order_items" },
    { table: "table_sessions" },
    { table: "call_requests" },
  ];

type FloorMapProps = {
  storeId: string;
};

type BoardState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; tables: ReadonlyArray<TableBillingSummary> };

const GENERIC_ERROR_MESSAGE =
  "卓の情報の取得に失敗しました。ネットワーク接続をご確認のうえ、画面を再読み込みしてください。";

// design decision A（ファイル冒頭コメント参照）。mock-preview.htmlの
// renderRegister関数の`/^T/`・`/^C/`とそのまま一致させる。
const TABLE_AREA_LABEL_PATTERN = /^T/;
const COUNTER_AREA_LABEL_PATTERN = /^C/;

const AREA_SECTIONS: ReadonlyArray<{
  key: "table" | "counter" | "other";
  title: string;
}> = [
  { key: "table", title: "テーブル" },
  { key: "counter", title: "カウンター" },
  { key: "other", title: "その他" },
];

/**
 * ファイル冒頭コメント「金額フォーマットについて」参照。タスク8.2で
 * `TableDetailPanel.tsx`からも再利用するためexportする（同一ファイル内の
 * 表記を1箇所に保つため、TableDetailPanel側での複製はしない）。
 */
export function formatYen(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}

/**
 * mock-preview.htmlの`elapsedMin(ts) = Math.max(0, Math.floor((Date.now() -
 * ts) / 60000))`と同じ算出式（`ts`はISO文字列のため`Date.parse`相当で
 * ミリ秒へ変換してから適用する）。タスク8.2で`TableDetailPanel.tsx`からも
 * 再利用するためexportする（タスク文書の指示「reuse/mirror FloorMap.tsx's
 * existing elapsed-minutes formula — do not reinvent」に従う）。
 */
export function elapsedMinutes(startedAtIso: string): number {
  const startedAtMs = new Date(startedAtIso).getTime();
  return Math.max(0, Math.floor((Date.now() - startedAtMs) / 60000));
}

/** design decision A参照。ラベル接頭辞で3区分へ振り分ける。 */
function groupByArea(
  tables: ReadonlyArray<TableBillingSummary>,
): Record<"table" | "counter" | "other", TableBillingSummary[]> {
  const groups: Record<"table" | "counter" | "other", TableBillingSummary[]> =
    {
      table: [],
      counter: [],
      other: [],
    };
  for (const table of tables) {
    if (TABLE_AREA_LABEL_PATTERN.test(table.tableLabel)) {
      groups.table.push(table);
    } else if (COUNTER_AREA_LABEL_PATTERN.test(table.tableLabel)) {
      groups.counter.push(table);
    } else {
      groups.other.push(table);
    }
  }
  return groups;
}

export default function FloorMap({ storeId }: FloorMapProps) {
  const gateway = useMemo(
    () => createStaffOperationsGateway(createBrowserClient()),
    [],
  );
  const [state, setState] = useState<BoardState>({ status: "loading" });
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);

  // タスク8.3で追加: 品目追加リストは選択中の卓に依存しない店舗全体の
  // データのため、`state.tables`とは独立したstateとして持つ（ファイル
  // 冒頭コメント「品目一覧の取得方法」参照）。タスク8.4で`mergeAddedItem`が
  // 参照するため（後述、ファイル冒頭コメント「タスク8.4での更新」）、
  // `mergeAddedItem`より前に宣言する。
  const [menuItemsState, setMenuItemsState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; items: ReadonlyArray<MenuItemListing> }
  >({ status: "loading" });

  // タスク8.2で追加: ファイル冒頭コメント「タスク8.2での更新」参照。
  // startSession成功時のローカルマージのたびにインクリメントする単調増加
  // カウンタ。tasks.md 7.6 Implementation Notesの設計をそのまま踏襲する。
  const mutationSeqRef = useRef(0);

  /**
   * タスク8.2で追加: `startSession`成功応答をFloorMapの`state.tables`へ
   * 合成する（ファイル冒頭コメント「design decision A」参照。`items: []`・
   * `total: 0`・`hasOpenCallRequest: false`は、新規発行直後のセッションが
   * まだ注文・呼び出しを一切持ちえないことに基づく安全な合成）。
   *
   * spec完了後のユーザー確認で追加: 入店操作を確定したら卓詳細パネルを
   * 閉じ、卓マップへ戻る（`setSelectedTableId(null)`）。入店直後の
   * オペレーションは「次の卓の対応に移る」ことが通常であり、品目追加等
   * （8.3）のようにその場でパネルを操作し続ける前提がないため
   * （8.5の`mergeVacatedTable`が会計後にパネルを閉じるのと同じ理由）。
   */
  function mergeStartedSession(
    tableId: string,
    session: { id: string; startedAt: string; partySize: number },
  ) {
    mutationSeqRef.current += 1;
    setState((prev) =>
      prev.status === "ready"
        ? {
            status: "ready",
            tables: prev.tables.map((table) =>
              table.tableId === tableId
                ? {
                    ...table,
                    activeSession: session,
                    items: [],
                    total: 0,
                    hasOpenCallRequest: false,
                  }
                : table,
            ),
          }
        : prev,
    );
    setSelectedTableId(null);
  }

  const { checkIn, submittingTableId, checkInError, clearCheckInError } =
    useCheckIn(gateway, mergeStartedSession);

  /**
   * タスク8.3で追加: `addOrderItem`成功応答（`OrderItemSummary`）を
   * `state.tables`の該当卓の`items`へ追加し、`total`を
   * `unitPrice*quantity`分だけ加算する（ファイル冒頭コメント「合計金額の
   * 再計算方法」参照）。`mutationSeqRef`のインクリメントは8.2の
   * `mergeStartedSession`と同型のガード。
   *
   * タスク8.4で追加: `TableBillingSummary.items`が`genre`を持つように
   * なった（`0014_list_register_feed_item_genre.sql`）が、
   * `addOrderItem`が返す`OrderItemSummary`自体はgenreを含まない（客側の
   * `submitOrder`等とも共有する型であり、本タスクのために拡張すると
   * 影響範囲が本タスクのBoundary（RegisterConsole）を大きく超えるため
   * 見送った）。そのため、既に取得済みの`menuItemsState`（品目追加リスト用、
   * 同一コンポーネント内に既存）から`item.menuItemId`に一致する
   * `MenuItemListing.genre`を引く。追加操作は`menuItemsState`から選んだ
   * 品目に対してのみ行われるため通常は必ず見つかるが、万一見つからない
   * 場合は暫定的に`"food"`にフォールバックする（ローカルマージは
   * ベストエフォートであり、次回の背景ポーリングが`list_register_feed`の
   * 権威的な`genre`で必ず補正するため実害は次回ポーリングまでに限定される
   * ——8.2/8.3が確立した「ドキュメント化された業務エラー時はローカル状態を
   * 次回ポーリングに委ねる」という既存方針と同じ考え方）。
   */
  function mergeAddedItem(tableId: string, item: OrderItemSummary) {
    const genre =
      menuItemsState.status === "ready"
        ? (menuItemsState.items.find((m) => m.id === item.menuItemId)
            ?.genre ?? "food")
        : "food";
    mutationSeqRef.current += 1;
    setState((prev) =>
      prev.status === "ready"
        ? {
            status: "ready",
            tables: prev.tables.map((table) =>
              table.tableId === tableId
                ? {
                    ...table,
                    items: [
                      ...table.items,
                      {
                        id: item.id,
                        menuItemId: item.menuItemId,
                        name: item.name,
                        quantity: item.quantity,
                        unitPrice: item.unitPrice,
                        optionsSummary: item.optionsSummary,
                        status: item.status,
                        genre,
                      },
                    ],
                    total: table.total + item.unitPrice * item.quantity,
                  }
                : table,
            ),
          }
        : prev,
    );
  }

  /**
   * タスク8.3で追加: `removeOrderItem`成功応答（`{orderItemId}`）を
   * `state.tables`の該当卓の`items`から取り除き、`total`から
   * `unitPrice*quantity`分だけ減算する。削除対象が既にローカル状態に
   * 存在しない場合（通常運用下では起こらない）は何もしない。
   */
  function mergeRemovedItem(tableId: string, orderItemId: string) {
    mutationSeqRef.current += 1;
    setState((prev) => {
      if (prev.status !== "ready") {
        return prev;
      }
      return {
        status: "ready",
        tables: prev.tables.map((table) => {
          if (table.tableId !== tableId) {
            return table;
          }
          const removed = table.items.find(
            (item) => item.id === orderItemId,
          );
          if (!removed) {
            return table;
          }
          return {
            ...table,
            items: table.items.filter((item) => item.id !== orderItemId),
            total: table.total - removed.unitPrice * removed.quantity,
          };
        }),
      };
    });
  }

  const { addItem, addItemError, clearAddItemError } = useAddOrderItem(
    gateway,
    mergeAddedItem,
  );
  const { removeItem, removeItemError, clearRemoveItemError } =
    useRemoveOrderItem(gateway, mergeRemovedItem);

  /**
   * タスク8.4で追加: `updateOrderItemStatus`成功応答（`{id, status}`）を
   * `state.tables`の該当卓の該当明細へマージする。`mutationSeqRef`の
   * インクリメントは8.2/8.3の各マージ関数と同型のガード（ファイル冒頭
   * コメント「タスク8.4での更新」参照）。
   */
  function mergeUpdatedItemStatus(
    tableId: string,
    item: { id: string; status: OrderItemSummary["status"] },
  ) {
    mutationSeqRef.current += 1;
    setState((prev) => {
      if (prev.status !== "ready") {
        return prev;
      }
      return {
        status: "ready",
        tables: prev.tables.map((table) => {
          if (table.tableId !== tableId) {
            return table;
          }
          return {
            ...table,
            items: table.items.map((existing) =>
              existing.id === item.id
                ? { ...existing, status: item.status }
                : existing,
            ),
          };
        }),
      };
    });
  }

  const {
    updateStatus,
    updateStatusError,
    clearUpdateStatusError,
  } = useUpdateOrderItemStatus(gateway, mergeUpdatedItemStatus);

  /**
   * タスク8.5で追加: `closeSession`成功後、対象卓を空席状態
   * （`activeSession: null`・`items: []`・`total: 0`・
   * `hasOpenCallRequest: false`）へ合成する（`mergeStartedSession`の鏡像
   * 変換）。加えて、本タスクの観測可能な完了条件が要求する「卓詳細パネルが
   * 閉じる」ことを満たすため`selectedTableId`もクリアする——8.2/8.3/8.4の
   * いずれのマージもパネルを開いたまま維持したため、この呼び出しを含む
   * マージ関数は本タスクが初めて（ファイル冒頭コメント「タスク8.5での更新」
   * 参照）。`mutationSeqRef`のインクリメントは既存の4つのマージ関数と
   * 同型のガード。
   */
  function mergeVacatedTable(tableId: string) {
    mutationSeqRef.current += 1;
    setState((prev) =>
      prev.status === "ready"
        ? {
            status: "ready",
            tables: prev.tables.map((table) =>
              table.tableId === tableId
                ? {
                    ...table,
                    activeSession: null,
                    items: [],
                    total: 0,
                    hasOpenCallRequest: false,
                  }
                : table,
            ),
          }
        : prev,
    );
    setSelectedTableId(null);
  }

  const { closeSession, closeSessionError, clearCloseSessionError } =
    useCloseSession(gateway, mergeVacatedTable);

  /**
   * タスク8.6で追加: `resolveCallRequest`成功応答（`CallRequest`、
   * `sessionId`を持つ）から、`activeSession.id`が一致する卓を探して
   * `hasOpenCallRequest: false`・`openCallRequestId: null`へ合成する
   * （ファイル冒頭コメント「タスク8.6での更新」参照。`tableId`ではなく
   * `sessionId`で対象を探す理由は`useResolveCallRequest.ts`冒頭コメント
   * 参照）。8.1のタイルの呼出バッジと8.2のパネルバナーは同じ
   * `state.tables`を参照しているため、この単一の更新で両方が同時に消える。
   */
  function mergeResolvedCallRequest(sessionId: string) {
    mutationSeqRef.current += 1;
    setState((prev) =>
      prev.status === "ready"
        ? {
            status: "ready",
            tables: prev.tables.map((table) =>
              table.activeSession?.id === sessionId
                ? {
                    ...table,
                    hasOpenCallRequest: false,
                    openCallRequestId: null,
                  }
                : table,
            ),
          }
        : prev,
    );
  }

  const {
    resolveCall,
    resolvingTableId,
    resolveCallError,
    clearResolveCallError,
  } = useResolveCallRequest(gateway, mergeResolvedCallRequest);

  /**
   * タスク8.7で追加: `updatePartySize`成功応答（`TableSession.partySize`）を
   * `state.tables`の該当卓の`activeSession.partySize`へマージする（ファイル
   * 冒頭コメント「タスク8.7での更新」参照）。8.x全体で最も単純なマージ
   * （合成するフィールドがpartySize一つのみ）。`mutationSeqRef`の
   * インクリメントは既存の6つのマージ関数と同型のガード。
   */
  function mergePartySize(tableId: string, partySize: number) {
    mutationSeqRef.current += 1;
    setState((prev) =>
      prev.status === "ready"
        ? {
            status: "ready",
            tables: prev.tables.map((table) =>
              table.tableId === tableId && table.activeSession
                ? {
                    ...table,
                    activeSession: { ...table.activeSession, partySize },
                  }
                : table,
            ),
          }
        : prev,
    );
  }

  const {
    updatePartySize,
    updatePartySizeError,
    clearUpdatePartySizeError,
  } = useUpdatePartySize(gateway, mergePartySize);

  useEffect(() => {
    let cancelled = false;

    async function loadMenuItems() {
      try {
        const result = await gateway.listMenuItems({ storeId });
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          // design.mdの`never`エラー型によりここへは実際には到達しない
          // 防御的分岐（listRegisterFeedの読み込みeffectと同じ方針）。
          setMenuItemsState((prev) =>
            prev.status === "ready" ? prev : { status: "error" },
          );
          return;
        }
        setMenuItemsState({ status: "ready", items: result.value });
      } catch {
        if (!cancelled) {
          setMenuItemsState((prev) =>
            prev.status === "ready" ? prev : { status: "error" },
          );
        }
      }
    }

    void loadMenuItems();

    const interval = setInterval(() => {
      void loadMenuItems();
    }, REGISTER_FLOOR_MAP_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gateway, storeId]);

  // タスク8.2で追加（8.3で品目追加・削除、8.4でステータス変更、8.5で会計の
  // エラーも合わせてクリアするよう拡張）: 選択中の卓が切り替わる（別の卓を
  // 選ぶ／パネルを閉じる）たびに、直前の操作エラーを持ち越さない（別の卓の
  // パネルへ古いエラーメッセージを誤って表示することを防ぐ）。
  useEffect(() => {
    clearCheckInError();
    clearAddItemError();
    clearRemoveItemError();
    clearUpdateStatusError();
    clearCloseSessionError();
    clearResolveCallError();
    clearUpdatePartySizeError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTableId]);

  // タスク9.2で追加: 下記のマウント時初回フェッチ+背景ポーリングeffectが
  // ローカルに定義する`load`関数を、useRealtimeFeedの`onSync`からも
  // 直接呼び出せるようにするための橋渡し（ファイル冒頭コメント
  // 「タスク9.2での更新」の「onSyncの実装について」参照）。`load`自体は
  // 従来通りeffect内のローカル関数のまま変更しない
  // （`useCallback`へ引き上げてeffect外から直接呼び出す設計も検討したが、
  // `react-hooks/set-state-in-effect`がuseEffect本体からの`useCallback`
  // 関数の直接呼び出しを「effect内での同期的なsetState」の疑いとして
  // 誤検知したため見送った。effect内のローカル関数呼び出しという既存の
  // 形は静的解析上問題にならないため、その関数への参照だけをrefへ逃がし、
  // onSync（effect本体の外側にあるコールバック）側から`loadRef.current`
  // 経由で呼び出す）。マウント時初回フェッチ・5秒背景ポーリング・onSync
  // 起点の背景フェッチの3つの呼び出し元が、新しい再同期機構を増やすことなく
  // 同一の`load`関数・同一のmutationSeqRefガードを共有する。
  const loadRef = useRef<((isInitialLoad: boolean) => Promise<void>) | null>(
    null,
  );

  // FoodBoard.tsx（7.2）が確立した既存パターン——マウント時の初回取得と
  // 背景ポーリングを、1つのuseEffect内でローカルに定義した非同期関数として
  // まとめ、`cancelled`フラグでアンマウント後のsetStateを防ぐ——をそのまま
  // 踏襲する。
  useEffect(() => {
    let cancelled = false;

    // tasks.md Implementation Notes: listRegisterFeedはResult<T, never>
    // ——ドキュメント化されたエラーコード以外（FORBIDDENを含むあらゆる
    // エラー）は常に例外としてthrowされる（Resultのエラーメンバーには
    // 決して現れない）ため、必ずtry/catchで捕捉する。
    async function load(isInitialLoad: boolean) {
      // タスク8.2で追加: フェッチ開始時点のmutationSeqRefを記録する
      // （ファイル冒頭コメント「タスク8.2での更新」、FoodBoard.tsxの
      // 7.6と同型のガード）。
      const fetchSeq = mutationSeqRef.current;
      try {
        const result = await gateway.listRegisterFeed({ storeId });
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          // design.mdの`never`エラー型によりここへは実際には到達しない
          // 防御的分岐。
          if (isInitialLoad) {
            setState({ status: "error", message: GENERIC_ERROR_MESSAGE });
          }
          return;
        }
        if (mutationSeqRef.current !== fetchSeq) {
          // タスク8.2で追加: このフェッチが開始してから解決するまでの間に
          // checkIn()等によるローカルマージが発生した——このフェッチが持つ
          // スナップショットはそのマージより古い可能性がある。丸ごと
          // 上書きすると、たった今マージしたばかりの来店中の状態を空席へ
          // 巻き戻してしまう（7.6レビューで発見された競合と同型、tasks.md
          // Implementation Notes参照）。このフェッチの結果は破棄し、次回の
          // ポーリング（またはonSync起点の再取得、タスク9.2）に委ねる
          // （その頃にはサーバー側の実データ自体がこのマージ結果を反映済み
          // のため、次回フェッチは安全に適用できる）。
          return;
        }
        setState({ status: "ready", tables: result.value });
      } catch {
        // 初回読み込みの失敗のみ明示的なエラー表示にする。バックグラウンド
        // ポーリング・onSync起点の再取得の失敗は画面を壊さないよう
        // 握りつぶす（FoodBoard.tsxと同じ方針）。
        if (!cancelled && isInitialLoad) {
          setState({ status: "error", message: GENERIC_ERROR_MESSAGE });
        }
      }
    }

    // タスク9.2で追加: onSyncからも同じ`load`を呼べるようrefへ公開する。
    loadRef.current = load;

    void load(true);

    const interval = setInterval(() => {
      void load(false);
    }, REGISTER_FLOOR_MAP_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      loadRef.current = null;
      clearInterval(interval);
    };
  }, [gateway, storeId]);

  // タスク9.2で追加: register-feedチャンネルへ接続するSupabaseクライアント。
  // KitchenBoardScreen.tsx（7.6）と同じDIパターン（`gateway`が内部に持つ
  // クライアントとは別に、画面ごとに1つ生成しuseMemoで安定させる）。
  const realtimeClient = useMemo(() => createBrowserClient(), []);

  // タスク9.2: onSyncは既存の`load(false)`（上記effectがloadRef経由で
  // 公開したもの）をそのまま呼ぶだけで、新しい再同期state（resyncToken等）は
  // 増やさない（ファイル冒頭コメント「onSyncの実装について」参照）。
  // マウント直後等、上記effectがまだ`loadRef.current`を設定する前に
  // useRealtimeFeedが先にSUBSCRIBEDを報告してonSyncを呼ぶ理論上の順序も
  // オプショナルチェイニングで安全に無視する（その場合でも、同じeffectが
  // 直後に行うマウント時初回フェッチ`load(true)`が同じ内容を取得済みのため
  // 実害はない）。戻り値（接続状態）は使わない——RegisterConsoleには
  // 接続状態UIを追加しない設計判断のため（ファイル冒頭コメント
  // 「接続状態UIを追加しない」参照）。
  useRealtimeFeed({
    client: realtimeClient,
    channelName: "register-feed",
    subscriptions: REGISTER_REALTIME_SUBSCRIPTIONS,
    onSync: () => {
      void loadRef.current?.(false);
    },
  });

  if (state.status === "loading") {
    return (
      <p
        className="p-4 text-sm text-neutral-500"
        data-testid="register-floor-map-loading"
      >
        読み込み中...
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <p role="alert" className="p-4 text-sm text-red-600">
        {state.message}
      </p>
    );
  }

  const grouped = groupByArea(state.tables);

  // タスク8.2で追加: ファイル冒頭コメント「design decision D」参照。
  // 選択中卓の`TableBillingSummary`は、クリック時点のスナップショットでは
  // なく`state.tables`から都度探索した最新値を用いる（背景ポーリングの
  // 結果が反映されるたびに、開いたままのパネルも新しい注文・合計へ追随する）。
  const selectedTable =
    state.tables.find((table) => table.tableId === selectedTableId) ?? null;

  // spec完了後のユーザー確認で追加: CallBannerStack向けに、呼び出し中の
  // 卓を`openCallRequestCreatedAt`昇順（古い順）へ整列する。null
  // （呼び出しが無い、または0017適用前の防御的な欠損値）の卓は除外する
  // ——CallBannerStack.tsx冒頭コメント「複数呼び出しの積み重ね順」参照。
  // ソート自体をこちら側（データを持つ側）で行い、CallBannerStackは
  // 受け取った順序をそのまま描画するだけの表示専用に保つ。
  const openCalls = state.tables
    .filter(
      (table): table is typeof table & { openCallRequestId: string; openCallRequestCreatedAt: string } =>
        table.hasOpenCallRequest &&
        table.openCallRequestId !== null &&
        table.openCallRequestCreatedAt !== null,
    )
    .map((table) => ({
      tableId: table.tableId,
      tableLabel: table.tableLabel,
      callRequestId: table.openCallRequestId,
      createdAt: table.openCallRequestCreatedAt,
    }))
    .sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

  return (
    <>
      <CallBannerStack
        calls={openCalls}
        onDismiss={(tableId, callRequestId) =>
          void resolveCall(tableId, callRequestId)
        }
        dismissingTableId={resolvingTableId}
      />
      <div data-testid="register-floor-map" className="flex flex-col gap-3 p-3">
      <div className="flex items-baseline justify-between">
        <h1 className="text-base font-semibold text-neutral-900">卓マップ</h1>
        <span
          data-testid="register-floor-map-count"
          className="text-xs text-neutral-500"
        >
          全{state.tables.length}卓
        </span>
      </div>

      {AREA_SECTIONS.map((section) => {
        const tables = grouped[section.key];
        if (section.key === "other" && tables.length === 0) {
          // design decision A参照: T/Cいずれにも一致する卓が無ければ
          // 「その他」区分自体を描画しない。
          return null;
        }
        return (
          <div key={section.key} data-testid={`register-floor-section-${section.key}`}>
            <div className="mb-1 text-xs font-bold text-neutral-500">
              {section.title}
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {tables.length === 0 ? (
                <p className="col-span-full py-2 text-xs text-neutral-400">
                  卓がありません
                </p>
              ) : (
                tables.map((table) => (
                  <button
                    type="button"
                    key={table.tableId}
                    data-testid={`register-floor-tile-${table.tableLabel}`}
                    onClick={() => setSelectedTableId(table.tableId)}
                    aria-pressed={selectedTableId === table.tableId}
                    className={
                      "relative flex flex-col gap-1 rounded-lg border p-2 text-left text-xs shadow-sm " +
                      (table.activeSession
                        ? "border-neutral-300 bg-white"
                        : "border-neutral-200 bg-neutral-50")
                    }
                  >
                    {table.hasOpenCallRequest ? (
                      <span
                        data-testid="register-floor-tile-call-badge"
                        className="absolute -top-2 -right-2 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white shadow"
                      >
                        呼出
                      </span>
                    ) : null}
                    <div className="font-bold text-neutral-900">
                      {table.tableLabel}
                    </div>
                    {table.activeSession === null ? (
                      <div
                        data-testid="register-floor-tile-vacant"
                        className="text-neutral-400"
                      >
                        空席
                      </div>
                    ) : (
                      <>
                        <div
                          data-testid="register-floor-tile-occupancy"
                          className="text-neutral-600"
                        >
                          {table.activeSession.partySize}名・
                          {elapsedMinutes(table.activeSession.startedAt)}分
                        </div>
                        <div
                          data-testid="register-floor-tile-total"
                          className="font-mono font-semibold text-neutral-900"
                        >
                          {formatYen(table.total)}
                        </div>
                      </>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        );
      })}

      {selectedTable ? (
        <TableDetailPanel
          table={selectedTable}
          onClose={() => setSelectedTableId(null)}
          onCheckIn={(partySize) => void checkIn(selectedTable.tableId, partySize)}
          submitting={submittingTableId === selectedTable.tableId}
          checkInErrorMessage={
            checkInError && checkInError.tableId === selectedTable.tableId
              ? checkInError.message
              : null
          }
          menuItems={
            menuItemsState.status === "ready" ? menuItemsState.items : []
          }
          menuItemsLoadError={menuItemsState.status === "error"}
          onAddItem={(input) => {
            if (!selectedTable.activeSession) {
              // 到達しないはずの防御的分岐: onAddItemはOccupiedView
              // （table.activeSessionが非nullのときのみ描画される）からしか
              // 呼ばれない。
              return Promise.resolve();
            }
            return addItem(selectedTable.tableId, {
              sessionId: selectedTable.activeSession.id,
              menuItemId: input.menuItemId,
              quantity: input.quantity,
              optionSelections: input.optionSelections,
            });
          }}
          addItemErrorMessage={
            addItemError && addItemError.tableId === selectedTable.tableId
              ? addItemError.message
              : null
          }
          onRemoveItem={(orderItemId) =>
            removeItem(selectedTable.tableId, orderItemId)
          }
          removeItemErrorMessage={
            removeItemError && removeItemError.tableId === selectedTable.tableId
              ? removeItemError.message
              : null
          }
          onUpdateItemStatus={(orderItemId, status) =>
            updateStatus(selectedTable.tableId, orderItemId, status)
          }
          updateStatusErrorMessage={
            updateStatusError &&
            updateStatusError.tableId === selectedTable.tableId
              ? updateStatusError.message
              : null
          }
          onCloseSession={() => {
            if (!selectedTable.activeSession) {
              // 到達しないはずの防御的分岐: onCloseSessionはOccupiedView
              // （table.activeSessionが非nullのときのみ描画される）からしか
              // 呼ばれない。
              return Promise.resolve();
            }
            return closeSession(
              selectedTable.tableId,
              selectedTable.activeSession.id,
            );
          }}
          closeSessionErrorMessage={
            closeSessionError &&
            closeSessionError.tableId === selectedTable.tableId
              ? closeSessionError.message
              : null
          }
          onResolveCallRequest={() => {
            if (!selectedTable.openCallRequestId) {
              // 到達しないはずの防御的分岐: 「対応済みにする」ボタンは
              // table.hasOpenCallRequestが真のときのみ描画され、
              // list_register_feedはhasOpenCallRequestとopenCallRequestIdを
              // 同時に更新するため通常は必ず非nullになる
              // （TableDetailPanel.tsx冒頭コメント「呼び出し対応」参照）。
              return;
            }
            void resolveCall(selectedTable.tableId, selectedTable.openCallRequestId);
          }}
          resolvingCallRequest={resolvingTableId === selectedTable.tableId}
          resolveCallRequestErrorMessage={
            resolveCallError && resolveCallError.tableId === selectedTable.tableId
              ? resolveCallError.message
              : null
          }
          onUpdatePartySize={(partySize) => {
            if (!selectedTable.activeSession) {
              // 到達しないはずの防御的分岐: onUpdatePartySizeはOccupiedView
              // （table.activeSessionが非nullのときのみ描画される）からしか
              // 呼ばれない。
              return Promise.resolve();
            }
            return updatePartySize(
              selectedTable.tableId,
              selectedTable.activeSession.id,
              partySize,
            );
          }}
          updatePartySizeErrorMessage={
            updatePartySizeError &&
            updatePartySizeError.tableId === selectedTable.tableId
              ? updatePartySizeError.message
              : null
          }
        />
      ) : null}
      </div>
    </>
  );
}
