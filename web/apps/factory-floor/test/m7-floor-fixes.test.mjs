// M7 D6: the floor counted wave memberships as slices ("6 slices" for 5: SLICE-002 is in WAVE-001
// and WAVE-002). It now counts distinct slices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim } from "./_load.mjs";

test("the floor counts distinct slices, not wave memberships (M7 D6)", () => {
  const waves = {
    "WAVE-001": { sliceIds: ["SLICE-001", "SLICE-002"] },
    "WAVE-002": { sliceIds: ["SLICE-002"] },
    "WAVE-003": { sliceIds: ["SLICE-005", "SLICE-006", "SLICE-003"] },
  };
  assert.equal(sim.distinctSliceCount({ waves }), 5);
  assert.equal(sim.distinctSliceCount({ waves: {} }), 0);
});
