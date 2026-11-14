import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Tauri 가 devUrl 로 이 포트를 고정해 기다린다 — 바뀌면 빈 창이 뜬다.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // 폰 화면(mobile.html)은 PC 앱의 폰 서버가 같은 묶음에서 꺼내 준다(remote.rs). 따로 굽지 않는다.
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        mobile: resolve(import.meta.dirname, "mobile.html"),
      },
    },
  },
});
