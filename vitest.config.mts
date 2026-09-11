import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // ViteはデフォルトではVITE_接頭辞の変数のみをimport.meta.env向けに
  // 公開し、.env.local等の中身をprocess.envへは自動反映しない
  // （import.meta.envとprocess.envは別経路）。本リポジトリの結合テスト
  // （例: src/lib/supabase/provisionDevice.integration.test.ts）は
  // @vitest-environment nodeで動作し、Next.jsを経由せずprocess.env.*
  // （DEVICE_SETUP_CODEやSUPABASE_DB_URL等、NEXT_PUBLIC_接頭辞なしの値を
  // 含む）を直接参照するため、ここで明示的に.env / .env.localをロードし
  // process.envへマージする（第三引数を空文字列にすることで接頭辞フィルタを
  // 無効化し、全キーを対象にする）。既にprocess.envに設定済みのキー
  // （実行環境の環境変数やCIのsecrets）は上書きしない。
  const env = loadEnv(mode, process.cwd(), "");
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return {
    resolve: {
      tsconfigPaths: true,
    },
    plugins: [react()],
    test: {
      environment: "jsdom",
      setupFiles: ["./vitest.setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      exclude: ["node_modules/**", ".next/**", "e2e/**"],
    },
  };
});
