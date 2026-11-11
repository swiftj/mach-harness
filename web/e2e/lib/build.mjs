// Builds the real host with the real app embedded, entirely in scratch folders: the app's own
// dist/ and the committed placeholder in apps/studio/internal/webui/dist are never touched (other
// people build there concurrently).
//
// Set E2E_BINARY to reuse a binary from `node web/e2e/build.mjs`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { appDir, hostSource, scratch } from "./env.mjs";

function walk(folder) {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** The same refusals as apps/studio/build.sh: a build that cannot run under the host's CSP. */
export function cspProblems(dist) {
  const problems = [];
  for (const file of walk(dist)) {
    if (/\.(js|css|html)$/.test(file) && /data:(font|application)\//.test(readFileSync(file, "utf8"))) problems.push(`data: URI font/script in ${file}`);
  }
  const index = readFileSync(join(dist, "index.html"), "utf8");
  if (/style="|<script>/.test(index)) problems.push("inline <script> or style= in index.html");
  return problems;
}

export function buildHost({ attempts = 2 } = {}) {
  if (process.env.E2E_BINARY) {
    if (!existsSync(process.env.E2E_BINARY)) throw new Error(`E2E_BINARY ${process.env.E2E_BINARY} does not exist`);
    return { binary: process.env.E2E_BINARY, folder: null };
  }
  const folder = scratch("mach-e2e-build");
  const dist = join(folder, "dist");
  let lastError;
  // Other agents edit the app concurrently, so one transient failure is retried before it counts.
  for (let i = 0; i < attempts; i++) {
    try {
      execFileSync("pnpm", ["--filter", "@mach/product-studio", "exec", "vite", "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "warn"], {
        cwd: appDir,
        stdio: ["ignore", "inherit", "inherit"],
      });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw new Error(`the app did not build: ${lastError.message}`);
  const problems = cspProblems(dist);
  if (problems.length) throw new Error(`the build cannot run under the host's CSP:\n${problems.join("\n")}`);
  const source = join(folder, "studio");
  cpSync(hostSource, source, { recursive: true, filter: (p) => p !== join(hostSource, "bin") && p !== join(hostSource, "mach-studio") });
  rmSync(join(source, "internal/webui/dist"), { recursive: true, force: true });
  cpSync(dist, join(source, "internal/webui/dist"), { recursive: true });
  const binary = join(folder, "mach-studio");
  execFileSync("go", ["build", "-trimpath", "-o", binary, "./cmd/mach-studio"], { cwd: source, stdio: ["ignore", "inherit", "inherit"] });
  return { binary, folder };
}
