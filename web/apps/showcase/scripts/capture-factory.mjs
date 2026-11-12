// Captures the Factory grammar sheet (M6) in both themes and runs axe on it.
//
//   pnpm --filter @mach/showcase build && node apps/showcase/scripts/capture-factory.mjs
//
// Starts `vite preview` on 127.0.0.1:4174, writes PNGs and factory-axe-report.json into
// ./screenshots/factory, and exits non-zero on axe violations or any request leaving 127.0.0.1.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const out = join(app, "screenshots", "factory");
mkdirSync(out, { recursive: true });

const base = "http://127.0.0.1:4174/";
const sections = ["factory-projection", "factory-studies", "factory-places", "factory-stations", "factory-agents", "factory-gates", "factory-artifacts", "factory-tools", "factory-connections", "factory-lettering", "factory-states"];
const unclip = `[data-mach-shell]{height:auto!important;overflow:visible!important} main{overflow:visible!important}`;
const only = process.argv[2]; // optional: one section id

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

const server = spawn("pnpm", ["exec", "vite", "preview", "--port", "4174", "--strictPort", "--host", "127.0.0.1"], { cwd: app, stdio: "ignore" });
const report = { generated: new Date().toISOString(), runs: [], externalRequests: [] };
let violations = 0;

try {
  await waitForServer(base);
  const browser = await chromium.launch();
  for (const product of ["control-tower", "product-studio"]) {
    for (const theme of ["dark", "light"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
      const page = await context.newPage();
      page.on("request", (request) => {
        if (!request.url().startsWith(base) && !request.url().startsWith("data:")) report.externalRequests.push(request.url());
      });
      await page.goto(`${base}?theme=${theme}&product=${product}#factory`, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const tag = `${product === "control-tower" ? "ct" : "ps"}-${theme}`;
      await page.screenshot({ path: join(out, `factory-${tag}-top.png`) });
      if (product === "control-tower") {
        const style = await page.addStyleTag({ content: unclip });
        await page.waitForTimeout(150);
        for (const id of sections) {
          if (only && id !== only) continue;
          await page.locator(`#${id}`).screenshot({ path: join(out, `${id}-${tag}.png`) });
        }
        await page.locator("#factory-plant-fit").screenshot({ path: join(out, `plant-fit-${tag}.png`) });
        await style.evaluate((node) => node.remove());
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
        violations += axe.violations.length;
        const overflow = await page.evaluate(() => {
          const main = document.querySelector("main");
          return { page: document.documentElement.scrollWidth - window.innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
        });
        report.runs.push({ product, theme, overflow, violations: axe.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")) })), passes: axe.passes.length });
      }
      await context.close();
    }
  }
  await browser.close();
} finally {
  server.kill();
}

writeFileSync(join(out, "factory-axe-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ violations, externalRequests: report.externalRequests, runs: report.runs.map((r) => [r.theme, r.overflow, r.violations.map((v) => v.id)]) }, null, 2));
if (violations > 0 || report.externalRequests.length > 0) process.exit(1);
