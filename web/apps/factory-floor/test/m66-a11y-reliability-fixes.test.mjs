// M6.6 corrections from the accessibility checks (docs/mach-next/M6_6_ACCESSIBILITY.md) and the
// reliability scenarios (docs/mach-next/M6_6_RELIABILITY.md, defects 3 and 4): reflow at 320 CSS px,
// the design system's focus ring, label-in-name, the scrollable Analytics sheet, an unavailable
// source said on the connection badge, the Factory's disabled and paused stretches on the Timeline's
// ruler (held at the playhead), and the failure cross on the Timeline canvas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import "./_load.mjs";

const notices = await import("../src/shell/notices.ts");
const fi = await import("../src/timeline/data/factoryIntervals.ts");
const draw = await import("../src/timeline/render/draw.ts");
const toolbar = () => src("timeline/controls/TimelineToolbar.tsx");
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
  assert.match(shell, /top: theater \? 0 : inTimeline && !tiny \? topH \+ TIMELINE_CHROME_HEIGHT : topH/);
  assert.match(shell, /<header ref=\{headerRef\}/);
});

test("reflow: the transport wraps below 640 px and the docked timeline makes room for its second row", () => {
  assert.match(src("shell/timeline/Transport.tsx"), /max-\[639px\]:h-auto max-\[639px\]:min-h-10 max-\[639px\]:flex-wrap/);
  assert.match(src("shell/Shell.tsx"), /\+ \(tiny \? TINY_TRANSPORT_EXTRA : 0\)/);
});

test("reflow and text spacing: the Timeline's controls row ends its squeeze by wrapping, never clipping", async () => {
  const t = toolbar();
  assert.match(t, /export const TOOLBAR_WRAP = 4;/);
  assert.match(t, /squeeze >= TOOLBAR_WRAP \? "min-h-10 flex-wrap py-1" : "h-10"/);
  assert.match(t, /setSqueeze\(\(q\) => Math\.min\(TOOLBAR_WRAP, q \+ 1\)\)/);
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

test("focus: the playhead slider, the docked tracks, the Timeline tracks and the label-column splitter carry the ring", () => {
  assert.match(src("shell/timeline/Ruler.tsx"), /focus-visible:outline-2 focus-visible:outline-solid/);
  assert.match(src("shell/timeline/Tracks.tsx"), /focus-visible:outline-2 focus-visible:outline-solid/);
  assert.match(src("timeline/render/TrackCanvas.tsx"), /mach-tl-tracks relative overflow-hidden outline-none focus-visible:outline-2 focus-visible:outline-solid/);
  assert.match(src("timeline/render/TrackLabels.tsx"), /outline-hidden focus-visible:outline-2 focus-visible:outline-solid/);
  assert.doesNotMatch(src("timeline/render/render.css"), /mach-tl-tracks:focus-visible::after/);
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

// ---------------------------------------------------------------- 4 Factory disabled and paused

const E = (t, type) => ({ t, event: { type } });
const T = Date.UTC(2026, 10, 14, 5, 0, 0);
const MIN = 60_000;
const RETRY = [
  E(T, "factory.activated"),
  E(T + 30 * MIN, "work.scheduled"),
  E(T + 42 * MIN, "factory.disabled"),
  E(T + 91 * MIN, "factory.activated"),
  E(T + 91 * MIN, "factory.resumed"),
  E(T + 100 * MIN, "factory.paused"),
  E(T + 120 * MIN, "factory.disabled"),
];

test("the Factory's disabled and paused stretches: ends only where recorded", () => {
  const iv = fi.factoryIntervals(RETRY);
  assert.deepEqual(iv, [
    { kind: "disabled", from: T + 42 * MIN, to: T + 91 * MIN },
    { kind: "paused", from: T + 100 * MIN, to: T + 120 * MIN },
    { kind: "disabled", from: T + 120 * MIN, to: null },
  ]);
  assert.equal(fi.factoryIntervalWords(iv[0]), "Factory disabled 05:42–06:31");
  assert.equal(fi.factoryIntervalWords(iv[2]), "Factory disabled from 07:00, no end recorded");
});

test("held at the playhead, nothing recorded after it is read: a later end is open, a later start absent", () => {
  const at = T + 60 * MIN;
  const iv = fi.factoryIntervals(RETRY, at);
  assert.deepEqual(iv, [{ kind: "disabled", from: T + 42 * MIN, to: null }]);
  assert.ok(iv.every((x) => x.from <= at && (x.to === null || x.to <= at)));
  assert.deepEqual(fi.factoryIntervals(RETRY, T + 10 * MIN), []);
});

test("the ruler draws the stretches with their words, from the Workspace's held cut", () => {
  const ruler = src("timeline/render/WindowRuler.tsx");
  assert.match(ruler, /data-timeline-factory-bands=""/);
  assert.match(ruler, /factoryIntervalWords\(iv\)/);
  assert.match(src("timeline/Workspace.tsx"), /factoryIntervals\(store\.getState\(\)\.log\.entries\(\), heldAt\)/);
});

// ---------------------------------------------------------------- 6 failure without colour

test("a failed bar's end carries the cross: knocked out of a thick bar, past the end of a thin one", () => {
  const calls = [];
  const ctx = { lineWidth: 1, strokeStyle: "", beginPath: () => calls.push("begin"), moveTo: (x, y) => calls.push(["m", x, y]), lineTo: (x, y) => calls.push(["l", x, y]), stroke: () => calls.push("stroke") };
  draw.failCross(ctx, 100, 10, 8, 40, "red", "ground");
  assert.equal(ctx.lineWidth, 1, "line width restored");
  const xs = calls.filter(Array.isArray).map((c) => c[1]);
  assert.ok(xs.every((x) => x < 100), "inside the bar's right end");
  assert.equal(calls.filter((c) => c === "stroke").length, 1);
  calls.length = 0;
  draw.failCross(ctx, 100, 10, 1, 40, "red", "ground");
  assert.ok(calls.filter(Array.isArray).every((c) => c[1] > 100), "past a thin bar's end");
  assert.match(src("timeline/render/draw.ts"), /if \(tone === "fail"\) failCross\(ctx, X1, cy, th, w, ink, p\.ground\);/);
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
  const commands = { toggleInspector() {}, toggleTimeline() {}, openHelp() {}, openSource() {}, modalOpen: () => false };
  const doc = { nodeType: 9 }; // a document: no getAttribute, no tagName
  for (const e of [{ key: "End", target: doc }, { target: doc }]) {
    const ev = { shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, defaultPrevented: false, preventDefault() {}, ...e };
    assert.doesNotThrow(() => shellKeyHandler(fakeStore, commands)(ev));
  }
});
