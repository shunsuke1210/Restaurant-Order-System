import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import OrderPage from "./page";

// OrderPage（page.tsx）は、ルートパラメータからtableIdを取り出し
// MenuScreen（クライアントコンポーネント、実際のメニュー表示・オプション選択
// ロジックはこちらが担う）へそのまま渡す薄いサーバーコンポーネントの
// ラッパーであることのみを検証する（Next.js App Routerの規約、
// src/app/setup/[role]/page.tsxと同じ構成）。
vi.mock("./MenuScreen", () => ({
  default: ({ tableId }: { tableId: string }) => (
    <div data-testid="menu-screen-stub">{tableId}</div>
  ),
}));

describe("OrderPage", () => {
  it("ルートパラメータのtableIdをMenuScreenへそのまま渡す", async () => {
    const jsx = await OrderPage({
      params: Promise.resolve({ tableId: "table-abc" }),
    });
    render(jsx);

    expect(screen.getByTestId("menu-screen-stub")).toHaveTextContent(
      "table-abc",
    );
  });
});
