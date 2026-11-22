"""Fixtures for M18 in the app: a small change, started, checked, widened by a rule and on the product manager's word.

Called by generate.py (python3 web/fixtures/generate.py, or --only small to write just these). Each scenario drives the
real engine with --app, in the same throwaway repositories and stand-in for gh as the engine's own tests
(tests/test_small_change.py), and saves exactly what it printed. Nothing is invented: the shipped rule a fix names is a
spec committed to main; a slice is widened by `slice check` itself, or by `slice widen --why`.

The states, with the parameter that reaches each in fixture mode, are listed in docs/mach-next/M18_APP.md.
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))

from test_current import make_spec  # noqa: E402
from test_small_change import INTENT, SPEC, with_effects, with_frs  # noqa: E402

MEMBERSHIP = ("Team membership", "EPIC-001", None)
EXPIRY = "The system SHALL expire an invitation after 14 days."
# A spec name per slice, the engine's pattern.
NAME = "{slice_id}-expired-invitation-message.md"


def generate(Scenario, out: Path) -> None:
    small_changes(Scenario)
    small_request(Scenario)


def run(Scenario, body):
    s = Scenario()
    s.setUp()
    saved = s.save
    # slice resume names the interview method by its path in this checkout; the fixture names it under /mach, so it is
    # the same file whichever checkout generated it.
    s.save = lambda name, data: saved(name, json.loads(json.dumps(data).replace(str(ROOT), "/mach")))
    try:
        os.environ.pop("MACH_EXECUTION_ID", None)
        body(s)
    finally:
        s.doCleanups()


def write(s, slice_id, text, tier="Low"):
    """The spec and why the short interview would write, for this slice."""
    name = NAME.format(slice_id=slice_id)
    s.draft(s.a, f"specs/slices/{name}").write_text(text.replace("# SLICE-001:", f"# {slice_id}:", 1))
    s.draft(s.a, f"product/intents/{slice_id}.md").write_text(INTENT.format(slice_id=slice_id, name=name, tier=tier))


def small_changes(Scenario):
    """One shipped slice on main (its rules in force), then small changes in every state the app shows: an adjustment
    being drafted and then passing its check on the light path; a fix naming the shipped rule that is not holding; one
    the check widened by a rule (four requirements); one widened on the product manager's word; the refusals; and one
    marked ready on the light path."""
    from product_memory import commit_to_main  # noqa: E402  (beside this file)

    def body(s):
        commit_to_main(s, {
            "specs/slices/SLICE-001-invite.md": make_spec(1, "Invite by email", invs=[("INV-01", "An invitation MUST name one email address.")],
                                                          frs=[("FR-01", "The system SHALL send the invitation by email."), ("FR-02", EXPIRY)],
                                                          rules=[("R1", "Yes", "Sent"), ("R2", "No", "Refused")], effects_section="None.", epic=MEMBERSHIP),
        }, "SLICE-001 shipped")
        s.project_and_epic()
        s.capture("epic.current.small", "epic", "current", "EPIC-001", "--json")

        # An adjustment being drafted: started, nothing written yet.
        adjustment = s.capture("slice.new.small", "slice", "new", "--epic", "EPIC-001", "--title", "Clearer expired invitation message",
                               "--small", "--change", "adjustment")["slice"]["slice_id"]
        s.capture("slice.resume.small", "slice", "resume", adjustment)
        s.capture("slice.show.small-drafting", "slice", "show", adjustment)
        s.capture("status.small-drafting", "status")
        # Its spec written: the check keeps it small.
        write(s, adjustment, SPEC)
        s.capture("slice.check.small", "slice", "check", adjustment)
        s.capture("slice.show.small", "slice", "show", adjustment)

        # A fix: the shipped rule that is not holding, in force on main. Its spec keeps that rule, with the case that fails today.
        s.capture("slice.new.refused-small-not-in-force", "slice", "new", "--epic", "EPIC-001", "--title", "Expire invitations again",
                  "--small", "--change", "fix", "--rule", "SLICE-001/FR-09")
        fix = s.capture("slice.new.small-fix", "slice", "new", "--epic", "EPIC-001", "--title", "Expire invitations after 14 days again",
                        "--small", "--change", "fix", "--rule", "SLICE-001/FR-02")["slice"]["slice_id"]
        write(s, fix, with_effects(SPEC, "| SLICE-001/FR-02 | kept | AC-01 | An invitation still expires after 14 days. |"))
        s.capture("slice.resume.small-fix", "slice", "resume", fix)
        s.capture("slice.check.small-fix", "slice", "check", fix)
        s.capture("slice.show.small-fix", "slice", "show", fix)

        # Widened by the check: four requirements is more than a small change has. Nothing in the spec is trimmed.
        by_rule = s.ok(s.a, "slice", "new", "--epic", "EPIC-001", "--title", "Help text on the expired invitation page",
                       "--small", "--change", "adjustment")["slice"]["slice_id"]
        write(s, by_rule, with_frs(SPEC))
        s.capture("slice.check.small-widened", "slice", "check", by_rule)
        s.capture("slice.show.small-widened", "slice", "show", by_rule)
        s.capture("slice.resume.small-widened", "slice", "resume", by_rule)

        # Widened on the product manager's word, with their reason; then the refusals.
        asked = s.ok(s.a, "slice", "new", "--epic", "EPIC-001", "--title", "Shorter reminder wording",
                     "--small", "--change", "adjustment")["slice"]["slice_id"]
        write(s, asked, SPEC)
        s.capture("slice.widen", "slice", "widen", asked, "--why", "It should also change the reminder email, which is a second message.")
        s.capture("slice.show.small-widened-asked", "slice", "show", asked)
        s.capture("slice.widen.refused-already", "slice", "widen", asked, "--why", "Again.")
        full = s.drafted(title="Invite a teammate")
        s.capture("slice.widen.refused-full", "slice", "widen", full, "--why", "It is bigger.")
        s.capture("status.small-changes", "status")

        # The adjustment marked ready on the light path.
        s.capture("slice.ready.small", "slice", "ready", adjustment)
        s.capture("slice.show.small-ready", "slice", "show", adjustment)
        s.capture("status.small-ready", "status")
    run(Scenario, body)


def small_request(Scenario):
    """A request picked up as a small change."""
    from test_mach_requests import RequestBase  # noqa: E402

    class RequestScenario(RequestBase):
        def runTest(self):  # pragma: no cover
            pass
        save = Scenario.save
        capture = Scenario.capture

    def body(s):
        s.ready(s.a)
        s.request(s.a)
        s.capture("request.pick.small", "request", "pick", "42", "--epic", "EPIC-001", "--title", "Clearer invitation wording",
                  "--small", "--change", "adjustment")
    run(RequestScenario, body)
