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


if __name__ == "__main__":
    unittest.main()
