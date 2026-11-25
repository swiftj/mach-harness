"""Tests for lanes.py: which plan tasks could be built at the same time (M22 design, 4.1 to 4.4), the arithmetic of 11.2,
and `measure`, which reads past builds from live cells and cleanup archives and writes nothing.

Plans are read with the build station's own parse_plan, loaded by path as lanes.py's command line loads it.
"""

import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "skills" / "build" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import lanes  # noqa: E402


def build_module():
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec = importlib.util.spec_from_file_location("mach_build_station_for_lane_tests", SCRIPTS / "build.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


BUILD = build_module()
parse_plan = BUILD.parse_plan


def fixture_plan(test_file):
    """The PLAN a test module holds, read as text (the module is not imported)."""
    text = (ROOT / "tests" / test_file).read_text(encoding="utf-8")
    return re.search(r'^PLAN = """(.*?)"""', text, re.S | re.M).group(1)


def make_plan(tasks, touch=()):
    rows = "\n".join(f"| `{name}` | create | {', '.join(ids)} |" for name, ids in touch)
    return ("# Plan: SLICE-001: Sample\n\n- **App type:** library\n- **Risk tier:** Low\n- **Contracts:** None.\n- **ADRs:** None.\n\n"
            "## Contracts\n\n- None.\n\n## Tasks\n\n" + "\n".join(tasks) + "\n\n## File touch map\n\n| File | Change | Tasks |\n|------|--------|-------|\n"
            + rows + "\n\n## Engineering decisions\n\n- None.\n")


def lanes_of(text):
    tasks, touch = parse_plan(text)
    return lanes.plan(text, tasks, touch)


def problems_of(text):
    tasks, touch = parse_plan(text)
    return lanes.problems(text, tasks, touch)


def task_groups(text):
    return [lane["tasks"] for lane in lanes_of(text)["lanes"]]


DESIGN_PLAN = make_plan([
    "### Before the lanes",
    "- [ ] T01 [test] Invitation model — `tests/test_invitation_model.py` (INV-01)",
    "- [ ] T02 [impl] Invitation model — `app/models/invitation.py` (INV-01)",
    "",
    "### Lanes",
    "- [ ] T03 [test] Rules for who may invite, 16 cases — `tests/test_invite_rules.py` (FR-01, FR-02, FR-03)",
    "- [ ] T04 [impl] Who may invite — `app/invite/rules.py` (FR-01, FR-02, FR-03)",
    "- [ ] T05 [test] The invitation e-mail — `tests/test_invite_mail.py` (FR-05, AC-02)",
    "- [ ] T06 [impl] The invitation e-mail — `app/invite/mail.py`, `templates/invite.txt` (FR-05, AC-02, after T02)",
    "",
    "### After the lanes",
    "- [ ] T07 [test] Invite route — `tests/test_invite_route.py` (AC-01, AC-03)",
    "- [ ] T08 [impl] Invite route — `app/routes.py` (AC-01, AC-03)",
])


class ParserAgreementTest(unittest.TestCase):
    """lanes.py reads the Tasks section a second time, for the sub-headings and `after`. It must see the same tasks."""

    def test_the_task_line_pattern_is_the_build_stations(self):
        self.assertEqual(lanes.TASK_RE.pattern, BUILD.TASK_RE.pattern)

    def test_both_readers_find_the_same_tasks_in_every_plan(self):
        plans = [fixture_plan("test_build.py"), fixture_plan("test_cell.py"), DESIGN_PLAN,
                 (ROOT / "skills" / "intent" / "assets" / "plan-template.md").read_text(encoding="utf-8")]
        for text in plans:
            tasks, _ = parse_plan(text)
            found, _ = lanes._task_lines(text)
            self.assertEqual([t["id"] for t in tasks], [entry[0] for entry in found])
            self.assertEqual([t["id"] for t in lanes.annotate(text, tasks)], [t["id"] for t in tasks])

    def test_the_additions_change_nothing_parse_plan_reads(self):
        """`after` and the sub-headings leave every task's ids and files exactly as without them (design 4.2)."""
        plain = DESIGN_PLAN.replace(", after T02", "")
        plain = "\n".join(line for line in plain.splitlines() if not line.startswith("### "))
        def read(text):
            tasks, touch = parse_plan(text)
            return [{k: v for k, v in t.items() if k != "text"} for t in tasks], touch
        self.assertEqual(read(DESIGN_PLAN), read(plain))

    def test_annotate_does_not_change_its_input(self):
        tasks, _ = parse_plan(DESIGN_PLAN)
        before = json.dumps(tasks, sort_keys=True)
        lanes.annotate(DESIGN_PLAN, tasks)
        self.assertEqual(json.dumps(tasks, sort_keys=True), before)


class RuleTest(unittest.TestCase):
    """Each clause of 4.1, with a plan that isolates it."""

    def test_independent_tasks_are_lanes_of_their_own(self):
        text = make_plan(["- [ ] T01 [docs] Readme — `README.md`", "- [ ] T02 [docs] Guide — `docs/guide.md`"])
        self.assertEqual(task_groups(text), [["T01"], ["T02"]])
        self.assertEqual(lanes_of(text)["joined_because"], [])

    def test_rule_1_a_file_on_both_task_lines(self):
        text = make_plan(["- [ ] T01 [impl] One — `app/a.py`", "- [ ] T02 [impl] Two — `app/b.py`, `app/a.py`"])
        result = lanes_of(text)
        self.assertEqual(task_groups(text), [["T01", "T02"]])
        self.assertEqual(result["joined_because"], [{"tasks": ["T01", "T02"], "why": "T01 and T02 share app/a.py"}])

    def test_rule_1_a_file_from_the_touch_map(self):
        text = make_plan(["- [ ] T01 [impl] One — `app/a.py`", "- [ ] T02 [impl] Two — `app/b.py`"], [("app/shared.py", ["T01", "T02"])])
        self.assertEqual(task_groups(text), [["T01", "T02"]])
        self.assertIn("app/shared.py", lanes_of(text)["joined_because"][0]["why"])

    def test_rule_2_a_test_and_its_code_share_an_fr(self):
        text = make_plan(["- [ ] T01 [test] Rule — `tests/test_a.py` (FR-01)", "- [ ] T02 [impl] Rule — `app/a.py` (FR-01)"])
        self.assertEqual(task_groups(text), [["T01", "T02"]])
        self.assertEqual(lanes_of(text)["joined_because"][0]["why"], "T01 [test] and T02 [impl] both name FR-01")

    def test_rule_2_an_ac(self):
        text = make_plan(["- [ ] T01 [test] Scenario — `tests/test_a.py` (AC-03)", "- [ ] T02 [impl] Scenario — `app/a.py` (AC-03)"])
        self.assertEqual(task_groups(text), [["T01", "T02"]])

    def test_rule_2_an_invariant_alone_joins_nothing(self):
        text = make_plan(["- [ ] T01 [test] Keeps — `tests/test_a.py` (INV-01)", "- [ ] T02 [impl] Keeps — `app/a.py` (INV-01)"])
        self.assertEqual(task_groups(text), [["T01"], ["T02"]])

    def test_rule_2_only_a_test_and_an_impl(self):
        for first, second in (("test", "test"), ("impl", "impl"), ("docs", "impl"), ("test", "contract"), ("refactor", "test")):
            with self.subTest(kinds=(first, second)):
                text = make_plan([f"- [ ] T01 [{first}] One — `a/one.py` (FR-01)", f"- [ ] T02 [{second}] Two — `a/two.py` (FR-01)"])
                self.assertEqual(task_groups(text), [["T01"], ["T02"]])

    def test_rule_2_the_impl_may_come_first(self):
        text = make_plan(["- [ ] T01 [impl] Code — `app/a.py` (FR-02)", "- [ ] T02 [test] Its test — `tests/test_a.py` (FR-02)"])
        self.assertEqual(task_groups(text), [["T01", "T02"]])

    def test_rule_3_after_joins_two_tasks(self):
        text = make_plan(["- [ ] T01 [impl] Module — `app/a.py`", "- [ ] T02 [impl] Uses it — `app/b.py` (after T01)"])
        self.assertEqual(task_groups(text), [["T01", "T02"]])
        self.assertEqual(lanes_of(text)["joined_because"][0]["why"], "T02 is after T01")

    def test_rule_3_after_a_task_before_the_lanes_changes_nothing(self):
        result = lanes_of(DESIGN_PLAN)
        self.assertEqual([lane["tasks"] for lane in result["lanes"]], [["T03", "T04"], ["T05", "T06"]])
        self.assertFalse(any("after" in entry["why"] for entry in result["joined_because"]))

    def test_rule_4_a_task_with_no_file_makes_one_lane(self):
        text = make_plan(["- [ ] T01 [docs] Readme — `README.md`", "- [ ] T02 [docs] Explain it somewhere (FR-01)",
                          "- [ ] T03 [docs] Guide — `docs/guide.md`"])
        result = lanes_of(text)
        self.assertEqual(task_groups(text), [["T01", "T02", "T03"]])
        self.assertEqual(result["single_reason"], "T02 names no file, so it cannot be placed and the lanes part is one lane.")
        self.assertTrue(all("T02 names no file" == entry["why"] for entry in result["joined_because"]))

    def test_rule_4_counts_only_the_lanes_part(self):
        text = make_plan(["### Before the lanes", "- [ ] T01 [contract] Wiring, no file", "### Lanes",
                          "- [ ] T02 [docs] Readme — `README.md`", "- [ ] T03 [docs] Guide — `docs/guide.md`"])
        result = lanes_of(text)
        self.assertEqual(task_groups(text), [["T02"], ["T03"]])
        self.assertIsNone(result["single_reason"])

    def test_lanes_are_numbered_by_their_first_task_and_keep_plan_order(self):
        text = make_plan(["- [ ] T01 [test] A — `tests/test_a.py` (FR-01)", "- [ ] T02 [test] B — `tests/test_b.py` (FR-02)",
                          "- [ ] T03 [impl] A — `app/a.py` (FR-01)", "- [ ] T04 [impl] B — `app/b.py` (FR-02)",
                          "- [ ] T05 [docs] C — `docs/c.md`"])
        result = lanes_of(text)
        self.assertEqual([(lane["lane"], lane["tasks"]) for lane in result["lanes"]],
                         [("L1", ["T01", "T03"]), ("L2", ["T02", "T04"]), ("L3", ["T05"])])
        self.assertEqual(result["lanes"][0]["files"], ["app/a.py", "tests/test_a.py"])

    def test_joins_are_transitive(self):
        text = make_plan(["- [ ] T01 [impl] A — `app/a.py`", "- [ ] T02 [impl] B — `app/b.py`", "- [ ] T03 [impl] AB — `app/a.py`, `app/b.py`"])
        result = lanes_of(text)
        self.assertEqual(task_groups(text), [["T01", "T02", "T03"]])
        self.assertEqual(len(result["joined_because"]), 2)

    def test_pairs_with_no_headings_and_no_shared_file_give_one_lane_each(self):
        lines = []
        for n in range(1, 6):
            lines += [f"- [ ] T{2 * n - 1:02d} [test] Part {n} — `tests/test_p{n}.py` (FR-{n:02d})",
                      f"- [ ] T{2 * n:02d} [impl] Part {n} — `app/p{n}.py` (FR-{n:02d})"]
        self.assertEqual(task_groups(make_plan(lines)), [[f"T{2 * n - 1:02d}", f"T{2 * n:02d}"] for n in range(1, 6)])


class SharedFileTest(unittest.TestCase):
    """4.3: a file many tasks touch puts them all in one lane; no exception for any kind of file."""

    KINDS = {"a shared test file": "tests/helpers.py", "a routes table": "app/routes.py", "a registry": "app/registry.py",
             "a migration list": "migrations/index.txt", "a lock file": "package-lock.json"}

    def test_every_kind_joins_its_tasks(self):
        for kind, name in self.KINDS.items():
            with self.subTest(kind=kind):
                text = make_plan(["- [ ] T01 [impl] A — `app/a.py`", "- [ ] T02 [impl] B — `app/b.py`", "- [ ] T03 [impl] C — `app/c.py`"],
                                 [(name, ["T01", "T03"])])
                result = lanes_of(text)
                self.assertEqual(task_groups(text), [["T01", "T03"], ["T02"]])
                self.assertEqual(result["ties"], [{"file": name, "tasks": ["T01", "T03"]}])

    def test_the_shared_file_planned_before_the_lanes_frees_them(self):
        shared = make_plan(["- [ ] T01 [impl] Registry — `app/registry.py`", "- [ ] T02 [impl] A — `app/a.py`, `app/registry.py`",
                            "- [ ] T03 [impl] B — `app/b.py`, `app/registry.py`"])
        self.assertEqual(task_groups(shared), [["T01", "T02", "T03"]])
        planned = make_plan(["### Before the lanes", "- [ ] T01 [impl] Registry entries for A and B — `app/registry.py`",
                             "### Lanes", "- [ ] T02 [impl] A — `app/a.py`", "- [ ] T03 [impl] B — `app/b.py`"])
        self.assertEqual(task_groups(planned), [["T02"], ["T03"]])

    def test_ties_are_most_shared_first_then_by_name(self):
        text = make_plan(["- [ ] T01 [impl] A — `z.py`, `b.py`", "- [ ] T02 [impl] B — `z.py`, `b.py`, `a.py`", "- [ ] T03 [impl] C — `z.py`, `a.py`"])
        self.assertEqual([tie["file"] for tie in lanes_of(text)["ties"]], ["z.py", "a.py", "b.py"])


class GrammarTest(unittest.TestCase):
    def test_no_sub_headings_is_all_lanes(self):
        result = lanes_of(fixture_plan("test_build.py"))
        self.assertEqual((result["before"], result["after"]), ([], []))

    def test_the_three_parts(self):
        result = lanes_of(DESIGN_PLAN)
        self.assertEqual(result["before"], ["T01", "T02"])
        self.assertEqual(result["after"], ["T07", "T08"])
        tasks, _ = parse_plan(DESIGN_PLAN)
        annotated = {t["id"]: t for t in lanes.annotate(DESIGN_PLAN, tasks)}
        self.assertEqual(annotated["T06"]["after"], ["T02"])
        self.assertEqual([annotated[i]["phase"] for i in ("T01", "T03", "T08")], ["before", "lanes", "after"])
        self.assertEqual(problems_of(DESIGN_PLAN), [])

    def test_only_some_parts(self):
        text = make_plan(["### Lanes", "- [ ] T01 [docs] A — `a.md`", "- [ ] T02 [docs] B — `b.md`",
                          "### After the lanes", "- [ ] T03 [docs] C — `c.md`"])
        result = lanes_of(text)
        self.assertEqual((result["before"], task_groups(text), result["after"]), ([], [["T01"], ["T02"]], ["T03"]))
        self.assertEqual(problems_of(text), [])

    def test_headings_ignore_case_and_spacing(self):
        text = make_plan(["###   before THE lanes", "- [ ] T01 [docs] A — `a.md`", "### lanes", "- [ ] T02 [docs] B — `b.md`"])
        self.assertEqual(lanes_of(text)["before"], ["T01"])
        self.assertEqual(problems_of(text), [])

    def test_after_forms(self):
        text = make_plan(["- [ ] T01 [impl] A — `a.py`", "- [ ] T02 [impl] B — `b.py`",
                          "- [ ] T03 [impl] C — `c.py` (FR-01, After T01, after T02, after T01)",
                          "- [ ] T04 [impl] Runs after T01 in prose only — `d.py` (FR-02)"])
        tasks, _ = parse_plan(text)
        annotated = {t["id"]: t["after"] for t in lanes.annotate(text, tasks)}
        self.assertEqual(annotated, {"T01": [], "T02": [], "T03": ["T01", "T02"], "T04": []})
        self.assertEqual(task_groups(text), [["T01", "T02", "T03"], ["T04"]])

    def test_after_errors(self):
        cases = {
            "unknown": (["- [ ] T01 [impl] A — `a.py` (after T09)"], "the plan has no task T09"),
            "itself": (["- [ ] T01 [impl] A — `a.py` (after T01)"], "names itself"),
            "later": (["- [ ] T01 [impl] A — `a.py` (after T02)", "- [ ] T02 [impl] B — `b.py`"], "comes later in the plan"),
            "after the lanes": (["### Lanes", "- [ ] T01 [impl] A — `a.py`", "### After the lanes", "- [ ] T02 [impl] B — `b.py`",
                                 "- [ ] T03 [impl] C — `c.py` (after T02)"], "which is after the lanes"),
        }
        for name, (lines, words) in cases.items():
            with self.subTest(case=name):
                found = problems_of(make_plan(lines))
                self.assertEqual(len(found), 1, found)
                self.assertIn(words, found[0])

    def test_after_the_lanes_may_name_a_lanes_task(self):
        text = make_plan(["### Lanes", "- [ ] T01 [impl] A — `a.py`", "### After the lanes", "- [ ] T02 [impl] B — `b.py` (after T01)"])
        self.assertEqual(problems_of(text), [])

    def test_heading_errors(self):
        cases = {
            "unknown": (["### Lanes", "### Later", "- [ ] T01 [docs] A — `a.md`"], "'### Later'"),
            "repeated": (["### Lanes", "- [ ] T01 [docs] A — `a.md`", "### Lanes", "- [ ] T02 [docs] B — `b.md`"], "more than once"),
            "out of order": (["### Lanes", "- [ ] T01 [docs] A — `a.md`", "### Before the lanes", "- [ ] T02 [docs] B — `b.md`"],
                             "comes after '### Lanes'"),
            "loose task": (["- [ ] T01 [docs] A — `a.md`", "### Lanes", "- [ ] T02 [docs] B — `b.md`"], "before the first sub-heading"),
        }
        for name, (lines, words) in cases.items():
            with self.subTest(case=name):
                found = problems_of(make_plan(lines))
                self.assertTrue(any(words in sentence for sentence in found), found)

    def test_other_sub_headings_alone_are_a_plan_written_the_old_way(self):
        # As check-plan reads it: no problem, and nothing in it is read as a part.
        text = make_plan(["### Backend", "- [ ] T01 [docs] A — `a.md`", "### Frontend", "- [ ] T02 [docs] B — `b.md`"])
        self.assertFalse(lanes.uses_additions(text))
        self.assertEqual(problems_of(text), [])
        self.assertEqual((lanes_of(text)["before"], lanes_of(text)["after"]), ([], []))

    def test_a_fenced_block_hides_headings_but_never_tasks(self):
        # The build's parse_plan reads a task line inside a fence as a task, so the lanes read it too; a heading inside a
        # fence is an example, not a part (the review's e4: check-plan and the lane calculator read such a plan alike).
        text = make_plan(["### Lanes", "- [ ] T01 [docs] A — `a.md`", "```markdown", "### After the lanes", "- [ ] T02 [docs] B — `b.md`", "```",
                          "- [ ] T03 [docs] C — `c.md`"])
        tasks, _ = parse_plan(text)
        self.assertEqual([t["id"] for t in tasks], ["T01", "T02", "T03"])
        self.assertEqual([t["phase"] for t in lanes.annotate(text, tasks)], ["lanes", "lanes", "lanes"])
        self.assertEqual(lanes_of(text)["after"], [])
        self.assertEqual(problems_of(text), [])
        self.assertFalse(lanes.uses_additions(make_plan(["~~~", "### Lanes", "~~~", "- [ ] T01 [docs] A — `a.md`"])))

    def test_a_task_above_the_first_heading_counts_as_before(self):
        text = make_plan(["- [ ] T01 [docs] A — `a.md`", "### Lanes", "- [ ] T02 [docs] B — `b.md`"])
        self.assertEqual(lanes_of(text)["before"], ["T01"])

    def test_before_the_lanes_must_end_green(self):
        text = make_plan(["### Before the lanes", "- [ ] T01 [test] Model — `tests/test_m.py` (FR-01, AC-01, INV-01)",
                          "- [ ] T02 [impl] Model — `app/m.py` (FR-01)", "### Lanes", "- [ ] T03 [impl] Scenario — `app/s.py` (AC-01)"])
        found = problems_of(text)
        self.assertEqual(len(found), 1, found)
        self.assertIn("test AC-01 but no [impl] task before the lanes names it", found[0])

    def test_each_lane_must_be_able_to_go_green(self):
        text = make_plan(["- [ ] T01 [test] Rule — `tests/test_a.py` (FR-01)", "- [ ] T02 [impl] Helper — `app/a.py` (FR-02)",
                          "- [ ] T03 [impl] Rule — `app/a.py` (FR-01)"])
        found = problems_of(text)
        self.assertEqual(len(found), 1, found)
        self.assertTrue(found[0].startswith("In lane L1: T03 [impl] implements FR-01"), found)

    def test_one_lane_is_never_a_problem(self):
        self.assertEqual(problems_of(fixture_plan("test_cell.py")), [])
        self.assertEqual(problems_of(make_plan(["- [ ] T01 [docs] No file", "- [ ] T02 [docs] B — `b.md`"])), [])

    def test_a_plan_without_the_additions_has_no_problems(self):
        self.assertEqual(problems_of(fixture_plan("test_build.py")), [])


class FixturePlanTest(unittest.TestCase):
    def test_the_build_fixture_is_one_lane_plus_the_docs_task(self):
        result = lanes_of(fixture_plan("test_build.py"))
        self.assertEqual([lane["tasks"] for lane in result["lanes"]], [["T01", "T02", "T03", "T04"], ["T05"]])
        self.assertEqual([entry["why"] for entry in result["joined_because"]],
                         ["T01 [test] and T02 [impl] both name FR-01", "T02 and T04 share app/invite.py", "T03 [test] and T04 [impl] both name FR-06"])

    def test_the_cell_fixture_is_one_lane(self):
        result = lanes_of(fixture_plan("test_cell.py"))
        self.assertEqual([lane["tasks"] for lane in result["lanes"]], [["T01", "T02", "T03", "T04"]])
        self.assertIsNone(result["single_reason"])
        self.assertEqual(result["ties"], [{"file": "src/invite.ts", "tasks": ["T02", "T04"]}])

    def test_the_template_is_one_lane_because_its_placeholders_name_no_file(self):
        text = (ROOT / "skills" / "intent" / "assets" / "plan-template.md").read_text(encoding="utf-8")
        result = lanes_of(text)
        self.assertEqual([lane["tasks"] for lane in result["lanes"]], [["T01", "T02"]])
        self.assertIn("T01, T02 name no file", result["single_reason"])


class DeterminismTest(unittest.TestCase):
    def test_the_same_plan_gives_the_same_lanes(self):
        for text in (DESIGN_PLAN, fixture_plan("test_build.py"), fixture_plan("test_cell.py")):
            first = json.dumps(lanes_of(text), sort_keys=True)
            for _ in range(5):
                self.assertEqual(json.dumps(lanes_of(text), sort_keys=True), first)

    def test_the_order_of_touch_map_rows_does_not_matter(self):
        lines = ["- [ ] T01 [impl] A — `a.py`", "- [ ] T02 [impl] B — `b.py`", "- [ ] T03 [impl] C — `c.py`", "- [ ] T04 [impl] D — `d.py`"]
        rows = [("x.py", ["T01", "T03"]), ("y.py", ["T02", "T04"]), ("w.py", ["T03", "T04"])]
        one = lanes_of(make_plan(lines, rows))
        two = lanes_of(make_plan(lines, list(reversed(rows))))
        self.assertEqual(one["lanes"], two["lanes"])
        self.assertEqual([lane["tasks"] for lane in one["lanes"]], [["T01", "T02", "T03", "T04"]])


MIN = 1.0  # the design's example is in minutes; the arithmetic does not care about the unit


def chain(n, m=4.0, s=2.0):
    return [(m, s)] * n


class ArithmeticTest(unittest.TestCase):
    """11.2's table: 30 tasks, t = 6 (m = 4, s = 2), G = 5, W = 1, S = 3, landing 0. Sequential: 185."""

    def total(self, before, lane_lengths, after, shared):
        fixed = 5 + (before + after) * 6  # the first reading of the ground, and the tasks that stay sequential
        return lanes.estimate(fixed, [chain(n) for n in lane_lengths], len(lane_lengths), shared, ground=5, worktree=1, landing=0, suite=3)["seconds"]

    def test_the_design_table(self):
        self.assertEqual(5 + 30 * 6, 185)
        cases = [((4, [12, 12], 2), 122, 146), ((2, [6, 6, 6, 6], 4), 86, 122), ((2, [16, 4, 4], 4), 146, 162), ((0, [8, 8, 8, 6], 0), 62, 106)]
        for (before, lengths, after), alone, shared in cases:
            with self.subTest(shape=(before, lengths, after)):
                self.assertEqual(before + sum(lengths) + after, 30)
                self.assertAlmostEqual(self.total(before, lengths, after, False), alone)
                self.assertAlmostEqual(self.total(before, lengths, after, True), shared)

    def test_lanes_wall(self):
        self.assertEqual(lanes.lanes_wall([chain(3), chain(1)], False), 18)
        # c = 2 for the first task of each, then the long lane alone: 4 + 2*2, then two tasks at 6.
        self.assertEqual(lanes.lanes_wall([chain(3), chain(1)], True), 8 + 12)
        self.assertEqual(lanes.lanes_wall([], True), 0)
        self.assertEqual(lanes.lanes_wall([[(0, 0), (5, 0)]], False), 5)

    def test_batches_when_fewer_run_at_once_than_there_are_lanes(self):
        """Five lanes of 2, 4, 1, 3, 2 tasks, two at a time: batches (2, 4), (1, 3), (2). Each batch makes worktrees and reads the ground."""
        lengths = [2, 4, 1, 3, 2]
        result = lanes.estimate(10, [chain(n) for n in lengths], 2, False, ground=5, worktree=1, landing=2, suite=3)
        self.assertEqual(result["batches"], 3)
        self.assertEqual(result["lanes_wall_seconds"], (4 + 3 + 2) * 6)
        self.assertEqual(result["seconds"], 10 + 54 + 3 * (1 + 5) + 2 + 3)


def two_pair_plan():
    return make_plan(["- [ ] T01 [test] A — `tests/test_a.py` (FR-01)", "- [ ] T02 [impl] A — `app/a.py` (FR-01)",
                      "- [ ] T03 [test] B — `tests/test_b.py` (FR-02)", "- [ ] T04 [impl] B — `app/b.py` (FR-02)"])


def report_for(steps, elapsed=1300.0, baseline=60.0, total=None, final=100.0):
    measured = [s[3] for s in steps if s[3] is not None]
    return {"ticket_id": "T-1", "status": "BUILT", "timing": {
        "started_at": "2026-11-01T10:00:00Z", "finished_at": "2026-11-01T10:21:40Z", "elapsed_seconds": elapsed,
        "test_seconds_total": total if total is not None else round(sum(measured) + baseline + final, 1), "test_runs": len(measured) + 2,
        "baseline_test_seconds": baseline, "final_test_seconds": final,
        "steps": [{"task": task, "kind": kind, "loop": loop, "tests": scope, "test_seconds": test, "seconds_since_previous_step": since}
                  for task, kind, scope, test, since, loop in [(s[0], s[1], s[2], s[3], s[4], s[5] if len(s) > 5 else 0) for s in steps]]}}


TWO_PAIR_STEPS = [("T01", "test", "new tests only", 20.0, 400.0), ("T02", "impl", "whole suite", 100.0, 300.0),
                  ("T03", "test", "new tests only", 20.0, 200.0), ("T04", "impl", "whole suite", 100.0, 300.0)]


class PredictTest(unittest.TestCase):
    """predict() against hand-computed numbers.

    Recorded: elapsed 1300; tasks 400, 300, 200, 300 (sum 1200); test runs 20, 100, 20, 100; baseline run 60.
    S = median whole-suite run = 100. G = 400 - 60 - median(300, 200, 300) = 40. Fixed = 1300 - 1200 = 100.
    Lanes: L1 = (380, 20), (200, 100); L2 = (180, 20), (200, 100).
    Tests alone: wall = max(700, 500) = 700; total = 100 + 700 + (W 30 + G 40) + J 30 + S 100 = 1000.
    Tests shared (c = lanes running): 180 both write; L2 tests 40 (c 2); L1 writes on to 380 while L2 writes 160 of 200;
    L1 tests 40 while L2 finishes writing (420); L1 writes 200 while L2 tests 100 at c 2 (620); L1 tests 100 alone (720).
    Total = 100 + 720 + 30 + 40 + 30 + 100 = 1020."""

    def test_hand_computed(self):
        text = two_pair_plan()
        result = lanes.predict(lanes_of(text), report_for(TWO_PAIR_STEPS))
        self.assertEqual(result["label"], lanes.PREDICTION)
        self.assertFalse(result["one_lane"])
        self.assertEqual((result["inputs"]["ground_seconds"], result["inputs"]["suite_seconds"]), (40.0, 100.0))
        self.assertEqual(result["recorded"]["base_seconds"], 1300.0)
        self.assertEqual(result["recorded"]["test_share"], round((240 + 60 + 100) / 1300, 3))  # the steps' runs, the baseline and the finish
        by_k = {e["lanes_at_once"]: e for e in result["estimates"]}
        self.assertEqual(sorted(by_k), [2, 3, 4])
        for k in (2, 3, 4):
            self.assertEqual((by_k[k]["seconds_tests_alone"], by_k[k]["seconds_tests_shared"]), (1000.0, 1020.0))
            self.assertEqual(by_k[k]["lanes_used"], 2)
        self.assertEqual(by_k[2]["saving_seconds_tests_alone"], 300.0)
        self.assertEqual(result["not_recorded"], [])

    def test_given_fixed_costs_replace_the_assumed_ones(self):
        result = lanes.predict(lanes_of(two_pair_plan()), report_for(TWO_PAIR_STEPS), worktree_seconds=0, landing_seconds=0)
        self.assertEqual(result["estimates"][0]["seconds_tests_alone"], 940.0)
        self.assertEqual(result["inputs"]["worktree_from"], "given")

    def test_one_lane_is_no_estimate(self):
        text = make_plan(["- [ ] T01 [test] A — `tests/test_a.py` (FR-01)", "- [ ] T02 [impl] A — `app/a.py` (FR-01)"])
        result = lanes.predict(lanes_of(text), report_for(TWO_PAIR_STEPS[:2], elapsed=800))
        self.assertTrue(result["one_lane"])
        self.assertEqual(result["estimates"], [])
        self.assertEqual(result["recorded"]["elapsed_seconds"], 800)

    def test_no_timing_says_not_recorded(self):
        result = lanes.predict(lanes_of(two_pair_plan()), {"status": "BUILT"})
        self.assertEqual(result["estimates"], [])
        self.assertIn("not recorded", result["not_recorded"][0])

    def test_a_task_without_its_time_is_not_guessed(self):
        steps = list(TWO_PAIR_STEPS)
        steps[2] = ("T03", "test", "new tests only", 20.0, None)
        result = lanes.predict(lanes_of(two_pair_plan()), report_for(steps))
        self.assertEqual(result["estimates"], [])
        self.assertTrue(any("not recorded for T03" in note for note in result["not_recorded"]), result["not_recorded"])

    def test_a_test_run_without_its_seconds_is_not_guessed(self):
        steps = list(TWO_PAIR_STEPS)
        steps[1] = ("T02", "impl", "whole suite", None, 300.0)
        result = lanes.predict(lanes_of(two_pair_plan()), report_for(steps))
        self.assertEqual(result["estimates"], [])

    def test_no_elapsed_time(self):
        result = lanes.predict(lanes_of(two_pair_plan()), report_for(TWO_PAIR_STEPS, elapsed=None))
        self.assertEqual(result["estimates"], [])
        self.assertIn("The build's elapsed time is not recorded.", result["not_recorded"])

    def test_revision_rounds_are_left_out(self):
        steps = TWO_PAIR_STEPS + [("R1-T01", "impl", "whole suite", 100.0, 90000.0, 1)]
        result = lanes.predict(lanes_of(two_pair_plan()), report_for(steps, elapsed=95000))
        self.assertEqual((result["recorded"]["base_is"], result["recorded"]["base_seconds"]), ("first round", 1200.0))
        # The first round has no finish of its own, so fixed is 0 and each estimate is 100 less than above.
        self.assertEqual(result["estimates"][0]["seconds_tests_alone"], 900.0)


# ---------------------------------------------------------------- measure

def add(tar, name, data, kind=tarfile.REGTYPE, link=""):
    info = tarfile.TarInfo(name)
    info.type = kind
    info.linkname = link
    raw = data.encode("utf-8") if isinstance(data, str) else data
    info.size = len(raw) if kind == tarfile.REGTYPE else 0
    tar.addfile(info, io.BytesIO(raw) if kind == tarfile.REGTYPE else None)


def write_archive(path, ticket, files, extra=()):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(str(path), "w:gz") as tar:
        add(tar, f"{ticket}/cell.json", json.dumps({"ticket_id": ticket}))
        for name, data in files.items():
            add(tar, f"{ticket}/{name}", data)
        for item in extra:
            add(tar, *item)


def one_lane_plan():
    return make_plan(["- [ ] T01 [test] Matrix — `tests/test_invite.py` (FR-01, FR-02)", "- [ ] T02 [impl] Service — `app/invite.py`, `app/models.py` (FR-01)",
                      "- [ ] T03 [impl] Expiry — `app/invite.py`, `app/models.py` (FR-02)", "- [ ] T04 [docs] Notes — `app/invite.py`"])


def snapshot(folder):
    return sorted((str(p.relative_to(folder)), p.stat().st_mtime_ns, p.stat().st_size) for p in folder.rglob("*"))


class MeasureTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mach-lanes-"))
        self.project = self.tmp / "project"
        (self.project / ".factory" / "worktrees").mkdir(parents=True)
        (self.project / ".factory" / "archive").mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cell(self, ticket, plan_text, report=None):
        folder = self.project / ".factory" / "worktrees" / ticket
        (folder / "repo").mkdir(parents=True)
        (folder / "plan.md").write_text(plan_text, encoding="utf-8")
        if report is not None:
            (folder / "build-report.json").write_text(json.dumps(report), encoding="utf-8")
        return folder

    def run_main(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = lanes.main(list(argv), parse_plan=parse_plan)
        return code, out.getvalue()

    def test_a_live_cell_and_an_archive_in_one_go(self):
        self.cell("T-1", two_pair_plan(), report_for(TWO_PAIR_STEPS))
        write_archive(self.project / ".factory" / "archive" / "T-2.tar.gz", "T-2",
                      {"plan.md": one_lane_plan(), "build-report.json": json.dumps(report_for(TWO_PAIR_STEPS, elapsed=1500))})
        before = snapshot(self.project)
        code, out = self.run_main("measure", "--project", str(self.project))
        self.assertEqual(code, 0, out)
        self.assertEqual(snapshot(self.project), before, "measure wrote into the project")
        self.assertIn("T-1 (from the cell", out)
        self.assertIn("T-2 (from the archive", out)
        self.assertIn("2 lanes at once: about 16 min 40 s if test runs do not slow each other, about 17 min 00 s if they share the machine", out)
        self.assertIn("Lanes would not change this build: the plan as written is one lane.", out)
        self.assertIn("app/invite.py: 3 tasks (T02, T03, T04)", out)
        self.assertLess(out.index("app/invite.py: 3 tasks"), out.index("app/models.py: 2 tasks"))
        self.assertIn(lanes.PREDICTION, out)
        table = out[out.index("ticket "):]
        self.assertRegex(table, r"T-1\s+4\s+2\s+2\s+21 min 40 s\s+31%\s+16 min 40 s - 17 min 00 s")
        self.assertRegex(table, r"T-2\s+4\s+1\s+4\s+25 min 00 s\s+\d+%\s+one lane: no change")

    def test_named_tickets_only_and_a_missing_one(self):
        self.cell("T-1", two_pair_plan(), report_for(TWO_PAIR_STEPS))
        self.cell("T-3", one_lane_plan(), report_for(TWO_PAIR_STEPS))
        code, out = self.run_main("measure", "--project", str(self.project), "T-1", "T-9", "../etc")
        self.assertEqual(code, 0)
        self.assertIn("T-1 (from the cell", out)
        self.assertNotIn("T-3 (", out)
        self.assertIn("T-9                not read: no cell and no archive", out)
        self.assertIn("../etc             not read: not a ticket ID", out)

    def test_missing_timing_says_not_recorded(self):
        self.cell("T-1", two_pair_plan(), {"ticket_id": "T-1", "status": "BUILT"})
        self.cell("T-2", two_pair_plan())
        code, out = self.run_main("measure", "--project", str(self.project))
        self.assertEqual(code, 0)
        self.assertIn("Not recorded: The build report has no timing, so the build's time is not recorded.", out)
        self.assertIn("Not recorded: There is no build report", out)
        self.assertRegex(out, r"T-1\s+4\s+2\s+2\s+not recorded\s+-\s+not recorded")
        self.assertNotRegex(out, r"T-1.*\d+ min.*at once")

    def test_the_newest_archive_of_a_ticket_and_a_cell_before_an_archive(self):
        archive = self.project / ".factory" / "archive"
        write_archive(archive / "T-1.tar.gz", "T-1", {"plan.md": one_lane_plan()})
        write_archive(archive / "T-1-2.tar.gz", "T-1", {"plan.md": two_pair_plan()})
        write_archive(archive / "T-1-3.tar.gz", "T-1-3", {"plan.md": one_lane_plan()})  # another ticket, named like a repeat
        found = {t: (s.name if s else None) for t, s, _ in lanes.project_sources(self.project, [])}
        self.assertEqual(found, {"T-1": "T-1-2.tar.gz", "T-1-3": "T-1-3.tar.gz"})
        self.cell("T-1", one_lane_plan())
        found = {t: (s.name if s else None) for t, s, _ in lanes.project_sources(self.project, ["T-1"])}
        self.assertEqual(found, {"T-1": "T-1"})

    def test_finished_tickets_with_no_archive_kept_are_counted_and_said_why(self):
        self.cell("T-1", two_pair_plan(), report_for(TWO_PAIR_STEPS))
        archive = self.project / ".factory" / "archive"
        write_archive(archive / "T-2.tar.gz", "T-2", {"plan.md": one_lane_plan()})
        (archive / "runs.jsonl").write_text("".join(json.dumps(r) + "\n" for r in (
            {"ticket_id": "T-2", "archive": ".factory/archive/T-2.tar.gz"}, {"ticket_id": "T-3", "archive": None},
            {"ticket_id": "T-5", "archive": None}, {"ticket_id": "T-6"})))
        code, out = self.run_main("measure", "--project", str(self.project))
        self.assertEqual(code, 0, out)
        self.assertIn("T-1 (from the cell", out)
        self.assertIn("T-2 (from the archive", out)
        self.assertRegex(out, r"T-3\s+not read: finished, and its archive was not kept after cleanup \(cleanup.archive\)")
        self.assertIn("2 finished ticket(s) could not be read: their archives were not kept after cleanup (cleanup.archive). "
                      "This covers the open tickets and the finished ones whose archive was kept.", out)
        self.assertNotIn("T-6", out, "an old record that names no archive and has none is not counted")
        code, out = self.run_main("measure", "--project", str(self.project), "--json")
        data = json.loads(out)
        self.assertEqual((data["not_kept"], sorted(item["ticket"] for item in data["not_read"])), (2, ["T-3", "T-5"]))
        code, out = self.run_main("measure", "--project", str(self.project), "T-3")
        self.assertIn("not read: finished, and its archive was not kept", out)

    def test_paths_given_directly(self):
        folder = self.cell("T-1", two_pair_plan(), report_for(TWO_PAIR_STEPS))
        archive = self.tmp / "T-2.tar.gz"
        write_archive(archive, "T-2", {"plan.md": two_pair_plan(), "build-report.json": json.dumps(report_for(TWO_PAIR_STEPS))})
        code, out = self.run_main("measure", str(folder), str(archive), "--json")
        self.assertEqual(code, 0, out)
        data = json.loads(out)
        self.assertEqual([b["ticket"] for b in data["builds"]], ["T-1", "T-2"])
        self.assertEqual(data["builds"][1]["prediction"]["estimates"][0]["seconds_tests_alone"], 1000.0)
        self.assertEqual(data["label"], lanes.PREDICTION)

    def test_hostile_archives_are_refused_and_nothing_is_extracted(self):
        good = {"plan.md": two_pair_plan(), "build-report.json": json.dumps(report_for(TWO_PAIR_STEPS))}
        cases = {
            "escape": [("T-1/../../escaped.txt", "x")],
            "absolute": [("/tmp/mach-lanes-absolute.txt", "x")],
            "symlink": [("T-1/link", "", tarfile.SYMTYPE, "/etc/passwd")],
            "hardlink": [("T-1/hard", "", tarfile.LNKTYPE, "T-1/plan.md")],
            "device": [("T-1/dev", "", tarfile.CHRTYPE)],
        }
        for name, extra in cases.items():
            with self.subTest(case=name):
                path = self.tmp / "hostile" / f"{name}.tar.gz"
                write_archive(path, "T-1", good, extra)
                with self.assertRaises(lanes.MeasureError):
                    lanes.read_archive(path)
                code, out = self.run_main("measure", str(path))
                self.assertEqual(code, 0)
                self.assertIn("not read:", out)
                self.assertNotIn("Tasks:", out)
        self.assertFalse((self.tmp / "escaped.txt").exists())
        self.assertFalse(Path("/tmp/mach-lanes-absolute.txt").exists())
        self.assertEqual(sorted(p.name for p in (self.tmp / "hostile").iterdir()), sorted(f"{n}.tar.gz" for n in cases))

    def test_a_plan_md_that_is_a_link_in_a_live_cell_is_not_followed(self):
        folder = self.cell("T-1", two_pair_plan())
        (self.tmp / "elsewhere.md").write_text(two_pair_plan(), encoding="utf-8")
        (folder / "plan.md").unlink()
        os.symlink(str(self.tmp / "elsewhere.md"), str(folder / "plan.md"))
        with self.assertRaises(lanes.MeasureError):
            lanes.read_cell(folder)

    def test_a_folder_that_is_not_a_project(self):
        code, out = self.run_main("measure", "--project", str(self.tmp))
        self.assertEqual(code, 1)
        self.assertIn("REFUSED", out)


class CommandLineTest(unittest.TestCase):
    """The script as a project runs it: .claude/skills/mach-build/scripts/lanes.py, beside build.py, writing nothing."""

    def test_measure_in_an_installed_project(self):
        tmp = Path(tempfile.mkdtemp(prefix="mach-lanes-cli-"))
        try:
            project = tmp / "project"
            skills = project / ".claude" / "skills"
            shutil.copytree(str(ROOT / "skills" / "build"), str(skills / "mach-build"), ignore=shutil.ignore_patterns("__pycache__"))
            shutil.copytree(str(ROOT / "skills" / "intent"), str(skills / "mach-intent"), ignore=shutil.ignore_patterns("__pycache__"))
            cell = project / ".factory" / "worktrees" / "T-1"
            cell.mkdir(parents=True)
            (cell / "plan.md").write_text(two_pair_plan(), encoding="utf-8")
            (cell / "build-report.json").write_text(json.dumps(report_for(TWO_PAIR_STEPS)), encoding="utf-8")
            write_archive(project / ".factory" / "archive" / "T-2.tar.gz", "T-2",
                          {"plan.md": fixture_plan("test_build.py"), "build-report.json": json.dumps({"ticket_id": "T-2"})})
            before = snapshot(project)
            env = {k: v for k, v in os.environ.items() if k != "PYTHONDONTWRITEBYTECODE"}
            done = subprocess.run([sys.executable, ".claude/skills/mach-build/scripts/lanes.py", "measure", "--project", "."],
                                  cwd=str(project), capture_output=True, text=True, env=env, timeout=120)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(snapshot(project), before, "the command wrote into the project")
            self.assertIn("T-1 (from the cell", done.stdout)
            self.assertIn("T-2 (from the archive", done.stdout)
            self.assertIn("T02 and T04 share app/invite.py", done.stdout)
            shown = subprocess.run([sys.executable, ".claude/skills/mach-build/scripts/lanes.py", "show", ".factory/worktrees/T-1/plan.md", "--json"],
                                   cwd=str(project), capture_output=True, text=True, env=env, timeout=120)
            self.assertEqual(shown.returncode, 0, shown.stderr)
            self.assertEqual([lane["tasks"] for lane in json.loads(shown.stdout)["lanes"]], [["T01", "T02"], ["T03", "T04"]])
            self.assertEqual(snapshot(project), before)
        finally:
            shutil.rmtree(str(tmp), ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
