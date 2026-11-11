// A project with something on every screen, built through the real engine (the terminal path):
// an approved and a proposed epic, an accepted wave, a sent wave with changes requested, a
// paused slice with open questions, a fresh draft slice, and a conflict waiting in Decisions.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { specFor, whyFor } from "./content.mjs";

const OPEN_QUESTIONS =
  "## Open questions\n\n- Does a removed teammate keep access until the end of the billing period? Follow up: ask Finance.\n- Can an admin remove themselves? Follow up: ask the product owner.";

export function seedRich(world) {
  const pm = world.pm;
  const ok = (...argv) => {
    const r = world.studio(pm, ...argv);
    if (r.code !== 0) throw new Error(`studio ${argv.join(" ")}: ${r.stderr}${r.stdout}`);
    return r.json;
  };
  const write = (rel, text) => {
    const path = join(pm, ".factory/studio/draft", rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  ok("project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together without friction.", "--outcome", "Teams can work together", "--outcome", "Admins stay in control of who has access");
  ok("epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join", "--criterion", "Admins can see who is invited");
  ok("epic", "approve", "EPIC-001");
  ok("slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate");
  write("specs/slices/SLICE-001-invite-teammate.md", specFor("SLICE-001"));
  write("product/intents/SLICE-001.md", whyFor("SLICE-001"));
  ok("slice", "approve", "SLICE-001");
  ok("wave", "new", "--slice", "SLICE-001");
  ok("wave", "approve", "WAVE-001");
  ok("send", "WAVE-001");
  world.land("product/WAVE-001");
  ok("refresh");
  // A second wave, sent, with changes requested and reviewers' words.
  ok("slice", "new", "--epic", "EPIC-001", "--title", "Resend an invitation");
  write("specs/slices/SLICE-002-invite-teammate.md", specFor("SLICE-002"));
  write("product/intents/SLICE-002.md", whyFor("SLICE-002"));
  ok("slice", "approve", "SLICE-002");
  ok("wave", "new", "--slice", "SLICE-002");
  ok("wave", "approve", "WAVE-002");
  ok("send", "WAVE-002");
  world.setPr(2, {
    reviewDecision: "CHANGES_REQUESTED",
    reviews: [{ author: { login: "erin" }, state: "CHANGES_REQUESTED", body: "What about expired invitations?" }],
    comments: [{ author: { login: "sam" }, body: "Can an admin invite someone who was removed last week?" }],
  });
  ok("epic", "add", "--title", "Workspace settings", "--criterion", "Admins can rename the workspace");
  ok("slice", "new", "--epic", "EPIC-001", "--title", "Remove a teammate");
  write("specs/slices/SLICE-003-remove-teammate.md", specFor("SLICE-003").replace("## Open questions\n\n- None.", OPEN_QUESTIONS));
  write("product/intents/SLICE-003.md", whyFor("SLICE-003"));
  ok("slice", "check", "SLICE-003");
  ok("slice", "pause", "SLICE-003", "--note", "Settled who may remove a teammate. Next: does access end at once or at the end of the billing period?");
  ok("slice", "new", "--epic", "EPIC-002", "--title", "Rename the workspace");
  // A conflict: the vision changed here and in the shared project.
  ok("project", "set", "--vision", "Teams work together, wherever they are.");
  world.upstream("product/project.json", 'd["vision"] = "Teams work together without friction, at any scale."');
  ok("refresh");
  const status = ok("status");
  if (!status.needs_reconciling.conflicts.length) throw new Error("the seed has no conflict");
  return {
    routes: [
      "/", "/vision", "/roadmap", "/slices/SLICE-001", "/slices/SLICE-003", "/slices/SLICE-004", "/slices/SLICE-003/interview",
      "/inbox", "/waves", "/waves/WAVE-002/send", "/waves/WAVE-002/review", "/waves/WAVE-001/review", "/shared", "/no-such-screen",
    ],
  };
}
