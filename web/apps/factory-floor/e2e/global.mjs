// Global setup and teardown for the Timeline end-to-end suite (node --test --test-global-setup).
// Setup: build mach-observer and mach-synth from the working tree into the scratch folder, start the
// relay and the Vite dev server. Teardown: kill every process any test file recorded, by pid, even
// when tests failed (scripts/timeline-e2e-lib.mjs).
import { buildTools, killRegistered, log, scratch, spawnDevServer, spawnRelay } from "../scripts/timeline-e2e-lib.mjs";

export async function globalSetup() {
  log("scratch:", scratch);
  // Anything a previous, interrupted run left behind.
  killRegistered();
  for (const note of buildTools()) log(note);
  await spawnRelay();
  await spawnDevServer();
}

export async function globalTeardown() {
  const killed = killRegistered();
  log("stopped:", killed.length ? killed.join(", ") : "nothing");
}
