// The real app in a real Chromium against the real host: watchers for what must never happen,
// screenshots at both sizes, and a small step runner for sequential suites.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, screenshots } from "./env.mjs";

export const sizes = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1100", width: 1100, height: 800 },
];

export async function openBrowser() {
  return chromium.launch();
}

/**
 * A page that records console errors, page errors, CSP violations, requests to any other origin,
 * and API responses that were not ok. Call `problems()` to read them.
 */
export async function watchedPage(browser, origin, { viewport = sizes[0], reducedMotion, colorScheme } = {}) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion, colorScheme });
  const page = await context.newPage();
  const seen = { consoleErrors: [], external: [], apiFailures: [], requests: [] };
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"}`));
  });
  page.on("console", (m) => {
    if (m.type() === "error") seen.consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => seen.consoleErrors.push(`page error: ${e.message}`));
  page.on("request", (r) => {
    const url = r.url();
    seen.requests.push(`${r.method()} ${url}`);
    if (!url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:") && url !== "about:blank") seen.external.push(url);
  });
  page.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 400) seen.apiFailures.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
  return {
    context,
    page,
    seen,
    async problems() {
      const csp = await page.evaluate(() => window.__csp ?? []).catch(() => []);
      return { ...seen, csp };
    },
  };
}

/** Waits until nothing on screen says it is loading. */
export async function settle(page, ms = 300) {
  await page
    .waitForFunction(
      () =>
        !document.querySelector('[aria-busy="true"]') &&
        ![...document.querySelectorAll('[role="status"]')].some((n) => /^(Checking|Reading|Loading)/.test((n.textContent ?? "").trim())),
      undefined,
      { timeout: 30000 },
    )
    .catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(ms);
}

/** Screenshots of the current screen at both sizes (and back to the first). */
export async function shoot(page, folder, name) {
  const dir = join(screenshots, folder);
  mkdirSync(dir, { recursive: true });
  const original = page.viewportSize();
  const files = [];
  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await settle(page, 250);
    const file = join(dir, `${name}-${size.name}.png`);
    await page.screenshot({ path: file });
    files.push(file);
  }
  if (original) await page.setViewportSize(original);
  return files;
}

/** Horizontal overflow of the page and of <main>, in pixels (0 is none). */
export function overflow(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    return { page: document.documentElement.scrollWidth - window.innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
  });
}

/**
 * Sequential steps for node:test: a step after a failed one is skipped (it would only fail for
 * the same reason), and every failure leaves a screenshot.
 */
export function stepper(t, getPage, folder) {
  let broken = null;
  return async function step(name, fn) {
    await t.test(name, async (st) => {
      if (broken) {
        st.skip(`after "${broken}" failed`);
        return;
      }
      try {
        await fn(st);
      } catch (error) {
        broken = name;
        const page = getPage();
        if (page) {
          const dir = join(screenshots, folder);
          mkdirSync(dir, { recursive: true });
          await page.screenshot({ path: join(dir, `FAILED-${name.replace(/[^a-z0-9]+/gi, "-")}.png`), fullPage: false }).catch(() => {});
        }
        throw error;
      }
    });
  };
}
