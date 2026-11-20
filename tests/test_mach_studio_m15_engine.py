"""M15 clean-up: what the Product Studio screens needed from the engine.

The statements of each policy pack in `policy list`; each slice's and epic's Jira key in `status`; unpublished principles
counted as not saved; the line of each row of '## Effects on shipped behaviour' in the spec's model; the PRD field in the
read-only `slice show`; and the app's wording of the new commands' refusals and notes.
"""

import json
import os
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
import policies  # noqa: E402
import validate_slice  # noqa: E402
import test_mach_policy_packs as packs_tests  # noqa: E402
import test_mach_product_prd as prd_tests  # noqa: E402
from test_mach_product_issues import IssuesBase, git as issues_git  # noqa: E402
from test_mach_product_principles import STATEMENT  # noqa: E402
from test_mach_shipped_effects import FIXTURE, FIXTURE_NAME, effects  # noqa: E402

# A command in the app's wording (the same as AppWordingTest.COMMAND).
COMMAND = re.compile(r"\((principle|policy|prd|jira|reconcile|slice|epic) [a-z]|--[a-z]|\b(studio|run|cell)\.py\b")


class PackBase(IssuesBase):
    def setUp(self):
        super().setUp()
        path = self.eng / "policies/privacy/policy.md"
        path.parent.mkdir(parents=True)
        path.write_text(packs_tests.pack_text())
        issues_git(self.eng, "add", "-A")
        issues_git(self.eng, "commit", "-q", "-m", "privacy pack")
        issues_git(self.eng, "push", "-q", "origin", "main")
        issues_git(self.a, "pull", "-q")
        self.project_and_epic()
        saved = os.environ.pop("MACH_EXECUTION_ID", None)
        self.addCleanup(lambda: os.environ.__setitem__("MACH_EXECUTION_ID", saved) if saved is not None else None)


class PolicyListTest(PackBase):
    def test_each_pack_lists_its_statements_bounded(self):
        listed = self.ok(self.a, "policy", "list")
        self.assertEqual(listed["packs"][0]["statements"], [{"id": "POL-privacy-01", "text": packs_tests.STATEMENT_1},
                                                           {"id": "POL-privacy-02", "text": packs_tests.STATEMENT_2}])
        self.assertTrue(all(len(item["text"]) <= policies.STATEMENT_LIMIT for item in listed["packs"][0]["statements"]))


class AppWordingOfPoliciesTest(PackBase):
    def test_the_open_concern_and_a_refused_acceptance_name_the_page_not_the_command(self):
        slice_id = self.drafted()
        path = next((self.a / ".factory/studio/draft/specs/slices").glob(f"{slice_id}-*.md"))
        path.write_text(packs_tests.concern(path.read_text()))
        shown = self.ok(self.a, "--app", "slice", "show", slice_id)
        (finding,) = [item for item in shown["spec"]["findings"] if item["rule"] == "policy-concern-open"]
        self.assertIn("on the slice's Principles and policies page", finding["message"])
        self.assertNotIn("(policy accept)", finding["message"])
        self.assertIn("(policy accept)", [item for item in self.ok(self.a, "slice", "show", slice_id)["spec"]["findings"]
                                          if item["rule"] == "policy-concern-open"][0]["message"], "the terminal keeps its command")
        code, _, err = self.run_studio(self.a, "--app", "policy", "accept", slice_id, "POL-privacy-02", "--by", "x", "--reason", "Accepted for the pilot.")
        self.assertEqual(code, 1)
        self.assertIn("refused: Name who accepted it as", err)
        self.assertIn("--by names", self.refused(self.a, "policy", "accept", slice_id, "POL-privacy-02", "--by", "x", "--reason", "Accepted for the pilot."))


class StatusTest(IssuesBase):
    def setUp(self):
        super().setUp()
        self.project_and_epic()

    def test_rows_carry_their_own_jira_key(self):
        first, second = self.drafted(), self.drafted(title="Remove a teammate")
        self.ok(self.a, "slice", "link", first, "--jira", "TEAM-12")
        self.ok(self.a, "epic", "link", "EPIC-001", "--jira", "TEAM-1")
        status = self.ok(self.a, "status")
        rows = {row["slice_id"]: row for row in status["slices"]}
        self.assertEqual(rows[first]["tracking"], {"jira": "TEAM-12"})
        self.assertNotIn("tracking", rows[second], "a slice without a key of its own has none; its epic's is on the epic's row")
        self.assertEqual(status["epics"][0]["tracking"], {"jira": "TEAM-1"})
        self.ok(self.a, "epic", "link", "EPIC-001", "--no-jira")
        self.assertNotIn("tracking", self.ok(self.a, "status")["epics"][0])

    def test_unpublished_principles_are_not_saved(self):
        self.assertTrue(self.ok(self.a, "status")["saved"]["everything_saved"])
        self.ok(self.a, "principle", "add", "--title", "Versions stay", "--statement", STATEMENT, "--reason", "Readers rely on what they saw.")
        saved = self.ok(self.a, "--app", "status")["saved"]
        self.assertFalse(saved["everything_saved"])
        (entry,) = saved["not_saved"]
        self.assertEqual((entry["kind"], entry["target"]), ("principles_unpublished", None))
        self.assertIsNone(COMMAND.search(entry["text"]))
        self.assertIsNone(COMMAND.search(self.ok(self.a, "--app", "status")["principles"]["next"]))
        self.assertIn("(principle publish)", self.ok(self.a, "status")["principles"]["next"], "the terminal keeps its command")
        self.lose("issue comment")
        self.refused(self.a, "principle", "publish")
        self.assertEqual([item["kind"] for item in self.ok(self.a, "status")["saved"]["not_saved"]], ["principles_unfinished"])
        self.ok(self.a, "principle", "publish")
        self.assertTrue(self.ok(self.a, "status")["saved"]["everything_saved"])

    def test_the_new_notes_name_no_command_in_the_app(self):
        added = self.ok(self.a, "--app", "principle", "add", "--title", "Versions stay", "--statement", STATEMENT, "--reason", "Readers rely on it.")
        self.assertIsNone(COMMAND.search(added["note"]), added["note"])
        self.assertIn("(principle publish)", self.ok(self.a, "principle", "set", "PP-01", "--reason", "Readers rely on what they saw.")["note"])


class EffectsLineTest(unittest.TestCase):
    def test_each_row_carries_its_line_in_the_spec(self):
        text = effects(FIXTURE, "| SLICE-001/FR-01 | kept | AC-01 | Still holds. |", "| SLICE-001/FR-02 | changed | FR-02 | |")
        _, model = validate_slice.analyze(text, FIXTURE_NAME)
        lines = text.splitlines()
        self.assertEqual([lines[row["line"] - 1].split("|")[1].strip() for row in model["effects"]], ["SLICE-001/FR-01", "SLICE-001/FR-02"])


class SliceShowPrdTest(prd_tests.PrdBase):
    def test_show_carries_the_prd_field_and_changes_nothing(self):
        self.applied()
        self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Something else")
        self.ok("slice", "resume", "SLICE-003")
        shown = self.ok("slice", "show", "SLICE-002")
        self.assertEqual(self.ok("status")["current_slice"], "SLICE-003", "slice show never changes the current slice")
        self.assertEqual(shown["prd"], self.ok("slice", "resume", "SLICE-002")["prd"], "the same field as slice resume")
        self.assertNotIn("prd", self.ok("slice", "show", "SLICE-003"))

    def test_the_prd_notes_in_the_app_name_no_command(self):
        self.applied()
        shown = json.loads(self.run_studio("--app", "slice", "show", "SLICE-002")[1])
        self.assertIsNone(COMMAND.search(shown["prd"]["note"]), shown["prd"]["note"])
        self.assertIn("(prd draft)", self.ok("slice", "show", "SLICE-002")["prd"]["note"])
        code, _, err = self.run_studio("--app", "prd", "confirm", "SLICE-002", "--accept", "all")
        self.assertEqual(code, 1)
        self.assertIsNone(COMMAND.search(err), err)


if __name__ == "__main__":
    unittest.main()
