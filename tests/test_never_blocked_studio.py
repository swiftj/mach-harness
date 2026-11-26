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
import re
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
        (folder,) = (self.a / ".factory/studio/replaced").glob(f"SLICE-001-issue-{issue['number']}-version-2-*")
        self.assertTrue((folder / "spec.md").read_text().endswith("Changed by Ben.\n"))

    def test_several_project_issues_are_a_warning(self):
        self.ada_ships_first_slice()
        first = self.issues("mach:project")[0]["number"]
        self.second_project_issue()
        self.drafted(self.ada(), title="Remove a teammate")
        result = self.done(self.a, "slice", "ready", "SLICE-002")
        self.warned_first(result, "This repository has more than one project issue on GitHub")
        self.assertEqual(result["project_issue"], first)

    def test_marking_ready_over_a_version_the_builders_are_building_says_so_first(self):
        """The builders started on Ben's version 2; Ada's version 3 goes on the same issue, which is how they are told, and the
        note says so first instead of "nothing has started yet"."""
        self.ada_ships_first_slice()
        (issue,) = self.slice_issues_for("SLICE-001")
        number = issue["number"]
        self.ok(self.a, "slice", "reopen", "SLICE-001")
        self.draft(self.a, "specs/slices/SLICE-001-invite-teammate.md").write_text(spec_for("SLICE-001", extra="\nAda's change.\n"))
        marker = issue_rules.parse_slice_body(self.issue(number)["body"])
        spec = marker["spec"] + "\nChanged by Ben.\n"
        building = {"login": "erin-eng", "created_at": "2026-11-17T14:02:00Z",
                    "body": "The MACH Factory has started building SLICE-001 revision 2.\n\n<!-- mach:status v1 moment=building key=0123456789abcdef -->"}
        self.change_issue(number, body=issue_rules.slice_issue_body("SLICE-001", 2, marker["epic"], [], marker["why"], spec),
                          labels=[{"name": "mach:slice"}, {"name": "mach:building"}],
                          comments=[*self.issue(number)["comments"],
                                    {"login": "ben-pm", "body": issue_rules.approval_comment("SLICE-001", 2, "ben-pm", issue_rules.text_sha256_of(spec),
                                                                                             marker["why_sha256"])}, building])
        self.ada()
        result = self.done(self.a, "slice", "ready", "SLICE-001")
        self.assertTrue(result["note"].startswith("The builders started on version 2 at 14:02 UTC on 2026-11-17. Marking this ready tells them it "
                                                  "changed; they pick up version 3 once their work on version 2 leaves the line."), result["note"])
        self.assertNotIn("nothing has started yet", result["note"])
        self.assertEqual(result["building"]["revision"], 2)
        # How they are told: version 3, approved, on the same issue, marked ready again.
        self.assertEqual(issue_rules.parse_slice_body(self.issue(number)["body"])["revision"], 3)
        self.assertIn("mach:ready", self.labels_of(number))

    def test_project_init_names_the_issues_it_can_close(self):
        self.ada_ships_first_slice()
        first = self.issues("mach:project")[0]["number"]
        second = self.second_project_issue()
        result = self.done(self.ben(), "project", "init", "--id", "team-space", "--name", "x", "--vision", "y", "--outcome", "z")
        self.assertEqual((result["taken_from_github"], result["extra_issues"]), (first, [second]))
        code, out, _ = self.run_studio(self.b, "--app", "status")
        self.assertEqual(code, 0)


class NotApprovedRecordTest(TakeBase, Done):
    """A slice opened from GitHub without an approval for its text is recorded as not approved, why and since when, so status,
    the app, export and the next slice ready all know after the one-time note."""

    def test_the_record_says_not_approved_until_it_is_marked_ready(self):
        (slice_id,) = self.ada_ready()
        number = self.slice_issue(slice_id)[0]["number"]
        self.change_issue(number, body=self.issue(number)["body"].replace("An admin", "Anyone"))
        self.done(self.b, "slice", "take", str(number))
        entry = self.ledger(self.b)["slices"][slice_id]
        self.assertEqual((entry["not_approved"]["why"], entry["spec_sha256"], entry["approved_by"]), ("edited", None, None))
        self.assertTrue(entry["not_approved"]["since"])
        (row,) = self.ledger(self.b)["seen"]["slices"][slice_id]
        self.assertFalse(row["matches_approval"])
        status = self.ok(self.b, "status")
        (slice_row,) = status["slices"]
        self.assertEqual(slice_row["github"]["not_approved"]["why"], "edited")
        self.assertTrue(slice_row["github"]["changed_on_github"])
        first = next(a for a in status["next_actions"] if a["target"] == slice_id)
        # Never a bare "mark it ready": read it, knowing whose approval was for which text.
        self.assertEqual(first["kind"], "read_slice")
        self.assertIn("@ada-pm approved Invite a teammate (version 1), and its text on GitHub was changed after that", first["reason"])
        self.assertEqual(status["saved"]["not_saved"], [], "nothing calls it changed since you marked it ready")
        self.done(self.b, "slice", "ready", slice_id)
        self.assertNotIn("not_approved", self.ledger(self.b)["slices"][slice_id])

    def test_no_approval_is_recorded_too(self):
        (slice_id,) = self.ada_ready()
        number = self.slice_issue(slice_id)[0]["number"]
        self.change_issue(number, comments=[])
        self.done(self.b, "slice", "take", str(number))
        self.assertEqual(self.ledger(self.b)["slices"][slice_id]["not_approved"]["why"], "no_approval")
        (row,) = self.ledger(self.b)["seen"]["slices"][slice_id]
        self.assertFalse(row["matches_approval"])

    def test_taking_theirs_works_for_a_version_changed_after_approval(self):
        (slice_id,) = self.ada_ready()
        number = self.slice_issue(slice_id)[0]["number"]
        self.done(self.b, "slice", "take", str(number))
        self.ok(self.b, "slice", "reopen", slice_id)
        mine = next(self.draft(self.b, "specs/slices").glob(f"{slice_id}-*.md"))
        mine.write_text(mine.read_text() + "\nBen's own change.\n")  # changed here: a refresh keeps it, and taking theirs is his choice
        # Ada saves version 2, then someone edits its text on GitHub after her approval.
        self.set_gh(me="ada-pm")
        self.ok(self.a, "slice", "reopen", slice_id)
        self.draft(self.a, f"specs/slices/{slice_id}-invite-teammate.md").write_text(spec_for(slice_id, extra="\nAda's v2.\n"))
        self.ok(self.a, "slice", "ready", slice_id)
        self.change_issue(number, body=self.issue(number)["body"].replace("Ada's v2.", "Edited by hand."))
        self.set_gh(me="ben-pm")
        self.ok(self.b, "refresh")
        taken = self.done(self.b, "reconcile", slice_id, "--take", "theirs")
        self.assertIn("it is taken as it is", taken["note"])
        self.assertIn("Edited by hand.", next(self.draft(self.b, "specs/slices").glob(f"{slice_id}-*.md")).read_text())
        self.assertIn(".factory/studio/replaced/", taken["kept_yours"])


class KeptVersionsTest(unittest.TestCase):
    def test_a_kept_version_is_never_overwritten(self):
        import tempfile
        import replaced
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)

            def write(path, text):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)

            first = replaced.keep(home, write, "SLICE-001-issue-3-version-2", {"spec.md": "one"}, {"what": "slice", "slice_id": "SLICE-001"})
            second = replaced.keep(home, write, "SLICE-001-issue-3-version-2", {"spec.md": "two"}, {"what": "slice", "slice_id": "SLICE-001"})
            self.assertNotEqual(first, second)
            self.assertEqual(((first / "spec.md").read_text(), (second / "spec.md").read_text()), ("one", "two"))
            rows = replaced.listing(home, home)
            self.assertEqual(sorted(row["name"] for row in rows), sorted([first.name, second.name]))
            self.assertTrue(all(row["restorable"] for row in rows))


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


# Words that send the product manager to another person, stop an act for someone else's sake, or defer it to them: the
# reviewer's word list, narrowed to the ones that are never right in Product Studio's own text. Read in every string a person
# can read: Python string literals in skills/studio/scripts, TypeScript strings and JSX text under web/apps/product-studio/src,
# Go string literals under apps/studio (tests left out), and the sentences of skills/studio/SKILL.md.
BANNED = re.compile(
    r"\bask (?:the person|the product manager|someone|another|whoever|the other|them to|an engineer|the engineer)\b"
    r"|\btell the engineer\b|\bon their computer\b|\bis left to\b|\bthat conversation\b|\bcannot be opened\b|\bwould be refused\b"
    r"|\bwait for it\b|\bchoose (?:a version |yours or theirs |which )?(?:first|before)\b|\bbefore (?:you )?(?:mark(?:ing)? it ready|publishing|saving)\b"
    r"|\bgive (?:it|yours|your draft|your epic|that \w+) (?:a new|the next free) number(?:,| first| then| before)",
    re.I)
# Each allowed use, with why it is not one person's work held for another's. Matched by file and a fragment of the text.
ALLOWED = {
    # Terminal wording read by the interviewer working for the product manager: "the product manager" is the person in the
    # conversation, the one being served. The app's wording (the second argument of say) asks no one.
    ("prd.py", "Ask the product manager about each: a slice, out of scope, or later (prd settle)."),
    ("prd.py", "Ask the product manager (prd confirm)."),
    ("shape_route.py", "Ask the product manager about each: a slice, out of scope, or later (idea settle)."),
    ("shape_route.py", "Ask the product manager which kind it is, then apply it with their word: "),
    # Export reads only and changes nothing in the workspace, so it names the product manager's own renumber; nobody else holds it.
    ("project_export.py", "Give your epic a new number"),
    # An import that stopped because the product manager's own new draft took a number the import had given out: their own work.
    ("project_import.py", "Give that {} a new number"),
    # A dependency on a slice that came with the import: the slice waits for that one to ship, not for a person.
    ("project_import.py", "cannot wait for it; answer that row again here."),
    ("SKILL.md", "depend on a slice that came with them and wait for it to ship"),
    # A safety check on the archive's own size, not anyone's hold.
    ("project_archive.py", "would be refused as unsafe where it is brought in"),
    # The interviewer's own instruction: it asks the product manager it is working with.
    ("shape.py", "ask the product manager open questions, one at a time."),
    # A conflict's settlement the product manager chooses ("ask-engineer"), named as the choice it is.
    ("model.ts", '"Ask the engineer"'),
    # What is left for the product manager to settle in their own PRD.
    ("PrdScreen.tsx", "what is left to settle."),
}


def strings(path):
    """Every string in the file as a person reads it, with its line."""
    if path.suffix == ".py":
        found = []
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.JoinedStr):
                found.append((node.lineno, "".join(part.value if isinstance(part, ast.Constant) and isinstance(part.value, str) else "{}"
                                                   for part in node.values)))
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                found.append((node.lineno, node.value))
        return found
    if path.suffix == ".md":
        return [(n, line) for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)]
    literal = re.compile(r'"(?:[^"\\\n]|\\.)*"|`[^`]*`' + (r"|'(?:[^'\\\n]|\\.)*'|>[^<>{}\n]{20,}<" if path.suffix in (".ts", ".tsx") else ""))
    found = []
    for n, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if line.strip().startswith(("//", "*", "/*")):
            continue
        found += [(n, match.group(0)) for match in literal.finditer(line)]
    return found


def sources():
    yield from sorted((ROOT / "skills" / "studio" / "scripts").glob("*.py"))
    yield ROOT / "skills" / "studio" / "SKILL.md"
    for pattern in ("*.ts", "*.tsx"):
        yield from (p for p in sorted((ROOT / "web" / "apps" / "product-studio" / "src").rglob(pattern)) if "/dev/" not in str(p))
    yield from (p for p in sorted((ROOT / "apps" / "studio").rglob("*.go")) if not p.name.endswith("_test.go") and "testkit" not in str(p))


class NoSendingAwayTest(unittest.TestCase):
    def test_no_sentence_sends_the_product_manager_to_another_person(self):
        offending = []
        for path in sources():
            for line, text in strings(path):
                text = " ".join(text.split())
                if BANNED.search(text) and not any(name == path.name and allowed in text for name, allowed in ALLOWED):
                    offending.append(f"{path.relative_to(ROOT)}:{line}: {text[:200]!r}")
        self.assertEqual(offending, [])

    def test_the_words_are_caught(self):
        """The scan itself: each kind of sentence it is there to catch is caught."""
        for text in ("Ask the person who looks after the repository to check it.", "Wait for it to finish, or interrupt it.",
                     "Publishing now would be refused.", "Give yours the next free number, then save it.", "tell the engineer before anything else",
                     "Choose a version first.", "reopen it on their computer"):
            self.assertTrue(BANNED.search(text), text)

    def test_the_skill_states_the_rule(self):
        self.assertIn("**Never blocked.**", (ROOT / "skills" / "studio" / "SKILL.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
