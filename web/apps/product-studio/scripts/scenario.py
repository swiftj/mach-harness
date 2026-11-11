#!/usr/bin/env python3
"""Build a real Product Studio project for screenshots and manual checks, through the real engine.

    python3 scenario.py empty        a Git project with one commit and a shared remote; no product yet
    python3 scenario.py established  Ada's project: an accepted wave, a colleague's accepted work waiting
                                     to arrive (with a numbering collision), a changed vision upstream,
                                     a proposed epic, a slice in interview with open questions, a draft

Prints JSON: {"project": <folder for --project>, "env": {"PATH": ..., "FAKE_GH_STATE": ...}}. Start the
host with that environment so `send` and `feedback` reach the stand-in for gh. The folder is left in
place for the caller to delete. Uses the collaboration test harness (a local bare repository as the
shared remote), so nothing touches the network.
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tests"))
from test_mach_product_collab import Base  # noqa: E402

OPEN_QUESTIONS = (
    "## Open questions\n\n"
    "- Does a removed teammate keep access until the end of the billing period? Follow up: ask Finance.\n"
    "- Can an admin remove themselves? Follow up: ask the product owner."
)


class Scenario(Base):
    def runTest(self):  # pragma: no cover
        pass


def keep(s):
    """Keep the temporary folder after this process exits."""
    s.tmp._finalizer.detach()


def main(kind):
    s = Scenario()
    s.setUp()
    keep(s)
    a, b = s.a, s.b
    if kind == "established":
        s.ok(a, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together without friction.",
             "--outcome", "Teams can work together", "--outcome", "Admins stay in control of who has access")
        s.ok(a, "epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join", "--criterion", "Admins can see who is invited")
        s.ok(a, "epic", "approve", "EPIC-001")
        s.new_slice(a, title="Invite a teammate")
        first = s.new_wave(a, "SLICE-001")
        s.ok(a, "send", first)
        s.land(f"product/{first}")
        s.ok(a, "refresh")
        # Ben, the second product manager, defines and lands a slice of his own.
        s.ok(b, "refresh")
        ben = s.new_slice(b, title="Resend an invitation")
        ben_wave = s.new_wave(b, ben)
        s.ok(b, "send", ben_wave)
        s.land(f"product/{ben_wave}")
        # Someone sharpens the vision on the shared project.
        s.upstream("product/project.json", lambda d: d.update(vision="Teams work together without friction, wherever they are."))
        # Meanwhile Ada, not yet refreshed, starts more work: her next slice takes the number Ben's now holds.
        s.ok(a, "epic", "add", "--title", "Workspace settings", "--criterion", "Admins can rename the workspace", "--criterion", "Admins can see the seat count")
        removal = s.ok(a, "slice", "new", "--epic", "EPIC-001", "--title", "Remove a teammate")["slice"]["slice_id"]
        s.write_slice(a, removal)
        spec = s.draft(a, f"specs/slices/{removal}-invite-teammate.md")
        spec.write_text(spec.read_text().replace("## Open questions\n\n- None.", OPEN_QUESTIONS))
        s.ok(a, "slice", "check", removal)
        s.ok(a, "slice", "pause", removal, "--note", "Settled who may remove a teammate. Next: does access end at once or at the end of the billing period?")
        s.ok(a, "slice", "new", "--epic", "EPIC-002", "--title", "Rename the workspace")
    print(json.dumps({
        "project": str(a),
        "root": str(s.root),
        "env": {"PATH": os.environ["PATH"], "FAKE_GH_STATE": os.environ["FAKE_GH_STATE"]},
    }))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "empty")
