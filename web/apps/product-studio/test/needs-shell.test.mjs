// Unit tests for Technical needs' shell (M17, src/features/needs/shell/paths.ts): the paths and the breadcrumb, the
// destination beside Vision, the fixture set the two screens build on, that every needs and design fixture carries the
// app's wording (no terminal command or option), and that no page offers an ADR act or says "architecture".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { DESIGN_ID, designOfPath, designPath, needsBreadcrumb } from "../src/features/needs/shell/paths.ts";

const folder = new URL("../../../fixtures/", import.meta.url);
const run = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, folder), "utf8"));
const needsFixtures = readdirSync(folder)
  .filter((f) => /^(need|design)\.|^reconcile\.needs|^(status|refresh)\.(needs|designs)/.test(f))
  .map((f) => f.slice(0, -5));

test("the paths and the breadcrumb", () => {
  const designs = run("design.list.mapped").data.designs;
  assert.deepEqual(needsBreadcrumb("/needs", designs), ["Technical needs"]);
  assert.deepEqual(needsBreadcrumb("/needs/design", designs), ["Technical needs", "A design you already have"]);
  assert.deepEqual(needsBreadcrumb("/needs/design/DES-01", designs), ["Technical needs", "A design you already have", "DES-01 architecture.md"]);
  assert.deepEqual(needsBreadcrumb("/needs/design/DES-07", designs), ["Technical needs", "A design you already have", "DES-07"]);
  assert.deepEqual(needsBreadcrumb("/needs/design/DES-07", null), ["Technical needs", "A design you already have", "DES-07"]);
  assert.equal(needsBreadcrumb("/vision", designs), null);
  assert.equal(needsBreadcrumb("/needsy", designs), null);
  assert.equal(designPath("DES-01"), "/needs/design/DES-01");
  assert.equal(designOfPath("/needs/design/DES-01"), "DES-01");
  assert.equal(designOfPath("/needs/design"), null);
  assert.ok(DESIGN_ID.test("DES-01") && DESIGN_ID.test("DES-120"));
  for (const bad of ["DES-1", "des-01", "PRD-01", "DES-01/../x", ""]) assert.ok(!DESIGN_ID.test(bad), bad);
});

test("Technical needs sits in the product's own navigation beside Vision, and its routes are registered", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const order = (text) => Number(text.match(/order: (\d+)/)?.[1]);
  const needs = source("../src/features/needs/index.tsx");
  assert.match(needs, /label: "Technical needs"/);
  assert.match(needs, /path: "needs"/);
  assert.match(needs, /path: "needs\/design"/);
  assert.match(needs, /path: "needs\/design\/:designId"/);
  assert.equal(order(needs), 21);
  assert.equal(order(source("../src/features/vision/index.tsx")), 20);
  assert.equal(order(source("../src/features/principles/index.tsx")), 22);
  assert.match(source("../src/features/registry.ts"), /import \{ feature as needs \} from "\.\/needs";[\s\S]*shape, needs(, [a-z]+)*\]/);
});

test("the fixtures hold every state the two screens start from", () => {
  const list = (name) => run(name).data;
  assert.deepEqual(list("need.list.empty").unanswered, ["people", "data", "connections", "never", "priority", "given"]);
  assert.equal(run("status.needs-none").data.needs, undefined, "a project that never opened them: no needs in status");
  const several = list("need.list.several");
  assert.ok(new Set(several.needs.filter((n) => n.status === "active").map((n) => n.kind)).size >= 3);
  assert.deepEqual(several.nothing_to_say, ["never"]);
  assert.equal(several.unpublished_changes, true);
  assert.ok(several.needs.some((n) => n.kind === "given" && n.said_by && n.said_on));
  const behind = list("need.list.adr-behind");
  assert.deepEqual(behind.unanswered, []);
  assert.equal(behind.unpublished_changes, false);
  assert.deepEqual(behind.adrs_behind.map((row) => [row.adr, row.need_id, row.served_revision, row.revision_now]), [["ADR-0001", "TN-01", 1, 2]]);
  assert.equal(list("need.list.newer-elsewhere").published.newer_elsewhere, true);
  assert.deepEqual(list("design.list.empty").designs, []);
  assert.equal(list("design.show.unmapped").map, null);
  const mapped = list("design.show.mapped");
  assert.deepEqual(mapped.map.unsettled, [1]);
  assert.equal(mapped.map.conflicts[0].against, "TN-01");
  assert.ok(mapped.fenced.startsWith("<<<DESIGN-DATA "), "the text arrives fenced as data");
  const published = list("design.show.published");
  assert.deepEqual(published.map.unsettled, []);
  assert.equal(published.map.conflicts[0].settled, "design-is-wrong");
  assert.ok(published.map.published);
  assert.equal(run("design.publish.refused-unsettled").data, null);
});

test("every needs and design fixture is in the app's wording", () => {
  assert.ok(needsFixtures.length >= 45, String(needsFixtures.length));
  const words = [];
  const walk = (value, key) => {
    if (key === "suggested_next" || key === "fenced") return; // the terminal skill's own form; the document's own text
    if (typeof value === "string") words.push(value);
    else if (Array.isArray(value)) value.forEach((v) => walk(v, null));
    else if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => walk(v, k));
  };
  for (const name of needsFixtures) {
    const { data, refused } = run(name);
    walk(data, null);
    if (refused) words.push(refused);
    for (const text of words.splice(0)) {
      assert.doesNotMatch(text, /\s--[a-z]|studio\.py|\((need|design|reconcile) [a-z]/, `${name}: ${text}`);
    }
  }
});

test("no Technical needs page offers an ADR act or says architecture", () => {
  const root = new URL("../src/features/needs/", import.meta.url);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = new URL(entry, dir);
      if (statSync(path).isDirectory()) walk(new URL(`${entry}/`, dir));
      else files.push(path);
    }
  };
  walk(root);
  assert.ok(files.length >= 7);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /"adr\.|adr (accept|settle|new|supersede)/i, file.pathname);
    // Comments may name the engine's own words; what the page says may not.
    const said = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(said, /architecture/i, file.pathname);
  }
});
