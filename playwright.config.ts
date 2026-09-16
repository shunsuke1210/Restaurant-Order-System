import { loadEnv } from "vite";
import { defineConfig, devices } from "@playwright/test";

// vitest.config.mtsと同じ理由（同ファイル冒頭コメント参照）: Playwrightの
// spec自体はNext.jsを経由せずNodeプロセスとして実行されるため、
// `.env.local`（SUPABASE_DB_URL/DEVICE_SETUP_CODE/NEXT_PUBLIC_STORE_ID等、
// NEXT_PUBLIC_接頭辞なしの値を含む）はprocess.envへ自動反映されない。
// タスク7.4のsoldout-board.spec.tsが「実DBへseedし、実際の/setup/kitchenで
// デバイスをプロビジョニングし、DB直接問い合わせで永続化を検証する」という
// 結合的なE2E検証を行うために、ここで明示的にロードする（webServerとして
// 起動する`next dev`自体は.env.localを独自に読み込むため影響しない）。
const env = loadEnv("development", process.cwd(), "");
for (const [key, value] of Object.entries(env)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
