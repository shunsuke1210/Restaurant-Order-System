import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import KitchenPage from "./page";

describe("KitchenPage", () => {
  it("厨房画面という見出しを表示する", () => {
    render(<KitchenPage />);
    expect(
      screen.getByRole("heading", { name: "厨房画面" }),
    ).toBeInTheDocument();
  });
});
