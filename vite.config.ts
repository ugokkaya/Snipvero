import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and must see Rust compiler errors in the terminal.
// See https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    ...(host && { hmr: { protocol: "ws", host, port: 1421 } }),
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // WebView2 (Windows) is Chromium-based; WKWebView on macOS 14+ is Safari 17.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari17",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    // theme.test.ts reads the stylesheet's text; Vitest empties CSS otherwise.
    css: { include: [/App\.css/] },
  },
});
