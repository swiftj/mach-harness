"""Fixtures for M19 in the app: starting a project from nothing, every way the start screen offers.

Called by generate.py (python3 web/fixtures/generate.py, or --only start to write just these). Each scenario drives the
real engine with --app in an empty project (no project, no epic), in the same throwaway repositories and stand-in for gh
as the engine's own tests, and saves exactly what it printed. Nothing is invented: what a PRD's map, a settlement or an
idea does before the project is named is what the engine answered here.

The states, with the parameter that reaches each in fixture mode, are listed in src/dev/startTransport.ts.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))

from test_mach_product_prd import PRD_TEXT  # noqa: E402

# A map that names only new epics: in an empty project there is no EPIC-NNN to name.
START_MAP = {
    "epics": [{"key": "E1", "title": "Workspace members", "criteria": ["Only invited people join"]}],
    "slices": [
        {"key": "M1", "title": "Invite a teammate", "scope": "An admin invites one teammate by email.", "epic": "E1", "depends_on": [], "cites": ["5-9"]},
        {"key": "M2", "title": "Remove a member", "scope": "An admin removes one member.", "epic": "E1", "depends_on": ["M1"], "cites": ["11-14"]},
    ],
}


def generate(Scenario, out: Path) -> None:
    from_nothing(Scenario)
    from_an_idea(Scenario)
    from_a_request(Scenario)


def from_an_idea(Scenario):
    """Only an idea, added before the product is named: where the person is after choosing to shape an idea first."""
    s = start_scenario(Scenario)()
    s.setUp()
    try:
        s.ok(s.a, "idea", "add", "Let members renew a loan themselves")
        s.capture("status.start-idea", "status")
    finally:
        s.doCleanups()


def from_a_request(Scenario):
    """A request someone filed on GitHub, read by a refresh before any project exists, then picked up once the product is
    named and has an epic: the order the start screen's way from a request takes."""
    from test_mach_requests import RequestBase, labeled  # noqa: E402

    class RequestScenario(RequestBase):
        def runTest(self):  # pragma: no cover
            pass
        save = Scenario.save
        capture = Scenario.capture

    s = RequestScenario()
    s.setUp()
    try:
        s.add_issue(41, "Let admins see who has not accepted an invitation yet", "Admins keep asking who still has to join.",
                    events=[labeled("erin-eng", 2001)])
        s.capture("refresh.start-requests", "refresh")
        s.capture("request.list.start", "request", "list")
        s.capture("status.start-requests", "status")
        s.ok(s.a, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together without friction.",
             "--outcome", "Teams can work together")
        s.capture("status.start-request-named", "status")
        s.capture("epic.add.start", "epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join")
        s.capture("status.start-request-epic", "status")
        s.capture("request.pick.start", "request", "pick", "42", "--epic", "EPIC-001", "--title", "Invite a teammate by email")
        s.capture("status.start-request-picked", "status")
    finally:
        s.doCleanups()


def start_scenario(Scenario):
    """Shape's own test base (it can leave a request cache as a refresh does), with the fixtures' save and capture."""
    from test_mach_shape import ShapeBase  # noqa: E402

    class StartScenario(ShapeBase):
        def runTest(self):  # pragma: no cover
            pass
        save = Scenario.save
        capture = Scenario.capture

    return StartScenario


def from_nothing(Scenario):
    s = start_scenario(Scenario)()
    s.setUp()
    try:
        files = s.root / "files"
        files.mkdir()
        document = files / "team-space.md"
        document.write_text(PRD_TEXT, encoding="utf-8")
        (files / "map.json").write_text(json.dumps(START_MAP))
        # Nothing yet: the start screen.
        s.capture("status.start-empty", "status")
        s.capture("prd.list.start-empty", "prd", "list")
        s.capture("idea.list.start-empty", "idea", "list")
        s.capture("refresh.start-empty", "refresh")
        s.capture("request.list.start-empty", "request", "list")
        # From a PRD: imported, mapped and settled before the product is named.
        s.capture("prd.import.start", "prd", "import", str(document))
        s.capture("prd.list.start", "prd", "list")
        s.capture("prd.show.start", "prd", "show", "PRD-01")
        s.capture("prd.status.start-no-map", "prd", "status", "PRD-01")
        s.capture("status.start-prd-imported", "status")
        s.capture("prd.map.start", "prd", "map", "PRD-01", "--from", str(files / "map.json"))
        waiting = s.capture("prd.status.start-mapped", "prd", "status", "PRD-01")["not_covered"]
        s.capture("status.start-prd-mapped", "status")
        s.capture("prd.settle.start", "prd", "settle", "PRD-01", "--section", str(waiting[0]), "--as", "slice:M1", "--reason", "The opening belongs to inviting.")
        for section in waiting[1:-1]:
            s.ok(s.a, "prd", "settle", "PRD-01", "--section", str(section), "--as", "later", "--reason", "Not this quarter.")
        s.capture("prd.status.start-one-left", "prd", "status", "PRD-01")
        s.capture("prd.settle.start-last", "prd", "settle", "PRD-01", "--section", str(waiting[-1]), "--as", "out-of-scope", "--reason", "Billing is the finance team's.")
        s.capture("prd.status.start-settled", "prd", "status", "PRD-01")
        s.capture("prd.apply.refused-no-project", "prd", "apply", "PRD-01")
        s.capture("status.start-prd-settled", "status")
        # Shape an idea first: added before the product is named.
        s.capture("idea.add.start", "idea", "add", "Let members renew a loan themselves")
        s.capture("idea.list.start", "idea", "list")
        s.capture("status.start-prd-and-idea", "status")
        # The product named by the person, then the drafts made.
        s.capture("project.init.start", "project", "init", "--id", "team-space", "--name", "Team Space", "--vision",
                  "Teams work together without friction.", "--outcome", "Teams can work together", "--outcome", "Admins stay in control of who has access")
        s.capture("status.start-prd-named", "status")
        s.capture("prd.apply.start", "prd", "apply", "PRD-01")
        s.capture("prd.status.start-applied", "prd", "status", "PRD-01")
        s.capture("status.start-made", "status")
    finally:
        s.doCleanups()
