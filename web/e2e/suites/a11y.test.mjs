// Accessibility and visuals in the real app with real data: axe on every route in light and dark,
// no horizontal overflow at 1440x900 and 1100x800 (with screenshots of each), a keyboard-only pass
// of the lifecycle's main path, and reduced motion.
//
//   node --test web/e2e/suites/a11y.test.mjs
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AxeBuilder, screenshots } from "../lib/env.mjs";
import { buildHost } from "../lib/build.mjs";
import { createWorld } from "../lib/world.mjs";
import { startHost } from "../lib/host.mjs";
import { openBrowser, overflow, settle, sizes, watchedPage } from "../lib/app.mjs";
import { seedRich } from "../lib/seed.mjs";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
let binary, browser;
const report = { axe: [], overflow: [], keyboard: [], motion: [] };

before(async () => {
  ({ binary } = buildHost());
  browser = await openBrowser();
});

after(async () => {
  await browser?.close();
  mkdirSync(screenshots, { recursive: true });
  writeFileSync(join(screenshots, "a11y-report.json"), JSON.stringify(report, null, 2));
});

test("every route with real data: axe in light and dark, no overflow at either size", async (t) => {
  const world = createWorld({ claude: "fake" });
  const { routes } = seedRich(world);
  const host = await startHost(binary, world.pm, world.env);
  const { page, problems, context } = await watchedPage(browser, host.origin);
  try {
    await page.goto(host.url, { waitUntil: "networkidle" });
    for (const route of routes) {
      await t.test(route, async () => {
        const violations = [];
        const overflows = [];
        // A fresh load per route, so one screen's failure cannot leak into the next.
        await page.goto("about:blank");
        await page.goto(`${host.origin}/#${route}`);
        await settle(page);
        const crashed = await page.getByText("Unexpected Application Error!").count();
        assert.equal(crashed, 0, `${route} crashed the app: ${await page.locator("body").innerText().then((x) => x.split("\n").slice(0, 2).join(" "))}`);
        for (const theme of ["light", "dark"]) {
          await page.emulateMedia({ colorScheme: theme });
          for (const size of sizes) {
            await page.setViewportSize({ width: size.width, height: size.height });
            await settle(page, 400);
            const name = `${route === "/" ? "workspace" : route.slice(1).replace(/\//g, "-")}-${theme}-${size.name}`;
            const dir = join(screenshots, "routes");
            mkdirSync(dir, { recursive: true });
            await page.screenshot({ path: join(dir, `${name}.png`) });
            const o = await overflow(page);
            report.overflow.push({ route, theme, size: size.name, ...o });
            if (o.page > 0 || o.main > 0) overflows.push(`${theme} ${size.name}: page +${o.page}px, main +${o.main}px`);
            if (size.name === "1440") {
              const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
              for (const v of axe.violations) {
                const entry = { route, theme, id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(" ")) };
                report.axe.push(entry);
                violations.push(`${theme}: ${v.id} (${v.impact}) ${v.help} at ${entry.nodes.join(" | ")}`);
              }
            }
          }
        }
        assert.deepEqual({ violations, overflows }, { violations: [], overflows: [] });
      });
    }
    await t.test("no console error, CSP violation or outside request on any route", async () => {
      const p = await problems();
      const firstLine = (m) => m.split("\n")[0];
      assert.deepEqual(
        // A 422 is the engine refusing, shown to the person as written (the browser logs every 4xx as a console error).
        {
          console: [...new Set(p.consoleErrors.map(firstLine))].filter((m) => !/status of 422/.test(m)),
          csp: p.csp,
          external: p.external,
          apiFailures: p.apiFailures.filter((f) => !f.startsWith("422 ")),
        },
        { console: [], csp: [], external: [], apiFailures: [] },
      );
    });
  } finally {
    await context.close();
    await host.stop();
    world.cleanup();
  }
});

/** What has focus, as a keyboard user would perceive it. */
function focusInfo(page) {
  return page.evaluate(() => {
    const e = document.activeElement;
    if (!e || e === document.body) return { name: "(body)", body: true };
    const labelled = (e.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ")
      .trim();
    const name = (e.getAttribute("aria-label") || labelled || (e.labels && e.labels[0]?.textContent) || e.innerText || e.value || e.title || e.tagName).trim().replace(/\s+/g, " ");
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    const indicator = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== "none");
    return {
      name: name.slice(0, 80),
      tag: e.tagName.toLowerCase(),
      role: e.getAttribute("role"),
      inDialog: !!e.closest('[role="dialog"],[role="alertdialog"]'),
      visible: r.width > 0 && r.height > 0,
      focusVisible: e.matches(":focus-visible"),
      indicator,
    };
  });
}

test("keyboard only: the lifecycle's main path", async (t) => {
  const world = createWorld({ claude: "fake", turns: [{ kind: "question", number: 1, title: "Who it is for" }, { kind: "write_spec" }] });
  const host = await startHost(binary, world.pm, world.env);
  const { page, context } = await watchedPage(browser, host.origin);
  const noIndicator = new Map();
  const focusNotRestored = [];
  const escapeIgnored = [];
  let broken = null;
  const step = async (name, fn) => {
    await t.test(name, async (st) => {
      if (broken) return st.skip(`after "${broken}" failed`);
      try {
        await fn();
      } catch (e) {
        broken = name;
        mkdirSync(join(screenshots, "keyboard"), { recursive: true });
        await page.screenshot({ path: join(screenshots, "keyboard", `FAILED-${name.replace(/[^a-z0-9]+/gi, "-")}.png`) }).catch(() => {});
        throw e;
      }
    });
  };
  const press = (key) => page.keyboard.press(key);
  /** Tab (or Shift+Tab) until the focused control's name matches; every stop is checked for a visible focus indicator. */
  const tabTo = async (match, { max = 120, back = false, within } = {}) => {
    const seen = [];
    for (let i = 0; i < max; i++) {
      await press(back ? "Shift+Tab" : "Tab");
      const f = await focusInfo(page);
      seen.push(f.name);
      if (!f.body && f.visible && !f.indicator) noIndicator.set(`${f.tag}${f.role ? `[${f.role}]` : ""} "${f.name}"`, true);
      if (within === "dialog" && !f.inDialog) throw new Error(`focus left the dialog to "${f.name}"`);
      if (typeof match === "string" ? f.name === match : match.test(f.name)) return f;
    }
    throw new Error(`never reached ${match}; focus went: ${seen.slice(-25).join(" → ")}`);
  };
  const dialog = () => page.getByRole("dialog");
  /** Focus stays in the open dialog for a full cycle, Escape closes it, and focus returns to the opener. */
  const trapAndEscape = async (opener) => {
    for (let i = 0; i < 20; i++) {
      await press("Tab");
      const f = await focusInfo(page);
      if (!f.inDialog) throw new Error(`Tab left the dialog to "${f.name}" after ${i + 1} presses`);
    }
    for (let i = 0; i < 5; i++) {
      await press("Shift+Tab");
      const f = await focusInfo(page);
      if (!f.inDialog) throw new Error(`Shift+Tab left the dialog to "${f.name}"`);
    }
    const toasts = await page.getByRole("region", { name: /Notifications/ }).getByRole("listitem").count();
    const at = await focusInfo(page);
    const tooltip = await page.getByRole("tooltip").count();
    await press("Escape");
    const closed = await dialog().waitFor({ state: "detached", timeout: 1500 }).then(() => true, () => false);
    if (!closed) {
      escapeIgnored.push(`Escape did not close the dialog opened by "${opener}" (focus on "${at.name}", ${tooltip} tooltip(s) and ${toasts} notification(s) open; a second Escape was needed)`);
      if (tooltip) escapeIgnored.pop(); // the first Escape rightly closed the tooltip (WCAG 1.4.13)
      await press("Escape");
      await dialog().waitFor({ state: "detached" });
    }
    const back = await focusInfo(page);
    if (back.name !== opener) focusNotRestored.push(`Escape from the dialog opened by "${opener}" left focus on ${back.name}`);
  };
  /** After a dialog closes by its own action, focus must not be lost to the page body. */
  const afterClose = async (what) => {
    const f = await focusInfo(page);
    if (f.body) focusNotRestored.push(`after ${what}, focus was lost to the page body`);
  };

  try {
    await step("the skip link comes first and moves focus into main", async () => {
      await page.goto(host.url, { waitUntil: "networkidle" });
      await settle(page);
      await press("Tab");
      const f = await focusInfo(page);
      assert.equal(f.name, "Skip to content");
      assert.ok(f.indicator, "the skip link shows focus");
      const before = page.url();
      await press("Enter");
      await settle(page);
      const after = page.url();
      const inMain = await page.evaluate(() => !!document.activeElement?.closest("main") || document.activeElement?.id === "main");
      const heading = await page.getByRole("heading", { level: 1 }).first().innerText().catch(() => "");
      if (after !== before) {
        await page.screenshot({ path: join(screenshots, "keyboard", "DEFECT-skip-link.png") }).catch(() => {});
        // Carry on from the screen the skip link should have stayed on.
        await page.goto(before);
        await settle(page);
      }
      assert.equal(after, before, `the skip link navigated away (to "${heading}")`);
      assert.ok(inMain, "focus is in main after the skip link");
    });
    broken = null; // the rest of the path does not depend on the skip link

    await step("define the project", async () => {
      await tabTo("Define the project");
      await press("Enter");
      await page.getByRole("heading", { level: 1, name: "Define the project" }).waitFor();
      await tabTo("Name");
      await page.keyboard.type("Team Space");
      await tabTo("Vision");
      await page.keyboard.type("Teams work together without friction.");
      await tabTo("Outcome 1");
      await page.keyboard.type("Teams can work together");
      await tabTo("Create the project");
      await press("Enter");
      await page.getByRole("heading", { level: 1, name: "Vision" }).waitFor();
      assert.equal(world.status().project.name, "Team Space");
    });

    await step("the epic dialog traps focus, Escape closes it and focus returns", async () => {
      await tabTo("Add an epic");
      await press("Enter");
      await dialog().waitFor();
      const first = await focusInfo(page);
      assert.ok(first.inDialog, `focus moved into the dialog (it is on "${first.name}")`);
      await trapAndEscape("Add an epic");
    });

    await step("add and approve an epic", async () => {
      if ((await focusInfo(page)).name !== "Add an epic") await tabTo("Add an epic");
      await press("Enter");
      await dialog().waitFor();
      const f = await focusInfo(page);
      if (f.name !== "Title") await tabTo("Title", { within: "dialog" });
      await page.keyboard.type("Team membership");
      await tabTo("Criterion 1", { within: "dialog" });
      await page.keyboard.type("Only invited people can join");
      await tabTo("Add epic", { within: "dialog" });
      await press("Enter");
      await dialog().waitFor({ state: "detached" });
      await afterClose("adding an epic");
      await tabTo("Approve EPIC-001", { back: true }).catch(() => tabTo("Approve EPIC-001"));
      await press("Enter");
      await dialog().waitFor();
      await tabTo("Approve epic", { within: "dialog" });
      await press("Enter");
      await dialog().waitFor({ state: "detached" });
      await afterClose("approving an epic");
      assert.equal(world.status().epics[0].status, "approved");
    });

    await step("start a slice and answer the interview", async () => {
      await tabTo("Start a slice", { back: true }).catch(() => tabTo("Start a slice"));
      await press("Enter");
      await dialog().waitFor();
      await tabTo("Title", { within: "dialog" });
      await page.keyboard.type("Invite a teammate");
      await tabTo("Start and open the interview", { within: "dialog" });
      await press("Enter");
      await page.waitForURL(/#\/slices\/SLICE-001\/interview$/);
      await page.getByRole("button", { name: "Start the interview" }).waitFor();
      await settle(page);
      await tabTo("Start the interview");
      await press("Enter");
      await page.getByRole("region", { name: "Who it is for" }).waitFor({ timeout: 30000 });
      await tabTo("Yes, accept", { back: true }).catch(() => tabTo("Yes, accept"));
      await press("Enter");
      await page.getByText("ready for you to approve").waitFor({ timeout: 30000 });
    });

    await step("approve the slice", async () => {
      await tabTo("Open the full specification", { back: true }).catch(() => tabTo("Open the full specification"));
      await press("Enter");
      await page.getByRole("heading", { level: 1, name: "Invite a teammate" }).waitFor();
      await settle(page);
      await tabTo("Approve SLICE-001", { back: true }).catch(() => tabTo("Approve SLICE-001"));
      await press("Enter");
      await dialog().waitFor();
      await tabTo("Approve SLICE-001", { within: "dialog" });
      await press("Enter");
      await dialog().waitFor({ state: "detached" });
      await afterClose("approving a slice");
      assert.equal(world.status().slices[0].status, "approved_for_engineering");
    });

    await step("create, approve and send a wave", async () => {
      await tabTo("Delivery waves", { back: true });
      await press("Enter");
      await page.getByRole("heading", { level: 1, name: "Delivery waves" }).waitFor();
      await settle(page);
      await tabTo("Start a wave");
      await press("Enter");
      await dialog().waitFor();
      await tabTo(/SLICE-001/, { within: "dialog" });
      await press("Space");
      await tabTo("Create a wave with 1 slice", { within: "dialog" });
      await press("Enter");
      await dialog().waitFor({ state: "detached" });
      await afterClose("creating a wave");
      await settle(page);
      await tabTo("Approve WAVE-001", { back: true }).catch(() => tabTo("Approve WAVE-001"));
      await press("Enter");
      await dialog().waitFor();
      await tabTo("Approve WAVE-001", { within: "dialog" });
      await press("Enter");
      await dialog().waitFor({ state: "detached" });
      await afterClose("approving a wave");
      await settle(page);
      await tabTo("Review and send WAVE-001", { back: true }).catch(() => tabTo("Review and send WAVE-001"));
      await press("Enter");
      await page.getByRole("heading", { level: 1, name: "Send WAVE-001 to engineering" }).waitFor();
      await settle(page);
      await tabTo("Send WAVE-001 to engineering…");
      await press("Enter");
      await dialog().waitFor();
      await tabTo("Send WAVE-001", { within: "dialog" });
      await press("Enter");
      await page.getByText("WAVE-001 was sent to engineering").waitFor({ timeout: 60000 });
      assert.equal(world.gh().prs.length, 1);
    });

    await t.test("one Escape closes an open dialog", () => {
      assert.deepEqual(escapeIgnored, []);
    });

    await t.test("dialogs give focus back when they close", () => {
      report.focusNotRestored = focusNotRestored;
      assert.deepEqual(focusNotRestored, []);
    });

    await step("every control reached by Tab showed a focus indicator", () => {
      report.keyboard = [...noIndicator.keys()];
      assert.deepEqual([...noIndicator.keys()], []);
    });
  } finally {
    await context.close();
    await host.stop();
    world.cleanup();
  }
});

test("reduced motion is respected", async (t) => {
  const world = createWorld({ claude: "none" });
  seedRich(world);
  const host = await startHost(binary, world.pm, world.env);
  const measure = async (reducedMotion) => {
    const { page, context } = await watchedPage(browser, host.origin, { reducedMotion });
    // The one-time token is spent by the first context; reuse the cookie from it.
    return { page, context };
  };
  try {
    const first = await measure("reduce");
    await first.page.goto(host.url, { waitUntil: "networkidle" });
    const cookies = await first.context.cookies();
    const runs = {};
    for (const mode of ["no-preference", "reduce"]) {
      const { page, context } = mode === "reduce" ? first : await measure(mode);
      if (mode !== "reduce") await context.addCookies(cookies);
      await page.goto(`${host.origin}/#/vision`);
      await settle(page);
      // Open a dialog and a sheet, and sample what animates while they appear.
      const sample = async () =>
        page.evaluate(() =>
          document.getAnimations().map((a) => {
            const timing = a.effect?.getComputedTiming?.() ?? {};
            const target = a.effect?.target;
            return { name: a.animationName || a.transitionProperty || a.constructor.name, duration: Number(timing.duration) || 0, target: target ? `${target.tagName.toLowerCase()}${target.getAttribute("role") ? `[${target.getAttribute("role")}]` : ""}` : "" };
          }),
        );
      await page.getByRole("button", { name: /^Approve EPIC-002/ }).click();
      await page.waitForTimeout(30);
      const dialogAnims = await sample();
      await page.keyboard.press("Escape");
      await page.goto(`${host.origin}/#/roadmap`);
      await settle(page);
      await page.locator(".react-flow__node").filter({ hasText: "Remove a teammate" }).first().click();
      await page.waitForTimeout(30);
      const sheetAnims = await sample();
      runs[mode] = [...dialogAnims, ...sheetAnims];
      if (mode !== "reduce") await context.close();
    }
    report.motion = runs;
    await t.test("with reduced motion nothing animates for longer than 10 ms", () => {
      const long = runs.reduce.filter((a) => a.duration > 10);
      assert.deepEqual(long, []);
    });
    await t.test("(control) without the preference the same screens do animate", (st) => {
      if (!runs["no-preference"].some((a) => a.duration > 10)) st.diagnostic("nothing animated even without the preference");
    });
    await first.context.close();
  } finally {
    await host.stop();
    world.cleanup();
  }
});
