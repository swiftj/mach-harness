// Builds TimelineSpan objects (src/timeline/contract.ts) for tests, shaped as the observer's spans.go
// makes them: id `<kind>:<entity>`, ids only as that kind carries them. Times are epoch milliseconds.

const MIN = 60_000;
export const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
/** Minutes after T0. */
export const at = (minutes) => T0 + Math.round(minutes * MIN);

function spanEnd(value, reason) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return { eventId: null, precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: reason ?? null, ...value };
  return { eventId: null, at: value, precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: reason ?? null };
}

/**
 * span({ kind, entity, parent, ids, start, end, outcome, reason, attrs })
 * `start`/`end` are epoch ms, a partial SpanEnd, or null (start: only the end recorded; end: open).
 */
export function span({ kind, entity, parent = null, ids = {}, start = null, end = null, outcome = null, reason = "completed", attrs = {}, authority = "authoritative" }) {
  const s = spanEnd(start, null);
  const e = spanEnd(end, reason);
  const ms = s && e && s.at !== null && e.at !== null ? e.at - s.at : null;
  const basis = e === null ? "open" : s === null ? "unknown" : "measured";
  return {
    id: `${kind}:${entity}`,
    kind,
    entity,
    parent,
    ids,
    start: s,
    end: e,
    duration: { ms, minMs: ms, maxMs: ms, basis },
    outcome: e ? outcome : null,
    authority,
    attrs,
  };
}

/** A copy with some fields replaced (a new object, as a re-query would return). */
export function changed(original, patch) {
  return { ...original, ...patch };
}

/** A tiny deterministic generator for tests (src stays free of randomness). */
export function lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}
