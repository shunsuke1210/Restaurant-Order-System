import { test, expect } from "@playwright/test";

test("厨房画面が表示される", async ({ page }) => {
  const response = await page.goto("/kitchen");
  expect(response?.ok()).toBeTruthy();
  // タスク7.1でsrc/app/kitchen/page.tsxがタスク1.1のプレースホルダー
  // （固定の「厨房画面」見出し）から実装に置き換わったことに伴う更新。
  // このE2E環境ではデバイスが未プロビジョニングのため、通常は
  // KitchenBoardScreenの案内メッセージ（「厨房画面を利用できません」）が
  // 表示されるが、既にプロビジョニング済みの環境で実行された場合でも
  // クラッシュせず本来のタブ付きボード（フードボードタブ）が表示される
  // ことを確認する（どちらの分岐でもページがエラーなく意味のあるUIを
  // 描画すること自体がこのスモークテストの目的）。
  await expect(
    page
      .getByRole("heading", { name: "厨房画面を利用できません" })
      .or(page.getByRole("tab", { name: "フードボード" })),
  ).toBeVisible();
});
