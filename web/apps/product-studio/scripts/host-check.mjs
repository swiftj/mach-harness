// Host check: the production build, embedded in the real Go host, against a real scratch project.
//
//   pnpm --filter @mach/product-studio build && node scripts/host-check.mjs
//
// Asserts: zero console errors, zero CSP violations, zero requests leaving 127.0.0.1, the session
// established (no "signed in" error), real engine data on screen, a state-changing operation
// accepted (CSRF and Content-Type), and a personal act confirmed in a dialog under the CSP.
import { chromium } from "playwright";
import { rmSync } from "node:fs";
import { buildHost, scratchProject, startHost, studio, watch } from "./host.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
};

const { binary, scratch } = buildHost();
const project = scratchProject();
studio(project, "project", "init", "--id", "host-check", "--name", "Host Check", "--vision", "Prove the app works inside the real host.", "--outcome", "The app loads with real data");
studio(project, "epic", "add", "--title", "Embedded app", "--criterion", "Loads under the host's security policy");
studio(project, "slice", "new", "--epic", "EPIC-001", "--title", "Open the app from the skill");

const host = await startHost(binary, project);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const watcher = await watch(page, host.origin);
  const apiFailures = [];
  page.on("response", async (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) apiFailures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });

  await page.goto(host.url, { waitUntil: "networkidle" });
  check("start link exchanged for a session", !page.url().includes("?t="), page.url());

  await page.getByRole("heading", { level: 1, name: "Host Check" }).waitFor({ timeout: 20000 });
  check("real project data on screen", true, "h1 'Host Check' from the engine's status");
  await page.getByText("Embedded app").first().waitFor({ timeout: 10000 });
  check("epic from the engine on screen", true);

  const signedOut = await page.getByText("no longer signed in").count();
  check("no signed-out error", signedOut === 0);

  // A personal act, confirmed in a dialog (exercises Radix under the CSP), then cancelled.
  await page.goto(`${host.origin}/#/vision`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Approve EPIC-001/ }).first().click();
  await page.getByRole("dialog").waitFor();
  check("approval dialog opens", true);
  await page.getByRole("dialog").getByRole("button", { name: "Approve epic" }).click();
  await page.getByText("Approved EPIC-001").first().waitFor({ timeout: 20000 });
  await page.getByRole("dialog").waitFor({ state: "detached" });
  const approvedNow = studio(project, "status").epics[0]?.status;
  check("epic approved through the app's own client (POST with CSRF)", approvedNow === "approved", `engine says ${approvedNow}`);

  // The lazily loaded map (React Flow, then ELK on first layout) under the CSP.
  await page.goto(`${host.origin}/#/roadmap`, { waitUntil: "networkidle" });
  await page.locator(".react-flow__node").first().waitFor({ timeout: 20000 });
  check("roadmap map loads on demand and lays out", (await page.locator(".react-flow__node").count()) >= 3);

  // A slice with no spec yet: the specification screen says so inside the shell, never an error page.
  await page.goto(`${host.origin}/#/slices/SLICE-001`, { waitUntil: "networkidle" });
  await page.getByText("Nothing is written yet").waitFor({ timeout: 20000 });
  check("slice with no spec shows its empty state in the shell", (await page.locator('nav[aria-label="Main"]').count()) === 1);

  // The interview screen asks the host for the slice's interview through the shared client.
  const lookup = page.waitForResponse((r) => r.url().includes("/api/interview?slice_id=SLICE-001"), { timeout: 20000 }).catch(() => null);
  await page.goto(`${host.origin}/#/slices/SLICE-001/interview`, { waitUntil: "networkidle" });
  const answered = await lookup;
  check("interview lookup through the shared client", answered !== null, answered ? `HTTP ${answered.status()}` : "no request");
  await page.locator("h1").first().waitFor({ timeout: 20000 });

  // A state-changing request from the page itself: the client must send CSRF and JSON.
  const set = await page.evaluate(async () => {
    const session = await (await fetch("/api/session", { credentials: "same-origin" })).json();
    const response = await fetch("/api/ops/validate", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-MACH-CSRF": session.data.csrf_token },
      body: "{}",
    });
    return response.status;
  });
  check("state-changing request accepted with CSRF", set === 200, `HTTP ${set}`);

  await page.waitForTimeout(500);
  const problems = await watcher.collect();
  check("zero API failures", apiFailures.length === 0, apiFailures.join(", "));
  check("zero console errors", problems.consoleErrors.length === 0, problems.consoleErrors.join(" | "));
  check("zero CSP violations", problems.cspViolations.length === 0, problems.cspViolations.join(" | "));
  check("zero requests outside 127.0.0.1", problems.externalRequests.length === 0, problems.externalRequests.join(", "));
  await context.close();
} catch (error) {
  check("host check ran to the end", false, String(error));
} finally {
  await browser.close();
  host.stop();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
