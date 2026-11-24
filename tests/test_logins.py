"""The one rule for a GitHub account name, shared by every place that reads or writes one."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for folder in ("skills/ticket/scripts", "skills/studio/scripts"):
    sys.path.insert(0, str(ROOT / folder))

import collab  # noqa: E402
import issue_rules  # noqa: E402

GOOD = ["octocat", "a", "ada-pm", "A" * 39, "CGR273_cof", "erin-eng_cof", "x_y-z1"]
BAD = ["", "-ada", "ada_", "_cof", "a_b_c", "ada pm", "ada/pm", "A" * 40, "ada_" + "c" * 40, "ada[bot]", "ada\n", None, 7]


class LoginRuleTest(unittest.TestCase):
    def test_the_rule_takes_ordinary_and_enterprise_managed_names_and_nothing_else(self):
        for login in GOOD:
            self.assertTrue(issue_rules.LOGIN_RE.fullmatch(login), login)
            self.assertTrue(collab.is_login(login), login)
        for login in BAD:
            self.assertFalse(isinstance(login, str) and issue_rules.LOGIN_RE.fullmatch(login), login)
            self.assertFalse(collab.is_login(login), login)

    def test_product_studio_keeps_no_copy_of_the_rule(self):
        for name in ("collab.py", "issues.py", "handoff.py", "studio.py", "requests_in.py", "shape.py"):
            text = (ROOT / "skills/studio/scripts" / name).read_text()
            self.assertNotIn("{0,38})\", login", text, name)
            self.assertNotIn("[A-Za-z0-9-]{0,38})\"", text, name)

    def test_an_approval_by_an_enterprise_managed_account_reads_back(self):
        body = issue_rules.approval_comment("SLICE-001", 2, "CGR273_cof", "a" * 64, "b" * 64)
        (found,) = issue_rules.approvals([body])
        self.assertEqual((found["by"], found["revision"]), ("CGR273_cof", 2))

    def test_an_acceptance_by_an_enterprise_managed_account_reads_back(self):
        body = issue_rules.acceptance_comment("EPIC-001", "r1", "c" * 40, "accepted", "CGR273_cof", "d" * 64)
        found = issue_rules.acceptances([{"login": "CGR273_cof", "body": body}], "EPIC-001", "r1", "c" * 40)
        self.assertEqual(len(found), 1, found)

    def test_a_marker_cannot_be_ended_early_by_a_name(self):
        with self.assertRaises(Exception):
            issue_rules.approval_comment("SLICE-001", 1, "ada --> x", "a" * 64, "b" * 64)


if __name__ == "__main__":
    unittest.main()
