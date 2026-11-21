"""Fixtures for the M17 screens: technical needs and a design the team already has.

Called by generate.py (python3 web/fixtures/generate.py, or --only needs to write just these). Each scenario drives the
real engine with --app, in the same throwaway repositories and stand-in for gh as the engine's own tests
(tests/test_mach_technical_needs.py, tests/test_mach_product_design.py), and saves exactly what it printed. Nothing is
invented: an ADR behind a need is a real ADR committed with `serves: TN-01@1` after the need's second revision; a design's
map is recorded with `design map --from`, as the needs conversation records it.

The states, with the parameter that reaches each in fixture mode, are listed in docs/mach-next/M17_APP_FOUNDATION.md.
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))

from test_mach_product_design import DESIGN_TEXT, a_map  # noqa: E402
from test_mach_product_issues import git  # noqa: E402

PEOPLE = "About three hundred staff use it from two offices, busiest on Monday mornings."
DATA = "Invitations are kept at most one year; member names and email addresses are personal data."
CONNECTIONS = "Members sign in with the accounts the company already gives its staff."
PRIORITY = "When safety and speed of change conflict, safety wins."
GIVEN = "It runs on the company's PostgreSQL cluster."


def generate(Scenario, out: Path) -> None:
    needs_none_yet(Scenario)
    needs_several_kinds(Scenario)
    needs_published_with_an_adr_behind(Scenario)
    needs_newer_elsewhere(Scenario)
    design_states(Scenario)


def run(Scenario, body):
    s = Scenario()
    s.setUp()
    try:
        os.environ.pop("MACH_EXECUTION_ID", None)
        body(s)
    finally:
        s.doCleanups()


def add(s, kind, statement, why, *extra, name=None, project=None):
    argv = ("need", "add", "--kind", kind, "--statement", statement, "--why", why, *extra)
    return s.capture(name, *argv, project=project) if name else s.ok(project or s.a, *argv)


# ---- technical needs (M17 part A) ----

def needs_none_yet(Scenario):
    """A project that never opened Technical needs: every kind unanswered, nothing published; status has no needs field."""
    def body(s):
        s.project_and_epic()
        s.capture("need.list.empty", "need", "list")
        s.capture("status.needs-none", "status")
        s.capture("need.publish.refused-none", "need", "publish")
        s.capture("design.list.empty", "design", "list")
    run(Scenario, body)


def needs_several_kinds(Scenario):
    """Needs in several kinds, a given, one kind with nothing to say, published once and changed since (unpublished
    changes); the refusals the engine gives (technology words, a given without who said it, nothing to say about a kind
    that has a need, a retired need changed)."""
    def body(s):
        s.project_and_epic()
        add(s, "people", PEOPLE, "It sets how large it must be.", name="need.add")
        add(s, "data", DATA, "Privacy law.", name="need.add.data")
        s.capture("need.add.refused-technology", "need", "add", "--kind", "connections", "--statement", "It reads members from the company's Postgres database.",
                  "--why", "Staff already have accounts.")
        s.capture("need.add.refused-given-without-who", "need", "add", "--kind", "given", "--statement", GIVEN, "--why", "Procurement.")
        add(s, "given", GIVEN, "The company already pays for it.", "--said-by", "Jo Bloggs, CTO", "--said-on", "2026-11-02", name="need.add.given")
        s.capture("need.none", "need", "none", "--kind", "never")
        s.capture("need.none.refused-has-need", "need", "none", "--kind", "people")
        s.capture("need.list.answered-some", "need", "list")
        s.capture("need.publish", "need", "publish")
        s.capture("need.list.published", "need", "list")
        # Changed since it was published: a new revision of TN-01, a new need, a retired one.
        s.capture("need.set", "need", "set", "TN-01", "--statement", "About five hundred staff use it from three offices, busiest on Monday mornings.")
        s.capture("need.set.why", "need", "set", "TN-02", "--why", "Privacy law, and members expect it.")
        add(s, "connections", CONNECTIONS, "Staff already have accounts.")
        add(s, "priority", PRIORITY, "A mistake costs more than a delay.")
        s.capture("need.retire", "need", "retire", "TN-05")
        s.capture("need.set.refused-retired", "need", "set", "TN-05", "--why", "Changed my mind.")
        s.capture("need.list.several", "need", "list")
        s.capture("status.needs-unpublished", "status")
    run(Scenario, body)


def needs_published_with_an_adr_behind(Scenario):
    """Every kind answered and published; an engineer's accepted ADR serves the first revision of TN-01, which has a
    second: the engine flags it (adrs_behind)."""
    def body(s):
        s.project_and_epic()
        add(s, "people", PEOPLE, "It sets how large it must be.")
        add(s, "data", DATA, "Privacy law.")
        add(s, "connections", CONNECTIONS, "Staff already have accounts.")
        s.ok(s.a, "need", "none", "--kind", "never")
        add(s, "priority", PRIORITY, "A mistake costs more than a delay.")
        add(s, "given", GIVEN, "The company already pays for it.", "--said-by", "Jo Bloggs, CTO", "--said-on", "2026-11-02")
        s.ok(s.a, "need", "publish")
        s.ok(s.a, "need", "set", "TN-01", "--statement", "About five hundred staff use it from three offices, busiest on Monday mornings.")
        s.capture("need.publish.again", "need", "publish")
        adr = s.a / "docs" / "adr" / "0001-size-for-the-staff.md"
        adr.parent.mkdir(parents=True)
        adr.write_text("---\nstatus: accepted\nserves: TN-01@1\n---\n\n# Size for the staff\n")
        git(s.a, "add", "docs")
        git(s.a, "commit", "-q", "-m", "adr")
        s.capture("need.list.adr-behind", "need", "list")
        s.capture("status.needs-adr-behind", "status")
    run(Scenario, body)


def needs_newer_elsewhere(Scenario):
    """Another product manager publishes newer needs while Ada has unpublished changes: Ada chooses."""
    def body(s):
        s.project_and_epic()
        add(s, "people", PEOPLE, "It sets how large it must be.")
        s.ok(s.a, "need", "publish")
        s.project_and_epic(s.b)
        s.set_gh(me="ben-pm")
        s.ok(s.b, "refresh")
        s.ok(s.b, "need", "add", "--kind", "data", "--statement", DATA, "--why", "Privacy law.")
        s.ok(s.b, "need", "publish")
        s.set_gh(me="ada-pm")
        add(s, "priority", PRIORITY, "A mistake costs more than a delay.")
        s.capture("refresh.needs-newer-elsewhere", "refresh")
        s.capture("need.list.newer-elsewhere", "need", "list")
        s.capture("status.needs-newer-elsewhere", "status")
        s.capture("need.publish.refused-newer-elsewhere", "need", "publish")
        s.capture("reconcile.needs", "reconcile", "needs", "--take", "theirs")
        s.capture("reconcile.needs.refused-nothing-newer", "reconcile", "needs", "--take", "mine")
    run(Scenario, body)


# ---- a design you already have (M17 part B) ----

def design_states(Scenario):
    """No design; one imported and not mapped; mapped with one unsettled conflict (against a need); settled and published;
    the refusals (publish with a conflict waiting, the same document twice)."""
    def body(s):
        s.project_and_epic()
        add(s, "data", "Invitations are kept at most one year.", "Privacy.")
        folder = s.root / "documents"
        folder.mkdir()
        document = folder / "architecture.md"
        document.write_text(DESIGN_TEXT, encoding="utf-8")
        s.capture("design.import", "design", "import", str(document))
        s.capture("design.import.again", "design", "import", str(document))
        s.capture("design.list.imported", "design", "list")
        s.capture("design.show.unmapped", "design", "show", "DES-01")
        s.capture("design.show.lines", "design", "show", "DES-01", "--lines", "5-9")
        s.capture("design.publish.refused-no-map", "design", "publish", "DES-01")
        mapped = folder / "map.json"
        mapped.write_text(json.dumps(a_map()))
        s.capture("design.map", "design", "map", "DES-01", "--from", str(mapped))
        s.capture("design.show.mapped", "design", "show", "DES-01")
        s.capture("design.list.mapped", "design", "list")
        s.capture("status.designs-unsettled", "status")
        s.capture("design.publish.refused-unsettled", "design", "publish", "DES-01")
        s.capture("design.settle.refused-no-conflict", "design", "settle", "DES-01", "--conflict", "4", "--as", "stands", "--reason", "It stands.")
        s.capture("design.settle", "design", "settle", "DES-01", "--conflict", "1", "--as", "design-is-wrong",
                  "--reason", "The design predates the privacy review; invitations go after a year.")
        s.capture("design.show.settled", "design", "show", "DES-01")
        s.capture("design.publish", "design", "publish", "DES-01")
        s.capture("design.publish.again", "design", "publish", "DES-01")
        s.capture("design.show.published", "design", "show", "DES-01")
        s.capture("design.list.published", "design", "list")
        s.capture("status.designs-published", "status")
    run(Scenario, body)

