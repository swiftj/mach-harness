// Shared by host-check.mjs and capture.mjs: build the real Go host with this app embedded, in a
// scratch copy (the committed placeholder in apps/studio/internal/webui/dist is never touched),
// and start it for a project.
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const app = resolve(here, "..");
export const repo = resolve(app, "../../..");
export const engine = join(repo, "skills/product-studio/scripts/studio.py");

/** Copies apps/studio to a scratch folder, puts dist/ in, builds, returns the binary path. */
export function buildHost() {
  const dist = join(app, "dist");
  if (!existsSync(join(dist, "index.html"))) throw new Error("Build the app first: pnpm --filter @mach/product-studio build");
  const scratch = mkdtempSync(join(tmpdir(), "mach-host-"));
  const source = join(scratch, "studio");
  cpSync(join(repo, "apps/studio"), source, { recursive: true });
  rmSync(join(source, "internal/webui/dist"), { recursive: true, force: true });
  cpSync(dist, join(source, "internal/webui/dist"), { recursive: true });
  const binary = join(scratch, "mach-studio");
  execFileSync("go", ["build", "-o", binary, "./cmd/mach-studio"], { cwd: source, stdio: "inherit" });
  return { binary, scratch };
}

/** Starts the host for a project; resolves with the one-time URL and a stop function. */
export function startHost(binary, project, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, ["--no-open", "--project", project, "--engine", engine], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Open: (http:\/\/127\.0\.0\.1:\d+\/\?t=\S+)/);
      if (match) {
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolvePromise({ url: match[1], origin: new URL(match[1]).origin, stop: () => child.kill("SIGTERM"), child });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`host exited (${code}) before printing its address:\n${output}`)));
    setTimeout(() => reject(new Error(`host did not print its address within 60s:\n${output}`)), 20000);
  });
}

/** A scratch Git project with one commit (what the host and engine need). */
export function scratchProject(name = "host-check") {
  const folder = mkdtempSync(join(tmpdir(), `mach-${name}-`));
  const git = (...args) => execFileSync("git", args, { cwd: folder, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Host Check");
  git("config", "user.email", "host-check@example.test");
  git("config", "commit.gpgsign", "false");
  execFileSync("sh", ["-c", "printf '# Scratch project\\n' > README.md"], { cwd: folder });
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  return folder;
}

/** Runs the engine directly (to seed a project), returns its JSON. */
export function studio(project, ...args) {
  const out = execFileSync("python3", ["-I", "-B", engine, "--project", project, ...args], { encoding: "utf8" });
  return JSON.parse(out);
}

/**
 * Watches a page for what the host check forbids: console errors, CSP violations and any request
 * that leaves the host's origin. Call before navigating.
 */
export async function watch(page, origin) {
  const problems = { consoleErrors: [], cspViolations: [], externalRequests: [] };
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"}${e.sample ? ` (${e.sample.slice(0, 60)})` : ""}`),
    );
  });
  page.on("console", (message) => {
    if (message.type() === "error") problems.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => problems.consoleErrors.push(`page error: ${error.message}`));
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:")) problems.externalRequests.push(url);
  });
  return {
    async collect() {
      const csp = await page.evaluate(() => window.__csp ?? []).catch(() => []);
      problems.cspViolations.push(...csp);
      return problems;
    },
  };
}
