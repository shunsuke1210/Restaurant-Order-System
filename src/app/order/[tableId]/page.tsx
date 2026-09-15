import MenuScreen from "./MenuScreen";

type OrderPageProps = {
  params: Promise<{ tableId: string }>;
};

/**
 * 客向け注文画面のルートエントリ。
 * ルートパラメータからtableIdを取り出しMenuScreen（クライアント
 * コンポーネント）へそのまま渡す薄いサーバーコンポーネント。
 * 実際のメニュー取得・表示・オプション選択ロジックは全てMenuScreenが担う
 * （src/app/setup/[role]/page.tsx + SetupFormと同じ構成）。
 */
export default async function OrderPage({ params }: OrderPageProps) {
  const { tableId } = await params;

  return <MenuScreen tableId={tableId} />;
}
