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

- [ ] 8.7 人数変更UI（確認モーダル）
  - 卓詳細パネルに人数更新ボタンを設け、レジからの人数変更操作と実行前の確認モーダルを実装する
  - 観測可能な完了条件: 人数変更の確認モーダルで確認すると、卓マップのタイルと卓詳細パネルの人数表示が更新される
  - _Requirements: 3.5_
  - _Depends: 8.2_

- [ ] 9. Integration: デバイスガードと画面配線
- [ ] 9.1 厨房/レジ起動時のデバイスセッション確認とセットアップ導線
  - `/kitchen`・`/register`起動時に`ensureDeviceSession`を確認し、未プロビジョニングの場合は`/setup/[role]`へ導線を表示する
  - 観測可能な完了条件: 未プロビジョニングのブラウザで`/kitchen`にアクセスするとセットアップ画面へ誘導される
  - _Requirements: 8.2, 8.3_
  - _Depends: 2.3, 7.1, 8.1_

- [ ] 9.2 3画面へのRealtimeFeed接続と再接続時再取得の統合確認
  - `CustomerOrderApp`/`KitchenBoard`/`RegisterConsole`それぞれに`useRealtimeFeed`を配線し、画面間をまたいだ更新反映（客の注文→厨房/レジへの反映）を確認する
  - 観測可能な完了条件: 客側画面から注文を送信すると、5秒以内に厨房画面とレジ画面の両方に反映される
  - _Requirements: 1.12, 6.1, 6.9_
  - _Depends: 6.2, 7.5, 8.2_

- [ ] 10. Validation: テスト
- [ ] 10.1 CustomerOrderingGateway ユニットテスト
  - `submit_order`のセッション無効・売り切れ・オプション別明細分離・冪等性、`get_ordering_context`の基本ケースをテストする
  - 観測可能な完了条件: 終了済みセッションへの`submit_order`が`SESSION_NOT_ACTIVE`を返しDBに行が増えないことがテストで確認される
  - _Requirements: 1.4, 1.8, 1.9, 1.11, 7.2_
  - _Depends: 3.2_

- [ ] 10.2 StaffOperationsGateway ユニットテスト
  - `start_session`の重複防止、`update_party_size`の境界ケース（`closed`セッションへの拒否）、`update_order_item_status`のジャンル別許可遷移、`list_kitchen_feed`の一品優先順と調理完了の直近完了順、`add_order_item`/`remove_order_item`の境界ケースをテストする
  - 観測可能な完了条件: ドリンクジャンルへの`in_progress`遷移要求が`INVALID_TRANSITION`として拒否されることがテストで確認される
  - 観測可能な完了条件: `list_kitchen_feed`の調理完了列が`status_updated_at`降順で返ることがテストで確認される
  - 観測可能な完了条件: 会計済みセッションへの`update_party_size`が`SESSION_NOT_ACTIVE`として拒否されることがテストで確認される
  - _Requirements: 3.1, 3.4, 3.5, 4.1, 5.5, 5.6, 6.3, 6.4, 6.6, 6.7, 6.10_
  - _Depends: 4.5_

- [ ] 10.3 結合テスト（RLS境界・権限・整合性）
  - `anon`ロールでの生テーブル直接書き込み拒否、`device_role`未設定JWTでの`FORBIDDEN`、`confirmedTotal`と`listRegisterFeed`の`total`の一致、呼び出し重複防止、注文挿入からRealtime通知到達までの時間を検証する
  - 観測可能な完了条件: 同一卓・同一セッションで客側`confirmedTotal`とレジ側`total`が常に同じ値になることがテストで確認される
  - _Requirements: 1.12, 2.3, 5.1, 6.1, 8.1, 8.2, 8.3_
  - _Depends: 9.2_

- [ ] 10.4 E2E: 主要ユーザージャーニー
  - 客のQR注文（写真・オプション選択含む）→厨房のフード/ドリンクボードへの反映→ステータス更新→レジでの金額確認→会計操作によるセッション終了までを通しで検証する
  - 観測可能な完了条件: 一連のE2Eシナリオがグリーンで完走する
  - _Requirements: 1.5, 1.6, 1.7, 1.9, 1.12, 3.1, 3.3, 3.4, 4.1, 4.2, 4.4, 5.1, 5.4, 6.1, 6.3, 6.4, 6.8_
  - _Depends: 9.2_

- [ ] 10.5 E2E: エッジケース（売り切れ・人数入力・人数変更・レジ確認操作・セッション失効）
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
