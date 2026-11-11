import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The showcase is a static app: no proxy, no network. Fixtures are imported as JSON at build time.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 4174, strictPort: true, host: "127.0.0.1" },
  preview: { port: 4174, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 1600 },
});
