import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Product Studio.
 *
 *   pnpm dev            proxies /api to the Go host at MACH_STUDIO_HOST (e.g. http://127.0.0.1:47123)
 *   pnpm dev:fixtures   no host: API calls are answered from web/fixtures (development only)
 *   pnpm build          the production bundle the Go host embeds (apps/studio/internal/webui)
 *
 * The production build talks only to its own origin. Nothing here is used by it.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "MACH_");
  const host = env.MACH_STUDIO_HOST || "http://127.0.0.1:47123";
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) {
    throw new Error(`MACH_STUDIO_HOST must be a loopback origin such as http://127.0.0.1:47123, not ${host}`);
  }
  return {
    plugins: [react(), tailwindcss()],
    // Relative asset URLs so the Go host can serve the bundle from any path prefix.
    base: "./",
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy:
        mode === "fixtures"
          ? undefined
          : {
              "/api": {
                target: host,
                changeOrigin: true,
                // The host accepts state-changing requests only from its own origin. In development the
                // page is on the Vite origin, so the proxy presents the host's origin instead. Dev only.
                configure: (proxy) => {
                  proxy.on("proxyReq", (request) => {
                    if (request.getHeader("origin")) request.setHeader("origin", host);
                  });
                },
              },
            },
    },
    preview: { host: "127.0.0.1", port: 4175, strictPort: true },
    build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1600 },
  };
});
