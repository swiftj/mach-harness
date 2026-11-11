// A complete, valid slice spec and why: the repository's own fixture, adapted the same way
// tests/test_mach_product_collab.py adapts it (and the stand-in claude writes it).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repo } from "./env.mjs";

export function specFor(sliceId) {
  const lines = readFileSync(join(repo, "tests/fixtures/SLICE-001-invite-teammate.md"), "utf8")
    .split("\n")
    .filter((line) => !line.includes("(Deferred to"));
  const at = lines.indexOf("### Out of scope") + 2;
  lines.splice(at, 0, "- None.");
  return lines.join("\n").replace(/\n+$/, "").replaceAll("SLICE-001", sliceId) + "\n";
}

export function whyFor(sliceId) {
  return `# Intent: Invite a teammate

- **Slice:** ${sliceId} at specs/slices/${sliceId}-invite-teammate.md
- **Status:** Ready for approval

## Why

- **Problem:** An admin cannot bring a colleague in.
- **Who it is for:** A workspace admin.
- **Success looks like:** The colleague receives an invitation.

## Goal ancestry

- **Goal:** Teams can work together
- **Epic:** EPIC-001: Team membership
- **Slice:** ${sliceId}: An admin invites one teammate.

## Constraints

- None.

## Risk

- **Tier:** High
- **Reason:** It grants access.

## Deferred work

- None.
`;
}
