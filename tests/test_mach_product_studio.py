"""Tests for studio.py: Product Studio's draft workspace, approval gates and the shared slice ID allocator."""

import ast
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "skills" / "studio" / "scripts"
INTENT = ROOT / "skills" / "intent"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(INTENT / "scripts"))
import cell  # noqa: E402
import product  # noqa: E402
import studio  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "SLICE-001-invite-teammate.md"
SPEC = "SLICE-001-invite-teammate.md"
AT = "2026-11-10T14:00:00Z"
INTENT_TEXT = """# Intent: Invite a teammate

- **Slice:** SLICE-001 at specs/slices/SLICE-001-invite-teammate.md
- **Status:** Ready for approval

## Why

- **Problem:** A workspace admin cannot bring a colleague into the workspace.
- **Who it is for:** A workspace admin.
- **Success looks like:** The colleague receives an invitation.

## Goal ancestry

- **Goal:** Teams can work together
- **Epic:** EPIC-001: Team membership
- **Slice:** SLICE-001: An admin invites one teammate by email.

## Constraints

- None.

## Risk

- **Tier:** High
- **Reason:** It grants access to a workspace.

## Deferred work

- Inviting many teammates at once (SLICE-002)
"""


def git(folder, *args):
    return subprocess.run(["git", *args], cwd=str(folder), capture_output=True, text=True)


class Base(unittest.TestCase):
    use_git = True

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = self.make_project("project")
        self.draft = self.project / ".factory/studio/draft"

    def make_project(self, name):
        project = Path(self.tmp.name).resolve() / name
        project.mkdir()
        (project / "README.md").write_text("# Sample\n")
        if self.use_git:
            git(project, "init", "-q", "-b", "main")
            for key, value in (("user.name", "Pat PM"), ("user.email", "pat@example.com"), ("commit.gpgsign", "false")):
                git(project, "config", key, value)
            git(project, "add", "-A")
            git(project, "commit", "-q", "-m", "start")
        return project

    def run_studio(self, *argv, project=None):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = studio.main(["--project", str(project or self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def ok(self, *argv, project=None):
        code, out, err = self.run_studio(*argv, project=project)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def refused(self, *argv, project=None):
        code, out, err = self.run_studio(*argv, project=project)
        self.assertEqual(code, 1, out)
        self.assertIn("refused:", err)
        return err

    def start(self, project=None):
        self.ok("project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together.",
                "--outcome", "Teams can work together", project=project)
        self.ok("epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join", project=project)

    def write_spec(self, project=None, text=None):
        draft = (project or self.project) / ".factory/studio/draft"
        path = draft / "specs/slices" / SPEC
        path.write_text(text if text is not None else FIXTURE.read_text())
        return path

    def write_intent(self, project=None, text=INTENT_TEXT):
        draft = (project or self.project) / ".factory/studio/draft"
        (draft / "product/intents/SLICE-001.md").write_text(text)

    def ready_slice(self, project=None):
        self.start(project)
        self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate", project=project)
        self.write_spec(project)
        self.write_intent(project)

    def approved_slice(self, project=None):
        self.ready_slice(project)
        return self.ok("slice", "ready", "SLICE-001", project=project)

    def artifact(self, relative, project=None):
        return json.loads(((project or self.project) / ".factory/studio/draft" / relative).read_text())

    def tree(self, project):
        draft = project / ".factory/studio/draft"
        return {p.relative_to(draft).as_posix(): p.read_bytes() for p in sorted(draft.rglob("*")) if p.is_file()}


class FullSessionTest(Base):
    def test_project_to_a_ready_slice(self):
        result = self.approved_slice()
        self.assertEqual((result["ready"], result["saved_to"]), (True, "folder"))  # no GitHub repository here
        self.assertIs(result["factory_authorized"], False)
        work = self.artifact("product/slices/SLICE-001.json")
        self.assertEqual((work["status"], work["open_questions"], work["spec_path"]), ("approved_for_engineering", [], "specs/slices/" + SPEC))
        # The authoritative validator agrees, run the way the intent station runs it.
        done = subprocess.run([sys.executable, str(INTENT / "scripts/validate_slice.py"), str(self.draft / "specs/slices" / SPEC), "--ready"],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stdout)
        report = product.validate_workspace(self.draft)
        self.assertTrue(report["valid"], report["errors"])
        self.assertIs(report["factory_authorized"], False)
        status = self.ok("status")
        self.assertTrue(status["structurally_valid"])
        self.assertIs(status["factory_authorized"], False)

    def test_status_suggests_the_next_step(self):
        self.assertIn("Define the project", self.ok("status")["suggested_next"][0])
        self.start()
        self.assertIn("slice new", " ".join(self.ok("status")["suggested_next"]))
        self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate")
        self.assertIn("slice resume SLICE-001", " ".join(self.ok("status")["suggested_next"]))
        self.write_spec()
        self.write_intent()
        self.ok("slice", "check", "SLICE-001")
        suggestions = " ".join(self.ok("status")["suggested_next"])
        self.assertIn("slice ready SLICE-001", suggestions)
        self.assertNotIn("epic approve", suggestions)

    def test_where_points_at_the_shared_interview_files(self):
        where = self.ok("where")
        for key in ("interview_method", "slice_template", "intent_template"):
            self.assertTrue(Path(where[key]).is_file(), key)
        self.assertTrue(all(Path(p).is_file() for p in where["spec_rules"]))
        self.assertEqual(Path(where["interview_method"]).parent.parent, INTENT)

    def test_same_operations_give_identical_bytes(self):
        other = self.make_project("other")
        self.approved_slice()
        self.approved_slice(other)
        self.assertEqual(self.tree(self.project), self.tree(other))
        for name, data in self.tree(self.project).items():
            if name.endswith(".json"):
                self.assertEqual(data.decode(), studio.canonical(json.loads(data)), name)

    def test_unchanged_writes_do_not_raise_the_revision(self):
        self.ready_slice()
        before = self.artifact("product/project.json")["revision"]
        self.ok("project", "set", "--name", "Team Space")
        self.assertEqual(self.artifact("product/project.json")["revision"], before)
        self.ok("project", "set", "--name", "Team Rooms")
        self.assertEqual(self.artifact("product/project.json")["revision"], before + 1)
        self.ok("slice", "check", "SLICE-001")
        self.ok("slice", "check", "SLICE-001")
        self.assertEqual(self.artifact("product/slices/SLICE-001.json")["revision"], 1)


class ApprovalGateTest(Base):
    def test_no_spec(self):
        self.start()
        self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate")
        self.assertIn("No spec yet", self.refused("slice", "ready", "SLICE-001"))

    def test_open_question_blocks(self):
        self.ready_slice()
        text = FIXTURE.read_text().replace("## Open questions\n\n- None.", "## Open questions\n\n- Do invitations expire? Follow up: ask Legal.")
        self.assertNotEqual(text, FIXTURE.read_text())
        self.write_spec(text=text)
        check = self.ok("slice", "check", "SLICE-001")
        self.assertEqual((check["status"], len(check["open_questions"])), ("interviewing", 1))
        self.assertEqual(self.artifact("product/slices/SLICE-001.json")["open_questions"], ["Do invitations expire?"])
        self.assertEqual(self.run_studio("slice", "check", "SLICE-001", "--ready")[0], 1)
        self.assertIn("open question: Do invitations expire?", self.refused("slice", "ready", "SLICE-001"))
        self.assertEqual(self.artifact("product/slices/SLICE-001.json")["status"], "interviewing")

    def test_spec_the_validator_rejects_blocks(self):
        self.ready_slice()
        text = FIXTURE.read_text()
        cut = text.index("## Invariants")
        self.write_spec(text=text[:cut] + text[text.index("## Functional requirements"):])
        code, out, _ = self.run_studio("slice", "check", "SLICE-001")
        self.assertEqual(code, 1)
        self.assertTrue(json.loads(out)["errors"])
        self.refused("slice", "ready", "SLICE-001")

    def test_spec_for_another_slice_blocks(self):
        self.ready_slice()
        self.write_spec(text=FIXTURE.read_text().replace("# SLICE-001:", "# SLICE-009:", 1))
        self.refused("slice", "ready", "SLICE-001")

    def test_missing_or_unfinished_intent_blocks(self):
        self.ready_slice()
        (self.draft / "product/intents/SLICE-001.md").unlink()
        self.assertIn("is missing", self.refused("slice", "ready", "SLICE-001"))
        self.write_intent(text=(ROOT / "skills/studio/assets/intent-template.md").read_text())
        self.assertIn("placeholder", self.refused("slice", "ready", "SLICE-001"))
        self.write_intent(text=INTENT_TEXT.replace("- **Tier:** High", "- **Tier:** Severe"))
        self.assertIn("Tier", self.refused("slice", "ready", "SLICE-001"))

    def test_a_new_epic_is_open_and_needs_no_approval(self):
        self.ready_slice()
        epic = self.artifact("product/epics/EPIC-001.json")
        self.assertEqual(epic["status"], "open")
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            self.run_studio("epic", "approve", "EPIC-001")  # there is no such command
        self.ok("slice", "ready", "SLICE-001")  # a slice under a new epic is marked ready with no step for the epic

    def test_an_epic_set_aside_is_brought_back(self):
        self.start()
        self.assertEqual(self.ok("epic", "set", "EPIC-001", "--status", "deferred")["epic"]["status"], "deferred")
        self.assertEqual(self.ok("epic", "set", "EPIC-001", "--status", "open")["epic"]["status"], "open")
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            self.run_studio("epic", "set", "EPIC-001", "--status", "approved")

    def test_a_dependency_not_ready_blocks(self):
        self.ready_slice()
        other = self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Remove a teammate")["slice"]["slice_id"]
        self.ok("slice", "set", "SLICE-001", "--depends-on", other)
        self.assertIn(f"SLICE-001 depends on {other}, which is not ready yet", self.refused("slice", "ready", "SLICE-001"))

    def test_approved_slice_cannot_be_edited_in_place(self):
        self.approved_slice()
        for argv in (("slice", "set", "SLICE-001", "--title", "Other"), ("slice", "check", "SLICE-001")):
            self.assertIn("reopen", self.refused(*argv))

    def test_editing_an_approved_spec_is_caught_and_reopen_recovers(self):
        self.approved_slice()
        spec = self.draft / "specs/slices" / SPEC
        spec.write_text(spec.read_text() + "\nA late change.\n")
        code, out, _ = self.run_studio("validate")
        self.assertEqual(code, 1)
        self.assertIn("spec_sha256 does not match", out)
        self.assertIn("changed after you approved it", self.refused("slice", "ready", "SLICE-001"))
        reopened = self.ok("slice", "reopen", "SLICE-001")
        self.assertEqual(reopened["github"], {"where": "folder"})
        self.assertFalse((self.draft / "product/ready/SLICE-001").exists())
        work = self.artifact("product/slices/SLICE-001.json")
        self.assertEqual((work["status"], work["spec_sha256"], work["revision"]), ("interviewing", None, 3))
        self.assertEqual(self.run_studio("validate")[0], 0)

    def test_a_failed_change_leaves_every_file_as_it_was(self):
        self.ready_slice()
        before = self.tree(self.project)
        self.assertIn("inconsistent", self.refused("slice", "set", "SLICE-001", "--depends-on", "SLICE-404"))
        self.assertIn("inconsistent", self.refused("slice", "set", "SLICE-001", "--depends-on", "SLICE-001"))
        self.assertEqual(self.tree(self.project), before)

    def test_without_a_shared_repository_refresh_reads_nothing(self):
        self.approved_slice()
        refreshed = self.ok("refresh")
        self.assertIs(refreshed["refreshed"], False)
        self.assertEqual((refreshed["github"]["repository"], refreshed["github"]["refreshed"]), (None, False))


class SliceIdTest(Base):
    """One allocator: grooming a ticket and Product Studio never hand out the same slice number."""

    def cell_next(self):
        out = io.StringIO()
        with redirect_stdout(out):
            cell.main(["--project", str(self.project), "next-id", "--count", "1"])
        return json.loads(out.getvalue())

    def test_cell_skips_studio_work_orders_and_drafts(self):
        self.start()
        self.assertEqual(self.cell_next()["next"], ["SLICE-001"])
        self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate")
        self.assertEqual(self.cell_next()["next"], ["SLICE-002"])  # a work order with no spec yet
        self.write_spec()
        result = self.cell_next()  # the draft spec defers features to SLICE-002..004
        self.assertEqual(result["next"], ["SLICE-005"])
        self.assertEqual([r["id"] for r in result["reserved_without_spec"]], ["SLICE-002", "SLICE-003", "SLICE-004"])

    def test_cell_skips_published_work_orders(self):
        folder = self.project / "product/slices"
        folder.mkdir(parents=True)
        (folder / "SLICE-006.json").write_text("{}")
        self.assertEqual(self.cell_next()["next"], ["SLICE-007"])

    def test_studio_skips_open_cells_and_main_specs(self):
        self.start()
        in_cell = self.project / ".factory/worktrees/LOCAL-001/repo/specs/slices"
        in_cell.mkdir(parents=True)
        (in_cell / "SLICE-003-pause-plan.md").write_text("# SLICE-003: Pause a plan\n")
        self.assertEqual(self.ok("slice", "new", "--epic", "EPIC-001", "--title", "First")["slice"]["slice_id"], "SLICE-004")
        on_main = self.project / "specs/slices"
        on_main.mkdir(parents=True)
        shutil.copy(FIXTURE, on_main / SPEC)  # SLICE-001, reserving 002 to 004
        self.assertEqual(self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Second")["slice"]["slice_id"], "SLICE-005")

    def test_a_reserved_id_can_be_picked_up_and_no_other(self):
        self.start()
        on_main = self.project / "specs/slices"
        on_main.mkdir(parents=True)
        shutil.copy(FIXTURE, on_main / SPEC)
        self.assertIn("already taken", self.refused("slice", "new", "--epic", "EPIC-001", "--title", "x", "--id", "SLICE-001"))
        self.assertIn("not a reserved ID", self.refused("slice", "new", "--epic", "EPIC-001", "--title", "x", "--id", "SLICE-050"))
        new = self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Bulk invite", "--id", "SLICE-002")
        self.assertEqual(new["slice"]["slice_id"], "SLICE-002")
        self.assertEqual(new["ids"]["next"][0], "SLICE-005")

    def test_cell_validation_sees_a_studio_draft_with_the_same_number(self):
        self.ready_slice()
        registries = cell.registries(self.project)
        self.assertIn(self.draft / "specs/slices", registries)


class HandOffOnOneComputerTest(Base):
    """The product manager and the Factory on one computer: once the Factory has its copy of a slice marked ready, under the
    name intake gives it, the product manager's draft of that slice is the same slice, never a duplicate of it."""

    FACTORY_NAME = "SLICE-001-invite-a-teammate-by-email.md"

    def factory_copy(self, where):
        folder = self.project / where
        folder.mkdir(parents=True, exist_ok=True)
        text = FIXTURE.read_text()
        (folder / self.FACTORY_NAME).write_text(text.replace("\n", "\n\n> Epic: Team membership (EPIC-001, issue #1). Slice issue: #6.\n", 1))

    def duplicate(self, result):
        return [line for line in result["errors"] if "duplicate-slice-id" in line]

    def check_after_reopening(self, where):
        self.approved_slice()
        self.factory_copy(where)
        self.ok("slice", "reopen", "SLICE-001")  # the folder is taken back; the record that it was handed over stays
        checked = self.ok("slice", "check", "SLICE-001", "--ready")
        self.assertEqual(self.duplicate(checked), [])
        self.assertEqual(self.ok("slice", "ready", "SLICE-001")["slice"]["status"], "approved_for_engineering")

    def test_the_factorys_copy_in_a_cell(self):
        self.check_after_reopening(".factory/worktrees/6/repo/specs/slices")

    def test_the_factorys_copy_in_the_main_checkout(self):
        self.check_after_reopening("specs/slices")

    def test_a_slice_never_handed_over_still_meets_its_duplicate(self):
        self.ready_slice()  # SLICE-001 is a draft here, never marked ready
        self.factory_copy(".factory/worktrees/LOCAL-002/repo/specs/slices")  # an engineer's own slice with the same number
        code, out, _ = self.run_studio("slice", "check", "SLICE-001")
        checked = json.loads(out)
        self.assertEqual((code, len(self.duplicate(checked))), (1, 1), checked["errors"])
        self.assertIn(self.FACTORY_NAME, self.duplicate(checked)[0])


class WorkspaceTest(Base):
    def snapshot(self):
        return (git(self.project, "status", "--porcelain").stdout, git(self.project, "rev-parse", "HEAD").stdout,
                git(self.project, "branch", "--list").stdout, git(self.project, "worktree", "list").stdout,
                sorted(p.name for p in self.project.iterdir() if p.name not in (".git", ".factory")),
                sorted(p.name for p in (self.project / ".factory").iterdir()) if (self.project / ".factory").exists() else [])

    def test_the_main_checkout_is_untouched_by_a_whole_session(self):
        before = self.snapshot()
        self.approved_slice()
        self.ok("slice", "reopen", "SLICE-001")
        self.ok("status")
        after = self.snapshot()
        self.assertEqual(after[:5], before[:5])
        self.assertEqual(after[5], ["studio"])  # no tickets, no worktrees, no local policy
        self.assertEqual(git(self.project, "status", "--porcelain", "--ignored").stdout.strip(), "!! .factory/")

    def test_resume_after_the_session_ends(self):
        self.ready_slice()
        self.ok("slice", "pause", "SLICE-001", "--note", "Settled who invites. Next: do invitations expire?")
        resumed = self.ok("slice", "resume")  # no ID: the session remembers
        self.assertEqual(resumed["slice"]["slice_id"], "SLICE-001")
        self.assertEqual(resumed["slice"]["status"], "interviewing")
        self.assertEqual(resumed["resume_note"], "Settled who invites. Next: do invitations expire?")
        self.assertTrue(resumed["spec"].endswith(SPEC))
        self.assertEqual(resumed["check"]["errors"], [])
        self.assertEqual(self.ok("status")["slices"][0]["resume_note"], resumed["resume_note"])

    def test_resume_needs_an_id_when_it_cannot_tell(self):
        self.start()
        self.assertIn("Say which slice", self.refused("slice", "resume"))

    def test_symlinked_workspace_is_refused(self):
        elsewhere = Path(self.tmp.name) / "elsewhere"
        elsewhere.mkdir()
        (self.project / ".factory").mkdir()
        (self.project / ".factory/studio").symlink_to(elsewhere, target_is_directory=True)
        self.assertIn("symbolic link", self.refused("status"))
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_mach_makes_the_project_id_from_the_name(self):
        for name, expected in (("Team Space", "team-space"), ("  Café — Orders 2!  ", "cafe-orders-2"), ("3D Planner", "project-3d-planner"), ("X", "project-x"),
                               ("!!!", "project"), ("日本語", "project"), ("A" * 200, "a" * 64), ("Ab-" * 40, ("ab-" * 22)[:64].rstrip("-"))):
            made = product.project_id_from(name)
            self.assertEqual(made, expected, name)
            self.assertRegex(made, product.PROJECT_RE)
        folder = self.make_project("named")
        done = self.ok("project", "init", "--name", "3D Planner", "--vision", "v", "--outcome", "o", project=folder)
        self.assertEqual(done["project"]["project_id"], "project-3d-planner")

    def test_bad_ids_never_become_paths(self):
        self.start()
        for bad in ("../../etc", "SLICE-1", "slice-001", "SLICE-001/../x"):
            self.assertIn("not a usable", self.refused("slice", "resume", bad))
        self.assertIn("not a usable project ID", self.refused("project", "init", "--id", "../x", "--name", "n", "--vision", "v", "--outcome", "o", project=self.make_project("p2")))


class WithoutGitTest(Base):
    use_git = False

    def test_works_in_a_folder_that_is_not_a_repository(self):
        self.assertEqual(self.approved_slice()["saved_to"], "folder")
        self.assertIs(self.ok("where")["is_git_repository"], False)


class SliceShowTest(Base):
    """slice show: one read for the Specification Workspace, which changes nothing on disk."""

    def files(self):
        root = self.project / ".factory"
        return {p.relative_to(root).as_posix(): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}

    def test_a_ready_slice_in_one_read(self):
        self.ready_slice()
        before = self.files()
        shown = self.ok("slice", "show", "SLICE-001")
        self.assertEqual(self.files(), before)  # no sync, no bookkeeping
        self.assertEqual(shown["slice"], self.artifact("product/slices/SLICE-001.json"))
        self.assertIs(shown["editable"], True)
        self.assertIsNone(shown["edit_refusal"])
        self.assertIs(shown["factory_authorized"], False)
        self.assertEqual(shown["paths"], {"work_order": "product/slices/SLICE-001.json", "specs_dir": "specs/slices",
                                          "spec": "specs/slices/" + SPEC, "spec_name_pattern": "SLICE-001-<lowercase-kebab-name>.md",
                                          "intent": "product/intents/SLICE-001.md"})
        self.assertEqual(shown["spec"]["markdown"], FIXTURE.read_text())
        self.assertEqual(shown["spec"]["name"], SPEC)
        # The model is exactly the validator's own export.
        _, model = cell_validator().analyze(FIXTURE.read_text(), SPEC, {}, ready=False)
        self.assertEqual(shown["spec"]["model"], json.loads(json.dumps(model)))
        self.assertEqual(shown["spec"]["findings"], [])
        why = shown["why"]
        self.assertEqual((why["exists"], why["markdown"], why["title"]), (True, INTENT_TEXT, "Invite a teammate"))
        self.assertEqual(why["header"], {"Slice": "SLICE-001 at specs/slices/SLICE-001-invite-teammate.md", "Status": "Ready for approval"})
        self.assertEqual([s["heading"] for s in why["sections"]], list(cell.INTENT_SECTIONS))
        risk = next(s for s in why["sections"] if s["heading"] == "Risk")
        self.assertEqual(risk["fields"], {"Tier": "High", "Reason": "It grants access to a workspace."})
        # The check is what slice check reports, with the spec path relative to the workspace.
        check = shown["check"]
        self.assertEqual((check["ready"], check["errors"], check["spec"], check["risk"]), (True, [], "specs/slices/" + SPEC, "High"))
        self.assertEqual(check["counts"], self.ok("slice", "check", "SLICE-001")["counts"])

    def test_before_a_spec_or_why_is_written(self):
        self.start()
        self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate")
        shown = self.ok("slice", "show", "SLICE-001")
        self.assertIsNone(shown["spec"])
        self.assertIsNone(shown["paths"]["spec"])
        self.assertEqual(shown["why"], {"exists": False, "markdown": None, "title": None, "header": {}, "sections": []})
        self.assertFalse(shown["check"]["ready"])
        self.assertIn("No spec yet", shown["check"]["errors"][0])

    def test_findings_are_reported_with_their_rule_and_line(self):
        self.ready_slice()
        text = FIXTURE.read_text()
        self.write_spec(text=text[:text.index("## Invariants")] + text[text.index("## Functional requirements"):])
        shown = self.ok("slice", "show", "SLICE-001")
        rules = {f["rule"] for f in shown["spec"]["findings"] if f["severity"] == "error"}
        self.assertIn("missing-section", rules)
        self.assertTrue(shown["check"]["errors"])
        self.assertEqual(self.artifact("product/slices/SLICE-001.json")["status"], "draft")  # nothing recorded

    def test_an_approved_slice_is_shown_and_not_editable(self):
        self.approved_slice()
        shown = self.ok("slice", "show", "SLICE-001")
        self.assertIs(shown["editable"], False)
        self.assertEqual(shown["slice"]["status"], "approved_for_engineering")
        self.assertIn("reopen it first", shown["edit_refusal"])
        self.assertEqual(shown["edit_refusal"], self.refused("slice", "check", "SLICE-001").replace("refused: ", "").strip())

    def test_unknown_or_unusable_ids_are_refused(self):
        self.start()
        self.assertIn("No slice SLICE-009", self.refused("slice", "show", "SLICE-009"))
        self.assertIn("not a usable", self.refused("slice", "show", "../SLICE-001"))


class NextActionsTest(Base):
    """status: next_actions is the same decision as suggested_next, in a form an app can act on."""

    COMMAND = re.compile(r"studio\.py|--[a-z]|\((project|epic|slice|wave|send|reconcile|renumber)\b")

    def actions(self):
        status = self.ok("status")
        actions = status["next_actions"]
        self.assertEqual(len(actions), len(status["suggested_next"]))
        for action, sentence in zip(actions, status["suggested_next"]):
            self.assertEqual(sorted(action), ["kind", "reason", "related", "target", "title"])
            self.assertIn(action["kind"], studio.NEXT_ACTION_KINDS)
            for text in (action["title"], action["reason"]):
                self.assertTrue(text and not self.COMMAND.search(text), text)
            if action["target"]:
                self.assertIn(action["target"], sentence)  # the same item, in the same place
        return status, [(a["kind"], a["target"]) for a in actions]

    def test_each_stage_names_its_next_action(self):
        self.assertEqual(self.actions()[1], [("define_project", None)])
        self.ok("project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "v", "--outcome", "o")
        status, kinds = self.actions()
        self.assertEqual(kinds, [("add_epic", None)])
        # Where the engine explains what a slice is, it is a slice of intent.
        self.assertEqual(status["next_actions"][0]["reason"], "An epic is a larger capability that several slices of intent deliver.")
        self.ok("epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join")
        status, kinds = self.actions()
        self.assertEqual(kinds, [("start_slice", None)])
        self.assertEqual(status["next_actions"][0]["reason"], "No slice of intent is being defined right now.")
        self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate")
        self.assertEqual(self.actions()[1], [("continue_interview", "SLICE-001")])
        self.write_spec()
        self.write_intent()
        self.ok("slice", "check", "SLICE-001")
        self.assertEqual(self.actions()[1], [("mark_ready", "SLICE-001")])  # a ready slice is still open
        self.ok("slice", "ready", "SLICE-001")
        self.assertEqual(self.actions()[1], [("start_slice", None)])
        # Approved but not handed over (an interrupted run): finish it.
        (self.project / ".factory/studio/issues.json").unlink()
        self.assertEqual(self.actions()[1], [("finish_ready", "SLICE-001"), ("start_slice", None)])

    def test_status_carries_what_the_screens_need(self):
        self.approved_slice()
        self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Remove a teammate", "--depends-on", "SLICE-001")
        status = self.ok("status")
        self.assertNotIn("waves", status)
        rows = {row["slice_id"]: row for row in status["slices"]}
        second = next(sid for sid in rows if sid != "SLICE-001")
        self.assertEqual((rows["SLICE-001"]["editable"], rows["SLICE-001"]["github"]["saved"], rows["SLICE-001"]["dependencies"]), (False, "folder", []))
        self.assertEqual((rows[second]["editable"], rows[second]["github"]["saved"], rows[second]["dependencies"]), (True, None, ["SLICE-001"]))
        self.assertEqual(status["epics"][0]["acceptance_criteria"], ["Only invited people can join"])


class AppWordingTest(Base):
    """--app: what the web app shows carries no terminal commands or Git words, and a structured hint."""

    BANNED = re.compile(r"studio\.py|--[a-z]|\bbranch\b|\b(" + "|".join(
        sorted({value for enums in product.ENUMS.values() for value in enums["status"] if "_" in value})) + r")\b")

    def app_refusal(self, *argv):
        code, out, err = self.run_studio("--app", *argv)
        self.assertEqual(code, 1, out)
        lines = err.strip().splitlines()
        hint = json.loads(lines[0][len("refused-hint: "):]) if lines[0].startswith("refused-hint: ") else None
        message = "\n".join(lines[1:] if hint else lines)
        self.assertTrue(message.startswith("refused: "), err)
        message = message[len("refused: "):]
        self.assertIsNone(self.BANNED.search(message), message)
        return message, hint

    def test_refusals_for_the_app(self):
        self.start()
        self.assertEqual(self.app_refusal("project", "init", "--id", "x-y", "--name", "n", "--vision", "v", "--outcome", "o"),
                         ("This project is already defined. Change it instead.", {"kind": "edit_project", "target": None}))
        self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate")
        self.write_spec()
        self.write_intent()
        asked = FIXTURE.read_text().replace("## Open questions\n\n- None.", "## Open questions\n\n- Do invitations expire? Follow up: ask Legal.")
        self.write_spec(text=asked)
        # The app titles a refusal itself ("SLICE-001 was not marked ready"), so its message is the reasons alone.
        self.assertEqual(self.app_refusal("slice", "ready", "SLICE-001"), ("open question: Do invitations expire?", None))
        self.assertIn("SLICE-001 cannot be marked ready yet:\n  open question: Do invitations expire?", self.refused("slice", "ready", "SLICE-001"))  # the terminal keeps its heading
        self.write_spec()
        other = self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Remove a teammate")["slice"]["slice_id"]
        self.ok("slice", "set", "SLICE-001", "--depends-on", other)
        self.assertEqual(self.app_refusal("slice", "ready", "SLICE-001"),
                         (f"SLICE-001 depends on {other}, which is not ready yet. Mark {other} ready first.", {"kind": "mark_ready", "target": other}))
        self.ok("slice", "set", "SLICE-001", "--depends-on", "none")
        self.ok("slice", "ready", "SLICE-001")
        self.assertEqual(self.app_refusal("slice", "check", "SLICE-001"),
                         ("SLICE-001 is approved. To change an approved slice, reopen it first.", {"kind": "reopen_slice", "target": "SLICE-001"}))
        spec = self.draft / "specs/slices" / SPEC
        spec.write_text(spec.read_text() + "\nA late change.\n")
        self.assertEqual(self.app_refusal("slice", "ready", "SLICE-001"),
                         ("SLICE-001's spec changed after you approved it. Reopen it to change it.", {"kind": "reopen_slice", "target": "SLICE-001"}))
        self.assertIn("approved_for_engineering", self.refused("slice", "check", "SLICE-001"))  # the terminal keeps the identifier
        shown = json.loads(self.run_studio("--app", "slice", "show", "SLICE-001")[1])
        self.assertIsNone(self.BANNED.search(shown["edit_refusal"]))
        self.assertEqual(self.run_studio("--app", "status")[0], 0)

    def test_every_refusal_with_a_command_has_app_wording(self):
        """Every refusal or problem whose text names a command, an option or a branch says it twice, through say()."""
        for name in ("studio.py", "collab.py"):
            tree = ast.parse((SCRIPTS / name).read_text())
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call) or not node.args:
                    continue
                func = node.func
                called = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else ""
                if called not in ("StudioError", "CollabError", "append"):
                    continue
                first = node.args[0]
                if isinstance(first, ast.Call) and getattr(first.func, "id", "") == "say":
                    continue
                if called == "CollabError" and len(node.args) > 1:
                    continue  # its second argument is the app's wording
                # A state interpolated into a message is worded through state(), never shown raw.
                for value in [n for n in ast.walk(node) if isinstance(n, ast.FormattedValue)]:
                    if "status" in ast.unparse(value.value):
                        self.assertTrue(isinstance(value.value, ast.Call) and getattr(value.value.func, "id", "") == "state",
                                        f"{name}:{node.lineno}: a raw state in {ast.unparse(value.value)}")
                words = " ".join(n.value for n in ast.walk(first) if isinstance(n, ast.Constant) and isinstance(n.value, str))
                if called == "append" and not (isinstance(func.value, ast.Name) and func.value.id == "problems"):
                    continue
                self.assertIsNone(self.BANNED.search(words), f"{name}:{node.lineno}: {words}")

    # A terminal command, option, script or quoted command in text a person reads.
    COMMAND = re.compile(r"\((principle|policy|prd|jira|reconcile|slice|epic|idea|brief|case|verdict|lookback) [a-z]|\b(principle (add|set|retire|publish|list)|policy (accept|list)"
                         r"|reconcile principles|prd (import|list|show|map|settle|status|apply|draft|confirm)|jira (export|keys)"
                         r"|(slice|epic) (link|mock|current)|idea (add|list|faults|show|stage|lookups|publish|renumber|size|map|settle|map-status|apply|change|chain)"
                         r"|brief (check|show)|case (show|check)|verdict record|lookback record|need (add|set|retire|none|list|publish)|reconcile needs)\b|--[a-z]|\b(studio|run|cell)\.py\b|`[a-z]+ [a-z]+")
    # The M13 and M14 commands (principle, policy, prd, jira, slice link, epic link, slice mock, epic current): whole modules, and
    # studio.py's and handoff.py's functions behind them.
    NEW_COMMANDS = {
        "prd.py": None, "mocks.py": None, "jira_export.py": None, "shape.py": None, "validate_brief.py": None,  # M16 A: Shape
        "shape_route.py": None,  # M16 B: sizing, the map, change what exists, looking back
        "needs.py": None,  # M17 A: technical needs
        "handoff.py": {"publish_set"},
        "studio.py": {"principle_flags", "principles_status", "saved_state", "cmd_epic_current", "jira_key", "effective_jira", "link_slice", "link_epic",
                      "cmd_slice_link", "cmd_epic_link", "principles_field", "policies_field", "policies_changed", "cmd_policy_list", "cmd_policy_accept",
                      "approval_problems", "principle_findings", "one_line", "checked", "find_principle", "cmd_principle_add", "cmd_principle_set",
                      "cmd_principle_retire", "cmd_principle_list", "cmd_principle_publish", "reconcile_principles"},
    }
    # Text that is never shown in the app as a sentence of its own: README.txt is a file for whoever imports into Jira, written the
    # same in both modes so the host and the terminal leave identical files.
    NOT_SHOWN = {("jira_export.py", "readme")}

    def test_the_new_commands_name_no_terminal_command_in_the_app(self):
        """Every string a person can read from the M13 and M14 commands either names no command, or is the terminal's half of
        say() (or of an error's app= wording), so the app names the page or button instead (M15)."""
        for name, functions in self.NEW_COMMANDS.items():
            tree = ast.parse((SCRIPTS / name).read_text())
            parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}

            def terminal_only(node):
                while node in parents:
                    parent = parents[node]
                    if isinstance(parent, ast.Call):
                        called = getattr(parent.func, "id", None) or getattr(parent.func, "attr", "")
                        if called == "say" and parent.args and node is parent.args[0]:
                            return True
                        if called in ("add_argument", "add_parser", "git", "gh") or (node in parent.args and any(k.arg == "app" for k in parent.keywords)):
                            return True
                    if isinstance(parent, ast.Expr) and isinstance(node, ast.Constant):
                        return True  # a docstring
                    node = parent
                return False

            for function in [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
                if (functions is not None and function.name not in functions) or (name, function.name) in self.NOT_SHOWN:
                    continue
                for node in ast.walk(function):
                    if isinstance(node, ast.Constant) and isinstance(node.value, str) and self.COMMAND.search(node.value) and not terminal_only(node):
                        self.fail(f"{name}:{node.lineno} ({function.name}) names a command in the app's wording: {node.value[:120]!r}")

    def test_findings_and_refusals_from_the_shared_checks_are_worded_for_the_app(self):
        """The validator and policies.py are shared with the Factory; Studio rewords their command and file names for the app."""
        self.assertEqual(studio.app_finding("POL-privacy-02's concern is open: it waits for the owner to accept it (policy accept), or for the spec to change."),
                         "POL-privacy-02's concern is open: it waits for the owner to accept it on the slice's Principles and policies page, or for the spec to change.")
        self.assertEqual(studio.app_finding("Missing section. See references/spec-structure.md."), "Missing section.")
        for terminal, app in studio.APP_FINDING_WORDS:
            self.assertIsNone(self.COMMAND.search(app), app)
        sources = " ".join((ROOT / "skills" / "intent" / "scripts" / name).read_text() for name in ("validate_slice.py", "effects.py", "policies.py"))
        for terminal, _ in studio.APP_FINDING_WORDS:
            self.assertIn(terminal.strip().split(" (")[0][:20], sources, f"the shared checks no longer write {terminal!r}; drop it from the table")


class HintKindsTest(unittest.TestCase):
    def test_every_hint_kind_is_in_the_vocabulary(self):
        source = (SCRIPTS / "studio.py").read_text()
        used = set(re.findall(r"hint\(\"([a-z_]+)\"", source))
        used |= {f"renumber_{kind}" for kind in ("slice", "epic", "wave")} if 'hint(f"renumber_{kind}"' in source else set()
        self.assertTrue(used)
        self.assertEqual(used - set(studio.HINT_KINDS), set())


class StatusFactsTest(Base):
    def test_withdrawn_approvals_are_explained_until_given_again(self):
        self.approved_slice()
        self.assertEqual(self.ok("status")["approvals_withdrawn"], [])
        self.ok("slice", "reopen", "SLICE-001")
        withdrawn = {(w["artifact"], w["kind"]): w for w in self.ok("status")["approvals_withdrawn"]}
        self.assertEqual(list(withdrawn), [("SLICE-001", "slice")])
        self.assertEqual(withdrawn[("SLICE-001", "slice")]["reason"], "You reopened it to change it.")
        self.assertTrue(product._is_timestamp(withdrawn[("SLICE-001", "slice")]["at"]))
        self.ok("slice", "ready", "SLICE-001")
        self.assertEqual(self.ok("status")["approvals_withdrawn"], [])

    def test_the_project_has_no_issue_until_a_slice_is_marked_ready(self):
        self.start()
        self.assertEqual((self.ok("status")["project"]["issue"], self.ok("status")["project"]["url"]), (None, None))

    def test_each_diagnostic_names_its_section(self):
        self.ready_slice()
        text = FIXTURE.read_text()
        broken = text[:text.index("## Invariants")] + text[text.index("## Functional requirements"):]
        self.write_spec(text=broken)
        code, out, _ = self.run_studio("slice", "check", "SLICE-001")
        check = json.loads(out)
        heading_at = [(n, line[3:].strip()) for n, line in enumerate(broken.splitlines(), start=1) if line.startswith("## ")]
        self.assertEqual(len(check["diagnostics"]), len(check["errors"]) + len(check["warnings"]))
        for item in check["diagnostics"]:
            if item["line"] is None:
                self.assertIsNone(item["section"])
                continue
            expected = [title for start, title in heading_at if start <= item["line"]][-1]
            self.assertEqual(item["section"], expected, item)
        self.assertTrue(any(item["section"] for item in check["diagnostics"]))
        shown = self.ok("slice", "show", "SLICE-001")
        self.assertTrue(all("section" in f for f in shown["spec"]["findings"]))


def cell_validator():
    _, validate_slice = studio.intent_modules()
    return validate_slice


class IntentTemplateTest(unittest.TestCase):
    def test_slice_intent_template_keeps_the_intent_sections_without_a_ticket(self):
        text = (ROOT / "skills/studio/assets/intent-template.md").read_text()
        sections = cell.markdown_sections(text)
        self.assertEqual([name for name in sections if name], list(cell.INTENT_SECTIONS))
        header = cell.fields(sections[""])
        self.assertEqual(sorted(header), ["Slice", "Status"])
        self.assertNotIn("TICKET-ID", text)

    def test_the_ticket_intent_check_is_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "intent.md"
            path.write_text(INTENT_TEXT)
            problems, _ = cell.check_intent(path)
            self.assertEqual(sorted(p for p in problems if "header line" in p),
                             ["intent.md: missing header line '- **Mode:** ...'", "intent.md: missing header line '- **Ticket:** ...'"])
            self.assertEqual(cell.check_intent(path, header_fields=("Slice", "Status"))[0], [])


if __name__ == "__main__":
    unittest.main()
