// Screenshots and accessibility checks of the shell owner's screens, in the real Go host, against
// real projects built through the engine (scripts/scenario.py).
//
//   pnpm --filter @mach/product-studio build && node scripts/capture.mjs
//
// Writes screenshots/<scenario>-<screen>-<theme>-<width>.png and screenshots/axe-report.json.
// Exits non-zero on any axe violation, console error, CSP violation, external request or overflow.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { app, buildHost, startHost, watch } from "./host.mjs";

const out = join(app, "screenshots");
mkdirSync(out, { recursive: true });

const sizes = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1100", width: 1100, height: 800 },
];
const themes = ["light", "dark"];
const screens = [
  { name: "workspace", hash: "#/" },
  { name: "vision", hash: "#/vision" },
  { name: "roadmap", hash: "#/roadmap" },
];
// Lets a full-page capture see past the shell's own scroll container. Set through the CSSOM: the
// host's CSP (rightly) blocks an injected <style>.
const unclip = (on) => {
  const shell = document.querySelector("[data-mach-shell]");
  const main = document.querySelector("main");
  for (const node of [shell, main]) {
    if (!node) continue;
    node.style.setProperty("height", on && node === shell ? "auto" : "", on ? "important" : "");
    node.style.setProperty("overflow", on ? "visible" : "", on ? "important" : "");
  }
};

const report = { generated: new Date().toISOString(), runs: [], problems: {} };
let failures = 0;

async function settle(page) {
  await page.waitForFunction(
    () => !document.querySelector('[aria-busy="true"]') && ![...document.querySelectorAll('[role="status"]')].some((n) => /Checking|Reading/.test(n.textContent ?? "")),
    undefined,
    { timeout: 60000 },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

const { binary, scratch } = buildHost();
const browser = await chromium.launch();

for (const scenario of ["empty", "established"]) {
  const built = JSON.parse(execFileSync("python3", [join(app, "scripts/scenario.py"), scenario], { encoding: "utf8" }));
  const host = await startHost(binary, built.project, { ...process.env, ...built.env });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const watcher = await watch(page, host.origin);
  try {
    await page.goto(host.url, { waitUntil: "networkidle" });
    await settle(page);
    for (const screen of screens) {
      await page.goto(`${host.origin}/${screen.hash}`);
      for (const theme of themes) {
        await page.emulateMedia({ colorScheme: theme });
        for (const size of sizes) {
          await page.setViewportSize({ width: size.width, height: size.height });
          await settle(page);
          const base = `${scenario}-${screen.name}-${theme}-${size.name}`;
          await page.screenshot({ path: join(out, `${base}.png`) });
          const overflow = await page.evaluate(() => {
            const main = document.querySelector("main");
            return { page: document.documentElement.scrollWidth - window.innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
          });
          if (overflow.page > 0 || overflow.main > 0) failures++;
          const run = { scenario, screen: screen.name, theme, size: size.name, overflow };
          if (screen.name !== "roadmap") {
            await page.evaluate(unclip, true);
            await page.waitForTimeout(150);
            await page.screenshot({ path: join(out, `${base}-full.png`), fullPage: true });
            await page.evaluate(unclip, false);
            await page.evaluate(() => window.scrollTo(0, 0));
          }
          if (size.name === "1440") {
            const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
            run.violations = axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")) }));
            failures += axe.violations.length;
          }
          report.runs.push(run);
        }
      }
    }
    if (scenario === "established") {
      // The roadmap's detail sheet for a slice, and Vision's epic editor, in both themes.
      await page.setViewportSize({ width: 1440, height: 900 });
      for (const theme of themes) {
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(`${host.origin}/#/roadmap`);
        await settle(page);
        await page.locator(".react-flow__node").filter({ hasText: "Remove a teammate" }).first().click();
        await page.getByRole("dialog").waitFor();
        await settle(page);
        await page.screenshot({ path: join(out, `established-roadmap-sheet-${theme}-1440.png`) });
        const axe = await new AxeBuilder({ page }).include("[role=dialog]").analyze();
        report.runs.push({ scenario, screen: "roadmap-sheet", theme, size: "1440", violations: axe.violations.map((v) => v.id) });
        failures += axe.violations.length;
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "List" }).click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(out, `established-roadmap-list-${theme}-1440.png`) });
        await page.getByRole("button", { name: "Map" }).click();

        await page.goto(`${host.origin}/#/vision`);
        await settle(page);
        await page.getByRole("button", { name: "Approve EPIC-002" }).click();
        await page.getByRole("dialog").waitFor();
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(out, `established-vision-approve-${theme}-1440.png`) });
        const axeDialog = await new AxeBuilder({ page }).include("[role=dialog]").analyze();
        report.runs.push({ scenario, screen: "vision-approve-dialog", theme, size: "1440", violations: axeDialog.violations.map((v) => v.id) });
        failures += axeDialog.violations.length;
        await page.getByRole("button", { name: "Not now" }).click();
      }
    }
    const problems = await watcher.collect();
    report.problems[scenario] = problems;
    failures += problems.consoleErrors.length + problems.cspViolations.length + problems.externalRequests.length;
  } finally {
    await context.close();
    host.stop();
    rmSync(built.root, { recursive: true, force: true });
  }
}

await browser.close();
rmSync(scratch, { recursive: true, force: true });
writeFileSync(join(out, "axe-report.json"), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      failures,
      problems: report.problems,
      violations: report.runs.filter((r) => r.violations?.length),
      overflow: report.runs.filter((r) => r.overflow && (r.overflow.page > 0 || r.overflow.main > 0)),
    },
    null,
    2,
  ),
);
process.exit(failures ? 1 : 0);
