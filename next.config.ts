import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 親ディレクトリに別プロジェクトのpackage-lock.json等が存在するため、
  // Turbopackのルート推測が本プロジェクト外を指さないよう明示する。
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
