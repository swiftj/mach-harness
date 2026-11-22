// Scout (not a film clip): one screenshot of a Shape state in fixture mode, after the same alignment the clips use.
import { chromium } from "playwright";
import { alignIdea, ORIGIN, applyZoom, VIEWPORT, settle, cleanup } from "./lib.mjs";
const [, , url, out, pre] = process.argv;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: VIEWPORT, colorScheme: "light", bypassCSP: true });
await alignIdea(ctx);
const page = await ctx.newPage();
await applyZoom(page);
await page.goto(`${ORIGIN}/${url}`);
await settle(page, 800); await page.waitForTimeout(2000);
if (pre) { await eval(`(async()=>{${pre}})()`); await page.waitForTimeout(1500); }
await page.screenshot({ path: out });
console.log((await page.evaluate(() => document.querySelector("main")?.innerText ?? document.body.innerText)).slice(0, 2500));
await b.close(); cleanup(); process.exit(0);
