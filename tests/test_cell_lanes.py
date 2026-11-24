"""Tests for the plan stage's part of building one plan in lanes (M22, piece B): the plan's two optional additions,
what check-plan refuses in them, and the `lanes` it prints for such a plan unless build.max_lanes is 1 (it defaults to 3).

A plan written without the additions is checked exactly as before: the old-plan tests below cover every plan the
test suite writes and the plan template. The tests that need the lane calculator (skills/build/scripts/lanes.py,
piece A) are skipped where it is not installed."""

import ast
import json
import shutil
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
import test_cell  # noqa: E402  (its Base, the spec fixture and the plan the plan-stage tests use)
from test_cell import PLAN, SPEC_NAME, run  # noqa: E402

cell = test_cell.cell
HAS_LANES = (ROOT / "skills" / "build" / "scripts" / "lanes.py").is_file()

PARTS_TASKS = """## Tasks

Test command: `npx vitest run`

### Before the lanes
- [ ] T01 [test] Invitation model — `tests/model.test.ts` (INV-01)
- [ ] T02 [impl] Invitation model — `src/model.ts` (INV-01)

### Lanes
- [ ] T03 [test] Table-driven test of rules R1 to R5, 16 cases — `tests/invite.test.ts` (FR-01, FR-02, FR-03, FR-04, FR-05, FR-07, INV-02, INV-04)
- [ ] T04 [impl] Invitation service — `src/invite.ts` (FR-01, FR-02, FR-03, FR-04, FR-05, FR-07)
- [ ] T05 [test] Expiry — `tests/expiry.test.ts` (FR-06, FR-09, INV-03)
- [ ] T06 [impl] Expiry — `src/expiry.ts` (FR-06, FR-09, after T02)

### After the lanes
- [ ] T07 [test] Scenarios — `tests/invite.scenarios.test.ts` (AC-01, AC-02, AC-03, FR-08)
- [ ] T08 [impl] Failure handling and the route — `src/routes.ts` (FR-08)

## File touch map

| File | Change | Tasks |
|------|--------|-------|
| `src/model.ts` | create | T02 |
| `src/invite.ts` | create | T04 |
| `src/expiry.ts` | create | T06 |
| `src/routes.ts` | create | T08 |
"""

PARTS_PLAN = PLAN.split("## Tasks")[0] + PARTS_TASKS + "\n## Engineering decisions" + PLAN.split("## Engineering decisions")[1]


def written_plans():
    """Every plan the test suite writes (a string holding '## Tasks' and a task line), and the plan template."""
    plans = {"skills/intent/assets/plan-template.md": (ROOT / "skills/intent/assets/plan-template.md").read_text(encoding="utf-8")}
    for path in sorted((ROOT / "tests").glob("test_*.py")):
        if path.name == Path(__file__).name:
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and "## Tasks" in node.value and "[ ] T0" in node.value:
                plans[f"{path.name}:{node.lineno}"] = node.value
    return plans


def task_section(text):
    return cell.markdown_sections(text).get("Tasks", [])


class OldPlansTest(unittest.TestCase):
    """Nothing changes for a plan written the old way."""

    def test_every_plan_the_suite_writes_and_the_template_use_neither_addition(self):
        plans = written_plans()
        self.assertGreater(len(plans), 5, "the suite's plans were found")
        for name, text in plans.items():
            with self.subTest(plan=name):
                parts = cell.lane_parts(task_section(text))
                self.assertFalse(parts["used"])
                self.assertEqual(cell.lane_problems(parts, {}), [])
                self.assertEqual({task["part"] for task in parts["tasks"]} - {"lanes"}, set())

    def test_an_after_in_a_tasks_prose_is_not_a_mark(self):
        line = "- [ ] T03 [impl] Retry after T02 fails — `src/retry.ts` (FR-01)"
        self.assertEqual(cell.lane_parts([line])["tasks"][0]["after"], [])
        self.assertFalse(cell.lane_parts([line])["used"])

    def test_other_sub_headings_alone_leave_a_plan_as_it_was(self):
        parts = cell.lane_parts(["### Backend", "- [ ] T01 [test] A — `tests/a.py` (FR-01)", "### Frontend", "- [ ] T02 [impl] A — `a.py` (FR-01)"])
        self.assertFalse(parts["used"])
        self.assertEqual(cell.lane_problems(parts, {}), [])


class PlanProject(test_cell.Base):
    """A groomed ticket whose plan.md a test writes; no tests of its own."""

    def ready(self, plan, config=None):
        info = self.groom()
        run("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}", project=self.project)
        contract = Path(info["workdir"]) / "proto/openapi/members.yaml"
        contract.parent.mkdir(parents=True)
        contract.write_text("openapi: 3.1.0\n")
        Path(info["plan_path"]).write_text(plan, encoding="utf-8")
        if config is not None:
            (self.project / ".factory" / "config.json").write_text(json.dumps(config), encoding="utf-8")
        return info

    def check(self, plan, config=None):
        self.ready(plan, config)
        return run("check-plan", "LOCAL-001", project=self.project)

    def fresh(self):
        """Start again from no ticket, for a test that checks several plans."""
        cell_dir = self.project / ".factory" / "worktrees" / "LOCAL-001"
        if cell_dir.exists():
            test_cell.git(self.project, "worktree", "remove", "--force", str(cell_dir / "repo"))
            test_cell.git(self.project, "branch", "-D", "feature/LOCAL-001")
            shutil.rmtree(str(self.project / ".factory"))


class OldPlanCheckTest(PlanProject):
    def test_an_old_plan_never_loads_the_lane_calculator_and_prints_what_it_printed(self):
        # Decided from the plan, not the setting: on by default (absent), off (1), on (3), and unusable values.
        settings = {"absent": None, "1": {"build": {"max_lanes": 1}}, "3": {"build": {"max_lanes": 3}}, "text": {"build": {"max_lanes": "3"}},
                    "true": {"build": {"max_lanes": True}}, "zero": {"build": {"max_lanes": 0}}}
        outputs = {}
        for name, config in settings.items():
            with self.subTest(setting=name):
                self.fresh()
                self.ready(PLAN.replace("## Tasks\n", "## Tasks\n\n### Backend\n"), config)
                with mock.patch.object(cell, "lanes_module", side_effect=AssertionError("an old plan loaded lanes.py")):
                    code, out, _ = run("check-plan", "LOCAL-001", project=self.project)
                self.assertEqual(code, 0, out)
                printed = json.loads(out[out.index("{"):])
                self.assertEqual(list(printed), ["status", "app_type", "risk", "contracts", "tasks", "adrs"])
                outputs[name] = out
        self.assertEqual(len(set(outputs.values())), 1, "an old plan prints the same whatever the setting")


class PartsCheckTest(PlanProject):
    def test_a_plan_in_parts_is_accepted(self):
        code, out, _ = self.check(PARTS_PLAN, {"build": {"max_lanes": 1}})
        self.assertEqual(code, 0, out)
        self.assertNotIn('"lanes"', out, "at build.max_lanes 1 PLANNED says nothing about lanes")
        parts = cell.lane_parts(task_section(PARTS_PLAN))
        self.assertEqual([(task["id"], task["part"]) for task in parts["tasks"]],
                         [("T01", "before"), ("T02", "before"), ("T03", "lanes"), ("T04", "lanes"), ("T05", "lanes"), ("T06", "lanes"),
                          ("T07", "after"), ("T08", "after")])
        self.assertEqual(parts["tasks"][5]["after"], ["T02"])

    def test_without_the_lane_calculator_a_plan_in_parts_is_still_checked_and_accepted(self):
        with mock.patch.object(cell, "lanes_module", return_value=None):
            code, out, _ = self.check(PARTS_PLAN)
        self.assertEqual(code, 0, out)
        self.assertNotIn('"lanes"', out)

    def test_the_mistakes_in_parts_and_marks_are_refused_in_plain_sentences(self):
        cases = {
            "'### Backend' under '## Tasks' is not one of the plan's parts. Use only '### Before the lanes', '### Lanes' and '### After the lanes'":
                PARTS_PLAN.replace("### Lanes\n", "### Lanes\n### Backend\n"),
            "'### Lanes' appears twice under '## Tasks'. Each part comes once":
                PARTS_PLAN.replace("- [ ] T05 [test]", "### Lanes\n- [ ] T05 [test]"),
            "'### Before the lanes' comes after '### Lanes'. The parts go in the order Before the lanes, Lanes, After the lanes":
                PARTS_PLAN.replace("### Before the lanes\n", "").replace("### Lanes\n", "### Lanes\n### Before the lanes\n"),
            "T01 (`tests/model.test.ts`) comes before the first part heading under '## Tasks'. When the plan has parts, every task is in one: put T01 under":
                PARTS_PLAN.replace("### Before the lanes\n- [ ] T01 [test] Invitation model — `tests/model.test.ts` (INV-01)\n",
                                   "- [ ] T01 [test] Invitation model — `tests/model.test.ts` (INV-01)\n### Before the lanes\n"),
            "T06 says 'after T09', but the plan has no task T09. Name the earlier task whose work T06 needs, or remove the mark":
                PARTS_PLAN.replace("after T02", "after T09"),
            "T04 says 'after T06', but T06 does not come before it. A task can only wait for an earlier one: move T06 above T04, or remove the mark":
                PARTS_PLAN.replace("FR-05, FR-07)\n- [ ] T05", "FR-05, FR-07, after T06)\n- [ ] T05"),
            "T08 says 'after T07', but T07 is after the lanes, where tasks are built one at a time in plan order anyway. Remove the mark from T08":
                PARTS_PLAN.replace("`src/routes.ts` (FR-08)", "`src/routes.ts` (FR-08, after T07)"),
            "T01 [test] (`tests/model.test.ts`) is before the lanes and tests FR-01, but no [impl] task before the lanes names it, so every lane "
            "would start from a failing suite. Put the [impl] task that makes T01 pass before the lanes too, or move T01 into '### Lanes' beside its code":
                PARTS_PLAN.replace("`tests/model.test.ts` (INV-01)", "`tests/model.test.ts` (INV-01, FR-01)"),
        }
        for expected, plan in cases.items():
            with self.subTest(expected=expected[:40]):
                self.assertNotEqual(plan, PARTS_PLAN)
                self.fresh()
                code, out, _ = self.check(plan)
                self.assertEqual(code, 1, out)
                self.assertIn(f"error: plan.md: {expected}", out)
                self.assertEqual(json.loads((self.project / ".factory/worktrees/LOCAL-001/cell.json").read_text())["stage"], "spec-ready")

    def test_an_after_mark_alone_is_checked_and_puts_every_task_in_the_lanes_part(self):
        marked = PLAN.replace("`src/invite.ts` (FR-06, FR-08)", "`src/invite.ts` (FR-06, FR-08, after T05)")
        parts = cell.lane_parts(task_section(marked))
        self.assertTrue(parts["used"])
        self.assertEqual({task["part"] for task in parts["tasks"]}, {"lanes"})
        code, out, _ = self.check(marked)
        self.assertEqual(code, 1, out)
        self.assertIn("T04 says 'after T05', but the plan has no task T05", out)

    def test_an_invariant_alone_does_not_hold_the_lanes_back(self):
        # T01 names only INV-01 before the lanes, which an [impl] task keeps rather than makes pass: no refusal.
        self.assertEqual(cell.lane_problems(cell.lane_parts(task_section(PARTS_PLAN.replace("`src/model.ts` (INV-01)", "`src/model.ts` (FR-01)"))), {}), [])


class LaneUnreachableGreenTest(unittest.TestCase):
    def test_each_lanes_own_sequence_is_checked(self):
        lines = ["- [ ] T01 [test] A — `tests/a.py` (FR-01)", "- [ ] T02 [impl] A part — `a.py` (FR-02)", "- [ ] T03 [impl] A — `b.py` (FR-01)"]
        parts = cell.lane_parts(lines)
        found = cell.lanes_unreachable_green(parts, {"lanes": [{"lane": "L1", "tasks": ["T01", "T02", "T03"]}]})
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0].startswith("in lane L1: T03 [impl] implements FR-01, but every [test] task for them (the last is T01) comes before T02 [impl]"))
        self.assertEqual(cell.lanes_unreachable_green(parts, {"lanes": [{"lane": "L1", "tasks": ["T01", "T03"]}, {"lane": "L2", "tasks": ["T02"]}]}), [])


class MaxLanesTest(test_cell.Base):
    with_git = False

    def test_a_whole_number_is_taken_as_given_and_anything_else_is_the_default(self):
        self.assertEqual(cell.DEFAULT_MAX_LANES, 3)
        (self.project / ".factory").mkdir()
        self.assertEqual(cell.max_lanes(self.project), 3, "no config file")
        for value, expected in ((None, 3), (2, 2), (1, 1), (0, 3), (-3, 3), ("2", 3), (True, 3), (2.0, 3), (4, 4)):
            with self.subTest(value=value):
                (self.project / ".factory" / "config.json").write_text(json.dumps({"build": {} if value is None else {"max_lanes": value}}))
                self.assertEqual(cell.max_lanes(self.project), expected)


@unittest.skipUnless(HAS_LANES, "needs the lane calculator, skills/build/scripts/lanes.py (piece A)")
class LanesOutputTest(PlanProject):
    def test_planned_shows_the_lanes_when_max_lanes_is_above_one(self):
        code, out, _ = self.check(PARTS_PLAN, {"build": {"max_lanes": 2}})
        self.assertEqual(code, 0, out)
        lanes = json.loads(out[out.index("{"):])["lanes"]
        self.assertEqual(lanes["count"], 2)
        self.assertEqual((lanes["before"], lanes["after"]), (["T01", "T02"], ["T07", "T08"]))
        self.assertEqual([lane["tasks"] for lane in lanes["lanes"]], [["T03", "T04"], ["T05", "T06"]])
        self.assertEqual([lane["lane"] for lane in lanes["lanes"]], ["L1", "L2"])

    def test_planned_shows_the_lanes_by_default(self):
        code, out, _ = self.check(PARTS_PLAN)
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out[out.index("{"):])["lanes"]["count"], 2)

    def test_at_max_lanes_one_the_lanes_are_checked_but_not_printed(self):
        code, out, _ = self.check(PARTS_PLAN, {"build": {"max_lanes": 1}})
        self.assertEqual(code, 0, out)
        self.assertNotIn('"lanes"', out)

    def test_the_calculator_gives_a_reason_for_every_join(self):
        lane_plan = cell.lanes_module().plan(PLAN, *cell.plan_tasks(PLAN))
        self.assertEqual([lane["tasks"] for lane in lane_plan["lanes"]], [["T01", "T02", "T03", "T04"]])
        self.assertTrue(lane_plan["joined_because"], "the output says why the tasks were joined")

    def test_the_calculator_reads_the_parts_and_marks_as_check_plan_does(self):
        lanes = cell.lanes_module()
        tasks, _ = cell.plan_tasks(PARTS_PLAN)
        annotated = lanes.annotate(PARTS_PLAN, tasks)
        mine = cell.lane_parts(task_section(PARTS_PLAN))["tasks"]
        self.assertEqual([(t["id"], t["phase"], list(t["after"])) for t in annotated], [(t["id"], t["part"], t["after"]) for t in mine])
        self.assertEqual(lanes.problems(PARTS_PLAN, *cell.plan_tasks(PARTS_PLAN)), [])

    def test_check_plan_and_the_calculator_read_the_tasks_section_alike(self):
        # Where the two readers could differ. A task above the first heading has no part for check-plan, which refuses it;
        # the calculator counts it before the lanes and reports it as a problem too: both refuse, so None reads as "before".
        lanes = cell.lanes_module()
        cases = {
            "letter case and spaces": PARTS_PLAN.replace("### Before the lanes", "### before the LANES").replace("### Lanes", "###   lanes")
                                                .replace("### After the lanes", "### After  the  lanes"),
            "an unknown heading": PARTS_PLAN.replace("- [ ] T05 [test]", "### Backend\n- [ ] T05 [test]"),
            "a task above the first heading": PARTS_PLAN.replace("### Before the lanes\n- [ ] T01 [test] Invitation model — `tests/model.test.ts` (INV-01)\n",
                                                                 "- [ ] T01 [test] Invitation model — `tests/model.test.ts` (INV-01)\n### Before the lanes\n"),
            "repeated and lower-case after": PARTS_PLAN.replace("(FR-06, FR-09, after T02)", "(FR-06, FR-09, after T02, After t02, after T01)"),
            "an after in the prose only": PARTS_PLAN.replace("T06 [impl] Expiry —", "T06 [impl] Expiry after T04 —"),
            "no headings, one mark": PLAN.replace("`src/invite.ts` (FR-06, FR-08)", "`src/invite.ts` (FR-06, FR-08, after T01)"),
            "unknown headings only": PLAN.replace("## Tasks\n", "## Tasks\n\n### Backend\n"),
        }
        for name, text in cases.items():
            with self.subTest(case=name):
                tasks, touch = cell.plan_tasks(text)
                theirs = [(t["id"], t["phase"], list(t["after"])) for t in lanes.annotate(text, tasks)]
                parts = cell.lane_parts(task_section(text))
                mine = [(t["id"], t["part"] or "before", t["after"]) for t in parts["tasks"]]
                self.assertEqual(mine, theirs)
                refused = (bool(cell.lane_problems(parts, {})), bool(lanes.problems(text, tasks, touch)))
                if name == "unknown headings only":
                    # A known disagreement, kept visible: a plan whose only sub-headings are other ones is a plan written the
                    # old way, which check-plan accepts as it always did; lanes.problems (not called by check-plan) refuses it.
                    self.assertEqual(refused, (False, True))
                else:
                    self.assertEqual(refused[0], refused[1], "both readers accept or both refuse")
