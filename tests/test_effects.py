"""Tests for effects.py: the one parser of a slice spec's `## Effects on shipped behaviour` (M13 part B's grammar)."""

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "skills" / "intent" / "scripts" / "effects.py"
_spec = importlib.util.spec_from_file_location("effects_under_test", SCRIPT)
effects = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(effects)

HEAD = "| Shipped rule | Effect | In this slice | Note |\n|---|---|---|---|\n"


def spec(section: str) -> str:
    return "# SLICE-009: Returns\n\n## Summary\n\n- **Actor:** Member\n\n" + section + "\n## Open questions\n\n- None.\n"


def table(*rows: str) -> str:
    return "## Effects on shipped behaviour\n\n" + HEAD + "".join(row + "\n" for row in rows)


def codes(parsed):
    return [item["code"] for item in parsed["problems"]]


class GrammarTest(unittest.TestCase):
    def test_absent_section(self):
        parsed = effects.parse(spec(""))
        self.assertEqual((parsed["present"], parsed["none"], parsed["rows"], parsed["problems"]), (False, False, [], []))

    def test_none(self):
        parsed = effects.parse(spec("## Effects on shipped behaviour\n\nNone.\n"))
        self.assertTrue(parsed["present"] and parsed["none"])
        self.assertEqual((parsed["rows"], parsed["problems"]), ([], []))
        self.assertEqual(parsed["line"], 7)

    def test_the_design_example(self):
        parsed = effects.parse(spec(table("| SLICE-003/FR-02 | kept | AC-04 | A returned item is not overdue. |",
                                          "| SLICE-003/R3 | replaced | FR-05 | |",
                                          "| SLICE-002/INV-01 | retired | | The product manager's reason. |",
                                          "| SLICE-004/FR-11 | changed | INV-02 | |")))
        self.assertEqual(parsed["problems"], [])
        self.assertFalse(parsed["none"])
        self.assertEqual([(r["slice_id"], r["rule_id"], r["effect"], r["in_slice"], r["note"]) for r in parsed["rows"]], [
            ("SLICE-003", "FR-02", "kept", "AC-04", "A returned item is not overdue."),
            ("SLICE-003", "R3", "replaced", "FR-05", ""),
            ("SLICE-002", "INV-01", "retired", None, "The product manager's reason."),
            ("SLICE-004", "FR-11", "changed", "INV-02", ""),
        ])
        self.assertEqual(parsed["rows"][0]["line"], 11)

    def test_an_escaped_bar_stays_in_the_note(self):
        parsed = effects.parse(spec(table("| SLICE-002/INV-01 | retired | | Either a \\| b. |")))
        self.assertEqual(parsed["rows"][0]["note"], "Either a | b.")

    def test_every_problem(self):
        cases = {
            "| SLICE-003/FR-02 | kept | AC-04 |": "effects-row",
            "| SLICE-3/FR-02 | kept | AC-04 | |": "effects-rule",
            "| SLICE-003/AC-02 | kept | AC-04 | |": "effects-rule",
            "| SLICE-003/FR-02 | dropped | AC-04 | |": "effects-unknown-effect",
            "| SLICE-003/FR-02 | Kept | AC-04 | |": "effects-unknown-effect",
            "| SLICE-003/FR-02 | kept | | |": "effects-kept-scenario",
            "| SLICE-003/FR-02 | kept | FR-04 | |": "effects-wrong-id",
            "| SLICE-003/FR-02 | changed | | |": "effects-replacement",
            "| SLICE-003/FR-02 | replaced | AC-01 | |": "effects-wrong-id",
            "| SLICE-003/FR-02 | retired | FR-01 | why |": "effects-wrong-id",
            "| SLICE-003/FR-02 | retired | | |": "effects-retired-note",
        }
        for row, code in cases.items():
            parsed = effects.parse(spec(table(row)))
            self.assertIn(code, codes(parsed), row)
            self.assertEqual(parsed["rows"], [], row)
            self.assertTrue(all(item["line"] == 11 for item in parsed["problems"]), (row, parsed["problems"]))

    def test_duplicate_shipped_rule(self):
        parsed = effects.parse(spec(table("| SLICE-003/FR-02 | kept | AC-04 | |", "| SLICE-003/FR-02 | replaced | FR-01 | |")))
        self.assertEqual(codes(parsed), ["effects-duplicate-rule"])
        self.assertEqual(parsed["problems"][0]["line"], 12)
        self.assertIn("line 11", parsed["problems"][0]["message"])

    def test_table_and_none_together(self):
        parsed = effects.parse(spec("## Effects on shipped behaviour\n\nNone.\n\n" + HEAD + "| SLICE-003/FR-02 | kept | AC-04 | |\n"))
        self.assertIn("effects-none-and-table", codes(parsed))
        self.assertFalse(parsed["none"])

    def test_structure_problems(self):
        self.assertEqual(codes(effects.parse(spec("## Effects on shipped behaviour\n\n"))), ["effects-empty"])
        self.assertEqual(codes(effects.parse(spec("## Effects on shipped behaviour\n\nNone\n"))), ["effects-none"])
        self.assertEqual(codes(effects.parse(spec("## Effects on shipped behaviour\n\nNothing changes.\n"))), ["effects-content"])
        self.assertIn("effects-header", codes(effects.parse(spec("## Effects on shipped behaviour\n\n| Rule | Effect | Here | Note |\n|---|---|---|---|\n| SLICE-003/FR-02 | kept | AC-04 | |\n"))))
        self.assertIn("effects-separator", codes(effects.parse(spec("## Effects on shipped behaviour\n\n| Shipped rule | Effect | In this slice | Note |\n| SLICE-003/FR-02 | kept | AC-04 | |\n"))))
        self.assertIn("effects-no-rows", codes(effects.parse(spec("## Effects on shipped behaviour\n\n" + HEAD))))
        two = effects.parse(spec(table("| SLICE-003/FR-02 | kept | AC-04 | |") + "\n" + HEAD + "| SLICE-003/FR-03 | kept | AC-04 | |\n"))
        self.assertIn("effects-tables", codes(two))
        self.assertIn("effects-content", codes(effects.parse(spec("## Effects on shipped behaviour\n\n### More\n\nNone.\n"))))
        self.assertIn("effects-none", codes(effects.parse(spec("## Effects on shipped behaviour\n\nNone.\nNone.\n"))))

    def test_headings(self):
        wrong = effects.parse(spec("## Effects on shipped behavior\n\nNone.\n"))
        self.assertFalse(wrong["present"])
        self.assertEqual(codes(wrong), ["effects-heading"])
        level = effects.parse(spec("### Effects on shipped behaviour\n\nNone.\n"))
        self.assertEqual(codes(level), ["effects-heading"])
        twice = effects.parse(spec("## Effects on shipped behaviour\n\nNone.\n\n## Effects on shipped behaviour\n\n" + HEAD))
        self.assertEqual(codes(twice), ["effects-duplicate"])
        self.assertTrue(twice["none"])

    def test_fences_and_comments(self):
        fenced = "```\n## Effects on shipped behaviour\n\nNone.\n```\n"
        self.assertFalse(effects.parse(spec(fenced))["present"], "a heading inside a code block is not the section")
        commented = effects.parse(spec("## Effects on shipped behaviour\n\n<!-- write None. or the table -->\nNone.\n"))
        self.assertEqual((commented["none"], commented["problems"]), (True, []))
        block = effects.parse(spec("## Effects on shipped behaviour\n\n```\nNone.\n```\n"))
        self.assertIn("effects-content", codes(block))

    def test_total(self):
        for value in (None, 42, "", "## Effects on shipped behaviour", "|||", "## Effects on shipped behaviour\n|", "\x00" * 10):
            parsed = effects.parse(value)
            self.assertIsInstance(parsed["problems"], list)
        self.assertEqual(effects.describe({"line": 3, "message": "x"}), "line 3: x")
        self.assertEqual(effects.describe({"line": 0, "message": "x"}), "x")


class CheckTest(unittest.TestCase):
    ROWS = table("| SLICE-003/FR-02 | kept | AC-04 | |", "| SLICE-003/R3 | replaced | FR-05 | |", "| SLICE-002/INV-01 | retired | | why |")

    def test_found(self):
        parsed = effects.parse(spec(self.ROWS))
        shipped = ["SLICE-003/FR-02", "SLICE-003/R3", "SLICE-002/INV-01"]
        self.assertEqual(effects.check(parsed, shipped, slice_id="SLICE-009", own_ids={"AC-04", "FR-05"}), [])
        self.assertEqual(effects.check(parsed, {key: None for key in shipped}), [])
        self.assertEqual(effects.check(parsed, [{"rule": key, "in_force": True} for key in shipped]), [])

    def test_not_found(self):
        parsed = effects.parse(spec(self.ROWS))
        found = effects.check(parsed, ["SLICE-003/FR-02"])
        self.assertEqual([item["code"] for item in found], ["effects-not-shipped", "effects-not-shipped"])
        self.assertIn("SLICE-003 has no R3", found[0]["message"])
        self.assertIn("no spec of SLICE-002 has shipped", found[1]["message"])

    def test_not_in_force_says_what_took_its_place(self):
        parsed = effects.parse(spec(table("| SLICE-003/FR-02 | kept | AC-04 | |", "| SLICE-002/INV-01 | kept | AC-04 | |")))
        shipped = [{"rule": "SLICE-003/FR-02", "in_force": False, "superseded_by": [{"effect": "replaced", "by": "SLICE-005/FR-01", "slice_id": "SLICE-005"}]},
                   {"rule": "SLICE-002/INV-01", "in_force": False, "superseded_by": [{"effect": "retired", "by": None, "slice_id": "SLICE-004"}]}]
        found = effects.check(parsed, shipped)
        self.assertEqual([item["code"] for item in found], ["effects-not-in-force"] * 2)
        self.assertIn("replaced by SLICE-005/FR-01", found[0]["message"])
        self.assertIn("retired by SLICE-004", found[1]["message"])

    def test_own_slice_and_own_ids(self):
        parsed = effects.parse(spec(table("| SLICE-009/FR-02 | kept | AC-04 | |", "| SLICE-003/R3 | replaced | FR-05 | |")))
        found = effects.check(parsed, ["SLICE-009/FR-02", "SLICE-003/R3"], slice_id="SLICE-009", own_ids={"AC-04"})
        self.assertEqual([item["code"] for item in found], ["effects-own-slice", "effects-not-in-this-slice"])

    def test_pure(self):
        source = SCRIPT.read_text()
        for word in ("open(", "subprocess", "print(", "read_text", "Path("):
            self.assertNotIn(word, source, word)


if __name__ == "__main__":
    unittest.main()
