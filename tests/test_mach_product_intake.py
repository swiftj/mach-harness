"""Tests for Factory product intake and the dependency scheduler (run.py product ...).

Each test publishes real delivery waves with Product Studio into a local bare repository, has an
"engineer" merge them, and then takes them into the engineer's Factory.
"""

import io
import json
import subprocess
import sys
import tarfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
import intake  # noqa: E402
import run  # noqa: E402
from test_mach_product_collab import AT, Base as CollabBase, git, intent_for, spec_for  # noqa: E402

EVENT_KEYS = {"schema_version", "seq", "at", "type", "project_id", "source_commit", "wave_id", "slice_id", "revision", "ticket_id", "data"}


class Base(CollabBase):
    def setUp(self):
        super().setUp()
        # The engineer's clone is the Factory. Execution state is git-ignored there, as in a real install.
        (self.eng / ".gitignore").write_text(".factory/\n__pycache__/\n")
        (self.eng / ".factory").mkdir()
        (self.eng / ".factory/config.json").write_text(json.dumps({"tickets": {"provider": "local"}, "factory": {"max_parallel": 3}}))
        git(self.eng, "add", ".gitignore")
        git(self.eng, "commit", "-q", "-m", "ignore execution state")
        git(self.eng, "push", "-q", "origin", "main")

    def run_product(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.eng), "product", *argv])
        return code, out.getvalue(), err.getvalue()

    def product(self, *argv):
        code, out, err = self.run_product(*argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def refused(self, *argv):
        code, out, err = self.run_product(*argv)
        self.assertEqual(code, 1, out)
        return err + out

    def plan(self):
        plan = self.product("plan")
        return plan, {row["slice_id"]: row for row in plan["slices"]}

    def events(self, since=0):
        return self.product("events", "--since", str(since))["events"]

    def tickets(self):
        folder = self.eng / ".factory/tickets"
        return sorted(p.stem for p in folder.glob("*.md")) if folder.is_dir() else []

    def ticket_text(self, ticket_id):
        return (self.eng / ".factory/tickets" / f"{ticket_id}.md").read_text()

    def ledger(self):
        return json.loads((self.eng / ".factory/intake/ledger.json").read_text())

    def cell(self, ticket_id):
        return json.loads((self.eng / ".factory/worktrees" / ticket_id / "cell.json").read_text())

    def set_cell(self, ticket_id, **changes):
        path = self.eng / ".factory/worktrees" / ticket_id / "cell.json"
        data = json.loads(path.read_text())
        data.update(changes)
        path.write_text(json.dumps(data))

    def checkout(self):
        return (subprocess.run(["git", "status", "--porcelain"], cwd=str(self.eng), capture_output=True, text=True).stdout, git(self.eng, "rev-parse", "HEAD"))

    def slice(self, project, title, depends=()):
        """An approved slice in a product manager's workspace."""
        args = [arg for dep in depends for arg in ("--depends-on", dep)]
        slice_id = self.ok(project, "slice", "new", "--epic", "EPIC-001", "--title", title, *args)["slice"]["slice_id"]
        self.write_slice(project, slice_id)
        self.ok(project, "slice", "approve", slice_id)
        return slice_id

    def publish(self, project, *slice_ids):
        """Approve a wave, send it, and have engineering merge it."""
        wave = self.new_wave(project, *slice_ids)
        self.ok(project, "send", wave)
        self.land(f"product/{wave}")
        self.ok(project, "refresh")
        return wave

    def first(self):
        """Ada's first wave, SLICE-001, is merged; the engineer's main has it."""
        self.first_wave(self.a)
        self.ok(self.a, "send", "WAVE-001")
        self.land("product/WAVE-001")
        self.ok(self.a, "refresh")

    def chain(self):
        """WAVE-001 holds SLICE-001; WAVE-002 holds SLICE-002 (needs 001) and SLICE-003 (needs 002)."""
        self.first()
        second = self.slice(self.a, "Second", depends=["SLICE-001"])
        third = self.slice(self.a, "Third", depends=[second])
        self.publish(self.a, second, third)
        self.product("intake")

    def revise(self, slice_id="SLICE-001"):
        """Product changes an accepted slice: reopen, edit, approve, publish in a new wave."""
        self.ok(self.a, "slice", "reopen", slice_id)
        self.write_slice(self.a, slice_id, extra="\nRevised by product.\n")
        self.ok(self.a, "slice", "approve", slice_id)
        return self.publish(self.a, slice_id)

    def integrate(self, ticket_id, cleanup=False):
        """The line finishes a ticket for real: its branch is merged into the integration branch."""
        repo = self.eng / ".factory/worktrees" / ticket_id / "repo"
        (repo / f"{ticket_id.lower()}.py").write_text("print('built')\n")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", f"build {ticket_id}")
        landed = git(repo, "rev-parse", "HEAD").strip()
        git(self.eng, "merge", "-q", "--no-ff", "-m", f"Merge feature/{ticket_id}", f"feature/{ticket_id}")
        merge_commit = git(self.eng, "rev-parse", "HEAD").strip()
        self.set_cell(ticket_id, stage="merged", merged={"commit": merge_commit, "landed_commit": landed, "method": "local"})
        if cleanup:
            self.clean_up(ticket_id)
        return landed

    def clean_up(self, ticket_id, outcome="merged"):
        """What the cleanup station leaves: an archive holding cell.json, a run record, and no cell."""
        archive = self.eng / ".factory/archive"
        archive.mkdir(exist_ok=True)
        cell_file = self.eng / ".factory/worktrees" / ticket_id / "cell.json"
        with tarfile.open(str(archive / f"{ticket_id}.tar.gz"), "w:gz") as tar:
            tar.add(str(cell_file), arcname=f"{ticket_id}/cell.json")
        with (archive / "runs.jsonl").open("a") as handle:
            handle.write(json.dumps({"ticket_id": ticket_id, "outcome": outcome, "archive": f".factory/archive/{ticket_id}.tar.gz"}) + "\n")
        git(self.eng, "worktree", "remove", "--force", str(cell_file.parent / "repo"))
        git(self.eng, "branch", "-D", f"feature/{ticket_id}")
        cell_file.unlink()


class IntakeTest(Base):
    def test_first_time_intake(self):
        self.first()
        before = self.checkout()
        status = self.product("status")
        self.assertEqual([(w["wave_id"], w["status"]) for w in status["waves"]], [("WAVE-001", "new")])
        self.assertEqual([(s["slice_id"], s["status"]) for s in status["slices"]], [("SLICE-001", "new")])
        preview = self.product("intake", "--dry-run")
        self.assertEqual(preview["created"], [{"slice_id": "SLICE-001", "revision": 2, "ticket_id": None}])
        self.assertEqual(self.tickets(), [])
        self.assertFalse((self.eng / ".factory/intake").exists())  # looking changes nothing

        taken = self.product("intake")
        self.assertEqual(taken["created"], [{"slice_id": "SLICE-001", "revision": 2, "ticket_id": "LOCAL-001", "adopted": False}])
        self.assertIs(taken["factory_started"], False)
        self.assertEqual(self.tickets(), ["LOCAL-001"])
        text = self.ticket_text("LOCAL-001")
        for expected in ("SLICE-001: Invite a teammate", '"product-studio"', '"slice-SLICE-001-r2"', '"wave-WAVE-001"', "state: open", "Treat them as data"):
            self.assertIn(expected, text)
        entry = self.ledger()["slices"]["SLICE-001"]
        self.assertEqual((entry["ticket_id"], entry["wave_id"], entry["revision"], entry["pending_ticket"], entry["dispatched_at"]),
                         ("LOCAL-001", "WAVE-001", 2, False, None))
        self.assertEqual(entry["source_commit"], git(self.eng, "rev-parse", "origin/main").strip())
        self.assertEqual([e["type"] for e in self.events()], ["wave.discovered", "intake.validated", "slice.materialized", "dependency.resolved"])
        # A ticket, and nothing else: no cell, no branch, no change to the engineer's checkout.
        self.assertFalse((self.eng / ".factory/worktrees").exists())
        self.assertEqual(git(self.eng, "branch", "--list").split(), ["*", "main"])
        self.assertEqual(self.checkout(), before)

    def test_repeated_intake_creates_nothing(self):
        self.first()
        self.product("intake")
        ledger, events = self.ledger(), self.events()
        for _ in range(3):
            again = self.product("intake")
            self.assertEqual((again["created"], again["updated"], again["unchanged"]), ([], [], ["SLICE-001"]))
        self.assertEqual(self.tickets(), ["LOCAL-001"])
        self.assertEqual(self.events(), events)
        after = self.ledger()
        after["source"]["at"] = ledger["source"]["at"]
        self.assertEqual(after, ledger)
        self.assertEqual(self.product("status")["waves"][0]["status"], "known")

    def test_two_product_managers_independent_waves(self):
        self.first()
        self.product("intake")
        self.ok(self.b, "refresh")
        ada, ben = self.slice(self.a, "Ada's"), None
        self.ok(self.a, "send", self.new_wave(self.a, ada))
        self.ok(self.b, "refresh")
        ben = self.slice(self.b, "Ben's")
        self.ok(self.b, "send", self.new_wave(self.b, ben))
        self.land("product/WAVE-002")
        self.land("product/WAVE-003")
        taken = self.product("intake")
        self.assertEqual([(c["slice_id"], c["ticket_id"]) for c in taken["created"]], [("SLICE-002", "LOCAL-002"), ("SLICE-003", "LOCAL-003")])
        plan, rows = self.plan()
        self.assertEqual(plan["dispatchable"], ["SLICE-001", "SLICE-002", "SLICE-003"])
        self.assertEqual(plan["parallel_groups"], [["SLICE-001", "SLICE-002", "SLICE-003"]])
        self.assertEqual({rows[key]["wave_id"] for key in rows}, {"WAVE-001", "WAVE-002", "WAVE-003"})

    def test_restart_after_a_ticket_was_filed_but_not_recorded(self):
        self.first()
        real = intake.Factory.ticket
        calls = []

        def crash_after_create(factory, *argv, stdin=None):
            done = real(factory, *argv, stdin=stdin)
            calls.append(argv[0])
            if argv[0] == "create":
                raise RuntimeError("power cut")
            return done

        with mock.patch.object(intake.Factory, "ticket", crash_after_create):
            with self.assertRaises(RuntimeError):
                self.run_product("intake")
        self.assertEqual(self.tickets(), ["LOCAL-001"])
        entry = self.ledger()["slices"]["SLICE-001"]
        self.assertEqual((entry["ticket_id"], entry["pending_ticket"]), (None, True))  # the intention was on record first
        self.assertIn("has not been filed yet", self.plan()[1]["SLICE-001"]["reasons"][0])
        resumed = self.product("intake")
        self.assertEqual(resumed["created"], [{"slice_id": "SLICE-001", "revision": 2, "ticket_id": "LOCAL-001", "adopted": True}])
        self.assertEqual(self.tickets(), ["LOCAL-001"])  # found again by its marker, not filed twice
        self.assertEqual(self.product("intake")["created"], [])
        self.assertEqual([e["type"] for e in self.events()].count("slice.materialized"), 1)

    def test_restart_between_two_slices(self):
        self.first()
        second = self.slice(self.a, "Second")
        self.publish(self.a, second)
        real = intake.Factory.materialize
        seen = []

        def crash_on_second(factory, ledger, entry, *rest):
            if seen:
                raise RuntimeError("power cut")
            seen.append(entry["slice_id"])
            return real(factory, ledger, entry, *rest)

        with mock.patch.object(intake.Factory, "materialize", crash_on_second):
            with self.assertRaises(RuntimeError):
                self.run_product("intake")
        self.assertEqual(self.tickets(), ["LOCAL-001"])
        self.product("intake")
        self.assertEqual(self.tickets(), ["LOCAL-001", "LOCAL-002"])
        self.assertEqual({key: value["ticket_id"] for key, value in self.ledger()["slices"].items()}, {"SLICE-001": "LOCAL-001", "SLICE-002": "LOCAL-002"})

    def test_events_survive_a_crash_between_the_ledger_and_the_log(self):
        self.first()
        self.product("intake")
        _, line = run.factory(run.Project(self.eng))
        ledger = line.ledger()
        line.emit(ledger, "human.required", slice_id="SLICE-001", reason="test")
        intake.write_atomic(line.ledger_path, intake.canonical(ledger))  # the ledger was written; the log append never happened
        before = len(self.events())
        line.save(line.ledger())
        line.save(line.ledger())
        events = self.events()
        self.assertEqual(len(events), before + 1)
        self.assertEqual([e["seq"] for e in events], list(range(1, len(events) + 1)))
        self.assertEqual(line.ledger()["pending_events"], [])

    def test_a_tracker_without_label_search_asks_a_person(self):
        self.first()
        real = intake.Factory.ticket

        def no_search(factory, *argv, stdin=None):
            if argv[0] == "list":
                return subprocess.CompletedProcess(argv, 1, "", "refused: cannot filter by label")
            return real(factory, *argv, stdin=stdin)

        def crash_after_create(factory, *argv, stdin=None):
            done = no_search(factory, *argv, stdin=stdin)
            if argv[0] == "create":
                raise RuntimeError("power cut")
            return done

        with mock.patch.object(intake.Factory, "ticket", crash_after_create):
            with self.assertRaises(RuntimeError):
                self.run_product("intake")
        with mock.patch.object(intake.Factory, "ticket", no_search):
            stuck = self.product("intake")
            self.assertIn("--adopt SLICE-001=", stuck["needs_person"][0]["why"])
            self.assertEqual(self.tickets(), ["LOCAL-001"])
            adopted = self.product("intake", "--adopt", "SLICE-001=LOCAL-001")
        self.assertEqual(adopted["created"][0]["adopted"], True)
        self.assertEqual(self.tickets(), ["LOCAL-001"])


class VerificationTest(Base):
    def tamper(self, relative, change, message="tamper"):
        path = self.eng / relative
        if relative.endswith(".json"):
            data = json.loads(path.read_text())
            change(data)
            path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
        else:
            path.write_text(change(path.read_text()))
        git(self.eng, "add", "-A")
        git(self.eng, "commit", "-q", "-m", message)
        git(self.eng, "push", "-q", "origin", "main")

    def assert_refused(self, expected, waves=1):
        message = self.refused("intake")
        self.assertIn(expected, message)
        self.assertEqual(self.tickets(), [])
        self.assertEqual(self.ledger()["slices"], {})
        kinds = [e["type"] for e in self.events()]
        self.assertEqual((kinds.count("intake.refused"), kinds.count("human.required"), kinds.count("slice.materialized")), (waves, waves, 0))
        self.refused("intake")
        self.assertEqual(len(self.events()), len(kinds))  # the same refusal is reported once

    def test_spec_changed_after_approval(self):
        self.first()
        self.tamper("specs/slices/SLICE-001-invite-teammate.md", lambda text: text + "\nSlipped in after approval.\n")
        self.assert_refused("spec_sha256 does not match")

    def test_unsafe_spec_reference(self):
        self.first()
        self.tamper("product/slices/SLICE-001.json", lambda d: d.update(spec_path="../../etc/passwd"))
        self.assert_refused("spec_path")

    def test_symlinked_spec(self):
        self.first()
        spec = self.eng / "specs/slices/SLICE-001-invite-teammate.md"
        (self.eng / "elsewhere.md").write_text(spec.read_text())
        spec.unlink()
        spec.symlink_to("../../elsewhere.md")
        git(self.eng, "add", "-A")
        git(self.eng, "commit", "-q", "-m", "symlink")
        git(self.eng, "push", "-q", "origin", "main")
        self.assert_refused("SLICE-001")

    def test_wave_without_an_approval_record(self):
        self.first()
        self.tamper("product/delivery-waves/WAVE-001.json", lambda d: d.update(approval=None))
        self.assert_refused("requires recorded author approval")

    def test_cyclic_dependencies(self):
        self.first()
        second = self.slice(self.a, "Second", depends=["SLICE-001"])
        self.publish(self.a, second)
        self.tamper("product/slices/SLICE-001.json", lambda d: d.update(dependencies=[second]))
        self.assert_refused("dependency cycle: SLICE-001 -> SLICE-002 -> SLICE-001", waves=2)

    def test_unknown_dependency(self):
        self.first()
        self.tamper("product/slices/SLICE-001.json", lambda d: d.update(dependencies=["SLICE-404"]))
        self.assert_refused("unknown dependency 'SLICE-404'")

    def test_unmerged_local_product_changes_are_ignored(self):
        self.first()
        path = self.eng / "product/slices/SLICE-001.json"
        data = json.loads(path.read_text())
        data["title"] = "Changed locally, never reviewed"
        path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
        git(self.eng, "commit", "-q", "-am", "local only")
        taken = self.product("intake")
        self.assertIn("unshared commits that change product files", " ".join(taken["notes"]))
        self.assertEqual(self.ledger()["slices"]["SLICE-001"]["title"], "Invite a teammate")
        self.assertEqual(self.ledger()["source"]["commit"], git(self.eng, "rev-parse", "origin/main").strip())

    def test_a_refused_wave_does_not_stop_a_good_one(self):
        self.first()
        second = self.slice(self.a, "Second")
        self.publish(self.a, second)
        self.tamper("product/delivery-waves/WAVE-002.json", lambda d: d.update(project_id="other-project"))
        code, out, _ = self.run_product("intake")
        report = json.loads(out)
        self.assertTrue(report["refused"])  # the tree as a whole no longer validates, so nothing is taken
        self.assertEqual(self.tickets(), [])

    def test_no_product_definitions_yet(self):
        status = self.product("status")
        self.assertEqual((status["has_product"], status["waves"]), (False, []))
        self.assertEqual(self.product("intake")["created"], [])
        self.assertEqual(self.plan()[0]["slices"], [])


class SchedulerTest(Base):
    def test_dependencies_decide_what_is_ready(self):
        self.chain()
        plan, rows = self.plan()
        self.assertEqual({key: row["state"] for key, row in rows.items()}, {"SLICE-001": "ready", "SLICE-002": "blocked", "SLICE-003": "blocked"})
        self.assertEqual(plan["dispatchable"], ["SLICE-001"])
        self.assertEqual(plan["parallel_groups"], [["SLICE-001"], ["SLICE-002"], ["SLICE-003"]])
        self.assertEqual(rows["SLICE-001"]["reasons"], ["It depends on nothing."])
        self.assertEqual(rows["SLICE-002"]["reasons"], ["It waits for SLICE-001 to be integrated (now queued)."])
        self.assertEqual(rows["SLICE-002"]["depends_on"], [{"slice_id": "SLICE-001", "integrated": False, "state": "queued"}])
        self.assertEqual(plan["counts"], {"ready": 1, "blocked": 2})
        self.assertIs(plan["intake_is_current"], True)
        self.assertEqual(plan, self.product("plan"))  # deterministic, and reading it changes nothing

    def test_finished_is_not_integrated(self):
        self.chain()
        self.product("dispatch", "SLICE-001")
        for stage in ("planned", "built", "verified", "approved"):
            self.set_cell("LOCAL-001", stage=stage)
            _, rows = self.plan()
            self.assertEqual((rows["SLICE-001"]["state"], rows["SLICE-002"]["state"]), ("active", "blocked"), stage)
            self.assertIn("now active", rows["SLICE-002"]["reasons"][0])
        # A cell that says "merged" while its commit is not on the integration branch proves nothing.
        self.set_cell("LOCAL-001", stage="merged", merged={"commit": "0" * 40, "landed_commit": None})
        _, rows = self.plan()
        self.assertEqual(rows["SLICE-001"]["state"], "blocked")
        self.assertIn("its commit is not on the integration branch", rows["SLICE-001"]["reasons"][0])
        self.assertEqual(rows["SLICE-002"]["state"], "blocked")

    def test_integration_unblocks_the_next_slice(self):
        self.chain()
        self.product("dispatch", "SLICE-001")
        landed = self.integrate("LOCAL-001")
        plan, rows = self.plan()
        self.assertEqual((rows["SLICE-001"]["state"], rows["SLICE-002"]["state"], rows["SLICE-003"]["state"]), ("completed", "ready", "blocked"))
        self.assertEqual(rows["SLICE-001"]["integrated_commit"], git(self.eng, "rev-parse", "HEAD").strip())
        self.assertEqual(rows["SLICE-002"]["reasons"], ["Everything it depends on is integrated."])
        self.assertEqual(plan["dispatchable"], ["SLICE-002"])
        seq = len(self.events())
        self.product("dispatch", "SLICE-002")
        kinds = [(e["type"], e["slice_id"]) for e in self.events(seq)]
        self.assertEqual(kinds, [("slice.integrated", "SLICE-001"), ("dependency.resolved", "SLICE-002"), ("work.scheduled", "SLICE-002")])
        self.assertEqual(self.ledger()["slices"]["SLICE-002"]["built_against"], {"SLICE-001": 2})
        self.assertTrue(landed)

    def test_integration_is_still_known_after_cleanup(self):
        self.chain()
        self.product("dispatch", "SLICE-001")
        self.integrate("LOCAL-001", cleanup=True)
        _, rows = self.plan()
        self.assertEqual((rows["SLICE-001"]["state"], rows["SLICE-002"]["state"]), ("completed", "ready"))

    def test_a_manual_merge_is_recognised_from_the_approved_commit(self):
        self.chain()
        self.product("dispatch", "SLICE-001")
        landed = self.integrate("LOCAL-001")
        self.set_cell("LOCAL-001", stage="approved", merged=None)  # merged by hand: the merge station recorded nothing
        self.assertEqual(self.plan()[1]["SLICE-001"]["state"], "active")  # still in the line until it is cleaned up
        archive = self.eng / ".factory/archive"
        archive.mkdir()
        decision = self.eng / "decision.json"
        decision.write_text(json.dumps({"outcome": "APPROVED", "head": landed}))
        with tarfile.open(str(archive / "LOCAL-001.tar.gz"), "w:gz") as tar:
            tar.add(str(self.eng / ".factory/worktrees/LOCAL-001/cell.json"), arcname="LOCAL-001/cell.json")
            tar.add(str(decision), arcname="LOCAL-001/review/decision.json")
        decision.unlink()
        (archive / "runs.jsonl").write_text(json.dumps({"ticket_id": "LOCAL-001", "outcome": "merged"}) + "\n")
        git(self.eng, "worktree", "remove", "--force", str(self.eng / ".factory/worktrees/LOCAL-001/repo"))
        (self.eng / ".factory/worktrees/LOCAL-001/cell.json").unlink()
        _, rows = self.plan()
        self.assertEqual((rows["SLICE-001"]["state"], rows["SLICE-001"]["integrated_commit"], rows["SLICE-002"]["state"]), ("completed", landed, "ready"))

    def test_a_run_record_alone_is_not_integration(self):
        self.chain()
        self.product("dispatch", "SLICE-001")
        self.set_cell("LOCAL-001", stage="merged", merged={"commit": "0" * 40})
        self.clean_up("LOCAL-001")  # the record says merged; the commit it names is nowhere on main
        _, rows = self.plan()
        self.assertEqual((rows["SLICE-001"]["state"], rows["SLICE-001"]["needs_person"], rows["SLICE-002"]["state"]), ("blocked", True, "blocked"))

    def test_an_abandoned_ticket_blocks_until_reissued(self):
        self.chain()
        self.product("dispatch", "SLICE-001")
        self.clean_up("LOCAL-001", outcome="abandoned")
        plan, rows = self.plan()
        self.assertEqual((rows["SLICE-001"]["state"], plan["needs_person"]), ("blocked", ["SLICE-001"]))
        self.assertIn("was abandoned", rows["SLICE-001"]["reasons"][0])
        self.assertIn("not abandoned", self.refused("intake", "--reissue", "SLICE-002"))
        again = self.product("intake", "--reissue", "SLICE-001")
        self.assertEqual(again["created"], [{"slice_id": "SLICE-001", "revision": 2, "ticket_id": "LOCAL-004", "reissued": True}])
        self.assertEqual(self.plan()[1]["SLICE-001"]["state"], "ready")

    def test_concurrency_limit(self):
        self.first()
        for title in ("B", "C", "D"):
            self.publish(self.a, self.slice(self.a, title))
        (self.eng / ".factory/config.json").write_text(json.dumps({"tickets": {"provider": "local"}, "factory": {"max_parallel": 2}}))
        self.product("intake")
        plan, rows = self.plan()
        self.assertEqual((plan["dispatchable"], plan["waiting_for_a_place"]), (["SLICE-001", "SLICE-002"], ["SLICE-003", "SLICE-004"]))
        self.assertIn("waiting for a free place: 0 of 2", rows["SLICE-003"]["reasons"][-1])
        refused = self.product("dispatch", "SLICE-004")
        self.assertEqual((refused["tickets"], refused["refused"][0]["state"]), ([], "ready"))
        sent = self.product("dispatch", "--ready")
        self.assertEqual(sent["tickets"], ["LOCAL-001", "LOCAL-002"])
        plan, _ = self.plan()
        self.assertEqual((plan["limits"], plan["dispatchable"], plan["waiting_for_a_place"]),
                         ({"max_parallel": 2, "active": 2, "free": 0}, [], ["SLICE-003", "SLICE-004"]))
        self.assertEqual(self.product("dispatch", "--ready")["tickets"], [])
        self.integrate("LOCAL-001")
        self.assertEqual(self.plan()[0]["dispatchable"], ["SLICE-003"])
        self.assertEqual(self.product("dispatch", "--ready", "--limit", "1")["tickets"], ["LOCAL-003"])

    def test_a_dependency_that_is_not_approved_work_here(self):
        self.chain()
        ledger = self.ledger()
        ledger["slices"]["SLICE-001"]["state"] = "superseded"
        (self.eng / ".factory/intake/ledger.json").write_text(json.dumps(ledger))
        _, rows = self.plan()
        self.assertEqual(rows["SLICE-001"]["state"], "superseded")
        self.assertEqual(rows["SLICE-002"]["reasons"], ["It depends on SLICE-001, which is not approved work in this Factory."])

    def test_the_scheduler_finds_cycles_itself(self):
        self.assertEqual(intake.find_cycles({"SLICE-003": ["SLICE-001"], "SLICE-001": ["SLICE-002"], "SLICE-002": ["SLICE-003"], "SLICE-004": ["SLICE-001"]}),
                         [["SLICE-001", "SLICE-002", "SLICE-003"]])
        self.assertEqual(intake.find_cycles({"SLICE-001": [], "SLICE-002": ["SLICE-001"]}), [])
        self.chain()
        ledger = self.ledger()
        ledger["slices"]["SLICE-001"]["dependencies"] = ["SLICE-003"]
        (self.eng / ".factory/intake/ledger.json").write_text(json.dumps(ledger))
        plan, rows = self.plan()
        self.assertEqual(plan["cycles"], [["SLICE-001", "SLICE-003", "SLICE-002", "SLICE-001"]])
        self.assertEqual((plan["dispatchable"], {row["state"] for row in rows.values()}), ([], {"blocked"}))
        self.assertIn("dependency cycle: SLICE-001 -> SLICE-003 -> SLICE-002 -> SLICE-001", rows["SLICE-002"]["reasons"][0])


class RevisionTest(Base):
    def test_modified_before_execution(self):
        self.first()
        self.product("intake")
        self.revise()
        status = self.product("status")
        self.assertEqual([(s["slice_id"], s["status"], s["was_revision"], s["revision"], s["work"]) for s in status["slices"]],
                         [("SLICE-001", "modified", 2, 4, "queued")])
        plan, rows = self.plan()
        self.assertEqual((rows["SLICE-001"]["state"], plan["intake_is_current"]), ("blocked", False))
        self.assertIn("changed since intake", rows["SLICE-001"]["reasons"][0])
        self.assertIn("changed since intake", json.dumps(self.product("dispatch", "SLICE-001")["refused"]))
        taken = self.product("intake")
        self.assertEqual(taken["updated"], [{"slice_id": "SLICE-001", "from_revision": 2, "to_revision": 4, "ticket_id": "LOCAL-001", "effect": "ticket updated"}])
        self.assertEqual(self.tickets(), ["LOCAL-001"])  # the same ticket, not a second one
        text = self.ticket_text("LOCAL-001")
        self.assertIn('"slice-SLICE-001-r4"', text)
        self.assertNotIn('"slice-SLICE-001-r2"', text)
        self.assertEqual(self.plan()[1]["SLICE-001"]["state"], "ready")
        self.assertIn("revision.superseded", [e["type"] for e in self.events()])
        self.product("dispatch", "SLICE-001")
        self.assertIn("Revised by product.", (self.eng / ".factory/worktrees/LOCAL-001/spec.md").read_text())

    def test_modified_during_execution(self):
        self.first()
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        cell_before = (self.eng / ".factory/worktrees/LOCAL-001/cell.json").read_text()
        spec_before = (self.eng / ".factory/worktrees/LOCAL-001/spec.md").read_text()
        self.revise()
        taken = self.product("intake")
        self.assertEqual(taken["needs_person"], [{"slice_id": "SLICE-001", "from_revision": 2, "to_revision": 4, "ticket_id": "LOCAL-001",
                                                  "why": "the definition changed while work was in progress"}])
        self.assertEqual((taken["created"], taken["updated"]), ([], []))
        # Work in flight is never changed underneath the line.
        self.assertEqual((self.eng / ".factory/worktrees/LOCAL-001/cell.json").read_text(), cell_before)
        self.assertEqual((self.eng / ".factory/worktrees/LOCAL-001/spec.md").read_text(), spec_before)
        self.assertEqual(self.tickets(), ["LOCAL-001"])
        plan, rows = self.plan()
        self.assertEqual((rows["SLICE-001"]["state"], rows["SLICE-001"]["needs_person"], plan["needs_person"]), ("active", True, ["SLICE-001"]))
        self.assertEqual(rows["SLICE-001"]["stale"], ["The approved definition changed while this was being built."])
        seq = len(self.events())
        self.product("intake")
        self.assertEqual(self.events(seq), [])  # said once
        kinds = [e["type"] for e in self.events()]
        self.assertIn("revision.superseded", kinds)
        self.assertIn("human.required", kinds)

    def test_completed_work_becomes_stale(self):
        self.chain()
        self.product("dispatch", "SLICE-001")
        self.integrate("LOCAL-001", cleanup=True)
        self.product("dispatch", "SLICE-002")
        self.integrate("LOCAL-002")
        self.revise("SLICE-001")
        _, rows = self.plan()
        self.assertEqual(rows["SLICE-001"]["state"], "completed")
        self.assertEqual(rows["SLICE-001"]["stale"], ["The approved definition changed after this was built. Run intake to open follow-up work."])
        taken = self.product("intake")
        self.assertEqual(taken["updated"], [{"slice_id": "SLICE-001", "from_revision": 2, "to_revision": 4, "ticket_id": "LOCAL-004", "effect": "follow-up ticket"}])
        entry = self.ledger()["slices"]["SLICE-001"]
        self.assertEqual((entry["ticket_id"], entry["revision"], entry["history"][0]["ticket_id"], entry["history"][0]["revision"]), ("LOCAL-004", 4, "LOCAL-001", 2))
        plan, rows = self.plan()
        self.assertEqual((rows["SLICE-001"]["state"], rows["SLICE-002"]["state"], rows["SLICE-003"]["state"]), ("ready", "completed", "ready"))
        self.assertEqual(rows["SLICE-002"]["stale"], ["Built against SLICE-001 revision 2; SLICE-001 is now revision 4."])
        self.assertEqual(plan["dispatchable"], ["SLICE-001", "SLICE-003"])
        self.assertEqual([e["slice_id"] for e in self.events() if e["type"] == "slice.integrated"], ["SLICE-001", "SLICE-002"])

    def test_a_withdrawn_wave(self):
        self.first()
        self.product("intake")
        path = self.eng / "product/delivery-waves/WAVE-001.json"
        data = json.loads(path.read_text())
        data.update(status="superseded")
        path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
        git(self.eng, "commit", "-q", "-am", "withdraw the wave")
        git(self.eng, "push", "-q", "origin", "main")
        self.assertEqual(self.product("status")["slices"][0]["status"], "superseded")
        taken = self.product("intake")
        self.assertEqual(taken["superseded"], [{"slice_id": "SLICE-001", "why": "it is no longer in any approved delivery wave", "ticket_id": "LOCAL-001"}])
        self.assertIn("state: closed", self.ticket_text("LOCAL-001"))
        plan, rows = self.plan()
        self.assertEqual((rows["SLICE-001"]["state"], plan["dispatchable"]), ("superseded", []))
        self.assertIn("Withdrawn", rows["SLICE-001"]["reasons"][0])
        self.assertEqual(self.product("intake")["superseded"], [])

    def test_a_wave_withdrawn_while_being_built(self):
        self.first()
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        path = self.eng / "product/delivery-waves/WAVE-001.json"
        data = json.loads(path.read_text())
        data.update(status="superseded")
        path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
        git(self.eng, "commit", "-q", "-am", "withdraw the wave")
        git(self.eng, "push", "-q", "origin", "main")
        taken = self.product("intake")
        self.assertIn("withdrawn by product while in progress", taken["needs_person"][0]["why"])
        self.assertNotIn("state: closed", self.ticket_text("LOCAL-001"))
        _, rows = self.plan()
        self.assertEqual((rows["SLICE-001"]["state"], rows["SLICE-001"]["needs_person"]), ("active", True))


class DispatchTest(Base):
    def test_explicit_dispatch_prepares_the_cell_and_starts_nothing(self):
        self.first()
        self.product("intake")
        self.assertFalse((self.eng / ".factory/local").exists())  # automatic execution was never enabled
        result = self.product("dispatch", "SLICE-001")
        self.assertEqual(result["dispatched"], [{"slice_id": "SLICE-001", "ticket_id": "LOCAL-001", "stage": "spec-ready", "risk": "High", "already_dispatched": False}])
        self.assertEqual((result["tickets"], result["factory_started"], result["workflow"]), (["LOCAL-001"], False, "mach:belt"))
        cell = self.cell("LOCAL-001")
        self.assertEqual((cell["stage"], cell["slice_id"], cell["risk"], cell["branch"], cell["isolation"]), ("spec-ready", "SLICE-001", "High", "feature/LOCAL-001", "worktree"))
        self.assertEqual(cell["product"]["revision"], 2)
        self.assertEqual(cell["product"]["digest"], self.ledger()["slices"]["SLICE-001"]["digest"])
        root = self.eng / ".factory/worktrees/LOCAL-001"
        intent = (root / "intent.md").read_text()
        for expected in ("- **Ticket:** LOCAL-001 (local)", "- **Mode:** Interactive (Product Studio, approved by Ada PM)", "- **Status:** Ready for contracts",
                         "- **Ticket:** LOCAL-001: Invite a teammate", "- **Problem:** An admin cannot bring a colleague in."):
            self.assertIn(expected, intent)
        spec_json = json.loads((root / "spec.json").read_text())
        self.assertEqual((spec_json["ticket_id"], spec_json["slice_id"], len(spec_json["functional_requirements"])), ("LOCAL-001", "SLICE-001", 9))
        self.assertFalse((root / "plan.md").exists())  # contracts and the plan are still engineering's work
        self.assertIn("state: in_progress", self.ticket_text("LOCAL-001"))
        # The existing state machine takes over from here, unchanged.
        step = run.next_step(run.Project(self.eng), "LOCAL-001", True)
        self.assertEqual((step["stage"], step["action"], step["model"]), ("spec-ready", "plan", "opus"))
        board = json.loads(self.board())
        self.assertEqual((board["ready_to_run"], [row["action"] for row in board["tickets"]]), (["LOCAL-001"], ["plan"]))

    def board(self):
        out = io.StringIO()
        with redirect_stdout(out):
            run.main(["--project", str(self.eng), "board"])
        return out.getvalue()

    def test_dispatch_is_idempotent_and_resumes(self):
        self.first()
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        seq = len(self.events())
        again = self.product("dispatch", "SLICE-001")
        self.assertEqual(again["dispatched"], [{"slice_id": "SLICE-001", "ticket_id": "LOCAL-001", "stage": "spec-ready", "already_dispatched": True}])
        self.assertEqual(self.events(seq), [])
        self.assertEqual(git(self.eng, "worktree", "list").count("\n"), 2)

    def test_dispatch_interrupted_after_the_cell_opened(self):
        self.first()
        self.product("intake")
        real = intake.Factory.script

        def crash_at_finalize(factory, station, name, *argv, stdin=None):
            if name == "cell.py" and argv[0] == "finalize":
                raise RuntimeError("power cut")
            return real(factory, station, name, *argv, stdin=stdin)

        with mock.patch.object(intake.Factory, "script", crash_at_finalize):
            with self.assertRaises(RuntimeError):
                self.run_product("dispatch", "SLICE-001")
        self.assertEqual(self.cell("LOCAL-001")["stage"], "interview")
        self.assertIsNone(self.ledger()["slices"]["SLICE-001"]["dispatched_at"])
        resumed = self.product("dispatch", "SLICE-001")
        self.assertEqual((resumed["dispatched"][0]["stage"], resumed["dispatched"][0]["already_dispatched"]), ("spec-ready", False))
        self.assertEqual([e["type"] for e in self.events()].count("work.scheduled"), 1)

    def test_nothing_dispatches_without_being_asked(self):
        self.chain()
        local = self.eng / ".factory/local"
        local.mkdir()
        (local / "runner.json").write_text(json.dumps({"schema_version": 1, "enabled": True, "paused": False, "auto_sync": True, "autonomy": "extended"}))
        for argv in (("status",), ("intake",), ("plan",), ("events",), ("intake", "--dry-run")):
            self.product(*argv)
        self.assertFalse((self.eng / ".factory/worktrees").exists())
        self.assertEqual(git(self.eng, "branch", "--list").split(), ["*", "main"])
        self.assertNotIn("work.scheduled", [e["type"] for e in self.events()])
        self.assertIn("Name the slices to dispatch", self.refused("dispatch"))

    def test_only_ready_slices_can_be_dispatched(self):
        self.chain()
        result = self.product("dispatch", "SLICE-002", "SLICE-404", "SLICE-001")
        self.assertEqual(result["tickets"], ["LOCAL-001"])
        self.assertEqual([(r["slice_id"], r["why"][0]) for r in result["refused"]],
                         [("SLICE-002", "It waits for SLICE-001 to be integrated (now queued)."), ("SLICE-404", "It is not in the intake ledger. Run intake first.")])

    def test_dispatch_never_changes_the_checkout(self):
        self.first()
        self.product("intake")
        git(self.eng, "switch", "-q", "-c", "something-else")
        (self.eng / "wip.txt").write_text("work in progress\n")
        git(self.eng, "add", "-A")
        git(self.eng, "commit", "-q", "-m", "unrelated work")
        before = self.checkout()
        self.assertIn("dispatch never changes your checkout", self.refused("dispatch", "SLICE-001"))
        self.assertEqual(self.checkout(), before)
        self.assertFalse((self.eng / ".factory/worktrees").exists())
        git(self.eng, "switch", "-q", "main")
        before = self.checkout()
        self.product("dispatch", "SLICE-001")
        self.assertEqual(self.checkout(), before)

    def test_a_local_change_to_the_spec_blocks_dispatch(self):
        self.first()
        self.product("intake")
        spec = self.eng / "specs/slices/SLICE-001-invite-teammate.md"
        spec.write_text(spec.read_text() + "\nlocal edit\n")
        git(self.eng, "commit", "-q", "-am", "local edit to an approved spec")
        result = self.product("dispatch", "SLICE-001")
        self.assertEqual(result["tickets"], [])
        self.assertIn("is not the approved spec", result["refused"][0]["why"][0])
        self.assertFalse((self.eng / ".factory/worktrees").exists())

    def test_product_cannot_lower_the_review_tier(self):
        self.first_wave(self.a)
        intent = self.draft(self.a, "product/intents/SLICE-001.md")
        self.ok(self.a, "slice", "reopen", "SLICE-001")
        intent.write_text(intent_for("SLICE-001").replace("- **Tier:** High", "- **Tier:** Low"))
        self.ok(self.a, "slice", "approve", "SLICE-001")
        self.ok(self.a, "wave", "approve", "WAVE-001", "--at", AT)
        self.ok(self.a, "send", "WAVE-001")
        self.land("product/WAVE-001")
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.assertEqual(self.cell("LOCAL-001")["risk"], "Medium")
        intent_md = (self.eng / ".factory/worktrees/LOCAL-001/intent.md").read_text()
        self.assertIn("- **Tier:** Medium", intent_md)
        self.assertIn("Product proposed Low; product-sourced work is reviewed at Medium or above.", intent_md)


class EventsTest(Base):
    def test_every_event_is_versioned_ordered_and_typed(self):
        self.chain()
        self.product("dispatch", "SLICE-001")
        self.integrate("LOCAL-001")
        self.revise("SLICE-001")
        self.product("intake")
        self.product("plan")
        result = self.product("events")
        events = result["events"]
        self.assertEqual((result["schema_version"], result["event_types"]), (1, list(intake.EVENT_TYPES)))
        self.assertEqual([e["seq"] for e in events], list(range(1, len(events) + 1)))
        for event in events:
            self.assertEqual(set(event), EVENT_KEYS)
            self.assertIn(event["type"], intake.EVENT_TYPES)
            self.assertEqual((event["schema_version"], event["project_id"]), (1, "team-space"))
            self.assertRegex(event["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual({e["type"] for e in events}, {"wave.discovered", "intake.validated", "slice.materialized", "dependency.resolved", "dependency.blocked",
                                                       "work.scheduled", "slice.integrated", "revision.superseded"})
        self.assertEqual(self.product("events", "--since", str(len(events) - 2))["events"], events[-2:])
        blocked = next(e for e in events if e["type"] == "dependency.blocked")
        self.assertEqual((blocked["slice_id"], blocked["data"]["reasons"]), ("SLICE-002", ["It waits for SLICE-001 to be integrated (now queued)."]))
        scheduled = next(e for e in events if e["type"] == "work.scheduled")
        self.assertEqual((scheduled["ticket_id"], scheduled["data"]["by"], scheduled["data"]["stage"]), ("LOCAL-001", "explicit dispatch", "spec-ready"))

    def test_schema_files_describe_the_events_and_the_ledger(self):
        schemas = ROOT / "docs/mach-next/schemas"
        event = json.loads((schemas / "factory-event.schema.json").read_text())
        self.assertEqual(sorted(event["required"]), sorted(EVENT_KEYS))
        self.assertEqual(event["properties"]["type"]["enum"], list(intake.EVENT_TYPES))
        self.assertEqual(event["properties"]["schema_version"], {"const": intake.EVENT_VERSION})
        ledger = json.loads((schemas / "intake-ledger.schema.json").read_text())
        self.assertEqual(ledger["properties"]["schema_version"], {"const": intake.LEDGER_VERSION})
        self.first()
        self.product("intake")
        self.assertEqual(sorted(set(self.ledger()) - {"last_refusal"}), sorted(ledger["required"]))
        entry = self.ledger()["slices"]["SLICE-001"]
        self.assertTrue(set(ledger["properties"]["slices"]["additionalProperties"]["required"]) <= set(entry))


if __name__ == "__main__":
    unittest.main()
