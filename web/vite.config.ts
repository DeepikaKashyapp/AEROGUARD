import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The sim is a workspace package written in TypeScript; Vite compiles it like app code.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
  build: { chunkSizeWarningLimit: 2000 },
});
