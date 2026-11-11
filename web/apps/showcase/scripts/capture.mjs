// Captures the built showcase in both themes at the supported widths, and runs axe on it.
//
//   pnpm --filter @mach/showcase build && pnpm --filter @mach/showcase capture
//
// Starts `vite preview` on 127.0.0.1:4174, drives Chromium with Playwright, writes PNGs and
// axe-report.json into ./screenshots, and exits non-zero if axe finds violations.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const out = join(app, "screenshots");
mkdirSync(out, { recursive: true });

const base = "http://127.0.0.1:4174/";
const sizes = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1100", width: 1100, height: 800 },
];
const themes = ["light", "dark"];
const sections = ["foundations", "controls", "overlays", "states", "lifecycle", "graph", "shell"];

// Lets the full-page capture see past the shell's own scroll container.
const unclip = `[data-mach-shell]{height:auto!important;overflow:visible!important} main{overflow:visible!important}`;

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`preview server did not start at ${url}`);
}

const server = spawn("pnpm", ["exec", "vite", "preview", "--port", "4174", "--strictPort", "--host", "127.0.0.1"], {
  cwd: app,
  stdio: "ignore",
});

const report = { generated: new Date().toISOString(), runs: [] };
let violations = 0;

try {
  await waitForServer(base);
  const browser = await chromium.launch();

  // Any request that leaves 127.0.0.1 is a failure: the built app must make no network calls.
  const external = [];

  for (const theme of themes) {
    for (const size of sizes) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: theme, deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.on("request", (request) => {
        if (!request.url().startsWith(base) && !request.url().startsWith("data:")) external.push(request.url());
      });
      await page.goto(`${base}?theme=${theme}`, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForSelector(".react-flow__node");
      await page.waitForTimeout(600);

      await page.screenshot({ path: join(out, `showcase-${theme}-${size.name}-top.png`) });

      // Horizontal overflow check: nothing may be wider than the viewport.
      const overflow = await page.evaluate(() => {
        const main = document.querySelector("main");
        return { page: document.documentElement.scrollWidth - window.innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
      });

      // Sections and the full page are captured with the shell unclipped, so long sections render whole.
      const style = await page.addStyleTag({ content: unclip });
      await page.waitForTimeout(200);
      for (const id of sections) {
        await page.locator(`#${id}`).screenshot({ path: join(out, `section-${id}-${theme}-${size.name}.png`) });
      }
      await page.screenshot({ path: join(out, `showcase-${theme}-${size.name}-full.png`), fullPage: true });
      await style.evaluate((node) => node.remove());
      await page.evaluate(() => window.scrollTo(0, 0));

      if (size.name === "1440") {
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
        violations += axe.violations.length;
        report.runs.push({ theme, size: size.name, state: "page", overflow, violations: axe.violations.map(slim), passes: axe.passes.length });

        // Dialog open.
        await page.locator("#overlays").scrollIntoViewIfNeeded();
        await page.locator("#overlays").getByRole("button", { name: /^Approve SLICE-001$/ }).click();
        await page.waitForSelector("[role=dialog]");
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(out, `dialog-${theme}.png`) });
        const axeDialog = await new AxeBuilder({ page }).include("[role=dialog]").analyze();
        violations += axeDialog.violations.length;
        report.runs.push({ theme, size: size.name, state: "dialog", violations: axeDialog.violations.map(slim), passes: axeDialog.passes.length });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);

        // Sheet open.
        await page.getByRole("button", { name: /^Settle \d+ differences$/ }).click();
        await page.waitForSelector("[role=dialog]");
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(out, `sheet-${theme}.png`) });
        const axeSheet = await new AxeBuilder({ page }).include("[role=dialog]").analyze();
        violations += axeSheet.violations.length;
        report.runs.push({ theme, size: size.name, state: "sheet", violations: axeSheet.violations.map(slim), passes: axeSheet.passes.length });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);

        // Keyboard focus is visible: from a fresh load, the skip link, then the first navigation link.
        await page.goto(`${base}?theme=${theme}`, { waitUntil: "networkidle" });
        await page.keyboard.press("Tab");
        await page.screenshot({ path: join(out, `focus-skip-link-${theme}.png`), clip: { x: 0, y: 0, width: 520, height: 200 } });
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await page.screenshot({ path: join(out, `focus-nav-${theme}.png`), clip: { x: 0, y: 0, width: 520, height: 200 } });
      } else {
        report.runs.push({ theme, size: size.name, state: "page", overflow });
      }
      await context.close();
    }
  }

  // Control Tower flavour, dark.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(`${base}?theme=dark&product=control-tower#graph`, { waitUntil: "networkidle" });
  await page.waitForSelector(".react-flow__node");
  await page.locator("#graph").evaluate((node) => node.scrollIntoView());
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(out, "control-tower-dark-1440.png") });
  await context.close();

  // Reduced motion: the page must still render everything.
  const reduced = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const reducedPage = await reduced.newPage();
  await reducedPage.goto(`${base}?theme=light#states`, { waitUntil: "networkidle" });
  const animated = await reducedPage.evaluate(() =>
    [...document.querySelectorAll("*")].filter((el) => {
      const s = getComputedStyle(el);
      return s.animationName !== "none" && parseFloat(s.animationDuration) > 0.001;
    }).length,
  );
  report.reducedMotion = { elementsStillAnimating: animated };
  await reduced.close();

  report.externalRequests = external;
  await browser.close();
} finally {
  server.kill();
}

writeFileSync(join(out, "axe-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ violations, externalRequests: report.externalRequests, reducedMotion: report.reducedMotion, overflow: report.runs.map((r) => [r.theme, r.size, r.state, r.overflow]) }, null, 2));
if (violations > 0 || report.externalRequests.length > 0) process.exit(1);

function slim(v) {
  return { id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 6).map((n) => ({ target: n.target.join(" "), summary: n.failureSummary })) };
}
