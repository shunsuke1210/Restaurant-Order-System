import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// createBrowserClient()をモックし、DeviceIdentityProviderのロジック
// （JWTクレームのデコード、Result型の分岐、ローカルキャッシュの読み書き）を
// 実際のSupabase/DBに接続せずに検証する。RPC/セッション周りの実際の挙動
// （provision_deviceの成否・device_roleクレームの反映）は
// provisionDevice.integration.test.tsで実DBに対して検証する。
const mockGetSession = vi.fn();
const mockSignInAnonymously = vi.fn();
const mockRefreshSession = vi.fn();
const mockRpc = vi.fn();

vi.mock("../supabase/client", () => ({
  createBrowserClient: () => ({
    auth: {
      getSession: mockGetSession,
      signInAnonymously: mockSignInAnonymously,
      refreshSession: mockRefreshSession,
    },
    rpc: mockRpc,
  }),
}));

const STORAGE_KEY = "table-order-kitchen:device-identity";

/** JWTのペイロード部分のみを本物らしくbase64url符号化したダミートークンを作る。 */
function makeAccessToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}

function sessionFor(userId: string, claims: Record<string, unknown> = {}) {
  return {
    access_token: makeAccessToken({ sub: userId, ...claims }),
    user: { id: userId },
  };
}

describe("useDeviceIdentity", () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetSession.mockReset();
    mockSignInAnonymously.mockReset();
    mockRefreshSession.mockReset();
    mockRpc.mockReset();
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  describe("ensureDeviceSession", () => {
    it("既存セッションがなければ匿名サインインしてからクレームを判定する", async () => {
      mockGetSession.mockResolvedValue({ data: { session: null } });
      mockSignInAnonymously.mockResolvedValue({
        data: { session: sessionFor("user-1"), user: { id: "user-1" } },
        error: null,
      });

      const { ensureDeviceSession } = await import("./useDeviceIdentity");
      const result = await ensureDeviceSession();

      expect(mockSignInAnonymously).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: false, error: { code: "NOT_PROVISIONED" } });
    });

    it("既存セッションがある場合は匿名サインインを呼ばない", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: sessionFor("user-1", { device_role: "kitchen" }) },
      });

      const { ensureDeviceSession } = await import("./useDeviceIdentity");
      await ensureDeviceSession();

      expect(mockSignInAnonymously).not.toHaveBeenCalled();
    });

    it("device_roleクレームがない場合はNOT_PROVISIONEDを返す（客の匿名セッションと同型）", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: sessionFor("user-1") },
      });

      const { ensureDeviceSession } = await import("./useDeviceIdentity");
      const result = await ensureDeviceSession();

      expect(result).toEqual({ ok: false, error: { code: "NOT_PROVISIONED" } });
    });

    it("device_roleクレームがあり、ローカルキャッシュと整合する場合はDeviceIdentityを返す", async () => {
      const identity = {
        deviceUserId: "user-1",
        role: "kitchen",
        storeId: "store-1",
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
      mockGetSession.mockResolvedValue({
        data: { session: sessionFor("user-1", { device_role: "kitchen" }) },
      });

      const { ensureDeviceSession } = await import("./useDeviceIdentity");
      const result = await ensureDeviceSession();

      expect(result).toEqual({ ok: true, value: identity });
    });

    it("device_roleクレームはあるがローカルキャッシュがない場合はNOT_PROVISIONEDを返す（再セットアップを促す）", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: sessionFor("user-1", { device_role: "kitchen" }) },
      });

      const { ensureDeviceSession } = await import("./useDeviceIdentity");
      const result = await ensureDeviceSession();

      expect(result).toEqual({ ok: false, error: { code: "NOT_PROVISIONED" } });
    });

    it("ローカルキャッシュのroleがJWTのdevice_roleクレームと矛盾する場合はキャッシュを破棄しNOT_PROVISIONEDを返す", async () => {
      const staleIdentity = {
        deviceUserId: "user-1",
        role: "register",
        storeId: "store-1",
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(staleIdentity));
      mockGetSession.mockResolvedValue({
        data: { session: sessionFor("user-1", { device_role: "kitchen" }) },
      });

      const { ensureDeviceSession, getCurrentDevice } = await import(
        "./useDeviceIdentity"
      );
      const result = await ensureDeviceSession();

      expect(result).toEqual({ ok: false, error: { code: "NOT_PROVISIONED" } });
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(getCurrentDevice()).toBeNull();
    });

    it("access_tokenが不正な形式の場合もクラッシュせずNOT_PROVISIONEDを返す", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: { access_token: "not-a-jwt", user: { id: "user-1" } } },
      });

      const { ensureDeviceSession } = await import("./useDeviceIdentity");
      const result = await ensureDeviceSession();

      expect(result).toEqual({ ok: false, error: { code: "NOT_PROVISIONED" } });
    });
  });

  describe("provisionDevice", () => {
    it("成功時: RPCを正しい引数で呼び、セッションをrefreshし、DeviceIdentityを返してキャッシュする", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: sessionFor("user-1") },
      });
      mockRpc.mockResolvedValue({
        data: {
          id: "device-1",
          auth_user_id: "user-1",
          store_id: "store-1",
          role: "kitchen",
        },
        error: null,
      });
      mockRefreshSession.mockResolvedValue({
        data: { session: sessionFor("user-1", { device_role: "kitchen" }) },
        error: null,
      });

      const { provisionDevice, getCurrentDevice } = await import(
        "./useDeviceIdentity"
      );
      const result = await provisionDevice({
        setupCode: "correct-code",
        role: "kitchen",
        storeId: "store-1",
      });

      expect(mockRpc).toHaveBeenCalledWith("provision_device", {
        p_setup_code: "correct-code",
        p_role: "kitchen",
        p_store_id: "store-1",
      });
      expect(mockRefreshSession).toHaveBeenCalledTimes(1);
      const expectedIdentity = {
        deviceUserId: "user-1",
        role: "kitchen",
        storeId: "store-1",
      };
      expect(result).toEqual({ ok: true, value: expectedIdentity });
      expect(getCurrentDevice()).toEqual(expectedIdentity);
      expect(
        JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null"),
      ).toEqual(expectedIdentity);
    });

    it("セットアップコード不一致（SQLSTATE P0401）の場合はINVALID_SETUP_CODEを返し、セッションをrefreshしない", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: sessionFor("user-1") },
      });
      mockRpc.mockResolvedValue({
        data: null,
        error: { code: "P0401", message: "invalid setup code" },
      });

      const { provisionDevice } = await import("./useDeviceIdentity");
      const result = await provisionDevice({
        setupCode: "wrong-code",
        role: "kitchen",
        storeId: "store-1",
      });

      expect(result).toEqual({ ok: false, error: { code: "INVALID_SETUP_CODE" } });
      expect(mockRefreshSession).not.toHaveBeenCalled();
    });

    it("想定外のRPCエラーの場合はResultに変換せず例外を送出する", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: sessionFor("user-1") },
      });
      mockRpc.mockResolvedValue({
        data: null,
        error: { code: "XX000", message: "unexpected failure" },
      });

      const { provisionDevice } = await import("./useDeviceIdentity");

      await expect(
        provisionDevice({ setupCode: "any", role: "kitchen", storeId: "store-1" }),
      ).rejects.toThrow(/unexpected failure/);
    });
  });

  describe("getCurrentDevice", () => {
    it("何もキャッシュされていない場合はnullを返す", async () => {
      const { getCurrentDevice } = await import("./useDeviceIdentity");
      expect(getCurrentDevice()).toBeNull();
    });

    it("localStorageに永続化されたDeviceIdentityがあれば、ensureDeviceSessionを呼ばなくても返す", async () => {
      const identity = {
        deviceUserId: "user-1",
        role: "register",
        storeId: "store-1",
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));

      const { getCurrentDevice } = await import("./useDeviceIdentity");
      expect(getCurrentDevice()).toEqual(identity);
    });

    it("破損したlocalStorageの値は無視してnullを返す", async () => {
      window.localStorage.setItem(STORAGE_KEY, "not-json");

      const { getCurrentDevice } = await import("./useDeviceIdentity");
      expect(getCurrentDevice()).toBeNull();
    });
  });

  describe("useDeviceIdentity（フック）", () => {
    it("ensureDeviceSession/provisionDevice/getCurrentDeviceを持つオブジェクトを返す", async () => {
      const { useDeviceIdentity } = await import("./useDeviceIdentity");
      const api = useDeviceIdentity();

      expect(typeof api.ensureDeviceSession).toBe("function");
      expect(typeof api.provisionDevice).toBe("function");
      expect(typeof api.getCurrentDevice).toBe("function");
    });
  });
});
