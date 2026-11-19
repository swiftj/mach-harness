import { serve, sleep } from "./lib.mjs";
import { chromium } from "playwright";
import { join } from "node:path";
const s = await serve();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3, colorScheme: "light" });
const page = await ctx.newPage();
await page.goto(`${s.origin}/?simulation&theme=light#floor`);
await page.waitForFunction(() => window.__machSim);
await page.evaluate(() => document.fonts.ready);
const out = join(process.cwd(), "capture", "raw", "scout");
const shot = async (n) => page.screenshot({ path: join(out, n + ".png") });
for (const t of (process.argv[2] ?? "0,34,640,1470,1601,1660").split(",")) {
  await page.evaluate((t) => { window.__machSim.setFollow(false); window.__machSim.seek(t * 1000); }, +t);
  await sleep(500);
  await page.evaluate(() => window.__atlasCamera.fit());
  await sleep(1200);
  await shot("atlas-" + t);
}
await browser.close(); await s.stop();
