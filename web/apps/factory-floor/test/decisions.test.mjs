// Decisions in force (key 4, #decisions): the observer's replies read into the page's model, people's
// words contained, the address and the keyboard, the Simulation's labelled sample, the real /mach adr
// commands, and the guards that keep the page read-only and its text plain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { sim } from "./_load.mjs";

const M = await import("../src/decisions/model.ts");
const F = await import("../src/decisions/fixture.ts");
const U = await import("../src/text/unchecked.ts");
const { createSceneStore, showDecisions, showOnLine, DECISION_ID } = await import("../src/scene/store.ts");
const { manualClock } = await import("../src/scene/clock.ts");
const { parseHash, formatHash } = await import("../src/shell/source/hash.ts");
const { applyHash, createHashSync } = await import("../src/shell/source/hashSync.ts");
const { KEYMAP, activeIn, shellKeyHandler } = await import("../src/shell/keyboard.ts");

const make = () => createSceneStore({ fixture: sim.SCENARIO, clock: manualClock() });
const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const view = (t) => (t ? U.uncheckedView(t).full : null);

/** A reply as the observer gives it (apps/observer/internal/server/decisions.go). */
const REPLY = {
  basis: "Read from the ADR folder in the main checkout's working tree, as the files are on disk.",
  source: { kind: "working-tree", dir: "docs/adr", dir_found: true, dir_setting_problem: false, config: "read" },
  adrs: [
    { id: "ADR-0002", number: 2, file: "docs/adr/0002-use-sqlite.md", file_text: null, title: "Keep data in SQLite", status: "superseded", superseded_by: "ADR-0003", supersedes: [], topics: ["storage"], applies_to: ["topic:storage"], applies_to_hidden: 0, binding: false, readable: true, unread: false, problems: [], digest: null },
    { id: "ADR-0003", number: 3, file: "docs/adr/0003-use-postgres.md", file_text: null, title: "Use PostgreSQL <b>now</b>", status: "accepted", superseded_by: null, supersedes: ["ADR-0002"], topics: ["storage", "Bad Topic"], applies_to: ["topic:storage", "path:../x y"], applies_to_hidden: 1, binding: true, readable: true, unread: false, problems: [], digest: "a".repeat(64) },
    { id: "ADR-0006", number: 6, file: "docs/adr/0006-huge.md", file_text: null, title: null, status: "accepted", superseded_by: null, supersedes: [], topics: [], applies_to: ["all"], applies_to_hidden: 0, binding: false, readable: false, unread: true, problems: ["the file is larger than 200 KB"], digest: null },
    { id: null, number: null, file: null, file_text: "docs/adr/0009 Odd Name.md", title: "Odd", status: "bogus", superseded_by: "not-an-id", supersedes: [], topics: [], applies_to: [], applies_to_hidden: 0, binding: true, readable: false, unread: false, problems: ["the file name must be NNNN-title.md"], digest: null },
  ],
  problems: ["docs/adr/0006-huge.md: the file is larger than 200 KB"],
  baseline: {
    required: ["language", "storage"],
    topics: [
      { topic: "language", description: "Language and runtime: ...", added_by_project: false, covered_by: [], files: [] },
      { topic: "storage", description: "Data storage: ...", added_by_project: false, covered_by: ["ADR-0003"], files: [] },
    ],
    missing: ["language"],
    covered: true, // a reply that says covered with a topic uncovered is not believed
    unusable_entries: 0,
    setting_problems: [],
  },
  waiting: {
    proposals: [{ ticket: "T-8", adr: "ADR-0009", title: "Use Redis", file: "docs/adr/0009-use-redis.md", stage: "planned", risk: "High", holds_build: true }],
    stopped: [
      { ticket: "T-7", needs: "adr-decision", stage: "spec-ready", adr: "ADR-0003", adrs: ["ADR-0003"], title: "Use PostgreSQL", reason: "Needs a document store.", at: "2026-11-20T10:00:00+00:00", also_recorded: null },
      { ticket: "T-8", needs: "adr-acceptance", stage: "planned", adr: null, adrs: ["ADR-0009"], title: null, reason: null, at: null, also_recorded: "main-conflict" },
      { ticket: "T-99", needs: "adr-baseline", stage: "spec-ready", adr: null, adrs: [] },
      { ticket: "../x", needs: "adr-fix" },
    ],
    proposed_on_main: ["ADR-0005", "nope"],
  },
  cells: { read: 3, unreadable: ["T-11"], archived: "not read" },
};

test("the list: codes checked, people's words contained, nothing guessed", () => {
  const v = M.readDecisions(REPLY);
  assert.equal(v.adrs.length, 4);
  const [sqlite, pg, huge, odd] = v.adrs;
  assert.equal(sqlite.status, "superseded");
  assert.equal(sqlite.supersededBy, "ADR-0003");
  assert.equal(M.stateWords(sqlite), "Superseded by ADR-0003");
  assert.deepEqual(pg.supersedes, ["ADR-0002"]);
  assert.deepEqual(pg.topics, ["storage"], "a topic that is not a topic word is dropped");
  assert.deepEqual(pg.appliesTo, ["topic:storage"]);
  assert.ok(U.isUnchecked(pg.title), "a title is contained, never a string");
  assert.equal(String(pg.title), "[free text]");
  assert.equal(JSON.stringify({ t: pg.title }), '{"t":"[free text]"}');
  assert.equal(view(pg.title), "Use PostgreSQL <b>now</b>", "shown as the words, never as markup");
  assert.equal(M.stateWords(huge), "Cannot be read", "an unreadable file is listed, and says so");
  assert.equal(huge.problems.length, 1);
  assert.equal(odd.id, null);
  assert.equal(odd.status, null);
  assert.equal(odd.supersededBy, null);
  assert.equal(odd.file, null);
  assert.equal(view(odd.fileText), "docs/adr/0009 Odd Name.md");
  assert.equal(M.stateWords(odd), "Status cannot be read");
  assert.deepEqual(v.baseline.missing, ["language"]);
  assert.equal(v.baseline.covered, false, "fails closed: a topic without a decision is never covered");
  assert.deepEqual(v.stopped.map((s) => `${s.ticket} ${s.needs}`), ["T-7 adr-decision", "T-8 adr-acceptance"], "an unknown code or a bad ticket is dropped");
  assert.equal(v.stopped[1].alsoMainConflict, true);
  assert.equal(view(v.stopped[0].reason), "Needs a document store.");
  assert.deepEqual(v.proposedOnMain, ["ADR-0005"]);
  assert.deepEqual(v.cellsUnreadable, ["T-11"]);
  assert.deepEqual(M.summary(v), { accepted: 2, binding: 1, proposed: 0, withProblems: 2 });
  assert.deepEqual(M.ordered(v.adrs).map((a) => a.id), ["ADR-0002", "ADR-0003", "ADR-0006", null]);
});

test("an empty or broken reply is an empty page, never a crash", () => {
  for (const data of [null, undefined, 42, "x", [], {}, { adrs: "x", baseline: [], waiting: null }]) {
    const v = M.readDecisions(data);
    assert.deepEqual(v.adrs, []);
    assert.equal(v.baseline.covered, false, "a reply that does not say covered is not covered");
    assert.deepEqual(v.stopped, []);
  }
  assert.equal(M.readDecisions({ baseline: { covered: true, topics: [] } }).baseline.covered, true, "an empty required list is the project's choice");
});

test("one decision: an exception says who by role, when and why; a name in the reply is never shown", () => {
  const p = M.readDecision(
    {
      basis: "b",
      adr: { ...REPLY.adrs[1], same_number: ["docs/adr/0003-other.md"] },
      text: "---\nstatus: accepted\n---\n# Use PostgreSQL\n[link](https://example.test) <script>x</script>",
      text_cut: true,
      text_limit: 6000,
      planned_under: [{ ticket: "T-9", stage: "built", planned_at: "2026-11-19T09:00:00+00:00", same_text: false }, { ticket: "../bad" }],
      exceptions: [{ ticket: "T-9", at: "2026-11-18T08:00:00+00:00", by: "Quentin Archer", recorded_by: "Quentin Archer", reason: "Prototype only.", same_text: true }],
      conflicts: [{ ticket: "T-7", at: null, reason: "Needs a document store." }],
      proposed_by: [],
      acceptances: [],
    },
    "ADR-0003",
  );
  assert.deepEqual(p.adr.sameNumber, ["docs/adr/0003-other.md"]);
  assert.ok(U.isUnchecked(p.text));
  assert.match(view(p.text), /<script>x<\/script>/, "the text is the file's words, as plain text");
  assert.equal(p.textCut, true);
  assert.deepEqual(p.plannedUnder.map((t) => t.ticket), ["T-9"]);
  assert.equal(M.sameTextWords(p.plannedUnder[0].sameText), "under an earlier text");
  const e = p.exceptions[0];
  assert.equal(e.by, "a person");
  assert.equal(e.recordedBy, "a person", "anything but MACH's own role phrase becomes a person");
  assert.equal(e.at, "2026-11-18T08:00:00+00:00");
  assert.equal(view(e.reason), "Prototype only.");
  assert.ok(!JSON.stringify(p).includes("Quentin"));
});

test("the Simulation's sample is read by the same readers, and says it is a sample", () => {
  const v = M.readDecisions(F.SAMPLE_DECISIONS);
  assert.match(v.basis, /^Sample decisions for the Simulation\. No project was read\./);
  assert.ok(v.adrs.length >= 5);
  assert.equal(v.baseline.covered, false);
  assert.ok(v.stopped.every((s) => s.ticket.startsWith("SAMPLE-")), "sample tickets are never a project's");
  assert.ok(v.proposals.every((p) => p.ticket.startsWith("SAMPLE-")));
  for (const id of v.adrs.map((a) => a.id)) {
    const p = M.readDecision(F.sampleDecision(id), id);
    assert.match(p.basis, /^Sample decisions/);
  }
  assert.equal(F.sampleDecision("ADR-0404"), null);
  assert.match(src("decisions/Workspace.tsx"), /Simulation: these are sample decisions to show the page\. No project was read\./);
  assert.match(src("decisions/Workspace.tsx"), /<SourceStamp source="simulation" \/>/);
});

test("the commands are the run skill's real ones", () => {
  const skill = readFileSync(new URL("../../../../skills/run/SKILL.md", import.meta.url), "utf8");
  const hint = skill.split("\n").find((l) => l.startsWith("argument-hint:"));
  for (const verb of ["adr [list", "baseline", "new <decision>", "accept <ADR>...", "except <ticket> <ADR> <why>", "accept <ticket> <ADR>...", "decide [<ticket>...]"]) {
    assert.ok(hint.includes(verb), `the skill's argument hint has "${verb}"`);
  }
  assert.equal(M.COMMANDS.list.command, "/mach adr list");
  assert.equal(M.COMMANDS.baseline.command, "/mach adr baseline");
  assert.equal(M.COMMANDS.except("T-7", "ADR-0003").command, '/mach adr except T-7 ADR-0003 "<why>"');
  assert.equal(M.stopCommand({ ticket: "T-8", needs: "adr-acceptance", adr: null, adrs: ["ADR-0009"] }).command, "/mach adr accept T-8 ADR-0009");
  assert.equal(M.stopCommand({ ticket: "T-7", needs: "adr-decision", adr: "ADR-0003", adrs: ["ADR-0003"] }).command, "/mach decide T-7");
  assert.match(M.WHERE_CHANGED, /pull request/);
  assert.match(M.WHERE_CHANGED, /\/mach adr/);
});

test("the words: plain, MACH acts, no internal terms", () => {
  const words = [
    M.WHERE_CHANGED,
    M.BASELINE_HELD,
    ...Object.values(M.STOP_WORDS).flatMap((w) => [w.title, w.sentence]),
    ...Object.values(M.STATUS_WORDS).map((w) => w.label),
    src("decisions/Workspace.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
  ].join("\n");
  // (`error.kind` is code, not words.)
  for (const bad of [/\bengine\b/i, /\blight path\b/i, /(?<!\.)\bkind\b/i, /\ba script\b/i, /\bthe script\b/i]) assert.ok(!bad.test(words), `${bad} appears`);
});

// ---------------------------------------------------------------- the address, the store and the keys

test("address: #decisions and #decisions?adr=ADR-NNNN, both ways; anything else in adr is dropped", () => {
  assert.equal(parseHash("#decisions").route, "decisions");
  assert.equal(parseHash("#decisions").decision, null);
  assert.equal(parseHash("#decisions?adr=ADR-0007").decision, "ADR-0007");
  for (const bad of ["adr-7", "ADR-07", "ADR-00071", "ADR-0007%3Cscript%3E", "<b>"]) assert.equal(parseHash(`#decisions?adr=${bad}`).decision, null, bad);
  assert.equal(parseHash("#line?adr=ADR-0007").decision, null, "adr belongs to Decisions only");
  assert.equal(formatHash({ route: "decisions", sel: null, decision: "ADR-0007" }), "#decisions?adr=ADR-0007");
  assert.equal(formatHash({ route: "decisions", sel: null, decision: null }), "#decisions");
  assert.equal(formatHash({ route: "line", sel: null, decision: "ADR-0007" }), "#line");
  for (const h of ["#decisions", "#decisions?adr=ADR-0001", "#decisions?adr=ADR-9999&sel=cell%3A131"]) {
    const p = parseHash(h);
    assert.equal(formatHash({ route: p.route, sel: p.sel, decision: p.decision }), h);
  }
});

test("store: setDecision takes an ADR ID or null, nothing else; showDecisions switches and keeps the selection", () => {
  const store = make();
  store.select("cell:131", { focus: false });
  store.setDecision("ADR-0003");
  assert.equal(store.getState().decision, "ADR-0003");
  const same = store.getState();
  store.setDecision("x");
  store.setDecision("ADR-0003");
  assert.equal(store.getState(), same);
  showDecisions(store);
  assert.equal(store.getState().workspace, "decisions");
  assert.equal(store.getState().decision, "ADR-0003", "the open page is kept across a switch");
  showDecisions(store, null);
  assert.equal(store.getState().decision, null);
  assert.equal(store.getState().selection, "cell:131");
  assert.equal(store.getState().theater, false);
  store.setTheater(true);
  assert.equal(store.getState().theater, false, "Theater Mode is the Floor's");
  assert.ok(DECISION_ID.test("ADR-0001"));
});

test("hash sync: opening a decision is a new history entry, so Back returns to the list", () => {
  const store = make();
  const host = { hash: "#line", pushed: [], getHash: () => host.hash, replaceHash: (h) => (host.hash = h), pushHash: (h) => (host.pushed.push(h), (host.hash = h)), onHashChange: (l) => ((host.change = l), () => {}) };
  const sync = createHashSync(store, host);
  showDecisions(store);
  assert.equal(host.hash, "#decisions");
  store.setDecision("ADR-0004");
  assert.equal(host.hash, "#decisions?adr=ADR-0004");
  assert.deepEqual(host.pushed, ["#decisions", "#decisions?adr=ADR-0004"]);
  host.hash = "#decisions";
  host.change();
  assert.equal(store.getState().decision, null, "Back: the address without adr is the list");
  host.hash = "#decisions?adr=ADR-0002";
  host.change();
  assert.equal(store.getState().decision, "ADR-0002");
  showOnLine(store);
  assert.equal(host.hash, "#line");
  sync.dispose();
  const fresh = make();
  applyHash(fresh, parseHash("#decisions?adr=ADR-0005"));
  assert.equal(fresh.getState().workspace, "decisions");
  assert.equal(fresh.getState().decision, "ADR-0005");
});

function press(store, key) {
  const commands = { toggleInspector: () => {}, openHelp: () => {}, openSource: () => {}, modalOpen: () => false };
  const e = { key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, defaultPrevented: false, target: null, prevented: false, preventDefault() { this.prevented = true; } };
  shellKeyHandler(store, commands)(e);
  return e;
}

test("keys: 4 opens Decisions from every workspace; no key is bound twice there; I does nothing (no inspector)", () => {
  for (const from of ["line", "floor", "analytics", "decisions"]) {
    const store = make();
    store.setWorkspace(from);
    assert.equal(press(store, "4").prevented, true);
    assert.equal(store.getState().workspace, "decisions");
  }
  const store = make();
  showDecisions(store);
  assert.equal(press(store, "i").prevented, false);
  assert.equal(press(store, "t").prevented, false);
  const seen = new Map();
  for (const b of KEYMAP.filter((k) => !k.view && activeIn(k, "decisions"))) {
    for (const key of b.keys) {
      assert.ok(!seen.has(key) || seen.get(key) === b.action, `${key} twice`);
      seen.set(key, b.action);
    }
  }
  for (const k of ["1", "2", "3", "4"]) assert.ok(seen.has(k), k);
  assert.ok(KEYMAP.some((b) => b.view && b.workspace === "decisions" && b.keys.includes("Escape")), "Escape back to the list is listed in the help");
});

// ---------------------------------------------------------------- guards

const FILES = readdirSync(new URL("../src/decisions", import.meta.url)).filter((n) => /\.tsx?$/.test(n));
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("guard: no markup, no Markdown, no links, no storage, no title from the page's text", () => {
  assert.ok(FILES.includes("Workspace.tsx") && FILES.includes("model.ts"));
  for (const f of FILES) {
    const text = code(src(`decisions/${f}`));
    for (const bad of [/dangerouslySetInnerHTML/, /\.innerHTML/, /\bmarked\b/, /markdown-it|remark|rehype/, /<a\s/, /\bhref=/, /localStorage|sessionStorage|indexedDB/, /document\.title/, /\bfetch\(/, /method:\s*"(POST|PUT|PATCH|DELETE)"/]) {
      assert.ok(!bad.test(text), `${f}: ${bad}`);
    }
  }
});

test("guard: people's words reach the screen only through UncheckedText, and never name anything", () => {
  const ui = code(src("decisions/Workspace.tsx"));
  // Every free-text member is handed to <Contained> or <UncheckedText>, never printed or named.
  for (const field of ["title", "reason", "fileText", "text", "problems"]) {
    for (const m of ui.matchAll(new RegExp(`\\.${field}\\b`, "g"))) {
      const line = ui.slice(ui.lastIndexOf("\n", m.index) + 1, ui.indexOf("\n", m.index));
      assert.ok(!/aria-label=|title=|purpose=|command=/.test(line) || /aria-label=\{`The text of \$\{p\.id\}`\}/.test(line), `named with ${field}: ${line.trim()}`);
      // `{x.title}` printed as a child; `text={x.title}` hands it to the containment.
      const printed = new RegExp(`(?<!text=)\\{\\s*[\\w.?]*\\.${field}\\s*\\}`).test(line);
      assert.ok(!printed, `printed raw: ${line.trim()}`);
    }
  }
  assert.match(ui, /<UncheckedText text=\{p\.text\} labelled expandable=\{false\} \/>/);
  assert.match(ui, /<UncheckedNote \/>/);
});
