// A project with something on every screen, built through the real engine (the terminal path) and
// the stand-in gh: an approved and a proposed epic, a slice marked ready that the builders took,
// one edited on GitHub after it was approved, one someone else saved a newer version of, a paused
// slice with open questions, and a fresh draft.
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
  const drafted = (id, title, spec = specFor(id)) => {
    ok("slice", "new", "--epic", "EPIC-001", "--title", title);
    write(`specs/slices/${id}-invite-teammate.md`, spec);
    write(`product/intents/${id}.md`, whyFor(id));
  };
  ok("project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together without friction.", "--outcome", "Teams can work together", "--outcome", "Admins stay in control of who has access");
  ok("epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join", "--criterion", "Admins can see who is invited");
  ok("epic", "approve", "EPIC-001");
  // Marked ready, and taken by the builders.
  drafted("SLICE-001", "Invite a teammate");
  const building = ok("slice", "ready", "SLICE-001").issue;
  world.setStateLabel(building, "mach:building");
  // Marked ready, then edited on GitHub by someone else.
  drafted("SLICE-002", "Resend an invitation");
  const edited = ok("slice", "ready", "SLICE-002").issue;
  world.onGithub(`issue = state["issues"][str(args[0])]
issue["body"] = issue["body"].replace("An admin", "Anyone")`, edited);
  // Marked ready, reopened here, and saved again by someone else in the meantime.
  drafted("SLICE-003", "Rename a teammate");
  const newer = ok("slice", "ready", "SLICE-003").issue;
  ok("slice", "reopen", "SLICE-003");
  world.newerVersion(newer, "\nChanged by Ben.\n");
  // Paused in the interview, with open questions.
  drafted("SLICE-004", "Remove a teammate", specFor("SLICE-004").replace("## Open questions\n\n- None.", OPEN_QUESTIONS));
  ok("slice", "check", "SLICE-004");
  ok("slice", "pause", "SLICE-004", "--note", "Settled who may remove a teammate. Next: does access end at once or at the end of the billing period?");
  // A second epic, not yet approved, with a fresh draft.
  ok("epic", "add", "--title", "Workspace settings", "--criterion", "Admins can rename the workspace");
  ok("slice", "new", "--epic", "EPIC-002", "--title", "Rename the workspace");
  ok("refresh");
  const status = ok("status");
  const github = Object.fromEntries(status.slices.map((s) => [s.slice_id, s.github]));
  if (github["SLICE-001"].state_label !== "mach:building" || !github["SLICE-002"].changed_on_github || !github["SLICE-003"].newer_elsewhere) {
    throw new Error(`the seed is missing a state: ${JSON.stringify(github)}`);
  }
  return {
    routes: ["/", "/vision", "/roadmap", "/slices/SLICE-001", "/slices/SLICE-004", "/slices/SLICE-005", "/slices/SLICE-004/interview", "/inbox", "/github", "/no-such-screen"],
  };
}
