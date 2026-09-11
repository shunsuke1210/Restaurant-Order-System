import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import SetupPage from "./page";

const mockEnsureDeviceSession = vi.fn();

vi.mock("@/lib/device/useDeviceIdentity", () => ({
  ensureDeviceSession: (...args: unknown[]) => mockEnsureDeviceSession(...args),
  provisionDevice: vi.fn(),
  getCurrentDevice: vi.fn(() => null),
}));

describe("SetupPage", () => {
  it("roleがkitchen/register以外の場合はnotFound()相当（例外）になる", async () => {
    await expect(
      SetupPage({ params: Promise.resolve({ role: "owner" }) }),
    ).rejects.toThrow();
  });

  it("有効なroleの場合はセットアップ画面（SetupForm）を描画する", async () => {
    mockEnsureDeviceSession.mockResolvedValue({
      ok: false,
      error: { code: "NOT_PROVISIONED" },
    });

    const jsx = await SetupPage({
      params: Promise.resolve({ role: "kitchen" }),
    });
    render(jsx);

    expect(
      await screen.findByRole("heading", { name: /デバイスセットアップ/ }),
    ).toBeInTheDocument();
  });
});
