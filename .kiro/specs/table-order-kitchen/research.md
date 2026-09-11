# Research & Design Decisions

## Summary
- **Feature**: `table-order-kitchen`
- **Discovery Scope**: New Feature（グリーンフィールド、フルディスカバリー実施）
- **Key Findings**:
  - スタッフ起点でセッションを開始/終了する方式は、USEN Mobile Order（会計操作でその卓の注文URLを即時無効化）やToast Mobile Order & Payと同型であり、業界の主流パターンと一致する
  - Supabaseのanonキー＋RLSだけでは、生テーブルへの直接アクセスを許すと設定ミスのリスクが高い（実際に多数のアプリがRLS未設定のまま公開されたCVE事例あり）。書き込みは`SECURITY DEFINER`のPostgres関数（RPC）に集約し、生テーブルへの直接grantを最小化する方が安全
  - 「厨房/レジは個人ログイン不要」という要件と、「不特定多数がインターネット越しに操作できてはいけない」という前提は、匿名サインイン＋カスタムクレーム（デバイス識別）で両立できる。客側は匿名サインインすら不要（anonキー＋セッション有効性チェックのみで十分）
  - Supabase Realtime（`postgres_changes`）はRLSを購読者ごとに評価するため安全だが、本規模（卓10〜20・厨房/レジ端末1〜3台）ではBroadcastへの切り替えが必要になる閾値（3,000同時購読）に遠く及ばない

## Research Log

### Supabase上での匿名アクセス・デバイス認証・Realtimeパターン
- **Context**: 客・厨房・レジ通常モードはいずれも個人ログイン不要という要件（8.1-8.3）を満たしつつ、厨房/レジの書き込み操作（セッション開始/終了、ステータス更新、売り切れ登録）を保護する必要がある
- **Sources Consulted**: Supabase公式ドキュメント（Row Level Security、Anonymous Sign-ins、Custom Access Token Hook、Realtime Postgres Changes、Auth Headers）
- **Findings**:
  - RLSはPostgresロール（`anon`/`authenticated`）単位で評価され、有効化を忘れると即座に全公開になる（実例あり）
  - 匿名サインイン（`signInAnonymously`）はデバイスに永続化でき、Custom Access Token Hookで`device_role`のようなカスタムクレームをJWTに埋め込める
  - `postgres_changes`はRLSを購読ごとに評価するが、本規模の同時接続数では性能上の懸念はない。再接続後の自動リプレイは保証されないため、再接続時に明示的な再取得が必要
  - PIN方式のオーナーモードは、Edge Function経由でPINを検証し短命JWTを発行する方式が、匿名セッションのアップグレードより運用がシンプル
- **Implications**: 客側は匿名サインインすら不要（anonキー＋RPC関数のみ）。厨房/レジのみ「デバイス識別」（匿名サインイン一回＋カスタムクレーム）を持つ。オーナーモード用に`owner_mode`クレームの名前空間を予約しておき、将来specでの追加を無理なく行えるようにする

### QR固定・セッション使い回し方式のドメイン検証
- **Context**: 卓固定QRを複数の来店グループが使い回す設計（要件4）が実運用で成立するか、他社事例で裏取りする
- **Sources Consulted**: USEN Mobile Order公式FAQ、Toast Mobile Order & Payコミュニティ、Square for Restaurantsコミュニティ（不具合報告）、国内QRオーダー比較記事、レストランデータモデルに関する実務記事
- **Findings**:
  - USENは「会計すると注文用URLが無効化され、退店後の客のスマホから追加注文は入らない」と明言しており、本spec全く同じ挙動
  - Squareでは時間経過のみでセッションを閉じる実装が原因で、古い卓割り当てが客端末に残り誤発注を招くバグが報告されている → **会計操作を唯一の正とし、タイムアウトのみに頼らない**という設計判断の裏付けになった
  - 実務上の頻出モデリングミスは「注文明細に単価スナップショットを持たない」こと（価格改定後に過去の注文金額が変わってしまう）
  - 呼び出し要求は注文とは別の軽量なエンティティとして持つのが一般的
  - 二重送信（ボタン連打）対策としてクライアント生成の冪等キーを使う設計が標準的
- **Implications**: セッション終了は会計操作のみをトリガーとする（要件3.3通り）。`order_items`に単価・商品名のスナップショットを持たせる。呼び出しは`call_requests`として独立管理する。`submit_order`に冪等キーを必須化する

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 生テーブル直RLS方式 | 各テーブルに対し細かいRLSポリシーを直接付与し、フロントから直接INSERT/UPDATE | 実装が直感的 | ポリシー漏れ・設定ミスが即座に全公開データ漏洩に直結（実例あり） | 不採用 |
| **RPC集約方式（採用）** | 書き込みは全てSECURITY DEFINERのPostgres関数経由。生テーブルはデフォルト拒否＋最小限のSELECTポリシーのみ | 攻撃面が小さい。セッション整合性・冪等性などの業務ルールを1箇所に集約できる | 関数の設計・レビューが重要になる | 採用。CustomerOrderingGateway / StaffOperationsGatewayとして設計 |
| Next.js API Route経由 | フロントは自前のNext.js API Routeを叩き、そこからSupabaseへ（サービスロールキー使用） | RLSに頼らず柔軟なロジックが書ける | 余分なサーバーレイヤーが増え、一人運用のデプロイ・監視対象が増える。Vercel Functionsのコールドスタートも増える | 不採用（Simplification原則により、Supabase単体で完結する構成を優先） |

## Design Decisions

### Decision: 書き込みはSECURITY DEFINER RPC関数に集約する
- **Context**: anonキー・デバイス認証いずれの経路でも、生テーブルへの直接書き込みは設定ミスのリスクが高いという調査結果
- **Alternatives Considered**:
  1. 生テーブルRLSで直接INSERT/UPDATEを許可
  2. Next.js API Route + service roleキーで仲介
- **Selected Approach**: `CustomerOrderingGateway`（客向け）と`StaffOperationsGateway`（厨房/レジ向け）という2系統のPostgres RPC関数群にすべての書き込みを集約し、生テーブルはRLS有効化＋デフォルト拒否＋最小限の閲覧ポリシーのみとする
- **Rationale**: 攻撃面を最小化しつつ、セッション整合性チェックなどの業務ルールをDBトランザクション内で原子的に実行できる
- **Trade-offs**: 関数の設計・命名規約を最初にきちんと決める必要があるが、追加のサーバーレイヤーは不要
- **Follow-up**: 実装時にRLSが「全ポリシー拒否」の状態で公開されていないか、anonロールでの直接テーブルアクセスができないことを結合テストで確認する

### Decision: 卓あたりのアクティブセッションはDBの部分ユニークインデックスで強制する
- **Context**: 要件4.1（卓ごとに同時アクティブセッションは高々1つ）をアプリケーションロジックだけで保証すると、同時操作によるレースコンディションの余地が残る
- **Alternatives Considered**:
  1. アプリ側で「既存セッションがないか確認してからINSERT」を順に実行
  2. DBの部分ユニークインデックス（`WHERE status = 'active'`）で強制
- **Selected Approach**: `table_sessions(table_id)`に対し`status = 'active'`の行のみを対象とした部分ユニークインデックスを張り、`start_session`関数内でこの制約違反を検知して`SESSION_ALREADY_ACTIVE`エラーに変換する
- **Rationale**: DB制約により、同時に複数の入店操作が来ても不整合なセッションが物理的に作られない
- **Trade-offs**: なし（オーバーヘッドは無視できる規模）

### Decision: 客側は匿名サインインすら行わない
- **Context**: 客側にもデバイス識別（匿名サインイン）を持たせるべきか検討
- **Alternatives Considered**:
  1. 客側にも匿名サインインを行わせ、認証済みユーザーとして扱う
  2. 客側はanonキーのみで、RPC関数内のセッション有効性チェックだけに依存する
- **Selected Approach**: 2を採用。客側には一切のサインイン処理を行わせない
- **Rationale**: 要件8.1（客に認証情報の入力を要求しない）を最も単純な形で満たし、実装・UXの複雑さを増やさない。セキュリティ境界は「有効なセッションIDか」で十分に担保できる
- **Trade-offs**: 客ごとの個体識別はできないが、本specの要件はそれを必要としていない

### Decision: オーナーモード用のクレーム名前空間を予約する（実装はしない）
- **Context**: 将来specで追加される「オーナーモード」（商品登録・売上管理）が、本specのデバイス識別基盤と衝突しないようにしたい
- **Selected Approach**: JWTのカスタムクレームを`device_role`（本spec: kitchen/register）と`owner_mode`（将来spec: boolean）に分離しておく
- **Rationale**: 将来specが本specのデバイス認証を作り直す必要がなくなる
- **Trade-offs**: なし。本specでは`owner_mode`クレームを発行するロジック自体は実装しない

### Decision: ステータスは注文（order）ではなく注文明細（order_item）に持たせ、ジャンルごとに許可遷移を変える
- **Context**: 厨房でのモックレビューを通じて、フード（未対応/調理中/調理完了）とドリンク（未対応/対応済み）で調理にかかる時間が大きく異なり、同じ注文の中でも品目ごとに別々のタイミングで進行することが判明した
- **Alternatives Considered**:
  1. 注文（order）単位でステータスを持ち続け、フード/ドリンクを含む注文は全品目が揃うまで次のステータスに進めない
  2. 注文明細（order_item）ごとにステータスを持ち、品目のジャンルに応じて許可される遷移を変える
- **Selected Approach**: 2を採用。`order_items.status`を`received`/`in_progress`/`done`の3値で持ち、ドリンクジャンルは運用上`in_progress`を使わず`received → done`のみ、フード/一品ジャンルは3段階で遷移する。一品ジャンルのみ`received → done`への直接遷移も許可する
- **Rationale**: 注文単位のままだと「ドリンクは提供済みだがフードがまだ」という実態を表現できず、厨房の実運用（まとめて調理できない）と合わなくなる
- **Trade-offs**: 許可遷移の判定が`menu_items.genre`を参照する必要があり、DBのCHECK制約だけでは表現できない（`update_order_item_status`関数内のロジックとして実装する）
- **Follow-up**: 実装時に、ジャンルごとの許可遷移表をテストで固定化し、将来ジャンルが増えた場合の拡張ポイントを明確にする

### Decision: 厨房は1台のタブレットで、フード/ドリンク/売り切れをタブ切り替えする
- **Context**: 当初はフード担当とドリンク担当を別の物理タブレット2台に分ける案を検討したが、レビューの中で「厨房画面は1つ」という方針に変更された
- **Alternatives Considered**:
  1. フード用・ドリンク用の物理タブレット2台構成（担当ごとに専用端末を持つ）
  2. 1台のタブレットの中に「フードボード」「ドリンクボード」「売り切れボード」の3タブを設け、スタッフが切り替えて使う
- **Selected Approach**: 2を採用
- **Rationale**: 小規模店舗では、担当が固定の2人体制とは限らず、1台を共用できた方が導入・運用コストが低い。データ設計（`order_items`をジャンルでフィルタして表示するだけ）は2台構成でも1台構成でも変わらないため、後から複数台構成に分割する場合も大きな設計変更は不要
- **Trade-offs**: 混雑時に1台のタブレットをフード担当とドリンク担当が奪い合う可能性があるが、タブ切り替えは一瞬で済むため許容範囲と判断
- **Follow-up**: 実際の運用で2台に分けたいという要望が出た場合、`StaffOperationsGateway`のインターフェースは変更不要で、フロントエンドのルーティング（画面をどのタブレットに表示するか）のみの変更で対応できる

### Decision: メニューのオプション（味付け・トグル・個数）はJSONBスキーマで汎用的に持つ
- **Context**: 「焼き鳥はたれ/塩」「寿司はわさび抜き」「瓶ビールはグラス数」のように、品目ごとに異なる種類の選択肢を持たせたいという要望があった
- **Alternatives Considered**:
  1. 品目テーブルに`sauce_choice`、`wasabi_option`のような専用カラムを都度追加する
  2. `menu_items.options`をJSONB配列とし、`{ id, type: "choice"|"toggle"|"counter", label, ... }`という共通スキーマで表現する
- **Selected Approach**: 2を採用。客の選択結果は`order_items.options_selected`（生データ）と`options_summary`（厨房/レジ表示用の要約文字列）の両方を注文時点でスナップショットする
- **Rationale**: 品目ごとに専用カラムを増やす方式は、将来オプションの種類が増えるたびにマイグレーションが必要になる。JSONBスキーマなら`menu_items`側のデータ追加だけで新しいオプション付き品目を増やせる
- **Trade-offs**: JSONB内の構造はアプリケーション側で検証する必要があり、DBレベルの型安全性は弱まる。`submit_order`関数内でのバリデーションが重要になる

### Future Consideration: 飲み放題（コース時間制）に応じた卓マップの色分け
- **Context**: レジの卓マップで「長時間滞在への注意表示」を検討したが、レビューの中で「それより飲み放題などの時間制コースの残り時間を色で示す方が価値が高い」という指摘があった
- **Selected Approach**: 本specでは滞在時間による色分け・注意表示は実装しない。将来のspec（おそらくオーナーモードでのコース設定と合わせて）で、来店セッションにコース種別・制限時間を持たせ、残り時間に応じて卓マップの色を変える機能として再検討する
- **Follow-up**: 将来spec化する際は、`table_sessions`にコース情報（コース種別・開始時刻・制限時間）を追加する設計になる見込み

## Risks & Mitigations
- **RLS設定漏れによるデータ全公開** — 生テーブルへの直接grantを行わず、RPC関数経由のみに限定する。デプロイ前チェックリストに「anonロールで生テーブルに直接アクセスできないことの確認」を含める
- **QRコードのSNS拡散等による大量不正注文**（海外事例あり） — `submit_order`にセッション単位のレート制限（例: 1分あたりの送信回数上限）を設ける
- **厨房タブレットの匿名セッションのJWT失効によるRealtime切断** — クライアント側でトークンリフレッシュを有効化し、再接続時に未提供注文一覧を再取得（reconciliation）する
- **時間経過に頼ったセッション終了で古いセッションが残り続ける**（Square事例） — 会計操作のみを正式なセッション終了トリガーとし、長時間（例: 6時間以上）アクティブなセッションはレジ画面に注意喚起表示するのみに留め、自動クローズは行わない

## References
- [USEN Mobile Order FAQ](https://usen.com/service/pos/order-system/faq/mobileorder.html) — 会計によるセッション無効化の実例
- [Toast Mobile Order & Pay FAQs](https://support.toasttab.com/en/article/Toast-Mobile-Order-and-Pay-FAQs) — スタッフ起点でのチェックオープン方式
- [Square Community: QR Code Table Ordering Return Visit Issue](https://community.squareup.com/t5/Square-for-Restaurants/QR-Code-Table-Ordering-amp-Return-Visit-Issue/td-p/221844) — タイムアウトのみに依存する設計の失敗例
- [Supabase: Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase: Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous)
- [Supabase: Custom Access Token Hook](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook)
- [Supabase: Postgres Changes (Realtime)](https://supabase.com/docs/guides/realtime/postgres-changes)
- [Red Gate: A Data Model for Restaurants](https://www.red-gate.com/blog/serving-delicious-food-and-data-a-data-model-for-restaurants/) — 単価スナップショットの重要性
