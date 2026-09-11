import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserClient } from "./client";

const ORIGINAL_ENV = { ...process.env };

describe("createBrowserClient", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("NEXT_PUBLIC_SUPABASE_URLが未設定の場合、明確なエラーを投げる", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";

    expect(() => createBrowserClient()).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL/,
    );
  });

  it("NEXT_PUBLIC_SUPABASE_ANON_KEYが未設定の場合、明確なエラーを投げる", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    expect(() => createBrowserClient()).toThrow(
      /NEXT_PUBLIC_SUPABASE_ANON_KEY/,
    );
  });

  it("両方の環境変数が設定されている場合、Supabaseクライアントを返す", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";

    const client = createBrowserClient();

    expect(client).toBeDefined();
    expect(typeof client.from).toBe("function");
    expect(typeof client.auth.signInAnonymously).toBe("function");
  });
});
