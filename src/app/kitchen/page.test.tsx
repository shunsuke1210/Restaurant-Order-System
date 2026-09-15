import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import KitchenPage from "./page";

// KitchenPage（page.tsx）は、実際のデバイスセッション確認・3タブ切り替え・
// 固定ヘッダーのロジックを一切持たず、KitchenBoardScreen（クライアント
// コンポーネント）へそのまま委譲する薄いサーバーコンポーネントの
// ラッパーであることのみを検証する（src/app/order/[tableId]/page.test.tsx
// と同じ構成・同じ理由: 実際の挙動はKitchenBoardScreen.test.tsxが検証する）。
vi.mock("./KitchenBoardScreen", () => ({
  default: () => <div data-testid="kitchen-board-screen-stub" />,
}));

describe("KitchenPage", () => {
  it("KitchenBoardScreenを描画する", () => {
    render(<KitchenPage />);

    expect(
      screen.getByTestId("kitchen-board-screen-stub"),
    ).toBeInTheDocument();
  });
});
