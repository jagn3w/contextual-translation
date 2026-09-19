import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Rails serves the API on :3000. In development the browser only talks to Vite (:5173), which
// forwards API calls, so the app sees one origin — the same as production, where Rails serves
// the built files itself (design D1.6). That keeps the session cookie and Origin check identical.
const RAILS_URL = process.env.RAILS_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: RAILS_URL, changeOrigin: false },
      "/graphql": { target: RAILS_URL, changeOrigin: false },
      // Rails' health check, so bin/smoke through Vite checks Rails rather than the SPA fallback.
      "/up": { target: RAILS_URL, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    // No public source maps: they'd be served from public/ with year-long caching.
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
