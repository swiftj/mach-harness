// Global setup and teardown for the M6.5 Analytics browser suite (node --test --test-global-setup).
// Setup: build mach-observer and mach-synth from the working tree into the scratch folder (go build),
// start the relay (4439) and the Vite dev server (4430). Teardown: kill every process any file
// recorded, by pid, even when tests failed (e2e/analytics-lib.mjs).
import { buildTools, killRegistered, log, scratch, spawnDevServer, spawnRelay, takeLock } from "./analytics-lib.mjs";

export async function globalSetup() {
  process.env.E2E_AN_GLOBAL = "1";
  takeLock("test:e2e:analytics");
  log("scratch:", scratch);
  killRegistered();
  if (process.env.E2E_AN_MODE !== "proof") for (const note of buildTools()) log(note);
  await spawnRelay();
  await spawnDevServer();
}

export async function globalTeardown() {
  const killed = killRegistered();
  log("stopped:", killed.length ? killed.join(", ") : "nothing");
}
