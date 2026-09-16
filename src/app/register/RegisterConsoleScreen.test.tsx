import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RegisterConsoleScreen from "./RegisterConsoleScreen";

// ensureDeviceSessionをモックし、RegisterConsoleScreenのロジック（デバイス
// セッション確認の分岐）を実際のSupabase/DBに接続せずに検証する
// （KitchenBoardScreen.test.tsxと同じモック方式）。

const mockEnsureDeviceSession = vi.fn();

vi.mock("@/lib/device/useDeviceIdentity", () => ({
  ensureDeviceSession: (...args: unknown[]) => mockEnsureDeviceSession(...args),
}));

// FloorMap自体の詳細な振る舞い（エリア分け・タイル表示・呼び出しバッジ等）は
// FloorMap.test.tsxが専用に検証するため、ここではRegisterConsoleScreen固有の
// 関心事（デバイスセッション確認の分岐）を阻害しないよう空配列を返す最小限の
// モックに留める（KitchenBoardScreen.test.tsxのlistKitchenFeedモックと同型）。
const mockListRegisterFeed = vi.fn();

vi.mock("@/lib/gateways/staffOperationsGateway", () => ({
  createStaffOperationsGateway: () => ({
    listRegisterFeed: (...args: unknown[]) => mockListRegisterFeed(...args),
  }),
}));

describe("RegisterConsoleScreen", () => {
  beforeEach(() => {
    mockEnsureDeviceSession.mockReset();
    mockListRegisterFeed.mockReset();
    mockListRegisterFeed.mockResolvedValue({ ok: true, value: [] });
  });

  it("デバイスが未プロビジョニング（NOT_PROVISIONED）の場合、クラッシュせず案内メッセージを表示する", async () => {
    mockEnsureDeviceSession.mockResolvedValue({
      ok: false,
      error: { code: "NOT_PROVISIONED" },
    });

    render(<RegisterConsoleScreen />);

    expect(
      await screen.findByTestId("register-device-unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("セットアップ");
    expect(
      screen.queryByTestId("register-floor-map"),
    ).not.toBeInTheDocument();
  });

  it("ensureDeviceSessionが例外を投げても（ドキュメント化されていない失敗）、クラッシュせず案内メッセージを表示する", async () => {
    mockEnsureDeviceSession.mockRejectedValue(new Error("network error"));

    render(<RegisterConsoleScreen />);

    expect(
      await screen.findByTestId("register-device-unavailable"),
    ).toBeInTheDocument();
  });

  it("register以外のroleでプロビジョニング済みの場合も、クラッシュせず案内メッセージを表示する", async () => {
    mockEnsureDeviceSession.mockResolvedValue({
      ok: true,
      value: { deviceUserId: "user-1", role: "kitchen", storeId: "store-1" },
    });

    render(<RegisterConsoleScreen />);

    expect(
      await screen.findByTestId("register-device-unavailable"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("register-floor-map"),
    ).not.toBeInTheDocument();
  });

  it("registerデバイスとしてプロビジョニング済みの場合、卓マップ（FloorMap）が表示される", async () => {
    mockEnsureDeviceSession.mockResolvedValue({
      ok: true,
      value: { deviceUserId: "user-1", role: "register", storeId: "store-1" },
    });

    render(<RegisterConsoleScreen />);

    expect(await screen.findByTestId("register-floor-map")).toBeInTheDocument();
    expect(mockListRegisterFeed).toHaveBeenCalledWith({ storeId: "store-1" });
  });
});
