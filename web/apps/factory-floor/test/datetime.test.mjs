// The shared moment words (@mach/ui/datetime), used by both apps: the date with the time, in the
// person's locale and time zone; "Today" and "Yesterday" for the two latest days; the year only when it
// is not this year; the full moment and zone for the title; how old it is from before yesterday on.
// Locale, zone and clock are fixed here, so the words are the same wherever the test runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const D = await import("@mach/ui/datetime");
const time = await import("../src/shell/time.ts");

const NOW = Date.parse("2026-11-27T15:00:00Z");
const GB = { now: NOW, locale: "en-GB", timeZone: "Europe/London" };

test("today, yesterday, an earlier day, another year", () => {
  assert.equal(D.momentWords("2026-11-27T14:53:26Z", GB).text, "Today 14:53");
  assert.equal(D.momentWords("2026-11-27T14:53:26Z", GB).inline, "today 14:53");
  assert.equal(D.momentWords("2026-11-26T20:02:23Z", GB).text, "Yesterday 20:02");
  assert.equal(D.momentWords("2026-11-24T20:02:00Z", GB).text, "24 Nov 20:02");
  assert.equal(D.momentWords("2025-11-24T20:02:00Z", GB).text, "24 Nov 2025, 20:02");
});

test("the day is the person's: a moment after midnight in their zone is today, though it was yesterday in UTC", () => {
  const tokyo = { now: Date.parse("2026-11-27T03:00:00Z"), locale: "en-GB", timeZone: "Asia/Tokyo" };
  // 2026-11-26T16:30Z is 01:30 on 27 Nov in Tokyo.
  assert.equal(D.momentWords("2026-11-26T16:30:00Z", tokyo).text, "Today 01:30");
  assert.equal(D.momentWords("2026-11-26T16:30:00Z", { ...tokyo, timeZone: "UTC" }).text, "Yesterday 16:30");
});

test("precision: the minute by default, the second for an event record, the tenth when asked", () => {
  assert.equal(D.momentWords("2026-11-27T14:53:26.4Z", { ...GB, precision: "second" }).text, "Today 14:53:26");
  assert.equal(D.momentWords("2026-11-27T14:53:26.4Z", { ...GB, precision: "tenth" }).clock, "14:53:26.4");
});

test("the full moment and zone, and the machine-readable moment", () => {
  const w = D.momentWords("2026-11-24T20:02:23Z", { ...GB, precision: "second" });
  assert.match(w.exact, /Tuesday/);
  assert.match(w.exact, /24 November 2026/);
  assert.match(w.exact, /20:02:23/);
  assert.match(w.exact, /GMT/);
  assert.equal(w.iso, "2026-11-24T20:02:23.000Z");
  assert.match(D.momentWords("2026-07-24T20:02:23Z", GB).exact, /BST/, "the zone as it was on that day");
});

test("an old moment says how old it is; today and yesterday do not", () => {
  assert.equal(D.momentWords("2026-11-27T10:00:00Z", GB).age, null);
  assert.equal(D.momentWords("2026-11-26T10:00:00Z", GB).age, null);
  assert.equal(D.momentWords("2026-11-24T14:00:00Z", GB).age, "3 d ago");
  assert.equal(D.ageWords(12_000), "12 s ago");
  assert.equal(D.ageWords(3 * 60_000), "3 min ago");
  assert.equal(D.ageWords(2 * 3_600_000), "2 h ago");
  assert.equal(D.ageWords(0), "just now");
});

test("a span gives the second moment's day only when it is another day", () => {
  const p = { ...GB, precision: "second" };
  assert.equal(D.spanWords(Date.parse("2026-11-27T14:53:26Z"), Date.parse("2026-11-27T14:55:02Z"), p), "Today 14:53:26 to 14:55:02");
  assert.equal(D.spanWords(Date.parse("2026-11-26T23:58:00Z"), Date.parse("2026-11-27T00:04:00Z"), p), "Yesterday 23:58:00 to today 00:04:00");
});

test("an unreadable moment reads as itself", () => {
  const w = D.momentWords("not a time", GB);
  assert.equal(w.text, "not a time");
  assert.equal(w.age, null);
});

test("the locale sets the words: a 12-hour locale keeps its own clock", () => {
  assert.equal(D.momentWords("2026-11-27T14:53:26Z", { ...GB, locale: "en-US" }).text, "Today 02:53 PM");
});

test("the Factory Floor's time codes: real history dated, the Simulation's scenario code unchanged", () => {
  time.setTimeBase("scenario");
  assert.equal(time.timecode(252_500), "04:12.5");
  assert.equal(time.timecodeInline(252_500), "04:12");
  assert.equal(time.spanCode(252_000, 258_000, "at most "), "04:12 to at most 04:18");
  time.setTimeBase("wall");
  const t = Date.now();
  assert.equal(time.timecode(t), time.wallMoment(t, "second").text);
  assert.match(time.timecode(t), /^Today /);
  assert.match(time.timecodeInline(t), /^today /);
  assert.match(time.spanCode(t, t + 1000), /^Today .+ to \d/);
  time.setTimeBase("scenario");
});
