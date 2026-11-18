import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// 폰 화면 묶음. 데스크톱 묶음(dist) 뒤에 dist/m 으로 굽고, PC 앱이 그 안의 것만 중계로 내준다(remote.rs `asset_name`).
// 중계에서는 `/r/<방>/` 아래에서 열리므로 파일 경로를 상대로 둔다(base "./").
export default defineConfig({
  plugins: [react()],
  base: "./",
  publicDir: "ui/phone-public",
  clearScreen: false,
  build: {
    outDir: "dist/m",
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, "mobile.html") },
  },
});
