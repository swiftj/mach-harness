// M6.6 corrections from the accessibility checks (docs/mach-next/M6_6_ACCESSIBILITY.md) and the
// reliability scenarios (docs/mach-next/M6_6_RELIABILITY.md, defects 3 and 4): reflow at 320 CSS px,
// the design system's focus ring, label-in-name, the scrollable Analytics sheet, and an unavailable
// source said on the connection badge. (The Timeline's items, its ruler's Factory stretches and its
// failure cross, went with the Timeline.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import "./_load.mjs";

const notices = await import("../src/shell/notices.ts");
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- 1 reflow

test("reflow: the top bar wraps instead of clipping, and its grid row grows with it", () => {
  const shell = src("shell/Shell.tsx");
  assert.match(shell, /className="flex min-h-12 min-w-0 flex-wrap items-center/);
  assert.match(shell, /minmax\(\$\{TOP\}px,auto\) minmax\(0,1fr\)/);
  // The run's title never forces a wrap (basis 0); below 640 px it takes its own row.
  assert.match(shell, /min-w-0 flex-1 basis-0 overflow-hidden max-\[639px\]:order-last max-\[639px\]:basis-full/);
  assert.match(shell, /<nav aria-label="Workspaces" className="flex shrink-0 flex-wrap/);
});

test("reflow: below 640 px the inspector is a full-width sheet under the measured header", () => {
  const shell = src("shell/Shell.tsx");
  assert.match(shell, /max-\[639px\]:w-full max-\[639px\]:border-l-0/);
  assert.match(shell, /style=\{wide \? undefined : \{ top: theater \? 0 : topH \}\}/);
  assert.match(shell, /<header ref=\{headerRef\}/);
});

test("1280 px: the Factory-state chip's words fold to its glyph below 1440 px, so the Workspaces switch fits", () => {
  assert.match(src("shell/SourceBadge.tsx"), /<span className="max-\[1439px\]:sr-only">\{n\.chip\}<\/span>/);
});

// ---------------------------------------------------------------- 2 focus ring

test("focus: no element turns the outline off and back on without a style (Tailwind 4: outline-2 reads --tw-outline-style)", () => {
  const root = new URL("../src", import.meta.url).pathname;
  const bad = [];
  for (const f of walk(root)) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/className=(?:"[^"]*"|\{`[^`]*`\})/g)) {
      const c = m[0];
      if (/\boutline-(none|hidden)\b/.test(c) && /focus-visible:outline-2\b/.test(c) && !/focus-visible:outline-solid\b/.test(c)) bad.push(`${f.slice(root.length)}: ${c.slice(0, 80)}`);
    }
  }
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- 5 axe

test("label in name: the Factory-state chip's name starts with its visible words", () => {
  const s = src("shell/SourceBadge.tsx");
  assert.match(s, /aria-label=\{n\.title\.startsWith\(n\.chip\) \? `\$\{n\.title\}\. Details` : `\$\{n\.chip\}: \$\{n\.title\}\. Details`\}/);
});

test("the Analytics sheet is a focusable, named scroll region with the design system's ring", () => {
  const s = src("analytics/ui/Workspace.tsx");
  assert.match(s, /<main ref=\{sheet\} className="an-sheet outline-none focus-visible:outline-2 focus-visible:outline-solid[^"]*" aria-label=\{area\.label\} tabIndex=\{0\}>/);
});

// ---------------------------------------------------------------- 3 unavailable source

test("an unavailable source is said by kind, never by path, and clears when it returns", () => {
  const live = { state: "live", attempts: 0, staleSince: null, reason: null };
  assert.equal(notices.unavailableSourceWords(null), null);
  assert.equal(notices.unavailableSourceWords([{ key: "ledger", state: "idle" }, { key: "cell/LOCAL-003", state: "live" }]), null);
  // A finished stream or a cleaned-up cell ends legitimately; the intake log never does.
  assert.equal(notices.unavailableSourceWords([{ key: "stream/x1", state: "ended" }, { key: "cell/LOCAL-001", state: "ended" }]), null);
  assert.equal(notices.unavailableSourceWords([{ key: "ledger", state: "ended" }]), "the intake log");
  assert.equal(notices.unavailableSourceWords([{ key: "ledger", state: "gone" }, { key: "cell/LOCAL-003", state: "unreadable" }, { key: "cell/LOCAL-004", state: "unreadable" }]), "the intake log, a cell's lifecycle log");
  const words = notices.unavailableSourceWords([{ key: "ledger", state: "gone" }]);
  const look = notices.connectionLook(live, words);
  assert.equal(look.state, "live");
  assert.equal(look.label, "Live · a source is unavailable: the intake log");
  assert.doesNotMatch(look.sentence, /\.factory|events\.jsonl|\//);
  assert.notEqual(notices.lookKey(look), notices.lookKey(notices.connectionLook(live, null)));
  assert.equal(notices.connectionLook(live, null).label, "Live");
  // Not said over a dropped connection: that state's own words stand.
  assert.equal(notices.connectionLook({ ...live, state: "reconnecting" }, words).label, "Reconnecting");
});

test("the connection badge and its facts read the polled sources (no new request, no new store)", () => {
  const s = src("shell/SourceBadge.tsx");
  assert.match(s, /useSceneStore\(\(s\) => unavailableSourceWords\(s\.factoryStatus\?\.sources\)\)/);
  assert.match(s, /data-source-unavailable=\{look\.unavailable \?\? undefined\}/);
  assert.match(s, /\["Sources", `Unavailable: \$\{unavailable\}`\]/);
  assert.match(src("shell/Announcer.tsx"), /connectionLook\(s\.connection, unavailableSourceWords\(s\.factoryStatus\?\.sources\)\)/);
});

// ---------------------------------------------------------------- second live run (M6.6 journey)

test("a cell archived by cleanup is finished, not unavailable; a missing intake log and an unreadable live cell log still are", () => {
  assert.equal(notices.unavailableSourceWords([{ key: "cell/LOCAL-001", state: "archived" }]), null);
  assert.equal(notices.unavailableSourceWords([{ key: "cell/LOCAL-001", state: "archived" }, { key: "ledger", state: "gone" }]), "the intake log");
  assert.equal(notices.unavailableSourceWords([{ key: "cell/LOCAL-002", state: "unreadable" }]), "a cell's lifecycle log");
});

test("a keydown at the document (no element, no key) is ignored, not thrown", async () => {
  const { shellKeyHandler } = await import("../src/shell/keyboard.ts");
  const { scene, sim } = await import("./_load.mjs");
  const fakeStore = scene.createSceneStore({ fixture: sim.SCENARIO, clock: (await import("../src/scene/clock.ts")).manualClock() });
  const commands = { toggleInspector() {}, openHelp() {}, openSource() {}, modalOpen: () => false };
  const doc = { nodeType: 9 }; // a document: no getAttribute, no tagName
  for (const e of [{ key: "End", target: doc }, { target: doc }]) {
    const ev = { shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, defaultPrevented: false, preventDefault() {}, ...e };
    assert.doesNotThrow(() => shellKeyHandler(fakeStore, commands)(ev));
  }
});

test("unattended runs off reads as a setting, not a fault: MACH works, only the Supervisor is off", () => {
  const { chip } = notices.noticesFor({ source: "live", connection: null, empty: false, settled: true, notice: null, observer: null, factory: { factoryPresent: true, enabled: false, paused: false } });
  assert.equal(chip.key, "disabled");
  assert.equal(chip.chip, "Unattended runs: off");
  assert.ok(chip.title.startsWith(chip.chip), "the chip's accessible name starts with its visible words");
  assert.match(chip.body, /^MACH is installed and working: an engineer runs its work by hand/);
  assert.match(chip.body, /Only the Factory Supervisor, which runs work unattended, is off/);
  assert.match(chip.body, /outside the Factory Floor, which only reads/);
  assert.doesNotMatch(`${chip.chip} ${chip.title} ${chip.body}`, /not enabled/i);
});
