"""Mermaid diagrams in a plan and in an ADR an agent writes: only allowed kinds, small, closed, with nothing but the picture.

Slice specs carry none, and ADRs people write are theirs: the check applies to what an agent wrote (check-plan, adr new)."""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills/intent/scripts"))
sys.path.insert(0, str(ROOT / "tests"))

import diagrams  # noqa: E402
import adr  # noqa: E402
import test_adr as base  # noqa: E402

FLOW = "flowchart LR\n  Web[Web app] --> API[Invitations API]\n  API --> Store[(Invitations store)]"
BLOCK = f"```mermaid\n{FLOW}\n```\n"


class RulesTest(unittest.TestCase):
    def test_a_small_diagram_of_an_allowed_kind_is_in_order(self):
        for kind in diagrams.KINDS:
            with self.subTest(kind=kind):
                self.assertEqual(diagrams.problems(f"# Plan\n\n```mermaid\n{kind}\n  A --> B\n```\n"), [])
        self.assertEqual(diagrams.problems("# No picture here\n\n```python\nprint('```mermaid')\n```\n"), [], "another language's block is not a diagram")
        self.assertEqual(diagrams.problems("~~~mermaid\n%% a comment first\nsequenceDiagram\n  A->>B: ask\n~~~\n"), [])

    def test_what_is_refused_and_in_which_words(self):
        cases = {
            "line 3: the mermaid block is never closed": "# Plan\n\n```mermaid\nflowchart TD\n  A --> B\n",
            "opens with 'gantt', which is not a kind MACH allows": "```mermaid\ngantt\n  title Schedule\n```\n",
            "is empty": "```mermaid\n\n```\n",
            "has 41 lines, and at most 40 are allowed": "```mermaid\nflowchart TD\n" + "".join(f"  A{n} --> B{n}\n" for n in range(40)) + "```\n",
            "has a line over 200 characters": "```mermaid\nflowchart TD\n  A[" + "x" * 200 + "]\n```\n",
            "carries a click action": '```mermaid\nflowchart TD\n  A --> B\n  click A callback\n```\n',
            "carries a link": "```mermaid\nflowchart TD\n  A[see https://example.com] --> B\n```\n",
            "carries a renderer directive": "```mermaid\n%%{init: {'securityLevel': 'loose'}}%%\nflowchart TD\n  A --> B\n```\n",
            "carries HTML other than a line break": "```mermaid\nflowchart TD\n  A[<img src=x>] --> B\n```\n",
            "3 diagrams, and at most 2 are allowed in one document": BLOCK * 3,
        }
        for expected, text in cases.items():
            with self.subTest(expected=expected):
                found = diagrams.problems(text, "plan.md")
                self.assertTrue(any(expected in item for item in found), found)
                self.assertTrue(all(item.startswith("plan.md: ") for item in found))

    def test_a_line_break_and_a_stereotype_inside_a_diagram_are_not_refused(self):
        self.assertEqual(diagrams.problems("```mermaid\nclassDiagram\n  class Store {\n    <<interface>>\n  }\n  A[one<br/>two]\n```\n"), [])


class PlanTest(base.Project):
    def test_a_plan_with_a_diagram_passes(self):
        self.spec_ready()
        plan = base.PLAN_ADR + "\n## How the parts fit\n\n" + BLOCK
        code, out, err = self.check(plan)
        self.assertEqual(code, 0, err + out)
        self.assertEqual(self.cell_json()["stage"], "planned")

    def test_a_plan_with_a_diagram_of_another_kind_is_refused_and_stays_unplanned(self):
        self.spec_ready()
        code, out, _ = self.check(base.PLAN_ADR + "\n## Schedule\n\n```mermaid\ngantt\n  title When\n```\n")
        self.assertEqual(code, 1, out)
        self.assertIn("plan.md: the diagram at line", out)
        self.assertIn("opens with 'gantt', which is not a kind MACH allows", out)
        self.assertEqual(self.cell_json()["stage"], "spec-ready")

    def test_a_class_stereotype_in_a_plans_diagram_is_not_taken_for_a_placeholder(self):
        self.spec_ready()
        plan = base.PLAN_ADR + "\n## Shape\n\n```mermaid\nclassDiagram\n  class Store {\n    <<interface>>\n  }\n```\n"
        code, out, err = self.check(plan)
        self.assertEqual(code, 0, err + out)

    def test_a_proposed_adr_may_carry_a_diagram_and_a_bad_one_is_refused(self):
        self.spec_ready()
        drafted = self.draft()
        path = Path(drafted["path"])
        named = base.PLAN_ADR.replace("ADR-0001", "ADR-0001, ADR-0002")
        good = path.read_text()
        path.write_text(good + "\n" + BLOCK.replace("flowchart LR", "pie"))
        code, out, _ = self.check(named)
        self.assertEqual(code, 1, out)
        self.assertIn(f"{drafted['file']}: the diagram at line", out)
        self.assertIn("opens with 'pie'", out)
        path.write_text(good + "\n" + BLOCK)
        code, out, err = self.check(named)
        self.assertEqual(code, 0, err + out)
        self.assertIn("```mermaid", (self.cellroot / "adrs" / "ADR-0002.md").read_text(), "the copy kept in the cell carries the picture")


class NewTest(base.Project):
    ARGV = ("adr", "new", "--title", "Route invitations through one service", "--context", "Two parts send invitations today.",
            "--decision", "One invitations service sends them all.")

    def test_adr_new_draws_the_diagram_under_the_decision(self):
        (self.project / ".factory").mkdir(exist_ok=True)
        code, out, err = self.run_cmd(*self.ARGV, "--diagram", FLOW)
        self.assertEqual(code, 0, err)
        text = (self.project / json.loads(out)["file"]).read_text()
        self.assertIn("One invitations service sends them all.\n\n```mermaid\n" + FLOW + "\n```\n", text)
        record = adr.parse(text, "0002-route-invitations-through-one-service.md")
        self.assertEqual((record["status"], record["problems"]), ("proposed", []), "the file still reads as an ADR")

    def test_adr_new_refuses_a_diagram_it_does_not_allow_and_writes_nothing(self):
        (self.project / ".factory").mkdir(exist_ok=True)
        before = sorted(path.name for path in (self.project / "docs/adr").iterdir())
        for diagram, expected in (("gantt\n  title When", "opens with 'gantt'"), ("```mermaid\n" + FLOW + "\n```", "without the ``` lines"),
                                  (FLOW + "\n  click Web callback", "carries a click action")):
            with self.subTest(expected=expected):
                code, _, err = self.run_cmd(*self.ARGV, "--diagram", diagram)
                self.assertEqual(code, 1)
                self.assertIn(expected, err)
        self.assertEqual(sorted(path.name for path in (self.project / "docs/adr").iterdir()), before)


class InstructionsTest(unittest.TestCase):
    def test_the_briefs_say_when_a_diagram_belongs_and_that_specs_carry_none(self):
        brief = (ROOT / "skills/intent/references/contracts-and-plan.md").read_text()
        self.assertIn("A diagram, only where a picture carries the decision.", brief)
        self.assertIn("Never put a diagram in the slice spec", brief)
        skill = (ROOT / "skills/run/SKILL.md").read_text()
        self.assertIn("Never ask the engineer to write Mermaid.", skill)
        for kind in ("flowchart", "sequenceDiagram", "stateDiagram-v2", "erDiagram", "classDiagram"):
            self.assertIn(kind, brief)
            self.assertIn(kind, diagrams.KINDS)

    def test_the_slice_template_and_the_interview_method_do_not_offer_a_diagram(self):
        for name in ("spec-structure.md", "interview-method.md"):
            self.assertNotIn("mermaid", (ROOT / "skills/intent/references" / name).read_text().lower(), name)


if __name__ == "__main__":
    unittest.main()
