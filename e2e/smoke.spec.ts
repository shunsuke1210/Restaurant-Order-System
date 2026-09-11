import { test, expect } from "@playwright/test";

test("厨房画面が表示される", async ({ page }) => {
  const response = await page.goto("/kitchen");
  expect(response?.ok()).toBeTruthy();
  await expect(
    page.getByRole("heading", { name: "厨房画面" }),
  ).toBeVisible();
});
