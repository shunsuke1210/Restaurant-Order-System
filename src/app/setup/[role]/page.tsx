import { notFound } from "next/navigation";
import type { DeviceRole } from "@/lib/device/useDeviceIdentity";
import SetupForm from "./SetupForm";

type SetupPageProps = {
  params: Promise<{ role: string }>;
};

function isDeviceRole(value: string): value is DeviceRole {
  return value === "kitchen" || value === "register";
}

// 厨房/レジタブレットの初回デバイスプロビジョニング画面。
// ルートパラメータの妥当性検証（kitchen/register以外は404）のみを担い、
// 実際のセットアップコード入力・匿名サインイン・devices登録のフローは
// SetupForm（クライアントコンポーネント）に委譲する。
export default async function SetupPage({ params }: SetupPageProps) {
  const { role } = await params;

  if (!isDeviceRole(role)) {
    notFound();
  }

  return <SetupForm role={role} />;
}
