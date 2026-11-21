"""Tests for tests/affected.py: which test classes a change selects, and that it fails safe."""

import io
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
import affected  # noqa: E402


class SelectTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.graph = affected.Map()  # parsing the repository once serves every test here; nothing writes to it

    def select(self, *changed):
        return affected.select(list(changed), self.graph)

    def reaching(self, name):
        names, _ = affected.in_parallel.classes()
        return set(affected.reaching(self.graph, names, affected.class_nodes(names), name))

    def test_a_changed_script_selects_the_tests_that_load_it(self):
        # notify.py is imported by its own tests and loaded by run.py, which most classes drive.
        hits = self.reaching("skills/run/scripts/notify.py")
        self.assertTrue({name for name in hits if name.startswith("test_mach_notify.")})
        self.assertTrue({name for name in hits if name.startswith("test_run.")})

    def test_a_script_loaded_by_path_selects_the_tests_that_run_its_loader(self):
        # change_record.py is loaded by path from merge.py and review.py; test_merge only imports merge.
        hits = self.reaching("skills/merge/scripts/change_record.py")
        self.assertTrue({name for name in hits if name.startswith("test_merge.")})
        self.assertTrue({name for name in hits if name.startswith("test_change_record.")})

    def test_a_script_most_classes_reach_runs_everything_and_says_why(self):
        everything, chosen, _, names = self.select("skills/run/scripts/run.py")
        self.assertIn("skills/run/scripts/run.py: reached by", everything)
        self.assertEqual(chosen, {})

    def test_a_fixture_selects_only_the_tests_that_name_it(self):
        everything, chosen, _, names = self.select("tests/fixtures/scans/sample.sarif")
        self.assertIsNone(everything)
        self.assertTrue({name for name in chosen if name.startswith("test_ticket_scans.")})
        self.assertFalse({name for name in chosen if name.startswith("test_review.")})
        self.assertLess(len(chosen), len(names) // 4)

    def test_a_file_read_through_a_helper_selects_the_class_that_calls_it(self):
        # InstructionsTest reads with `read = lambda *parts: ROOT.joinpath(*parts).read_text()`, called with literal parts
        # and, in a loop, with `read(*path)`; the ten-commit check found the first form missed before it was followed.
        hits = self.reaching("skills/product-studio/SKILL.md") & self.reaching("templates/REVIEW.md")
        self.assertIn("test_mach_policy_packs.InstructionsTest", hits)

    def test_a_changed_test_module_selects_its_own_classes_and_its_importers(self):
        everything, chosen, _, _ = self.select("tests/test_mach_product_issues.py")
        self.assertIsNone(everything)
        modules = {name.split(".")[0] for name in chosen}
        self.assertIn("test_mach_product_issues", modules)
        self.assertIn("test_mach_product_intake", modules)  # it imports IssuesBase from there

    def test_a_file_nothing_names_selects_everything_and_says_why(self):
        everything, chosen, _, names = self.select("somewhere-new/unknown.cfg")
        self.assertIn("no test or script names it", everything)
        self.assertEqual(chosen, {})

    def test_a_docs_change_no_test_reads_selects_nothing(self):
        everything, chosen, unread, _ = self.select("docs/mach-next/NOT_A_REAL_NOTE.md")
        self.assertIsNone(everything)
        self.assertEqual((chosen, unread), ({}, ["docs/mach-next/NOT_A_REAL_NOTE.md"]))
        out = io.StringIO()
        with redirect_stdout(out):
            code = affected.main(["--list", "docs/mach-next/NOT_A_REAL_NOTE.md"])
        self.assertEqual(code, 0)
        self.assertIn("No test reads docs/mach-next/NOT_A_REAL_NOTE.md", out.getvalue())
        self.assertIn("nothing to run", out.getvalue())

    def test_shared_runners_and_helpers_select_everything(self):
        for name in ("tests/in_parallel.py", "Makefile", "skills/ticket/scripts/issue_rules.py", "tests/adr_baseline_fixture.py"):
            everything, _, _, _ = self.select(name)
            self.assertTrue(everything, name)

    def test_a_tree_scanning_class_is_chosen_for_any_skill_file(self):
        # BoundariesTest walks skills/, agents/, workflows/, templates/ and bin/ looking for callers of current.py.
        everything, chosen, _, _ = self.select("agents/builder.md")
        self.assertIsNone(everything)
        self.assertIn("test_current.BoundariesTest", chosen)

    def test_why_gives_one_line_per_class(self):
        out = io.StringIO()
        with redirect_stdout(out):
            affected.main(["--list", "--why", str(ROOT / "tests/fixtures/scans/sample.sarif")])
        lines = [line for line in out.getvalue().splitlines() if line.startswith("  ")]
        self.assertTrue(lines)
        self.assertTrue(all(line.rstrip().endswith(")") and "(" in line for line in lines))


if __name__ == "__main__":
    unittest.main()
