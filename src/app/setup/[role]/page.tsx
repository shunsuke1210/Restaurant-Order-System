type SetupPageProps = {
  params: Promise<{ role: string }>;
};

// 厨房/レジタブレットの初回デバイスプロビジョニング画面のプレースホルダー。
// セットアップコード入力・匿名サインインの実装は後続タスクで行う。
export default async function SetupPage({ params }: SetupPageProps) {
  const { role } = await params;

  return (
    <main>
      <h1>デバイスセットアップ ({role})</h1>
    </main>
  );
}
