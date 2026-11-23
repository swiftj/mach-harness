"""Team audit: two product managers, each on their own computer and clone, sharing one GitHub repository.

Reproductions only. A test marked expectedFailure shows a real defect: it states what a team needs and fails
today. The others pin down behaviour that already holds, so the boundary of each problem is on record.

Uses the GitHub stand-in of test_mach_product_issues: one shared bare repository, the clones `a` (Ada) and
`b` (Ben), and gh's state in one JSON file. Which account gh is signed in as is switched with set_gh(me=...).
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "product-studio" / "scripts"))
from test_mach_product_issues import IssuesBase  # noqa: E402
import handoff  # noqa: E402
import issue_rules  # noqa: E402


class TwoProductManagers(IssuesBase):
    def ada(self):
        self.set_gh(me="ada-pm")
        return self.a

    def ben(self):
        self.set_gh(me="ben-pm")
        return self.b

    def ada_ships_first_slice(self):
        """Ada sets up the project and EPIC-001 and marks SLICE-001 ready."""
        self.project_and_epic(self.ada())
        self.drafted(self.a)
        return self.ready("SLICE-001", self.a)["issue"]

    def ben_starts_the_same_project(self, vision="Teams work together.", criterion="Only invited people can join"):
        """Ben, on his own computer, starts the same project (same ID) and the same-named epic, as the guides tell a new
        product manager to do: his workspace is private, so it starts empty."""
        project = self.ben()
        self.ok(project, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", vision, "--outcome", "Teams can work together")
        self.ok(project, "epic", "add", "--title", "Team membership", "--criterion", criterion)
        return project

    def slice_issues_for(self, slice_id):
        return [i for i in self.issues("mach:slice") if (issue_rules.parse_slice_body(i["body"]) or {}).get("slice_id") == slice_id and i["state"] == "OPEN"]


class SliceNumberTest(TwoProductManagers):
    def test_the_same_next_number_is_caught_at_ready_and_renumbered(self):
        """Scenario 1, one after the other: DETECTED. Ben, who never refreshed, gets SLICE-001 as well; marking it ready
        is refused before anything is written, and renumbering gives SLICE-002."""
        self.ada_ships_first_slice()
        ben = self.ben_starts_the_same_project()
        self.assertEqual(self.drafted(ben, title="Remove a teammate"), "SLICE-001")  # allocated from what this computer can see
        refused = self.refused(ben, "slice", "ready", "SLICE-001")
        self.assertIn("already used on GitHub by another slice", refused)
        self.assertEqual(self.ok(ben, "slice", "renumber", "SLICE-001")["renumbered"]["to"], "SLICE-002")
        self.assertEqual(self.ready("SLICE-002", ben)["saved_to"], "github")
        self.assertEqual(len(self.slice_issues_for("SLICE-001")), 1)

    @unittest.expectedFailure
    def test_two_ready_at_the_same_moment_leave_two_issues_with_one_id(self):
        """Scenario 1, at the same moment: SILENT on Product Studio's side. Both read GitHub before either has written
        (stood in for by hiding Ada's new issue from Ben's one read), so both make an open issue holding SLICE-001.
        Neither product manager is refused or told; only the Factory later refuses the second (intake.discover,
        'a slice is handed over once'), on an engineer's screen."""
        ada_issue = self.ada_ships_first_slice()
        ben = self.ben_starts_the_same_project()
        self.drafted(ben, title="Remove a teammate")
        real_read = handoff.Handoff.read

        def before_ada_wrote(self_, repository):
            found, failure = real_read(self_, repository)
            if found:
                found = {**found, "slices": [item for item in found["slices"] if item["number"] != ada_issue]}
            return found, failure

        with mock.patch.object(handoff.Handoff, "read", before_ada_wrote):
            self.ready("SLICE-001", ben)
        # After the race, every later read is honest: does anyone learn of it?
        ben_status = self.ok(ben, "status")
        ada_status = self.ok(self.ada(), "status")
        told = [a["kind"] for a in ben_status["next_actions"] + ada_status["next_actions"]]
        self.assertEqual(len(self.slice_issues_for("SLICE-001")), 1, f"two open issues hold SLICE-001; next actions shown: {told}")


class SharedProjectAndEpicTest(TwoProductManagers):
    @unittest.expectedFailure
    def test_a_second_product_managers_project_text_replaces_the_firsts(self):
        """Scenario 11, the project's issue: SILENT, last writer wins. Ben's workspace holds his own copy of the project;
        his first `slice ready` rewrites the shared project issue's vision with his, without a word to either."""
        self.ada_ships_first_slice()
        project_issue = self.issues("mach:project")[0]["number"]
        ben = self.ben_starts_the_same_project(vision="A different vision Ben typed.")
        self.drafted(ben, title="Remove a teammate")
        self.ok(ben, "slice", "renumber", "SLICE-001")
        result = self.ready("SLICE-002", ben)
        self.assertEqual(result["project_issue"], project_issue)  # the same issue, found by the project ID
        self.assertIn("Teams work together.", self.issue(project_issue)["body"], "Ada's vision was replaced by Ben's")

    @unittest.expectedFailure
    def test_a_second_product_managers_epic_criteria_replace_the_firsts(self):
        """Scenario 11, an epic's issue: SILENT, last writer wins. An epic with the same ID and title is taken to be the
        same epic (handoff.find_epic), and Ben's `slice ready` rewrites its acceptance criteria with his own."""
        self.ada_ships_first_slice()
        epic_issue = self.issues("mach:epic")[0]["number"]
        ben = self.ben_starts_the_same_project(criterion="Anyone with the link can join")
        self.drafted(ben, title="Remove a teammate")
        self.ok(ben, "slice", "renumber", "SLICE-001")
        self.ready("SLICE-002", ben)
        self.assertEqual(len(self.issues("mach:epic")), 1)
        self.assertIn("Only invited people can join", self.issue(epic_issue)["body"], "Ada's acceptance criterion was replaced by Ben's")

    def test_an_epic_number_used_for_a_different_epic_is_refused(self):
        """Scenario 1, epics: DETECTED when the titles differ. The same EPIC-001 with another title is refused before
        anything is written, with a renumber hint."""
        self.ada_ships_first_slice()
        ben = self.ben()
        self.ok(ben, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together.", "--outcome", "Teams can work together")
        self.ok(ben, "epic", "add", "--title", "Billing", "--criterion", "Invoices are sent")
        self.drafted(ben, title="Send an invoice")
        self.ok(ben, "slice", "renumber", "SLICE-001")
        self.assertIn("already used on GitHub by another epic", self.refused(ben, "slice", "ready", "SLICE-002"))

    def test_two_first_readies_at_once_make_two_project_issues(self):
        """Scenario 1, the first `project init` and ready done by two people at once: two project issues. Product
        Studio says nothing; the Factory's principles check then refuses every principle ('several' project issues),
        so it is DETECTED, late and on the engineers' side. Pinned here as current behaviour."""
        self.project_and_epic(self.ada())
        self.drafted(self.a)
        ben = self.ben_starts_the_same_project()
        self.drafted(ben, title="Remove a teammate")
        self.ok(ben, "slice", "renumber", "SLICE-001")
        real_read = handoff.Handoff.read
        self.ready("SLICE-001", self.ada())
        ada_issues = {i["number"] for i in self.issues()}

        def before_ada_wrote(self_, repository):
            found, failure = real_read(self_, repository)
            if found:
                found = {key: [item for item in value if item["number"] not in ada_issues] for key, value in found.items()}
            return found, failure

        self.ben()
        with mock.patch.object(handoff.Handoff, "read", before_ada_wrote):
            self.ready("SLICE-002", ben)
        self.assertEqual(len(self.issues("mach:project")), 2)
        self.assertEqual(len(self.issues("mach:epic")), 2)


if __name__ == "__main__":
    unittest.main()
