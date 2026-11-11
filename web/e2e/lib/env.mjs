// Paths and module resolution shared by every suite.
//
// web/e2e is deliberately not a pnpm workspace package: adding one would change pnpm-lock.yaml.
// Playwright and axe are the exact versions the product-studio app already pins as dev
// dependencies, resolved from that package, so nothing new is installed and nothing loads from a CDN.
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const e2e = resolve(here, "..");
export const web = resolve(e2e, "..");
export const repo = resolve(web, "..");
export const appDir = join(web, "apps/product-studio");
export const hostSource = join(repo, "apps/studio");
export const engine = join(repo, "skills/product-studio/scripts/studio.py");
export const machCli = join(repo, "bin/mach");
export const screenshots = join(e2e, "screenshots");

const requireFromApp = createRequire(join(appDir, "package.json"));
export const { chromium } = requireFromApp("playwright");
export const { AxeBuilder } = requireFromApp("@axe-core/playwright");

/** A fresh scratch folder: under $E2E_SCRATCH when set, else the system temporary folder. */
export function scratch(prefix) {
  const base = process.env.E2E_SCRATCH || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}

export const keepScratch = process.env.E2E_KEEP === "1";
