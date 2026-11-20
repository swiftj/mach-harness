"""Tests for M13 part B, layer 3: the build station builds on today's main.

`build.py start` and `build.py revise` bring the ticket's branch up to date with the main checkout's committed HEAD,
and never at any other step. A clean merge is one merge commit made by the station and recorded; a conflict changes
nothing and stops for a person (the routing sheet's `main-conflict`). The merge is not a task: the gates and the build
report judge only what the builder changes."""

import json
import sys
import unittest
from pathlib import Path

from test_build import Base, IMPL, IMPL2, ROOT, SCENARIO_TEST, SPEC, SPEC_NAME, TEST_CMD, git

sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
import decide  # noqa: E402
import run  # noqa: E402

TICKET = "LOCAL-001"
FINDINGS = "1. invite() ignores the email.\n"


class MainBase(Base):
    def main_commit(self, files, message="main work"):
        self.put(self.project, files)
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", message)
        return git(self.project, "rev-parse", "HEAD").stdout.strip()

    def head(self):
        return git(self.work, "rev-parse", "HEAD").stdout.strip()

    def cell(self):
        return json.loads((self.cellroot / "cell.json").read_text())

    def report(self):
        return json.loads((self.cellroot / "build-report.json").read_text())

    def config(self, **build):
        self.put(self.project, {".factory/config.json": json.dumps({"build": build})})

    def next_step(self):
        return run.next_step(run.Project(self.project), TICKET, False)

    def findings(self):
        path = Path(self.tmp.name) / "findings.md"
        path.write_text(FINDINGS)
        return str(path)

    def built(self):
        """A ticket built from today's main, then sent back by review."""
        self.ready()
        self.ok("start", TICKET)
        self.build_through("T05")
        self.ok("finish", TICKET)


class StartTest(MainBase):
    def test_already_up_to_date_records_nothing(self):
        self.ready()
        started = self.ok("start", TICKET)
        self.assertIsNone(started["synced_with_main"])
        self.assertEqual(self.state()["main_merges"], [])
        self.assertFalse(any(line.startswith("Merge ") for line in self.log()))

    def test_a_clean_merge_is_one_commit_by_the_station_and_is_recorded(self):
        self.groom()
        self.main_commit({"app/later.py": "VALUE = 1\n"}, "later 1")
        main_head = self.main_commit({"app/later2.py": "VALUE = 2\n"}, "later 2")
        self.audit_report()
        before = self.head()
        started = self.ok("start", TICKET)
        self.assertIn("2 commit(s) behind main", started["synced_with_main"])
        self.assertEqual(self.log()[0], f"Merge main into feature/{TICKET} before building [{TICKET}]")
        [merge] = self.state()["main_merges"]
        self.assertEqual((merge["when"], merge["loop"], merge["by"], merge["main_commit"], merge["branch_commit"], merge["behind"]),
                         ("start", 0, "build station", main_head, before, 2))
        self.assertEqual(merge["merge_commit"], self.head())
        self.assertEqual(git(self.work, "log", "-1", "--format=%P").stdout.split(), [before, main_head])
        self.assertTrue(merge["at"])
        self.assertEqual(self.state()["baseline"], self.head(), "the build's own diff starts after the merge")
        self.build_through("T05")
        self.ok("finish", TICKET)
        report = self.report()
        self.assertEqual(report["main_merges"]["merges"], [merge])
        self.assertTrue(report["main_merges"]["enabled"])
        self.assertNotIn("app/later.py", report["files_changed"])
        self.assertEqual(sorted(report["files_changed"]), ["README.md", "app/invite.py", "tests/test_invite.py", "tests/test_scenarios.py"])

    def test_a_conflict_changes_nothing_and_stops_for_a_person(self):
        self.groom()
        self.put(self.work, {"README.md": "# Sample\n\ncell side\n"})
        git(self.work, "commit", "-qam", "cell edit")
        main_head = self.main_commit({"README.md": "# Sample\n\nmain side\n"})
        self.audit_report()
        before = self.head()
        refusal = self.refused("start", TICKET)
        self.assertIn("main has moved on since this ticket's branch was last brought up to date, and bringing the branch up to date conflicts in README.md", refusal)
        self.assertIn(f"A person must merge main into feature/{TICKET} in {self.work} and resolve it", refusal)
        self.assertIn("Nothing was changed", refusal)
        self.assertEqual((self.head(), git(self.work, "status", "--porcelain").stdout), (before, ""))
        self.assertNotEqual(git(self.work, "rev-parse", "-q", "--verify", "MERGE_HEAD").returncode, 0, "no merge is left half done")
        cell = self.cell()
        self.assertEqual(cell["stage"], "planned")
        self.assertEqual({k: cell["main_conflict"][k] for k in ("during", "main", "main_commit", "branch_commit", "files", "folder")},
                         {"during": "start", "main": "main", "main_commit": main_head, "branch_commit": before, "files": ["README.md"], "folder": str(self.work)})
        self.assertNotIn("tasks", self.state() if (self.cellroot / "build.json").is_file() else {})
        # The routing sheet stops for a person, and the walkthrough offers what can be done.
        stop = self.next_step()
        self.assertEqual((stop["action"], stop["needs"], stop["files"], stop["folder"]), ("stop", "main-conflict", ["README.md"], str(self.work)))
        self.assertIn("conflicts in README.md", stop["reason"])
        walked = decide.main([TICKET], self.project, config={}, next_step=lambda ticket: self.next_step())
        [item] = walked["tickets"]
        self.assertEqual((item["state"], item["situation"]["conflict"]["files"]), ("main-conflict", ["README.md"]))
        self.assertEqual([option["key"] for option in item["options"]], ["run", "replan", "abandon"])
        # A person merges main in the cell and resolves it; the line carries on and the build starts from their commit.
        git(self.work, "merge", "-q", main_head)
        self.put(self.work, {"README.md": "# Sample\n\nboth sides\n"})
        git(self.work, "commit", "-qam", "resolve")
        self.assertEqual(self.next_step()["action"], "build")
        started = self.ok("start", TICKET)
        self.assertIn("A person brought the branch up to date", started["synced_with_main"])
        [merge] = self.state()["main_merges"]
        self.assertEqual((merge["by"], merge["branch_commit"], merge["merge_commit"]), ("a person", before, self.head()))
        self.assertNotIn("main_conflict", self.cell())

    def test_the_stop_lifts_when_main_moves_on(self):
        self.groom()
        self.put(self.work, {"README.md": "# Sample\n\ncell side\n"})
        git(self.work, "commit", "-qam", "cell edit")
        self.main_commit({"README.md": "# Sample\n\nmain side\n"})
        self.audit_report()
        self.refused("start", TICKET)
        self.assertEqual(self.next_step()["needs"], "main-conflict")
        self.main_commit({"app/other.py": "X = 1\n"})
        self.audit_report()
        self.assertEqual(self.next_step()["action"], "build", "a newer main is tried again by the builder")

    def test_a_suite_that_fails_only_once_main_is_merged_names_the_cause(self):
        self.groom()
        main_head = self.main_commit({"tests/test_late.py": "import unittest\n\nclass L(unittest.TestCase):\n    def test_late(self):\n        self.fail('late')\n"})
        self.audit_report()
        code, out, err = self.run_build("start", TICKET)
        self.assertEqual(code, 1, out)
        self.assertIn(f"now that main ({main_head[:10]}) is merged into the branch", err)
        self.assertIn("Nothing has been built for this ticket yet, so its own work is not the cause", err)
        self.assertEqual(self.cell()["stage"], "planned")
        [merge] = self.state()["main_merges"]
        self.assertEqual(merge["merge_commit"], self.head(), "the merge stays and is recorded although the start was refused")
        lines = [json.loads(line) for line in (self.cellroot / "lifecycle.jsonl").read_text().splitlines()]
        self.assertEqual(lines[-1]["data"]["reason_code"], "baseline-red-after-main")
        # Fixed on main; the next start merges again and keeps both records.
        (self.project / "tests/test_late.py").unlink()
        self.main_commit({})
        self.audit_report()
        self.ok("start", TICKET)
        self.assertEqual([m["when"] for m in self.state()["main_merges"]], ["start", "start"])

    def test_the_setting_switches_it_off(self):
        self.groom()
        self.main_commit({"app/later.py": "VALUE = 1\n"})
        self.audit_report()
        self.config(update_from_main=False)
        before = self.head()
        started = self.ok("start", TICKET)
        self.assertIsNone(started["synced_with_main"])
        self.assertEqual((self.head(), self.state()["main_merges"], self.state()["update_from_main"]), (before, [], False))
        self.assertFalse((self.work / "app/later.py").exists())
        template = json.loads((ROOT / "templates/config.json").read_text())
        self.assertIs(template["build"]["update_from_main"], True)

    def test_the_adr_record_of_the_plan_is_not_changed(self):
        self.groom()
        adrs_before = self.cell().get("adrs")
        name = next(path for path in (self.project / "docs/adr").glob("*.md"))
        self.main_commit({str(name.relative_to(self.project)): name.read_text() + "\nA later note.\n"})
        self.audit_report()
        self.ok("start", TICKET)
        self.assertEqual(self.cell().get("adrs"), adrs_before)
        self.build_through("T05")
        self.ok("finish", TICKET)
        self.assertNotIn(str(name.relative_to(self.project)), self.report()["files_changed"], "main's ADR change is not this ticket's")

    def test_main_lines_that_look_like_a_secret_are_not_this_tickets(self):
        self.groom()
        shaped = "AKIA" + "Q7" * 8  # an access key's shape, built here so no file holds it
        self.main_commit({"app/settings.py": f"KEY = '{shaped}'\n"})
        self.audit_report()
        self.ok("start", TICKET)
        self.build_through("T05")
        self.ok("finish", TICKET)
        report = self.report()
        self.assertEqual((report["secret_scan"]["not_a_secret"], report["deviations"]), ([], []))


class ResumeTest(MainBase):
    def test_no_merge_between_start_and_finish(self):
        self.ready()
        self.ok("start", TICKET)
        self.build_through("T01")
        self.main_commit({"app/later.py": "VALUE = 1\n"})
        self.assertIn("already started", self.refused("start", TICKET))
        self.ok("next", TICKET)
        self.build_steps_after_t01()
        self.assertFalse(any(line.startswith("Merge ") for line in self.log()), "a red-to-green pair is never split by a merge")
        done = self.ok("finish", TICKET)
        self.assertEqual(done["status"], "BUILT")
        self.assertEqual(self.report()["timing"]["final_run_reused_from"], "T05", "the last whole-suite run on the tip still stands")
        self.assertEqual(self.next_step()["action"], "verify")

    def build_steps_after_t01(self):
        for task, step, files in (("T02", "green", {"app/invite.py": IMPL}), ("T03", "red", {"tests/test_scenarios.py": SCENARIO_TEST}),
                                  ("T04", "green", {"app/invite.py": IMPL2}), ("T05", "done", {"README.md": "# Sample\n\nAdmins can invite teammates.\n"})):
            self.put(self.work, files)
            self.ok(step, TICKET, task)


class ReviseTest(MainBase):
    def test_a_clean_merge_at_revise_is_recorded_and_kept_out_of_the_tickets_changes(self):
        self.built()
        built_head = self.head()
        main_head = self.main_commit({"app/other.py": "X = 1\n", "tests/test_base.py": "import unittest\n\nclass B(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(1)\n"})
        revising = self.ok("revise", TICKET, "--findings", self.findings())
        self.assertIn("1 commit(s) behind main", revising["synced_with_main"])
        self.assertEqual((revising["loop"], revising["suite"], revising["tests_after_merge"]), (1, "green", None))
        self.assertEqual(self.log()[0], f"Merge main into feature/{TICKET} before revision 1 [{TICKET}]")
        merge = self.state()["main_merges"][-1]
        self.assertEqual((merge["when"], merge["loop"], merge["main_commit"], merge["branch_commit"], merge["merge_commit"], merge["tests_after"]["passed"]),
                         ("revise", 1, main_head, built_head, self.head(), True))
        # The merge brought a changed committed test (main's) and files no task names: neither is judged as this task's change.
        self.ok("add-task", TICKET, "--kind", "docs", "--text", "Explain the fix (FR-01)", "--file", "README.md")
        self.put(self.work, {"README.md": "# Sample\n\nFixed.\n"})
        self.ok("done", TICKET, "R1-T01")
        self.assertEqual(self.state()["deviations"], [])
        self.ok("finish", TICKET)
        report = self.report()
        self.assertEqual(sorted(report["files_changed"]), ["README.md", "app/invite.py", "tests/test_invite.py", "tests/test_scenarios.py"])
        self.assertEqual(report["compared_with"], main_head)
        self.assertEqual([m["when"] for m in report["main_merges"]["merges"]], ["revise"])
        self.assertIn("own commits' files", report["main_merges"]["note"])
        # What review's delta needs: the station's merge commit, not the earlier round's head, as "since".
        since_earlier = git(self.work, "diff", "--name-only", f"{built_head}..HEAD").stdout.split()
        since_merge = git(self.work, "diff", "--name-only", f"{merge['merge_commit']}..HEAD").stdout.split()
        self.assertIn("app/other.py", since_earlier)
        self.assertEqual(since_merge, ["README.md"])
        # Review's whole-ticket diff starts at the merge base with main, which is the merged main: main's files are not in it.
        fork = git(self.work, "merge-base", "HEAD", "main").stdout.strip()
        self.assertEqual(fork, main_head)
        self.assertNotIn("app/other.py", git(self.work, "diff", "--name-only", f"{fork}..HEAD").stdout.split())

    def test_finish_right_after_a_merge_runs_the_suite_again(self):
        self.built()
        self.main_commit({"app/other.py": "X = 1\n"})
        self.ok("revise", TICKET)
        self.ok("finish", TICKET)
        self.assertIsNone(self.report()["timing"]["final_run_reused_from"], "the tip is the merge commit, so the last task's run does not stand")

    def test_revise_when_up_to_date_records_nothing(self):
        self.built()
        revising = self.ok("revise", TICKET)
        self.assertIsNone(revising["synced_with_main"])
        self.assertEqual(self.state()["main_merges"], [])
        self.ok("finish", TICKET)
        self.assertEqual(self.report()["timing"]["final_run_reused_from"], "T05")

    def test_a_suite_that_fails_after_the_merge_is_said_and_must_be_fixed(self):
        self.built()
        self.main_commit({"tests/test_late.py": "import unittest\nfrom app import invite\n\nclass L(unittest.TestCase):\n"
                                                "    def test_cancel(self):\n        self.assertEqual(invite.cancel(), 'cancelled')\n"})
        revising = self.ok("revise", TICKET, "--findings", self.findings())
        self.assertEqual(revising["suite"], "red")
        self.assertIn("The test suite passed when this ticket was last built and fails now that main is merged in", revising["tests_after_merge"])
        self.assertFalse(self.state()["main_merges"][-1]["tests_after"]["passed"])
        self.ok("add-task", TICKET, "--kind", "impl", "--text", "Add cancel (FR-01)", "--file", "app/invite.py")
        self.put(self.work, {"app/invite.py": IMPL2 + "\n\ndef cancel():\n    return 'cancelled'\n"})
        self.ok("green", TICKET, "R1-T01")
        self.assertEqual(self.ok("finish", TICKET)["status"], "BUILT")
        self.assertNotIn("tests/test_late.py", self.report()["test_files"], "main's tests are not this ticket's frozen tests")

    def test_a_conflict_at_revise_changes_nothing_and_uses_no_round(self):
        self.built()
        built_head = self.head()
        main_head = self.main_commit({"README.md": "# Sample\n\nmain side\n"})
        findings = self.findings()
        refusal = self.refused("revise", TICKET, "--findings", findings)
        self.assertIn("bringing the branch up to date conflicts in README.md", refusal)
        self.assertIn("then start the revision again", refusal)
        self.assertEqual((self.head(), git(self.work, "status", "--porcelain").stdout), (built_head, ""))
        self.assertEqual((self.cell()["stage"], self.state()["loop"]), ("built", 0))
        self.assertFalse((self.cellroot / "review-findings-1.md").exists())
        self.assertEqual(self.cell()["main_conflict"]["during"], "revise")
        # Review rejected this build: the routing sheet stops for the conflict instead of handing it to a builder.
        (self.cellroot / "review").mkdir(exist_ok=True)
        (self.cellroot / "review" / "decision.json").write_text(json.dumps({"outcome": "REJECTED", "head": built_head, "findings": findings}))
        self.assertEqual(self.next_step()["needs"], "main-conflict")
        # A person resolves it in the cell: the line revises from their commit, and the revision records it.
        git(self.work, "merge", "-q", main_head)
        self.put(self.work, {"README.md": "# Sample\n\nboth sides\n"})
        git(self.work, "commit", "-qam", "resolve")
        step = self.next_step()
        self.assertEqual((step["action"], step["findings"]), ("revise", str(Path(findings).resolve())))
        revising = self.ok("revise", TICKET, "--findings", findings)
        self.assertEqual(revising["loop"], 1)
        merge = self.state()["main_merges"][-1]
        self.assertEqual((merge["by"], merge["branch_commit"], merge["merge_commit"]), ("a person", built_head, self.head()))
        self.assertNotIn("main_conflict", self.cell())

    def test_the_escalating_round_does_not_merge(self):
        self.built()
        self.put(self.project, {".factory/config.json": json.dumps({"review": {"max_loops": 1}})})
        self.main_commit({"app/other.py": "X = 1\n"})
        before = self.head()
        code, out, _ = self.run_build("revise", TICKET)
        self.assertEqual((code, json.loads(out)["status"], self.head()), (1, "ESCALATE", before))


class SpecGuardTest(MainBase):
    commit_first = False

    def test_a_merge_that_would_change_the_spec_is_refused_and_changes_nothing(self):
        # A project groomed before it had history: the spec is committed on main, so main can change it without a conflict.
        self.groom()
        self.put(self.project, {".factory/config.json": json.dumps({"build": {"require_audit": False}})})
        self.commit_main()
        started = self.ok("start", TICKET, "--test-cmd", TEST_CMD)
        self.assertIsNone(started["synced_with_main"], "a worktree made at main's HEAD is already up to date")
        self.assertEqual(self.state()["main_merges"], [])
        self.build_through("T05")
        self.ok("finish", TICKET)
        before = self.head()
        self.main_commit({f"specs/slices/{SPEC_NAME}": SPEC.replace("7 days", "14 days")})
        refusal = self.refused("revise", TICKET)
        self.assertIn("would change its slice spec, so nothing was changed", refusal)
        self.assertEqual((self.head(), git(self.work, "status", "--porcelain").stdout, self.state()["loop"]), (before, "", 0))


if __name__ == "__main__":
    unittest.main()
