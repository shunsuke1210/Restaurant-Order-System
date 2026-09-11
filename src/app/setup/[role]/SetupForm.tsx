"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  ensureDeviceSession,
  provisionDevice,
  type DeviceIdentity,
  type DeviceRole,
} from "@/lib/device/useDeviceIdentity";

type SetupFormProps = {
  role: DeviceRole;
};

type ViewState =
  | { status: "checking" }
  | { status: "needs-setup" }
  | { status: "provisioned"; identity: DeviceIdentity };

const ROLE_LABEL: Record<DeviceRole, string> = {
  kitchen: "厨房",
  register: "レジ",
};

/**
 * 単一店舗前提のv1における店舗IDの取得元。
 *
 * design.mdのNon-Goals/Out of Boundaryは「卓自体の登録・QRコード発行機能
 * （初期データは移行作業として本spec範囲外で投入する）」「stores/tablesの
 * 初期データは本spec範囲外の手動投入作業として扱う」と明記しており、
 * storesテーブルへ行を投入する仕組み自体は本タスク（2.3）の範囲外。
 * そのため、運用者が手動でstores行を作成した後、そのidをこの環境変数へ
 * 設定する運用を前提とする（CONCERNS: タスク完了報告に記載）。
 * セットアップコード（DEVICE_SETUP_CODE）とは異なりこれは秘匿情報ではなく
 * 単なる識別子のため、NEXT_PUBLIC_接頭辞でクライアントに公開してよい。
 */
function getConfiguredStoreId(): string | null {
  return process.env.NEXT_PUBLIC_STORE_ID ?? null;
}

/**
 * 厨房/レジタブレットの初回デバイスプロビジョニングフォーム。
 * `/setup/[role]`（page.tsx）から、ルートパラメータで検証済みのroleを
 * propsとして受け取って描画される。
 *
 * 観測可能な完了条件（タスク2.3）: セットアップコード入力後、タブレットの
 * ローカルストレージに永続化されたセッションで再訪時に認証UIが表示されない。
 * → マウント時にensureDeviceSession()を呼び、既にプロビジョニング済みなら
 *   フォームを一切表示せず完了状態を表示する。
 */
export default function SetupForm({ role }: SetupFormProps) {
  const [view, setView] = useState<ViewState>({ status: "checking" });
  const [setupCode, setSetupCode] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ensureDeviceSession().then((result) => {
      if (cancelled) {
        return;
      }
      setView(
        result.ok
          ? { status: "provisioned", identity: result.value }
          : { status: "needs-setup" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);

    const storeId = getConfiguredStoreId();
    if (!storeId) {
      setErrorMessage(
        "店舗IDが設定されていません（NEXT_PUBLIC_STORE_ID）。管理者に連絡してください。",
      );
      return;
    }

    setSubmitting(true);
    try {
      const result = await provisionDevice({ setupCode, role, storeId });
      if (result.ok) {
        setView({ status: "provisioned", identity: result.value });
        return;
      }
      setErrorMessage(
        result.error.code === "INVALID_SETUP_CODE"
          ? "セットアップコードが正しくありません。店舗のスタッフにご確認ください。"
          : "セットアップに失敗しました。もう一度お試しください。",
      );
    } catch {
      // provisionDeviceは、design.mdがモデル化していない想定外の失敗
      // （ネットワーク断等）をResultではなく例外として投げる設計
      // （src/lib/device/useDeviceIdentity.ts参照）。ここで汎用エラーとして拾う。
      setErrorMessage(
        "予期しないエラーが発生しました。ネットワーク接続を確認し、もう一度お試しください。",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (view.status === "checking") {
    return (
      <main>
        <h1>デバイスセットアップ（{ROLE_LABEL[role]}）</h1>
        <p>確認中...</p>
      </main>
    );
  }

  if (view.status === "provisioned") {
    return (
      <main>
        <h1>セットアップ完了</h1>
        <p>
          このタブレットは{ROLE_LABEL[view.identity.role]}
          デバイスとしてセットアップ済みです。
        </p>
        <p>次回以降は、この画面を開いても再入力なしでそのまま利用できます。</p>
      </main>
    );
  }

  return (
    <main>
      <h1>デバイスセットアップ（{ROLE_LABEL[role]}）</h1>
      <p>
        このタブレットを{ROLE_LABEL[role]}デバイスとして登録します。
        店舗スタッフからセットアップコードを確認して入力してください。
      </p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="setup-code">セットアップコード</label>
        <input
          id="setup-code"
          name="setup-code"
          type="password"
          autoComplete="off"
          value={setupCode}
          onChange={(event) => setSetupCode(event.target.value)}
          required
        />
        <button type="submit" disabled={submitting}>
          {submitting ? "セットアップ中..." : "セットアップする"}
        </button>
      </form>
      {errorMessage ? <p role="alert">{errorMessage}</p> : null}
    </main>
  );
}
