import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// vitest.config.tsはtest.globalsを有効化していない（各テストファイルが
// vitestから明示的にdescribe/it/expect等をimportする方針）ため、
// @testing-library/reactの自動cleanup（afterEachのグローバル検出に依存する）は
// 効かない。同一テストファイル内で複数回render()するテスト
// （例: src/app/setup/[role]/SetupForm.test.tsx）がDOMの汚染で
// 誤って複数要素にマッチしてしまうのを防ぐため、ここで明示的に登録する。
afterEach(() => {
  cleanup();
});
