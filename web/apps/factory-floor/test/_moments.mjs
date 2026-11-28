// Moments are said in the person's locale and time zone, with the date ("today 10:15:00", "24 Nov
// 10:15:00"), so what a sentence says depends on where and when the test runs. These helpers read the
// moments of a sentence back as fixed words ("10:15:00 UTC"), so a check on the rest of the sentence
// holds in any zone and on any day. The formatter's own words are checked in datetime.test.mjs.
import "./_load.mjs";

const TM = await import("../src/shell/time.ts");

/** A real-history moment as a sentence says it (to the second). */
export const said = (ms, precision = "second") => TM.wallMoment(ms, precision).inline;
/** The same, standalone ("Today 10:15:00"). */
export const saidAlone = (ms, precision = "second") => TM.wallMoment(ms, precision).text;
/** The full moment with its zone, as a title or an accessible name says it. */
export const exactly = (ms) => TM.wallMoment(ms, "second").exact;

const utc = (ms) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;

/** `text` with each of these moments, as said, written back as "HH:MM:SS UTC". */
export function asUtc(text, ...ms) {
  let out = text;
  for (const t of ms) out = out.split(said(t)).join(utc(t)).split(saidAlone(t)).join(utc(t));
  return out;
}
