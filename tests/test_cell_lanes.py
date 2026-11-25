"""Tests for the plan stage's part of building one plan in lanes (M22, piece B): the plan's two optional additions,
what check-plan refuses in them, and the `lanes` it prints for such a plan unless build.max_lanes is 1 (it defaults to 3).

A plan written without the additions is checked exactly as before: the old-plan tests below cover every plan the
test suite writes and the plan template. The tests that need the lane calculator (skills/build/scripts/lanes.py,
piece A) are skipped where it is not installed."""

import ast
import copy
import io
import json
import shutil
import sys
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

try:
    import fcntl
except ImportError:  # pragma: no cover - not POSIX
    fcntl = None

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
        # Every reader of the Tasks section, compared on every case where they could differ: the build station's parse_plan
        # (which tasks exist), lanes.task_walk through annotate, problems and uses_additions (the build's lane plan), and
        # cell.py's lane_parts over plan_task_lines (check-plan). Each is compared with the others, so the test fails when
        # any one of them changes alone. A task above the first heading has no part for check-plan, which refuses it; the
        # calculator counts it before the lanes and reports it as a problem too: both refuse, so None reads as "before".
        lanes = cell.lanes_module()
        t05 = "- [ ] T05 [test] Expiry — `tests/expiry.test.ts` (FR-06, FR-09, INV-03)\n"
        t07 = "### After the lanes\n- [ ] T07 [test]"
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
            "unknown headings only, below the tasks": PLAN.replace("## File touch map", "### Frontend\n\n## File touch map"),
            "a part heading in a fence": PARTS_PLAN.replace(t05, "```markdown\n### After the lanes\n```\n" + t05),
            "the only part heading in a fence": PLAN.replace("## Tasks\n", "## Tasks\n\n```\n### Lanes\n```\n"),
            "a task in a fence": PARTS_PLAN.replace(t05, "```\n" + t05 + "```\n"),
            "a task with an after mark in a fence": PLAN.replace("## Tasks\n", "## Tasks\n\n~~~\n").replace("(FR-06, FR-08)", "(FR-06, FR-08, after T01)\n~~~"),
            "an unclosed fence": PARTS_PLAN.replace(t07, "```text\n" + t07),
            "tildes around backticks": PARTS_PLAN.replace(t07, "~~~\n```\n### Backend\n~~~\n" + t07),
            "backticks around tildes": PARTS_PLAN.replace(t07, "```\n~~~\n" + t07 + " Scenarios — `tests/x.test.ts` (AC-01)\n```\n- [ ] T09 [test]"),
            "a fenced section heading": PARTS_PLAN.replace(t07, "```\n## Notes\n```\n" + t07),
            "a fence closed, then a heading": PARTS_PLAN.replace(t05, "```\nexample\n```\n### Backend\n" + t05),
            "two Tasks sections": PARTS_PLAN.replace("## File touch map", "## tasks\n\n- [ ] T09 [docs] Notes — `README.md` (FR-08)\n\n## File touch map"),
        }
        readings = {}
        for name, text in cases.items():
            with self.subTest(case=name):
                self.assertNotIn(text, (PARTS_PLAN, PLAN), "the case changes the plan")
                tasks, touch = cell.plan_tasks(text)
                walked, _ = lanes.task_walk(text)
                parts = cell.lane_parts(cell.plan_task_lines(text))
                self.assertEqual([t["id"] for t in tasks], [entry[0] for entry in walked], "lanes.py reads the tasks parse_plan reads")
                self.assertEqual([t["id"] for t in tasks], [t["id"] for t in parts["tasks"]], "check-plan reads the tasks parse_plan reads")
                theirs = [(t["id"], t["phase"], list(t["after"])) for t in lanes.annotate(text, copy.deepcopy(tasks))]
                mine = [(t["id"], t["part"] or "before", t["after"]) for t in parts["tasks"]]
                self.assertEqual(mine, theirs)
                self.assertEqual(parts["used"], lanes.uses_additions(text), "both say alike whether the plan is written for lanes")
                refused = (bool(cell.lane_problems(parts, {})), bool(lanes.problems(text, copy.deepcopy(tasks), copy.deepcopy(touch))))
                self.assertEqual(refused[0], refused[1], "both readers accept or both refuse")
                readings[name] = (mine, parts["used"], refused[0])
        # What the rule is, so that changing every reader at once is a decision and not an accident.
        self.assertEqual(len(readings), len(cases))

        def part(name, task):
            return {i: p for i, p, _ in readings[name][0]}[task]
        self.assertEqual(readings["unknown headings only"][1:], (False, False), "other sub-headings alone: a plan written the old way")
        self.assertEqual(readings["unknown headings only, below the tasks"][1:], (False, False))
        self.assertEqual((part("a part heading in a fence", "T05"), part("a part heading in a fence", "T07")), ("lanes", "after"),
                         "a heading inside a fence is not a heading")
        self.assertFalse(readings["the only part heading in a fence"][1])
        self.assertEqual(part("a task in a fence", "T05"), "lanes", "a task inside a fence is a task, as parse_plan reads it")
        self.assertTrue(readings["a task with an after mark in a fence"][1])
        self.assertEqual(part("an unclosed fence", "T08"), "lanes", "an unclosed fence runs to the end of the section")
        self.assertEqual(part("tildes around backticks", "T07"), "after", "backticks do not close a block of tildes")
        self.assertFalse(readings["tildes around backticks"][2])
        self.assertEqual(part("backticks around tildes", "T07"), "lanes")
        self.assertNotIn("T07", [i for i, _, _ in readings["a fenced section heading"][0]], "a fenced '## ' line ends the section, as parse_plan reads it")
        self.assertTrue(readings["a fence closed, then a heading"][2], "a heading after a closed fence is a heading")
        self.assertEqual(part("two Tasks sections", "T09"), "after")


# ---------------------------------------------------------------- a re-plan of a build in lanes (the review's e5)

import test_build_lanes as built_in_lanes  # noqa: E402  (its project, plan and lane helpers; loads build.py)

LANE_TICKET = built_in_lanes.TICKET
NEW_LANE_PLAN = built_in_lanes.LANE_PLAN.replace("tests/test_invite.py", "tests/test_invite_rules.py").replace(
    "Table-driven test of rules R1 to R5", "Rules test, rewritten")


def cleanup_module():
    folder = str(ROOT / "skills" / "cleanup" / "scripts")
    if folder not in sys.path:
        sys.path.insert(0, folder)
    import cleanup  # noqa: E402
    return cleanup


@unittest.skipUnless(HAS_LANES, "needs the lane calculator, skills/build/scripts/lanes.py (piece A)")
class ReplanWithLanesTest(built_in_lanes.LaneBase):
    """A re-plan while lanes are open sets the lanes aside with the rest, losing nothing: each lane's commits and uncommitted
    files are kept under refs/mach/replan/<ticket>/<n>-lanes/<L>, its state files under plan-history/<n>/lanes/, and its
    worktree, Git's record of it and its branch are gone, so the new plan's build starts its lanes afresh."""

    git = staticmethod(built_in_lanes.git)

    def run_cell(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = built_in_lanes.test_build.cell_script.main(["--project", str(self.project), *argv])
        return code, out.getvalue() + err.getvalue()

    def replan(self):
        return json.loads(self.cell_cmd("replan", LANE_TICKET, "--reason", "the plan was wrong"))

    def lanes_open_with_work(self):
        self.ready_lanes()
        self.ok("start", LANE_TICKET)
        self.open_lanes()
        self.build_lane("L1", built_in_lanes.L1[:1])
        self.put(self.lane_work("L1"), {"notes.txt": "a builder's note, never added\n"})
        self.put(self.lane_work("L2"), {"tests/test_release.py": built_in_lanes.RELEASE_TEST})
        return self.lane_state("L1")["tasks"][0]["commit"]

    def test_the_lanes_are_set_aside_with_the_plan_and_the_new_build_starts_them_afresh(self):
        t01 = self.lanes_open_with_work()
        fork = self.state()["lanes"]["fork"]
        result = self.replan()
        self.assertEqual(result["status"], "REPLANNED")
        lanes = result["lanes"]
        self.assertEqual(lanes["kept_in"], str(self.cellroot / "plan-history" / "1" / "lanes"))
        saved = {entry["lane"]: entry for entry in lanes["saved"]}
        self.assertEqual(sorted(saved), ["L1", "L2"])
        l1, l2 = saved["L1"], saved["L2"]
        ref = "refs/mach/replan/LOCAL-001/1-lanes/"
        self.assertEqual((l1["saved_as"], l1["branch"]), (ref + "L1", "mach-lane/LOCAL-001/L1"))
        self.assertEqual([c["commit"] for c in l1["commits"]], [t01], "the lane's own commit is named")
        self.assertEqual(l1["commits"][0]["bring_back"], f'git -C "{self.work}" cherry-pick {t01}')
        self.assertEqual(l1["uncommitted"]["paths"], ["notes.txt"])
        self.assertEqual(l1["uncommitted"]["bring_back"], f'git -C "{self.work}" checkout {ref}L1 -- <path>')
        self.assertEqual((l2["commits"], l2["uncommitted"]["paths"]), ([], ["tests/test_release.py"]))
        self.assertEqual(self.git(self.project, "show", ref + "L1:notes.txt").stdout, "a builder's note, never added\n")
        self.assertEqual(self.git(self.project, "show", ref + "L2:tests/test_release.py").stdout, built_in_lanes.RELEASE_TEST)
        self.assertEqual(self.git(self.project, "merge-base", "--is-ancestor", t01, ref + "L1").returncode, 0)
        self.assertEqual(self.git(self.project, "merge-base", "--is-ancestor", fork, ref + "L2").returncode, 0)
        cleanup = cleanup_module()
        self.assertEqual(sorted(name for name, _ in cleanup.replan_refs(self.project, LANE_TICKET)), [ref + "L1", ref + "L2"],
                         "cleanup bundles and removes the lanes' refs with the other re-plan refs")
        self.assertIn(ref + "L1", result["next"])
        self.assertIn(f"cherry-pick {t01}", result["next"])
        # Gone: the worktrees, Git's records of them, the branches and the lanes folder; kept: every state file, never a tree.
        self.assertEqual((self.branches(), self.worktrees()), ([], []))
        self.assertEqual(sorted(lanes["worktrees_removed"]), [str(self.lane_work("L1")), str(self.lane_work("L2"))])
        self.assertEqual(sorted(lanes["branches_deleted"]), ["mach-lane/LOCAL-001/L1", "mach-lane/LOCAL-001/L2"])
        self.assertFalse((self.cellroot / "lanes").exists())
        kept = self.cellroot / "plan-history" / "1" / "lanes"
        self.assertEqual(json.loads((kept / "L1" / "lane.json").read_text())["tasks"][0]["commit"], t01)
        self.assertTrue((kept / "L2" / "lane.json").is_file())
        self.assertFalse((kept / "L1" / "repo").exists(), "a lane's checked-out tree is never kept as files")
        self.assertIn("lanes/L1/lane.json", lanes["state_files"])
        record = json.loads((self.cellroot / "plan-history" / "1" / "replan.json").read_text())
        self.assertEqual(record["lanes"], lanes)

        # The new plan's build: nothing of the old lanes is reused, no old commit lands, and the join gates what it lands.
        self.put(self.cellroot, {"plan.md": NEW_LANE_PLAN})
        self.cell_cmd("check-plan", LANE_TICKET)
        self.ok("start", LANE_TICKET)
        self.open_lanes()
        self.assertEqual([t["status"] for t in self.lane_state("L1")["tasks"]], ["pending", "pending"])
        self.assertEqual(self.ok("next", LANE_TICKET, "--lane", "L1")["task"], "T01")
        new_l1 = [("T01", "red", {"tests/test_invite_rules.py": built_in_lanes.RED_TEST}), built_in_lanes.L1[1]]
        self.build_lane("L1", new_l1)
        self.build_lane("L2", built_in_lanes.L2)
        joined = self.ok("join", LANE_TICKET)
        self.assertEqual((joined["status"], joined["landed"]), ("JOINED", 4))
        self.assertNotIn(t01, self.git(self.work, "log", "--format=%H").stdout)
        self.assertTrue((self.work / "tests/test_invite_rules.py").is_file())
        self.assertFalse((self.work / "tests/test_invite.py").exists(), "the old plan's test never lands")
        self.assertFalse((self.work / "notes.txt").exists())

    @unittest.skipIf(fcntl is None, "the lanes' lock needs fcntl, as in the build station")
    def test_a_replan_waits_for_the_lanes_lock_before_it_touches_the_lanes(self):
        """A lane's builder writes its lane.json under <cell>/lanes/.lock; a re-plan takes the same lock before it reads the lanes'
        state, so it never moves or removes a lane while that builder is writing."""
        self.lanes_open_with_work()
        lock = self.cellroot / "lanes" / ".lock"
        lock.parent.mkdir(parents=True, exist_ok=True)
        answers = []
        with open(str(lock), "a", encoding="utf-8") as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX)  # a lane's builder, writing
            worker = threading.Thread(target=lambda: answers.append(self.run_cell("replan", LANE_TICKET, "--reason", "the plan was wrong")))
            worker.start()
            worker.join(1.5)
            self.assertTrue(worker.is_alive(), "the re-plan waits for the lock")
            self.assertTrue(self.lane_work("L1").is_dir() and (self.cellroot / "lanes" / "L1" / "lane.json").is_file(), "nothing of the lanes was touched yet")
            self.assertFalse((self.cellroot / "plan-history").exists())
            fcntl.flock(held.fileno(), fcntl.LOCK_UN)
        worker.join(60)
        self.assertFalse(worker.is_alive())
        code, out = answers[0]
        self.assertEqual(code, 0, out)
        self.assertFalse(self.lane_work("L1").exists())
        self.assertTrue((self.cellroot / "plan-history" / "1" / "lanes" / "L1" / "lane.json").is_file())
        self.assertEqual(json.loads((self.cellroot / "plan-history" / "1" / "replan.json").read_text())["by"], "a person")

    def test_without_fcntl_a_replan_runs_without_the_lock(self):
        self.lanes_open_with_work()
        with mock.patch.object(built_in_lanes.test_build.cell_script, "fcntl", None):
            code, out = self.run_cell("replan", LANE_TICKET, "--reason", "the plan was wrong")
        self.assertEqual(code, 0, out)
        self.assertFalse(self.lane_work("L1").exists())

    def test_a_folder_that_is_not_a_lane_worktree_stops_the_replan_with_nothing_changed(self):
        self.lanes_open_with_work()
        stray = self.cellroot / "lanes" / "L3" / "repo"
        self.put(stray, {"mine.txt": "a person's file\n"})
        before = (self.branches(), self.worktrees(), self.git(self.work, "rev-parse", "HEAD").stdout)
        code, out = self.run_cell("replan", LANE_TICKET, "--reason", "the plan was wrong")
        self.assertEqual(code, 2, out)
        self.assertIn(str(stray), out)
        self.assertIn("Nothing was changed", out)
        self.assertEqual((self.branches(), self.worktrees(), self.git(self.work, "rev-parse", "HEAD").stdout), before)
        self.assertEqual(json.loads((self.cellroot / "cell.json").read_text())["stage"], "building")
        self.assertTrue((self.cellroot / "plan.md").is_file() and (self.cellroot / "lanes" / "L1" / "lane.json").is_file())
        self.assertEqual(self.git(self.project, "for-each-ref", "refs/mach/replan/").stdout, "")
        self.assertFalse((self.cellroot / "plan-history").exists())
        # Moving the folder out, as the message says, lets the re-plan run.
        shutil.move(str(stray.parent), str(Path(self.tmp.name) / "L3-kept"))
        self.assertEqual(self.replan()["status"], "REPLANNED")
        self.assertEqual(self.branches(), [])

    def test_after_a_join_only_the_state_files_are_left_and_they_move(self):
        self.through_lanes()
        result = self.replan()
        self.assertEqual(result["lanes"]["saved"], [])
        self.assertIn("lanes/L1/lane.json", result["lanes"]["state_files"])
        self.assertFalse((self.cellroot / "lanes").exists())
        self.assertTrue((self.cellroot / "plan-history" / "1" / "lanes" / "L2" / "lane.json").is_file())

    def test_a_replan_without_lanes_says_nothing_about_them(self):
        self.ready()
        self.ok("start", LANE_TICKET)
        self.assertNotIn("lanes", self.replan())
