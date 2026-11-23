"""Team audit: two engineers' Factories, each on their own computer and clone, taking slices from one GitHub repository.

Reproductions only. A test marked expectedFailure shows a real defect: it states what a team needs and fails today.
The others pin down where the behaviour already holds.

Builds on test_mach_product_intake: the engineer's clone `eng` is one Factory; `eng2` is a second clone of the same
shared repository, set up the same way, standing in for a second engineer's computer. Both reach the one GitHub
stand-in (the same issues and labels), as two machines would.
"""

import io
import json
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from test_mach_product_intake import Base as IntakeBase  # noqa: E402
from test_mach_product_issues import ADDRESS, git  # noqa: E402
import class_template  # noqa: E402
import run  # noqa: E402


class TwoFactories(IntakeBase):
    def setUp(self):
        super().setUp()
        self.eng2 = self.root / "eng2"
        class_template.step(self, "second factory", self.root, self.second_factory)

    def second_factory(self):
        """A second engineer's clone, set up as a Factory exactly like the first; files only."""
        self.clone("eng2", "Finn Engineer")
        git(self.eng2, "remote", "set-url", "origin", ADDRESS)
        git(self.eng2, "config", f"url.{self.origin}.insteadOf", ADDRESS)
        (self.eng2 / ".factory").mkdir()
        (self.eng2 / ".factory/config.json").write_text(json.dumps({"tickets": {"provider": "local"}, "factory": {"max_parallel": 3}}))

    def product2(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.eng2), "product", *argv])
        self.assertEqual(code, 0, err.getvalue() + out.getvalue())
        return json.loads(out.getvalue())

    def building_comments(self, number):
        return [body for body in self.comments_on(number) if body.startswith("The MACH Factory has started building")]


class SameSliceTwiceTest(TwoFactories):
    def test_a_factory_that_reads_after_the_other_took_it_leaves_it_alone(self):
        """Scenario 5, outside the window: SAFE. Once one Factory has dispatched and replaced mach:ready with
        mach:building, another Factory's intake no longer lists the issue."""
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.assertEqual(self.labels_of(number), ["mach:building", "mach:slice"])
        taken = self.product2("intake")
        self.assertEqual(taken["created"], [])
        self.assertFalse((self.eng2 / ".factory/worktrees").exists())

    @unittest.expectedFailure
    def test_two_factories_that_read_before_either_dispatched_both_build_it(self):
        """Scenario 5 and 9, inside the window: SILENT. Both Factories read the issue while it is mach:ready (a `pull`
        or a supervisor pass reads, then dispatches). The first dispatches and labels it mach:building; the second
        dispatches from what it read, without asking GitHub again, and opens its own cell and branch for the same
        slice. Nothing on either machine says so: the only trace is a second 'started building' comment on the issue."""
        number = self.ready("SLICE-001", self.epic())
        self.product2("intake")  # the second Factory's read
        self.product("intake")
        self.product("dispatch", "SLICE-001")  # the first Factory takes it: mach:building
        second = self.product2("dispatch", "SLICE-001")
        built_on = [name for name in ("eng", "eng2") if (self.root / name / ".factory/worktrees" / str(number) / "cell.json").is_file()]
        self.assertEqual(second["tickets"], [], f"the slice is being built on {built_on}; comments saying so: {len(self.building_comments(number))}")

    @unittest.expectedFailure
    def test_a_slice_changed_while_one_factory_builds_it_is_built_again_by_another(self):
        """Scenario 7: SILENT. The product manager reopens a slice one Factory is building and marks the new revision
        ready. The issue then carries mach:building and mach:ready together (handoff.run adds mach:ready; nothing
        removes mach:building), and ticket.py slice-check accepts an issue with mach:ready whatever else it carries.
        The building Factory rightly holds revision 2 for a person; any other Factory takes revision 2 in as a new
        slice and dispatches it, so two machines build two revisions of one slice at once."""
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        # Product Studio: reopen (mach:ready off), then ready again as revision 2 (body, approval, mach:ready on).
        state = self.gh()
        self.label(state, state["issues"][str(number)], "mach:ready", kind="unlabeled")
        self.write_state(state)
        self.ready("SLICE-001", epic, revision=2, number=number, extra="\nA clarification.\n")
        self.assertEqual(self.labels_of(number), ["mach:building", "mach:ready", "mach:slice"])
        held = self.product("intake")
        self.assertEqual([item["slice_id"] for item in held["needs_person"]], ["SLICE-001"])  # the first Factory waits for a person
        self.product2("intake")
        second = self.product2("dispatch", "SLICE-001")
        self.assertEqual(second["tickets"], [], "a second Factory dispatched revision 2 while the first is building revision 1")


class SplitChainTest(TwoFactories):
    @unittest.expectedFailure
    def test_a_slice_whose_dependency_shipped_from_another_machine_stays_blocked(self):
        """Scenario 4 and 8 across machines: DETECTED but stuck. The second Factory took in SLICE-001 and SLICE-002
        (which depends on it) while both were ready. The first Factory built and merged SLICE-001. On the second
        machine, with the merge pulled, SLICE-002 still waits: intake.plan judges a dependency this Factory took in by
        this Factory's own cell and run records (work()), never by the merged spec it would accept for a dependency it
        never took in. Only the machine that built SLICE-001 can build SLICE-002."""
        epic = self.epic()
        first = self.ready("SLICE-001", epic)
        self.ready("SLICE-002", epic, depends=[first], title="Remove a teammate")
        self.product2("intake")
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.integrate(str(first))
        git(self.eng, "push", "-q", "origin", "main")
        git(self.eng2, "pull", "-q", "--ff-only")
        self.product2("intake")
        rows = {row["slice_id"]: row for row in self.product2("plan")["slices"]}
        self.assertTrue(rows["SLICE-002"]["dispatchable"], f"SLICE-002 on the second machine: {rows['SLICE-002']['state']}: {rows['SLICE-002']['reasons']}")


if __name__ == "__main__":
    unittest.main()
