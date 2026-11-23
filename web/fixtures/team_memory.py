"""Fixtures for M20 A3 and A4 in the app: several product managers sharing one GitHub repository.

Called by generate.py (python3 web/fixtures/generate.py, or --only team to write just these). Each scenario drives the real
engine with --app on two product managers' clones (Ada's `a`, Ben's `b`) of one repository, with the same stand-in for gh
and the same way of standing in for "at the same moment" as tests/test_team_studio.py, and saves exactly what it printed.
Every file is named `<operation>.team-<state>.json`.

The states, with the address that reaches each in fixture mode, are listed in src/dev/teamTransport.ts.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))


def team_scenario(Scenario):
    """The team tests' own base (two product managers, one repository) with the fixtures' save and capture."""
    from test_team_studio import TwoProductManagers

    class TeamScenario(TwoProductManagers):
        def runTest(self):  # pragma: no cover
            pass
        save = Scenario.save
        capture = Scenario.capture

    return TeamScenario


def run(Scenario, body):
    s = team_scenario(Scenario)()
    s.setUp()
    try:
        body(s)
    finally:
        s.doCleanups()


def generate(Scenario, out: Path) -> None:
    run(Scenario, slice_same_moment)
    run(Scenario, slice_twice)
    run(Scenario, slice_twice_builders)
    run(Scenario, epic_same_moment)
    run(Scenario, text_taken_at_ready)
    run(Scenario, text_taken_at_refresh)
    run(Scenario, lambda s: project_changed(s, "mine"))
    run(Scenario, lambda s: project_changed(s, "theirs"))
    run(Scenario, project_unreadable)
    run(Scenario, lambda s: epic_changed(s, "theirs"))
    run(Scenario, lambda s: epic_changed(s, "mine"))
    run(Scenario, project_taken)
    run(Scenario, project_not_checked)
    run(Scenario, several_projects)
    run(Scenario, prd_numbers)
    idea_numbers(Scenario)


def slice_same_moment(s):
    """Ada and Ben mark SLICE-001 ready at the same moment. Ben's is refused (renumber_slice); he renumbers and marks it ready."""
    ada_issue = s.ada_ships_first_slice()
    ben = s.ben_starts_the_same_project()
    s.drafted(ben, title="Remove a teammate")
    with s.hidden({ada_issue}):
        s.capture("slice.ready.team-same-moment", "slice", "ready", "SLICE-001", project=ben)
    s.capture("status.team-same-moment", "status", project=ben)
    s.capture("refresh.team-same-moment", "refresh", project=ben)
    s.capture("slice.show.team-same-moment", "slice", "show", "SLICE-001", project=ben)
    s.capture("slice.renumber.team-same-moment", "slice", "renumber", "SLICE-001", project=ben)
    s.capture("status.team-renumbered", "status", project=ben)
    s.capture("slice.show.team-renumbered", "slice", "show", "SLICE-002", project=ben)
    s.capture("slice.ready.team-renumbered", "slice", "ready", "SLICE-002", project=ben)
    s.capture("status.team-renumbered-ready", "status", project=ben)


def slice_twice(s):
    """The look-again missed it: two open issues hold SLICE-001. Ada's refresh says hers is kept; Ben's closes his."""
    ada_issue = s.ada_ships_first_slice()
    ben = s.ben_starts_the_same_project()
    s.drafted(ben, title="Remove a teammate")
    with s.hidden({ada_issue}), s.look_again_missed():
        s.ready("SLICE-001", ben)
    s.ada()
    s.capture("refresh.team-twice-kept", "refresh", project=s.a)
    s.capture("status.team-twice-kept", "status", project=s.a)
    s.ben()
    s.capture("refresh.team-twice-closed", "refresh", project=ben)
    s.capture("status.team-twice-closed", "status", project=ben)
    s.capture("slice.show.team-twice-closed", "slice", "show", "SLICE-001", project=ben)


def slice_twice_builders(s):
    """Missed at ready, and the builders already took Ben's issue: his refresh says so and leaves it alone."""
    ada_issue = s.ada_ships_first_slice()
    ben = s.ben_starts_the_same_project()
    s.drafted(ben, title="Remove a teammate")
    with s.hidden({ada_issue}), s.look_again_missed():
        ben_issue = s.ready("SLICE-001", ben)["issue"]
    s.change_issue(ben_issue, labels=s.issue(ben_issue)["labels"] + [{"name": "mach:building"}])
    s.ben()
    s.capture("refresh.team-twice-builders", "refresh", project=ben)
    s.capture("status.team-twice-builders", "status", project=ben)


def epic_same_moment(s):
    """Ben's EPIC-001 ("Billing") is made a moment after Ada's ("Team membership"): refused (renumber_epic), renumbered, ready."""
    s.ada_ships_first_slice()
    ada_epic = s.issues("mach:epic")[0]["number"]
    ben = s.ben()
    s.ok(ben, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "x", "--outcome", "y")
    s.ok(ben, "epic", "add", "--title", "Billing", "--criterion", "Invoices are sent")
    s.drafted(ben, title="Send an invoice")
    s.ok(ben, "slice", "renumber", "SLICE-001")
    with s.hidden({ada_epic}):
        s.capture("slice.ready.team-epic-same-moment", "slice", "ready", "SLICE-002", project=ben)
    s.capture("status.team-epic-same-moment", "status", project=ben)
    s.capture("refresh.team-epic-same-moment", "refresh", project=ben)
    s.capture("slice.show.team-epic-same-moment", "slice", "show", "SLICE-002", project=ben)
    s.capture("epic.renumber.team-epic-same-moment", "epic", "renumber", "EPIC-001", project=ben)
    s.capture("status.team-epic-renumbered", "status", project=ben)
    s.capture("slice.ready.team-epic-renumbered", "slice", "ready", "SLICE-002", project=ben)


def text_taken_at_ready(s):
    """Ben defined the project with his own vision before Ada's issue existed; marking his slice ready takes hers instead."""
    s.project_and_epic(s.ada())
    s.drafted(s.a)
    ben = s.ben_starts_the_same_project(vision="A different vision Ben typed.", criterion="Anyone with the link can join")
    s.ready("SLICE-001", s.ada())
    s.drafted(ben, title="Remove a teammate")
    s.ok(s.ben(), "slice", "renumber", "SLICE-001")
    s.capture("slice.ready.team-text-taken", "slice", "ready", "SLICE-002", project=ben)
    s.capture("status.team-text-taken", "status", project=ben)


def text_taken_at_refresh(s):
    """Ada changes EPIC-001's criteria; Ben has nothing of his own unwritten, so his refresh takes hers."""
    s.ada_ships_first_slice()
    ben = s.ben_starts_the_same_project()
    s.ok(ben, "refresh")
    s.ok(s.ada(), "epic", "set", "EPIC-001", "--criterion", "Only invited people can join", "--criterion", "An invitation can be withdrawn")
    s.ready("SLICE-001", s.a)
    s.ben()
    s.capture("refresh.team-text-taken", "refresh", project=ben)
    s.capture("status.team-text-taken-refresh", "status", project=ben)


def project_changed(s, take):
    """Ada and Ben both change the project's vision; Ada's reaches GitHub first. Ben chooses."""
    s.ada_ships_first_slice()
    ben = s.ben_starts_the_same_project()
    s.ok(s.ada(), "project", "set", "--vision", "Teams of any size work together.")
    s.ready("SLICE-001", s.a)
    s.ok(s.ben(), "project", "set", "--vision", "Small teams work together.")
    if take == "mine":
        s.capture("refresh.team-project-changed", "refresh", project=ben)
        s.capture("status.team-project-changed", "status", project=ben)
        s.drafted(ben, title="Remove a teammate")
        s.capture("slice.ready.team-text-changed", "slice", "ready", "SLICE-002", project=ben)
    else:
        s.ok(ben, "refresh")
    s.capture(f"reconcile.team-project-{take}", "reconcile", "project", "--take", take, project=ben)
    s.capture(f"status.team-project-{take}", "status", project=ben)


def project_unreadable(s):
    """Both changed the project, and the other change was made by hand on GitHub, not in MACH's form: theirs cannot be shown."""
    s.ada_ships_first_slice()
    project_issue = s.issues("mach:project")[0]["number"]
    ben = s.ben_starts_the_same_project()
    s.ok(s.ben(), "project", "set", "--vision", "Small teams work together.")
    # MACH's marker is kept (it is still the project's issue); the vision gained a second paragraph, which is not MACH's form.
    s.change_issue(project_issue, body="<!-- mach:project id=team-space -->\n## Vision\nTeams work together.\n"
                                       "Edited by hand on GitHub: we agree the rest on Friday.\n\n## Outcomes\n- Teams can work together\n")
    s.capture("refresh.team-project-unreadable", "refresh", project=ben)
    s.capture("status.team-project-unreadable", "status", project=ben)
    s.capture("reconcile.team-project-theirs-refused", "reconcile", "project", "--take", "theirs", project=ben)


def epic_changed(s, take):
    """The same for EPIC-001's criteria."""
    s.ada_ships_first_slice()
    ben = s.ben_starts_the_same_project()
    s.ok(ben, "refresh")
    s.ok(s.ada(), "epic", "set", "EPIC-001", "--criterion", "Only invited people can join", "--criterion", "An invitation can be withdrawn")
    s.ready("SLICE-001", s.a)
    s.ok(s.ben(), "epic", "set", "EPIC-001", "--criterion", "Only admins invite")
    if take == "theirs":
        s.capture("refresh.team-epic-changed", "refresh", project=ben)
        s.capture("status.team-epic-changed", "status", project=ben)
    else:
        s.ok(ben, "refresh")
    s.capture(f"reconcile.team-epic-{take}", "reconcile", "EPIC-001", "--take", take, project=ben)
    s.capture(f"status.team-epic-{take}", "status", project=ben)


def project_taken(s):
    """Ben names the product in his own words; the repository already has Ada's project, so MACH takes hers."""
    s.ada_ships_first_slice()
    ben = s.ben()
    s.capture("status.team-start", "status", project=ben)
    s.capture("project.init.team-taken", "project", "init", "--id", "teamspace", "--name", "Teamspace", "--vision", "Mine.",
              "--outcome", "Mine too", project=ben)
    s.capture("status.team-taken", "status", project=ben)


def project_not_checked(s):
    """GitHub cannot be read when the product is named: it is defined from the person's words, and they are told."""
    ben = s.ben()
    s.gh_fails("issue list", once=False)
    s.capture("project.init.team-not-checked", "project", "init", "--id", "team-space", "--name", "Team Space",
              "--vision", "Teams work together.", "--outcome", "Teams can work together", project=ben)


def several_projects(s):
    """Two open project issues: naming the product and marking ready are refused, naming both; refresh reports them."""
    s.ada_ships_first_slice()
    s.second_project_issue()
    s.ben()
    s.capture("refresh.team-several-start", "refresh", project=s.b)
    s.capture("status.team-several-start", "status", project=s.b)
    s.capture("project.init.team-several", "project", "init", "--id", "team-space", "--name", "x", "--vision", "y", "--outcome", "z", project=s.b)
    s.drafted(s.ada(), title="Remove a teammate")
    s.capture("slice.ready.team-several", "slice", "ready", "SLICE-002", project=s.a)
    s.capture("refresh.team-several", "refresh", project=s.a)
    s.capture("status.team-several", "status", project=s.a)


def prd_numbers(s):
    """Ben makes a PRD's drafts: once with GitHub read first, once when GitHub could not be read."""
    import test_mach_product_prd as prd_tests  # noqa: E402

    s.ada_ships_first_slice()
    ben = s.ben()
    s.ok(ben, "project", "init", "--id", "team-space", "--name", "x", "--vision", "y", "--outcome", "z")
    prd_file = s.root / "team-space.md"
    prd_file.write_text(prd_tests.PRD_TEXT, encoding="utf-8")
    map_file = s.root / "map.json"
    map_file.write_text(json.dumps(prd_tests.MAP), encoding="utf-8")
    s.ok(ben, "prd", "import", str(prd_file))
    s.ok(ben, "prd", "map", "PRD-01", "--from", str(map_file))
    s.ok(ben, "prd", "settle", "PRD-01", "--section", "1", "--as", "slice:M1")
    s.ok(ben, "prd", "settle", "PRD-01", "--section", "4", "--as", "out-of-scope", "--reason", "Billing belongs to the finance team.")
    s.ok(ben, "prd", "settle", "PRD-01", "--section", "5", "--as", "later")
    s.capture("prd.status.team-settled", "prd", "status", "PRD-01", project=ben)
    s.gh_fails("issue list", once=False)
    s.capture("prd.apply.team-not-checked", "prd", "apply", "PRD-01", project=ben)
    s.capture("prd.status.team-not-checked", "prd", "status", "PRD-01", project=ben)


def idea_numbers(Scenario):
    """An idea's drafts made while GitHub could not be read."""
    import product_memory  # noqa: E402  (beside this file)
    from test_mach_shape_route import SEVERAL

    def body(s):
        s.project_and_epic()
        s.sized(SEVERAL)
        s.record_map(s.several_map())
        s.gh_fails("issue list", once=False)
        s.capture("idea.apply.team-not-checked", "idea", "apply", "IDEA-001")
    product_memory.run(product_memory.shape_scenario(Scenario), body)
