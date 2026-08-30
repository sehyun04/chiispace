import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 가 devUrl 로 이 포트를 고정해 기다린다 — 바뀌면 빈 창이 뜬다.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
