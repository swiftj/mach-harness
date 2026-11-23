#!/usr/bin/env python3
"""Regenerate the fixtures in this folder from the real Product Studio engine.

Every file here is the exact JSON studio.py printed in a real scenario (a local bare repository
reached through a github.com address, and the stand-in for gh from
tests/test_mach_product_issues.py, which keeps issues, labels and comments in a file), with
temporary paths replaced by /project. Nothing is invented, so the web application is developed
and tested against what the engine really returns.

The engine runs with --app, as the local host runs it, so the wording is the app's: no terminal
commands. A refusal's structured hint, when the engine gives one, is kept under "hint".

Run from the repository root:  python3 web/fixtures/generate.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "ticket" / "scripts"))
import issue_rules  # noqa: E402
from test_mach_product_issues import IssuesBase, intent_for, spec_for  # noqa: E402

OUT = Path(__file__).resolve().parent

OPEN_QUESTIONS = ("## Open questions\n\n- Does a removed teammate keep access until the end of the billing period? Follow up: ask Finance.\n"
                  "- Can an admin remove themselves? Follow up: ask the product owner.")


class Scenario(IssuesBase):
    def runTest(self):  # pragma: no cover - driven by hand below
        pass

    def save(self, name, data):
        text = json.dumps(data, indent=2, ensure_ascii=False).replace(str(self.root), "/project-root").replace("/project-root/a", "/project").replace("/project-root/b", "/project")
        (OUT / f"{name}.json").write_text(text + "\n")

    def capture(self, name, *argv, project=None):
        code, out, err = self.run_studio(project or self.a, "--app", *argv)
        data = json.loads(out) if out.strip().startswith("{") else None
        hint, lines = None, err.strip().splitlines()
        if lines and lines[0].startswith("refused-hint: "):
            hint, lines = json.loads(lines[0][len("refused-hint: "):]), lines[1:]
        refused = "\n".join(lines).replace("refused: ", "", 1).strip() if code and lines else None
        self.save(name, {"exit_code": code, "data": data, "refused": refused, "hint": hint})
        return data

    def artifact_id(self, title):
        """The slice ID the engine allocated for a title (IDs skip numbers a spec reserves)."""
        return [p.stem for p in sorted(self.draft(self.a, "product/slices").glob("SLICE-*.json")) if json.loads(p.read_text()).get("title") == title][-1]

    def factory_says(self, number, moment, question=None):
        """What the Factory writes on a slice's issue (the ticket station's own template), dated by the stand-in's clock."""
        state = self.gh()
        issue = state["issues"][str(number)]
        marker = issue_rules.parse_slice_body(issue["body"])
        body = issue_rules.comment(moment, [f"{marker['slice_id']}@r{marker['revision']}"], "0" * 32, question=question)["body"]
        state["clock"] = state.get("clock", 0) + 3600
        at = "2026-11-17T%02d:%02d:%02dZ" % (10 + state["clock"] // 3600, (state["clock"] // 60) % 60, state["clock"] % 60)
        issue["comments"].append({"login": "erin-eng", "body": body, "created_at": at, "updated_at": at})
        issue["labels"] = [{"name": "mach:slice"}, {"name": {"building": "mach:building", "question": "mach:question", "shipped": "mach:shipped"}[moment]}]
        if moment == "shipped":
            issue["state"] = "CLOSED"
        self.gh_state.write_text(json.dumps(state))


def main():
    import needs_memory  # noqa: E402  (beside this file)
    import small_memory  # noqa: E402  (beside this file)
    import start_memory  # noqa: E402  (beside this file)
    import team_memory  # noqa: E402  (beside this file)
    only = {"needs": needs_memory, "small": small_memory, "start": start_memory, "team": team_memory}
    if len(sys.argv) == 3 and sys.argv[1] == "--only" and sys.argv[2] in only:
        # M17 and M18: write only one milestone's fixtures, leaving the others as they are (a full run changes only times
        # and paths in them).
        before = {p: p.read_bytes() for p in OUT.glob("*.json")}
        only[sys.argv[2]].generate(Scenario, OUT)
        written = [p for p in OUT.glob("*.json") if before.get(p) != p.read_bytes()]
        print("wrote", len(written), "fixtures to", OUT)
        return
    if sys.argv[1:] == ["--only", "small-change"]:
        # M18: write only Shape's small-change fixtures, leaving the others as they are.
        import product_memory  # noqa: E402  (beside this file)
        before = set(OUT.glob("*.json"))
        product_memory.shape_small_change(Scenario)
        print("wrote", len(set(OUT.glob("*.json")) - before), "new fixtures to", OUT)
        return
    for name in OUT.glob("*.json"):
        name.unlink()
    on_github()
    builders_question()
    someone_elses()
    someone_elses_refused()
    without_gh()
    # M15: what M13 and M14 added to the engine, for the screens built on them.
    import product_memory  # noqa: E402  (beside this file)
    product_memory.generate(Scenario, OUT)
    # M17: technical needs and a design the team already has.
    needs_memory.generate(Scenario, OUT)
    # M18: a small change.
    small_memory.generate(Scenario, OUT)
    # M19: starting a project from nothing.
    start_memory.generate(Scenario, OUT)
    # M20: several product managers sharing one repository.
    team_memory.generate(Scenario, OUT)
    print("wrote", len(list(OUT.glob("*.json"))), "fixtures to", OUT)


def on_github():
    """One product manager's project on GitHub, from nothing to slices in every state the engine reports."""
    s = Scenario()
    s.setUp()
    try:
        s.capture("status.empty", "status")
        s.capture("where", "where")
        s.capture("project.init", "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together without friction.",
                  "--outcome", "Teams can work together", "--outcome", "Admins stay in control of who has access")
        s.capture("epic.add", "epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join", "--criterion", "Admins can see who is invited")
        s.capture("status.project-and-epic", "status")
        s.capture("slice.new", "slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate")
        s.capture("slice.ready.refused-no-spec", "slice", "ready", "SLICE-001")
        s.capture("slice.resume.no-spec", "slice", "resume", "SLICE-001")
        s.write_slice(s.a, "SLICE-001")
        s.capture("slice.pause", "slice", "pause", "SLICE-001", "--note", "Settled who may invite and the seat limit. Next: do invitations expire?")
        s.capture("slice.check.ready", "slice", "check", "SLICE-001")
        s.capture("slice.resume.ready", "slice", "resume", "SLICE-001")
        s.capture("slice.show.ready", "slice", "show", "SLICE-001")
        s.capture("status.slice-ready", "status")
        first = s.capture("slice.ready", "slice", "ready", "SLICE-001")["issue"]
        s.capture("slice.show.on-github", "slice", "show", "SLICE-001")
        s.capture("status.on-github", "status")
        s.capture("refresh.on-github", "refresh")

        # A slice that needs the first, marked ready, then a question from the builders.
        s.capture("slice.new.with-dependency", "slice", "new", "--epic", "EPIC-001", "--title", "Remove a teammate", "--depends-on", "SLICE-001")
        remove = s.artifact_id("Remove a teammate")
        s.write_slice(s.a, remove)
        s.capture("status.with-dependency", "status")
        second = s.ok(s.a, "slice", "ready", remove)["issue"]

        # Two more slices marked ready: one ships, one is edited on GitHub after approval.
        resend = s.drafted(title="Resend an invitation")
        third = s.ok(s.a, "slice", "ready", resend)["issue"]
        rename = s.drafted(title="Rename a teammate")
        fourth = s.ok(s.a, "slice", "ready", rename)["issue"]

        # The builders take the first, ask about the second, ship the third; someone edits the fourth.
        s.factory_says(first, "building")
        s.factory_says(second, "question", QUESTION)
        s.factory_says(third, "building")
        s.factory_says(third, "shipped")
        s.change_issue(fourth, body=s.issue(fourth)["body"].replace("An admin", "Anyone"))
        s.capture("refresh.states", "refresh")
        s.capture("status.states", "status")

        # Reopening a slice the builders have started.
        s.capture("slice.reopen", "slice", "reopen", "SLICE-001")
        s.capture("status.after-reopen", "status")
        s.write_slice(s.a, "SLICE-001", extra="\nA clarification.\n")
        s.ok(s.a, "slice", "ready", "SLICE-001")

        # Someone else saves a newer version of the fourth while it is reopened here.
        s.ok(s.a, "slice", "reopen", rename)
        marker = issue_rules.parse_slice_body(s.issue(fourth)["body"])
        spec = spec_for(rename) + "\nChanged by Ben.\n"
        newer = issue_rules.slice_issue_body(rename, marker["revision"] + 1, marker["epic"], [], intent_for(rename), spec)
        approval = issue_rules.approval_comment(rename, marker["revision"] + 1, "ben-pm", issue_rules.text_sha256_of(spec), issue_rules.text_sha256_of(intent_for(rename)))
        s.change_issue(fourth, body=newer, comments=[*s.issue(fourth)["comments"], {"login": "ben-pm", "body": approval}])
        s.capture("refresh.newer-elsewhere", "refresh")
        s.capture("status.newer-elsewhere", "status")
        s.capture("slice.ready.refused-newer-elsewhere", "slice", "ready", rename)
        s.capture("reconcile.theirs", "reconcile", rename, "--take", "theirs")

        # A draft whose number another slice on GitHub already uses.
        taken = s.drafted(title="Invite by link")
        state = s.gh()
        other = issue_rules.slice_issue_body(taken, 1, 1, [], intent_for(taken), spec_for(taken))
        state["issues"]["77"] = {"number": 77, "id": 9077, "title": "Someone else's slice", "body": other, "state": "OPEN", "labels": [{"name": "mach:slice"}],
                                 "comments": [], "events": [], "sub_issues": [], "author": {"login": "ben-pm"}, "updatedAt": "2026-11-10T09:00:00Z"}
        s.gh_state.write_text(json.dumps(state))
        s.capture("refresh.number-taken", "refresh")
        s.capture("status.number-taken", "status")
        s.capture("slice.ready.refused-number-taken", "slice", "ready", taken)
        s.capture("slice.renumber", "slice", "renumber", taken)

        # A draft with open questions, then with validator errors; a second epic.
        open_slice = s.ok(s.a, "slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate by email")["slice"]["slice_id"]
        s.write_slice(s.a, open_slice)
        spec_file = s.draft(s.a, f"specs/slices/{open_slice}-invite-teammate.md")
        spec_file.write_text(spec_file.read_text().replace("## Open questions\n\n- None.", OPEN_QUESTIONS))
        s.capture("slice.check.open-questions", "slice", "check", open_slice)
        s.capture("slice.show.open-questions", "slice", "show", open_slice)
        s.capture("slice.ready.refused-open-questions", "slice", "ready", open_slice)
        text = spec_file.read_text()
        spec_file.write_text(text[:text.index("## Invariants")] + text[text.index("## Functional requirements"):])
        s.capture("slice.check.errors", "slice", "check", open_slice)
        s.capture("slice.show.errors", "slice", "show", open_slice)
        spec_file.write_text(text)
        s.ok(s.a, "slice", "check", open_slice)
        s.ok(s.a, "epic", "add", "--title", "Workspace settings", "--criterion", "Admins can rename the workspace")
        s.ok(s.a, "slice", "new", "--epic", "EPIC-002", "--title", "Rename the workspace")
        s.capture("validate", "validate")
        s.capture("refresh.rich", "refresh")
        s.capture("status.rich", "status")
        s.capture("slice.move", "slice", "move", resend, "--before", remove)
        s.capture("slice.move.refused-other-epic", "slice", "move", resend, "--before", "SLICE-008")
        s.capture("status.moved", "status")
        s.lose("api PATCH priority")
        s.ok(s.a, "refresh")
        s.capture("slice.move.refused-interrupted", "slice", "move", resend, "--first")
        s.capture("status.move-unfinished", "status")
        s.capture("slice.move.finished", "slice", "move", resend, "--first")

        # Saving stops part way: the slice is approved, and marking it ready again finishes the job.
        interrupted = s.drafted(title="Invite with a message")
        s.lose("api POST sub_issues")
        s.capture("slice.ready.refused-interrupted", "slice", "ready", interrupted)
        s.capture("status.finish-ready", "status")

        # GitHub cannot be reached.
        s.gh_fails("*", once=False)
        s.capture("refresh.offline", "refresh")
        s.capture("status.offline", "status")
    finally:
        s.doCleanups()


QUESTION = "FR-02 says a pending invitation holds a seat, but INV-03 says only accepted members count against the seat limit. Which one wins?"


def builders_question():
    """The builders ask a question about a slice; the product manager reopens it and the interview starts from it."""
    s = Scenario()
    s.setUp()
    try:
        s.project_and_epic()
        s.drafted()
        number = s.ready()["issue"]
        s.factory_says(number, "question", QUESTION)
        s.capture("refresh.question", "refresh")
        s.capture("status.question", "status")
        s.capture("slice.show.question", "slice", "show", "SLICE-001")
        s.capture("slice.reopen.question", "slice", "reopen", "SLICE-001")
        s.capture("slice.resume.question", "slice", "resume", "SLICE-001")
    finally:
        s.doCleanups()


def someone_elses():
    """Ben's workspace has the project; Ada saved a slice he does not have. Refresh lists it as on GitHub only, and he opens it here."""
    s = Scenario()
    s.setUp()
    try:
        s.project_and_epic()
        s.drafted()
        s.ready()
        s.ok(s.b, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together.", "--outcome", "Teams can work together")
        s.capture("refresh.elsewhere", "refresh", project=s.b)
        s.capture("status.elsewhere", "status", project=s.b)
        s.capture("slice.take", "slice", "take", "3", project=s.b)
        s.capture("slice.take.again", "slice", "take", "SLICE-001", project=s.b)
        s.capture("status.after-take", "status", project=s.b)
    finally:
        s.doCleanups()


def someone_elses_refused():
    """Ben already has a different EPIC-001, so Ada's slice under hers cannot be opened until he renumbers his."""
    s = Scenario()
    s.setUp()
    try:
        s.project_and_epic()
        s.drafted()
        s.ready()
        s.ok(s.b, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together.", "--outcome", "Teams can work together")
        s.ok(s.b, "epic", "add", "--title", "Billing", "--criterion", "Invoices are sent")
        s.ok(s.b, "refresh")
        s.capture("slice.take.refused-epic", "slice", "take", "3", project=s.b)
    finally:
        s.doCleanups()


def without_gh():
    """No GitHub tool on this computer: a slice marked ready is written to the ready folder."""
    s = Scenario()
    s.setUp()
    try:
        state = s.gh()
        state["signed_in"] = False
        s.gh_state.write_text(json.dumps(state))
        s.project_and_epic()
        s.drafted()
        s.capture("slice.ready.folder", "slice", "ready", "SLICE-001")
        s.capture("status.folder", "status")
        s.capture("slice.reopen.folder", "slice", "reopen", "SLICE-001")
    finally:
        s.doCleanups()


if __name__ == "__main__":
    main()
