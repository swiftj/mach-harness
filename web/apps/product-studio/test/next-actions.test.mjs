// Unit tests for where the engine's next steps and refusal hints lead (src/api/nextActions.ts).
// Every hint kind the engine can give (studio.HINT_KINDS) has a route; the M13 and M14 commands give
// reopen_slice (a ready slice must be reopened first) and reconcile with the target "principles".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { routeFor, routeForHint } from "../src/api/nextActions.ts";

const run = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), "utf8"));

test("someone else's newer principles: the hint leads to the principles page, not the inbox", () => {
  const refused = run("principle.publish.refused-newer-elsewhere");
  assert.deepEqual(refused.hint, { kind: "reconcile", target: "principles" });
  assert.deepEqual(routeForHint(refused.hint), { type: "navigate", to: "/principles", label: "Choose a version of the principles" });
  assert.equal(routeForHint({ kind: "reconcile", target: "SLICE-002" }).to, "/inbox", "a slice's newer version is still chosen in the inbox");
});

test("a ready slice refused by a new command leads to the slice, to reopen it", () => {
  const refused = run("slice.mock.add.refused-ready");
  assert.equal(refused.hint.kind, "reopen_slice");
  assert.deepEqual(routeForHint(refused.hint), { type: "navigate", to: `/slices/${refused.hint.target}`, label: `Open ${refused.hint.target} to reopen it` });
});

test("every hint kind the engine names has a route of its own", () => {
  const source = readFileSync(new URL("../../../../skills/studio/scripts/studio.py", import.meta.url), "utf8");
  const kinds = [...source.matchAll(/^(NEXT_ACTION_KINDS|HINT_KINDS) = (?:NEXT_ACTION_KINDS \+ )?\(([^)]*)\)/gm)].flatMap((m) => [...m[2].matchAll(/"([a-z_]+)"/g)].map((k) => k[1]));
  assert.ok(kinds.includes("reconcile") && kinds.includes("reopen_slice"), kinds.join(","));
  for (const kind of kinds) {
    // Not an act (M20): AppHint shows the project issues it names as links, and never asks for a route.
    if (kind === "several_projects") continue;
    const route = routeForHint({ kind, target: "SLICE-001" });
    const fallback = routeFor({ kind: "no_such_kind", target: "SLICE-001", title: "", reason: null });
    if (kind !== "mark_ready" && kind !== "finish_ready") assert.notDeepEqual(route, fallback, `${kind} falls through to the default`);
  }
});
