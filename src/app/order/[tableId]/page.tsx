type OrderPageProps = {
  params: Promise<{ tableId: string }>;
};

// 客向け注文画面のプレースホルダー。
// メニュー表示・カート・呼び出しボタン等の実装は後続タスクで行う。
export default async function OrderPage({ params }: OrderPageProps) {
  const { tableId } = await params;

  return (
    <main>
      <h1>客注文画面 (卓: {tableId})</h1>
    </main>
  );
}
