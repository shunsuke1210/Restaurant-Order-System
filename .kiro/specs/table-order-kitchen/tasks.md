# Implementation Plan

- [ ] 1. Foundation: プロジェクト基盤とコアスキーマ
- [x] 1.1 Next.jsプロジェクトの初期構築とテスト基盤
  - TypeScript + App Routerで `/order`・`/kitchen`・`/register`・`/setup` の4ルートディレクトリを持つ単一Next.jsプロジェクトを作成する
  - lint・型チェックスクリプトと環境変数テンプレート（`.env.example`）を整備する
  - 単体/結合テスト用にVitest、E2E用にPlaywrightを導入し、`npm test`/`npm run test:e2e`で実行できるように設定する（以降の全タスクが依拠する基盤）
  - 観測可能な完了条件: `next build` がエラーなく完了し、4ルートの空ページがブラウザで表示される
  - 観測可能な完了条件: サンプルの1件のテストが`npm test`で実行され成功する

- [x] 1.2 Supabaseクライアントとローカル開発環境の設定
  - ブラウザ用Supabaseクライアント生成モジュールと、Supabase CLIによるローカルマイグレーション実行環境を整備する
  - `database.types.ts` をSupabase CLIで生成するスクリプトを用意する
  - 観測可能な完了条件: ローカルSupabaseに対して型生成コマンドが成功し、`database.types.ts` が生成される

- [x] 1.3 コアスキーマのマイグレーション作成
  - `stores`/`tables`/`table_sessions`（`party_size`列を含む）/`menu_items`（`genre`/`options` jsonb/`image_url`/`sold_out`列を含む）/`orders`（`idempotency_key`列を含む）/`order_items`（`status`/`status_updated_at`/`name_snapshot`/`unit_price_snapshot`/`options_selected`/`options_summary`列を含む）/`call_requests`/`devices` の各テーブルを作成する
  - `table_sessions(table_id) WHERE status = 'active'` の部分ユニークインデックスを作成する
  - `orders(session_id, idempotency_key)` のユニーク制約と、`order_items(status, status_updated_at)`の複合インデックスを作成する
  - 観測可能な完了条件: マイグレーション適用後、同一卓に対して2件目のアクティブセッションをINSERTすると一意制約違反になる
  - _Requirements: 1.5, 1.6, 3.4, 4.1, 6.2, 6.3, 6.4, 6.10, 7.4_

- [x] 1.4 RLSポリシーのマイグレーション作成
  - 全テーブルでRLSを有効化し、`anon`/`authenticated`ロールへのINSERT/UPDATE/DELETE直接権限を付与しない
  - `menu_items` のSELECTのみ `anon` に許可する
  - 観測可能な完了条件: `anon`ロールで`table_sessions`への直接INSERTを試みると拒否される
  - _Requirements: 8.1, 8.2, 8.3_

- [ ] 2. Foundation: デバイス識別基盤
- [x] 2.1 Custom Access Token Hookとdevice_roleクレーム
  - `devices`テーブルを参照し、JWT発行時に`device_role`クレームを埋め込むCustom Access Token Hook関数を実装する
  - 観測可能な完了条件: プロビジョニング済みデバイスでサインインすると、発行されたJWTに`device_role`クレームが含まれる
  - _Requirements: 8.2, 8.3_
  - _Depends: 1.3_

- [x] 2.2 device_role検証ヘルパーとFORBIDDEN境界の共通化
  - 各RPC関数冒頭で共通利用する`assert_device_role(text[])`ヘルパー関数を実装する
  - 観測可能な完了条件: 許可されていない`device_role`のJWTでヘルパーを呼び出すと例外（FORBIDDEN相当）が送出される
  - _Requirements: 8.2, 8.3_
  - _Depends: 2.1_

- [x] 2.3 DeviceIdentityProviderと初回セットアップ画面
  - `ensureDeviceSession`/`provisionDevice`/`getCurrentDevice`を実装し、`/setup/[role]`画面でセットアップコード入力→匿名サインイン→`devices`登録を行う
  - 観測可能な完了条件: セットアップコード入力後、タブレットのローカルストレージに永続化されたセッションで再訪時に認証UIが表示されない
  - _Requirements: 8.2, 8.3_
  - _Depends: 2.1_

- [ ] 3. Core: CustomerOrderingGateway（客側の唯一の書き込み経路）
- [x] 3.1 get_ordering_context RPCの実装
  - 卓IDからアクティブセッションの有無・メニュー一覧（`imageUrl`/`options`/`soldOut`含む）・`confirmedTotal`を返すRPCを実装する
  - 観測可能な完了条件: アクティブセッションのない卓IDで呼び出すと`activeSession: null`が返る
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.12, 7.2_

- [x] 3.2 submit_order RPCの実装
  - セッション有効性・売り切れ再検証・オプション整合性チェックを行い、`idempotencyKey`による重複送信の吸収、同一品目でもオプション別に別明細として登録する処理を実装する
  - 観測可能な完了条件: 同一`idempotencyKey`で2回送信しても`order_items`が重複挿入されず`deduplicated: true`が返る
  - _Requirements: 1.7, 1.8, 1.9, 1.10, 7.2_
  - _Depends: 3.1_

- [x] 3.3 create_call_request RPCの実装
  - セッションに未対応の呼び出しが既に存在する場合は新規作成しないRPCを実装する
  - 観測可能な完了条件: 同一セッションに対して連続して呼び出しても`call_requests`の行が1件のまま増えない
  - _Requirements: 2.1, 2.2, 2.3_
  - _Depends: 3.1_

- [x] 3.4 CustomerOrderingGatewayのTypeScriptラッパー
  - `getOrderingContext`/`submitOrder`/`createCallRequest`を型付きの`Result<T,E>`として公開するラッパーを実装する
  - 観測可能な完了条件: 各RPCのエラーコードがユニオン型として型チェックを通過し、呼び出し側で網羅的なswitchができる
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.12, 2.1, 2.2, 2.3, 7.2_
  - _Depends: 3.1, 3.2, 3.3_

- [x] 3.5 submit_orderのセッション単位レート制限
  - `submit_order`にセッション単位のレート制限（例: 1セッションあたり1分間に一定回数を超える呼び出しを拒否）を追加し、QRコード流出等による大量不正送信を緩和する（design.mdのSecurity Considerations／Risks、research.mdのRisks & Mitigations参照）
  - 新しいエラーコード`RATE_LIMITED`をRPCとTypeScriptラッパーの両方に反映する
  - 観測可能な完了条件: 同一セッションから許容回数を超えて短時間に送信すると`RATE_LIMITED`で拒否され、通常の送信間隔では拒否されない
  - _Boundary: CustomerOrderingGateway_
  - _Depends: 3.4_

- [ ] 4. Core: StaffOperationsGateway（厨房/レジの唯一の書き込み経路）
- [x] 4.1 (P) start_session / close_session / update_party_size RPCの実装
  - 人数を記録して新規セッションを発行する`start_session`、確認済みの会計操作を受けてセッションを終了する`close_session`、来店中のセッションの人数を変更する`update_party_size`を実装する
  - 部分ユニークインデックス違反を`SESSION_ALREADY_ACTIVE`として処理し、`device_role`検証を先頭で行う。`update_party_size`は対象セッションが`closed`の場合`SESSION_NOT_ACTIVE`を返す
  - 観測可能な完了条件: アクティブセッションが既にある卓に対する`start_session`が`SESSION_ALREADY_ACTIVE`エラーを返す
  - 観測可能な完了条件: 会計済み（`closed`）のセッションに対する`update_party_size`が`SESSION_NOT_ACTIVE`エラーを返す
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4_
  - _Boundary: StaffOperationsGateway_
  - _Depends: 1.3, 1.4, 2.1, 2.2_

- [x] 4.2 add_order_item / remove_order_item RPCの実装
  - `submit_order`と同等の検証（セッション有効性・売り切れ）を適用した品目追加と、閉じたセッションへの削除を拒否する品目削除を実装する
  - 観測可能な完了条件: 既に会計済み（`closed`）のセッションの注文明細を削除しようとすると`ORDER_ITEM_NOT_FOUND`が返る
  - _Requirements: 5.5, 5.6_
  - _Depends: 4.1_

- [x] 4.3 update_order_item_status RPCの実装
  - 品目のジャンルに応じた許可遷移（フード/一品: received→in_progress→done、ドリンク: received→done、一品のみreceived→done直接遷移も許可）を検証するRPCを実装する
  - ステータスを変更するたびに`status_updated_at`を現在時刻で更新する
  - 観測可能な完了条件: ドリンクジャンルの品目に対して`in_progress`への遷移を要求すると`INVALID_TRANSITION`が返る
  - _Requirements: 5.7, 6.2, 6.3, 6.4, 6.5, 6.6, 6.10_
  - _Depends: 4.1_

- [x] 4.4 set_sold_out / resolve_call_request RPCの実装
  - 品目の売り切れ状態を切り替える（既存注文の内容・状態を変更しない）RPCと、呼び出しを対応済みにするRPCを実装する
  - 観測可能な完了条件: 品目を売り切れ登録しても、登録前に作成された`order_items`の行数・`status`が変化しない
  - _Requirements: 2.4, 7.1, 7.3, 7.4_
  - _Depends: 4.1_

- [x] 4.5 list_kitchen_feed / list_register_feed RPCの実装
  - 未対応品目一覧で一品ジャンルを受注時刻に関わらず先頭に並べ、調理完了列は`status_updated_at`の降順（直近完了が先頭）に並べる厨房向け一覧と、卓ごとの人数・注文明細・合計金額・未対応の呼び出し有無（`hasOpenCallRequest`）を返すレジ向け一覧を実装する
  - 観測可能な完了条件: 一品ジャンルの品目を後から注文しても、未対応一覧の先頭に表示される順序でRPCが返す
  - 観測可能な完了条件: 先に調理完了にした品目と後から調理完了にした品目がある場合、後から完了させた品目が調理完了一覧の先頭に返る
  - _Requirements: 2.2, 5.1, 5.2, 5.3, 5.4, 6.1, 6.7, 6.8, 6.9, 6.10_
  - _Depends: 4.1_

- [x] 4.6 StaffOperationsGatewayのTypeScriptラッパー
  - `startSession`/`closeSession`/`updatePartySize`/`addOrderItem`/`removeOrderItem`/`updateOrderItemStatus`/`setSoldOut`/`resolveCallRequest`/`listKitchenFeed`/`listRegisterFeed`を型付きで公開するラッパーを実装する
  - 観測可能な完了条件: 全メソッドの戻り値が`Result<T,E>`型として型チェックを通過する
  - _Requirements: 2.2, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 7.1, 7.3, 7.4_
  - _Depends: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 5. useRealtimeFeedフックの実装
  - `order_items`/`table_sessions`/`call_requests`への`postgres_changes`購読と、切断検知時に対応する一覧再取得関数（`listKitchenFeed`/`listRegisterFeed`/`getOrderingContext`）を呼び直す再同期ロジックを実装する
  - 観測可能な完了条件: 購読中にネットワークを切断し再接続すると、一覧が最新状態に再取得される
  - _Requirements: 1.12, 6.1, 6.8, 6.9_
  - _Depends: 3.4, 4.6_

- [ ] 6. Core: 客側注文画面（CustomerOrderApp）
- [x] 6.1 メニュー閲覧・ジャンル別タブ・オプション選択UI
  - 品目の写真表示、オプション選択（choice/toggle/counter）、売り切れ品目の選択不可表示を含むメニュー画面を実装する
  - 観測可能な完了条件: 売り切れ品目がグレーアウトされ選択操作ができない
  - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 7.2_
  - _Depends: 3.4_

- [x] 6.2 注文送信・確定注文合計表示・通信断ハンドリング
  - 注文送信フローを実装し、送信完了が画面に表示されるようにする
  - 画面下部に確定注文合計を常時表示し、同席者の別端末からの注文にもRealtimeで追随して更新する
  - 送信中のネットワーク断エラー表示と再試行の案内を実装する
  - 観測可能な完了条件（3件）: (a) 注文送信が成功すると送信完了メッセージが表示される (b) 別端末からの注文後、確定注文合計表示が再読み込みなしに更新される (c) 送信中にネットワークを切断すると送信未完了の旨が画面に表示される
  - _Requirements: 1.7, 1.8, 1.9, 1.10, 1.11, 1.12_
  - _Depends: 6.1, 5_

- [x] 6.3 呼び出しボタンUI
  - 呼び出しボタンの表示と、対応済みになるまでの重複防止表示を実装する
  - 観測可能な完了条件: 呼び出し送信後、対応済みになるまでボタンが再送不可の状態を示す
  - _Requirements: 2.1, 2.2, 2.3_
  - _Depends: 6.1_

- [x] 6.4 (P) アクティブセッション不在時の案内画面
  - アクティブセッションがない卓でQRを読み取った場合に、注文フォームの代わりにスタッフを呼ぶ案内を表示する
  - 観測可能な完了条件: アクティブセッションのない卓IDへアクセスすると注文フォームが表示されず案内文が表示される
  - _Requirements: 1.1, 1.3_
  - _Boundary: CustomerOrderApp_
  - _Depends: 3.1_

- [ ] 7. Core: 厨房KDS画面（KitchenBoard）
- [x] 7.1 (P) 3タブ共通シェルと固定ヘッダー
  - フードボード／ドリンクボード／売り切れボードの3タブ切り替えと、スクロールしても消えない固定ヘッダー・サブタブ領域を実装する
  - 観測可能な完了条件: ボード内をスクロールしてもタブ・ヘッダーが画面上部に固定表示され続ける
  - _Boundary: KitchenBoard_
  - _Depends: 4.6, 5_

- [x] 7.2 フードボード（5分割カンバン・一品優先表示）
  - 未対応2列・調理中2列・調理完了1列の5分割カンバンと、一品ジャンルを受注時刻に関わらず未対応列の先頭に表示する並び替えを実装する
  - 調理完了列はRPCが返す順序（直近完了が先頭）をそのまま表示に反映する
  - 各カードに卓の識別情報と受注時刻を判別できる形で表示する
  - 観測可能な完了条件: 一品ジャンルの品目が、他の品目より後に注文されても未対応列の最上部に表示される
  - 観測可能な完了条件: 調理完了列で、後から調理完了にした品目が先に完了した品目より上に表示される
  - _Requirements: 6.3, 6.6, 6.7, 6.8, 6.10_
  - _Depends: 7.1_

- [x] 7.3 ドリンクボード（2状態カンバン）
  - 未対応/対応済みの2列カンバンを実装する
  - 各カードに卓の識別情報と受注時刻を判別できる形で表示する
  - 観測可能な完了条件: ドリンク品目のステータス更新操作に調理中の選択肢が表示されない
  - _Requirements: 6.4, 6.8_
  - _Depends: 7.1_

- [x] 7.4 売り切れボード（検索・確認モーダル）
  - 品目検索・サマリー・売り切れ切り替えの確認モーダルを実装する
  - 観測可能な完了条件: 売り切れ切り替え操作で確認モーダルの「いいえ」を選ぶと状態が変化しない
  - _Requirements: 7.1, 7.3, 7.4_
  - _Depends: 7.1_

- [x] 7.5 ステータス更新操作と即時反映
  - 品目のステータス更新操作（一品の未対応→調理完了直接遷移ショートカット含む）と、更新結果の画面への即時反映を実装する
  - 観測可能な完了条件: ステータス更新操作の直後に、確認や再読み込みなしで該当カードが新しい列へ移動する
  - _Requirements: 6.1, 6.2, 6.5_
  - _Depends: 7.2, 7.3_

- [x] 7.6 接続断表示と再同期
  - サーバーとの接続断の表示と、再接続後の最新一覧への同期を実装する
  - 観測可能な完了条件: 接続断中は画面にその旨が表示され、再接続後に一覧が最新化される
  - _Requirements: 6.9_
  - _Depends: 7.1_

- [ ] 8. Core: レジ画面（RegisterConsole）
- [x] 8.1 (P) 卓マップ表示
  - テーブル/カウンターのエリア分けと、各卓タイルへの人数・経過時間・合計金額・呼び出し中バッジ（`hasOpenCallRequest`）の表示を実装する
  - 観測可能な完了条件: 呼び出し中の卓のタイルに呼び出しバッジが表示され、対応済みになると消える
  - _Requirements: 2.2, 5.4_
  - _Boundary: RegisterConsole_
  - _Depends: 4.6, 5_

- [x] 8.2 卓詳細パネルと入店操作（人数入力）
  - 卓タイル選択で開く詳細パネルと、入店操作時の人数入力フォーム、選択中卓への新規注文のリアルタイム反映を実装する
  - 観測可能な完了条件: 入店操作で人数を入力し確定すると、卓マップのタイルにその人数が表示される
  - _Requirements: 3.1, 3.2, 3.4, 5.1, 5.2, 5.3_
  - _Depends: 8.1_

- [x] 8.3 品目の追加・削除UI（確認モーダル）
  - レジからの品目追加・削除操作と、実行前の確認モーダルを実装する
  - 観測可能な完了条件: 削除操作で確認モーダルの「いいえ」を選ぶと注文明細が変化しない
  - _Requirements: 5.5, 5.6_
  - _Depends: 8.2_

- [x] 8.4 品目ステータス変更UI（確認モーダル）
  - レジからの品目ステータス変更操作と、実行前の確認モーダルを実装する
  - 観測可能な完了条件: ステータス変更の確認モーダルで確認すると、注文明細のステータス表示が更新される
  - _Requirements: 5.7_
  - _Depends: 8.2_

- [x] 8.5 会計操作（確認モーダル・セッション終了）
  - 「お会計完了でよろしいですか？完了するとQRコード情報がリセットされます」の確認モーダルと、確認後のセッション終了・卓マップ表示への遷移を実装する
  - 観測可能な完了条件: 会計確認後、卓詳細パネルが閉じて卓マップ画面が表示され、対象卓が空席状態になる
  - _Requirements: 3.3_
  - _Depends: 8.2_

- [x] 8.6 呼び出し対応UI
  - 呼び出し通知の表示と、対応済み操作を実装する
  - 観測可能な完了条件: 呼び出し対応操作を行うと通知表示が消える
  - _Requirements: 2.4_
  - _Depends: 8.1_

- [x] 8.7 人数変更UI（確認モーダル）
  - 卓詳細パネルに人数更新ボタンを設け、レジからの人数変更操作と実行前の確認モーダルを実装する
  - 観測可能な完了条件: 人数変更の確認モーダルで確認すると、卓マップのタイルと卓詳細パネルの人数表示が更新される
  - _Requirements: 3.5_
  - _Depends: 8.2_

- [ ] 9. Integration: デバイスガードと画面配線
- [x] 9.1 厨房/レジ起動時のデバイスセッション確認とセットアップ導線
  - `/kitchen`・`/register`起動時に`ensureDeviceSession`を確認し、未プロビジョニングの場合は`/setup/[role]`へ導線を表示する
  - 観測可能な完了条件: 未プロビジョニングのブラウザで`/kitchen`にアクセスするとセットアップ画面へ誘導される
  - _Requirements: 8.2, 8.3_
  - _Depends: 2.3, 7.1, 8.1_

- [x] 9.2 3画面へのRealtimeFeed接続と再接続時再取得の統合確認
  - `CustomerOrderApp`/`KitchenBoard`/`RegisterConsole`それぞれに`useRealtimeFeed`を配線し、画面間をまたいだ更新反映（客の注文→厨房/レジへの反映）を確認する
  - 観測可能な完了条件: 客側画面から注文を送信すると、5秒以内に厨房画面とレジ画面の両方に反映される
  - _Requirements: 1.12, 6.1, 6.9_
  - _Depends: 6.2, 7.5, 8.2_

- [ ] 10. Validation: テスト
- [x] 10.1 CustomerOrderingGateway ユニットテスト
  - `submit_order`のセッション無効・売り切れ・オプション別明細分離・冪等性、`get_ordering_context`の基本ケースをテストする
  - 観測可能な完了条件: 終了済みセッションへの`submit_order`が`SESSION_NOT_ACTIVE`を返しDBに行が増えないことがテストで確認される
  - _Requirements: 1.4, 1.8, 1.9, 1.11, 7.2_
  - _Depends: 3.2_

- [x] 10.2 StaffOperationsGateway ユニットテスト
  - `start_session`の重複防止、`update_party_size`の境界ケース（`closed`セッションへの拒否）、`update_order_item_status`のジャンル別許可遷移、`list_kitchen_feed`の一品優先順と調理完了の直近完了順、`add_order_item`/`remove_order_item`の境界ケースをテストする
  - 観測可能な完了条件: ドリンクジャンルへの`in_progress`遷移要求が`INVALID_TRANSITION`として拒否されることがテストで確認される
  - 観測可能な完了条件: `list_kitchen_feed`の調理完了列が`status_updated_at`降順で返ることがテストで確認される
  - 観測可能な完了条件: 会計済みセッションへの`update_party_size`が`SESSION_NOT_ACTIVE`として拒否されることがテストで確認される
  - _Requirements: 3.1, 3.4, 3.5, 4.1, 5.5, 5.6, 6.3, 6.4, 6.6, 6.7, 6.10_
  - _Depends: 4.5_

- [x] 10.3 結合テスト（RLS境界・権限・整合性）
  - `anon`ロールでの生テーブル直接書き込み拒否、`device_role`未設定JWTでの`FORBIDDEN`、`confirmedTotal`と`listRegisterFeed`の`total`の一致、呼び出し重複防止、注文挿入からRealtime通知到達までの時間を検証する
  - 観測可能な完了条件: 同一卓・同一セッションで客側`confirmedTotal`とレジ側`total`が常に同じ値になることがテストで確認される
  - _Requirements: 1.12, 2.3, 5.1, 6.1, 8.1, 8.2, 8.3_
  - _Depends: 9.2_

- [x] 10.4 E2E: 主要ユーザージャーニー
  - 客のQR注文（写真・オプション選択含む）→厨房のフード/ドリンクボードへの反映→ステータス更新→レジでの金額確認→会計操作によるセッション終了までを通しで検証する
  - 観測可能な完了条件: 一連のE2Eシナリオがグリーンで完走する
  - _Requirements: 1.5, 1.6, 1.7, 1.9, 1.12, 3.1, 3.3, 3.4, 4.1, 4.2, 4.4, 5.1, 5.4, 6.1, 6.3, 6.4, 6.8_
  - _Depends: 9.2_

- [x] 10.5 E2E: エッジケース（売り切れ・人数入力・人数変更・レジ確認操作・セッション失効）
  - 売り切れ登録の確認モーダル、入店時の人数入力と卓マップ表示、来店中の人数変更確認モーダル、レジからの品目追加/削除確認モーダル、セッション終了後の旧セッションからの注文拒否を検証する
  - 観測可能な完了条件: セッション終了後に旧セッションIDで送信した注文がすべて拒否されることがテストで確認される
  - 観測可能な完了条件: 人数変更の確認モーダルで確認すると卓マップの人数表示が変わることがテストで確認される
  - _Requirements: 1.9, 3.1, 3.4, 3.5, 4.2, 4.4, 5.4, 5.5, 5.6, 7.1, 7.2, 7.3_
  - _Depends: 9.2_

## Implementation Notes
- 開発環境ではDockerがWSL2「Ubuntu」ディストリビューション内でのみ動作する（Windows側にDocker Desktopなし）。Supabase CLIは同ディストリビューション内`~/bin/supabase`にインストール済みでログインシェルのPATHに登録済み。`supabase`系コマンドは必ず `wsl -d Ubuntu -e bash -lc "cd '/mnt/c/Users/shunsuke-iida/Documents/VSCode/Restaurant Order System' && supabase <args>"` 経由で実行する。日常操作は`package.json`の`db:start`/`db:stop`/`db:reset`/`db:types`スクリプト（1.2で追加済み）がこの経路をラップしているのでそちらを使う。
- Supabase CLI 2.117.0はローカル起動時にキーを「Publishable」「Secret」として表示するが、内部的には引き続きレガシーのJWT形式`anon`/`service_role`キーと同等に扱われ、`anon`ロール経路はPublishable keyで正しく解決されることを1.2のレビューで実機検証済み。ただし`authenticated`ロール＋`device_role`カスタムクレームの経路（Custom Access Token Hook, DeviceIdentityProvider）は未検証であり、`supabase/config.toml`は現在`auth.enable_anonymous_sign_ins = false`（デフォルト）になっている。**タスク2.1（Custom Access Token Hook）着手時に、匿名サインインを有効化した上でdevice_roleクレームがセッションJWTに正しく含まれることを実機で確認すること。**
- 1.3でPostgres連携の統合テスト（`pg`クライアント）を追加した結果、`npm test`はローカルSupabaseスタック（`npm run db:start`）が起動していないと失敗する（ECONNREFUSED、フェイルファストで原因は明確）。本プロジェクトはPostgres RPCが中心のためこれは許容し、各タスクの実装者は作業前に`npm run db:start`を実行すること。RPCタスク（3.x/4.x）でテスト本数が増えてきたら、`test:unit`（DB不要・高速）と`test:integration`（DB必須）へのスクリプト分割を検討する。
- 2.3で判明：`vitest.config.mts`は元々`.env.local`を`process.env`へロードしていなかった（Vite/Vitestの既定動作では`.env.local`は自動ロードされない）。修正済み（`loadEnv`をマージ、シェル/CI環境変数が優先されるよう順序を維持）。この修正前は、統合テストが`process.env.X ?? "<ハードコードされたfallback値>"`という書き方をしていると、実際には常にfallback値でテストしていた（`.env.local`の値と偶然一致していただけ）。**今後、環境変数に依存する新しいテストを書く際は、ハードコードされたfallback値を使わず、値が未設定なら`beforeAll`等で明確なエラーを投げてfail-fastすること**（シークレット的な値の場合は特に、fallbackがgit管理ファイルへの平文漏洩の抜け道になる）。
- `src/lib/gateways/customerOrderingGateway.ts`（3.4）の各メソッドは、ドキュメント化されたエラーコード以外の予期しないエラー（ネットワーク断等）を`Result`に含めず例外としてthrowする（`src/lib/result.ts`/`useDeviceIdentity.ts`から続く既存の規約）。**そのため6.x（CustomerOrderApp UI）でこのゲートウェイを呼び出す際は、必ずtry/catchで例外を捕捉すること**（Reactのエラーバウンダリはイベントハンドラ内の非同期例外を自動捕捉しないため、素通りすると画面に何も表示されないまま失敗する）。
- 3.5のレート制限は、PL/pgSQLの1関数呼び出し=1トランザクションという性質上、セッション有効性/売り切れ等の検証で`RAISE EXCEPTION`する呼び出しはカウンタへのUPSERTごとロールバックされ、集計対象にできない（意図的なv1スコープの割り切りとしてレビュー済み・承認済み）。有効なセッション・品目に対する大量送信のみが対象。同一セッションからの`submit_order`はカウンタ行のロックにより直列化されるため、将来1卓あたりの同時注文数が大きく増える場合はレイテンシへの影響を再検討すること。
- タスク5で判明：Realtimeの`postgres_changes`は(a)対象テーブルが`supabase_realtime` publicationに登録されていること、(b)購読側ロールがRLSでSELECT可視であること、の両方が必要（片方だけでは配信されない、または中身の無いエラーメッセージのみ配信される）。`order_items`/`table_sessions`/`call_requests`のSELECT権限は`authenticated`（kitchen/register）にのみ付与し、**`anon`（客）には意図的に付与していない**——`using(true)`はanonにJWTクレームが無い以上「制限なし」と同義であり、Realtimeの`filter`パラメータはクライアント側の任意ヒントに過ぎず生のwebsocket呼び出しで省略できるため、店舗全体の注文明細（品目名・数量・金額・session_id等）が漏洩しうる。CustomerOrderApp（6.x）で確定注文合計のリアルタイム更新を実装する際は、`anon`にorder_itemsのSELECTを広げるのではなく、(1) Realtime Broadcast + `realtime.messages`をsession_idトピックでRLSスコープする方式、または(2) `get_ordering_context`の単純ポーリング、を検討すること。第三の案として、GRANTなしでpublicationにだけ追加すると中身の無い「変更があった」シグナルのみ配信されることを確認済みだが、これは`realtime.apply_rls`の内部実装詳細に依存するため6.x着手時に再検証すること。
- 4.1で確認：`0004_rpc_staff_gateway.sql`は`0006_assert_device_role.sql`（ファイル名順で後に適用される）の関数を呼び出すが、これは問題ない。PL/pgSQL関数は本体を`CREATE FUNCTION`時にコンパイルせず、初回呼び出し時に初めて解決するため（`check_function_bodies=on`でも前方参照は許容される、Postgres公式ドキュメントで確認済み）。実機の`db:reset`でも実証済み。4.2-4.5は同じ`0004`ファイルに追記していく計画なので基本的に再検討不要だが、新しい番号のマイグレーションファイルを追加する場合はこの前提（呼び出し先の関数は「全マイグレーション適用後の初回呼び出し時点」で存在していればよい）を踏まえること。
- 6.2で発覚・修正：冪等性キー（idempotencyKey）は「送信試行1回分＝その時点のカート内容」に厳密に紐付ける必要がある。カート内容が変わった時点で保留中のキーを破棄せず使い回すと、ネットワーク断で再送信した際に新しく追加した品目がサーバーに送信されないまま「送信完了」と表示される（旧キーでdeduplicateされ、旧内容の注文がそのまま返るため）バグがあった。修正済み（カート変更の唯一の経路`handleConfirmSelection`でキーをリセット）。**既知の残存リスク（本タスクのスコープ外、要追加インフラ）**: 直前の送信がサーバー側では実は成功していたがレスポンスだけ失われた場合に、カートへ品目を追加してから再送信すると、新しいキーによる別注文が発行され直前の注文と品目が重複しうる（二重注文）。解消には再送信前に既存キーでの結果を確認する調停処理が必要。レジ側で重複に気づいた場合は`removeOrderItem`で対応可能。
- 6.2で確定：CustomerOrderAppの確定注文合計ライブ更新は、Realtimeの`postgres_changes`購読ではなく`getOrderingContext`の定期ポーリング（5秒間隔）で実現する（`anon`に`order_items`等のSELECTを許可しないという上記タスク5の判断と両立させるため）。design.mdの該当箇所（CustomerOrderApp要約・RealtimeFeed Event Contract）も合わせて修正済み。
- 6.3で判明・修正：ポーリングと楽観的UI更新を同じ画面で併用する場合、送信中（in-flight）のポーリング応答が後から届いて楽観的更新を巻き戻すレース条件に注意すること。`getOrderingContext`を3度目に拡張（`hasOpenCallRequest`追加）し、呼び出しボタンの楽観的「呼び出し中」状態とポーリング結果が競合しうることが判明。修正はタイマー/ヒューリスティックではなく単調増加するシーケンスカウンタ（ポーリング送信時・楽観的更新時の両方でインクリメント）で「どちらが新しいか」を判定する方式を採用（`MenuScreen.tsx`）。同様のポーリング×楽観的更新パターンを他画面で使う場合はこの設計を踏襲すること。
- 6.4で判明・修正：同一卓で来店セッションが`closed→(no-session)→新規active`と切り替わる（要件4.4、客グループの入れ替わり）際、`cart`/`cartPanelOpen`/`submission`/呼び出しボタンのローカルエラー状態/`idempotencyKeyRef`のような「セッション単位のはずのクライアント状態」を明示的にリセットしないと、前の客グループのカート内容や表示中のエラーが新しい客グループの画面に残り続ける（前客との会計混同につながりうる重大なバグ）。修正は`sessionId`の変化を検知した時にのみ（同一セッション内のポーリングでは発火させない）これら全てを一箇所でリセットする方式（`MenuScreen.tsx`の`resetSessionScopedState`）。**セッションをまたいで永続させてよいクライアント状態は無い**という前提で、今後同様のセッションスコープの状態を画面に追加する場合はこのリセット機構に組み込むこと。
- 7.4で判明・対応：`stores`/`tables`の初期データが無いと`/setup`・`/kitchen`・`/order`等の実ブラウザ確認や一部のe2eテストが動かず、各タスクで`db:reset`のたびに手動でstore行を再投入する摩擦が続いていた（4.5のレビューでも`supabase/seed.sql`未整備が指摘済み）。`supabase/seed.sql`を追加し、`.env.local`の`NEXT_PUBLIC_STORE_ID`と一致する開発用store・table行を`db:reset`のたびに自動投入するようにした（Supabase CLIの標準機能、卓自体の登録・QRコード発行機能の実装ではないためdesign.mdのNon-Goalsに抵触しない）。以後は`db:reset`後の手動シードが不要。
- 7.4で判明：厨房タブレットが複数台ある場合、確認モーダル表示中に別端末が同じ品目の売り切れ状態を変更すると、確認時に送信する絶対値`soldOut`が古いままlost updateになりうる（`SoldOutBoard.tsx`のコメント参照）。単一操作の確認フローのみが要件のスコープのため対応していないが、7.5/8.xで同種の「絶対値を確認モーダルで確定する」パターンを再利用する場合は、確認実行前の最新状態の再検証を検討すること。
- 7.5で確立：品目ステータス更新（確認モーダル無し、要件6.5）は7.4の売り切れ操作（確認モーダル有り、要件7.1/7.3）とは異なる操作クラスであり、両者を混同しないこと。ステータス更新の「即時反映」は次ポーリングとの競合待ちではなく、RPC応答（`updateOrderItemStatus`が返す`OrderItemSummary`）をポーリング処理から独立して即座にローカル状態へマージする方式（`useAdvanceOrderItemStatus.ts`）。ジャンル×ステータスごとのボタン表示可否は`update_order_item_status`のサーバー側遷移許可ロジック（0004移行）と厳密に一致させる必要があり（一品のみ`received→done`直接ショートカットを持つ等）、UI側がRPCより緩い遷移を許すと`INVALID_TRANSITION`エラーの温床になる。この「ボタン表示条件をサーバー側許可ロジックと1:1で対応させる」設計は`OrderItemStatusActions.tsx`に集約し、8.x（RegisterConsoleのステータス変更UI）で同種のロジックが必要な場合はこの対応表の再利用・参照を検討すること。
- 7.6で確立：接続断表示（要件6.9）はKitchenBoardScreenで一度だけ`useRealtimeFeed`を配線する設計とした（FoodBoard/DrinkBoard/SoldOutBoard個別ではない）。理由は、"soldout"タブに切り替えるとフード/ドリンクボードがアンマウントされ、それぞれが独自に`useRealtimeFeed`を持つ設計だと接続状態インジケーター（固定ヘッダー内、mock-preview.htmlの`.screen-header`と同じ配置）がタブ切り替えのたびに消えてしまうため。`channelName`は`"kitchen-feed"`、`subscriptions`は`[{ table: "order_items" }]`のみとした（0008マイグレーションでkitchenロールがSELECT可能なのはorder_itemsのみで、table_sessions/call_requestsはregister限定のため購読しても配信されない）。再接続バナー（mock-preview.htmlの`reconnectNotice`と同じ文言・2200msの表示時間）は、`useRealtimeFeed`自身が「初回接続」と「再接続」を区別しない設計（タスク5で確立、呼び出し側の責務）であるため、KitchenBoardScreen側で`hasConnectedOnceRef`により「一度でもconnectedに到達したか」を保持し判定する。FoodBoard/DrinkBoardへの再同期シグナルは、`useRealtimeFeed`の`onSync`が呼ばれるたびに単調増加させる`resyncToken`を`resyncSignal`propとして渡す方式を採用した（6.3で確立した「タイマーではなくシーケンスカウンタで判定する」設計の再利用）。受け取り側（FoodBoard/DrinkBoard）は、この`resyncSignal`の変化を検知する処理を、既存のマウント時フェッチ+ポーリングeffect（依存配列`[gateway, storeId]`）とは完全に独立した新しいeffectとして実装した。`resyncSignal`をそちらのeffectの依存配列にそのまま加えると、変化のたびにeffect全体が再実行されて`load(true)`（初期ロード専用、失敗時に全画面エラーへ切り替える経路）が呼ばれ直してしまう退行になるため、意図的に分離した。既存のFoodBoard.tsx/DrinkBoard.tsx冒頭コメントが「7.6が配線した際はこのポーリングは置き換え/補完される想定」としていた分岐点については「補完」を選択し、5秒間隔ポーリングは変更していない（`useRealtimeFeed`の`status === "connected"`はwebsocketの生存確認に過ぎず、あらゆる見逃しイベントへの形式的な保証ではないため、厨房KDSという「画面が古いまま気づかれない＝注文の見逃し」が実運用上の事故に直結する製品では、低コストな二重の安全網を残す判断とした）。SoldOutBoard.tsx/SoldOutBoard.test.tsxは本タスクで一切変更していない（`menu_items`は0008マイグレーションでpublicationに登録されておらずRealtime配信の対象外であるため、そもそも再同期すべきシグナルが存在しない）。
- 7.6のレビューで発見・修正：上記の`resyncSignal`（店舗全体のorder_items変更のたびに高頻度で発火しうる）と、7.5のadvance()による即時ローカルマージ（`useAdvanceOrderItemStatus.ts`）が同一画面に共存することで、6.3と全く同じ形の競合が新たに生じていた——resyncSignal起点の背景フェッチがadvance()クリックより前に開始し、そのクリックのマージより後に解決すると、背景フェッチが持つ古いスナップショット（クリック前のstatus）で`setState({status:"ready", items: ...})`が該当品目を含む配列全体を丸ごと置き換えてしまい、たった今マージしたばかりの新しいstatusを古いstatusへ巻き戻してしまう。5秒ポーリング単独でも理論上は起こり得た潜在バグだが、resyncSignalは店舗全体の変更で高頻度に発火するため発生確率が大幅に上がり、7.6で実質的に顕在化した。修正は6.3と同じ「タイマーではなく単調増加するシーケンスカウンタで判定する」設計を再利用: `FoodBoard.tsx`/`DrinkBoard.tsx`に`mutationSeqRef`（advance()の`updateItems`が呼ばれるたびにインクリメント）を追加し、`load()`（マウント時+ポーリング）と`resync()`（resyncSignal起点）の両方でフェッチ開始時点の値を記録、フェッチ解決時に値が変わっていれば（＝フェッチ中にローカルマージが発生した）そのフェッチの結果は破棄して次回のフェッチに委ねる。回帰テストは`FoodBoard.test.tsx`（タスク7.6のdescribe内）に追加済み。**この設計判断を再利用する際の注意**: 「背景フェッチが確定済みローカル状態全体を無条件で置き換える」パターン（`setState({status:"ready", items: fetchedItems})`のような丸ごと置換）と「ユーザー操作起点の即時ローカルマージ」パターンが同一コンポーネントに共存する場合は必ずこの競合を疑うこと。8.x（RegisterConsole）で同様に背景再取得＋ローカル即時反映を組み合わせる場合は、実装時点から`mutationSeqRef`と同種のガードを組み込むこと（事後発見ではなく設計時点で織り込む）。
- 8.1で確立：`RegisterConsoleScreen.tsx`（デバイスセッション確認のみを担う薄いラッパー）と`FloorMap.tsx`（卓マップ本体。マウント時フェッチ+`REGISTER_FLOOR_MAP_POLL_INTERVAL_MS`＝5000msの簡易ポーリング、KitchenBoardの7.2/7.3と同型）に分割した。KitchenBoardScreenと異なり、「卓マップ／全N卓」ヘッダーはScreen側ではなくFloorMap側に持たせた（卓の総数はFloorMapが取得したlistRegisterFeedの結果からしか導出できず、タブ間で共有すべき画面レベルの状態がRegisterConsoleにはまだ存在しない――Realtime配線・接続断表示は9.2のスコープ――ため、KitchenBoardScreenのように画面レベルへ巻き上げる理由が無い）。8.2以降でタイル選択時の詳細パネルを追加する際、この分割（Screen=デバイスゲート、FloorMap=表示本体）にどう組み込むかは実装者の判断に委ねる。
  - **エリア分けの境界値**: `tables.label`はスキーマ上T/C接頭辞を強制されない（design.mdのNon-Goals通り卓登録機能自体が本spec範囲外）ため、`/^T/`にも`/^C/`にも一致しないラベルが来てもクラッシュしないよう3つ目の「その他」区分を設け、該当卓が無ければ区分自体を描画しない設計にした。実際の開発データ（seed.sql）はT/Cのみのため、これは主に将来の運用データに対する防御的な設計判断であり、テスト（`FloorMap.test.tsx`）でも明示的にカバーしている。
  - **金額フォーマットの境界越えimportを避けた**: `formatYen`は`src/app/order/[tableId]/formatYen.ts`（CustomerOrderApp境界）に既存のものがあるが、SoldOutBoard.tsx（KitchenBoard境界、7.4）が同じ理由でロジックを複製した前例に倣い、`FloorMap.tsx`でも同じ表記をローカルに複製した（RegisterConsole境界からCustomerOrderApp境界への物理的なimportを避ける）。3画面共通の金額フォーマッタを`src/lib/`へ切り出す方が本来はDRYだが、design.mdのBoundary Contextを跨ぐ共有モジュールの導入は本タスクの範囲を超える判断のため見送った。8.x/9.xで3箇所目の重複が発生した場合は共通化を検討すること。
  - **テスト環境の落とし穴（`vi.useFakeTimers()` + RTLの`findBy*`）**: `findByTestId`等のRTL非同期クエリは内部で`setTimeout`ベースのポーリングを行うため、`vi.useFakeTimers()`有効時に`findBy*`を呼ぶとタイマーが一切進まず必ずタイムアウトする（KitchenBoardScreen.test.tsxの7.6ブロックは元々この落とし穴を踏まずに済んでいたが、明示的な注意書きは無かった）。本タスクで実際に1件のテストがこれで5秒タイムアウトし判明した。回避策はKitchenBoardScreen.test.tsxの7.6ブロックと同型: `render`直後に`await act(async () => { await vi.advanceTimersByTimeAsync(0); })`でマウント時の非同期処理を先に流してから、同期的な`getByTestId`（`findBy*`ではなく）を使う。8.2以降で確認モーダル等のタイマー依存挙動をテストする際はこのパターンを踏襲すること。
- 8.2で確立：卓詳細パネル（`TableDetailPanel.tsx`、新規）と入店操作（`useCheckIn.ts`、新規フック）を追加した。8.1が予告していた通り、`FloorMap.tsx`のタイルを非対話的な`<div>`から`<button>`へ変更し、`selectedTableId`をFloorMap側に持たせた（`state.tables`から都度`find`した最新の`TableBillingSummary`をパネルへ渡すことで、要件5.3のライブ反映を新規ポーリングなしに満たす。design decision D）。
  - **`mutationSeqRef`の適用（7.6と同型）**: `startSession`成功時のローカルマージ（`mergeStartedSession`）と、既存の5秒背景ポーリングが同一コンポーネント内で共存するため、7.6が確立した単調増加シーケンスカウンタによる競合防止をそのまま適用した（8.1完了時点のコメントが「8.2以降が追加する場合は設計時点から織り込むこと」と予告していた通り）。回帰テストは`FloorMap.test.tsx`の「check-in成功より前に開始した背景ポーリングが...」に追加し、`FoodBoard.test.tsx`の7.6ブロックと同型の「解決を保留したフェッチ→ローカルマージ→保留フェッチの遅延解決→マージ結果が生き残ることを確認」という構造をそのまま踏襲した。
  - **`startSession`応答の合成（design decision A）**: `TableSession`（`items`/`total`/`hasOpenCallRequest`を持たない）から`TableBillingSummary`を合成する際、`items: []`・`total: 0`・`hasOpenCallRequest: false`を採用した。新規発行直後のセッションは定義上まだ注文・呼び出しを持ちえないため安全（`FloorMap.tsx`の「タスク8.2での更新」コメント参照）。
  - **`SESSION_ALREADY_ACTIVE`（要件3.2）**: 二重入店操作（複数レジ端末・誤操作）で実際に起こりうるエラーとして、専用メッセージ（「既に有効な来店セッションが存在します。新しい来店として登録されませんでした。卓マップの表示をご確認ください。」）を表示し、`mergeStartedSession`を呼び出さず`FloorMap`の`state`を未変更のまま次回ポーリングに委ねた（既存セッションの実際の人数を知らないため、占有中状態を推測で偽装しない）。`TABLE_NOT_FOUND`/`FORBIDDEN`は`useAdvanceOrderItemStatus.ts`と同型の共有汎用メッセージへ倒した。実ブラウザでの検証（後述）で、エラー発生時にパネルの人数ステッパー表示自体は（`startingSession`のリセットを行わないため）開いたまま残ることを確認した——これはローカルUI状態の話であり、要件3.2が求める「FloorMap側のサーバー状態を書き換えない」という制約とは独立した実装判断である（ユーザーが再試行するかキャンセルするかを選べる、意図的な挙動）。
  - **確認モーダルを設けない（design decision C）**: 要件3.1には3.3/3.5/5.5-5.7の「実行前に確認を求め」が無いため、人数ステッパー＋「入店する」ボタンのみで確定とし、二重確認は追加していない。
  - **人数の下限・デフォルト（design decision E）**: デフォルト2（mock-preview.htmlの`ru.partySizeDraft`初期値と一致）、下限1（0人以下を許容する意味が無いため）。上限は要件が定めないため設けていない。
  - **mock-preview.htmlとの既知の乖離（`optionsSummary`/`status`を表示しない）**: `tableDetailHtml`は各明細行にオプション概要とステータスラベルを表示するが、実際の`list_register_feed`（0004_rpc_staff_gateway.sql、設計判断21以降）が返す`TableBillingSummary.items`は`{menuItemId, name, quantity, unitPrice}`の4フィールドのみでありオプション概要・ステータスを持たない。本タスクのGit hygiene制約（ゲートウェイ・マイグレーション変更は対象外）により、実際に取得可能なフィールドのみを表示した（`TableDetailPanel.tsx`冒頭コメント参照）。将来この情報が必要になった場合は`list_register_feed`のRPC自体の拡張（レビュー・再検証を要する）が必要になる。
  - **呼び出し中バナー（要件2.2データの再利用）**: `hasOpenCallRequest`が真の場合に案内バナーのみを表示し、「対応済みにする」ボタンは呼び出し対応（8.6）のスコープのため一切表示していない。
  - **実ブラウザ検証**: 使い捨てのPlaywrightスペック（`e2e/register-checkin.manual-verification.spec.ts`、検証後に削除しリポジトリには残していない）で、(a) 空席卓への入店（人数3で確定）が即座にタイルへ反映されること（ポーリング待ちでないこと）、(b) 占有中パネルの読み取り専用表示（人数・経過時間・明細0件・合計¥0）、(c) 人数入力中に別端末が同じ卓へ先に入店した場合の`SESSION_ALREADY_ACTIVE`警告表示とローカル状態不変、の3点をローカルSupabaseスタックに対して確認した。検証後、作成したセッション・デバイスはDB直接操作で削除しクリーンな状態に戻した。
  - **8.2レビューでの指摘（非ブロッキング、要フォローアップ）**: (1) `checkInError`の`tableId`タグがパネル描画時に実際にチェックされている（別の卓を選択中は前の卓のエラーが表示されない）ことはコードレビューで確認済みだが、これを直接検証する回帰テストがまだ無い。今後この境界を触るタスクでは追加を検討すること。(2) より重要な指摘: **`TableBillingSummary.items`（`list_register_feed`が返す）には注文明細の`id`（`order_items.id`）が一切含まれない**（`{menuItemId, name, quantity, unitPrice}`の4フィールドのみ、`menuItemId`は同一注文内で重複しうるため一意識別子にならない）。次タスク8.3（品目の追加・削除UI）は`removeOrderItem({orderItemId})`の呼び出しにこの`id`を必要とするため、**現状の`list_register_feed`のレスポンス形状のままでは8.3が実装不能**。8.3着手前（またはその一部として）、`list_register_feed`（0004_rpc_staff_gateway.sql）と`TableBillingSummary.items`の型定義（design.md・staffOperationsGateway.ts）に`id`フィールド（可能であれば併せて`optionsSummary`/`status`も、mock-preview.htmlとの表示乖離解消のため）を追加する拡張が必要。これは`list_kitchen_feed`が4.1〜4.5・7.2にかけて段階的にフィールドを追加してきた前例と同型の対応であり、新しいマイグレーションファイル（`CREATE OR REPLACE FUNCTION`）として追加すること（既存マイグレーションの編集は不可）。
- 8.3で確立：8.2レビューが必須前提として記録していた`list_register_feed`の拡張（`0012_list_register_feed_item_id.sql`）を実施し、`TableBillingSummary.items`へ`id`（`removeOrderItem`の対象指定に必須）・`optionsSummary`・`status`を追加した（`status`は8.4向けの値の先取りで、本タスクのUI自体はジャンル情報を持たないため画面には表示しない）。加えて、`0011_list_menu_items.sql`冒頭コメントが本タスクへ判断を委ねていた「`list_menu_items`をregisterへ開放するか、別RPCを新設するか」の論点についても対応し（`0013_list_menu_items_register_options.sql`）、別RPCを新設せず既存の`list_menu_items`の`assert_device_role`対象を`['kitchen']`から`['kitchen','register']`へ拡大する方式を選んだ（店舗の全`menu_items`を返すという同一のクエリロジックを複製するのはSimplification原則に反するため）。同時に`imageUrl`/`options`を追加し、`MenuItemListing`を`MenuItemView`と構造的に一致させた——これは、客側の`OptionSelectionPanel.tsx`（`{item, onCancel, onConfirm}`のみを取るゲートウェイ非依存の純粋なプレゼンテーションコンポーネント、タスク6.1）をレジの品目追加フローへそのまま再利用する設計判断のためであり、216行の非自明なchoice/toggle/counter UIロジックを複製する（`formatYen`のような1行ヘルパーの複製とは質的に異なる規模・リスク）ことを避けた。品目追加・削除の確認モーダルは`SoldOutBoard.tsx`（7.4）と同型だが、Boundary Contextを跨ぐ物理importを避けるため`ConfirmDialog.tsx`としてRegisterConsole境界内に複製し（`formatYen`の前例と同じ理由）、本タスクで2箇所目の利用が生まれた時点で1コンポーネントへ集約した（7.6 Implementation Notesの「3箇所目の重複が発生したら共通化を検討する」方針に基づき、2箇所目で先に集約したのは確認モーダルという性質上の重要度判断）。品目追加・削除いずれの成功時マージも、8.2で確立した`mutationSeqRef`ガードを継続適用し、`total`はサーバー値の直接利用ではなく`unitPrice*quantity`の加減算で再計算する（`list_register_feed`の`total`集計式と同じロジックをクライアント側で個別マージ時に再現するため。要件5.5/5.6が求める「表示中の明細・合計の即時更新」と、既存ポーリングとの競合防止を両立させる）。
  - **8.3レビューでの指摘（非ブロッキング、要フォローアップ）**: (1) `useAddOrderItem.ts`の`ITEM_SOLD_OUT`分岐（追加確定と厨房の売り切れ登録が競合するケース）自体は正しく実装されていることをレビューで確認済みだが、この分岐を実際にモックのRPCエラー応答で駆動する永続的な回帰テストがまだ無い（既存テストは結果メッセージを静的propsとして渡すのみで、フック自身のエラーマッピングロジックを経由しない）。今後この分岐を触るタスクでは追加を検討すること。(2) `supabase/seed.sql`はオプション付きmenu_itemsを一切シードしないため、オプション選択を伴う品目追加のDB往復（`order_items.options_selected`/`options_summary`への実際の永続化）を実ブラウザで確認できていない（コンポーネントレベルでの`OptionSelectionPanel`実駆動テストと、4.2で作成済みの`addOrderItem`結合テストのオプション永続化カバレッジを組み合わせて十分と判断したが、真のエンドツーエンド確認ではない）。オプション付き品目のシードデータ整備は将来のタスクで検討の余地がある。
- 8.4で確立: 8.2/8.3レビューが必須前提として記録していた`list_register_feed`の再拡張（`0014_list_register_feed_item_genre.sql`）を実施し、`TableBillingSummary.items`へ`genre`を追加した（`list_kitchen_feed`と同一の`join public.menu_items mi on mi.id = oi.menu_item_id`パターン）。これにより、mock-preview.htmlの`statusLabel(genre, status)`と同じジャンルに応じた日本語ステータス表示（フード/一品: 未対応/調理中/調理完了、ドリンク: 未対応/対応済み）が初めて可能になった（`TableDetailPanel.tsx`の`orderItemStatusLabel`）。
  - **確認モーダルの非対称性（要件5.7 vs 要件6.5）**: KitchenBoardの同等操作（品目ステータス更新、要件6.5、タスク7.5）は明示的に確認モーダルを持たない設計だったが、レジの同操作は要件5.7が「実行前に確認を求め」と明記するため、`ConfirmDialog.tsx`（8.3で確立済み）による確認を挟む。7.5 Implementation Notesが警告した「両者は異なる操作クラスであり混同しないこと」を踏まえ、KitchenBoard側（`useAdvanceOrderItemStatus.ts`）は一切変更していない。
  - **ボタン構成の設計判断（一品ショートカットを持たない、mock-preview.htmlとの整合）**: mock-preview.htmlのレジ側`tableDetailHtml`が検証済みの通り、レジは単一の「進める」ボタン（1品目につき常に高々1個、次ステータスが無い`done`では非表示）のみを持ち、KitchenBoardの一品`received→done`直接ショートカット（要件6.6）は意図的に持たない。理由: (1)検証済みのUXリファレンス（mock-preview.html）がそう設計している、(2)レジスタッフが会計確認のついでにステータスを進める操作は、厨房の速度優先ショートカットとは異なるユースケースであり、要件5.7・design.mdのいずれもレジ側にショートカットを要求していない。
  - **ドリフト防止のための共有関数抽出（`resolveNextOrderItemStatus`）**: ジャンル×現在ステータス→次ステータスの判定ロジックは、`update_order_item_status`（0004_rpc_staff_gateway.sql）の許可遷移表と1:1対応させる必要がある正確性クリティカルなロジックであり、7.5 Implementation Notesが「8.xで同種のロジックが必要な場合はOrderItemStatusActions.tsxとの対応表の再利用・参照を検討すること」と明示的に予告していた。`OptionSelectionPanel`（8.3、216行）ほどの複製コストは無いためコピーという選択肢もあったが、まさに「サーバー側ルールとUIの1:1対応がドリフトする」典型的なリスクケースであるため、`src/lib/orderItemStatusTransitions.ts`の`resolveNextOrderItemStatus(genre, status)`という小さな純粋関数として抽出し、KitchenBoardの`OrderItemStatusActions.tsx`もこれを呼ぶよう改修した（一品の直接ショートカットは共有関数の責務に含めず、`OrderItemStatusActions.tsx`にローカルに残した——ショートカットはKitchenBoard専用のUXのため）。この改修による`OrderItemStatusActions.tsx`の出力（ボタンラベル・次ステータス・順序）は一切変化しないことを、既存の`FoodBoard.test.tsx`/`DrinkBoard.test.tsx`（62件、無回帰）で確認した。`orderItemStatusTransitions.test.ts`に全9通り（3ジャンル×3ステータス）のテーブル駆動テストを追加し、RPC側の許可遷移表（0004コメント）とのドリフトを監視する唯一の参照点とした。
  - **`mutationSeqRef`の適用（4つ目のローカルマージ経路）**: ステータス変更成功時のローカルマージ（`mergeUpdatedItemStatus`、`FloorMap.tsx`）は、既存の5秒背景ポーリング・check-in（8.2）・品目追加/削除（8.3）と同一コンポーネント内で共存するため、7.6が確立した`mutationSeqRef`ガードをそのまま適用した（8.2/8.3 Implementation Notesが「新しい局所的マージ経路は必ず同じガードを適用すること」と予告していた通り）。回帰テストは`FloorMap.test.tsx`に「ステータス変更成功より前に開始した背景ポーリングが...」を追加した（8.2/8.3の回帰テストと同型）。
  - **`mergeAddedItem`（8.3）の副作用的な修正**: `TableBillingSummary.items`が`genre`を必須フィールドとして持つようになったため、`addOrderItem`成功時のローカルマージ（`mergeAddedItem`、8.3で確立済み）も更新が必要だった。`addOrderItem`が返す`OrderItemSummary`自体はgenreを含まない（客側`submitOrder`等とも共有する型であり、拡張するとBoundaryを超える影響範囲になるため見送った）ため、同一コンポーネント内で既に取得済みの`menuItemsState`（品目追加リスト用）から`menuItemId`一致でgenreを引く方式とした。万一見つからない場合は`"food"`へ暫定フォールバックし、次回の背景ポーリングが権威的な値で補正するのに委ねる（8.2/8.3が確立した「ドキュメント化された業務エラー時はローカル状態を次回ポーリングに委ねる」既存方針と同じ考え方）。
  - **エラー方針（要件E）**: `INVALID_TRANSITION`（他端末との競合、実際に起こりうるレース）は`useAdvanceOrderItemStatus.ts`（KitchenBoard、7.5）と同型の汎用メッセージ表示＋ローカル状態不変とした（要件5.7がコード別の個別文言分岐を求めないため）。`ORDER_ITEM_NOT_FOUND`/`FORBIDDEN`も同じ汎用メッセージへ倒す（`useAddOrderItem.ts`/`useRemoveOrderItem.ts`と同じ考え方）。
  - **`useAdvanceOrderItemStatus.ts`を再利用しない判断**: KitchenBoard版は確認モーダル無し前提でクリック直後に即座にRPCを呼ぶ設計であり、レジ側は確認モーダルの応答待ちのため`Promise<void>`を返す契約が必要——両者は名前は似るが契約が異なるため、`useAddOrderItem.ts`/`useRemoveOrderItem.ts`と同型の新規フック`useUpdateOrderItemStatus.ts`として実装した（タスク文書が明示的に指示した設計判断）。
  - **実ブラウザ検証**: 使い捨てのPlaywrightスペック（`e2e/register-status-change.manual-verification.spec.ts`、検証後に削除しリポジトリには残していない）で、レジデバイスの実プロビジョニング→T1への入店→food/drink品目の投入→(a) foodジャンルの品目が未対応→調理中→調理完了と2段階で進み、各段階でDB直接問い合わせにより`order_items.status`のサーバー側永続化を確認、(b) drinkジャンルの品目が未対応→対応済みの1段階（in_progressを経由しない）で進むこと、(c) 確認モーダルの「いいえ」でステータス表示・DB上のstatusのいずれも変化しないこと、をローカルSupabaseスタックに対して確認した（ippinジャンルはfoodと同一の遷移ロジックのため実ブラウザでは未検証だが、`orderItemStatusTransitions.test.ts`のテーブル駆動テストで網羅済み）。検証後、作成したセッション・デバイス・menu_itemsはテストのafterAllで削除し、DB上に残留が無いことをクエリで確認した。
- 8.5で確立: 会計操作（確認モーダル・セッション終了）を実装した。`closeSession`は既存のRPC/TypeScriptラッパー（4.1/4.6）をそのまま利用し、新しいマイグレーション・型拡張は不要だった（タスク文書の予告通り）。
  - **確認モーダルの文言（要件3.3）**: タスク文書が指定する文言そのまま「お会計完了でよろしいですか？完了するとQRコード情報がリセットされます」を`TableDetailPanel.tsx`の`CHECKOUT_CONFIRM_MESSAGE`として1箇所に定義し、言い換えていない（mock-preview.htmlの`requestCloseSession`は同内容を`\n`で2行に分けているが、タスク文書の指定文字列自体には改行が無いため、そのまま単一文字列として使用した）。確認ボタンのラベルは「お会計完了」（mock-preview.htmlの`confirmLabel`と一致）。ボタン自体は「会計（退店）」ボタンとしてOccupiedView（来店中のビュー）にのみ表示し、空席時は表示しない。
  - **空席状態への合成（design decision、8.2の鏡像変換）**: `mergeStartedSession`（8.2、占有中への合成: `items:[]`・`total:0`・`hasOpenCallRequest:false`）の逆方向として、`FloorMap.tsx`の`mergeVacatedTable`は`closeSession`成功後に対象卓を`activeSession:null`・`items:[]`・`total:0`・`hasOpenCallRequest:false`へ合成する。安全性の理由も対称的（タスク文書が明記する通り、アクティブセッションが無い卓は現在の占有表示という観点では注文・呼び出しを持ちえない——閉じたセッション自体の過去の注文はDBに残り続け、要件4.3の履歴保持とは独立）。
  - **本タスクが8.2/8.3/8.4と異なる点（パネルを閉じる）**: 8.2/8.3/8.4のマージ関数（`mergeStartedSession`/`mergeAddedItem`/`mergeRemovedItem`/`mergeUpdatedItemStatus`）はいずれも成功後もパネルを開いたまま更新後の状態を表示したが、本タスクの観測可能な完了条件「卓詳細パネルが閉じて卓マップ画面が表示され、対象卓が空席状態になる」はパネルを閉じることそのものを要求する。そのため`mergeVacatedTable`は`state.tables`の空席化に加えて`setSelectedTableId(null)`を1箇所で併せて行う唯一のマージ関数とした（`useCloseSession.ts`/`FloorMap.tsx`冒頭コメント参照）。
  - **`mutationSeqRef`の適用（5つ目のローカルマージ経路）**: 会計成功時のローカルマージ（`mergeVacatedTable`）も、既存の背景ポーリング・check-in（8.2）・品目追加/削除（8.3）・ステータス変更（8.4）と同一コンポーネント内で共存するため、7.6が確立した`mutationSeqRef`ガードをそのまま適用した。回帰テストは`FloorMap.test.tsx`に「会計成功より前に開始した背景ポーリングが...」を追加した（7.6/8.2/8.3/8.4の回帰テストと同型）。
  - **`SESSION_NOT_ACTIVE`（要件E、実際に起こりうるレース）**: 別のレジ端末や二重操作による同一セッションへの先行会計というレースで実際に起こりうるため、`useCheckIn.ts`のSESSION_ALREADY_ACTIVEと同型の専用メッセージ（「このセッションは既に会計処理済みです。卓マップの表示をご確認ください。」）を表示し、`mergeVacatedTable`を呼び出さない（ローカル状態を強制的に空席へ書き換えたりパネルを強制的に閉じたりしない、次回の背景ポーリングに委ねる）。`FORBIDDEN`は`register`ロール限定という前提により防御的にしか到達せず、共有の汎用メッセージへ倒した（`useAddOrderItem.ts`等と同じ考え方）。
  - **新規フック`useCloseSession.ts`**: `useAddOrderItem.ts`/`useRemoveOrderItem.ts`/`useUpdateOrderItemStatus.ts`と同型（呼び出し関数・エラーメッセージ・クリア関数を返す、確認済みの呼び出しのみを受け取り例外を再送出しない`Promise<void>`）で実装した。`useUpdateOrderItemStatus.ts`冒頭コメントが検討したのと同じ理由（確認モーダルの応答待ちという契約）でKitchenBoard側のフックとは共有しない。
  - **実ブラウザ検証**: 使い捨てのPlaywrightスペック（`e2e/register-checkout.manual-verification.spec.ts`、検証後に削除しリポジトリには残していない）で、レジデバイスの実プロビジョニング→T1への入店（人数3）→food品目1件の追加→(a) 会計（退店）確認モーダルの「いいえ」でパネルが開いたまま・DB上のセッションが引き続き`active`であることを確認、(b) 同モーダルでタスク文書の指定文言がそのまま表示されることを確認、(c) 「お会計完了」確定でパネルが閉じ卓マップのT1タイルが「空席」表示になること、(d) DB直接問い合わせで当該セッションの`status`が`closed`・`closed_at`が設定済みであることを確認した。検証後、作成したセッション（`closed`へ更新）・デバイス・menu_itemsは削除し、DB上に残留が無いことをクエリで確認した（初回実行時にafterAllのクリーンアップ順序の不備でFK違反が出たため、`order_items`を先に削除してから`menu_items`を削除する順序に修正し、再実行で解消を確認した）。
- 8.6で確立: 呼び出し対応UIを実装した。
  - **確認モーダルを設けない（本タスクの最重要判断）**: 要件2.4「レジスタッフが呼び出しに対応済みとして操作する、当該呼び出し通知を対応済みとして扱い、通知表示を消去する」には、要件3.3（会計操作）・3.5（人数変更）・5.5-5.7（品目追加/削除/ステータス変更）に共通する「実行前に確認を求め」という文言が一切無い。8.3〜8.5の4つのレジ側書き込み操作が例外なく`ConfirmDialog`を経由していたパターンに引きずられて機械的に確認モーダルを追加しないよう、requirements.mdの実際の文言をタスク着手時に読み直して確認した上での判断である（KitchenBoardの品目ステータス更新—要件6.5、`useAdvanceOrderItemStatus.ts`、タスク7.5—が同じ理由で確認モーダルを持たないのと同型。「レジの書き込み操作は必ず確認モーダルを伴う」という表面的なパターンではなく、各要件の正確な文言が確認モーダルの要否を決めるという、本specが7.5/8.4で既に踏襲してきた原則を再確認した）。「対応済みにする」タップは`resolveCallRequest`を直接呼び出す。
  - **前提作業（`list_register_feed`への`openCallRequestId`追加）**: `resolveCallRequest`（4.4で実装済み）は入力に`callRequestId`（`call_requests.id`そのもの）を要求するが、`list_register_feed`（0004→0012→0014と拡張済み）は卓ごとに真偽値の`hasOpenCallRequest`しか返さず、対象のIDを一切公開していなかった——8.2レビュー（`id`欠如で8.3が実装不能だった）・8.3（`0012_list_register_feed_item_id.sql`）・8.4（`0014_list_register_feed_item_genre.sql`）と全く同型のギャップである。新しいマイグレーション（`0015_list_register_feed_open_call_request_id.sql`）を追加し、既存の`hasOpenCallRequest`（真偽値の`exists(...)`サブクエリ）はそのまま残し、隣にスカラーサブクエリ（`select cr.id from call_requests cr where cr.session_id = ts.id and cr.status = 'open' limit 1`）を追加した。要件2.3が保証する「セッションあたりopenな呼び出しは高々1件」という不変条件（`create_call_request`の部分ユニークインデックス、0003設計判断7）により、`limit 1`は曖昧さ回避のための防御的措置に過ぎない。`hasOpenCallRequest`を変更せず維持したのは、8.1のFloorMap.tsxタイルの呼出バッジが引き続きこの真偽値のみを参照するため（後方互換の純粋加算）。
  - **新規フック`useResolveCallRequest.ts`の形状**: `useCheckIn.ts`/`useAddOrderItem.ts`等と同じ「呼び出し関数・エラー・クリア関数」の家族形状（`{resolveCall, resolvingTableId, resolveCallError, clearResolveCallError}`）を保ちながら、確認モーダルが無いため`useAddOrderItem.ts`等の「確認モーダルの応答を待つためPromiseをawaitする」契約ではなく、`useCheckIn.ts`/`useAdvanceOrderItemStatus.ts`（KitchenBoard、タスク7.5）と同型の「呼び出し元のonClickから直接呼び出され、処理中フラグ（`resolvingTableId`）で二重タップを防ぐ」構造を採用した。`useAdvanceOrderItemStatus.ts`は本フックの直接の構造的参照実装であり、KitchenBoard境界のフックであってもRegisterConsole側の設計判断に転用できることを再確認した（7.5 Implementation Notesが確立した「確認レスな即時実行」パターンの2度目の適用例）。
  - **`mergeResolvedCallRequest`がtableIdではなくsessionIdで対象卓を探す理由**: `resolveCallRequest`の成功応答（`CallRequest`）は`sessionId`を持つが`tableId`を持たない。他の5つのマージ関数（`mergeStartedSession`等）はいずれも呼び出し元が渡す`tableId`をそのままキーに`state.tables`を更新するが、本関数は応答が実際に運ぶ権威的な識別子（`sessionId`）と`table.activeSession?.id`が一致する卓を探して更新する。呼び出し元（`FloorMap.tsx`）は`selectedTable.tableId`を既に知っているため実害は無いが、`CallRequest`型の実際の形（`tableId`を持たない）に忠実な実装とした。
  - **8.1のバッジと8.2のバナーが単一の更新で同時に消える**: `FloorMap.tsx`のタイル描画（`hasOpenCallRequest`）とパネル描画（同じフィールド、および新しい`openCallRequestId`）はいずれも同一の`state.tables`を参照しているため、`mergeResolvedCallRequest`が`hasOpenCallRequest: false`・`openCallRequestId: null`へ更新する単一の呼び出しで両方が同時に消える。新しい同期機構は一切追加していない（本タスクの観測可能な完了条件「呼び出し対応操作を行うと通知表示が消える」を、FloorMap.test.tsxで両方の場所を独立にアサートして検証した）。
  - **`mutationSeqRef`の適用（6つ目のローカルマージ経路、7.6→8.2→8.3→8.4→8.5に続く6回目の適用）**: 呼び出し対応成功時のローカルマージ（`mergeResolvedCallRequest`）も、既存の5秒背景ポーリング・check-in・品目追加・品目削除・ステータス変更・会計と同一コンポーネント内で共存するため、同じ`mutationSeqRef`ガードをそのまま適用した。回帰テストは`FloorMap.test.tsx`に「呼び出し対応成功より前に開始した背景ポーリングが...」を追加した（7.6/8.2/8.3/8.4/8.5の回帰テストと同型）。
  - **エラー方針（要件E）**: `CALL_REQUEST_NOT_FOUND`（別のレジ端末による先行対応、または対応の合間の客セッション終了で実際に起こりうるレース）は`useCheckIn.ts`のSESSION_ALREADY_ACTIVEと同型の専用メッセージを表示し、`mergeResolvedCallRequest`を呼び出さない（ローカル状態のバナー・バッジを強制的に消去せず、次回の背景ポーリングに委ねる）。`FORBIDDEN`は`register`ロール限定という前提により防御的にしか到達せず、共有の汎用メッセージへ倒す。
  - **実ブラウザ検証**: 使い捨てのPlaywrightスペック（`e2e/register-call-resolve.manual-verification.spec.ts`、検証後に削除しリポジトリには残していない）で、レジデバイスの実プロビジョニング→T1への入店→直接SQLで`call_requests`行を1件投入（`status='open'`）→(a) 卓マップのT1タイルに呼出バッジが表示されること、(b) T1詳細パネルを開くと「呼び出し中」バナーと「対応済みにする」ボタンが表示されること、(c) ボタンタップ時に確認モーダルが一切表示されないこと、(d) タップ直後（再読み込み無し）にバナーが消え、パネルを閉じるとタイルの呼出バッジも消えていること、(e) DB直接問い合わせで当該`call_requests`行の`status`が`resolved`・`resolved_at`が設定済みであることを確認した。検証後、作成したセッション・デバイス・call_requestsは削除し、DB上に残留が無いことをクエリで確認した。
- 8.7で確立: 人数変更UI（確認モーダル）を実装した。タスク群8（RegisterConsole UI）の最終タスクであり、`updatePartySize`（4.1で実装済み）にすべて必要なものが揃っていたため、`StaffOperationsGateway`・マイグレーションいずれの変更も不要だった（着手前にstaffOperationsGateway.tsを読み直し、`UpdatePartySizeInput: {sessionId, partySize}`・戻り値`TableSession`・エラー`{SESSION_NOT_ACTIVE}|{FORBIDDEN}`が過不足なく揃っていることを確認済み）。
  - **確認モーダルが必要（要件3.5、8.6との対称性の再確認）**: requirements.mdを直接読み直し、要件3.5「レジスタッフが来店中の卓の人数を変更する操作を行う、実行前に確認を求め、確認された場合にのみ...人数を更新する」に「実行前に確認を求め」が明記されていることを確認した（8.6の要件2.4には無かった文言）。8.3〜8.5と同じ`ConfirmDialog.tsx`（RegisterConsole境界、8.3で確立済み）を再利用し、5つ目の呼び出し箇所とした。
  - **UI構成（design decision、2段階: ステッパー→ConfirmDialog）**: 卓詳細パネルの人数表示（`register-table-detail-occupancy`）の隣に「人数を変更」ボタンを設け、押すと現在の人数（`activeSession.partySize`、チェックイン時の既定値2ではない）を初期値とするステッパー（8.2の`VacantView`人数入力ステッパーと同じ−/＋操作・下限`MIN_PARTY_SIZE`=1を再利用）を表示する。8.3の`OptionSelectionPanel`（調整UI自身の「選択を確定」がそのまま要件5.5の確認を兼ね、別のConfirmDialogを重ねない設計）とは異なり、本タスクはタスク文書が独立した`ConfirmDialog`層を明示的に要求したため、ステッパーの「確定」ボタンは値を直接確定させず`ConfirmDialog`（人数を明記した文言「人数を${変更後の人数}名に変更しますか？」、確定ラベル「変更する」）を開く2段階構成とした。`ConfirmDialog`の「いいえ」はモーダルのみを閉じてステッパーを開いたまま維持し（品目削除・ステータス変更確認の「いいえ」が背後の明細一覧を維持するのと同型）、ステッパー自身の「キャンセル」は`onUpdatePartySize`を一切呼び出さずステッパーを閉じる（`VacantView`の`cancelStartSession`と同型、本タスクの観測可能な完了条件の裏面）。
  - **ステッパーを共有コンポーネントへ抽出しなかった判断（非抽出、理由を明記）**: `VacantView`の人数入力ステッパー（8.2）とほぼ同じ−/＋の見た目（約10行）だが、共有コンポーネントへは抽出しなかった。理由: (1) 8.3の`OptionSelectionPanel`再利用（216行の非自明なロジックの複製コストが明確に高かった）とは規模が全く異なり、本件は抽出してもprops配線（testid・aria-label・下限値・呼び出し元の状態変数）のコストの方が10行強のJSX複製より大きい、(2) 両ステッパーは値確定後の遷移が異なる（`VacantView`は`onCheckIn`を直接呼ぶ1段階、本タスクは`ConfirmDialog`を挟む2段階）ため共有化すると呼び出し元ごとの分岐が却って複雑になる、(3) `VacantView`と`OccupiedView`は`table.activeSession`の有無で排他的に描画されるため、aria-label（「人数を減らす」/「人数を増やす」）をそのまま再利用してもDOM上の衝突が起きない。7.6 Implementation Notesの「3箇所目の重複が発生したら共通化を検討する」方針に照らすと本タスクの複製はまだ2箇所目のため、小さな重複を許容する方を選んだ（`ConfirmDialog.tsx`が2箇所目で集約された前例とは対照的な判断だが、対象が「小さな見た目のJSX」か「確認モーダルという独立コンポーネントの責務」かで判断が分かれるのは妥当と判断した）。
  - **`mergePartySize`（design decision、8.x全体で最も単純なマージ）**: `updatePartySize`が返す`TableSession.partySize`をそのまま該当卓の`activeSession.partySize`へ書き写すのみで、8.2の`mergeStartedSession`や8.5の`mergeVacatedTable`のような複数フィールドの合成・副次的な状態操作（パネルを閉じる等）は一切不要だった。タイル（`register-floor-tile-occupancy`）とパネル（`register-table-detail-occupancy`）はいずれも同一の`state.tables`を参照するため、この単一の更新で両方が同時に反映される（本タスクの観測可能な完了条件「卓マップのタイルと卓詳細パネルの人数表示が更新される」を、新しい同期機構なしに満たす。8.1のバッジと8.2のバナーが単一の更新で同時に消えたのと同型の構造）。
  - **`mutationSeqRef`の適用（7つ目のローカルマージ経路、7.6→8.2→8.3→8.4→8.5→8.6に続く7回目の適用）**: 人数変更成功時のローカルマージ（`mergePartySize`）も、既存の5秒背景ポーリング・check-in・品目追加・品目削除・ステータス変更・会計・呼び出し対応と同一コンポーネント内で共存するため、同じ`mutationSeqRef`ガードをそのまま適用した。回帰テストは`FloorMap.test.tsx`に「人数変更成功より前に開始した背景ポーリングが...」を追加した（7.6/8.2/8.3/8.4/8.5/8.6の回帰テストと同型: 変更前の古いpartySizeスナップショットを持つポーリングを保留したまま人数変更を先に確定・マージし、その後に保留ポーリングを解決させても、マージ結果の新しいpartySizeが古いスナップショットへ巻き戻らないことを検証）。
  - **エラー方針（design decision、8.6以前とは異なりSESSION_NOT_ACTIVEを分岐しない）**: `SESSION_NOT_ACTIVE`（パネルを開いてから人数変更を確定するまでの間に、別のレジ端末が同じセッションを先に会計済みにした、という実際に起こりうるレース）を、`useCloseSession.ts`（8.5、専用文言「このセッションは既に会計処理済みです...」に分岐）や`useCheckIn.ts`（8.2、SESSION_ALREADY_ACTIVEに専用文言）とは異なり、`useAddOrderItem.ts`/`useUpdateOrderItemStatus.ts`が確立した「ドキュメント化された業務エラーであっても分岐せず単一の汎用メッセージへ倒す」という方針に倣った（タスク文書が明示的に指示した設計判断）。`FORBIDDEN`も同じ汎用メッセージへ倒す。いずれのエラーでもローカル状態（FloorMapの`state.tables`）は不変のまま次回の背景ポーリングに委ねる（`mergePartySize`を呼び出さない）。
  - **新規フック`useUpdatePartySize.ts`**: `useAddOrderItem.ts`/`useRemoveOrderItem.ts`/`useUpdateOrderItemStatus.ts`/`useCloseSession.ts`と同型（呼び出し関数・エラーメッセージ・クリア関数を返す、確認済みの呼び出しのみを受け取り例外を再送出しない`Promise<void>`）で実装した。確認モーダルの応答待ちという契約のため、確認レスな`useResolveCallRequest.ts`とは異なるファミリーに属する。
  - **人数の下限（design decision F、8.2との一貫性）**: チェックイン時のステッパー（8.2）と同じ`MIN_PARTY_SIZE`=1を再利用し、上限は設けない（8.2の判断をそのまま踏襲、要件が上限を定めないため）。
  - **実ブラウザ検証**: 使い捨てのPlaywrightスペック（`e2e/register-party-size.manual-verification.spec.ts`、検証後に削除しリポジトリには残していない）で、レジデバイスの実プロビジョニング→T1への入店（人数3）→(a) 「人数を変更」タップでステッパーが現在値3（チェックイン既定値2ではない）を初期値として開くこと、(b) +2して5にした上で確認モーダルの「いいえ」を選ぶとタイル・パネルいずれも3名のまま変化せず、DB直接問い合わせでも`table_sessions.party_size`が3のままであること、(c) 「いいえ」後もステッパー自体は開いたまま（下書き5を維持）残ることを確認した上で、再度「確定」→確認モーダルで確定すると、再読み込み無しでタイル・パネルの両方が5名に更新されること、(d) DB直接問い合わせで`table_sessions.party_size`が5に更新されていることを確認した。検証後、作成したセッションは`closed`へ更新し（要件4.3の履歴保持方針に従い削除はしない）、作成したregisterデバイスは削除し、DB上にアクティブなセッション・デバイスの残留が無いことをクエリで確認した。
- 9.1で確立: 厨房/レジ起動時のデバイスセッション確認とセットアップ導線を実装した。7.1/8.1が確立した「デバイスセッション確認のみ最小限（プレーンテキストでURLに言及するのみ、実際のリンク・遷移は無し）」なプレースホルダーを、正式な導線へ置き換える本specの唯一の統合タスクであり、`KitchenBoardScreen.tsx`/`RegisterConsoleScreen.tsx`双方の`NOT_PROVISIONED`分岐のみを対象に、対称的な変更を適用した。新しいマイグレーション・ゲートウェイ変更は不要（本タスクは純粋にUIのみ）。
  - **実際の`<Link>` vs 自動リダイレクト（design decision、Linkを選択）**: タスク文書が提示した二択のうち、Next.js `<Link href="/setup/kitchen">セットアップ画面へ進む</Link>`（既存の案内文の下に追加表示）を選んだ。理由: (1) `/setup/[role]`はタブレットの物理的なセットアップ作業であり、スタッフが意図してタップする操作の方が、確認中の一瞬の分岐から問答無用で画面が切り替わる自動リダイレクトより安全、(2) `useRouter`のモック化とuseEffectのタイミング制御を要する自動遷移よりテストが単純・堅牢（hrefの静的アサーションのみで足りる）、(3) design.mdのError Categories and Responses（「権限エラー（FORBIDDEN）→...`/setup/[role]`への導線を示す」）は「示す」という表現であり、自動遷移までは要求していない。観測可能な完了条件「セットアップ画面へ誘導される」は、実際にクリックしてナビゲーションできることで満たす（プレーンテキストでのURL言及のみだった旧実装との違いがまさに本タスクの本体）。
  - **`ViewState`の拡張（`setupHref?: string`）**: 両画面とも既存の`{status: "device-unavailable", message}`型に`setupHref?: string`を追加し、`NOT_PROVISIONED`分岐でのみ設定する（`WRONG_ROLE`・汎用デバイスエラーは`undefined`のまま）。レンダー側は`view.setupHref`の有無だけでLinkの表示を切り替える単純な設計とし、新しい`ViewState`のバリアント（例: 独立した`"not-provisioned"`ステータス）は追加しなかった——3つの`device-unavailable`系分岐（NOT_PROVISIONED/WRONG_ROLE/汎用エラー）が共有するコンテナ（見出し・`role="alert"`のメッセージ）のマークアップを複製せずに済むため。
  - **WRONG_ROLE・汎用デバイスエラーは対象外（タスク文書のスコープ指定どおり）**: 「デバイスが既にプロビジョニング済みだが役割が違う」「ドキュメント化されていない失敗（ネットワーク断等）」のいずれも、本タスクの観測可能な完了条件（NOT_PROVISIONEDのブラウザが対象）に含まれないため、プレーンテキストのみの旧来表示のまま変更していない。両画面の既存テスト（`ensureDeviceSessionが例外を投げても...`／`kitchen(register)以外のroleでプロビジョニング済みの場合も...`）にセットアップリンクが表示されないことを明示的にアサートする回帰テストを追加した。
  - **KitchenBoard/RegisterConsole境界を跨ぐ共有コンポーネントを作らなかった判断（非共有、理由を明記）**: 両画面のLinkはテキスト・href以外は完全に同型（2箇所目の利用）だが、共有コンポーネントへは抽出しなかった。8.2 Implementation Notesが確立した`formatYen`の前例（「RegisterConsole境界からCustomerOrderApp境界への物理的なimportを避ける」）と同じ理由で、design.mdのComponents表がKitchenBoardとRegisterConsoleを別々のBoundary Contextとして扱っているため、この規約はBoundary Context間のあらゆる組み合わせに適用されると判断した。本要素はLink1個・文言1行のみで`ConfirmDialog.tsx`（8.3、確認モーダルという独立コンポーネントの責務、同一境界内で2箇所目の利用が生まれた時点で集約）よりもさらに小さく、境界を跨ぐ共有モジュールを新設するコスト（配置場所の意思決定、双方からの参照経路の確立、将来の変更が両画面に無関係な影響を与えるリスク）の方が、10行に満たないJSXの複製より大きいと判断した。
  - **テスト**: `KitchenBoardScreen.test.tsx`/`RegisterConsoleScreen.test.tsx`の既存NOT_PROVISIONEDテストに、Linkの`href`（`/setup/kitchen`・`/setup/register`をそれぞれ取り違えないこと）と表示文言のアサーションを追加した。`next/link`は実際の`AppRouterContext`が無い環境（RTL）でもクラッシュせず素の`<a>`同等にレンダリングされることを事前に`node_modules/next/dist/client/app-dir/link.js`のソースで確認済み（`useContext`のデフォルト値`null`をイベントハンドラ内で分岐しているのみで、prefetch用の`IntersectionObserver`欠如時も`requestIdleCallback`にフォールバックする設計）——追加のモック・プロバイダは不要だった。
  - **実ブラウザ検証**: 使い捨てのPlaywrightスペック（`e2e/device-setup-navigation.manual-verification.spec.ts`、検証後に削除しリポジトリには残していない）で、(a) 未プロビジョニングの`/kitchen`でリンク（href=`/setup/kitchen`）が表示されクリックで実際に`/setup/kitchen`（セットアップフォーム）へ遷移すること、(b) 同じく`/register`→`/setup/register`、(c) kitchenロールで実プロビジョニング済みの端末で`/register`を開くとWRONG_ROLEの旧来メッセージのみが表示されセットアップリンクが存在しないこと、をローカルSupabaseスタックに対して確認した。検証後、作成したkitchen/registerデバイスは削除し、DB上に残留が無いことをクエリで確認した。
  - **フルスイート**: `npm test`（541/541、無回帰）、`npm run typecheck`、`npm run lint`、`npm run build`、`npm run test:e2e`（2/2、既存スペックへの影響なし）をいずれも実行しグリーンを確認した。
- 9.2で確立: 3画面へのRealtimeFeed接続と再接続時再取得の統合確認を実装した。
  - **最重要判断: `CustomerOrderApp`/`MenuScreen.tsx`は本タスクの配線対象から意図的に除外した**。本タスクの文言（「`CustomerOrderApp`/`KitchenBoard`/`RegisterConsole`それぞれに`useRealtimeFeed`を配線し」）は、依存関係が`_Depends: 6.2, 7.5, 8.2_`——9.1や、そもそもタスク5自体の完了より後の知見を一切含まない——であることから、タスク5（0008マイグレーションでの`anon`除外判断の確定）より前に起草された文言だと判断した。実際には0008マイグレーション「anonへのSELECT付与を見送った理由」が、`anon`（客のロール）に`order_items`/`table_sessions`/`call_requests`いずれのRealtime SELECTも一切許可しないことを、独立した実機調査（`realtime.apply_rls`の実際のPL/pgSQL定義を`pg_get_functiondef`で確認）に基づき既に確定・実装済みであり、6.2ではこれを受けて客側の確定注文合計のライブ更新を`getOrderingContext`の5秒間隔ポーリングで実現する設計に切り替え済み（`MenuScreen.tsx`冒頭コメント「タスク6.2で確定」、design.mdのRealtimeFeed Event Contractも追随済み）だった。本タスクでこれを覆して`anon`に`order_items`等のRealtime購読を追加することは、既に独立レビュー・実装済みのセキュリティ判断への回帰であり、進捗ではなく後退になる。そのため`CustomerOrderApp`/`MenuScreen.tsx`は一切変更していない（実際に変更していないことをgit diffで確認済み——`src/app/order/[tableId]/`配下に変更なし）。本タスクの実際のスコープは「KitchenBoard（7.6で完了済み・本タスクでは一切変更していない）に、RegisterConsoleを追いつかせる」ことに限定した。この整理は、0011マイグレーション冒頭コメントが後続タスクへ判断を明示的に委ねた前例（8.2 Implementation Notes参照）と同じ「タスク文書の文言より、後から確定した具体的な設計判断・マイグレーションの実装を優先する」姿勢を踏襲する。
  - **観測可能な完了条件の充足経路**: 「客側画面から注文を送信すると、5秒以内に厨房画面とレジ画面の両方に反映される」という条件は、客側に購読を持たせることでは満たさない（そもそも客側は自分自身の注文の送信結果を確認するだけで、他画面への伝播とは無関係）。実際には、`submit_order`（3.2、SECURITY DEFINER RPC）が`order_items`へINSERTすることを引き金に、**厨房・レジそれぞれが自分自身の既存のRealtime購読で検知する**ことで満たされる——厨房はKitchenBoardScreen.tsxが7.6で確立した`order_items`購読、レジは本タスクで新設した`order_items`/`table_sessions`/`call_requests`購読。客側の5秒ポーリングに基づく確定注文合計表示（1.12、6.2で既に満たされている別個の懸念）とは無関係である。
  - **`useRealtimeFeed`の配線場所: `FloorMap.tsx`（`RegisterConsoleScreen.tsx`ではない）**: KitchenBoardScreen.tsx（7.6）は「フード/ドリンク/売り切れの3タブがそれぞれ独自に`useRealtimeFeed`を持つと、タブ切り替えでの子ボードのアンマウントのたびに接続状態インジケーターが消える」という理由で画面レベル（KitchenBoardScreen）へ`useRealtimeFeed`を巻き上げ、`resyncSignal` propで子ボードへ再同期シグナルを配る設計を採った。着手前に`RegisterConsoleScreen.tsx`と`FloorMap.tsx`を読み直し、RegisterConsoleにはこの事情が存在しないことを確認した——`RegisterConsoleScreen.tsx`はデバイスゲートのみを担う薄いラッパーであり（8.1 Implementation Notes参照）、"ready"になった後は`FloorMap.tsx`がアンマウントされることなく卓マップ・詳細パネルの両方を自己完結して描画し続ける（詳細パネルはオーバーレイとして同じコンポーネントツリー内に条件付きレンダリングされるのみで、`FloorMap`自体が消えるタブ切り替えのような構造が無い）。そのため画面レベルへ巻き上げる理由付け自体が存在せず、`useRealtimeFeed`は`FloorMap.tsx`に直接配線した（`RegisterConsoleScreen.tsx`は無変更）。
  - **`onSync`は新しい再同期機構を作らず、既存の`load`関数をそのまま呼ぶ**: KitchenBoardの`resyncToken`（単調増加カウンタをpropとして子ボードへ渡す方式）は「画面（親）とフェッチする側（子ボード）が別コンポーネント」という構造上の理由による間接的な配線であり、`FloorMap.tsx`はフェッチ処理（`load`関数、8.1から存在するマウント時初回フェッチ+5秒背景ポーリングのuseEffect内のローカル関数）を自分自身で直接持っているため、`onSync`から`load(false)`を直接呼ぶだけでよく、`resyncToken`相当の中継state・propは一切不要と判断した。
    - **`useCallback`への引き上げを試みたが撤回した理由**: `onSync`から`load`を直接呼ぶために、当初`load`をeffectローカル関数から`useCallback`（`[gateway, storeId]`依存）へ引き上げ、アンマウント検知もローカル`cancelled`変数から`cancelledRef`へ変更する設計を実装したが、`npm run lint`で`react-hooks/set-state-in-effect`（eslint-plugin-react-hooksのルール）が「useEffect本体から`useCallback`で作った関数を直接呼び出す」形を、内部でいずれ`setState`へ到達する経路として静的に検出し、「effect内での同期的なsetState」の疑いとして誤検知することが判明した（`load`は`await`を挟むため実際には非同期であり、このルールが問題視する「effect本体が同期的にsetStateする」パターンには本来該当しないが、ルールの静的解析はそこまで踏み込まない）。8.1-8.7が確立してきた「`load`はeffectのローカル関数のまま」という既存の形はこのルールに一切引っかからないため、`load`自体の定義場所・シグネチャ・`cancelled`変数は一切変更を撤回してそのまま維持し、代わりにその関数への参照だけを`loadRef`（ref）へ橋渡しして、`onSync`（effect本体の外側にあるコールバック）側は`loadRef.current?.(false)`経由で呼び出す設計に変更した。これにより(a)マウント時初回フェッチ、(b)5秒間隔の背景ポーリング、(c)onSync起点の背景フェッチ、の3つの呼び出し元が新しいガードを増やすことなく既存の`mutationSeqRef`ガード（7.6/8.2-8.7で確立済み）を共有する——8.2-8.7 Implementation Notesが繰り返し予告してきた「新しい局所的な再取得経路は既存のmutationSeqRefガードをそのまま適用すること」の、最も直接的な適用となった。**この`useCallback`誤検知の経緯自体を、同種のリファクタリング（effect内ローカル関数を外部から呼び出したいケース）に今後遭遇した実装者向けの教訓として記録しておく**。
  - **購読対象（3テーブルすべて）**: `REGISTER_REALTIME_SUBSCRIPTIONS`は`order_items`/`table_sessions`/`call_requests`の3テーブル（0008マイグレーションがregisterロールへSELECTを許可する全テーブル、design.mdのEvent Contract「RegisterConsoleはorder_items/table_sessions/call_requestsの変更を購読する」と一致）。`event`・`filter`はいずれも指定しない。
  - **RegisterConsoleには接続状態UI（disconnectedバナー等）を追加しない（design decision、要件不在・検証済みUXリファレンス不在の両方を根拠とする）**: KitchenBoardScreen.tsx（7.6）は要件6.9（接続断表示・再接続後の同期）という明示的な受入基準に基づき、接続状態インジケーター・disconnectedバナー・reconnectedバナーの3点を実装した。要件5（RegisterConsoleの要件群）には同等の受入基準が存在しない（5.3は表示中の注文明細・合計金額の更新そのものを求めるのみで、接続状態の可視化までは求めない）。加えて、本specがこれまで一貫して検証済みUXリファレンスとして扱ってきたmock-preview.htmlを実際に`grep`で確認したところ、`renderRegister`関数には`renderKitchen`関数が持つ`conn-dot`（接続状態インジケーター）相当の要素がそもそも存在しないことを確認した。以上（要件不在・検証済みUXリファレンス不在・本タスクの観測可能な完了条件がタイミングのみを問う）から、RegisterConsoleには接続状態UIを追加しないと判断した。5秒ポーリングという既存の安全網（7.6と同じ理由——`status === "connected"`はwebsocketの生存確認に過ぎず、あらゆる見逃しイベントへの形式的な保証ではない）は変更せずそのまま残す。将来RegisterConsole固有の接続状態表示が必要になった場合は、新しい要件として起票した上で改めて設計すること。
  - **テスト（`FloorMap.test.tsx`、「FloorMapのタスク9.2」ブロック、4件）**: KitchenBoardScreen.test.tsxの7.6ブロックと同型の方式（`@/lib/realtime/useRealtimeFeed`をmodule-level `vi.mock`し、`onSync`を手動発火）で、(a) `register-feed`チャンネル名で3テーブルを購読すること、(b) `onSync`発火で既存の`listRegisterFeed`背景再取得が再実行されローディング状態に戻らないこと、(c) 接続状態インジケーターを一切表示しないこと（design decisionの回帰確認）、(d) onSync起点の背景フェッチより前に開始したローカルマージ（check-in成功）があっても、そのフェッチの遅延解決でマージ結果を巻き戻さないこと（`mutationSeqRef`ガードの再利用、7.6/8.2と同型の回帰テスト）、の4点を検証した。このdescribeは上位の`describe("FloorMap", ...)`のbeforeEachを継承しない独立したトップレベルの兄弟ブロックとした（KitchenBoardScreen.test.tsxの7.6ブロックと同型）。
  - **既存テストへの副作用と対応**: `FloorMap.tsx`が本タスクから`useRealtimeFeed`を直接呼び出すようになったことで、`RegisterConsoleScreen.test.tsx`（`useRealtimeFeed`を元々モックしておらず、`FloorMap`を実際にレンダーする唯一の他ファイル）が実行時に実際のwebsocket接続を試みる副作用が生じ、`npm test`実行時に`Unhandled Errors`（`TypeError: The "event" argument must be an instance of Event`、undiciのWebSocket実装由来）が発生することを本タスクのレビューで発見した。テスト自体は（たまたま）パスし続けるため見逃しやすいが、実DBへの接続を試みるテストの混入は本specが一貫して避けてきた方針に反するため、`RegisterConsoleScreen.test.tsx`にも`@/lib/realtime/useRealtimeFeed`のモック（KitchenBoardScreen.test.tsxと同型、接続済み・onSyncは何もしない最小限のもの）を追加して解消した。**教訓**: ある画面のRealtime配線を新設する際は、その画面を実レンダーする「他の」テストファイル（今回は`RegisterConsoleScreen.test.tsx`）にモック漏れが無いか横断的に確認すること（`grep -r "render(<FloorMap\|render(<RegisterConsoleScreen"`で該当ファイルを洗い出した）。
  - **恒久E2E（`e2e/realtime-propagation.spec.ts`）を追加した判断（恒久 vs 使い捨て、明確な理由あり）**: 本タスクの観測可能な完了条件は「客側画面から注文を送信すると、5秒以内に厨房画面とレジ画面の両方に反映される」という、単一画面のコンポーネントテストでは原理的に検証できないクロススクリーン・タイミングの主張である。既存のコンポーネントテスト（KitchenBoardScreen.test.tsxの7.6ブロック、本タスクのFloorMap.test.tsxブロック）はいずれも`useRealtimeFeed`自体をモックしており、「`onSync`が呼ばれたら再取得する」というアプリ側ロジックのみを検証する——0008マイグレーション（publication登録・GRANT・RLS）・`useRealtimeFeed`自身の`wait: true`購読確立ロジック・実際の`submit_order`が発火する`order_items` INSERTという、DB層〜Realtimeサーバー層の実配線は原理的に検証できない（モックしているため）。この配線は今後のマイグレーション変更等（RLSポリシーの書き換え、publicationからのテーブル除外等）で静かに壊れうるにもかかわらず、他のどのテスト（10.1-10.5含む将来のタスクも、コンポーネント/RPC単体のテストである）にもカバーされない固有のリグレッションリスクである。8.x系の大半のタスクが「単一画面の、他のコンポーネントテストで既にカバーされているUI挙動」の実ブラウザ確認だったため使い捨て（検証後削除）としてきたのとは異なり、本タスクの実ブラウザ確認は「他のどのテストレイヤーでも構造的に検証不可能な、spec全体で最も重要な横断的性質」そのものであるため、恒久的な回帰テストとして追加する価値があると判断した。この判断は、kitchen-soldout-board.spec.ts（タスク7.4）が「新規RPC + 本spec初の確認モーダル」という固有のリスクを理由に例外的に恒久化された前例（tasks.mdの`npm run test:e2e`ベースラインが最初から2/2であり続けている事実そのものが、その前例の存在を示す）とも整合する。
    - **多重コンテキストの構成**: 客・厨房・レジそれぞれに独立した`browser.newContext()`（独立したlocalStorage、Supabase authセッション）を用いた。客側画面は実UIフロー（品目クリック→オプション確定→カート→送信）で注文を送信し、RPC直叩きにはしていない（実際に`submit_order`経由でのINSERT〜Realtime配信までの全経路を通す）。事前データ（卓・アクティブセッション・メニュー品目）は`pg`クライアントでの直接SQL投入とした——`table_sessions`の作成は本テストの検証対象（Realtime伝播）とは独立した前提条件であり、レジの実チェックインUIを介在させると本テストの本題ではない別の失敗要因（8.2の`useCheckIn`等）を混入させるため。
    - **タイミングアサーションの設計（3000ms、5000msちょうどを狙わない）**: 伝播確認のアサーションは`PROPAGATION_ASSERTION_TIMEOUT_MS = 3000`（要件6.1の上限5000msより明確な余裕を持たせた値、タスク文書「a few seconds, not the full 5s ceiling」の指示通り）とした。加えて、注文送信前に厨房側は`kitchen-connection-status`が「リアルタイム接続中」になるまで実際に待機してから送信する（購読確立前に送信すると5秒フォールバックポーリング頼みになり、本テストが証明したい「伝播がRealtime経由であること」という前提が崩れるため）。レジ側は本タスクの設計判断により接続状態UIが存在しないため、固定の待機時間（1500ms）で代替した——これは、他の2画面同様の可視シグナルが無いことによる已むを得ないトレードオフであり、コメントに明記した。実行結果（後述）は2回の連続実行いずれも安定してパスし、実測の伝播時間は数百ms〜1秒程度（アサーションのタイムアウトである3000msに対して十分な余裕）だった。
    - **後始末（他の並行E2Eスペックとの衝突回避）**: `kitchen-soldout-board.spec.ts`の既存のafterAllパターン（「対象storeのkitchenロール全デバイスを削除」）をそのまま踏襲すると、Playwrightのデフォルト並列実行（本specを含め3ファイルが最大3ワーカーで並行実行される）下で、他スペックが今まさに使用中のデバイス行を誤って削除しうることに気付いた。本テストでは、実際にプロビジョニングした自分自身のデバイスの`auth_user_id`をブラウザの`localStorage`（`table-order-kitchen:device-identity`キャッシュ、`deviceUserId`フィールド）から直接読み取り、その特定の行だけを削除する方式に変更し、この衝突を回避した（`kitchen-soldout-board.spec.ts`自体は変更していない——ロール全体削除のリスクは今回新たに顕在化させたわけではなく、これまで唯一のkitchenデバイス提供スペックだったために表面化していなかっただけである。既存スペックの変更は本タスクのGit hygiene制約外のため対象外とした）。
    - **実行結果**: 単体実行・`npm run test:e2e`（3ファイル、3ワーカー並行）の両方で2回連続パスを確認した。DB直接問い合わせで、テスト終了後に投入した`tables`/`table_sessions`/`menu_items`/`devices`のいずれも残留していないことを確認した。
    - **9.2レビューでの指摘（非ブロッキング、要フォローアップ）**: レビュアーが本specを合計9回連続実行（単体5回・フルスイート内4回、並列ワーカー負荷下含む）してもフレークは一切再現しなかったが、レジ側の固定1500ms待機はkitchen側の`kitchen-connection-status`ポーリング待機と異なり実際の購読確立を確認するものではなく、より重い（低速な）CI環境では購読確立が1500msを超えて本テストが偶然5秒フォールバックポーリングの方に頼って通ってしまう（＝「伝播がRealtime経由であること」という本テストの本来の証明対象が崩れた状態でも見かけ上パスしうる）リスクが理論上残る、との指摘を受けた。対応案として、ユーザーに見せる接続状態UIを追加せずとも、テスト専用の`data-testid`等でRealtime購読状態を公開する軽量な仕組みを設け、レジ側もkitchen側と同様に実際の購読確立を待ってから送信する方式へ置き換えることが考えられる。現時点でこの追加は行っていない（要件6.9相当のUIがレジには存在しないため、テストのためだけに何かを追加するかは今後の判断に委ねる）。
  - **フルスイート**: `npm test`（545/545、既存541件は無回帰・新規4件はFloorMap.test.tsxの「FloorMapのタスク9.2」ブロック）、`npm run typecheck`、`npm run lint`、`npm run build`、`npm run test:e2e`（3/3、新規1件は本タスクで追加した恒久スペック）をいずれも実行しグリーンを確認した。`useRealtimeFeed.integration.test.ts`（タスク5の既知の一過性flakeを持つテスト）は単独実行で1回でパスし、再実行を要しなかった。
- 10.1で確認: **本タスクは新規テストコードの追加を一切行わなかった（プロダクションコード・テストコードともに無変更、`tasks.md`の本エントリのみが差分）**。本specはタスク1以降、RPCを実装する各タスク（3.1-3.5）が結合テスト（`*.integration.test.ts`、実ローカルPostgresに対する実RPC呼び出し）をそのタスク自身の一部として同時に書き切る方針で一貫しており、着手前にこの前提を疑い、10.1が要求する5項目・引用要件5件それぞれについて「同名のテストが存在する」ではなく実際にテスト本文を読んで正しい観測点（DBの直接クエリ等）を検証しているかを確認する網羅的なギャップ分析を行った結果、真のギャップは見つからなかった。以下に項目ごとの根拠を記す（いずれも実際に本文を読んで確認済み）。
  - **セッション無効（要件1.9、本タスクの文言通りの観測可能な完了条件）**: `src/lib/supabase/submitOrder.integration.test.ts:364-380`の`"終了済み(closed)セッションへの送信はSESSION_NOT_ACTIVEで拒否され、何も挿入されない（要件1.9）"`が、(a) 事前に`status: 'closed'`のセッションを用意し、(b) `submit_order`を呼び、(c) `error?.code`が`SESSION_NOT_ACTIVE`（SQLSTATE `P0409`）であることを確認し、(d) `pool.query`で`orders`テーブルを対象セッションIDについて直接カウントし`0`であることを確認している——RPCの戻り値だけでなくDB状態そのものを独立して検証する、本タスクが名指しで要求した形そのもの。`order_items`テーブルは`order_id uuid not null references orders (id)`という外部キー制約のみで`orders`に接続され、`session_id`列を直接持たない（`supabase/migrations/0001_schema.sql:89-107`で確認）ため、`orders`側の行数が0であることは`order_items`側の行数が0であることを論理的に含意する（存在しない注文を参照する明細行は外部キー制約上作成不可能）。加えて0003マイグレーション本体（`supabase/migrations/0003_rpc_customer_gateway.sql:517-539`）を読み、セッション有効性検証がDB書き込みより前の最初のステップとして実装されており（コメント「ここではDBへの書き込みを一切行わず」）、無効セッションでの拒否が構造的にも一切のINSERT前に発生することを設計レベルでも確認した。よって`order_items`への個別クエリを重ねて追加することは、同じ結論を再証明するだけの重複テストと判断し、追加しなかった。
  - **売り切れ（要件1.4, 7.2）**: 同ファイル`:382-407`の`"売り切れ品目を含む送信はITEM_SOLD_OUT（該当menuItemId付き）で拒否され、何も挿入されない（要件7.2）"`が、`error?.code === "ITEM_SOLD_OUT"`かつ`error?.details === menuItemSoldOutId`（該当menuItemIdの一致）を確認し、さらに`pool.query`で該当idempotencyKeyに対応する`orders`行数が0であることを直接確認している。要件1.4（客画面での選択不可表示）自体はUI層（タスク6.1、`MenuScreen`のグレーアウト表示）の関心事だが、その表示を可能にするデータ契約は`src/lib/supabase/getOrderingContext.integration.test.ts:239-254`の`"売り切れ品目はmenuから除外されず、soldOut: trueとして含まれる（要件1.4, 7.2）"`が正しく検証している。
  - **オプション別明細分離（要件1.8）**: 同ファイル`:294-329`の`"同一menuItemIdを異なるoptionSelectionsで2回送信すると、統合せず別々のorder_items行として登録される（要件1.8）"`が、本タスクが要求する形——同一`submit_order`呼び出し1回の中で同一menuItemIdを異なる`optionSelections`で2件指定し、統合されず2行の`order_items`として登録され、それぞれが独立した`options_selected`/`options_summary`（`"辛さ: 普通"`と`"辛さ: 辛口"`）を持つこと——をDBへの直接クエリで確認している。
  - **冪等性**: 同ファイル`:331-362`の`"同一sessionId・idempotencyKeyで2回送信すると、2回目はdeduplicated: trueを返し、order_itemsは重複挿入されない（DBの行数を直接確認、観測可能な完了条件, 要件1.7）"`が、2回目の応答の`deduplicated: true`・同一`order.id`に加え、`pool.query`で`orders`/`order_items`双方の行数が1のままであることを直接確認している。さらに`src/lib/supabase/submitOrderRateLimit.integration.test.ts:281-317`が「同一idempotencyKeyでの冪等な再送はordersを増やさないが、レート制限のカウント対象には含まれる」という別角度からも冪等性の実装を裏付けている。
  - **get_ordering_contextの基本ケース**: `getOrderingContext.integration.test.ts`の`:195-214`（アクティブセッション無し卓→`activeSession: null`・`confirmedTotal: 0`）、`:228-237`（確定注文ありの卓→`confirmedTotal`が`500*2+300*1=1300`と正しく算出される）、`:239-254`（売り切れ品目が`soldOut: true`で含まれる）の3件で、本タスクが求める基本ケースをいずれもDB状態と突き合わせて確認している。
  - **要件1.11（送信中のネットワーク断→未完了表示・再試行促し）**: この要件はクライアントの実行時ネットワーク条件というUI層固有の関心事であり、バックエンドRPC自体には「ネットワーク断」という状態が存在しない。`CustomerOrderingGateway`境界での対応する契約は、`src/lib/gateways/customerOrderingGateway.ts`のドキュメント（Result型に載らない想定外のエラーは例外としてthrowする、実装ファイル冒頭のコメント参照）と、それを検証する`src/lib/gateways/customerOrderingGateway.test.ts:302-311`の`"マッピングにない未知のSQLSTATEはResultにならず例外として伝播する"`（submitOrder）である。この例外伝播契約こそが、タスク6.2で実装済みの`MenuScreen`側try/catch（`src/app/order/[tableId]/MenuScreen.test.tsx:478-508`の`"送信中にネットワーク接続が失われると送信未完了の旨を表示し、再試行は同一のidempotencyKeyで送信する（観測可能な完了条件c）"`、`mockSubmitOrder.mockRejectedValueOnce(new TypeError("Failed to fetch"))`で実際のfetch失敗の型を模擬）を成立させる基盤である。両テストとも既存（タスク3.4・6.2）であり、本タスクの追加は不要と判断した。
  - **結論**: 5項目・引用要件5件のいずれについても、名前が一致するテストが存在するだけでなく実際に正しい観測点（DB直接クエリ、正確なエラーコード、DETAILからのmenuItemId抽出、複数回呼び出しでの行数不変）を検証していることを確認したため、新規テストを追加しなかった。`git status --short`で本タスク中に生成物以外のファイル変更が一切無いことも確認済み。
  - **フルスイート**: `npm run db:start`後、`npm test`（545/545、無変更につき無回帰）、`npm run typecheck`、`npm run lint`、`npm run build`、`npm run test:e2e`（3/3、`useRealtimeFeed.integration.test.ts`の再実行は不要だった）をいずれも実行しグリーンを確認した。
- 10.2で確認: **本タスクも10.1と同様、新規テストコードの追加を一切行わなかった（プロダクションコード・テストコードともに無変更、`tasks.md`の本エントリのみが差分）**。着手前に「4.1-4.5がRPCを実装する各タスク自身の一部として結合テストを同時に書き切っている」という10.1が確立した前提を疑い、本タスクが要求する5項目・引用要件11件・3件の観測可能な完了条件それぞれについて、同名のテストが存在するというだけでなく実際にテスト本文を読んで正しい観測点（DBへの直接クエリ、エラーコードの厳密な一致、DETAILからのfrom/to抽出、複数回のRPC呼び出しでの順序検証等）を検証しているかを確認する網羅的なギャップ分析を行った結果、真のギャップは見つからなかった。以下に項目ごとの根拠を記す（いずれも実際に本文を読んで確認済み）。
  - **start_sessionの重複防止（タスクの文言通り、要件4.1, 3.1, 3.4）**: `src/lib/supabase/startSession.integration.test.ts:146-179`の`"アクティブセッションのない卓に対して呼び出すと成功し、指定したpartySizeが記録される（要件3.1, 3.4）"`が正常系（入力した`partySize`が記録されること）を、`:181-208`の`"既にアクティブセッションがある卓に対して呼び出すと、既存セッションのidを含むSESSION_ALREADY_ACTIVEが返り、2件目のアクティブセッションは作られない（観測可能な完了条件, 要件3.2, 4.1）"`が重複防止そのものを検証する。後者は本タスクが名指しで要求した「Resultだけでなく直接カウントクエリでDBを確認する」規律に厳密に従っており、`error?.details`が既存セッションIDと一致することに加え、`pool.query`で`table_sessions where table_id = $1 and status = 'active'`を直接問い合わせ、2件目が作られず既存の1件のみであることを配列の完全一致（`toEqual([{ id: existingActiveSessionId }])`）で確認している——件数だけでなくID自体が既存セッションのものであることまで確認しており、本タスクが要求した水準を満たす。ラッパー層（TypeScript）の同一契約は`src/lib/gateways/staffOperationsGateway.integration.test.ts:254-271`の`"startSession: 既にアクティブセッションがある卓はSESSION_ALREADY_ACTIVE（activeSessionId付き）になる"`が独立に確認している。
  - **update_party_sizeの境界ケース＝closedセッションへの拒否（タスクの3件目の観測可能な完了条件そのもの、要件3.5）**: `src/lib/supabase/updatePartySize.integration.test.ts:170-200`の`"会計済み（closed）のセッションに対して呼び出すとSESSION_NOT_ACTIVEが返り、人数は変更されない（観測可能な完了条件, 要件3.5）"`が、(a) 呼び出し前の`party_size`を`pool.query`で取得し、(b) `error?.code`が`SESSION_NOT_ACTIVE`であることを確認し、(c) 呼び出し後の`party_size`を再度`pool.query`で取得し前後が一致することを確認している——エラーコードだけでなく「人数が変更されていないこと」自体をDB直接クエリの前後比較で検証する、本タスクが名指しで要求した形そのもの。`:202-221`は存在しないセッションIDも同じ`SESSION_NOT_ACTIVE`に収束することを追加で確認する。要件3.5の「実行前に確認を求め」の部分はUI層（RegisterConsole）の責務であり、design.md該当箇所（StaffOperationsGateway Responsibilities & Constraints、`updatePartySize`の項）に「実行前確認はUI層（RegisterConsole）の責務とする」と明記されている——RPC自体は確認フラグを持たない設計であり、その部分は既にタスク8.7のコンポーネントテスト（確認モーダルの「はい」操作を経て`updatePartySize`が呼ばれること）で検証済みのため、本タスクのスコープ外として重複させなかった。
  - **update_order_item_statusのジャンル別許可遷移（タスクの1件目の観測可能な完了条件そのもの、要件6.3, 6.4, 6.6）**: `src/lib/supabase/updateOrderItemStatus.integration.test.ts`が単一ファイルでRPC自身の遷移許可ロジックを網羅している。ドリンクジャンルへの`in_progress`遷移要求というタスクの文言と一言一句対応するのは`:372-396`の`"received → in_progress はINVALID_TRANSITIONで拒否される（ドリンクはin_progress状態を持たない。タスクの観測可能な完了条件）"`——`error?.code`が`INVALID_TRANSITION`であること、`JSON.parse(error?.details as string)`が`{from: "received", to: "in_progress"}`と一致すること、DB上の`status`が`received`のまま変化していないことの3点を確認する。食品/一品ジャンルの段階的遷移（`received→in_progress→done`）は`:218-262`（food）・`:295-329`（ippin）が、一品のみに許可される`received→done`直接ショートカット（要件6.6）は`:331-350`の`"received → done への直接遷移（ショートカット）は成功する"`が確認する。そして本specの安全上重要な非対称性——フードは同じショートカットを持たない——は`:264-291`の`"received → done への直接遷移はINVALID_TRANSITIONで拒否される（foodはippinと異なりショートカットが許可されない）"`で明示的に検証されている（DBの`status`が`received`のまま不変であることまで確認）。ドリンクの`received→done`直接遷移（in_progressを経由しない仕様、要件6.4）は`:354-370`。後退遷移の拒否（全ジャンル）は`:422-521`。`status_updated_at`が遷移のたびに単調増加すること（要件6.10のソートキーとなる前提）は`:523-560`が実際のタイムスタンプ比較で確認する。ラッパー層でも`src/lib/gateways/staffOperationsGateway.integration.test.ts:457-486`がフードの`received→done`直接遷移拒否を`{from, to}`のDETAIL往復を含めて独立に確認している。**このRPC自体の遷移許可ロジックは、クライアント側の`resolveNextOrderItemStatus`（`src/lib/orderItemStatusTransitions.test.ts`）とは完全に独立したテストであることも確認済み**——同ファイルは純粋なTS関数のテーブル駆動テストであり`update_order_item_status` RPCを一切呼び出していないため、あくまで「クライアントとサーバーの遷移表が一致していることの傍証」に過ぎず、RPC自身が独自に遷移を強制していることの証明にはならない。この区別を踏まえた上で、`updateOrderItemStatus.integration.test.ts`がRPC単体で全ジャンル×全遷移パターンを独立に検証済みであることを確認したため、追加は不要と判断した。
  - **list_kitchen_feedの一品優先順と調理完了の直近完了順（タスクの2件目の観測可能な完了条件そのもの、要件6.7, 6.10）**: `src/lib/supabase/listKitchenFeed.integration.test.ts:214-261`が、food→drink→ippinの順に受注時刻を意図的にずらして挿入し（自然な受注時刻順であれば`food, drink, ippin`になるはずのところ）、未対応一覧が`[ippinItemId, foodItemId, drinkItemId]`の順で返ることを確認する（要件6.7）。調理完了列のstatus_updated_at降順（要件6.10）は二段構えで検証されている: `:263-313`が挿入順とタイムスタンプ順をあえて逆転させたDB直接操作で「挿入順ではなくタイムスタンプで並んでいること」を、`:315-366`のテスト名`"調理完了一覧: 実際のupdate_order_item_status呼び出しを時間差で連続実行しても、後から完了させた品目が先頭に返る（タスクの観測可能な完了条件そのもの）"`が、本物の`update_order_item_status` RPCを50ms間隔で2回呼び出し、後から`done`にした品目が先頭に来ることを実運用に近い形で確認する——タスクの文言「先に調理完了にした品目と後から調理完了にした品目がある場合、後から完了させた品目が調理完了一覧の先頭に返る」と一言一句対応する。`:432-458`が返却要素の`tableId`/`tableLabel`/`genre`（要件6.8）を確認する。
  - **add_order_item/remove_order_itemの境界ケース（要件5.5, 5.6）**: `src/lib/supabase/addOrderItem.integration.test.ts:261-282`の`"終了済み(closed)セッションへの追加はSESSION_NOT_ACTIVEで拒否され、何も挿入されない（要件5.5）"`が、追加前後の`countOrderItemsForSession`が変化しないことをDB直接クエリで確認する。`:302-324`は売り切れ品目の追加が`ITEM_SOLD_OUT`（`menuItemId`付き）で拒否され件数が不変であることを確認する。削除側は`src/lib/supabase/removeOrderItem.integration.test.ts:220-238`の`"既に会計済み（closed）のセッションに属する注文明細の削除はORDER_ITEM_NOT_FOUNDで拒否され、行は削除されない（観測可能な完了条件, 要件5.6）"`が、本タスクが名指しで要求した通り**具体的に`ORDER_ITEM_NOT_FOUND`という特定のコード**（design.mdが「会計後の履歴改ざんを防ぐため」と明記する意図的な設計判断）であることを確認し、かつ`orderItemExists`によるDB直接クエリで行が削除されていないことも確認する。`:240-255`が実在しない注文明細IDも同じコードに収束することを追加で検証し、closedセッションのケースと汎用的な「not found」のケースが区別なく同一コードへ収束するという設計意図（同ファイル冒頭コメント参照）を裏付ける。要件5.5/5.6の「実行前に確認を求め」の部分はupdate_party_sizeと同様design.md（StaffOperationsGateway Responsibilities & Constraints、`addOrderItem`/`removeOrderItem`/`updateOrderItemStatus`の項）が明示的にUI層の責務としており、タスク8.3のコンポーネントテスト（確認モーダルの「いいえ」で変化しないこと）が既に検証済みのため、本タスクでは対象としなかった。
  - **結論**: 5項目・引用要件11件・観測可能な完了条件3件のいずれについても、名前が一致するテストが存在するだけでなく実際に正しい観測点（DB直接クエリによる前後比較、正確なエラーコードとDETAILの内容一致、複数回のRPC呼び出しによる実時間差での順序検証）を検証していることを確認したため、新規テストを追加しなかった。`git status --short`で本タスク中に生成物以外のファイル変更が一切無いことも確認済み。
  - **フルスイート**: `npm run db:start`後、`npm run typecheck`・`npm run lint`・`npm run build`をいずれもエラーなく完了し、`npm test`（545/545、無変更につき無回帰）・`npm run test:e2e`（3/3、`useRealtimeFeed.integration.test.ts`含め再実行不要だった）をいずれも実行しグリーンを確認した。
- 10.3で確認: 10.1/10.2と同じ規律（名前が一致するテストの存在ではなく実際にテスト本文を読んで正しい観測点を検証しているかを確認する網羅的なギャップ分析）で着手したが、本タスクは10.1/10.2と異なり**「5項目中4項目は真のギャップなし、残り1項目（Realtimeタイミング）は実装→実機での問題発見→意図的な不採用」という結果になった**（プロダクションコードは無変更。テストコードも最終的には無変更——後述の通り一度追加した新規結合テストファイルを検証の末に削除したため）。以下、5項目それぞれの根拠を記す。
  - **`anon`ロールでの生テーブル直接書き込み拒否（要件8.1）**: `src/lib/supabase/rlsPolicies.integration.test.ts`の`describe("anonロール: 直接書き込みは全テーブルで拒否される", ...)`が、タスク文言が要求する「一部テーブルの代表サンプル＋スキーマレベルの一様性確認」ではなく、**0001_schema.sqlが定義する全8テーブル（`stores`/`tables`/`table_sessions`/`menu_items`/`orders`/`order_items`/`call_requests`/`devices`）に対して`it.each(ALL_TABLES)`でINSERT/UPDATE/DELETEの3種別すべてを個別に実行し、いずれも`42501`（INSUFFICIENT_PRIVILEGE）で拒否されることを確認済みであることを実際にテスト本文を読んで確認した**。そのため「代表サンプルで十分と判断する」という設計判断そのものが不要だった（既に全数検証されている）。同ファイルは`authenticated`ロール（device_role未検証）についても同じ全8テーブル×3操作の総当たりを持ち、加えてタスク5（0008マイグレーション）以降SELECT権限が広がった`order_items`/`table_sessions`/`call_requests`の3テーブルについて「テーブル権限はあるがRLSにより0件になる」ことまで区別して検証している。真のギャップなし。
  - **`device_role`未設定JWTでの`FORBIDDEN`（要件8.2, 8.3）**: `src/lib/supabase/assertDeviceRole.integration.test.ts`がヘルパー関数`assert_device_role(text[])`自体を、(a) 許可されたロール、(b) 許可リストにないロール、(c) ランダムな不正ロール文字列、(d) `device_role`クレーム自体が存在しないJWT（客の匿名セッション相当）、(e) JWTコンテキストが全く存在しない場合、の5パターンで検証し、(b)-(e)いずれも`P0403`（FORBIDDEN相当）を確認する。これはヘルパー単体の検証に留まらず、実際のRPC呼び出しレベルでも独立に検証されている——`startSession.integration.test.ts`（`"device_roleクレームを持たない匿名セッション（客側と同じ経路）から呼び出すと拒否される"`・`"匿名サインインすらしていない場合（真のanonロール）は呼び出し自体が失敗する"`）、`updateOrderItemStatus.integration.test.ts:598`（`"device_roleクレームを持たない匿名セッション（客側相当）からの呼び出しはFORBIDDENで拒否される"`、DBの`status`が不変であることまで確認）、`removeOrderItem.integration.test.ts:267`、`listRegisterFeed.integration.test.ts:507`（kitchenロールでのregister限定RPC呼び出し拒否）等、StaffOperationsGatewayの9 RPC全ての結合テストファイルに`FORBIDDEN_DEVICE_ROLE = "P0403"`の検証が存在することを`grep`で確認した（`assert_device_role`が全RPC冒頭で共通利用される設計、タスク2.2の前提通り）。真のギャップなし。
  - **`confirmedTotal`と`listRegisterFeed`の`total`の一致（タスクの文言通りの観測可能な完了条件、要件1.12, 5.1）**: タスク指示書が名指しした`src/lib/supabase/listRegisterFeed.integration.test.ts:375-403`のテスト`"total は get_ordering_context の confirmedTotal と完全に一致する（design.mdが明示的に要求する、同一ロジック共有のクロスRPC検証。1.12, 5.1）"`を実際に読み、指示書の疑いを検証した。同一の`occupiedTableId`・同一の`occupiedSessionId`に対して`listRegisterFeed`（registerデバイスクライアント）と`getOrderingContext`（真のanonクライアント）を`Promise.all`で並行呼び出しし、`expect(row?.total).toBe(customerResult.data.confirmedTotal)`という**`toBe`（厳密等価、"近い値"や"両方非ゼロ"ではない）**でアサートしていることを確認した。タスクが要求する観測可能な完了条件そのものが、追加作業なしに既に完全な形で満たされていることを確認した。真のギャップなし。
  - **呼び出し重複防止（要件2.3）**: `src/lib/supabase/createCallRequest.integration.test.ts:160-180`の`"未対応の呼び出しが既に存在するセッションへ連続して呼び出すと、call_requestsの行が1件のまま増えず、CALL_ALREADY_OPENが返る（観測可能な完了条件, 要件2.3）"`が、タスク文言「同一セッションに対して連続して呼び出しても call_requests の行が1件のまま増えない」と一言一句対応する検証を行う——1回目呼び出し後の行数（`beforeCount`）と2回目呼び出し後の行数（`afterCount`）をDB直接クエリで比較し完全一致（かつ`1`）であることを確認し、2回目の応答が`CALL_ALREADY_OPEN`（`error.details`が1回目のIDと一致）であることも確認する。真のギャップなし。
  - **注文挿入からRealtime通知到達までの時間（要件1.12, 6.1、本タスクで唯一実装→実機検証→不採用という結論に至った項目）**: タスク指示書が明示的に判断を委ねた論点。着手前に、この項目に関連する既存2テストを実際に読み、以下を確認した——(1) `useRealtimeFeed.integration.test.ts`（タスク5）は`waitFor(..., { timeout: 45000 })`という寛容な待機で「いつかは`onSync`が呼ばれる」ことのみを確認し、DB変更発生から`onSync`発火までの実経過時間を計測・アサートしていない。(2) `e2e/realtime-propagation.spec.ts`（タスク9.2）は3ブラウザコンテキスト・実UIフローを通しで検証し`PROPAGATION_ASSERTION_TIMEOUT_MS = 3000`という明確な時間上限をアサートするが、これは「客のクリックから厨房のDOM描画まで」という画面全体の遅延でありブラウザ起動・ページ遷移・Reactレンダリングのオーバーヘッドを含む。この2つの間には「UI/Reactフックを一切介さない、bareな`postgres_changes`購読への到達時間を具体的な閾値でアサートする結合テスト」という空白が確かに存在すると判断し、`src/lib/realtime/realtimePropagationTiming.integration.test.ts`を新規実装した——`createCustomerOrderingGateway.submitOrder`（実RPC呼び出し、生SQLではない）でorder_itemsへ挿入し、`kitchenClient.channel(...).on("postgres_changes", { event: "INSERT", table: "order_items", filter: \`menu_item_id=eq.${menuItemId}\` }, ...)`という素の`@supabase/supabase-js`購読（Reactフックなし、`@vitest-environment node`）が受信するまでの実経過時間（`performance.now()`差分）を計測し、3000ms未満（要件6.1の上限5000msに対する明確な余裕、9.2のe2eテストと同じ閾値）をアサートする設計とした。
    - **単体実行では4/4回連続成功（実測伝播時間は毎回1秒未満、テストファイル総実行時間0.7〜1.1秒）**、かつ`src/lib/realtime/`配下2ファイル（本テスト＋`useRealtimeFeed.integration.test.ts`）を同時実行しても成功することを確認した。
    - しかし**`npm test`のフルスイート（vitestが1ファイル=1ワーカーとして最大41〜42ワーカーを同時起動する既存のアーキテクチャ）に含めた状態では3回中2回失敗し、うち1回は計測用の待機時間を30000msまで引き上げても`postgres_changes`イベントが到達しなかった**（診断用に`console.error`で実測値を出力しつつ検証。同一の`src/lib/realtime/`2ファイルのみの同時実行や単体実行では一度も再現しなかった）。これはuseRealtimeFeed.integration.test.ts自身が「タスク5の既知の一過性flake」として文書化している現象（同ファイルの再接続シナリオが単体実行の2秒未満からフルスイート実行下で120秒相当の猶予を要するほど劣化する、tasks.md 5番のフルスイート実行時のコメント参照）と同じ種類の劣化だが、本テストで観測された劣化幅（数十ms〜1秒→30秒超）は「1回の再実行で通常解消する既知の稀なflake」という水準を明確に超えており、恒久的な自動テストとして`npm test`に残すと新たな主要な不安定要因（false failure）を持ち込むと判断した。原因はおそらく、フルスイート下で41〜42個のvitestワーカーが単一のローカルPostgres/Realtimeスタックへ同時に大量のトランザクション・INSERTを発行することによるWAL処理・Realtime配信側のバックログ（0008マイグレーション冒頭コメントが記録する「一過性の揺らぎ」と同種の、単一ローカルインスタンス特有の資源競合）であり、本番運用（厨房/レジタブレット同時1〜3台、9.2 Implementation Notes参照）が経験しない負荷条件に起因する既知のテスト環境固有の限界であって、0008マイグレーションの配線自体の欠陥ではないと判断した（配線自体は単体実行4/4回で一貫して1秒未満と確認済み）。
    - **結論（不採用の判断）**: 上記の実機調査の結果、`realtimePropagationTiming.integration.test.ts`は削除し、恒久的な自動テストとしては追加しないことに決定した（8.2 Implementation Notesが確立した「実ブラウザでの使い捨て検証（検証後に削除、リポジトリには残さない）」パターンと同型の扱い——本ファイルも「配線が実際に高速であることを実機で検証する」という目的は既に単体実行4/4回で達成済みであり、恒久的に残すことのコスト（`npm test`への新たな不安定要因の混入）がベネフィット（e2eより高速な回帰シグナル）を上回ると判断した）。**「e2eで既にカバーされているから」という理由だけでスキップしたのではなく、実際に実装・実機検証した上で、このリポジトリ固有のテスト実行アーキテクチャ（1ファイル=1ワーカーの高並列度）における具体的な実測結果に基づいて不採用と判断した**点を明記する。結果として、この項目のタイミング境界の恒久的な検証は、(a) `useRealtimeFeed.integration.test.ts`（配線が機能すること自体の検証、寛容なタイムアウトでフルスイート下の資源競合に対して頑健）と(b) `e2e/realtime-propagation.spec.ts`（要件6.1の実際の数値上限に対する最も説得力のある証拠。`test:e2e`はPlaywrightの3ワーカー並列でありvitestの41〜42ワーカー並列と異なり同種の資源競合が起きにくいため、タイトな時間上限のアサーションが安定して成立する。9.2 Implementation Notesが記録する9回連続実行でのフレーク皆無という実績もこれを裏付ける）の既存2層に委ねる、という結論に至った。
  - **結論**: 5項目のうち4項目（`anon`直接書き込み拒否、`device_role`未設定`FORBIDDEN`、`confirmedTotal`/`total`一致、呼び出し重複防止）は実際にテスト本文を読んで正しい観測点を検証済みであることを確認し追加不要と判断した。残り1項目（Realtimeタイミング）は新規結合テストを実装・実機で4/4回の成功を確認した上で、フルスイート実行時の資源競合により恒久的な自動テストとしては不適格であると判断し、削除した（プロダクションコード・最終的なテストコードともに無変更）。`git status --short`で本タスク完了時点で生成物以外のファイル変更が一切無いことを確認済み。
  - **フルスイート**: `npm run db:start`後、`npm run typecheck`・`npm run lint`・`npm run build`をいずれもエラーなく完了し、`npm test`（545/545、無変更につき無回帰。上記の通り一時的に追加した新規テストファイルは検証後削除済み）・`npm run test:e2e`（3/3、無変更につき無回帰）をいずれも実行しグリーンを確認した。`useRealtimeFeed.integration.test.ts`は`npm test`のフルスイート内で1回、タスク5の既知の一過性flake（再接続シナリオの`waitFor`タイムアウト）により失敗したため単体で再実行し1回でパスした（既知の許容範囲内の事象、`docker ps`/スタック健全性に異常なし）。
- 10.4で新規実装: 10.1-10.3（いずれも既存カバレッジで充足済みと判明）とは異なり、本タスクは真に新規のE2E（`e2e/main-user-journey.spec.ts`）が必要だった——「客のQR注文→厨房反映→ステータス更新→レジでの金額確認→会計操作によるセッション終了」を1本の連続したシナリオとして通しで検証するテストは、9.2（`e2e/realtime-propagation.spec.ts`、伝播タイミングのみに特化）にも10.1-10.3（RPC単体・結合テストのみ）にも存在しなかった真の空白だった。
  - **構造上の判断（1本の長いtest() vs test.describe.serial）**: realtime-propagation.spec.ts（9.2）・kitchen-soldout-board.spec.ts（7.4）が確立した「1つのdescribe内に1つの長いtest()」構造をそのまま踏襲した。本シナリオの各ステップ（入店→客注文→厨房反映→レジ確認→会計→旧セッション拒否）は前段が作った状態に後段が依存する一続きの物語であり、`test.describe.serial()`で複数の小さなtest()に分割すると3ブラウザコンテキストの引き継ぎが煩雑になる上、個々のtest()が単体では意味をなさない前提条件になってしまう。タスクの観測可能な完了条件「一連のE2Eシナリオがグリーンで完走する」が求める「1つの通しシナリオとして完走すること」を、1つのtest()内の明確なステップコメント区切り（1〜6）で表現する方が実際の意図に忠実だと判断した。
  - **フィクスチャ**: `supabase/seed.sql`が投入する既存店舗（`NEXT_PUBLIC_STORE_ID`）に対し、本テスト専用の卓（ラベル`TJRN`+randomUUID接頭辞、卓マップの「テーブル」区分に入るよう`/^T/`に一致させる）と、`image_url`（1x1透明PNGのdata URI、外部ネットワーク依存を避けるための意図的な選択）・`options`（choice/toggle/counterの3種、`OptionSelectionPanel.tsx`が描画する全UIパターンを実機で検証するため）を持つジャンル`food`の品目、および（下記「差し戻し対応」参照）ジャンル`drink`の品目（image_url無し・options空配列の最小構成）の計2件を、`pg`直叩きで`beforeAll`にて投入した。`afterAll`は`tableId`に紐づく全セッション・注文・卓・品目（food/drinkの2件とも）をFK順序（order_items→orders→table_sessions→tables→menu_items）で削除し、devicesの後始末はrealtime-propagation.spec.tsが確立した「role全体削除ではなく本テストが実際にプロビジョニングした2台のauth_user_idのみを対象にする」方式を踏襲した（Playwrightのデフォルト並列実行下で他specのデバイス行を誤って削除するのを避けるため）。
  - **差し戻し対応（独立レビューでREJECTED→修正、要件6.4）**: 独立レビューが指摘した通り、初版は`genre='food'`の品目1件のみを投入しており、Requirements欄に明記されていた6.4「ドリンクジャンルは『未対応』『対応済み』の2状態で管理する」は、タスクの完了条件（フード/ドリンクボードへの反映）に反して一切検証されていなかった——`beforeAll`のコメント自体が「drinkはreceived→doneの2状態のみで6.3の別分岐を検証できないためfoodを選んだ」と明記しており、この判断自体は6.3の検証には妥当だったが、結果として6.4がテスト全体を通じて一度も触れられない空白を生んでいた（foodのreceived→in_progress→doneをどれだけ検証しても、drinkのin_progress禁止という別の分岐が壊れるregressionは検知できない）。レビューの指示どおり、`beforeAll`へジャンル`drink`の品目（options無し・image_url無しの最小構成、1.5/1.6の精緻なオプション検証は既存のfood品目でカバー済みのため）を追加し、客のQR注文フェーズで3明細目としてfood品目と同じ送信に含め、厨房検証フェーズで（a）ドリンクボードタブへの実際の反映、（b）`drink-board-column-in_progress`がDOM上に存在しないこと、（c）`OrderItemStatusActions`がこのカードに対して描画するボタンが「対応完了」ただ1つのみ（ボタン総数1）であること、（d）その「対応完了」クリックでreceived→doneへ実際に1段階で遷移し`drink-board-column-done`へ移動すること、をすべて実クリックで検証するよう拡張した。レジ側の明細一覧・ステータス表示（「対応済み」ラベル）・合計金額（food×2+drink×1、要件1.12のクロス確認）のアサーションも3明細分に更新した。ファイル冒頭のRequirements欄自体（6.4を含む一覧）は変更不要だったが、`beforeAll`のfood/drink品目投入コメントおよび全体の構造コメントを、両ジャンルを検証する現状に合わせて書き直した。修正後、単体実行（`--workers=1`）で3回連続成功、`npm run test:e2e`のフルスイート（4ファイル、デフォルト並列ワーカー）を5回連続実行しすべて4/4でグリーンを確認し、各回後にDB直接問い合わせでfood/drink両品目を含むフィクスチャの残留が無いことも確認した。`npm run typecheck`・`npm run lint`・`npm run build`・`npm test`（545/545、vitestテストは無変更のため無回帰）もすべてグリーンで再確認した。
  - **要件↔アサーションの対応**: 1.5（写真）→客側画面で`getByRole("img", {name: menuItemName})`の可視性、1.6（オプション選択）→choiceを非既定値（辛口）・toggle/counterを非既定値へ実際に操作、1.7（送信・完了表示）→「送信完了」テキストの可視性、1.9（別オプション組み合わせは別明細）→同一品目に異なるオプション（辛さ:辛口 / 追加ソース、ライス増量×1）で2回注文し、厨房ボード上の2枚の別カード・レジ側の2行の別明細として検証、1.12（確定注文合計とレジtotalの一致）→客側`confirmed-total-amount`とレジ側`register-table-detail-total`が同一の`expectedSubtotal`文字列に一致することをアサート、3.1/3.4（人数入力・保持）→入店操作で既定値2から3へ変更し卓詳細パネル・卓マップタイルの両方に反映されることを確認、4.1（同時1アクティブセッション）→真に空席の卓から出発することで前提として担保、5.1/5.4（レジでの卓別会計・全卓一覧）→卓詳細パネルの明細一覧・合計と卓マップタイルの合計表示、6.1（5秒以内反映）→`PROPAGATION_ASSERTION_TIMEOUT_MS=3000`ms（realtime-propagation.spec.tsと同じ値・同じ根拠）以内の可視性アサート、6.3/6.4（ジャンル別ステータス体系、独立レビュー対応でドリンク側を追加）→フードジャンルの`received→in_progress→done`の段階遷移、およびドリンクジャンルの`received→done`の2状態遷移（`drink-board-column-in_progress`がDOM上に存在しないこと・`OrderItemStatusActions`のボタンが「対応完了」1個のみであることを含む）の両方を実際にボタンクリックで進め、列移動をアサート、6.8（卓/時刻の判別）→カード内のtableLabel包含・`HH:MM`形式の時刻表示、3.3（会計操作の確認）→`register-checkout-confirm`のメッセージ文言をタスク文書指定の一言一句と完全一致で確認、4.2（終了セッションへの注文拒否）→UIが実際に表示していたセッションID（`session #<uuid>`表示から正規表現で抽出、DBへの再問い合わせではなくUI表示値をそのまま再利用）を使い、真のanonクライアントで`submit_order`を直接RPC呼び出しし`P0409`（SESSION_NOT_ACTIVE）を確認、かつ`order_items`行数が変化しないことをDB直接問い合わせで確認、4.4（新規セッションは独立ID、任意検証扱いだったが実装に含めた）→会計後の同一卓への再入店で得た新セッションIDが旧セッションIDと異なることを確認。
  - **並行実行との衝突回避（9.2の教訓の再適用）**: 厨房ボードの品目一覧（`listKitchenFeed`）は店舗全体を対象とするため、他specが同じ店舗へ並行して投入するfoodジャンルの品目が同一画面に同時に存在しうる。カード数の`toHaveCount`アサーションは必ず自卓の`tableLabel`で絞り込んでから行う（絞り込み無しの`toHaveCount`は他specとの衝突で偽陽性の失敗を招きうることに気づき、実装時点で対応した）。
  - **安定性検証**: 単体実行（`--workers=1`）で4回連続成功（初回+3回の安定性確認）、`npm run test:e2e`のフルスイート（4ファイル、デフォルト並列ワーカー、9.2 Implementation Notes記載の通り本プロジェクトは複数ワーカーで並行実行する）を5回連続実行しすべて4/4でグリーンを確認した（フレーク皆無）。各実行後にDB直接問い合わせでフィクスチャ（卓・品目・セッション・デバイス）が残留していないことも確認した。
  - **フルスイート**: `npm run typecheck`・`npm run lint`・`npm run build`をいずれもエラーなく完了し、`npm test`（545/545、本タスクはvitestテストを追加していないため無変更・無回帰）・`npm run test:e2e`（4/4、新規1件は本タスクで追加した`e2e/main-user-journey.spec.ts`）を実行しグリーンを確認した。
- 10.5で確認・部分実装: タスクが列挙する5シナリオそれぞれについて、既存4ファイル（smoke/kitchen-soldout-board/realtime-propagation/main-user-journey）に対する網羅的な監査（実際にテスト本文・アサーションを読む、10.1-10.4が確立した規律）を行った結果、3シナリオは既にE2E層（実ブラウザ・実RPC・実RLS）で検証済みであることを確認し、残り2シナリオ（来店中の人数変更確認モーダル、レジからの品目追加/削除確認モーダル）が真のギャップだったため、新規ファイル`e2e/register-edge-cases.spec.ts`を追加した。
  - **監査結果（5シナリオ）**:
    1. **売り切れ登録の確認モーダル（要件7.1/7.2/7.3）**: 既存カバレッジで充足済み。`e2e/kitchen-soldout-board.spec.ts:122-160`（タスク7.4）が確認モーダルの「いいえ」（状態不変・DB直接確認）→「はい」（`sold_out`がtrueへ、DB直接確認・リロード後も反映）の両パスを実ブラウザ・実RPCで検証している。追加不要と判断した。
    2. **入店時の人数入力と卓マップ表示（要件3.1, 3.4）**: 既存カバレッジで充足済み。`e2e/main-user-journey.spec.ts:256-317`（タスク10.4、ステップ1）が空席卓への入店操作で既定値2から3へ人数を変更し、確定後に卓詳細パネル・卓マップタイルの両方に「3名」が反映されることを検証している。追加不要と判断した。
    3. **セッション終了後の旧セッションからの注文拒否（要件4.2、タスクの1件目の観測可能な完了条件そのもの）**: 既存カバレッジで充足済み。`e2e/main-user-journey.spec.ts:592-655`（タスク10.4、ステップ6）が、UIが実際に表示していた旧セッションID（`session #<uuid>`表示から正規表現抽出）を使い、真のanonクライアントで`submit_order`を直接RPC呼び出しし、`P0409`（SESSION_NOT_ACTIVE）で拒否されること、かつ`order_items`行数が呼び出し前後で変化しないことをDB直接問い合わせで確認している——タスクの完了条件の文言（「旧セッションIDで送信した注文がすべて拒否される」）と一言一句対応する検証であり、追加は同じ主張を再証明するだけの重複になると判断し、追加不要とした。
    4. **来店中の人数変更確認モーダル（要件3.5、タスクの2件目の観測可能な完了条件そのもの）**: 真のギャップだった。タスク8.7が同じUI（卓詳細パネルの人数変更ステッパー→`ConfirmDialog`）についてコンポーネントテスト（モックしたゲートウェイ、`TableDetailPanel.test.tsx`）による厚いカバレッジを持つが、既存4つのE2Eファイル全てをgrepしても`update_party_size`・`updatePartySize`・`register-party-size`・「人数を変更」のいずれの言及も無く、実ブラウザ・実RPC・実RLSを通す層のテストは存在しなかった（main-user-journey.spec.tsの人数関連アサーションは入店時の初期人数入力のみで、来店中セッションへの人数変更操作は一度も行われない）。`e2e/register-edge-cases.spec.ts`の`describe("来店中の人数変更確認モーダル（タスク10.5）")`として新規追加した。
    5. **レジからの品目追加/削除確認モーダル（要件5.5, 5.6）**: 真のギャップだった。タスク8.3が同じUIについてコンポーネントテストによる厚いカバレッジを持つが、既存4つのE2Eファイルをgrepしても`add_order_item`・`remove_order_item`・`register-add`・`register-remove`のいずれの言及も無かった。main-user-journey.spec.tsは客側の`submit_order`経由の注文（`OptionSelectionPanel`を介した客のQR注文フロー）のみを検証しており、レジ自身の「＋品目を追加」/「削除」操作（`TableDetailPanel.tsx`の`onAddItem`/`onRemoveItem`、`add_order_item`/`remove_order_item`という別のRPC・別のUI経路）は一度も駆動されていなかった。`e2e/register-edge-cases.spec.ts`の`describe("レジからの品目追加・削除確認モーダル（タスク10.5）")`として新規追加した。
  - **新規ファイルの構造（1ファイル2describe、既存ファイルの「1describe1test」構造を2回反復）**: kitchen-soldout-board.spec.ts/realtime-propagation.spec.ts/main-user-journey.spec.tsはいずれも「1つのdescribe内に1つの長いtest()」構造を採る。本タスクは独立した2シナリオを扱うため、2つのdescribeブロックへ分割し、各ブロックが自己完結したbeforeAll/afterAll・1つのtest()を持つ（既存ファイルの構造をそのまま2回反復）。`main-user-journey.spec.ts`（既に695行の単一の長い通しシナリオ）への追記は、タスク文書自身が「既存ファイルを肥大化させない」よう促す判断基準（無関係な関心事を1つの通しシナリオに混ぜない）に照らして避け、`kitchen-soldout-board.spec.ts`が独立ファイルとして切り出された前例を踏襲して新規ファイルとした。
  - **`Pool`インスタンスの分離（実装中に発見・修正した実装上の罠）**: 当初は他specと同じ「ファイル冒頭で`const pool = new Pool(...)`を1つだけ宣言する」パターンをそのまま踏襲したが、`--workers=1`での初回実行で`Error: Cannot use a pool after calling end on the pool`が発生した。原因は、本ファイルが2つのdescribeを持つため、1つ目のdescribeの`afterAll`が呼ぶ`pool.end()`の後に2つ目のdescribeの`beforeAll`/testが同じ`pool`変数を使おうとしたため（既存の全ファイルは1ファイル1describeのため、この問題が一度も顕在化していなかった）。修正は各describeが自分自身の`Pool`インスタンスをローカルに持ち、自分の`afterAll`でのみ`end()`する方式とした（`cleanupDevice`ヘルパーは`pool`を引数として受け取るよう変更）。**この罠は、1ファイルに複数describeを持つ新しいE2Eファイルを今後追加する実装者への教訓として記録する**: 「1ファイル1describe1pool」という既存4ファイルの暗黙の前提を複数describeファイルへそのまま持ち込むと、`fullyParallel: true`下でなくとも単一workerの逐次実行時点で表面化する。
  - **事前状態の構築方法（direct SQL、実チェックインUIを介さない）**: 両シナリオとも「来店中の卓」を前提とするが、来店操作（チェックイン）自体は既にmain-user-journey.spec.tsで実UIを通して検証済みであり、いずれのシナリオの検証対象でもない。`realtime-propagation.spec.ts`冒頭コメントが確立した「検証対象と無関係な前提条件はUIではなく`pg`直叩きで用意し、本題ではない別の失敗要因を混入させない」という判断をそのまま踏襲し、`pg`直叩きでアクティブセッション（人数変更シナリオ）・アクティブセッション+オプション無し品目（品目追加/削除シナリオ）を用意してから、各シナリオの本題のみを実UIで検証した。
  - **人数変更シナリオの検証内容**: 卓マップタイル・卓詳細パネル双方の初期表示（2名）確認→「人数を変更」タップでステッパーが現在値（チェックイン時の既定値2ではなく`activeSession.partySize`そのもの、タスク8.7 design decisions F）を初期値として開くことを確認→2名から5名へ変更→「確定」→確認モーダル（`register-party-size-confirm`、文言「人数を5名に変更しますか？」）の「いいえ」でモーダルのみが閉じステッパーは下書き値5を保持したまま開いたままであること・パネル/タイルの人数表示・DB上の`party_size`のいずれも不変であることを確認（要件3.5「確認された場合にのみ」の裏面）→再度「確定」→「変更する」で確定すると、ステッパーが閉じ、パネル・タイルの両方が再読み込みなしで「5名」に更新され、DB上の`table_sessions.party_size`が5になっていることを確認した（タスクの2件目の観測可能な完了条件そのもの）。
  - **品目追加/削除シナリオの検証内容**: オプション無し品目を使用——`TableDetailPanel.tsx`の`requestAddItem`は品目がオプションを持つ場合`OptionSelectionPanel`（客側と共有、6.1/8.3で既に実ブラウザ検証済み）を経由し、オプションを持たない場合のみ本テストが検証したい`ConfirmDialog`（`register-add-confirm`）分岐に入るため、意図的にオプション無し品目を選んだ。「＋」タップ→確認モーダル（文言「「品目名」を注文に追加しますか？」）の「いいえ」で追加されず明細一覧・合計・DB（`order_items`件数）いずれも不変→再度「＋」→「追加する」で確定すると明細が1件追加され合計が更新され、DB上の`order_items`（`name_snapshot`/`unit_price_snapshot`/`quantity`）に正しい値で永続化されていることを確認。続けて「削除」タップ→確認モーダル（文言「「品目名」を削除しますか？この操作は取り消せません。」）の「いいえ」で削除されず明細一覧・合計・DBいずれも不変→再度「削除」→「削除する」で確定すると明細が消え合計が¥0に戻り、`remove_order_item`が実際にハード削除（`0004_rpc_staff_gateway.sql`設計判断9/10）であることをDB直接クエリ（`order_items`件数0）で確認した。
  - **numeric型の文字列返却（実装中に発見した罠、既存の前例と同じ）**: `order_items.unit_price_snapshot`はPostgresの`numeric`型のため、`pg`クライアントは精度保持のため値を文字列として返す（`submitOrder.integration.test.ts`で既に確立済みの前提と同じ）。初回実行時に`expect(unit_price_snapshot).toBe(550)`（数値）が`"550"`（文字列）とのミスマッチで失敗し、`Number(...)`変換を挟むよう修正した。
  - **安定性検証**: 新規ファイル単体を`--workers=1`で1回、デフォルト並列ワーカーで3回連続実行しすべて2/2でグリーンを確認した。続けて`npm run test:e2e`のフルスイート（5ファイル、デフォルト並列ワーカー）を5回連続実行しすべて6/6（既存4件+新規2件）でグリーンを確認した（フレーク皆無）。各実行後にDB直接問い合わせで本タスクのフィクスチャ（`TPSZ`/`TAIZ`接頭辞の卓、品目、デバイス）が残留していないことを確認した。
  - **フルスイートのベースライン再現性についての所見（非ブロッキング、本タスクの変更とは無関係）**: 本タスク着手直後（`npm run db:start`直後の初回`npm run test:e2e`実行）に、既存の`main-user-journey.spec.ts`が1回だけ`register-table-detail-item-status`のアサーション（3000msタイムアウト）で失敗した。直後の再実行（同一プロセス、Next.js dev serverはウォーム状態）では3回連続で成功しており、Next.js dev serverの初回リクエスト時のJITコンパイル（`next dev`はページを初回アクセス時に初めてコンパイルする）による一過性の遅延が原因である可能性が高いと判断した（本タスクの新規ファイルにはこの種の失敗は一度も再現していない）。プロダクションコード・`main-user-journey.spec.ts`自体はいずれも変更していない。
  - **フルスイート**: `npm run typecheck`・`npm run lint`・`npm run build`をいずれもエラーなく完了し、`npm test`（545/545、本タスクはvitestテストを追加していないため無変更・無回帰）・`npm run test:e2e`（6/6、新規2件は本タスクで追加した`e2e/register-edge-cases.spec.ts`）を実行しグリーンを確認した。
