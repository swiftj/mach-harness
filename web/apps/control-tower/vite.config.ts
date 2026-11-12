import { fileURLToPath } from "node:url";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The Control Tower is a static app. In production the observer (apps/observer) serves it and its
// `/api/v1` from the same loopback origin. In development the dev server can stand in for that
// origin: set MACH_OBSERVER_PORT to a running observer's port and `/api` is proxied to it.
//
//   MACH_OBSERVER_PORT=4321 pnpm --filter @mach/control-tower dev
//
// The observer's session cookie is per host (127.0.0.1), not per port, so open the observer's
// one-time link once in the same browser and the dev server's requests carry it. Without the
// variable nothing is proxied and the app says "No observer: showing the simulation".
//
// The proxy only ever reaches 127.0.0.1: the port is the only thing that can be set, it must be a
// number, and the host is fixed. GET and the event stream pass through; nothing else is added.
const OBSERVER_PORT = process.env.MACH_OBSERVER_PORT;

function observerProxy(): Record<string, ProxyOptions> | undefined {
  if (!OBSERVER_PORT) return undefined;
  const port = Number(OBSERVER_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`MACH_OBSERVER_PORT must be a port number, not ${JSON.stringify(OBSERVER_PORT)}.`);
  const target = `http://127.0.0.1:${port}`;
  return {
    "/api/": {
      target,
      // The observer accepts only Host 127.0.0.1:<its port> and an Origin of that host, if any.
      changeOrigin: true,
      ws: false,
      configure(proxy) {
        proxy.on("proxyReq", (req) => {
          if (req.getHeader("origin")) req.setHeader("origin", target);
        });
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Radix's scroll lock injects a <style> element, which the host's CSP blocks; this version uses a
    // constructable stylesheet instead (see the file).
    alias: { "react-style-singleton": fileURLToPath(new URL("../../packages/ui/src/vendor/react-style-singleton.ts", import.meta.url)) },
  },
  server: { port: 4176, strictPort: true, host: "127.0.0.1", proxy: observerProxy() },
  preview: { port: 4176, strictPort: true, host: "127.0.0.1", proxy: observerProxy() },
  build: {
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    target: "es2022", sourcemap: true, chunkSizeWarningLimit: 1600 },
});
