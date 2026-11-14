// M6.6 Phase 9 (policy review): a figure states its measurement basis truthfully. The station's
// visit-duration chart in Flow said every percentile was "read from the observer's buckets, as the
// upper edge of the bucket they fall in"; since M6.5 the observer computes small populations exactly
// and marks bucket-read ones, which the figures say "about". The footnote now says the same.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./_load.mjs";

const Fmt = await import("../src/analytics/model/format.ts");
const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("Flow's visit-duration footnote states both percentile bases, as the figures word them", () => {
  const flow = src("analytics/ui/areas/Flow.tsx");
  assert.doesNotMatch(flow, /as the upper edge of the bucket they fall in/);
  assert.match(flow, /Percentiles marked “about” are read inside the observer's buckets; the others are exact, over every measured visit\./);
  // The footnote's promise: a bucket-read percentile is said "about", an exact one is not.
  assert.match(Fmt.p50Text({ p50_ms: 8_192_000, percentile_basis: "histogram" }), /^about /);
  assert.doesNotMatch(Fmt.p50Text({ p50_ms: 8_192_000, percentile_basis: "exact" }), /about/);
  assert.match(Fmt.p90Text({ p90_ms: 16_384_000, percentile_basis: "histogram" }), /^about /);
});
