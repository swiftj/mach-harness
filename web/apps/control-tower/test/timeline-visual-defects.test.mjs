// The four visual defects the Timeline's final capture set showed (docs/mach-next/M6_3_COMPLETION.md,
// section 5, "Must fix"): the toolbar measured once and left clipped when the pinned control arrived;
// "After the playhead" left on screen at the live edge; a wait on a person picked on the tracks said
// nothing more was recorded; a lens's Frame left the tracks scrolled away from what it framed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./_load.mjs";

const frame = await import("../src/timeline/controls/frame.ts");
const scale = await import("../src/timeline/render/scale.ts");
const M = await import("../src/timeline/inspector/model.ts");
const words = await import("../src/shell/inspector/words.ts");
const inv = await import("../src/timeline/investigate/model.ts");
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- 1. the toolbar folds whatever it holds

const base = { rowWidth: 936, lens: null, filters: 0, jump: "failure", caption: false, table: false, pinnedAhead: null, length: "10 min" };

test("1: the toolbar is measured again when the pinned control arrives, at the same width", () => {
  const before = frame.toolbarFitKey(base);
  const pinned = frame.toolbarFitKey({ ...base, pinnedAhead: 13 * 3_600_000 + 12 * 60_000 });
  assert.notEqual(before, pinned, "the pinned control changes what the row holds: the fit must start again");
  assert.equal(frame.toolbarFitKey({ ...base }), before, "nothing changed: the same key (no re-fit per render)");
});

test("1: the pinned control's words, the window's length and the chips each re-fit the row", () => {
  const a = frame.toolbarFitKey({ ...base, pinnedAhead: 3 * 60_000 });
  assert.notEqual(a, frame.toolbarFitKey({ ...base, pinnedAhead: 13 * 3_600_000 }), "'3 min ahead' and '13 h ahead' are different widths");
  assert.equal(a, frame.toolbarFitKey({ ...base, pinnedAhead: 3 * 60_000 + 200 }), "a change below the words' resolution does not re-fit");
  assert.notEqual(frame.toolbarFitKey(base), frame.toolbarFitKey({ ...base, length: "1 h 15 min" }));
  assert.notEqual(frame.toolbarFitKey(base), frame.toolbarFitKey({ ...base, filters: 2 }));
  assert.notEqual(frame.toolbarFitKey(base), frame.toolbarFitKey({ ...base, lens: "waits" }));
  assert.notEqual(frame.toolbarFitKey(base), frame.toolbarFitKey({ ...base, rowWidth: 1168 }), "an inspector opened or closed beside it");
});

test("1: the toolbar uses the full fit key, and a squeezed row shortens the pinned control to 'Window pinned — Follow'", () => {
  const t = src("timeline/controls/TimelineToolbar.tsx");
  assert.match(t, /toolbarFitKey\(\{[\s\S]*pinnedAhead: pinned \? pinned\.ahead : null/);
  assert.match(t, /live edge is \{windowLengthWords\(pinned\.ahead\)\} ahead/);
  assert.match(t, /squeeze >= 2 && "hidden"\)\}> · live edge is/);
});

test("1: the shared transport drops its secondary words in a column narrower than 1100 px; the floor's is unchanged", () => {
  assert.equal(frame.transportCompact(0), false, "not measured yet: as before");
  assert.equal(frame.transportCompact(936), true, "1280 wide with the inspector column (344 px)");
  assert.equal(frame.transportCompact(1099), true);
  assert.equal(frame.transportCompact(1100), false, "1100 wide with the inspector as a drawer");
  assert.equal(frame.transportCompact(1168), false, "1512 wide with the inspector column");
  assert.match(src("timeline/Workspace.tsx"), /<Transport collapsed=\{false\} idleSince=\{idleSince\} compact=\{transportCompact\(fullWidth\)\} \/>/);
  assert.match(src("shell/timeline/Timeline.tsx"), /<Transport (?![^>]*compact)/, "the docked timeline's transport passes no compact flag");
});

test("1: over the Timeline the inspector drawer starts under the transport and the toolbar, so Follow stays in reach", () => {
  assert.equal(frame.TIMELINE_CHROME_HEIGHT, 81);
  // M6.5: only the Timeline has the transport and toolbar; the floor and Analytics start under the header.
  assert.match(src("shell/Shell.tsx"), /top: theater \? 0 : inTimeline \? TOP \+ TIMELINE_CHROME_HEIGHT : TOP/);
});

// ---------------------------------------------------------------- 2. "After the playhead" only while behind

test("2: the after-the-playhead band is not drawn at the live edge, and its label never outlives it", () => {
  assert.equal(scale.afterPlayheadBand(false, -200, 944, 944), null, "following: no band (and so no label)");
  assert.equal(scale.afterPlayheadBand(true, 944, 944, 944), null, "nothing between the playhead and the live edge in the window");
  assert.deepEqual(scale.afterPlayheadBand(true, -40, 944, 944), { left: 0, width: 944, label: true }, "behind, the playhead left of the window");
  assert.deepEqual(scale.afterPlayheadBand(true, 900, 944, 944), { left: 900, width: 44, label: false }, "too narrow for its label");
});

test("2: the tracks never give the label its own 'visible' (a hidden band would not hide it)", () => {
  const t = src("timeline/render/TrackCanvas.tsx");
  assert.match(t, /label\.style\.visibility = band\?\.label \? "" : "hidden"/);
  assert.doesNotMatch(t, /label\.style\.visibility = [^;]*"visible"/);
});

// ---------------------------------------------------------------- 3. a wait on a person, picked on the tracks

const at = (t, extra = {}) => ({ eventId: `e-${t}`, at: t, precision: "s", notBefore: t - 999, notAfter: t, basis: "recorded", rule: null, reason: null, ...extra });
/** Shaped like REAL-A's wait on a person (person-wait:gate:LOCAL-001/required:…), as the observer serves it. */
const personWait = (finish) => ({
  id: "person-wait:gate:LOCAL-001/required:i:x:18",
  kind: "person-wait",
  entity: "gate:LOCAL-001/required:i:x:18",
  parent: "cell:LOCAL-001",
  ids: { ticket_id: "LOCAL-001", slice_id: "SLICE-001" },
  start: at(1_000_000),
  end: finish === null ? null : at(finish, { reason: "completed" }),
  duration: finish === null ? { ms: null, minMs: null, maxMs: null, basis: "open" } : { ms: finish - 1_000_000, minMs: finish - 1_000_999, maxMs: finish - 999_001, basis: "measured" },
  outcome: finish === null ? null : "work.claimed",
  authority: "authoritative",
  attrs: { reasons: ["1 execution(s) ended without moving it past 'building'."] },
});
const cellSpan = { id: "cell:cell:LOCAL-001", kind: "cell", entity: "cell:LOCAL-001", parent: null, ids: { ticket_id: "LOCAL-001" }, start: at(0), end: null, duration: { ms: null, minMs: null, maxMs: null, basis: "open" }, outcome: null, authority: "authoritative", attrs: {} };

test("3: the wait picked through its cell is the subject of In time, with what it waited on in its record's words", () => {
  const w = personWait(4_000_000);
  const { span, picked } = M.subjectSpan("cell:LOCAL-001", w.entity, [cellSpan, w], 5_000_000);
  assert.equal(picked, true);
  assert.equal(span, w);
  assert.deepEqual(M.waitedOnOf(w, 5_000_000), ["1 execution(s) ended without moving it past 'building'."]);
  assert.equal(M.endedFact(w, 5_000_000, {}).state, "at", "until when: its end");
  const open = personWait(null);
  assert.match(M.endedFact(open, 5_000_000, {}).text, /waiting for a person/i, "still open: said so");
});

test("3: nothing is invented: no reason recorded, another kind, or not begun at the playhead gives no 'Waiting on'", () => {
  const w = personWait(null);
  assert.equal(M.waitedOnOf({ ...w, attrs: {} }, 5_000_000), null);
  assert.equal(M.waitedOnOf({ ...w, attrs: { reasons: ["  "] } }, 5_000_000), null);
  assert.equal(M.waitedOnOf(cellSpan, 5_000_000), null);
  assert.equal(M.waitedOnOf(w, 500_000), null, "before its start");
});

test("3: the note above a picked-through span never says nothing more is recorded, and In time comes first", () => {
  const note = words.pickedThroughWords("gate:LOCAL-001/required:i:x:18", "Cell");
  assert.match(note, /a wait on a person/);
  assert.match(note, /In time, first/);
  assert.doesNotMatch(note, /No further detail/);
  assert.equal(words.pickedWords("gate:LOCAL-001/round#2"), "a review round");
  const inspector = src("shell/inspector/Inspector.tsx");
  assert.doesNotMatch(inspector, /No further detail/);
  const first = inspector.indexOf("{through ? <InTimeSection");
  const anatomy = inspector.indexOf("<Anatomy entity={subject}");
  assert.ok(first > 0 && first < anatomy, "In time is drawn before the cell's own anatomy when a span was picked through it");
  const section = src("timeline/inspector/InTimeSection.tsx");
  assert.match(section, /\["Waiting on"/);
  assert.match(section, /context \? \["Recorded as", <AuthorityBadge/);
});

// ---------------------------------------------------------------- 4. Frame brings its rows into view

test("4: Frame reveals the first framed ref that has a track, else the first given", () => {
  const has = (r) => r === "workflow:x2/w1";
  assert.equal(frame.frameRevealRef(["agent:x1/a", "workflow:x2/w1"], has), "workflow:x2/w1");
  assert.equal(frame.frameRevealRef(["agent:x1/a"], has), "agent:x1/a");
  assert.equal(frame.frameRevealRef([], has), null);
});

test("4: a Frame concerns its spans' rows, then their parents' (a wait on a person has no row in the Execution grouping)", () => {
  const wait = { entity: "gate:SYN-004/required:i:x:45", parent: "cell:SYN-004" };
  const visit = { entity: "visit:SYN-005/build#1", parent: "execution:x1" };
  assert.deepEqual(inv.frameAbout([wait, null, visit, { entity: "visit:SYN-005/build#1", parent: null }]), ["gate:SYN-004/required:i:x:45", "visit:SYN-005/build#1", "cell:SYN-004", "execution:x1"]);
  // In the Execution grouping only the cell's executions have rows: the parent is what is revealed.
  assert.equal(frame.frameRevealRef(inv.frameAbout([wait]), (r) => r === "cell:SYN-004"), "cell:SYN-004");
});

test("4: every lens's Frame says which rows it concerns, and the workspace reveals them with the existing reveal (no selection, no pan)", () => {
  for (const f of ["Concurrency", "Recovery", "Retries", "Review", "Waits"]) {
    const s = src(`timeline/investigate/${f}.tsx`);
    for (const m of s.matchAll(/<FrameFig [^>]*\/>/g)) assert.match(m[0], / about=\{frameAbout\(/, `${f}: ${m[0].slice(0, 60)}`);
  }
  assert.match(src("timeline/investigate/InvestigationPanel.tsx"), /props\.onFrameRows\?\.\(about\)/);
  const w = src("timeline/Workspace.tsx");
  assert.match(w, /onFrameRows=\{onFrameRows\}/);
  assert.match(w, /frameOnly\.current === ref \? null : extentOfSpans\(spansOfRef/);
  // One reveal: the frame goes through `pendingReveal`, not a second scroll helper.
  const onFrameRows = w.slice(w.indexOf("const onFrameRows"), w.indexOf("[tree],", w.indexOf("const onFrameRows")));
  assert.match(onFrameRows, /pendingReveal\.current = ref/);
  assert.doesNotMatch(onFrameRows, /setScrollTop|store\.select|store\.seek/);
});
