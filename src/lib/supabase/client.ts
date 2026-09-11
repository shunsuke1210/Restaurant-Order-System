import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * ブラウザ（客・厨房・レジの各クライアント画面）から利用する
 * 型付きSupabaseクライアントを生成する。
 *
 * `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` は
 * ブラウザに露出してよい公開値だが、未設定のまま`undefined`で
 * クライアントを生成すると失敗が実行時まで見えづらくなるため、
 * ここで明示的にエラーを投げてfail-fastする。
 */
export function createBrowserClient(): SupabaseClient<Database> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL is not set. Define it in your environment (e.g. .env.local) before creating a Supabase client.",
    );
  }

  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseAnonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. Define it in your environment (e.g. .env.local) before creating a Supabase client.",
    );
  }

  return createClient<Database>(supabaseUrl, supabaseAnonKey);
}
