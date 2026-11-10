"""Tests for the slice validator bundled with the intent skill."""

import ast
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "intent"
sys.path.insert(0, str(SKILL / "scripts"))
import validate_slice  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "SLICE-001-invite-teammate.md"
NAME = FIXTURE.name
GOOD = FIXTURE.read_text(encoding="utf-8")


def rules(text, name=NAME, others=None, ready=False):
    return {f.rule: f.severity for f in validate_slice.validate_text(text, name, others, ready)}


def swap(old, new, text=GOOD):
    assert text.count(old) >= 1, f"fixture no longer contains: {old}"
    return text.replace(old, new, 1)


class FixtureTest(unittest.TestCase):
    def test_example_spec_has_no_findings(self):
        self.assertEqual(validate_slice.validate_text(GOOD, NAME, ready=True), [])

    def test_export_expands_every_rule_into_cases(self):
        _, model = validate_slice.analyze(GOOD, NAME)
        matrix = model["decision_matrix"]
        self.assertTrue(matrix["complete"])
        self.assertEqual(len(matrix["rules"]), 5)
        self.assertEqual(len(matrix["cases"]), 16)
        self.assertEqual(matrix["cases"][0]["id"], "R1-1")
        self.assertEqual(model["slice_id"], "SLICE-001")
        self.assertEqual(model["external_dependencies"], [{"name": "Email delivery service, which sends the invitation email", "failure_requirements": ["FR-06"]}])
        self.assertEqual([d["deferred_to"] for d in model["out_of_scope"]], ["SLICE-002", "SLICE-003", "SLICE-004"])
        self.assertEqual(model["accepted_defaults"][0]["requirements"], ["INV-03"])


class MutationTest(unittest.TestCase):
    """Each broken spec must be caught under the documented rule code."""

    CASES = [
        ("filename", "error", GOOD, "invite.md"),
        ("title", "error", swap("# SLICE-001:", "# SLICE-009:"), NAME),
        ("missing-section", "error", swap("## Preconditions", "## Prerequisites"), NAME),
        ("extra-section", "warning", GOOD + "\n## Notes\n\n- Something.\n", NAME),
        ("summary-format", "error", swap("- **Trigger:** The admin submits one email address on the Members page\n", ""), NAME),
        ("single-actor", "warning", swap("- **Actor:** Workspace admin", "- **Actor:** Workspace admin or owner"), NAME),
        ("template-residue", "error", swap("## Summary", "## Summary\n\n<!-- fill in -->"), NAME),
        ("placeholder", "error", swap("- The workspace's purchased seat count is known", "- <State that must be true>"), NAME),
        ("deferred-pointer", "error", swap(" (Deferred to SLICE-002)", ""), NAME),
        ("inv-keyword", "error", swap("An invitation link MUST stop", "An invitation link SHOULD stop"), NAME),
        ("rfc2119-case", "error", swap("the system SHALL reserve one seat", "the system shall reserve one seat"), NAME),
        ("fr-keyword", "error", swap("the system SHALL reserve one seat", "the system SHALL reserve one seat and MAY notify the owner"), NAME),
        ("ears-label", "error", swap("**FR-01:** [Event-driven]", "**FR-01:** [State-driven]"), NAME),
        ("ears-pattern", "error", swap("When a seat is reserved for an invitee, the system", "When a seat is reserved for an invitee the system"), NAME),
        ("ears-atomic", "error", swap("the system SHALL release the reserved seat.", "the system SHALL release the reserved seat and SHALL tell the admin."), NAME),
        ("implementation-detail", "warning", swap("the system SHALL release the reserved seat.", "the system SHALL release the reserved seat in the database."), NAME),
        ("vague-term", "warning", swap("to the invitee within 60 seconds.", "to the invitee quickly."), NAME),
        ("unparsed-line", "error", swap("- **FR-09:**", "- FR-09:"), NAME),
        ("duplicate-id", "error", swap("- **FR-09:**", "- **FR-08:**"), NAME),
        ("matrix-incomplete", "error", swap("| R4   | Yes          | Yes         | No                        | No             | Rejected with \"All seats are in use. Add seats to invite more people.\" | None | FR-04, INV-01 |\n", ""), NAME),
        ("matrix-conflict", "error", swap("| R2   | Yes          | No ", "| R2   | -            | No "), NAME),
        ("matrix-value", "error", swap("| R5   | Yes          | Yes         | No                        | Yes ", "| R5   | Yes          | Yes         | No                        | Maybe ", swap("| Seat available |", "| Seat available (Yes / No) |")), NAME),
        ("matrix-empty-cell", "error", swap("| Invitation sent | One seat reserved; invitation email sent to the invitee |", "| Invitation sent |  |"), NAME),
        ("matrix-rule-id", "error", swap("| R5   |", "| Rule5 |"), NAME),
        ("message-missing", "warning", swap('Rejected with "Enter a valid email address."', "Rejected"), NAME),
        ("scenario-steps", "error", swap("- **And** the email service is not responding\n", "- **When** the email service stops responding\n"), NAME),
        ("scenario-format", "error", swap("#### AC-02: Invitation link expires", "#### Invitation link expires"), NAME),
        ("trace-uncovered", "error", swap("- **Covers:** INV-03", "- **Covers:** FR-01"), NAME),
        ("trace-undefined", "error", swap("- **Covers:** INV-03", "- **Covers:** INV-03, FR-42"), NAME),
        ("dependency-failure", "error", swap(" (failure: FR-06)", ""), NAME),
        ("dependencies-format", "error", swap("- **Required permissions:** Workspace admin role in the invited workspace\n", ""), NAME),
        ("defaults-format", "error", swap("they are sent (INV-03).", "they are sent."), NAME),
        ("open-question-format", "error", swap("## Open questions\n\n- None.", "## Open questions\n\n- What is the seat price?"), NAME),
        ("empty-section", "error", swap("## Assumptions\n\n- The Members page already shows the seat count; found in docs/members-page.md.", "## Assumptions\n"), NAME),
    ]

    def test_each_mutation_is_reported(self):
        for rule, severity, text, name in self.CASES:
            with self.subTest(rule=rule):
                self.assertEqual(rules(text, name).get(rule), severity)


class OpenQuestionsTest(unittest.TestCase):
    OPEN = swap("## Open questions\n\n- None.", "## Open questions\n\n- What is the seat price? Follow up: Finance team.")

    def test_open_questions_warn_until_ready_is_required(self):
        self.assertEqual(rules(self.OPEN).get("open-questions"), "warning")
        self.assertEqual(rules(self.OPEN, ready=True).get("open-questions"), "error")


class RegistryTest(unittest.TestCase):
    def test_duplicate_id_is_found_in_another_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            mine = Path(tmp) / "cell" / "specs" / "slices"
            main = Path(tmp) / "main" / "specs" / "slices"
            mine.mkdir(parents=True)
            main.mkdir(parents=True)
            (mine / NAME).write_text(GOOD, encoding="utf-8")
            (main / "SLICE-001-something-else.md").write_text(GOOD, encoding="utf-8")
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(validate_slice.main([str(mine / NAME)]), 0)
                code = validate_slice.main(["--registry", str(main), str(mine / NAME)])
            self.assertEqual(code, 1)
            self.assertIn("[duplicate-slice-id]", out.getvalue())

    def test_same_file_in_registry_is_not_a_duplicate(self):
        with tempfile.TemporaryDirectory() as tmp:
            mine = Path(tmp) / "cell"
            main = Path(tmp) / "main"
            for folder in (mine, main):
                folder.mkdir()
                (folder / NAME).write_text(GOOD, encoding="utf-8")
            with redirect_stdout(io.StringIO()):
                self.assertEqual(validate_slice.main(["--registry", str(main), str(mine / NAME)]), 0)

    def test_reserved_id_for_a_different_feature_warns(self):
        other = "### Out of scope\n\n- Exporting invoices as PDF (Deferred to SLICE-001)\n"
        self.assertEqual(rules(GOOD, others={"SLICE-007-billing.md": other}).get("reserved-id"), "warning")


class CommandLineTest(unittest.TestCase):
    def test_export_prints_json_only_when_valid(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(validate_slice.main(["--ready", "--export", str(FIXTURE)]), 0)
        self.assertEqual(json.loads(out.getvalue())["slice_id"], "SLICE-001")
        self.assertIn("READY", err.getvalue())

    def test_unreadable_file_exits_2(self):
        with redirect_stderr(io.StringIO()):
            self.assertEqual(validate_slice.main(["/nonexistent/SLICE-001-x.md"]), 2)


class DocumentationTest(unittest.TestCase):
    def test_every_rule_code_is_documented(self):
        tree = ast.parse((SKILL / "scripts" / "validate_slice.py").read_text(encoding="utf-8"))
        codes = set()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if isinstance(func, ast.Attribute) and func.attr in ("error", "warning") and len(node.args) >= 2:
                if isinstance(node.args[1], ast.Constant):
                    codes.add(node.args[1].value)
            if isinstance(func, ast.Name) and func.id == "check_fields" and isinstance(node.args[2], ast.Constant):
                codes.add(node.args[2].value)
        documented = "".join(p.read_text(encoding="utf-8") for p in (SKILL / "references").glob("*.md"))
        self.assertGreater(len(codes), 35)
        self.assertEqual([code for code in sorted(codes) if f"[{code}]" not in documented], [])


if __name__ == "__main__":
    unittest.main()
