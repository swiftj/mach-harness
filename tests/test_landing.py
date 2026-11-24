"""Tests for landing.py: bringing a ticket's lanes together on its branch (M22 design, sections 8, 9 and 14 C2).

Every test runs real Git in a temporary project: a cell worktree on feature/LOCAL-001 and one sparse worktree per lane
on mach-lane/LOCAL-001/<lane>, made as the build station makes them, each lane committing one commit per task with the
station's message shape. The joined history is compared with a sequential build of the same plan made in another
worktree: one commit per task, in plan order, with the same messages and the same trees.
"""

import contextlib
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "build" / "scripts"))
import landing  # noqa: E402
import workspace  # noqa: E402  (put on the path by landing, as build.py puts it)

TICKET = "LOCAL-001"
JOIN_BRANCH = f"mach-lane/{TICKET}/join"
PREFIX = {"test": "test", "impl": "feat", "docs": "docs"}
SUITE = [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."]


def git(folder, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    return subprocess.run(["git", *args], cwd=str(folder), capture_output=True, text=True, env=env)


def run_suite(folder):
    started = time.monotonic()
    done = subprocess.run(SUITE, cwd=str(folder), capture_output=True, text=True, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
    out = done.stdout + "\n" + done.stderr
    return {"command": " ".join(SUITE), "exit_code": done.returncode, "passed": done.returncode == 0,
            "seconds": round(time.monotonic() - started, 1), "output_tail": out.strip()[-3000:], "output": out}


def test_of(name, module, value):
    return (f"import unittest\nfrom app.{module} import {module}\n\n# FR-01\nclass T(unittest.TestCase):\n"
            f"    def test_{name}(self):\n        self.assertEqual({module}(), '{value}')\n")


def impl_of(module, value):
    return f"def {module}():\n    return '{value}'\n"


# Two independent pairs, interleaved in plan order: lane L1 is T01 and T03, lane L2 is T02 and T04.
TWO = [
    ("T01", "L1", "test", "Alpha rules", {"tests/test_alpha.py": test_of("alpha", "alpha", "a")}),
    ("T02", "L2", "test", "Beta rules", {"tests/test_beta.py": test_of("beta", "beta", "b")}),
    ("T03", "L1", "impl", "Alpha", {"app/alpha.py": impl_of("alpha", "a")}),
    ("T04", "L2", "impl", "Beta", {"app/beta.py": impl_of("beta", "b")}),
]
THREE = TWO + [
    ("T05", "L3", "test", "Gamma rules", {"tests/test_gamma.py": test_of("gamma", "gamma", "c")}),
    ("T06", "L1", "docs", "Describe alpha", {"docs/alpha.md": "# Alpha\n"}),
    ("T07", "L3", "impl", "Gamma", {"app/gamma.py": impl_of("gamma", "c")}),
]


class Crash(BaseException):
    """The process dying at this point: nothing below it runs, nothing catches it."""


def crashing(when):
    """A Git runner that dies before or after the call `when(args, count)` picks (count: how many calls of that Git
    command, or of that `git worktree` subcommand, so far, this one included)."""
    counts = {}

    def runner(args, cwd, env=None, input=None):  # noqa: A002
        key = " ".join(args[:2]) if args[0] == "worktree" else args[0]
        counts[key] = counts.get(key, 0) + 1
        moment = when(list(args), counts[key])
        if moment == "before":
            raise Crash(" ".join(args))
        done = landing.run_git(args, cwd, env=env, input=input)
        if moment == "after":
            raise Crash(" ".join(args))
        return done
    return runner


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="mach-landing-")
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.project = self.tmp / "project"
        self.put(self.project, {".gitignore": ".factory/\n__pycache__/\n", "README.md": "# Sample\n", "app/__init__.py": "",
                                "app/plugins/__init__.py": "", "tests/__init__.py": "",
                                "tests/test_base.py": "import unittest\n\nclass B(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n",
                                ".claude/settings.json": "{}\n"})
        git(self.project, "init", "-q", "-b", "main")
        for key, value in (("user.name", "t"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")):
            git(self.project, "config", key, value)
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "work")
        self.cellroot = self.project / ".factory" / "worktrees" / TICKET
        self.cell = self.cellroot / "repo"
        workspace.create(self.project, self.cell, f"feature/{TICKET}")
        self.fork = self.head(self.cell)
        self.join_repo = self.cellroot / "lanes" / "join" / "repo"
        self.folders, self.branches = {}, {}

    # ---- helpers

    @staticmethod
    def put(folder, files):
        for name, body in files.items():
            path = Path(folder) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body)

    @staticmethod
    def head(folder, rev="HEAD"):
        return git(folder, "rev-parse", rev).stdout.strip()

    @staticmethod
    def message(task, kind, what):
        return f"{PREFIX[kind]}(SLICE-001): {task} {what} [{TICKET}]"

    def open_lane(self, lane):
        if lane not in self.folders:
            branch = f"mach-lane/{TICKET}/{lane}"
            folder = self.cellroot / "lanes" / lane / "repo"
            git(self.project, "branch", branch, self.fork)
            workspace.create(self.project, folder, branch)
            self.folders[lane], self.branches[lane] = folder, branch
        return self.folders[lane]

    def commit_task(self, folder, task, kind, what, files):
        self.put(folder, files)
        git(folder, "add", "-A")
        done = git(folder, "commit", "-q", "-m", self.message(task, kind, what))
        self.assertEqual(done.returncode, 0, done.stderr)
        return self.head(folder)

    def build_lanes(self, plan, finish_order=None, skip=()):
        """Build each lane's tasks in its own worktree (lanes taken in `finish_order`, whole lane at a time), and return the
        tasks in plan order as the station hands them to landing."""
        commits = {}
        for lane in finish_order or list(dict.fromkeys(item[1] for item in plan)):
            folder = self.open_lane(lane)
            for task, owner, kind, what, files in plan:
                if owner == lane and task not in skip:
                    commits[task] = self.commit_task(folder, task, kind, what, files)
        for lane in dict.fromkeys(item[1] for item in plan):
            self.open_lane(lane)
        return [{"task": task, "lane": lane, "lane_commit": commits.get(task)} for task, lane, _, _, _ in plan]

    @staticmethod
    def lane_tests(plan):
        found = {}
        for task, lane, kind, _, files in plan:
            found.setdefault(lane, [])
            if kind == "test":
                found[lane] += sorted(files)
        return found

    def join(self, tasks, test_files, **kwargs):
        kwargs.setdefault("lane_folders", self.folders)
        kwargs.setdefault("lane_branches", self.branches)
        return landing.join_lanes(self.project, self.cell, self.join_repo, JOIN_BRANCH, self.fork, tasks, test_files,
                                  kwargs.pop("run_suite", run_suite), **kwargs)

    def history(self, folder, since=None):
        """(message, tree, parents count) of each commit since the fork point, oldest first."""
        out = git(folder, "log", "--reverse", "--format=%H", f"{since or self.fork}..HEAD").stdout.split()
        return [(git(folder, "log", "-1", "--format=%B", sha).stdout.strip(), self.head(folder, sha + "^{tree}"),
                 len(git(folder, "rev-list", "--parents", "-n", "1", sha).stdout.split()) - 1) for sha in out]

    def sequential(self, plan, skip=()):
        """The same plan built one task after another, in plan order, from the fork point: what landing must equal."""
        folder = self.tmp / "sequential"
        git(self.project, "worktree", "add", "-q", "-b", "sequential", str(folder), self.fork)
        for task, _, kind, what, files in plan:
            if task not in skip:
                self.commit_task(folder, task, kind, what, files)
        found = self.history(folder)
        git(self.project, "worktree", "remove", "--force", str(folder))
        git(self.project, "branch", "-D", "sequential")
        return found

    def worktrees(self):
        return sorted(line[len("worktree "):] for line in git(self.project, "worktree", "list", "--porcelain").stdout.splitlines()
                      if line.startswith("worktree "))

    def branch_list(self):
        return sorted(git(self.project, "for-each-ref", "--format=%(refname:short)", "refs/heads").stdout.split())

    def assertClean(self):
        self.assertEqual(self.worktrees(), sorted([str(self.project), str(self.cell)]))
        self.assertEqual(self.branch_list(), [f"feature/{TICKET}", "main"])
        self.assertFalse(self.join_repo.exists())
        for folder in self.folders.values():
            self.assertFalse(folder.exists(), folder)

    def assertUntouched(self):
        self.assertEqual(self.head(self.cell), self.fork)
        self.assertEqual(git(self.cell, "status", "--porcelain").stdout, "")


class JoinTest(Base):
    def test_two_lanes_land_one_commit_per_task_in_plan_order(self):
        tasks = self.build_lanes(TWO)
        result = self.join(tasks, self.lane_tests(TWO))
        self.assertEqual(result["status"], "JOINED", result)
        self.assertEqual([item["task"] for item in result["landed"]], ["T01", "T02", "T03", "T04"])
        self.assertEqual([item["lane"] for item in result["landed"]], ["L1", "L2", "L1", "L2"])
        for item, task in zip(result["landed"], tasks):
            self.assertEqual(item["lane_commit"], task["lane_commit"])
            self.assertEqual(item["patch_id"], landing.patch_id(self.project, task["lane_commit"]))
        landed = self.history(self.cell)
        self.assertEqual(landed, self.sequential(TWO))  # same messages, same trees, one parent each: no merge commit
        self.assertEqual([entry[0] for entry in landed], [self.message(t, k, w) for t, _, k, w, _ in TWO])
        self.assertTrue(all("cherry picked" not in entry[0] for entry in landed))
        self.assertEqual(self.head(self.cell), result["tip"])
        self.assertEqual(result["ticket_head"], result["tip"])
        self.assertTrue(result["branch_moved"])
        self.assertEqual(result["suite"]["ran_on"], result["tip"])
        self.assertEqual(result["suite"]["where"], "join worktree")
        self.assertTrue(result["suite"]["passed"])
        self.assertEqual(result["set_aside"], [])
        self.assertIsNone(result["interaction"])
        self.assertEqual(git(self.cell, "status", "--porcelain").stdout, "")
        self.assertFalse((self.cell / ".claude").exists())  # still the sparse checkout
        self.assertClean()
        self.assertEqual(sorted(result["removed"]), sorted([str(self.join_repo), JOIN_BRANCH, *map(str, self.folders.values()), *self.branches.values()]))
        self.assertEqual(result["left"], [])
        self.assertEqual(set(result["seconds"]), {"check", "land", "suite", "fast_forward", "cleanup"})

    def test_three_lanes(self):
        tasks = self.build_lanes(THREE)
        result = self.join(tasks, self.lane_tests(THREE))
        self.assertEqual(result["status"], "JOINED", result)
        self.assertEqual(result["lanes"], ["L1", "L2", "L3"])
        self.assertEqual([item["task"] for item in result["landed"]], [t[0] for t in THREE])
        self.assertEqual(self.history(self.cell), self.sequential(THREE))
        self.assertClean()

    def test_plan_order_is_kept_when_lanes_finish_out_of_order(self):
        tasks = self.build_lanes(THREE, finish_order=["L3", "L2", "L1"])
        self.assertLess(int(git(self.project, "log", "-1", "--format=%ct", tasks[4]["lane_commit"]).stdout),
                        int(git(self.project, "log", "-1", "--format=%ct", tasks[0]["lane_commit"]).stdout) + 1)
        result = self.join(tasks, self.lane_tests(THREE))
        self.assertEqual(result["status"], "JOINED", result)
        self.assertEqual([item["task"] for item in result["landed"]], ["T01", "T02", "T03", "T04", "T05", "T06", "T07"])
        self.assertEqual(self.history(self.cell), self.sequential(THREE))

    def test_a_lane_with_no_commits(self):
        """A lane whose every task was done without a commit (already done by an earlier task) lands nothing and is removed."""
        plan = TWO + [("T05", "L3", "docs", "Nothing to change", {"docs/x.md": "x\n"})]
        tasks = self.build_lanes(plan, skip=("T05",))
        self.assertIsNone(tasks[4]["lane_commit"])
        result = self.join(tasks, self.lane_tests(plan))
        self.assertEqual(result["status"], "JOINED", result)
        self.assertEqual(result["tasks_without_commit"], ["T05"])
        self.assertEqual([item["task"] for item in result["landed"]], ["T01", "T02", "T03", "T04"])
        self.assertEqual(self.history(self.cell), self.sequential(plan, skip=("T05",)))
        self.assertClean()

    def test_one_lane_is_refused_and_changes_nothing(self):
        plan = [item for item in TWO if item[1] == "L1"]
        tasks = self.build_lanes(plan)
        result = self.join(tasks, self.lane_tests(plan))
        self.assertEqual(result["status"], "REFUSED")
        self.assertEqual(result["refused"]["code"], "one-lane")
        self.assertUntouched()
        self.assertFalse(self.join_repo.exists())
        self.assertIn(self.branches["L1"], self.branch_list())
        self.assertTrue(self.folders["L1"].exists())
        self.assertEqual(self.join([], {})["refused"]["code"], "one-lane")

    def test_the_landed_commits_keep_their_authors(self):
        tasks = self.build_lanes(TWO)
        result = self.join(tasks, self.lane_tests(TWO))
        for item in result["landed"]:
            self.assertEqual(git(self.cell, "log", "-1", "--format=%an %ae %aI", item["commit"]).stdout,
                             git(self.project, "log", "-1", "--format=%an %ae %aI", item["lane_commit"]).stdout)


class SetAsideTest(Base):
    def test_a_secretly_shared_file_sets_the_later_lane_aside(self):
        plan = TWO[:2] + [
            ("T03", "L1", "impl", "Alpha", {"app/alpha.py": impl_of("alpha", "a"), "app/util.py": "X = 1\n"}),
            ("T04", "L2", "impl", "Beta", {"app/beta.py": impl_of("beta", "b"), "app/util.py": "X = 2\n"}),
        ]
        tasks = self.build_lanes(plan, finish_order=["L2", "L1"])  # the later lane finished first: still the one set aside
        result = self.join(tasks, self.lane_tests(plan))
        self.assertEqual(result["status"], "JOINED", result)
        self.assertEqual(result["set_aside"], [{"lane": "L2", "tasks": ["T02", "T04"], "lane_commits": [tasks[1]["lane_commit"], tasks[3]["lane_commit"]],
                                                "because": [{"other": "L1", "file": "app/util.py", "why": "same-file"}]}])
        self.assertEqual([item["task"] for item in result["landed"]], ["T01", "T03"])
        self.assertEqual(self.history(self.cell), self.sequential(plan, skip=("T02", "T04")))
        self.assertEqual(git(self.cell, "show", "HEAD:app/util.py").stdout, "X = 1\n")
        self.assertFalse((self.cell / "app" / "beta.py").exists())  # nothing of the set-aside lane lands
        self.assertFalse((self.cell / "tests" / "test_beta.py").exists())
        self.assertClean()  # its lane is not kept beyond the join; its commits are named in the result

    def test_a_lane_that_changed_another_lanes_test_file(self):
        plan = TWO[:3] + [("T04", "L2", "impl", "Beta", {"app/beta.py": impl_of("beta", "b"),
                                                          "tests/test_alpha.py": test_of("alpha", "alpha", "a") + "# weakened\n"})]
        tasks = self.build_lanes(plan)
        frozen = git(self.project, "show", f"{tasks[0]['lane_commit']}:tests/test_alpha.py").stdout
        result = self.join(tasks, self.lane_tests(plan))
        self.assertEqual(result["status"], "JOINED", result)
        self.assertEqual(result["set_aside"][0]["lane"], "L2")
        self.assertEqual(result["set_aside"][0]["because"], [{"other": "L1", "file": "tests/test_alpha.py", "why": "frozen-test"}])
        self.assertEqual(git(self.cell, "show", "HEAD:tests/test_alpha.py").stdout, frozen)  # never altered by landing

    def test_an_extra_test_file_both_lanes_wrote(self):
        """Scenario 4: lane 1 committed tests/test_helpers_extra.py with --allow-extra; lane 2 wrote a file of that name."""
        plan = [("T01", "L1", "test", "Alpha rules", {"tests/test_alpha.py": test_of("alpha", "alpha", "a"), "tests/test_helpers_extra.py": "# one\n"}),
                TWO[1],
                TWO[2],
                ("T04", "L2", "impl", "Beta", {"app/beta.py": impl_of("beta", "b"), "tests/test_helpers_extra.py": "# two\n"})]
        tasks = self.build_lanes(plan)
        result = self.join(tasks, self.lane_tests(plan))
        self.assertEqual(result["set_aside"][0]["because"], [{"other": "L1", "file": "tests/test_helpers_extra.py", "why": "frozen-test"}])
        self.assertEqual(git(self.cell, "show", "HEAD:tests/test_helpers_extra.py").stdout, "# one\n")

    def test_an_earlier_lane_touching_a_later_lanes_test_sets_the_later_aside_never_the_earlier(self):
        plan = TWO[:2] + [("T03", "L1", "impl", "Alpha", {"app/alpha.py": impl_of("alpha", "a"), "tests/test_beta.py": test_of("beta", "beta", "b")}),
                          TWO[3]]
        tasks = self.build_lanes(plan)
        result = self.join(tasks, {"L1": ["tests/test_alpha.py"], "L2": ["tests/test_beta.py"]})
        self.assertEqual([item["lane"] for item in result["set_aside"]], ["L2"])
        self.assertEqual([item["task"] for item in result["landed"]], ["T01", "T03"])

    def test_a_lane_clashing_only_with_a_set_aside_lane_still_lands(self):
        plan = [TWO[0], TWO[1],
                ("T03", "L1", "impl", "Alpha", {"app/alpha.py": impl_of("alpha", "a"), "app/util.py": "X = 1\n"}),
                ("T04", "L2", "impl", "Beta", {"app/beta.py": impl_of("beta", "b"), "app/util.py": "X = 2\n", "app/other.py": "Y = 2\n"}),
                THREE[4],
                ("T07", "L3", "impl", "Gamma", {"app/gamma.py": impl_of("gamma", "c"), "app/other.py": "Y = 3\n"})]
        tasks = self.build_lanes(plan)
        result = self.join(tasks, self.lane_tests(plan))
        self.assertEqual(result["status"], "JOINED", result)
        self.assertEqual([item["lane"] for item in result["set_aside"]], ["L2"])
        self.assertEqual([item["task"] for item in result["landed"]], ["T01", "T03", "T05", "T07"])

    def test_a_test_file_inherited_from_the_fork_is_no_lanes_own(self):
        """Every lane starts with the cell's committed tests; a lane that amends one clashes only with a lane that changed it too."""
        plan = TWO[:3] + [("T04", "L2", "impl", "Beta", {"app/beta.py": impl_of("beta", "b"), "tests/test_base.py": "# amended\n"})]
        tasks = self.build_lanes(plan)
        test_files = {lane: ["tests/test_base.py", *files] for lane, files in self.lane_tests(plan).items()}
        self.assertEqual(self.join(tasks, test_files)["set_aside"], [])

    def test_overlaps_is_read_only(self):
        tasks = self.build_lanes(TWO)
        refs = git(self.project, "for-each-ref").stdout
        found = landing.overlaps(self.project, self.fork, {"L1": [tasks[0]["lane_commit"]], "L2": [tasks[1]["lane_commit"]]},
                                 {"L1": ["tests/test_beta.py"], "L2": []})
        self.assertEqual(found, [{"lane": "L2", "other": "L1", "file": "tests/test_beta.py", "why": "frozen-test"}])
        self.assertEqual(git(self.project, "for-each-ref").stdout, refs)
        self.assertEqual(self.worktrees(), sorted([str(self.project), str(self.cell), *map(str, self.folders.values())]))


class InteractionTest(Base):
    PLAN = [
        ("T01", "L1", "test", "Alpha plugin", {"tests/test_alpha.py": "import os, unittest\n\nclass T(unittest.TestCase):\n    def test_only_alpha(self):\n"
                                               "        self.assertEqual(sorted(n for n in os.listdir('app/plugins') if n != '__init__.py' and n.endswith('.py')), ['alpha.py'])\n"}),
        ("T02", "L2", "test", "Beta plugin", {"tests/test_beta.py": "import os, unittest\n\nclass T(unittest.TestCase):\n    def test_only_beta(self):\n"
                                              "        self.assertEqual(sorted(n for n in os.listdir('app/plugins') if n != '__init__.py' and n.endswith('.py')), ['beta.py'])\n"}),
        ("T03", "L1", "impl", "Alpha", {"app/plugins/alpha.py": "NAME = 'alpha'\n"}),
        ("T04", "L2", "impl", "Beta", {"app/plugins/beta.py": "NAME = 'beta'\n"}),
    ]

    def test_each_lane_passes_alone(self):
        self.build_lanes(self.PLAN)
        for folder in self.folders.values():
            self.assertTrue(run_suite(folder)["passed"])

    def test_the_joined_suite_failing_leaves_the_ticket_branch_where_it_was(self):
        tasks = self.build_lanes(self.PLAN)
        result = self.join(tasks, self.lane_tests(self.PLAN))
        self.assertEqual(result["status"], "INTERACTION", result)
        self.assertUntouched()
        self.assertFalse(result["branch_moved"])
        self.assertEqual(result["ticket_head"], self.fork)
        self.assertFalse(result["suite"]["passed"])
        self.assertEqual(result["suite"]["ran_on"], result["tip"])
        self.assertNotEqual(result["tip"], self.fork)
        interaction = result["interaction"]
        self.assertEqual(interaction["failing"], ["tests.test_alpha.T.test_only_alpha", "tests.test_beta.T.test_only_beta"])
        self.assertEqual(interaction["lanes_named"], [{"lane": "L1", "files": ["tests/test_alpha.py"]}, {"lane": "L2", "files": ["tests/test_beta.py"]}])
        self.assertEqual(interaction["lanes"], ["L1", "L2"])
        self.assertEqual(interaction["fix_files"], ["app/plugins/alpha.py", "app/plugins/beta.py"])
        self.assertIn("test_only_alpha", interaction["output_tail"])
        # The landed work is kept for the fix: the join worktree at the tip, and every lane's branch.
        self.assertEqual(self.head(self.join_repo), result["tip"])
        for lane, branch in self.branches.items():
            self.assertIn(branch, self.branch_list())
        # The station decides what comes next; moving the branch is one call, and a join run again starts over.
        again = self.join(tasks, self.lane_tests(self.PLAN))
        self.assertEqual(again["status"], "INTERACTION")
        self.assertEqual(len(self.history(self.join_repo)), 4)
        landing.fast_forward(self.cell, again["tip"])
        self.assertEqual(self.head(self.cell), again["tip"])

    def test_moving_on_red_as_section_8_3_words_it(self):
        tasks = self.build_lanes(self.PLAN)
        result = self.join(tasks, self.lane_tests(self.PLAN), move_on_red=True)
        self.assertEqual(result["status"], "INTERACTION")
        self.assertTrue(result["branch_moved"])
        self.assertEqual(self.head(self.cell), result["tip"])
        self.assertEqual(self.history(self.cell), self.sequential(self.PLAN))
        self.assertClean()


class RefusalTest(Base):
    def test_a_cherry_pick_that_does_not_apply(self):
        """Scenario 5 at this level: two commits that cannot both apply; land names the one that did not and removes what it made."""
        one = self.commit_task(self.open_lane("L1"), "T01", "test", "One", {"README.md": "# One\n"})
        two = self.commit_task(self.open_lane("L2"), "T02", "test", "Two", {"README.md": "# Two\n"})
        with self.assertRaises(landing.LandingError) as caught:
            landing.land(self.project, self.join_repo, JOIN_BRANCH, self.fork, [one, two])
        self.assertEqual(caught.exception.code, "cherry-pick-failed")
        self.assertEqual(caught.exception.commit, two)
        self.assertEqual(caught.exception.left, [])
        self.assertFalse(self.join_repo.exists())
        self.assertNotIn(JOIN_BRANCH, self.branch_list())
        self.assertUntouched()

    def test_a_cherry_pick_failing_in_the_join_changes_nothing_on_the_ticket_branch(self):
        tasks = self.build_lanes(TWO)
        bad = tasks[2]["lane_commit"]

        def runner(args, cwd, env=None, input=None):  # noqa: A002
            if args[0] == "cherry-pick" and args[-1] == bad:
                return subprocess.CompletedProcess(args, 1, "", "error: could not apply")
            return landing.run_git(args, cwd, env=env, input=input)
        result = self.join(tasks, self.lane_tests(TWO), git=runner)
        self.assertEqual(result["status"], "REFUSED")
        self.assertEqual(result["refused"]["code"], "cherry-pick-failed")
        self.assertEqual(result["refused"]["commit"], bad)
        self.assertUntouched()
        self.assertFalse(self.join_repo.exists())
        self.assertNotIn(JOIN_BRANCH, self.branch_list())
        for folder in self.folders.values():  # the lanes' work is untouched, for a person
            self.assertTrue(folder.exists())
        self.assertEqual(self.join(tasks, self.lane_tests(TWO))["status"], "JOINED")

    def test_a_landed_copy_whose_change_differs_is_refused(self):
        """Scenario 13: a commit edited in the join worktree after it landed (patch ID differs): refused, nothing moves."""
        tasks = self.build_lanes(TWO)

        def runner(args, cwd, env=None, input=None):  # noqa: A002
            done = landing.run_git(args, cwd, env=env, input=input)
            if args[0] == "cherry-pick" and args[-1] == tasks[1]["lane_commit"]:
                (Path(cwd) / "app" / "smuggled.py").write_text("TOKEN = 'x'\n")
                landing.run_git(["add", "-A"], cwd)
                landing.run_git(["commit", "-q", "--amend", "--no-edit"], cwd)
            return done
        result = self.join(tasks, self.lane_tests(TWO), git=runner)
        self.assertEqual(result["refused"]["code"], "patch-id-mismatch")
        self.assertEqual(result["refused"]["commit"], tasks[1]["lane_commit"])
        self.assertUntouched()
        self.assertFalse(self.join_repo.exists())

    def test_a_lane_branch_with_a_commit_no_task_recorded(self):
        tasks = self.build_lanes(TWO)
        self.commit_task(self.folders["L2"], "T99", "docs", "By hand", {"docs/hand.md": "x\n"})
        result = self.join(tasks, self.lane_tests(TWO))
        self.assertEqual(result["refused"]["code"], "lane-unrecorded-commits")
        self.assertUntouched()

    def test_lane_commits_out_of_their_own_order(self):
        tasks = self.build_lanes(TWO)
        tasks[0]["lane_commit"], tasks[2]["lane_commit"] = tasks[2]["lane_commit"], tasks[0]["lane_commit"]
        self.assertEqual(self.join(tasks, self.lane_tests(TWO))["refused"]["code"], "lane-history")
        self.assertUntouched()

    def test_a_ticket_branch_that_moved_some_other_way(self):
        tasks = self.build_lanes(TWO)
        self.commit_task(self.cell, "T00", "docs", "In the cell", {"docs/cell.md": "x\n"})
        result = self.join(tasks, self.lane_tests(TWO))
        self.assertEqual(result["refused"]["code"], "branch-moved")
        self.assertFalse(self.join_repo.exists())

    def test_a_dirty_cell(self):
        tasks = self.build_lanes(TWO)
        (self.cell / "README.md").write_text("changed\n")
        self.assertEqual(self.join(tasks, self.lane_tests(TWO))["refused"]["code"], "cell-dirty")
        self.assertEqual(self.head(self.cell), self.fork)

    def test_a_join_branch_holding_other_work_is_left_for_a_person(self):
        tasks = self.build_lanes(TWO)
        git(self.project, "branch", JOIN_BRANCH, self.fork)
        folder = self.tmp / "someone"
        git(self.project, "worktree", "add", "-q", str(folder), JOIN_BRANCH)
        self.commit_task(folder, "T42", "docs", "Someone's work", {"docs/mine.md": "x\n"})
        git(self.project, "worktree", "remove", "--force", str(folder))
        mine = self.head(self.project, JOIN_BRANCH)
        result = self.join(tasks, self.lane_tests(TWO))
        self.assertEqual(result["refused"]["code"], "join-branch-foreign")
        self.assertEqual(self.head(self.project, JOIN_BRANCH), mine)
        self.assertUntouched()

    def test_a_suite_that_moves_the_checked_out_commit(self):
        tasks = self.build_lanes(TWO)

        def suite(folder):
            git(folder, "checkout", "-q", "--detach", "HEAD~1")
            return run_suite(folder)
        result = self.join(tasks, self.lane_tests(TWO), run_suite=suite)
        self.assertEqual(result["refused"]["code"], "suite-moved-head")
        self.assertUntouched()
        self.assertFalse(self.join_repo.exists())

    def test_fast_forward_refuses_what_is_not_a_fast_forward(self):
        tasks = self.build_lanes(TWO)
        with self.assertRaises(landing.LandingError) as caught:
            landing.fast_forward(self.folders["L1"], tasks[1]["lane_commit"])
        self.assertEqual(caught.exception.code, "not-fast-forward")
        landing.fast_forward(self.cell, self.fork)  # already there: nothing to do


class InterruptedTest(Base):
    """A join stopped at any point (the process dies) can be run again: it finishes, and never lands a commit twice."""

    def crash_then_finish(self, runner=None, suite=None, patch=None):
        tasks = self.build_lanes(TWO)
        with mock.patch.object(landing.workspace, "create", patch) if patch else contextlib.nullcontext():
            with self.assertRaises(Crash):
                self.join(tasks, self.lane_tests(TWO), git=runner or landing.run_git, run_suite=suite or run_suite)
        moved = self.head(self.cell) != self.fork
        if not moved:
            self.assertUntouched()
        result = self.join(tasks, self.lane_tests(TWO))
        self.assertEqual(result["status"], "JOINED", result)
        self.assertEqual(self.history(self.cell), self.sequential(TWO))  # four commits, in plan order, none twice
        self.assertEqual(result["suite"]["ran_on"], self.head(self.cell))
        self.assertClean()
        return moved, result

    def test_while_reading_the_lanes(self):
        self.assertEqual(self.crash_then_finish(crashing(lambda a, n: "before" if a[0] == "diff-tree" and n == 3 else None))[0], False)

    def test_after_making_the_join_branch(self):
        self.crash_then_finish(crashing(lambda a, n: "after" if a[:1] == ["branch"] and len(a) == 3 else None))

    def test_after_making_the_join_worktree(self):
        real = workspace.create

        def create(project, repo, branch):
            real(project, repo, branch)
            raise Crash("after worktree")
        self.crash_then_finish(patch=create)

    def test_after_landing_one_commit(self):
        self.crash_then_finish(crashing(lambda a, n: "after" if a[0] == "cherry-pick" and n == 1 else None))

    def test_after_landing_two_of_four_commits(self):
        self.crash_then_finish(crashing(lambda a, n: "after" if a[0] == "cherry-pick" and n == 2 else None))

    def test_in_the_middle_of_a_cherry_pick(self):
        def when(args, n):
            return "before" if args[0] == "cherry-pick" and n == 3 else None
        self.crash_then_finish(crashing(when))

    def test_during_the_suite(self):
        def suite(folder):
            raise Crash("suite")
        self.crash_then_finish(suite=suite)

    def test_just_before_the_fast_forward(self):
        moved, _ = self.crash_then_finish(crashing(lambda a, n: "before" if a[0] == "merge" else None))
        self.assertFalse(moved)

    def test_just_after_the_fast_forward(self):
        moved, result = self.crash_then_finish(crashing(lambda a, n: "after" if a[0] == "merge" else None))
        self.assertTrue(moved)
        self.assertTrue(result["resumed"])
        self.assertEqual(result["suite"]["where"], "cell checkout")
        self.assertEqual([item["task"] for item in result["landed"]], ["T01", "T02", "T03", "T04"])

    def test_during_cleanup(self):
        moved, result = self.crash_then_finish(crashing(lambda a, n: "before" if a[:2] == ["worktree", "remove"] and n == 2 else None))
        self.assertTrue(moved)
        self.assertTrue(result["resumed"])

    def test_an_earlier_join_worktree_left_half_made(self):
        tasks = self.build_lanes(TWO)
        self.put(self.join_repo, {"stray.txt": "x\n"})  # a folder, not a registered worktree
        self.assertEqual(self.join(tasks, self.lane_tests(TWO))["status"], "JOINED")
        self.assertClean()


class RemoveTest(Base):
    def test_it_never_removes_work_that_has_not_landed(self):
        tasks = self.build_lanes(TWO)
        self.put(self.folders["L1"], {"app/half.py": "x = \n"})  # a half-written file in a landed lane
        result = self.join(tasks, self.lane_tests(TWO))
        self.assertEqual(result["status"], "JOINED")
        self.assertTrue(self.folders["L1"].exists())
        self.assertEqual(len(result["left"]), 2, result["left"])
        self.assertIn("uncommitted work that has not landed: app/half.py", result["left"][0])
        self.assertIn("used by worktree", result["left"][1])  # its branch stays with its worktree
        self.assertNotIn(str(self.folders["L1"]), result["removed"])
        self.assertNotIn(self.branches["L1"], result["removed"])
        self.assertIn(self.branches["L2"], result["removed"])
        left = landing.remove(self.project, [self.folders["L1"]], [self.branches["L1"]], landed_on=result["tip"])
        self.assertEqual(len(left), 2)
        self.assertEqual(landing.remove(self.project, [self.folders["L1"]], [self.branches["L1"]]), [])  # a person said to discard it
        self.assertClean()

    def test_a_branch_with_commits_that_did_not_land_stays(self):
        tasks = self.build_lanes(TWO)
        left = landing.remove(self.project, [], [self.branches["L1"]], landed_on=self.fork)
        self.assertEqual(len(left), 1)
        self.assertIn("commits that have not landed", left[0])
        self.assertIn(self.branches["L1"], self.branch_list())
        self.assertIn(tasks[0]["lane_commit"][:10], left[0])

    def test_only_lane_folders_and_lane_branches(self):
        left = landing.remove(self.project, [self.tmp / "elsewhere", self.cellroot.parent.parent / "config.json"], ["main", f"feature/{TICKET}"])
        self.assertEqual(len(left), 4)
        self.assertEqual(self.branch_list(), [f"feature/{TICKET}", "main"])
        self.assertTrue(self.project.exists())

    def test_what_is_already_gone_is_not_a_problem(self):
        self.assertEqual(landing.remove(self.project, [self.cellroot / "lanes" / "L9" / "repo"], [f"mach-lane/{TICKET}/L9"]), [])


class HelpersTest(unittest.TestCase):
    def test_failing_tests_from_unittest_and_pytest(self):
        out = ("FAIL: test_a (tests.test_x.T)\n----\nERROR: test_b (tests.test_y.U)\n"
               "FAILED tests/test_z.py::T::test_c - AssertionError\nERROR tests/test_w.py\n")
        self.assertEqual(landing.failing_tests(out), ["tests.test_x.T.test_a", "tests.test_y.U.test_b", "tests/test_z.py::T::test_c", "tests/test_w.py"])

    def test_the_python_3_11_unittest_header_is_read_the_same(self):
        self.assertEqual(landing.failing_tests("FAIL: test_a (tests.test_x.T.test_a)\n"), ["tests.test_x.T.test_a"])


if __name__ == "__main__":
    unittest.main()
