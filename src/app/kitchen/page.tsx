import KitchenBoardScreen from "./KitchenBoardScreen";

/**
 * 厨房KDS画面のルートエントリ。
 * デバイスセッション確認・3タブ切り替え・固定ヘッダーの実際のロジックは
 * すべてKitchenBoardScreen（クライアントコンポーネント）へ委譲する薄い
 * サーバーコンポーネントのラッパー（src/app/order/[tableId]/page.tsxと
 * 同じ構成）。タスク1.1のプレースホルダー見出しを、タスク7.1の実装で
 * 置き換える。
 */
export default function KitchenPage() {
  return <KitchenBoardScreen />;
}
