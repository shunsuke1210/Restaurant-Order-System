import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SetupForm from "./SetupForm";

const mockEnsureDeviceSession = vi.fn();
const mockProvisionDevice = vi.fn();

vi.mock("@/lib/device/useDeviceIdentity", () => ({
  ensureDeviceSession: (...args: unknown[]) => mockEnsureDeviceSession(...args),
  provisionDevice: (...args: unknown[]) => mockProvisionDevice(...args),
  getCurrentDevice: vi.fn(() => null),
}));

const ORIGINAL_ENV = { ...process.env };

describe("SetupForm", () => {
  beforeEach(() => {
    mockEnsureDeviceSession.mockReset();
    mockProvisionDevice.mockReset();
    process.env = { ...ORIGINAL_ENV, NEXT_PUBLIC_STORE_ID: "store-1" };
  });

  it("未プロビジョニングの場合、セットアップコード入力フォームを表示する", async () => {
    mockEnsureDeviceSession.mockResolvedValue({
      ok: false,
      error: { code: "NOT_PROVISIONED" },
    });

    render(<SetupForm role="kitchen" />);

    expect(
      await screen.findByLabelText("セットアップコード"),
    ).toBeInTheDocument();
  });

  it("既にプロビジョニング済みの場合、フォームを表示せず完了状態を表示する（再訪時に認証UIが表示されない）", async () => {
    mockEnsureDeviceSession.mockResolvedValue({
      ok: true,
      value: { deviceUserId: "user-1", role: "kitchen", storeId: "store-1" },
    });

    render(<SetupForm role="kitchen" />);

    expect(await screen.findByText(/セットアップ済み/)).toBeInTheDocument();
    expect(
      screen.queryByLabelText("セットアップコード"),
    ).not.toBeInTheDocument();
    expect(mockProvisionDevice).not.toHaveBeenCalled();
  });

  it("正しいセットアップコードを送信すると、route roleと設定済み店舗IDでprovisionDeviceを呼び、完了状態を表示する（happy path）", async () => {
    mockEnsureDeviceSession.mockResolvedValue({
      ok: false,
      error: { code: "NOT_PROVISIONED" },
    });
    mockProvisionDevice.mockResolvedValue({
      ok: true,
      value: { deviceUserId: "user-1", role: "kitchen", storeId: "store-1" },
    });

    render(<SetupForm role="kitchen" />);

    const input = await screen.findByLabelText("セットアップコード");
    fireEvent.change(input, { target: { value: "correct-code" } });
    fireEvent.click(screen.getByRole("button", { name: "セットアップする" }));

    await waitFor(() => {
      expect(mockProvisionDevice).toHaveBeenCalledWith({
        setupCode: "correct-code",
        role: "kitchen",
        storeId: "store-1",
      });
    });

    expect(await screen.findByText(/セットアップ済み/)).toBeInTheDocument();
    expect(
      screen.queryByLabelText("セットアップコード"),
    ).not.toBeInTheDocument();
  });

  it("誤ったセットアップコードを送信すると、明確なエラーを表示しフォームは表示され続ける（invalid-code path）", async () => {
    mockEnsureDeviceSession.mockResolvedValue({
      ok: false,
      error: { code: "NOT_PROVISIONED" },
    });
    mockProvisionDevice.mockResolvedValue({
      ok: false,
      error: { code: "INVALID_SETUP_CODE" },
    });

    render(<SetupForm role="register" />);

    const input = await screen.findByLabelText("セットアップコード");
    fireEvent.change(input, { target: { value: "wrong-code" } });
    fireEvent.click(screen.getByRole("button", { name: "セットアップする" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "セットアップコードが正しくありません",
    );
    expect(screen.getByLabelText("セットアップコード")).toBeInTheDocument();
  });

  it("provisionDeviceが想定外の例外を投げた場合、汎用エラーメッセージを表示する", async () => {
    mockEnsureDeviceSession.mockResolvedValue({
      ok: false,
      error: { code: "NOT_PROVISIONED" },
    });
    mockProvisionDevice.mockRejectedValue(new Error("network down"));

    render(<SetupForm role="kitchen" />);

    const input = await screen.findByLabelText("セットアップコード");
    fireEvent.change(input, { target: { value: "any-code" } });
    fireEvent.click(screen.getByRole("button", { name: "セットアップする" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "予期しないエラー",
    );
  });

  it("NEXT_PUBLIC_STORE_IDが未設定の場合、provisionDeviceを呼ばずエラーを表示する", async () => {
    delete process.env.NEXT_PUBLIC_STORE_ID;
    mockEnsureDeviceSession.mockResolvedValue({
      ok: false,
      error: { code: "NOT_PROVISIONED" },
    });

    render(<SetupForm role="kitchen" />);

    const input = await screen.findByLabelText("セットアップコード");
    fireEvent.change(input, { target: { value: "any-code" } });
    fireEvent.click(screen.getByRole("button", { name: "セットアップする" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("店舗ID");
    expect(mockProvisionDevice).not.toHaveBeenCalled();
  });
});
