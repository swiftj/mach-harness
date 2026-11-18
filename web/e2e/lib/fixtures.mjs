// The app built in fixture mode (`vite build --mode fixtures`) into a scratch folder and served
// from 127.0.0.1, for suites that need states the real engine cannot reach without GitHub (the
// request suites). The app's own dist/ is never touched. No host, no engine, no network.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { appDir, keepScratch, scratch } from "./env.mjs";

// The host's Content-Security-Policy (M5 contract 8.1).
export const HOST_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'";

const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };

let built = null;

/** Builds once per process; returns the folder. */
export function buildFixtures() {
  if (built) return built;
  const out = join(scratch("e2e-fixtures"), "dist");
  execFileSync(join(appDir, "node_modules", ".bin", "vite"), ["build", "--mode", "fixtures", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"], {
    cwd: appDir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  built = out;
  return out;
}

/**
 * Serves the fixture build. `csp: false` leaves the policy off, so a suite can prove that nothing
 * ran by itself rather than because the policy blocked it.
 */
export async function serveFixtures({ csp = true } = {}) {
  const root = buildFixtures();
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    const file = normalize(join(root, path === "/" ? "index.html" : path));
    if (!file.startsWith(root + sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", ...(csp ? { "Content-Security-Policy": HOST_CSP } : {}) });
    response.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    /**
     * The Inbox under a request scenario: url("all"), url("hostile", "refuse=1"). The workspace is
     * one slice marked ready, saved on GitHub, or to the folder for a project with no GitHub remote.
     */
    url: (scenario, extra = "") =>
      `${origin}/?requests=${scenario}&fixture=${scenario === "none" ? "status.folder" : "status.on-github"}${extra ? `&${extra}` : ""}#/inbox`,
    /** Any screen, with the fixture transport's query parameters: at("/", "fixture=status.conflicts"). */
    at: (route, query = "") => `${origin}/${query ? `?${query}` : ""}#${route}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function cleanupFixtures() {
  if (built && !keepScratch) rmSync(join(built, ".."), { recursive: true, force: true });
  built = null;
}
