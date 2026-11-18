#!/usr/bin/env python3
"""Build a real Product Studio project for screenshots and manual checks, through the real engine.

    python3 scenario.py empty        a Git project with one commit and a shared remote on GitHub; no product yet
    python3 scenario.py established  Ada's project: a slice marked ready that the builders took, one edited
                                     on GitHub after approval, a second epic, a slice in interview with
                                     open questions, a draft

Prints JSON: {"project": <folder for --project>, "env": {"PATH": ..., "FAKE_GH_STATE": ...}}. Start the
host with that environment so marking ready and refresh reach the stand-in for gh. The folder is left
in place for the caller to delete. Uses the GitHub issues test harness (a local bare repository reached
through a github.com address, and a stand-in gh), so nothing touches the network.
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tests"))
from test_mach_product_issues import IssuesBase  # noqa: E402

OPEN_QUESTIONS = (
    "## Open questions\n\n"
    "- Does a removed teammate keep access until the end of the billing period? Follow up: ask Finance.\n"
    "- Can an admin remove themselves? Follow up: ask the product owner."
)


class Scenario(IssuesBase):
    def runTest(self):  # pragma: no cover
        pass


def keep(s):
    """Keep the temporary folder after this process exits."""
    s.tmp._finalizer.detach()


def main(kind):
    s = Scenario()
    s.setUp()
    keep(s)
    a = s.a
    if kind == "established":
        s.ok(a, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together without friction.",
             "--outcome", "Teams can work together", "--outcome", "Admins stay in control of who has access")
        s.ok(a, "epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join", "--criterion", "Admins can see who is invited")
        # Marked ready; the builders took it.
        first = s.ready(s.drafted(title="Invite a teammate"))["issue"]
        s.change_issue(first, labels=[{"name": "mach:slice"}, {"name": "mach:building"}])
        # Marked ready, then edited on GitHub by someone else.
        second = s.ready(s.drafted(title="Resend an invitation"))["issue"]
        s.change_issue(second, body=s.issue(second)["body"].replace("An admin", "Anyone"))
        # More work: a second epic, a slice in interview with open questions, a draft.
        s.ok(a, "epic", "add", "--title", "Workspace settings", "--criterion", "Admins can rename the workspace", "--criterion", "Admins can see the seat count")
        removal = s.ok(a, "slice", "new", "--epic", "EPIC-001", "--title", "Remove a teammate")["slice"]["slice_id"]
        s.write_slice(a, removal)
        spec = s.draft(a, f"specs/slices/{removal}-invite-teammate.md")
        spec.write_text(spec.read_text().replace("## Open questions\n\n- None.", OPEN_QUESTIONS))
        s.ok(a, "slice", "check", removal)
        s.ok(a, "slice", "pause", removal, "--note", "Settled who may remove a teammate. Next: does access end at once or at the end of the billing period?")
        s.ok(a, "slice", "new", "--epic", "EPIC-002", "--title", "Rename the workspace")
        s.ok(a, "refresh")
    print(json.dumps({
        "project": str(a),
        "root": str(s.root),
        "env": {"PATH": os.environ["PATH"], "FAKE_GH_STATE": os.environ["FAKE_GH_STATE"]},
    }))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "empty")
