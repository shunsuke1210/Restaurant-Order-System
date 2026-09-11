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

- [ ] 1.3 コアスキーマのマイグレーション作成
  - `stores`/`tables`/`table_sessions`（`party_size`列を含む）/`menu_items`（`genre`/`options` jsonb/`image_url`/`sold_out`列を含む）/`orders`（`idempotency_key`列を含む）/`order_items`（`status`/`status_updated_at`/`name_snapshot`/`unit_price_snapshot`/`options_selected`/`options_summary`列を含む）/`call_requests`/`devices` の各テーブルを作成する
  - `table_sessions(table_id) WHERE status = 'active'` の部分ユニークインデックスを作成する
  - `orders(session_id, idempotency_key)` のユニーク制約と、`order_items(status, status_updated_at)`の複合インデックスを作成する
  - 観測可能な完了条件: マイグレーション適用後、同一卓に対して2件目のアクティブセッションをINSERTすると一意制約違反になる
  - _Requirements: 1.5, 1.6, 3.4, 4.1, 6.2, 6.3, 6.4, 6.10, 7.4_

- [ ] 1.4 RLSポリシーのマイグレーション作成
  - 全テーブルでRLSを有効化し、`anon`/`authenticated`ロールへのINSERT/UPDATE/DELETE直接権限を付与しない
  - `menu_items` のSELECTのみ `anon` に許可する
  - 観測可能な完了条件: `anon`ロールで`table_sessions`への直接INSERTを試みると拒否される
  - _Requirements: 8.1, 8.2, 8.3_

- [ ] 2. Foundation: デバイス識別基盤
- [ ] 2.1 Custom Access Token Hookとdevice_roleクレーム
  - `devices`テーブルを参照し、JWT発行時に`device_role`クレームを埋め込むCustom Access Token Hook関数を実装する
  - 観測可能な完了条件: プロビジョニング済みデバイスでサインインすると、発行されたJWTに`device_role`クレームが含まれる
  - _Requirements: 8.2, 8.3_
  - _Depends: 1.3_

- [ ] 2.2 device_role検証ヘルパーとFORBIDDEN境界の共通化
  - 各RPC関数冒頭で共通利用する`assert_device_role(text[])`ヘルパー関数を実装する
  - 観測可能な完了条件: 許可されていない`device_role`のJWTでヘルパーを呼び出すと例外（FORBIDDEN相当）が送出される
  - _Requirements: 8.2, 8.3_
  - _Depends: 2.1_

- [ ] 2.3 DeviceIdentityProviderと初回セットアップ画面
  - `ensureDeviceSession`/`provisionDevice`/`getCurrentDevice`を実装し、`/setup/[role]`画面でセットアップコード入力→匿名サインイン→`devices`登録を行う
  - 観測可能な完了条件: セットアップコード入力後、タブレットのローカルストレージに永続化されたセッションで再訪時に認証UIが表示されない
  - _Requirements: 8.2, 8.3_
  - _Depends: 2.1_

- [ ] 3. Core: CustomerOrderingGateway（客側の唯一の書き込み経路）
- [ ] 3.1 get_ordering_context RPCの実装
  - 卓IDからアクティブセッションの有無・メニュー一覧（`imageUrl`/`options`/`soldOut`含む）・`confirmedTotal`を返すRPCを実装する
  - 観測可能な完了条件: アクティブセッションのない卓IDで呼び出すと`activeSession: null`が返る
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.12, 7.2_

- [ ] 3.2 submit_order RPCの実装
  - セッション有効性・売り切れ再検証・オプション整合性チェックを行い、`idempotencyKey`による重複送信の吸収、同一品目でもオプション別に別明細として登録する処理を実装する
  - 観測可能な完了条件: 同一`idempotencyKey`で2回送信しても`order_items`が重複挿入されず`deduplicated: true`が返る
  - _Requirements: 1.7, 1.8, 1.9, 1.10, 7.2_
  - _Depends: 3.1_

- [ ] 3.3 create_call_request RPCの実装
  - セッションに未対応の呼び出しが既に存在する場合は新規作成しないRPCを実装する
  - 観測可能な完了条件: 同一セッションに対して連続して呼び出しても`call_requests`の行が1件のまま増えない
  - _Requirements: 2.1, 2.2, 2.3_
  - _Depends: 3.1_

- [ ] 3.4 CustomerOrderingGatewayのTypeScriptラッパー
  - `getOrderingContext`/`submitOrder`/`createCallRequest`を型付きの`Result<T,E>`として公開するラッパーを実装する
  - 観測可能な完了条件: 各RPCのエラーコードがユニオン型として型チェックを通過し、呼び出し側で網羅的なswitchができる
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.12, 2.1, 2.2, 2.3, 7.2_
  - _Depends: 3.1, 3.2, 3.3_

- [ ] 4. Core: StaffOperationsGateway（厨房/レジの唯一の書き込み経路）
- [ ] 4.1 (P) start_session / close_session RPCの実装
  - 人数を記録して新規セッションを発行する`start_session`と、確認済みの会計操作を受けてセッションを終了する`close_session`を実装する
  - 部分ユニークインデックス違反を`SESSION_ALREADY_ACTIVE`として処理し、`device_role`検証を先頭で行う
  - 観測可能な完了条件: アクティブセッションが既にある卓に対する`start_session`が`SESSION_ALREADY_ACTIVE`エラーを返す
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4_
  - _Boundary: StaffOperationsGateway_
  - _Depends: 1.3, 1.4, 2.1, 2.2_

- [ ] 4.2 add_order_item / remove_order_item RPCの実装
  - `submit_order`と同等の検証（セッション有効性・売り切れ）を適用した品目追加と、閉じたセッションへの削除を拒否する品目削除を実装する
  - 観測可能な完了条件: 既に会計済み（`closed`）のセッションの注文明細を削除しようとすると`ORDER_ITEM_NOT_FOUND`が返る
  - _Requirements: 5.5, 5.6_
  - _Depends: 4.1_

- [ ] 4.3 update_order_item_status RPCの実装
  - 品目のジャンルに応じた許可遷移（フード/一品: received→in_progress→done、ドリンク: received→done、一品のみreceived→done直接遷移も許可）を検証するRPCを実装する
  - ステータスを変更するたびに`status_updated_at`を現在時刻で更新する
  - 観測可能な完了条件: ドリンクジャンルの品目に対して`in_progress`への遷移を要求すると`INVALID_TRANSITION`が返る
  - _Requirements: 5.7, 6.2, 6.3, 6.4, 6.5, 6.6, 6.10_
  - _Depends: 4.1_

- [ ] 4.4 set_sold_out / resolve_call_request RPCの実装
  - 品目の売り切れ状態を切り替える（既存注文の内容・状態を変更しない）RPCと、呼び出しを対応済みにするRPCを実装する
  - 観測可能な完了条件: 品目を売り切れ登録しても、登録前に作成された`order_items`の行数・`status`が変化しない
  - _Requirements: 2.4, 7.1, 7.3, 7.4_
  - _Depends: 4.1_

- [ ] 4.5 list_kitchen_feed / list_register_feed RPCの実装
  - 未対応品目一覧で一品ジャンルを受注時刻に関わらず先頭に並べ、調理完了列は`status_updated_at`の降順（直近完了が先頭）に並べる厨房向け一覧と、卓ごとの人数・注文明細・合計金額・未対応の呼び出し有無（`hasOpenCallRequest`）を返すレジ向け一覧を実装する
  - 観測可能な完了条件: 一品ジャンルの品目を後から注文しても、未対応一覧の先頭に表示される順序でRPCが返す
  - 観測可能な完了条件: 先に調理完了にした品目と後から調理完了にした品目がある場合、後から完了させた品目が調理完了一覧の先頭に返る
  - _Requirements: 2.2, 5.1, 5.2, 5.3, 5.4, 6.1, 6.7, 6.8, 6.9, 6.10_
  - _Depends: 4.1_

- [ ] 4.6 StaffOperationsGatewayのTypeScriptラッパー
  - `startSession`/`closeSession`/`addOrderItem`/`removeOrderItem`/`updateOrderItemStatus`/`setSoldOut`/`resolveCallRequest`/`listKitchenFeed`/`listRegisterFeed`を型付きで公開するラッパーを実装する
  - 観測可能な完了条件: 全メソッドの戻り値が`Result<T,E>`型として型チェックを通過する
  - _Requirements: 2.2, 2.4, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 7.1, 7.3, 7.4_
  - _Depends: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 5. useRealtimeFeedフックの実装
  - `order_items`/`table_sessions`/`call_requests`への`postgres_changes`購読と、切断検知時に対応する一覧再取得関数（`listKitchenFeed`/`listRegisterFeed`/`getOrderingContext`）を呼び直す再同期ロジックを実装する
  - 観測可能な完了条件: 購読中にネットワークを切断し再接続すると、一覧が最新状態に再取得される
  - _Requirements: 1.12, 6.1, 6.8, 6.9_
  - _Depends: 3.4, 4.6_

- [ ] 6. Core: 客側注文画面（CustomerOrderApp）
- [ ] 6.1 メニュー閲覧・ジャンル別タブ・オプション選択UI
  - 品目の写真表示、オプション選択（choice/toggle/counter）、売り切れ品目の選択不可表示を含むメニュー画面を実装する
  - 観測可能な完了条件: 売り切れ品目がグレーアウトされ選択操作ができない
  - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 7.2_
  - _Depends: 3.4_

- [ ] 6.2 注文送信・確定注文合計表示・通信断ハンドリング
  - 注文送信フローを実装し、送信完了が画面に表示されるようにする
  - 画面下部に確定注文合計を常時表示し、同席者の別端末からの注文にもRealtimeで追随して更新する
  - 送信中のネットワーク断エラー表示と再試行の案内を実装する
  - 観測可能な完了条件（3件）: (a) 注文送信が成功すると送信完了メッセージが表示される (b) 別端末からの注文後、確定注文合計表示が再読み込みなしに更新される (c) 送信中にネットワークを切断すると送信未完了の旨が画面に表示される
  - _Requirements: 1.7, 1.8, 1.9, 1.10, 1.11, 1.12_
  - _Depends: 6.1, 5_

- [ ] 6.3 呼び出しボタンUI
  - 呼び出しボタンの表示と、対応済みになるまでの重複防止表示を実装する
  - 観測可能な完了条件: 呼び出し送信後、対応済みになるまでボタンが再送不可の状態を示す
  - _Requirements: 2.1, 2.2, 2.3_
  - _Depends: 6.1_

- [ ] 6.4 (P) アクティブセッション不在時の案内画面
  - アクティブセッションがない卓でQRを読み取った場合に、注文フォームの代わりにスタッフを呼ぶ案内を表示する
  - 観測可能な完了条件: アクティブセッションのない卓IDへアクセスすると注文フォームが表示されず案内文が表示される
  - _Requirements: 1.1, 1.3_
  - _Boundary: CustomerOrderApp_
  - _Depends: 3.1_

- [ ] 7. Core: 厨房KDS画面（KitchenBoard）
- [ ] 7.1 (P) 3タブ共通シェルと固定ヘッダー
  - フードボード／ドリンクボード／売り切れボードの3タブ切り替えと、スクロールしても消えない固定ヘッダー・サブタブ領域を実装する
  - 観測可能な完了条件: ボード内をスクロールしてもタブ・ヘッダーが画面上部に固定表示され続ける
  - _Requirements: 6.8_
  - _Boundary: KitchenBoard_
  - _Depends: 4.6, 5_

- [ ] 7.2 フードボード（5分割カンバン・一品優先表示）
  - 未対応2列・調理中2列・調理完了1列の5分割カンバンと、一品ジャンルを受注時刻に関わらず未対応列の先頭に表示する並び替えを実装する
  - 調理完了列はRPCが返す順序（直近完了が先頭）をそのまま表示に反映する
  - 観測可能な完了条件: 一品ジャンルの品目が、他の品目より後に注文されても未対応列の最上部に表示される
  - 観測可能な完了条件: 調理完了列で、後から調理完了にした品目が先に完了した品目より上に表示される
  - _Requirements: 6.3, 6.6, 6.7, 6.10_
  - _Depends: 7.1_

- [ ] 7.3 ドリンクボード（2状態カンバン）
  - 未対応/対応済みの2列カンバンを実装する
  - 観測可能な完了条件: ドリンク品目のステータス更新操作に調理中の選択肢が表示されない
  - _Requirements: 6.4_
  - _Depends: 7.1_

- [ ] 7.4 売り切れボード（検索・確認モーダル）
  - 品目検索・サマリー・売り切れ切り替えの確認モーダルを実装する
  - 観測可能な完了条件: 売り切れ切り替え操作で確認モーダルの「いいえ」を選ぶと状態が変化しない
  - _Requirements: 7.1, 7.3, 7.4_
  - _Depends: 7.1_

- [ ] 7.5 ステータス更新操作と即時反映
  - 品目のステータス更新操作（一品の未対応→調理完了直接遷移ショートカット含む）と、更新結果の画面への即時反映を実装する
  - 観測可能な完了条件: ステータス更新操作の直後に、確認や再読み込みなしで該当カードが新しい列へ移動する
  - _Requirements: 6.1, 6.2, 6.5_
  - _Depends: 7.2, 7.3_

- [ ] 7.6 接続断表示と再同期
  - サーバーとの接続断の表示と、再接続後の最新一覧への同期を実装する
  - 観測可能な完了条件: 接続断中は画面にその旨が表示され、再接続後に一覧が最新化される
  - _Requirements: 6.9_
  - _Depends: 7.1_

- [ ] 8. Core: レジ画面（RegisterConsole）
- [ ] 8.1 (P) 卓マップ表示
  - テーブル/カウンターのエリア分けと、各卓タイルへの人数・経過時間・合計金額・呼び出し中バッジ（`hasOpenCallRequest`）の表示を実装する
  - 観測可能な完了条件: 呼び出し中の卓のタイルに呼び出しバッジが表示され、対応済みになると消える
  - _Requirements: 2.2, 5.4_
  - _Boundary: RegisterConsole_
  - _Depends: 4.6, 5_

- [ ] 8.2 卓詳細パネルと入店操作（人数入力）
  - 卓タイル選択で開く詳細パネルと、入店操作時の人数入力フォーム、選択中卓への新規注文のリアルタイム反映を実装する
  - 観測可能な完了条件: 入店操作で人数を入力し確定すると、卓マップのタイルにその人数が表示される
  - _Requirements: 3.1, 3.2, 3.4, 5.1, 5.2, 5.3_
  - _Depends: 8.1_

- [ ] 8.3 品目の追加・削除UI（確認モーダル）
  - レジからの品目追加・削除操作と、実行前の確認モーダルを実装する
  - 観測可能な完了条件: 削除操作で確認モーダルの「いいえ」を選ぶと注文明細が変化しない
  - _Requirements: 5.5, 5.6_
  - _Depends: 8.2_

- [ ] 8.4 品目ステータス変更UI（確認モーダル）
  - レジからの品目ステータス変更操作と、実行前の確認モーダルを実装する
  - 観測可能な完了条件: ステータス変更の確認モーダルで確認すると、注文明細のステータス表示が更新される
  - _Requirements: 5.7_
  - _Depends: 8.2_

- [ ] 8.5 会計操作（確認モーダル・セッション終了）
  - 「お会計完了でよろしいですか？完了するとQRコード情報がリセットされます」の確認モーダルと、確認後のセッション終了・卓マップ表示への遷移を実装する
  - 観測可能な完了条件: 会計確認後、卓詳細パネルが閉じて卓マップ画面が表示され、対象卓が空席状態になる
  - _Requirements: 3.3_
  - _Depends: 8.2_

- [ ] 8.6 呼び出し対応UI
  - 呼び出し通知の表示と、対応済み操作を実装する
  - 観測可能な完了条件: 呼び出し対応操作を行うと通知表示が消える
  - _Requirements: 2.4_
  - _Depends: 8.1_

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
  - `start_session`の重複防止、`update_order_item_status`のジャンル別許可遷移、`list_kitchen_feed`の一品優先順と調理完了の直近完了順、`add_order_item`/`remove_order_item`の境界ケースをテストする
  - 観測可能な完了条件: ドリンクジャンルへの`in_progress`遷移要求が`INVALID_TRANSITION`として拒否されることがテストで確認される
  - 観測可能な完了条件: `list_kitchen_feed`の調理完了列が`status_updated_at`降順で返ることがテストで確認される
  - _Requirements: 3.1, 3.4, 4.1, 5.5, 5.6, 6.3, 6.4, 6.6, 6.7, 6.10_
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

- [ ] 10.5 E2E: エッジケース（売り切れ・人数入力・レジ確認操作・セッション失効）
  - 売り切れ登録の確認モーダル、入店時の人数入力と卓マップ表示、レジからの品目追加/削除確認モーダル、セッション終了後の旧セッションからの注文拒否を検証する
  - 観測可能な完了条件: セッション終了後に旧セッションIDで送信した注文がすべて拒否されることがテストで確認される
  - _Requirements: 1.9, 3.1, 3.4, 4.2, 4.4, 5.4, 5.5, 5.6, 7.1, 7.2, 7.3_
  - _Depends: 9.2_

## Implementation Notes
- 開発環境ではDockerがWSL2「Ubuntu」ディストリビューション内でのみ動作する（Windows側にDocker Desktopなし）。Supabase CLIは同ディストリビューション内`~/bin/supabase`にインストール済みでログインシェルのPATHに登録済み。`supabase`系コマンドは必ず `wsl -d Ubuntu -e bash -lc "cd '/mnt/c/Users/shunsuke-iida/Documents/VSCode/Restaurant Order System' && supabase <args>"` 経由で実行する。日常操作は`package.json`の`db:start`/`db:stop`/`db:reset`/`db:types`スクリプト（1.2で追加済み）がこの経路をラップしているのでそちらを使う。
- Supabase CLI 2.117.0はローカル起動時にキーを「Publishable」「Secret」として表示するが、内部的には引き続きレガシーのJWT形式`anon`/`service_role`キーと同等に扱われ、`anon`ロール経路はPublishable keyで正しく解決されることを1.2のレビューで実機検証済み。ただし`authenticated`ロール＋`device_role`カスタムクレームの経路（Custom Access Token Hook, DeviceIdentityProvider）は未検証であり、`supabase/config.toml`は現在`auth.enable_anonymous_sign_ins = false`（デフォルト）になっている。**タスク2.1（Custom Access Token Hook）着手時に、匿名サインインを有効化した上でdevice_roleクレームがセッションJWTに正しく含まれることを実機で確認すること。**
