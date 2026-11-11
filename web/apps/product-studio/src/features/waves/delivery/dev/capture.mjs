/* global document, window, getComputedStyle */
// DEVELOPMENT ONLY. Screenshots and axe for the delivery screens (inbox, waves, send, shared project).
//
//   cd web/apps/product-studio && pnpm exec vite --mode fixtures --port 5191 --strictPort &
//   node src/features/waves/delivery/dev/capture.mjs [http://127.0.0.1:5191/] [filter]
//
// Drives the fixture-mode app with Playwright (borrowed from the showcase's install), in light and
// dark at 1440x900 and 1100x800. Writes PNGs into apps/product-studio/screenshots/ (names start with
// inbox-, waves-, send-, shared-) and delivery-axe-report.json. Exits non-zero on axe violations,
// horizontal overflow, or a request to any origin but the app's own.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "../../../../..");
const showcase = createRequire(join(app, "../showcase/package.json"));
const { chromium } = showcase("playwright");
const { AxeBuilder } = showcase("@axe-core/playwright");

const base = process.argv[2] ?? "http://127.0.0.1:5191/";
const only = process.argv[3] ?? null;
const out = join(app, "screenshots");
mkdirSync(out, { recursive: true });

const sizes = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1100", width: 1100, height: 800 },
];
const themes = ["light", "dark"];
const unclip = `[data-mach-shell]{height:auto!important;overflow:visible!important} main{overflow:visible!important}`;

const click = (name, role = "button") => async (page) => {
  await page.getByRole(role, { name, exact: false }).first().click();
};
const dialog = async (page) => {
  await page.waitForSelector("[role=dialog]");
  await page.waitForTimeout(450);
};

/** name, url (query + hash), steps run before the shot, and whether the shot is of an open dialog. */
const scenarios = [
  { name: "inbox-conflicts", url: "?fixture=status.conflicts#/inbox", wait: "text=Versions to choose" },
  { name: "inbox-reconcile-confirm", url: "?fixture=status.conflicts#/inbox", wait: "text=Versions to choose", steps: [click(/Keep mine.*Title/), dialog], modal: true },
  { name: "inbox-spec-take-shared-confirm", url: "?fixture=status.conflicts#/inbox", wait: "text=Versions to choose", steps: [click(/^Use the shared version$/), dialog], modal: true },
  { name: "inbox-collision", url: "?fixture=status.collision#/inbox", wait: "text=New numbers needed" },
  { name: "inbox-renumber-confirm", url: "?fixture=status.collision#/inbox", wait: "text=New numbers needed", steps: [click(/Give my draft a new number/), dialog], modal: true },
  {
    name: "inbox-renumbered",
    url: "?fixture=status.collision#/inbox",
    wait: "text=New numbers needed",
    steps: [click(/Give my draft a new number/), dialog, click(/^Give it a new number$/), async (p) => p.waitForSelector("text=is now SLICE-003")],
  },
  { name: "inbox-review-feedback", url: "?fixture=status.published&feedback=feedback.changes-requested#/inbox", wait: "text=Engineering is waiting on you" },
  { name: "inbox-empty", url: "?fixture=status.wave-approved#/inbox", wait: "text=Nothing to decide" },

  { name: "waves-list", url: "?fixture=status.conflicts#/waves", wait: "text=Being prepared" },
  { name: "waves-approved-and-sent", url: "?fixture=status.published&feedback=feedback.changes-requested#/waves", wait: "text=With engineering" },
  { name: "waves-empty", url: "?fixture=status.slice-ready#/waves", wait: "text=No delivery waves yet" },
  { name: "waves-create", url: "?fixture=status.after-renumber#/waves", wait: "text=Being prepared", steps: [click(/^New wave$/), dialog], modal: true },
  { name: "waves-approve-dialog", url: "?fixture=status.conflicts#/waves", wait: "text=Being prepared", steps: [click(/^Approve WAVE-001$/), dialog], modal: true },

  { name: "send-1-check", url: "?fixture=status.wave-approved#/waves/WAVE-001/send", wait: "text=What will be shared" },
  { name: "send-2-confirm", url: "?fixture=status.wave-approved#/waves/WAVE-001/send", wait: "text=What will be shared", steps: [click(/Send WAVE-001 to engineering/), dialog], modal: true },
  {
    name: "send-3-sent",
    url: "?fixture=status.wave-approved#/waves/WAVE-001/send",
    wait: "text=What will be shared",
    steps: [click(/Send WAVE-001 to engineering/), dialog, async (p) => p.getByRole("dialog").getByRole("button", { name: /^Send WAVE-001$/ }).click(), async (p) => p.waitForSelector("text=Review progress")],
  },
  {
    name: "send-3-request-not-opened",
    url: "?fixture=status.wave-approved&send=send.request-not-opened&feedback=feedback.request-not-opened#/waves/WAVE-001/send",
    wait: "text=What will be shared",
    steps: [click(/Send WAVE-001 to engineering/), dialog, async (p) => p.getByRole("dialog").getByRole("button", { name: /^Send WAVE-001$/ }).click(), async (p) => p.waitForSelector("text=could not be opened")],
  },
  {
    name: "send-refused-offline",
    url: "?fixture=status.wave-approved&send=send.refused-offline#/waves/WAVE-001/send",
    wait: "text=What will be shared",
    steps: [click(/Send WAVE-001 to engineering/), dialog, async (p) => p.getByRole("dialog").getByRole("button", { name: /^Send WAVE-001$/ }).click(), async (p) => p.waitForSelector("[role=dialog] [role=alert]")],
    modal: true,
  },
  ...[
    "feedback.waiting",
    "feedback.changes-requested",
    "feedback.blocked-by-check",
    "feedback.needs-updating",
    "feedback.accepted-waiting",
    "feedback.accepted",
    "feedback.declined",
    "feedback.request-not-opened",
  ].map((f) => ({ name: `send-review-${f.slice("feedback.".length)}`, url: `?fixture=status.published&feedback=${f}#/waves/WAVE-001/review`, wait: "text=Review progress" })),

  { name: "shared-before-refresh", url: "?fixture=status.second-pm#/shared", wait: "text=Where everything stands" },
  {
    name: "shared-second-pm-arrives",
    url: "?fixture=status.second-pm&refresh=refresh.second-pm-arrives#/shared",
    wait: "text=Where everything stands",
    steps: [click(/^Refresh$/), async (p) => p.waitForSelector("text=New from other product managers")],
  },
  {
    name: "shared-conflicts",
    url: "?fixture=status.conflicts&refresh=refresh.conflicts#/shared",
    wait: "text=Where everything stands",
    steps: [click(/^Refresh$/), async (p) => p.waitForSelector("text=Settle in Decisions")],
  },
  {
    name: "shared-offline",
    url: "?fixture=status.conflicts&refresh=refresh.offline#/shared",
    wait: "text=Where everything stands",
    steps: [click(/^Refresh$/), async (p) => p.waitForSelector("text=The refresh didn't finish")],
  },
];

const report = { generated: new Date().toISOString(), base, runs: [] };
let violations = 0;
let overflowFailures = 0;
const external = [];
const browser = await chromium.launch();

for (const scenario of scenarios.filter((s) => !only || s.name.includes(only))) {
  for (const theme of themes) {
    for (const size of sizes) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: theme, deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.on("request", (request) => {
        const url = request.url();
        if (!url.startsWith(base) && !url.startsWith("data:") && !url.startsWith("ws://127.0.0.1")) external.push(url);
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const run = { scenario: scenario.name, theme, size: size.name };
      try {
        await page.goto(`${base}${scenario.url}`, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForSelector(scenario.wait, { timeout: 8000 });
        for (const step of scenario.steps ?? []) await step(page);
        await page.waitForTimeout(400);

        run.overflow = await page.evaluate(() => {
          const main = document.querySelector("main");
          return { page: document.documentElement.scrollWidth - window.innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
        });
        if (run.overflow.page > 0 || run.overflow.main > 0) overflowFailures++;

        const file = join(out, `${scenario.name}-${theme}-${size.name}.png`);
        const tall = await page.evaluate(() => {
          const main = document.querySelector("main");
          return main ? main.scrollHeight > main.clientHeight + 1 : false;
        });
        if (scenario.modal || !tall) {
          await page.screenshot({ path: file });
        } else {
          const style = await page.addStyleTag({ content: unclip });
          await page.waitForTimeout(150);
          await page.screenshot({ path: file, fullPage: true });
          await style.evaluate((node) => node.remove());
        }

        if (size.name === "1440") {
          const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
          if (scenario.modal) builder.include("[role=dialog]");
          const axe = await builder.analyze();
          violations += axe.violations.length;
          run.violations = axe.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => ({ target: n.target.join(" "), summary: n.failureSummary })) }));
        }
      } catch (error) {
        run.failed = String(error).split("\n")[0];
        await page.screenshot({ path: join(out, `FAILED-${scenario.name}-${theme}-${size.name}.png`) }).catch(() => undefined);
      }
      if (errors.length) run.pageErrors = errors;
      report.runs.push(run);
      await context.close();
    }
  }
}

// Reduced motion: nothing keeps animating.
const reduced = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
const rp = await reduced.newPage();
await rp.goto(`${base}?fixture=status.conflicts#/inbox`, { waitUntil: "networkidle" });
await rp.waitForSelector("text=Versions to choose");
report.reducedMotion = {
  elementsStillAnimating: await rp.evaluate(
    () => [...document.querySelectorAll("*")].filter((el) => {
      const s = getComputedStyle(el);
      return s.animationName !== "none" && parseFloat(s.animationDuration) > 0.001 && s.animationPlayState === "running";
    }).length,
  ),
};
await reduced.close();
await browser.close();

report.externalRequests = external;
writeFileSync(join(out, "delivery-axe-report.json"), JSON.stringify(report, null, 2));
const failed = report.runs.filter((r) => r.failed || r.pageErrors);
console.log(
  JSON.stringify(
    {
      runs: report.runs.length,
      violations,
      overflowFailures,
      externalRequests: external,
      reducedMotion: report.reducedMotion,
      failed: failed.map((r) => [r.scenario, r.theme, r.size, r.failed ?? r.pageErrors]),
      withViolations: report.runs.filter((r) => r.violations?.length).map((r) => [r.scenario, r.theme, r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" | ")}`)]),
    },
    null,
    2,
  ),
);
if (violations > 0 || overflowFailures > 0 || external.length > 0 || failed.length > 0) process.exit(1);
