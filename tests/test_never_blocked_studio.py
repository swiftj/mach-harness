"""The owner's rule, for Product Studio: anyone on the project may take over what someone else is working on. MACH warns
that someone else has it, changed it or holds its number, and then does what the product manager asked. It never refuses
because another person has it, never sends the product manager to another person, and never asks a second question for
the same act; the normal merge settles the rest.

Each case of the inventory (P1 to P6) is done here with a warning and exit code 0. The host's part (P7: a second interview,
an edit while the interviewer writes) is pinned by the Go tests in apps/studio. The last class reads every string literal
in skills/studio/scripts/*.py for words that send the product manager to another person.

Uses the GitHub stand-in of test_mach_product_issues and the request stand-in of test_mach_requests; nothing reaches the
network and real gh is never run.
"""

import ast
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "studio" / "scripts"))
from test_mach_product_issues import spec_for  # noqa: E402
from test_mach_product_order import TakeBase  # noqa: E402
from test_mach_requests import RequestBase  # noqa: E402
from test_team_studio import TwoProductManagers  # noqa: E402
import issue_rules  # noqa: E402

STATEMENT = "A published version MUST NOT be edited in place."
SECOND = "An invitation MUST name the person who sent it."


class Done:
    """An act that is done, exit code 0, with its warning first in the note."""

    def done(self, project, *argv):
        code, out, err = self.run_studio(project, *argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def warned_first(self, result, words):
        self.assertTrue(result["note"].startswith(words) or words in result["note"].split(". ", 1)[0] + ".", result["note"])
        self.assertIn(words, " ".join(result.get("warned") or [result["note"]]))


class TakeOverTest(TakeBase, Done):
    """P1: slice take always opens the slice."""

    def test_text_changed_after_approval_opens_as_a_draft(self):
        (slice_id,) = self.ada_ready()
        number = self.slice_issue(slice_id)[0]["number"]
        self.change_issue(number, body=self.issue(number)["body"].replace("An admin", "Anyone"))
        taken = self.done(self.b, "slice", "take", str(number))
        self.warned_first(taken, f"#{number}'s text was changed on GitHub after @ada-pm approved it.")
        self.assertEqual((taken["taken"], taken["approved_here"]), (True, False))

    def test_no_approval_opens_as_a_draft(self):
        (slice_id,) = self.ada_ready()
        number = self.slice_issue(slice_id)[0]["number"]
        self.change_issue(number, comments=[])
        taken = self.done(self.b, "slice", "take", str(number))
        self.warned_first(taken, f"#{number} has no approval for the version it holds.")

    def test_the_product_managers_own_draft_holding_the_number_moves_aside(self):
        self.ok(self.b, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together.", "--outcome", "Teams can work together")
        self.ok(self.b, "epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join")
        self.ok(self.b, "slice", "new", "--epic", "EPIC-001", "--title", "Ben's own idea")
        self.project_and_epic(self.a)
        self.ready(self.drafted(self.a), self.a)
        self.set_gh(me="ben-pm")
        taken = self.done(self.b, "slice", "take", "SLICE-001")
        self.assertRegex(taken["note"], r"^Your draft SLICE-001 is now SLICE-\d{3}, so #\d+ could open as SLICE-001\.")

    def test_a_dependency_not_here_is_opened_first(self):
        first, second = self.ada_ready(depends=["yes"])
        taken = self.done(self.b, "slice", "take", second)
        self.assertEqual(taken["opened_first"], [first])

    def test_the_product_managers_own_epic_holding_the_number_moves_aside(self):
        (slice_id,) = self.ada_ready()
        self.ok(self.b, "epic", "add", "--title", "Billing", "--criterion", "Invoices are sent")
        taken = self.done(self.b, "slice", "take", slice_id)
        self.assertIn("Your epic EPIC-001 is now EPIC-002", taken["note"])


class NumberAndVersionTest(TwoProductManagers, Done):
    """P2 and P3 for slices, and P5's several project issues: marking ready carries on, saying so first."""

    def test_a_number_someone_else_took_gets_the_next_free_one_in_the_same_act(self):
        self.ada_ships_first_slice()
        ben = self.ben_starts_the_same_project()
        self.drafted(ben, title="Remove a teammate")
        result = self.done(ben, "slice", "ready", "SLICE-001")
        self.assertEqual((result["ready"], result["slice"]["slice_id"]), (True, "SLICE-002"))
        self.assertTrue(result["note"].startswith("SLICE-001 was already used on GitHub by another slice"))

    def test_the_same_moment_is_carried_on_not_undone(self):
        ada_issue = self.ada_ships_first_slice()
        ben = self.ben_starts_the_same_project()
        self.drafted(ben, title="Remove a teammate")
        with self.hidden({ada_issue}):
            result = self.done(ben, "slice", "ready", "SLICE-001")
        self.assertEqual((result["ready"], result["slice"]["status"]), (True, "approved_for_engineering"))
        self.assertTrue(result["note"].startswith("SLICE-001 was marked ready at the same moment by someone else"))
        self.assertEqual(self.ok(ben, "status")["approvals_withdrawn"], [])

    def test_a_newer_version_someone_else_saved_is_replaced_and_kept(self):
        self.ada_ships_first_slice()
        (issue,) = self.slice_issues_for("SLICE-001")
        self.ok(self.a, "slice", "reopen", "SLICE-001")
        self.draft(self.a, "specs/slices/SLICE-001-invite-teammate.md").write_text(spec_for("SLICE-001", extra="\nAda's change.\n"))
        # Ben saves version 2 on GitHub meanwhile.
        marker = issue_rules.parse_slice_body(self.issue(issue["number"])["body"])
        spec = marker["spec"] + "\nChanged by Ben.\n"
        self.change_issue(issue["number"], body=issue_rules.slice_issue_body("SLICE-001", 2, marker["epic"], [], marker["why"], spec),
                          comments=[*self.issue(issue["number"])["comments"],
                                    {"login": "ben-pm", "body": issue_rules.approval_comment("SLICE-001", 2, "ben-pm", issue_rules.text_sha256_of(spec),
                                                                                             marker["why_sha256"])}])
        self.ada()
        result = self.done(self.a, "slice", "ready", "SLICE-001")
        self.warned_first(result, "@ben-pm saved version 2 of SLICE-001 on GitHub")
        self.assertIn("Yours is now version 3 and replaces it.", result["note"])
        self.assertTrue((self.a / ".factory/studio/replaced/SLICE-001-version-2/spec.md").read_text().endswith("Changed by Ben.\n"))

    def test_several_project_issues_are_a_warning(self):
        self.ada_ships_first_slice()
        first = self.issues("mach:project")[0]["number"]
        self.second_project_issue()
        self.drafted(self.ada(), title="Remove a teammate")
        result = self.done(self.a, "slice", "ready", "SLICE-002")
        self.warned_first(result, "This repository has more than one project issue on GitHub")
        self.assertEqual(result["project_issue"], first)


class PublishOverTest(TwoProductManagers, Done):
    """P3 for the principles and the technical needs: the product manager's set is published over the newer one."""

    def test_principles(self):
        self.project_and_epic(self.ada())
        self.ok(self.a, "principle", "add", "--title", "Versions", "--statement", STATEMENT, "--reason", "Readers rely on it.")
        self.ok(self.a, "principle", "publish")
        self.project_and_epic(self.ben())
        self.ok(self.b, "refresh")
        self.ok(self.b, "principle", "add", "--title", "Senders", "--statement", SECOND, "--reason", "Trust.")
        self.ok(self.b, "principle", "publish")
        self.ada()
        self.ok(self.a, "principle", "set", "PP-01", "--reason", "Ada's reason.")
        result = self.done(self.a, "principle", "publish")
        self.warned_first(result, "@ben-pm published version 2 of the principles on GitHub")
        self.assertEqual(result["revision"], 3)

    def test_needs(self):
        self.project_and_epic(self.ada())
        self.ok(self.a, "need", "add", "--kind", "people", "--statement", "Admins and members use it.", "--why", "Two kinds of people.")
        self.ok(self.a, "need", "publish")
        self.project_and_epic(self.ben())
        self.ok(self.b, "refresh")
        self.ok(self.b, "need", "set", "TN-01", "--why", "Ben's reason.")
        self.ok(self.b, "need", "publish")
        self.ada()
        self.ok(self.a, "need", "set", "TN-01", "--why", "Ada's reason.")
        result = self.done(self.a, "need", "publish")
        self.warned_first(result, "@ben-pm published version 2 of the technical needs on GitHub")


class RequestTakenTest(RequestBase, Done):
    """P6: a request someone else picked up is picked up as well, with no second question."""

    def test_picked_up_as_well(self):
        self.ready(self.a)
        self.request(self.a)
        self.ok(self.a, "request", "pick", "42", "--epic", "EPIC-001", "--title", "Invite a teammate")
        result = self.done(self.a, "request", "pick", "42", "--epic", "EPIC-001", "--title", "Second")
        self.warned_first(result, "@ada-pm has also picked this up.")


# Phrases that send the product manager to another person. Each allowed use is listed with why it does not.
BANNED = ("Ask the product manager", "ask the person", "Ask the person", "tell the engineer", "on their computer")
ALLOWED = {
    # Terminal wording read by the interviewer working for the product manager: "the product manager" is the person in the
    # conversation, the one being served, never someone else. The app's wording (the second argument of say) asks no one.
    ("prd.py", "Ask the product manager about each: a slice, out of scope, or later (prd settle)."),
    ("prd.py", "Ask the product manager (prd confirm)."),
    ("shape_route.py", "Ask the product manager about each: a slice, out of scope, or later (idea settle)."),
    ("shape_route.py", "Ask the product manager which kind it is, then apply it with their word: "),
}


def literals(path):
    """Every string in the file as a person reads it: plain literals, and each f-string's fixed parts joined."""
    found = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.JoinedStr):
            found.append("".join(part.value for part in node.values if isinstance(part, ast.Constant) and isinstance(part.value, str)))
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            found.append(node.value)
    return found


class NoSendingAwayTest(unittest.TestCase):
    def test_no_sentence_sends_the_product_manager_to_another_person(self):
        offending = []
        for path in sorted((ROOT / "skills" / "studio" / "scripts").glob("*.py")):
            for text in literals(path):
                for phrase in BANNED:
                    if phrase in text and not any(name == path.name and allowed in text for name, allowed in ALLOWED):
                        offending.append(f"{path.name}: {text[:160]!r}")
        self.assertEqual(offending, [])

    def test_the_skill_states_the_rule_and_sends_no_one_away(self):
        skill = (ROOT / "skills" / "studio" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("**Never blocked.**", skill)
        for phrase in ("tell the engineer", "a person who looks after the repository must", "Ask the person"):
            self.assertNotIn(phrase, skill)


if __name__ == "__main__":
    unittest.main()
