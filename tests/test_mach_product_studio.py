"""Tests for studio.py: Product Studio's draft workspace, approval gates and the shared slice ID allocator."""

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
SCRIPTS = ROOT / "skills" / "product-studio" / "scripts"
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
        self.ok("epic", "approve", "EPIC-001", project=project)
        return self.ok("slice", "approve", "SLICE-001", project=project)

    def approved_wave(self, project=None):
        self.approved_slice(project)
        self.ok("wave", "new", "--slice", "SLICE-001", project=project)
        return self.ok("wave", "approve", "WAVE-001", "--actor", "Pat PM", "--at", AT, project=project)

    def artifact(self, relative, project=None):
        return json.loads(((project or self.project) / ".factory/studio/draft" / relative).read_text())

    def tree(self, project):
        draft = project / ".factory/studio/draft"
        return {p.relative_to(draft).as_posix(): p.read_bytes() for p in sorted(draft.rglob("*")) if p.is_file()}


class FullSessionTest(Base):
    def test_project_to_approved_wave(self):
        result = self.approved_wave()
        self.assertEqual(result["wave"]["status"], "approved_for_engineering")
        self.assertEqual(result["wave"]["approval"], {"actor": "Pat PM", "approved_at": AT})
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

    def test_approval_uses_the_git_identity(self):
        self.approved_slice()
        self.ok("wave", "new", "--slice", "SLICE-001")
        wave = self.ok("wave", "approve", "WAVE-001")["wave"]
        self.assertEqual(wave["approval"]["actor"], "Pat PM")  # the name, never the address
        self.ok("slice", "reopen", "SLICE-001")
        self.ok("slice", "approve", "SLICE-001")
        self.assertEqual(self.ok("wave", "approve", "WAVE-001", "--actor", "Pat PM <pat@example.com>")["wave"]["approval"]["actor"], "Pat PM")
        self.ok("slice", "reopen", "SLICE-001")
        self.ok("slice", "approve", "SLICE-001")
        self.assertIn("a name, not an address", self.refused("wave", "approve", "WAVE-001", "--actor", "pat@example.com"))
        self.assertTrue(product._is_timestamp(wave["approval"]["approved_at"]))

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
        self.assertIn("slice approve SLICE-001", suggestions)
        self.assertIn("epic approve EPIC-001", suggestions)

    def test_where_points_at_the_shared_interview_files(self):
        where = self.ok("where")
        for key in ("interview_method", "slice_template", "intent_template"):
            self.assertTrue(Path(where[key]).is_file(), key)
        self.assertTrue(all(Path(p).is_file() for p in where["spec_rules"]))
        self.assertEqual(Path(where["interview_method"]).parent.parent, INTENT)

    def test_same_operations_give_identical_bytes(self):
        other = self.make_project("other")
        self.approved_wave()
        self.approved_wave(other)
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
        self.assertIn("No spec yet", self.refused("slice", "approve", "SLICE-001"))

    def test_open_question_blocks(self):
        self.ready_slice()
        self.ok("epic", "approve", "EPIC-001")
        text = FIXTURE.read_text().replace("## Open questions\n\n- None.", "## Open questions\n\n- Do invitations expire? Follow up: ask Legal.")
        self.assertNotEqual(text, FIXTURE.read_text())
        self.write_spec(text=text)
        check = self.ok("slice", "check", "SLICE-001")
        self.assertEqual((check["status"], len(check["open_questions"])), ("interviewing", 1))
        self.assertEqual(self.artifact("product/slices/SLICE-001.json")["open_questions"], ["Do invitations expire?"])
        self.assertEqual(self.run_studio("slice", "check", "SLICE-001", "--ready")[0], 1)
        self.assertIn("open question: Do invitations expire?", self.refused("slice", "approve", "SLICE-001"))
        self.assertEqual(self.artifact("product/slices/SLICE-001.json")["status"], "interviewing")

    def test_spec_the_validator_rejects_blocks(self):
        self.ready_slice()
        self.ok("epic", "approve", "EPIC-001")
        text = FIXTURE.read_text()
        cut = text.index("## Invariants")
        self.write_spec(text=text[:cut] + text[text.index("## Functional requirements"):])
        code, out, _ = self.run_studio("slice", "check", "SLICE-001")
        self.assertEqual(code, 1)
        self.assertTrue(json.loads(out)["errors"])
        self.refused("slice", "approve", "SLICE-001")

    def test_spec_for_another_slice_blocks(self):
        self.ready_slice()
        self.ok("epic", "approve", "EPIC-001")
        self.write_spec(text=FIXTURE.read_text().replace("# SLICE-001:", "# SLICE-009:", 1))
        self.refused("slice", "approve", "SLICE-001")

    def test_missing_or_unfinished_intent_blocks(self):
        self.ready_slice()
        self.ok("epic", "approve", "EPIC-001")
        (self.draft / "product/intents/SLICE-001.md").unlink()
        self.assertIn("is missing", self.refused("slice", "approve", "SLICE-001"))
        self.write_intent(text=(ROOT / "skills/product-studio/assets/intent-template.md").read_text())
        self.assertIn("placeholder", self.refused("slice", "approve", "SLICE-001"))
        self.write_intent(text=INTENT_TEXT.replace("- **Tier:** High", "- **Tier:** Severe"))
        self.assertIn("Tier", self.refused("slice", "approve", "SLICE-001"))

    def test_unapproved_epic_blocks(self):
        self.ready_slice()
        self.assertIn("epic EPIC-001 is proposed", self.refused("slice", "approve", "SLICE-001"))

    def test_epic_needs_criteria_to_be_approved(self):
        self.start()
        self.ok("epic", "add", "--title", "Billing")
        self.assertIn("acceptance criteria", self.refused("epic", "approve", "EPIC-002"))

    def test_approved_slice_cannot_be_edited_in_place(self):
        self.approved_slice()
        for argv in (("slice", "set", "SLICE-001", "--title", "Other"), ("slice", "check", "SLICE-001"), ("slice", "approve", "SLICE-001")):
            self.assertIn("reopen", self.refused(*argv))

    def test_editing_an_approved_spec_is_caught_and_reopen_recovers(self):
        self.approved_wave()
        spec = self.draft / "specs/slices" / SPEC
        spec.write_text(spec.read_text() + "\nA late change.\n")
        code, out, _ = self.run_studio("validate")
        self.assertEqual(code, 1)
        self.assertIn("spec_sha256 does not match", out)
        reopened = self.ok("slice", "reopen", "SLICE-001")
        self.assertEqual(reopened["waves_returned_to_draft"], ["WAVE-001"])
        work, wave = self.artifact("product/slices/SLICE-001.json"), self.artifact("product/delivery-waves/WAVE-001.json")
        self.assertEqual((work["status"], work["spec_sha256"], work["revision"]), ("interviewing", None, 3))
        self.assertEqual((wave["status"], wave["approval"], wave["revision"]), ("draft", None, 3))
        self.assertEqual(self.run_studio("validate")[0], 0)

    def test_wave_approval_rechecks_the_spec(self):
        self.approved_slice()
        self.ok("wave", "new", "--slice", "SLICE-001")
        spec = self.draft / "specs/slices" / SPEC
        spec.write_text(spec.read_text() + "\nA late change.\n")
        self.assertIn("changed after it was approved", self.refused("wave", "approve", "WAVE-001"))
        self.assertEqual(self.artifact("product/delivery-waves/WAVE-001.json")["status"], "draft")

    def test_wave_rules(self):
        self.ready_slice()
        self.assertIn("at least one slice", self.refused("wave", "new"))
        self.assertIn("No such slice", self.refused("wave", "new", "--slice", "SLICE-404"))
        self.ok("wave", "new", "--slice", "SLICE-001")
        self.assertIn("not approved", self.refused("wave", "approve", "WAVE-001"))
        self.assertIn("empty", self.refused("wave", "remove", "WAVE-001", "SLICE-001"))
        self.ok("epic", "approve", "EPIC-001")
        self.ok("slice", "approve", "SLICE-001")
        self.assertIn("date-time", self.refused("wave", "approve", "WAVE-001", "--at", "yesterday"))
        self.ok("wave", "approve", "WAVE-001", "--at", AT)
        self.assertIn("Only a draft wave", self.refused("wave", "add", "WAVE-001", "SLICE-001"))

    def test_a_failed_change_leaves_every_file_as_it_was(self):
        self.ready_slice()
        before = self.tree(self.project)
        self.assertIn("inconsistent", self.refused("slice", "set", "SLICE-001", "--depends-on", "SLICE-404"))
        self.assertIn("inconsistent", self.refused("slice", "set", "SLICE-001", "--depends-on", "SLICE-001"))
        self.assertEqual(self.tree(self.project), before)

    def test_nothing_can_be_sent_without_a_shared_repository(self):
        self.approved_wave()
        self.assertIn("not connected to a shared repository", self.refused("send", "WAVE-001"))
        self.assertIn("not connected to a shared repository", self.refused("send", "WAVE-001", "--dry-run"))
        self.assertEqual(self.ok("feedback")["waves"][0]["status"], "Approved, not sent")
        self.assertIs(self.ok("refresh")["refreshed"], False)


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


class WorkspaceTest(Base):
    def snapshot(self):
        return (git(self.project, "status", "--porcelain").stdout, git(self.project, "rev-parse", "HEAD").stdout,
                git(self.project, "branch", "--list").stdout, git(self.project, "worktree", "list").stdout,
                sorted(p.name for p in self.project.iterdir() if p.name not in (".git", ".factory")),
                sorted(p.name for p in (self.project / ".factory").iterdir()) if (self.project / ".factory").exists() else [])

    def test_the_main_checkout_is_untouched_by_a_whole_session(self):
        before = self.snapshot()
        self.approved_wave()
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

    def publish(self, relative, data):
        path = self.project / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(studio.canonical(data))
        return path

    def test_published_work_arrives_and_unedited_copies_follow_it(self):
        project = {"schema_version": 1, "project_id": "team-space", "name": "Team Space", "revision": 4, "status": "active",
                   "vision": "Teams work together.", "outcomes": ["Teams can work together"]}
        path = self.publish("product/project.json", project)
        status = self.ok("status")
        self.assertEqual(status["project"]["revision"], 4)
        self.assertIn("already defined", self.refused("project", "init", "--id", "x-y", "--name", "n", "--vision", "v", "--outcome", "o"))
        self.publish("product/project.json", {**project, "revision": 5, "name": "Team Rooms"})
        self.assertEqual(self.ok("status")["project"]["name"], "Team Rooms")
        self.assertEqual(path.read_text(), studio.canonical({**project, "revision": 5, "name": "Team Rooms"}))  # never written back

    def test_an_edited_copy_is_kept_and_the_conflict_reported(self):
        project = {"schema_version": 1, "project_id": "team-space", "name": "Team Space", "revision": 4, "status": "active",
                   "vision": "Teams work together.", "outcomes": ["Teams can work together"]}
        self.publish("product/project.json", project)
        self.ok("project", "set", "--vision", "My draft vision.")
        self.publish("product/project.json", {**project, "revision": 5, "vision": "Their vision."})
        status = self.ok("status")
        self.assertEqual(status["project"]["vision"], "My draft vision.")
        self.assertEqual(status["needs_reconciling"]["conflicts"], ["product/project.json"])

    def test_a_number_taken_upstream_blocks_approval_of_the_draft(self):
        self.ready_slice()
        self.ok("epic", "approve", "EPIC-001")
        self.publish("product/slices/SLICE-001.json", {"schema_version": 1, "slice_id": "SLICE-001", "project_id": "team-space",
                                                       "epic_id": "EPIC-001", "revision": 1, "title": "Someone else's slice", "status": "draft",
                                                       "dependencies": [], "open_questions": [], "spec_path": None, "spec_sha256": None})
        self.assertIn("renumbered", self.refused("slice", "approve", "SLICE-001"))
        status = self.ok("status")
        self.assertEqual(status["needs_reconciling"]["collisions"], ["product/slices/SLICE-001.json"])
        self.assertEqual(status["slices"][0]["source"], "collision")
        self.assertEqual(self.artifact("product/slices/SLICE-001.json")["title"], "Invite a teammate")

    def test_symlinked_workspace_is_refused(self):
        elsewhere = Path(self.tmp.name) / "elsewhere"
        elsewhere.mkdir()
        (self.project / ".factory").mkdir()
        (self.project / ".factory/studio").symlink_to(elsewhere, target_is_directory=True)
        self.assertIn("symbolic link", self.refused("status"))
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_bad_ids_never_become_paths(self):
        self.start()
        for bad in ("../../etc", "SLICE-1", "slice-001", "SLICE-001/../x"):
            self.assertIn("not a usable", self.refused("slice", "resume", bad))
        self.assertIn("not a usable project ID", self.refused("project", "init", "--id", "../x", "--name", "n", "--vision", "v", "--outcome", "o", project=self.make_project("p2")))


class WithoutGitTest(Base):
    use_git = False

    def test_works_in_a_folder_that_is_not_a_repository(self):
        self.approved_slice()
        self.ok("wave", "new", "--slice", "SLICE-001")
        wave = self.ok("wave", "approve", "WAVE-001", "--actor", "Pat PM")["wave"]
        self.assertEqual(wave["approval"]["actor"], "Pat PM")
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
        self.assertEqual(self.actions()[1], [("add_epic", None)])
        self.ok("epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join")
        self.assertEqual(self.actions()[1], [("approve_epic", "EPIC-001"), ("start_slice", None)])
        self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate")
        self.assertEqual(self.actions()[1], [("continue_interview", "SLICE-001"), ("approve_epic", "EPIC-001")])
        self.write_spec()
        self.write_intent()
        self.ok("slice", "check", "SLICE-001")
        self.assertEqual(self.actions()[1], [("approve_slice", "SLICE-001"), ("approve_epic", "EPIC-001")])  # a ready slice is still open
        self.ok("epic", "approve", "EPIC-001")
        self.ok("slice", "approve", "SLICE-001")
        status, kinds = self.actions()
        self.assertEqual(kinds, [("create_wave", None), ("start_slice", None)])
        self.assertEqual(status["next_actions"][0]["related"], ["SLICE-001"])
        self.ok("wave", "new", "--slice", "SLICE-001")
        self.assertEqual(self.actions()[1], [("approve_wave", "WAVE-001"), ("start_slice", None)])
        self.ok("wave", "approve", "WAVE-001", "--actor", "Pat PM", "--at", AT)
        self.assertEqual(self.actions()[1], [("send_wave", "WAVE-001"), ("start_slice", None)])

    def test_status_carries_what_the_screens_need(self):
        self.approved_slice()
        self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Remove a teammate", "--depends-on", "SLICE-001")
        self.ok("wave", "new", "--slice", "SLICE-001")
        status = self.ok("status")
        rows = {row["slice_id"]: row for row in status["slices"]}
        second = next(sid for sid in rows if sid != "SLICE-001")
        self.assertEqual((rows["SLICE-001"]["editable"], rows["SLICE-001"]["in_waves"], rows["SLICE-001"]["dependencies"]), (False, ["WAVE-001"], []))
        self.assertEqual((rows[second]["editable"], rows[second]["in_waves"], rows[second]["dependencies"]), (True, [], ["SLICE-001"]))
        self.assertEqual(status["epics"][0]["acceptance_criteria"], ["Only invited people can join"])


class OfflineMessageTest(Base):
    """A shared repository that cannot be reached is reported in a plain sentence, not Git's last line."""

    def setUp(self):
        super().setUp()
        git(self.project, "remote", "add", "origin", str(Path(self.tmp.name) / "no-such-repository"))

    def test_refresh_says_so_plainly(self):
        refreshed = self.ok("refresh")
        self.assertIs(refreshed["refreshed"], False)
        self.assertEqual(refreshed["problem"], "The shared repository could not be reached.")
        self.assertTrue(refreshed["problem_detail"])  # Git's own words, kept apart for an engineer

    def test_send_says_so_plainly(self):
        self.approved_wave()
        message = self.refused("send", "WAVE-001")
        self.assertIn("Could not reach the shared repository, so nothing was sent. Try again when you are connected.", message)
        self.assertNotIn("repository exists", message)


def cell_validator():
    _, validate_slice = studio.intent_modules()
    return validate_slice


class IntentTemplateTest(unittest.TestCase):
    def test_slice_intent_template_keeps_the_intent_sections_without_a_ticket(self):
        text = (ROOT / "skills/product-studio/assets/intent-template.md").read_text()
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
