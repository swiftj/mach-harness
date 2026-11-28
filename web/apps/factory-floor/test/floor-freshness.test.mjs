// The top bar's freshness (shell/freshness.ts), the tickets on this computer the page does not show
// (shell/onDisk.ts), and the Partial badge's lost ranges (shell/gaps.ts): their words and thresholds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";
import { asUtc, exactly } from "./_moments.mjs";
import { ev, finalize } from "./fixtures/v3.mjs";

const F = await import("../src/shell/freshness.ts");
const D = await import("../src/shell/onDisk.ts");
const G = await import("../src/shell/gaps.ts");
const { readFactoryStatus, readObserverHistory } = await import("../src/live/observer.ts");

const NOW = Date.UTC(2026, 10, 24, 14, 0, 0);
const S = 1000;
const MIN = 60 * S;

// ---------------------------------------------------------------- freshness

test("freshness: the newest record's age in words that follow the clock", () => {
  assert.equal(F.freshnessOf(NOW - 12 * S, NOW, 1).text, "last record 12 s ago");
  assert.equal(F.freshnessOf(NOW - 3 * MIN - 20 * S, NOW, 1).text, "last record 3 min ago");
  assert.equal(F.freshnessOf(NOW - 2 * 60 * MIN, NOW, 1).text, "last record 2 h ago");
  assert.equal(F.freshnessOf(NOW - 300, NOW, 1).text, "last record just now");
  assert.equal(F.freshnessOf(null, NOW, 1).text, "no record received yet");
});

test("freshness: the warning tone past ten minutes, only while a ticket is at work", () => {
  assert.equal(F.STALE_RECORD_MS, 10 * MIN);
  assert.equal(F.freshnessOf(NOW - 10 * MIN, NOW, 1).tone, "neutral", "ten minutes is still normal");
  const old = F.freshnessOf(NOW - 10 * MIN - S, NOW, 2);
  assert.equal(old.tone, "warning");
  assert.equal(old.text, "last record 10 min ago");
  assert.equal(old.full.split(exactly(NOW - 10 * MIN - S)).join("<moment>"), "Last record 10 min ago, <moment>; 2 tickets at work. Nothing has been recorded for over 10 minutes while a ticket is at work.");
  const idle = F.freshnessOf(NOW - 5 * 60 * MIN, NOW, 0);
  assert.equal(idle.tone, "neutral", "no ticket at work: nothing to expect, never a warning");
  assert.equal(idle.text, "no ticket at work");
  assert.equal(idle.full, `No ticket at work. The last record 5 h ago, ${exactly(NOW - 5 * 60 * MIN)}.`);
});

test("freshness: announced once per change of tone, never per tick", () => {
  const fresh = F.freshnessOf(NOW - 5 * S, NOW, 1);
  const old = F.freshnessOf(NOW - 11 * MIN, NOW, 1);
  assert.equal(F.freshnessAnnouncement(null, fresh), null, "the first reading is not news");
  assert.equal(F.freshnessAnnouncement("neutral", F.freshnessOf(NOW - 6 * S, NOW, 1)), null, "a tick is not news");
  assert.equal(F.freshnessAnnouncement("neutral", old), "Nothing recorded for over 10 minutes while a ticket is at work.");
  assert.equal(F.freshnessAnnouncement("warning", fresh), "Records are arriving again.");
  assert.equal(F.freshnessAnnouncement("warning", F.freshnessOf(NOW - 11 * MIN, NOW, 0)), "No ticket at work.");
});

test("freshness: a ticket is at work while a station visit is open, not while it waits for a person or has finished", () => {
  const visit = (station, leftAt) => ({ station, leftAt });
  assert.equal(F.atWork({ visits: [visit("build", null)], archived: null, runRecord: null, station: "build" }), true);
  assert.equal(F.atWork({ visits: [visit("build", 5)], archived: null, runRecord: null, station: null }), false);
  assert.equal(F.atWork({ visits: [visit("human-approval", null)], archived: null, runRecord: null, station: "human-approval" }), false);
  assert.equal(F.atWork({ visits: [visit("cleanup", null)], archived: { archive: "", at: 9 }, runRecord: null, station: "cleanup" }), false);
});

// ---------------------------------------------------------------- tickets on disk

const folder = (ticketId, over = {}) => ({ ticketId, folder: true, lifecycleLog: true, cellJson: true, firstSeenMs: NOW - MIN, ...over });

test("on disk, no records received: the ticket's ID and what is known, and what a person can do", () => {
  const [line] = D.onDiskLines([folder("6")], { cells: {} }, NOW);
  assert.equal(line.kind, "not-received");
  assert.equal(line.text, "Ticket 6 has a workspace on this computer but none of its records have reached this page yet.");
  assert.match(line.action, /^The observer reads the folder again on its own/);
});

test("on disk, no lifecycle log: no station wrote a record; the helper is named and /mach doctor", () => {
  const [line] = D.onDiskLines([folder("6", { lifecycleLog: false })], { cells: {} }, NOW);
  assert.equal(line.kind, "no-records");
  assert.equal(line.text, "Ticket 6 has a workspace on this computer, but no station has written a record for it: its folder holds cell.json and no lifecycle log.");
  assert.ok(line.action.includes(D.LIFECYCLE_HELPER) && line.action.includes("/mach doctor"));
  // The observer's own "history began from cell.json" cell is still a ticket with no records.
  const began = { cells: { 6: { ticketId: "6", archived: null, runRecord: null, historyBegan: { reason: "no-lifecycle-log", at: NOW - MIN } } } };
  assert.equal(D.onDiskLines([folder("6", { lifecycleLog: false })], began, NOW)[0].kind, "no-records");
});

test("on disk, finished: its records say it finished, but its workspace is still here", () => {
  const scene = { cells: { 6: { ticketId: "6", archived: null, runRecord: { outcome: "merged", at: NOW - MIN, rounds: 1, firstPass: true } } } };
  const [line] = D.onDiskLines([folder("6")], scene, NOW);
  assert.equal(line.kind, "finished-still-here");
  assert.equal(line.text, "Ticket 6: its records say it finished, but its workspace is still here.");
});

test("on disk: nothing is said for a ticket shown at work, a folder gone, or within the grace", () => {
  const atWork = { cells: { 6: { ticketId: "6", archived: null, runRecord: null } } };
  assert.deepEqual(D.onDiskLines([folder("6")], atWork, NOW), []);
  assert.deepEqual(D.onDiskLines([folder("6", { folder: false })], { cells: {} }, NOW), []);
  assert.deepEqual(D.onDiskLines([folder("6", { firstSeenMs: NOW - 5 * S })], { cells: {} }, NOW), [], "a folder just made is given time");
  const justDone = { cells: { 6: { ticketId: "6", archived: { archive: "", at: NOW - 5 * S }, runRecord: null } } };
  assert.deepEqual(D.onDiskLines([folder("6")], justDone, NOW), [], "cleanup removes the folder moments after its records");
});

test("the health reply's cell part is read; other sources carry none", () => {
  const status = readFactoryStatus({
    freshness: {
      sources: [
        { key: "cell/6", state: "idle", cell: { ticket_id: "6", folder: true, lifecycle_log: false, cell_json: true, first_seen_ms: NOW - MIN } },
        { key: "i:0badc0de", state: "live" },
      ],
    },
  });
  assert.deepEqual(status.sources[0].cell, { ticketId: "6", folder: true, lifecycleLog: false, cellJson: true, firstSeenMs: NOW - MIN });
  assert.equal("cell" in status.sources[1], false);
});

// ---------------------------------------------------------------- lost ranges

test("lost ranges: which source, between which records, the reason in words and as recorded, when noticed", () => {
  const gaps = [
    { eventId: "o:gap:1", at: NOW - 3 * MIN, reason: "missing-seq", source: "c:6:0adc4f0c", from: "4", to: "6", count: 3, class: "not-received", lost: true, noticedAt: NOW - 2 * MIN },
    { eventId: "o:gap:2", at: NOW - 2 * MIN, reason: "conflict", source: "c:6:0adc4f0c", from: "8", to: "8", count: 1, class: "conflict", lost: false, noticedAt: NOW },
    { eventId: "k:1", at: NOW - 10 * MIN, reason: "before-window", source: "client", from: null, to: "e.12", count: null, class: "before-window", lost: true },
  ];
  const observer = [
    { eventId: "o:gap:1", sourceKey: "c:6:0adc4f0c", fromSeq: 4, toSeq: 6, reason: "missing-seq", class: "not-received", atMs: NOW - 3 * MIN, noticedMs: NOW - 2 * MIN },
    { eventId: "o:gap:9", sourceKey: "i:00aa11bb", fromSeq: 12, toSeq: 12, reason: "truncated", class: "not-received", atMs: NOW - 20 * MIN, noticedMs: NOW - 19 * MIN },
  ];
  const lines = G.lostRangeLines(gaps, observer);
  assert.equal(lines.length, 3, "a conflict lost nothing; a range both hold is listed once");
  assert.deepEqual(
    lines.map((l) => asUtc(G.lostRangeSentence(l), NOW - 19 * MIN, NOW - 2 * MIN)),
    [
      "The intake log, record 12: the file became shorter than what had been read: what was cut off was not received (truncated); noticed at 13:41:00 UTC.",
      "This page's connection to the observer: before the history this page loaded (before-window).",
      "Ticket 6's lifecycle log, records 4 to 6: record numbers were skipped: the records between them were never received (missing-seq); noticed at 13:58:00 UTC.",
    ],
  );
  assert.match(G.LOST_RANGES_ACTION, /Reloading the page reads its history again/);
});

test("lost ranges: the observer's list is read from its history facts; a gap record says when it was noticed", () => {
  const h = readObserverHistory({ completeness: "partial", lost: { "not-received": 1 }, lost_ranges: [{ source_key: "c:6:aa", from_seq: 2, to_seq: 3, reason: "missing-seq", class: "not-received", at_ms: 5, noticed_ms: 9, event_id: "o:gap:x" }] });
  assert.deepEqual(h.lostRanges, [{ eventId: "o:gap:x", sourceKey: "c:6:aa", fromSeq: 2, toSeq: 3, reason: "missing-seq", class: "not-received", atMs: 5, noticedMs: 9 }]);
  const gap = ev("history.gap", { stream: "observer", key: "gap", seq: 1, t: NOW - MIN, lag: 0, data: { source_key: "c:6:aa", from_seq: 2, to_seq: 3, reason: "missing-seq", count: 2, class: "not-received", history_lost: true } });
  const log = sim.createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: sim.provenance("live") });
  log.ingest(finalize([gap]));
  const [g] = log.head().completeness.gaps;
  assert.equal(g.noticedAt, NOW - MIN);
  assert.equal(G.sourceWords("c:LOCAL-7:3f2a9c1e"), "ticket LOCAL-7's lifecycle log");
  assert.equal(G.sourceWords("r:0badc0de"), "the run records (runs.jsonl)");
});
