import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// VITE_DEMO=1 builds the static, server-free preview (scripts/build_preview.sh),
// bundling recorded data from build/preview/snapshot.json.
const demo = process.env.VITE_DEMO === "1";
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The sim is a workspace package written in TypeScript; Vite compiles it like app code.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@preview-snapshot": demo ? here("../build/preview/snapshot.json") : here("src/demo/empty-snapshot.json"),
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
  build: { chunkSizeWarningLimit: 6000 },
});
