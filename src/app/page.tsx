// トップページのプレースホルダー。
// 役割別ルート（/order/[tableId], /kitchen, /register, /setup/[role]）へは
// QRコードや店舗設置デバイスから直接アクセスする想定のため、ここでは案内のみ表示する。
export default function Home() {
  return (
    <main>
      <h1>Table Order &amp; Kitchen</h1>
      <p>役割別の画面（客注文・厨房・レジ・デバイスセットアップ）は各URLからアクセスしてください。</p>
    </main>
  );
}
