"""Tests for cell.py: cells, slice IDs, and the gates between grooming stages."""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
import cell  # noqa: E402
sys.path.insert(0, str(ROOT / "tests"))
import adr_baseline_fixture  # noqa: E402  (the test projects' covered ADR baseline)

SPEC_NAME = "SLICE-001-invite-teammate.md"
SPEC = (ROOT / "tests" / "fixtures" / SPEC_NAME).read_text(encoding="utf-8")
OPEN_SPEC = SPEC.replace("## Open questions\n\n- None.", "## Open questions\n\n- What is the seat price? Follow up: Finance team.")

INTENT = """# Intent: Invite a teammate by email

- **Ticket:** LOCAL-001 (local)
- **Slice:** SLICE-001 at specs/slices/SLICE-001-invite-teammate.md
- **Mode:** Interactive
- **Status:** Ready for contracts

## Why

- **Problem:** Admins cannot add teammates without contacting support.
- **Who it is for:** Workspace admin
- **Success looks like:** An admin adds a teammate without help.

## Goal ancestry

- **Goal:** Not stated.
- **Epic:** Team management
- **Ticket:** LOCAL-001: Invite teammates
- **Slice:** SLICE-001: an admin invites one teammate by email

## Constraints

- None.

## Risk

- **Tier:** Medium
- **Reason:** Ordinary product behavior; no money or permissions change.

## Deferred work

- Inviting many teammates at once from a file (SLICE-002)
"""

PLAN = """# Plan: SLICE-001: Invite a teammate by email

- **App type:** web
- **Risk tier:** High
- **Contracts:** `proto/openapi/members.yaml`
- **ADRs:** None.

## Contracts

- `proto/openapi/members.yaml`: new. Invitation requests and refusals (FR-03, FR-04, FR-05, FR-07)

## Tasks

- [ ] T01 [test] Table-driven test of rules R1 to R5, 16 cases — `tests/invite.test.ts` (FR-01, FR-02, FR-03, FR-04, FR-05, FR-07, INV-01, INV-02, INV-04)
- [ ] T02 [impl] Invitation service — `src/invite.ts` (FR-01, FR-02)
- [ ] T03 [test] Scenarios — `tests/invite.scenarios.test.ts` (AC-01, AC-02, AC-03, FR-06, FR-08, FR-09, INV-03)
- [ ] T04 [impl] Expiry and failure handling — `src/invite.ts` (FR-06, FR-08)

## File touch map

| File | Change | Tasks |
|------|--------|-------|
| `src/invite.ts` | create | T02, T04 |

## Engineering decisions

- None.
"""


def run(*argv, project):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = cell.main(["--project", str(project), *argv])
    return code, out.getvalue(), err.getvalue()


def git(project, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    return subprocess.run(["git", *args], cwd=str(project), capture_output=True, text=True, env=env)


class Base(unittest.TestCase):
    with_git = True

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name).resolve() / "project"
        self.project.mkdir()
        if self.with_git:
            git(self.project, "init", "-q", "-b", "main")
            git(self.project, "config", "user.name", "t")
            git(self.project, "config", "user.email", "t@example.com")
            git(self.project, "config", "commit.gpgsign", "false")
            (self.project / "README.md").write_text("demo\n")
            adr_baseline_fixture.write(self.project)
            git(self.project, "add", ".")
            git(self.project, "commit", "-q", "-m", "init")

    def open(self, ticket="LOCAL-001", *extra):
        code, out, _ = run("open", ticket, *extra, project=self.project)
        self.assertEqual(code, 0)
        return json.loads(out)

    def groom(self, ticket="LOCAL-001", spec=SPEC, name=SPEC_NAME, intent=INTENT):
        info = self.open(ticket)
        Path(info["specs_dir"]).mkdir(parents=True, exist_ok=True)
        (Path(info["specs_dir"]) / name).write_text(spec, encoding="utf-8")
        if intent:
            Path(info["intent_path"]).write_text(intent, encoding="utf-8")
        return info


class OpenTest(Base):
    def test_open_creates_an_isolated_worktree_on_a_feature_branch(self):
        info = self.open()
        self.assertEqual(info["isolation"], "worktree")
        self.assertEqual(info["branch"], "feature/LOCAL-001")
        self.assertEqual(Path(info["workdir"]), self.project / ".factory/worktrees/LOCAL-001/repo")
        self.assertTrue((Path(info["workdir"]) / "README.md").is_file())
        self.assertEqual(git(Path(info["workdir"]), "branch", "--show-current").stdout.strip(), "feature/LOCAL-001")
        self.assertEqual(git(self.project, "status", "--porcelain").stdout, "", "cells must not show up in the main checkout")

    def test_open_twice_returns_the_same_cell(self):
        first = self.open()
        second = self.open("LOCAL-001", "--headless")
        self.assertEqual(first["created_at"], second["created_at"])
        self.assertEqual(second["mode"], "headless")
        self.assertEqual(self.open()["mode"], "interactive", "a person resuming a headless ticket is interviewed")

    def test_bad_ticket_id_is_refused(self):
        code, _, err = run("open", "../escape", project=self.project)
        self.assertEqual(code, 2)
        self.assertIn("not a usable ticket ID", err)

    def test_project_is_found_from_inside_a_cell(self):
        info = self.open()
        self.assertEqual(cell.find_project(Path(info["workdir"]) / "specs"), self.project)

    def test_open_reports_ticket_files(self):
        run("ticket-new", "--title", "Invite teammates", project=self.project)
        info = self.open()
        self.assertTrue(info["ticket"]["local_ticket"].endswith(".factory/tickets/LOCAL-001.md"))


class NoGitTest(Base):
    with_git = False

    def test_without_git_the_cell_works_in_the_project_root(self):
        info = self.open()
        self.assertEqual(info["isolation"], "none")
        self.assertEqual(Path(info["workdir"]), self.project)
        self.assertIn("not a git repository", info["note"])

    def test_a_repository_git_cannot_read_stops_the_ticket(self):
        """A .git that Git refuses (an ownership rule, a broken repository) is not "no Git": nothing works in the project root."""
        (self.project / ".git").write_text("gitdir: /nowhere/that/exists\n")
        code, _out, err = run("open", "LOCAL-001", "--title", "Invite teammates", project=self.project)
        self.assertEqual(code, 2)
        self.assertIn("no work happens in the project root", err)
        self.assertFalse((self.project / ".factory" / "worktrees" / "LOCAL-001" / "cell.json").exists())

    def test_full_flow_without_git(self):
        self.groom()
        code, out, _ = run("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}", project=self.project)
        self.assertEqual(code, 0, out)
        self.assertNotIn("Committed", out)


class SliceIdTest(Base):
    def test_next_id_counts_files_and_reservations_across_cells(self):
        self.groom()  # SLICE-001, reserves 002-004
        code, out, _ = run("next-id", "--count", "2", project=self.project)
        data = json.loads(out)
        self.assertEqual(code, 0)
        self.assertEqual(data["next"], ["SLICE-005", "SLICE-006"])
        self.assertEqual([r["id"] for r in data["reserved_without_spec"]], ["SLICE-002", "SLICE-003", "SLICE-004"])
        self.assertEqual(data["existing"], [{"id": "SLICE-001", "file": SPEC_NAME}])

    def test_two_cells_cannot_take_the_same_slice_id(self):
        self.groom("LOCAL-001")
        self.groom("LOCAL-002", name="SLICE-001-other-feature.md", spec=SPEC)
        code, out, _ = run("validate", "LOCAL-002", "--spec", "specs/slices/SLICE-001-other-feature.md", project=self.project)
        self.assertEqual(code, 1)
        self.assertIn("[duplicate-slice-id]", out)


class HandOffTest(Base):
    """A slice Product Studio handed over is one slice on both sides of the hand-off: the product manager's draft of it in the
    Studio workspace, under the name it was started with, is never a duplicate of the Factory's copy, wherever that is written."""

    def studio_draft(self, name="SLICE-001-allow-list-access.md"):
        folder = self.project / ".factory/studio/draft/specs/slices"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_text(SPEC, encoding="utf-8")

    def finalize(self, *extra):
        return run("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}", "--no-commit", *extra, project=self.project)

    def test_the_draft_is_the_same_slice_as_the_one_handed_over(self):
        self.studio_draft()
        self.groom()
        code, out, _ = self.finalize()
        self.assertEqual(code, 1)  # without the hand-off on record, two files with one ID are two slices
        self.assertIn("SLICE-001 is already used by SLICE-001-allow-list-access.md", out)
        code, out, _ = self.finalize("--from-studio", "SLICE-001")
        self.assertEqual(code, 0, out)
        self.assertNotIn("duplicate-slice-id", out)
        # Afterwards the cell's own record of where its slice came from says so, for every later check.
        path = self.project / ".factory/worktrees/LOCAL-001/cell.json"
        data = json.loads(path.read_text())
        data["product"] = {"slice_id": "SLICE-001", "revision": 1}
        path.write_text(json.dumps(data))
        code, out, _ = run("validate", "LOCAL-001", project=self.project)
        self.assertEqual(code, 0, out)

    def test_another_slice_with_the_same_id_is_still_a_duplicate(self):
        self.studio_draft()
        self.groom()
        code, out, _ = self.finalize("--from-studio", "SLICE-002")  # the hand-off was of another slice: this draft is not its twin
        self.assertEqual(code, 1)
        self.assertIn("[duplicate-slice-id]", out)
        self.groom("LOCAL-002", name="SLICE-001-other-feature.md")  # an engineer's own slice with the same ID, in another cell
        code, out, _ = self.finalize("--from-studio", "SLICE-001")
        self.assertEqual(code, 1)
        self.assertIn("SLICE-001 is already used by SLICE-001-other-feature.md", out)
        self.assertNotIn("allow-list-access", out)

    def test_the_id_space_is_still_one(self):
        self.studio_draft()
        code, out, _ = run("next-id", "--count", "1", project=self.project)
        self.assertEqual(json.loads(out)["next"], ["SLICE-005"])  # the draft holds SLICE-001 and reserves 002 to 004

    def test_a_bad_slice_id_is_refused(self):
        self.groom()
        code, _, err = self.finalize("--from-studio", "../x")
        self.assertEqual(code, 2)
        self.assertIn("not a slice ID", err)


class HandOffWithoutGitTest(HandOffTest):
    """The same, with the Factory's copy written in the main checkout (a cell that works in the project root)."""
    with_git = False

    def test_the_draft_is_the_same_slice_as_the_one_handed_over(self):
        super().test_the_draft_is_the_same_slice_as_the_one_handed_over()
        self.assertTrue((self.project / "specs/slices" / SPEC_NAME).is_file())


class FinalizeTest(Base):
    def test_ready_spec_is_exported_and_committed(self):
        info = self.groom()
        code, out, _ = run("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}", project=self.project)
        self.assertEqual(code, 0, out)
        self.assertIn('"status": "READY"', out)
        self.assertIn('"matrix_cases": 16', out)
        export = json.loads(Path(info["spec_json_path"]).read_text())
        self.assertEqual((export["ticket_id"], export["slice_id"], export["risk"]), ("LOCAL-001", "SLICE-001", "Medium"))
        self.assertEqual(Path(info["spec_copy_path"]).read_text(), SPEC)
        state = json.loads((Path(info["cell_dir"]) / "cell.json").read_text())
        self.assertEqual((state["stage"], state["slice_id"]), ("spec-ready", "SLICE-001"))
        log = git(Path(info["workdir"]), "log", "--oneline", "-1").stdout
        self.assertIn("spec(SLICE-001)", log)
        self.assertNotIn("spec(SLICE-001)", git(self.project, "log", "--oneline", "main").stdout, "nothing may be committed on main")

    def test_open_questions_are_saved_but_not_ready(self):
        info = self.groom(spec=OPEN_SPEC)
        code, out, _ = run("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}", project=self.project)
        self.assertEqual(code, 1)
        code, out, _ = run("finalize", "LOCAL-001", "--allow-open", project=self.project)
        self.assertEqual(code, 0)
        self.assertIn("SAVED_NOT_READY", out)
        self.assertFalse(Path(info["spec_json_path"]).exists())
        self.assertTrue(Path(info["spec_copy_path"]).exists())
        code, _, err = run("check-plan", "LOCAL-001", project=self.project)
        self.assertEqual(code, 2)
        self.assertIn("not ready", err)

    def test_invalid_spec_or_missing_intent_finalizes_nothing(self):
        info = self.groom(spec=SPEC.replace("SHALL reserve", "shall reserve"), intent=None)
        code, out, _ = run("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}", "--allow-open", project=self.project)
        self.assertEqual(code, 1)
        self.assertIn("[rfc2119-case]", out)
        self.assertIn("intent.md is missing", out)
        self.assertFalse(Path(info["spec_copy_path"]).exists())

    def test_intent_needs_a_risk_tier_and_no_placeholders(self):
        self.groom(intent=INTENT.replace("- **Tier:** Medium", "- **Tier:** <High | Medium | Low>"))
        code, out, _ = run("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}", project=self.project)
        self.assertEqual(code, 1)
        self.assertIn("replace the placeholder", out)
        self.assertIn("'## Risk' needs", out)

    def test_spec_outside_the_cell_is_refused(self):
        self.groom()
        stray = self.project / "specs" / "slices"
        stray.mkdir(parents=True)
        (stray / SPEC_NAME).write_text(SPEC)
        code, _, err = run("validate", "LOCAL-001", "--spec", str(stray / SPEC_NAME), project=self.project)
        self.assertEqual(code, 2)
        self.assertIn("outside this cell's working folder", err)


class CheckPlanTest(Base):
    def ready(self, plan=PLAN, contract=True):
        info = self.groom()
        run("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}", project=self.project)
        if contract:
            path = Path(info["workdir"]) / "proto/openapi/members.yaml"
            path.parent.mkdir(parents=True)
            path.write_text("openapi: 3.1.0\n")
        Path(info["plan_path"]).write_text(plan, encoding="utf-8")
        return info

    def check(self):
        return run("check-plan", "LOCAL-001", project=self.project)

    def test_good_plan_passes_and_commits_contracts(self):
        info = self.ready()
        code, out, _ = self.check()
        self.assertEqual(code, 0, out)
        state = json.loads((Path(info["cell_dir"]) / "cell.json").read_text())
        self.assertEqual((state["stage"], state["app_type"], state["risk"]), ("planned", "web", "High"))
        self.assertEqual(state["contracts"], ["proto/openapi/members.yaml"])
        export = json.loads(Path(info["spec_json_path"]).read_text())
        self.assertEqual((export["risk"], export["app_type"]), ("High", "web"), "the exported spec follows the plan's risk tier")
        self.assertIn("contract(SLICE-001)", git(Path(info["workdir"]), "log", "--oneline", "-1").stdout)

    def test_plan_problems_are_reported(self):
        cases = {
            "appear in no task: FR-09": PLAN.replace("FR-08, FR-09", "FR-08"),
            "IDs the spec does not define: FR-77": PLAN.replace("(FR-06, FR-08)", "(FR-06, FR-08, FR-77)"),
            "first task must be a [test] task": PLAN.replace("T01 [test]", "T01 [impl]"),
            "'App type' must be one of": PLAN.replace("**App type:** web", "**App type:** website"),
            "never lower it": PLAN.replace("**Risk tier:** High", "**Risk tier:** Low"),
            "missing section '## File touch map'": PLAN.replace("## File touch map", "## Files"),
            "needs a reason": PLAN.replace("**Contracts:** `proto/openapi/members.yaml`", "**Contracts:** None."),
        }
        self.ready()
        for expected, plan in cases.items():
            with self.subTest(expected=expected):
                (self.project / ".factory/worktrees/LOCAL-001/plan.md").write_text(plan)
                code, out, _ = self.check()
                self.assertEqual(code, 1)
                self.assertIn(expected, out)

    def test_impl_task_that_can_never_go_green_is_refused(self):
        # M7 D5: the tests come first, then two [impl] tasks for the same requirements. The build station
        # completes the first only on a green suite, which needs the second's files: the line stops.
        stuck = PLAN.replace(
            "- [ ] T02 [impl] Invitation service — `src/invite.ts` (FR-01, FR-02)\n"
            "- [ ] T03 [test] Scenarios — `tests/invite.scenarios.test.ts` (AC-01, AC-02, AC-03, FR-06, FR-08, FR-09, INV-03)\n"
            "- [ ] T04 [impl] Expiry and failure handling — `src/invite.ts` (FR-06, FR-08)\n",
            "- [ ] T02 [test] Scenarios — `tests/invite.scenarios.test.ts` (AC-01, AC-02, AC-03, FR-06, FR-08, FR-09, INV-03)\n"
            "- [ ] T03 [impl] Invitation service — `src/invite.ts` (FR-01, FR-02, FR-06, INV-01)\n"
            "- [ ] T04 [impl] Route and handler — `src/routes.ts` (FR-01, FR-08, INV-01)\n",
        )
        self.assertNotEqual(stuck, PLAN)
        self.ready(plan=stuck)
        code, out, _ = self.check()
        self.assertEqual(code, 1, out)
        self.assertIn("T04 [impl] implements FR-01, FR-08, but every [test] task for them (the last is T02) comes before T03 [impl]", out)
        self.assertIn("Merge T03 and T04 into one [impl] task, or move the tests that need T04 after T03", out)
        self.assertNotIn("INV-01, ", out.split("T04 [impl] implements")[1].split("but")[0], "an invariant an [impl] task keeps is not counted")
        self.assertEqual(json.loads((self.project / ".factory/worktrees/LOCAL-001/cell.json").read_text())["stage"], "spec-ready")

    def test_later_impl_task_may_keep_an_invariant_or_follow_its_own_new_test(self):
        # A later [impl] task may name an invariant tested earlier (it keeps it), and a requirement
        # whose newest test comes after the previous [impl] task (that test is its own).
        fine = PLAN.replace("(FR-06, FR-08)\n", "(FR-06, FR-08, INV-01)\n").replace(
            "`tests/invite.scenarios.test.ts` (AC-01,", "`tests/invite.scenarios.test.ts` (FR-02, AC-01,"
        ).replace("Expiry and failure handling — `src/invite.ts` (FR-06", "Expiry and failure handling — `src/invite.ts` (FR-02, FR-06")
        self.assertIn("(FR-02, FR-06, FR-08, INV-01)", fine)
        self.ready(plan=fine)
        code, out, _ = self.check()
        self.assertEqual(code, 0, out)

    def test_new_contract_is_ordinary_risk_but_changing_an_existing_one_is_high(self):
        medium = PLAN.replace("**Risk tier:** High", "**Risk tier:** Medium")
        self.ready(plan=medium)
        code, out, _ = self.check()
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads((self.project / ".factory/worktrees/LOCAL-001/cell.json").read_text())["risk"], "Medium")

    def test_changing_a_contract_already_on_main_must_be_high(self):
        (self.project / "proto/openapi").mkdir(parents=True)
        (self.project / "proto/openapi/members.yaml").write_text("openapi: 3.1.0\n")
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "existing contract")
        self.ready(plan=PLAN.replace("**Risk tier:** High", "**Risk tier:** Medium"), contract=False)
        code, out, _ = self.check()
        self.assertEqual(code, 1)
        self.assertIn("changing an existing contract makes the ticket High risk", out)

    def test_listed_contract_must_exist(self):
        self.ready(contract=False)
        code, out, _ = self.check()
        self.assertEqual(code, 1)
        self.assertIn("is listed but does not exist", out)

    def test_spec_edited_after_finalize_blocks_planning(self):
        info = self.ready()
        (Path(info["specs_dir"]) / SPEC_NAME).write_text(SPEC.replace("7 days", "14 days"))
        code, _, err = self.check()
        self.assertEqual(code, 2)
        self.assertIn("changed after it was finalized", err)


class TicketTest(Base):
    with_git = False

    def test_local_tickets_are_numbered_and_updated(self):
        _, out, _ = run("ticket-new", "--title", "Invite teammates", "--body", "Admins want this.", "--label", "feature", project=self.project)
        self.assertEqual(json.loads(out)["ticket_id"], "LOCAL-001")
        _, out, _ = run("ticket-new", "--title", "Second", project=self.project)
        self.assertEqual(json.loads(out)["ticket_id"], "LOCAL-002")
        code, _, _ = run("ticket-note", "LOCAL-001", "--state", "in_progress", "--label", "groomed", "--comment", "Groomed as SLICE-001.", project=self.project)
        self.assertEqual(code, 0)
        text = (self.project / ".factory/tickets/LOCAL-001.md").read_text()
        self.assertIn("state: in_progress", text)
        self.assertIn('labels: ["feature", "groomed"]', text)
        self.assertIn("Groomed as SLICE-001.", text)
        self.assertIn("Admins want this.", text)
        run("ticket-note", "LOCAL-001", "--remove-label", "feature", project=self.project)
        self.assertIn('labels: ["groomed"]', (self.project / ".factory/tickets/LOCAL-001.md").read_text())

    def test_prefix_comes_from_config(self):
        (self.project / ".factory").mkdir()
        (self.project / ".factory/config.json").write_text('{"tickets": {"local_prefix": "ACME"}}')
        _, out, _ = run("ticket-new", "--title", "x", project=self.project)
        self.assertEqual(json.loads(out)["ticket_id"], "ACME-001")

    def test_note_on_missing_ticket_fails(self):
        code, _, err = run("ticket-note", "LOCAL-009", "--comment", "x", project=self.project)
        self.assertEqual(code, 2)
        self.assertIn("only updates local Markdown tickets", err)


class StatusTest(Base):
    def test_status_lists_cells(self):
        self.groom()
        run("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}", project=self.project)
        _, out, _ = run("status", project=self.project)
        self.assertEqual([(c["ticket_id"], c["slice_id"], c["stage"]) for c in json.loads(out)], [("LOCAL-001", "SLICE-001", "spec-ready")])


class ReplanTest(Base):
    """M7 N1: a person can send a planned or building cell back to spec-ready to plan it again, without losing anything."""

    ready = CheckPlanTest.ready
    check = CheckPlanTest.check

    def planned(self):
        info = self.ready()
        code, out, _ = self.check()
        self.assertEqual(code, 0, out)
        self.work = Path(info["workdir"])
        self.cell = Path(info["cell_dir"])
        return info

    def task_commit(self, name="tests/invite.test.ts", task="T01"):
        """A task commit as the build station makes it, recorded in build.json; the cell is then building."""
        path = self.work / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("test\n")
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", f"test(SLICE-001): {task} [LOCAL-001]")
        sha = git(self.work, "rev-parse", "HEAD").stdout.strip()
        (self.cell / "build.json").write_text(json.dumps({"loop": 0, "tasks": [{"id": task, "kind": "test", "status": "done", "commit": sha}]}))
        (self.cell / "build-report.json").write_text("{}")
        state = json.loads((self.cell / "cell.json").read_text())
        state["stage"] = "building"
        (self.cell / "cell.json").write_text(json.dumps(state))
        return sha

    def replan(self, reason="T05 cannot go green without T06's files"):
        return run("replan", "LOCAL-001", "--reason", reason, project=self.project)

    def test_a_building_cell_returns_to_spec_ready_with_its_history_kept(self):
        self.planned()
        spec_commit = json.loads((self.cell / "cell.json").read_text())["spec_commit"]
        tip = self.task_commit()
        code, out, err = self.replan()
        self.assertEqual(code, 0, err)
        result = json.loads(out)
        self.assertEqual(result["reset"], {"from": tip, "to": spec_commit, "saved_as": "refs/mach/replan/LOCAL-001/1"})
        self.assertEqual(git(self.work, "rev-parse", "HEAD").stdout.strip(), spec_commit)
        self.assertEqual(git(self.work, "rev-parse", "refs/mach/replan/LOCAL-001/1").stdout.strip(), tip, "the old tip is kept as a ref")
        kept = self.cell / "plan-history" / "1"
        self.assertEqual(sorted(path.name for path in kept.iterdir()), ["build-report.json", "build.json", "plan.md", "replan.json"])
        self.assertEqual(json.loads((kept / "replan.json").read_text())["reason"], "T05 cannot go green without T06's files")
        self.assertFalse((self.cell / "build.json").exists())
        state = json.loads((self.cell / "cell.json").read_text())
        self.assertEqual((state["stage"], state["replans"]), ("spec-ready", 1))
        log = [json.loads(line) for line in (self.cell / "lifecycle.jsonl").read_text().splitlines()]
        self.assertIn(("gate.evaluated", "plan.replan", "pass"), [(e["type"], e["data"].get("gate"), e["data"].get("outcome")) for e in log])
        self.assertIn(("station.exited", "build", "replanned"), [(e["type"], e["station"], e["data"].get("outcome")) for e in log])
        sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
        import run as belt  # noqa: E402
        out_ = io.StringIO()
        with redirect_stdout(out_), redirect_stderr(io.StringIO()):
            self.assertEqual(belt.main(["--project", str(self.project), "next", "LOCAL-001", "--headless"]), 0)
        self.assertEqual(json.loads(out_.getvalue())["action"], "plan")
        # Planned again: the plan check runs as before, and a second re-plan is numbered 2.
        Path(self.cell / "plan.md").write_text(PLAN)
        (self.work / "proto/openapi").mkdir(parents=True, exist_ok=True)
        (self.work / "proto/openapi/members.yaml").write_text("openapi: 3.1.0\n")  # the reset took the old plan's contract with it
        self.assertEqual(self.check()[0], 0)
        self.assertEqual(self.replan()[0], 0)
        self.assertTrue((self.cell / "plan-history" / "2" / "plan.md").exists())

    def test_a_planned_cell_with_only_its_contract_commit_is_replanned(self):
        self.planned()
        code, out, err = self.replan()
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["reset"]["saved_as"], "refs/mach/replan/LOCAL-001/1")

    def test_a_spec_corrected_after_planning_sets_the_plan_aside_without_a_separate_instruction(self):
        info = self.planned()
        spec = Path(info["specs_dir"]) / SPEC_NAME
        spec.write_text(SPEC.replace("7 days", "14 days"))
        code, out, err = run("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}", project=self.project)
        self.assertEqual(code, 0, err + out)
        self.assertIn("the contract engineer writes a new one", out)
        cell = json.loads((self.cell / "cell.json").read_text())
        self.assertEqual((cell["stage"], cell["replans"]), ("spec-ready", 1))
        self.assertFalse((self.cell / "plan.md").exists(), "the plan written for the old spec is no longer the cell's plan")
        self.assertTrue((self.cell / "plan-history/1/plan.md").is_file())
        kept = json.loads((self.cell / "plan-history/1/replan.json").read_text())
        self.assertEqual((kept["reason"], kept["from_stage"], kept["automatic"], kept["reset"]), ("The spec changed after the plan was written.", "planned", True, None))
        gates = [json.loads(line) for line in (self.cell / "lifecycle.jsonl").read_text().splitlines()]
        self.assertIn(("plan.replan", "spec-changed"), [(g["data"].get("gate"), g["data"].get("reason_code")) for g in gates if g["type"] == "gate.evaluated"])
        # A new plan for the corrected spec passes as any plan does.
        Path(info["plan_path"]).write_text(PLAN, encoding="utf-8")
        code, out, _ = self.check()
        self.assertEqual(code, 0, out)

    def test_a_spec_corrected_after_building_started_sets_the_plan_and_build_aside_as_a_replan_does(self):
        info = self.planned()
        spec_commit = json.loads((self.cell / "cell.json").read_text())["spec_commit"]
        tip = self.task_commit()
        (self.work / "src").mkdir()
        (self.work / "src/invite.ts").write_text("export const invite = 1;\n")  # written by the builder, not committed
        spec = Path(info["specs_dir"]) / SPEC_NAME
        spec.write_text(SPEC.replace("7 days", "14 days"))
        code, out, err = run("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}", project=self.project)
        self.assertEqual(code, 0, err + out)
        self.assertIn("Building had started under the old spec, so its plan and build are set aside as a re-plan sets them aside", out)
        self.assertIn("nothing is lost", out)
        ref = "refs/mach/replan/LOCAL-001/1"
        self.assertIn(ref, out)
        cell_state = json.loads((self.cell / "cell.json").read_text())
        self.assertEqual((cell_state["stage"], cell_state["replans"]), ("spec-ready", 1))
        kept = self.cell / "plan-history" / "1"
        self.assertEqual(sorted(path.name for path in kept.iterdir()), ["build-report.json", "build.json", "plan.md", "replan.json"])
        self.assertFalse((self.cell / "plan.md").exists() or (self.cell / "build.json").exists(), "nothing stale is left for a later build")
        record = json.loads((kept / "replan.json").read_text())
        self.assertEqual((record["from_stage"], record["automatic"], record["reason"]), ("building", True, cell.SPEC_CORRECTED))
        # The branch: the old tip and the uncommitted file are kept under the ref; the branch holds the corrected spec on the old spec commit.
        saved = git(self.work, "rev-parse", ref).stdout.strip()
        self.assertEqual(git(self.work, "rev-parse", f"{ref}~1").stdout.strip(), tip)
        self.assertEqual(record["uncommitted"]["commit"], saved)
        self.assertEqual(git(self.work, "rev-parse", "HEAD~1").stdout.strip(), spec_commit)
        self.assertTrue(git(self.work, "log", "-1", "--format=%s").stdout.startswith("spec(SLICE-001): "))
        self.assertEqual(cell_state["spec_commit"], git(self.work, "rev-parse", "HEAD").stdout.strip(), "spec_commit is the corrected spec, below no task")
        self.assertIn("14 days", spec.read_text())
        self.assertEqual(git(self.work, "status", "--porcelain").stdout, "")
        git(self.work, "checkout", ref, "--", "src/invite.ts")
        self.assertEqual((self.work / "src/invite.ts").read_text(), "export const invite = 1;\n", "the builder's file comes back")
        gates = [json.loads(line) for line in (self.cell / "lifecycle.jsonl").read_text().splitlines()]
        self.assertIn(("plan.replan", "spec-changed"), [(g["data"].get("gate"), g["data"].get("reason_code")) for g in gates if g["type"] == "gate.evaluated"])
        # Planned again for the corrected spec, as after any re-plan.
        self.plan_again()
        self.assertEqual(json.loads((self.cell / "cell.json").read_text())["stage"], "planned")

    def test_finalizing_an_unchanged_spec_again_sets_no_plan_aside(self):
        self.planned()
        code, out, err = run("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}", project=self.project)
        self.assertEqual(code, 0, err + out)
        self.assertTrue((self.cell / "plan.md").is_file())
        self.assertFalse((self.cell / "plan-history").exists())

    def test_refusals(self):
        def refused(expected, setup=None, reason="the plan is wrong"):
            with self.subTest(expected=expected):
                self.planned() if not hasattr(self, "work") else None
                if setup:
                    setup()
                before = git(self.work, "rev-parse", "HEAD").stdout.strip()
                code, _, err = self.replan(reason)
                self.assertEqual(code, 2)
                self.assertIn(expected, err)
                self.assertEqual(git(self.work, "rev-parse", "HEAD").stdout.strip(), before, "a refused re-plan changes nothing")
                self.assertFalse((self.cell / "plan-history").exists())

        self.planned()
        refused("--reason is required", reason="  ")

        def judged():
            self.task_commit()
            (self.cell / "build.json").write_text(json.dumps({"loop": 1, "tasks": []}))
        refused("has been through a judging round", judged)

        def merged():
            (self.cell / "build.json").write_text(json.dumps({"loop": 0, "tasks": [{"id": "T01", "commit": git(self.work, "rev-parse", "HEAD").stdout.strip()}]}))
            git(self.project, "merge", "-q", "--no-edit", "feature/LOCAL-001")
        refused("already on the main branch", merged)
        _, _, err = self.replan()
        self.assertNotIn("bandon", err, "the refusal names what can be done next, not abandoning the work")
        self.assertIn("carry on", err)

        def wrong_stage():
            state = json.loads((self.cell / "cell.json").read_text())
            state["stage"] = "verified"
            (self.cell / "cell.json").write_text(json.dumps(state))
        refused("Only a planned or building cell can be re-planned", wrong_stage)

    # The branch's spec commits and what a re-plan does with every commit and file it finds.

    def finalize(self, *extra):
        return run("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}", *extra, project=self.project)

    def state(self):
        return json.loads((self.cell / "cell.json").read_text())

    def head(self):
        return git(self.work, "rev-parse", "HEAD").stdout.strip()

    def subject(self, rev="HEAD"):
        return git(self.work, "log", "-1", "--format=%s", rev).stdout.strip()

    def stuck_building(self):
        """A build started and then stuck: build.json written, no task committed (the reported state)."""
        (self.cell / "build.json").write_text(json.dumps({"loop": 0, "tasks": [{"id": "T01", "kind": "test", "status": "pending"}]}))
        state = self.state()
        state["stage"] = "building"
        (self.cell / "cell.json").write_text(json.dumps(state))

    def plan_again(self):
        (self.cell / "plan.md").write_text(PLAN)
        contract = self.work / "proto/openapi/members.yaml"
        contract.parent.mkdir(parents=True, exist_ok=True)
        contract.write_text("openapi: 3.1.0\n")
        code, out, _ = self.check()
        self.assertEqual(code, 0, out)

    def test_the_reported_case_a_branch_holding_only_its_spec_commit_after_the_recorded_point(self):
        # finalize could not commit the spec (here a pre-commit hook refused it), so the cell recorded the commit before it;
        # the spec was then committed by hand with finalize's own message. The build started, stuck, and committed nothing.
        info = self.groom()
        self.work, self.cell = Path(info["workdir"]), Path(info["cell_dir"])
        hooks = self.cell / "hooks"
        hooks.mkdir()
        (hooks / "pre-commit").write_text("#!/bin/sh\nexit 1\n")
        (hooks / "pre-commit").chmod(0o755)
        git(self.work, "config", "core.hooksPath", str(hooks))
        base = self.head()
        code, out, _ = self.finalize()
        self.assertEqual(code, 0, out)
        self.assertIn("git commit failed", out)
        self.assertEqual(self.state()["spec_commit"], base)
        git(self.work, "config", "--unset", "core.hooksPath")
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "spec(SLICE-001): Invite a teammate by email [LOCAL-001]")
        spec = self.head()
        (self.cell / "plan.md").write_text(PLAN)
        self.stuck_building()
        code, out, err = self.replan("the hardening ticket has no test command")
        self.assertEqual(code, 0, err)
        result = json.loads(out)
        self.assertEqual(result["stage"], "spec-ready")
        self.assertIsNone(result["reset"], "the newest spec is the branch's tip: nothing to set aside")
        self.assertEqual(result["spec_commit"], {"was": base, "now": spec})
        self.assertEqual((result["set_aside"], result["not_recognised"], result["kept_on_branch"], result["uncommitted"]), ([], [], [], None))
        self.assertEqual(self.head(), spec, "the spec finalized last is what the branch holds")
        self.assertEqual(self.state()["spec_commit"], spec)
        self.assertFalse((self.cell / "build.json").exists())
        self.assertTrue((self.cell / "plan-history/1/build.json").is_file())
        self.plan_again()  # planned again, with nothing in its way
        self.assertEqual(self.state()["stage"], "planned")

    def test_files_a_stuck_build_wrote_without_committing_are_saved_and_can_be_brought_back(self):
        self.planned()
        self.task_commit()
        tip = self.head()
        (self.work / "README.md").write_text("changed by the builder\n")
        (self.work / "src").mkdir()
        (self.work / "src/invite.ts").write_text("export const invite = 1;\n")
        code, out, err = self.replan()
        self.assertEqual(code, 0, err)
        result = json.loads(out)
        saved = result["uncommitted"]
        self.assertEqual(sorted(saved["paths"]), ["README.md", "src/invite.ts"])
        ref = "refs/mach/replan/LOCAL-001/1"
        self.assertEqual(result["reset"]["saved_as"], ref)
        self.assertEqual(git(self.work, "rev-parse", ref).stdout.strip(), saved["commit"], "the saved ref holds the uncommitted files")
        self.assertEqual(git(self.work, "rev-parse", f"{ref}~1").stdout.strip(), tip, "on top of the branch's old tip")
        self.assertEqual(git(self.work, "status", "--porcelain").stdout, "", "the checkout is left clean for the new plan")
        self.assertFalse((self.work / "src/invite.ts").exists())
        self.assertEqual((self.work / "README.md").read_text(), "demo\n")
        self.assertIn(f"checkout {ref} --", saved["bring_back"])
        git(self.work, "checkout", ref, "--", "src/invite.ts", "README.md")
        self.assertEqual((self.work / "src/invite.ts").read_text(), "export const invite = 1;\n")
        self.assertEqual((self.work / "README.md").read_text(), "changed by the builder\n")
        replan = json.loads((self.cell / "plan-history/1/replan.json").read_text())
        self.assertEqual(replan["uncommitted"]["commit"], saved["commit"])

    def test_a_commit_mach_does_not_recognise_is_set_aside_and_can_be_brought_back(self):
        self.planned()
        spec_commit = self.state()["spec_commit"]
        task = self.task_commit()
        (self.work / "notes.txt").write_text("by hand\n")
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "a person's own commit")
        own = self.head()
        code, out, err = self.replan()
        self.assertEqual(code, 0, err)
        result = json.loads(out)
        self.assertEqual(self.head(), spec_commit)
        self.assertEqual([item["commit"] for item in result["not_recognised"]], [own])
        self.assertEqual(result["not_recognised"][0]["bring_back"], f'git -C "{self.work}" cherry-pick {own}')
        self.assertEqual([(item["commit"], item["as"]) for item in result["set_aside"]],
                         [(own, "not recognised"), (task, "task T01"), (git(self.work, "rev-parse", "refs/mach/replan/LOCAL-001/1~2").stdout.strip(), "contracts")])
        self.assertIn("cherry-pick", result["next"])
        self.assertEqual(git(self.work, "cherry-pick", own).returncode, 0)
        self.assertEqual((self.work / "notes.txt").read_text(), "by hand\n")

    def test_a_draft_then_a_ready_spec_records_the_ready_commit(self):
        info = self.groom(spec=OPEN_SPEC)
        self.work, self.cell = Path(info["workdir"]), Path(info["cell_dir"])
        self.assertEqual(self.finalize("--allow-open")[0], 0)
        draft = self.head()
        (Path(info["specs_dir"]) / SPEC_NAME).write_text(SPEC)
        self.assertEqual(self.finalize()[0], 0)
        self.assertNotEqual(self.head(), draft)
        self.assertEqual(self.state()["spec_commit"], self.head())

    def test_a_slice_handed_over_records_its_spec_commit(self):
        self.groom()
        self.work, self.cell = Path(self.project / ".factory/worktrees/LOCAL-001/repo"), self.project / ".factory/worktrees/LOCAL-001"
        code, out, _ = self.finalize("--from-studio", "SLICE-001")
        self.assertEqual(code, 0, out)
        self.assertTrue(self.subject().startswith("spec(SLICE-001): "))
        self.assertEqual(self.state()["spec_commit"], self.head())

    def test_a_small_change_records_its_spec_commit(self):
        code, out, _ = run("open", "LOCAL-001", "--small", project=self.project)
        self.assertEqual(code, 0, out)
        info = self.groom()
        self.work, self.cell = Path(info["workdir"]), Path(info["cell_dir"])
        for _ in range(2):  # a spec the rules say is not small is saved as a draft first, then finalized in full
            self.finalize("--allow-open")
            if self.state()["stage"] == "spec-ready":
                break
        self.assertEqual(self.state()["stage"], "spec-ready")
        self.assertTrue(self.subject().startswith("spec(SLICE-001): "))
        self.assertEqual(self.state()["spec_commit"], self.head())

    def test_finalizing_an_unchanged_spec_again_keeps_the_recorded_spec_commit(self):
        self.planned()
        spec_commit = self.state()["spec_commit"]
        self.assertTrue(self.subject().startswith("contract("))
        self.assertEqual(self.finalize()[0], 0)
        self.assertEqual(self.state()["spec_commit"], spec_commit, "the contract commit is the plan's, not the spec's")
        self.plan_again()
        self.task_commit()
        code, _, err = self.replan()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.head(), spec_commit)
        self.assertFalse((self.work / "proto/openapi/members.yaml").exists(), "the old plan's contract is set aside with it")

    def test_a_spec_finalized_without_a_commit_is_restored_on_the_branch(self):
        info = self.groom()
        self.work, self.cell = Path(info["workdir"]), Path(info["cell_dir"])
        base = self.head()
        self.assertEqual(self.finalize("--no-commit")[0], 0)
        self.assertEqual(self.state()["spec_commit"], base)
        self.plan_again()  # the contracts are committed; the spec is still not
        self.stuck_building()
        code, out, err = self.replan()
        self.assertEqual(code, 0, err)
        result = json.loads(out)
        self.assertIn(f"specs/slices/{SPEC_NAME}", result["uncommitted"]["paths"])
        self.assertEqual((self.work / "specs/slices" / SPEC_NAME).read_text(), SPEC)
        self.assertEqual(self.subject(), "spec(SLICE-001): Invite a teammate by email [LOCAL-001]")
        self.assertEqual(git(self.work, "rev-parse", "HEAD~1").stdout.strip(), base)
        self.assertEqual(result["spec_restored"]["commit"], self.head())
        self.assertEqual(result["spec_commit"], {"was": base, "now": self.head()})
        self.assertEqual(git(self.work, "status", "--porcelain").stdout, "")
        self.plan_again()

    def test_a_cell_without_a_recorded_spec_commit_returns_to_its_newest_spec(self):
        self.planned()
        newest = self.state()["spec_commit"]
        state = self.state()
        state.pop("spec_commit")
        (self.cell / "cell.json").write_text(json.dumps(state))
        self.task_commit()
        code, out, err = self.replan()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.head(), newest)
        self.assertEqual(json.loads(out)["spec_commit"], {"was": None, "now": newest})

    def test_a_recorded_spec_commit_no_longer_on_the_branch_is_not_a_dead_end(self):
        self.planned()
        spec_commit = self.state()["spec_commit"]
        state = self.state()
        state["spec_commit"] = "0" * 40
        (self.cell / "cell.json").write_text(json.dumps(state))
        self.task_commit()
        code, out, err = self.replan()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.head(), spec_commit)

    def test_a_newer_spec_after_the_plan_is_kept_and_the_work_after_it_is_set_aside(self):
        # spec S1 (recorded), the plan's contract C, then a corrected spec S2 committed outside finalize, then a task T:
        # the branch returns to S2. C stays below it on the branch and is named under "kept"; T is set aside.
        info = self.planned()
        first = self.state()["spec_commit"]
        contract = self.head()
        corrected = SPEC.replace("7 days", "14 days")
        (Path(info["specs_dir"]) / SPEC_NAME).write_text(corrected)
        self.assertEqual(self.finalize("--no-commit")[0], 0)  # the plan is set aside; the commit is made by hand
        self.assertEqual(self.state()["spec_commit"], first)
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "spec(SLICE-001): Invite a teammate by email [LOCAL-001]")
        second = self.head()
        self.plan_again()
        task = self.task_commit()
        code, out, err = self.replan()
        self.assertEqual(code, 0, err)
        result = json.loads(out)
        self.assertEqual(self.head(), second)
        self.assertEqual((self.work / "specs/slices" / SPEC_NAME).read_text(), corrected, "the spec finalized last, never the older one")
        self.assertEqual(result["spec_commit"], {"was": first, "now": second})
        self.assertEqual([(item["commit"], item["as"]) for item in result["kept_on_branch"]], [(contract, "contracts")])
        self.assertEqual([(item["commit"], item["as"]) for item in result["set_aside"]], [(task, "task T01")])
        self.assertEqual(self.state()["spec_commit"], second)


if __name__ == "__main__":
    unittest.main()
