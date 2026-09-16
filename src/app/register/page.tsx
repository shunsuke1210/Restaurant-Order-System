import RegisterConsoleScreen from "./RegisterConsoleScreen";

/**
 * レジ画面のルートエントリ。
 * デバイスセッション確認・卓マップ表示の実際のロジックはすべて
 * RegisterConsoleScreen（クライアントコンポーネント）へ委譲する薄い
 * サーバーコンポーネントのラッパー（src/app/kitchen/page.tsxと同じ構成）。
 * タスク1.1のプレースホルダー見出しを、タスク8.1の実装で置き換える。
 */
export default function RegisterPage() {
  return <RegisterConsoleScreen />;
}
