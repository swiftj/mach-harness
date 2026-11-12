import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The Living Factory prototype is a static app: no proxy, no network, no host. Its only data is the
// simulation fixture in src/sim, imported at build time.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Radix's scroll lock injects a <style> element, which the host's CSP blocks; this version uses a
    // constructable stylesheet instead (see the file).
    alias: { "react-style-singleton": fileURLToPath(new URL("../../packages/ui/src/vendor/react-style-singleton.ts", import.meta.url)) },
  },
  server: { port: 4176, strictPort: true, host: "127.0.0.1" },
  preview: { port: 4176, strictPort: true, host: "127.0.0.1" },
  build: {
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    target: "es2022", sourcemap: true, chunkSizeWarningLimit: 1600 },
});
