"""Release qualification (run.py release ...) and product acceptance (Product Studio's acceptance record).

Each test hands a slice over as Product Studio does (a ready folder on the shared branch, or a slice
issue), has an "engineer" take it in, dispatch it and merge the ticket's branch, and leaves the
archive the cleanup station would leave. Verdicts are written as the verification and review stations record them:
simulated station records, real Git, a real rerun of the project's suite.
"""

import io
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
import run  # noqa: E402
from test_mach_product_intake import Base as IntakeBase, git  # noqa: E402
import class_template  # noqa: E402  (a step taken from the same starting folder is run once per class)

QUALIFY = ROOT / "skills" / "run" / "scripts" / "qualify.py"
CHECK = "import pathlib, sys\nsys.exit(0 if pathlib.Path('ok.txt').is_file() else 1)\n"


class Base(IntakeBase):
    def setUp(self):
        super().setUp()
        class_template.step(self, "suite", self.root, self.suite)

    def suite(self):
        """A test suite on main and the release settings; files only."""
        (self.eng / "check.py").write_text(CHECK)
        (self.eng / "ok.txt").write_text("ok\n")
        git(self.eng, "add", "check.py", "ok.txt")
        git(self.eng, "commit", "-q", "-m", "a suite")
        git(self.eng, "push", "-q", "origin", "main")
        self.configure()

    def configure(self, **release):
        config = {"tickets": {"provider": "local"}, "factory": {"max_parallel": 3},
                  "audit": {"commands": {"test": f"{sys.executable} check.py"}}, "release": release}
        (self.eng / ".factory/config.json").write_text(json.dumps(config))

    def run_release(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.eng), "release", *argv])
        return code, out.getvalue(), err.getvalue()

    def release(self, *argv):
        code, out, err = self.run_release(*argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def refused_release(self, *argv):
        code, out, err = self.run_release(*argv)
        self.assertEqual(code, 1, out)
        return err

    def readiness(self, release_id):
        return json.loads((self.eng / ".factory/release" / release_id / "readiness.json").read_text())

    def scan(self, commit, findings=(), drop=(), **extra):
        """A scanner report with the facts MACH requires; `drop` leaves fields out, `extra` changes them."""
        folder = self.eng / ".factory/release/scans"
        folder.mkdir(parents=True, exist_ok=True)
        report = {"tool": "scanner", "version": "8.18.0", "commit": commit, "exit_code": 0, "scanned": 12, "scanned_at": "2026-11-14T10:00:00Z",
                  "findings": list(findings), **extra}
        (folder / "scanner.json").write_text(json.dumps({k: v for k, v in report.items() if k not in drop}))

    def head(self):
        return git(self.eng, "rev-parse", "HEAD").strip()

    def finish(self, ticket_id="LOCAL-001", verdict="PASS", outcome="APPROVED", blockers=(), contract=None, exceptions=None):
        """The ticket goes through the line: merged into main, then archived as the cleanup station would.
        With `contract` (path, text), the slice's plan names that contract and its build writes it."""
        if contract:
            path, text = contract
            target = self.eng / ".factory/worktrees" / ticket_id / "repo" / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
            self.set_cell(ticket_id, contracts=[path])
        landed = self.integrate(ticket_id)
        merge_commit = self.head()
        cell_dir = self.eng / ".factory/worktrees" / ticket_id
        evidence = {f"ac-{n}.log": f"AC-0{n} proven\n".encode() for n in (1, 2, 3)}
        import hashlib
        summary = {"status": verdict, "head": landed, "checks": {f"AC-0{n}": {"kind": "scenario", "result": "pass", "note": None, "evidence": [f"ac-{n}.log"]} for n in (1, 2, 3)},
                   "evidence_files": [{"file": name, "sha256": hashlib.sha256(data).hexdigest()} for name, data in evidence.items()]}
        decision = {"outcome": outcome, "head": landed, "round": 1, "risk": "Medium", "blockers": len(blockers), "human_approval_required": False, "human_approval": None}
        if exceptions is not None:
            decision["exceptions"] = [{**item, "head": landed} for item in exceptions]
        archive = self.eng / ".factory/archive"
        archive.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory() as folder:
            staged = Path(folder) / ticket_id
            (staged / "evidence").mkdir(parents=True)
            (staged / "review").mkdir()
            shutil.copy(cell_dir / "cell.json", staged / "cell.json")
            (staged / "evidence/summary.json").write_text(json.dumps(summary))
            for name, data in evidence.items():
                (staged / "evidence" / name).write_bytes(data)
            (staged / "review/decision.json").write_text(json.dumps(decision))
            with tarfile.open(str(archive / f"{ticket_id}.tar.gz"), "w:gz") as tar:
                tar.add(str(staged), arcname=ticket_id)
        record = {"record_version": 2, "ticket_id": ticket_id, "outcome": "merged", "archive": f".factory/archive/{ticket_id}.tar.gz",
                  "integration": {"approved_commit": landed, "landed_commit": landed, "merge_commit": merge_commit, "method": "local"},
                  "blockers": [{"round": 1, **b} for b in blockers]}
        with (archive / "runs.jsonl").open("a") as handle:
            handle.write(json.dumps(record) + "\n")
        git(self.eng, "worktree", "remove", "--force", str(cell_dir / "repo"))
        git(self.eng, "branch", "-D", f"feature/{ticket_id}")
        shutil.rmtree(cell_dir)
        return merge_commit

    def built(self, **finish):
        """SLICE-001 taken in from its ready folder, built, verified, reviewed and merged."""
        # The same step from the same folder and the same slices in hand is run once per class; later tests get a copy.
        key = "built " + json.dumps([finish, self.folders], sort_keys=True)
        commit, self.folders = class_template.step(self, key, self.root, lambda: self._built(**finish))
        return commit

    def _built(self, **finish):
        self.first()
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        return [self.finish(**finish), self.folders]

    def studio_refused(self, project, *argv):
        code, out, err = self.run_studio(project, *argv)
        self.assertEqual(code, 1, out)
        return err

    def checks(self, data):
        return {c["id"]: c for c in data["checks"]}


class OutcomeTest(Base):
    def test_qualified_and_byte_identical(self):
        commit = self.built()
        self.configure(integration_command=f"{sys.executable} check.py")
        self.scan(commit)
        first = self.release("qualify", "SLICE-001", "--release", "r1")
        self.assertEqual((first["outcome"], first["commit"], first["released"]), ("qualified", commit, False))
        path = self.eng / ".factory/release/r1/readiness.json"
        before = path.read_bytes()
        run_before = json.loads((path.parent / "run.json").read_text())
        self.release("qualify", "SLICE-001", "--release", "r1")
        self.assertEqual(path.read_bytes(), before)
        self.assertIn("evaluated_at", run_before)
        data = self.readiness("r1")
        self.assertNotIn("evaluated_at", json.dumps(data))
        self.assertEqual((data["schema_version"], data["scope"]), (2, {"epic": None, "slices": ["SLICE-001"], "issues_not_taken_in": []}))
        row = data["slices"][0]
        self.assertEqual((row["slice_id"], row["ticket_id"], row["integration"]["status"], row["verification"]["verdict"], row["review"]["decision"]),
                         ("SLICE-001", "LOCAL-001", "integrated", "PASS", "APPROVED"))
        self.assertIn("merge-base --is-ancestor", row["integration"]["established_by"])
        self.assertEqual([(s["scenario_id"], s["status"]) for s in data["acceptance_scenarios"]], [("AC-01", "pass"), ("AC-02", "pass"), ("AC-03", "pass")])
        self.assertEqual(data["commands"]["test_suite"]["status"], "pass")
        self.assertEqual(data["not_assessed"], ["performance"])
        self.assertEqual(data["outcome_summary"], "qualified; not assessed: performance (not configured)")
        self.assertEqual(first["outcome_summary"], data["outcome_summary"])
        # A merged, verified, passing release is still not accepted by product.
        self.assertEqual(data["product_acceptance"]["decision"], "not_recorded")

    def test_a_missing_check_is_incomplete_never_a_pass(self):
        self.built()
        result = self.release("qualify", "SLICE-001")
        self.assertEqual(result["outcome"], "incomplete")
        data = self.readiness(result["release_id"])
        checks = self.checks(data)
        self.assertEqual(checks["integration_tests"]["status"], "not_configured")
        self.assertEqual(checks["security.scan"]["status"], "not_run")
        self.assertEqual(set(data["incomplete"]), {"integration_tests", "security.scan"})

    def test_a_scanner_that_failed_or_scanned_nothing_is_not_run(self):
        commit = self.built()
        self.configure(integration_command=f"{sys.executable} check.py")
        for extra, reason in (({"exit_code": 128}, "exited with code 128"), ({"scanned": 0}, "scanned no sources"),
                              ({"error": "no package sources found"}, "reported an error")):
            self.scan(commit, **extra)
            result = self.release("qualify", "SLICE-001", "--release", "r1")
            check = self.checks(self.readiness("r1"))["security.scan.scanner"]
            self.assertEqual((result["outcome"], check["status"]), ("incomplete", "not_run"), extra)
            self.assertIn(reason, check["detail"])
            self.assertIn("security.scan.scanner", result["incomplete"])
        self.scan(commit, exit_code=1, scanned=12)  # findings-found exit code, sources scanned: a real result
        self.assertEqual(self.release("qualify", "SLICE-001", "--release", "r1")["outcome"], "qualified")

    def test_a_report_without_the_facts_is_not_evidence(self):
        commit = self.built()
        self.configure(integration_command=f"{sys.executable} check.py")
        for field in ("version", "exit_code", "scanned", "scanned_at"):
            self.scan(commit, drop=(field,))
            result = self.release("qualify", "SLICE-001", "--release", "r1")
            check = self.checks(self.readiness("r1"))["security.scan.scanner"]
            self.assertEqual((result["outcome"], check["status"]), ("incomplete", "not_run"), field)
            self.assertIn(f"report lacks {field}", check["detail"])
            self.assertIn(f"security.scan.scanner (not run: report lacks {field})", result["outcome_summary"])

    def test_the_outcome_line_names_every_check_not_shown(self):
        self.built()
        result = self.release("qualify", "SLICE-001")
        self.assertEqual(result["outcome_summary"], "incomplete; not assessed: integration_tests (not configured), performance (not configured), "
                                                    "security.scan (not run: no scanner report for this commit)")

    def test_a_failing_suite_blocks(self):
        self.built()
        (self.eng / "ok.txt").unlink()
        git(self.eng, "commit", "-q", "-am", "break the suite")
        self.configure(integration_command=f"{sys.executable} check.py")
        self.scan(self.head())
        result = self.release("qualify", "SLICE-001")
        self.assertEqual(result["outcome"], "blocked")
        self.assertIn("suite", result["unresolved_blockers"])
        self.assertTrue((self.eng / ".factory/release" / result["release_id"] / "logs/test-suite.log").is_file())

    def test_a_suite_that_cannot_run_is_not_run(self):
        self.built()
        (self.eng / ".factory/config.json").write_text(json.dumps({"audit": {"commands": {"test": "no-such-runner-xyz"}}}))
        result = self.release("qualify", "SLICE-001")
        self.assertEqual(self.checks(self.readiness(result["release_id"]))["suite"]["status"], "not_run")
        self.assertEqual(result["outcome"], "incomplete")

    def test_failed_verification_and_open_blockers_block(self):
        commit = self.built(verdict="FAIL_WITH_EVIDENCE",
                            blockers=[{"reviewer": "security", "rule": "INV-01", "title": "token logged", "file": "a.py"}])
        self.configure(integration_command=f"{sys.executable} check.py")
        self.scan(commit, [{"id": "X-1", "severity": "high", "title": "bad"}])
        data = self.readiness(self.release("qualify", "SLICE-001", "--release", "r2")["release_id"])
        self.assertEqual(data["outcome"], "blocked")
        self.assertIn("slice.SLICE-001.verification", data["unresolved_blockers"])
        self.assertIn("blocker.SLICE-001.r1.1", data["unresolved_blockers"])
        self.assertIn("security.scan.scanner", data["unresolved_blockers"])
        self.assertEqual(data["security"]["open_review_blockers"][0]["title"], "token logged")

    def test_work_not_integrated_is_not_qualified(self):
        self.first()
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        data = self.readiness(self.release("qualify", "SLICE-001", "--release", "r3")["release_id"])
        self.assertEqual(self.checks(data)["slice.SLICE-001.integrated"]["status"], "fail")
        self.assertEqual(self.checks(data)["slice.SLICE-001.verification"]["status"], "missing")
        self.assertEqual(data["outcome"], "blocked")


class ExceptionTest(Base):
    def test_exceptions_apply_only_at_their_commit(self):
        commit = self.built()
        self.assertEqual(self.release("qualify", "SLICE-001", "--release", "r1")["outcome"], "incomplete")
        for check in ("integration_tests", "security.scan"):
            self.release("except", "--release", "r1", "--check", check, "--by", "release-manager", "--reason", "Accepted for this internal release only.")
        again = self.release("qualify", "SLICE-001", "--release", "r1")
        self.assertEqual(again["outcome"], "qualified_with_exceptions")
        data = self.readiness("r1")
        self.assertEqual(self.checks(data)["security.scan"]["exception"]["by"], "release-manager")
        # The same exception written for another commit does not apply.
        path = self.eng / ".factory/release/r1/exceptions.jsonl"
        forged = [json.loads(line) for line in path.read_text().splitlines()]
        path.write_text("".join(json.dumps({**item, "commit": "f" * 40}) + "\n" for item in forged))
        self.assertEqual(self.release("qualify", "SLICE-001", "--release", "r1")["outcome"], "incomplete")
        self.assertEqual({i["not_applied_because"] for i in self.readiness("r1")["exceptions_not_applied"]}, {"recorded for another commit"})
        self.assertEqual(commit, self.readiness("r1")["release"]["commit"])

    def test_refusals(self):
        self.built()
        self.assertIn("is not known here", self.refused_release("qualify", "--epic", "EPIC-009"))
        self.assertIn("Name an epic", self.refused_release("qualify"))
        self.release("qualify", "SLICE-001", "--release", "r1")
        self.assertIn("names a role", self.refused_release("except", "--release", "r1", "--check", "security.scan", "--by", "Ada Lovelace", "--reason", "because it is fine"))
        self.assertIn("passes", self.refused_release("except", "--release", "r1", "--check", "suite", "--by", "release-manager", "--reason", "because it is fine"))
        self.assertIn("no check", self.refused_release("except", "--release", "r1", "--check", "nope", "--by", "release-manager", "--reason", "because it is fine"))
        self.assertIn("No readiness snapshot", self.refused_release("show", "r9"))
        (self.eng / "ok.txt").write_text("changed\n")
        git(self.eng, "commit", "-q", "-am", "move on")
        self.assertIn("names one commit", self.refused_release("qualify", "SLICE-001", "--release", "r1"))


class ReviewExceptionTest(Base):
    """M12: a security blocker a person excepted in review is listed as excepted, with who and why, never dropped."""

    BLOCKER = {"reviewer": "product", "rule": "REVIEW.md: no secrets in logs", "title": "token logged", "file": "a.py", "class": "security", "impact": "high"}

    def exception(self, **changes):
        item = {"round": "1", "seat": "product", "index": 1, "title": "token logged", "rule": "REVIEW.md: no secrets in logs", "file": "a.py",
                "class": "security", "impact": "high", "by": "Dana Smith", "reason": "Accepted for the internal pilot; fixed in the next slice.",
                "expires": None, "recorded_at": "2026-11-20T10:00:00+00:00"}
        item.update(changes)
        return item

    def qualify(self, **finish):
        commit = self.built(blockers=[self.BLOCKER], **finish)
        self.configure(integration_command=f"{sys.executable} check.py")
        self.scan(commit)
        return self.readiness(self.release("qualify", "SLICE-001", "--release", "r1")["release_id"])

    def test_an_excepted_blocker_makes_the_release_qualified_with_exceptions(self):
        data = self.qualify(exceptions=[self.exception()])
        self.assertEqual(data["outcome"], "qualified_with_exceptions")
        check = self.checks(data)["blocker.SLICE-001.r1.1"]
        self.assertEqual((check["status"], check["kind"]), ("fail", "security"), "excepted, never a pass")
        self.assertEqual((check["exception"]["source"], check["exception"]["by"], check["exception"]["finding"]), ("review", "Dana Smith", "1/product/1"))
        [listed] = data["security"]["open_review_blockers"]
        self.assertEqual((listed["excepted"]["by"], listed["excepted"]["reason"]), ("Dana Smith", "Accepted for the internal pilot; fixed in the next slice."))

    def test_an_expired_review_exception_blocks(self):
        data = self.qualify(exceptions=[self.exception(expires="2026-01-01")])
        self.assertEqual(data["outcome"], "blocked")
        self.assertIn("blocker.SLICE-001.r1.1", data["unresolved_blockers"])
        self.assertEqual(data["security"]["open_review_blockers"][0]["exception_expired"]["expires"], "2026-01-01")

    def test_without_an_exception_it_still_blocks(self):
        data = self.qualify()
        self.assertEqual(data["outcome"], "blocked")
        self.assertTrue(data["security"]["open_review_blockers"][0]["security"], "a security-class blocker from any seat is a security blocker")


class AcceptanceTest(Base):
    """Product's decision, per epic: a comment from a fixed template on the epic's issue, written by Product Studio."""

    def through_issues(self):
        """Product Studio marks SLICE-001 ready as a GitHub issue; the Factory builds it; the release is qualified."""
        self.set_gh(me="ada-pm")
        self.project_and_epic()
        self.drafted()
        number = self.ok(self.a, "slice", "ready", "SLICE-001")["issue"]
        self.set_gh(me="erin-eng")
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        commit = self.finish(str(number))
        self.configure(integration_command=f"{sys.executable} check.py")
        self.scan(commit)
        first = self.release("qualify", "--epic", "EPIC-001", "--release", "r1")
        self.assertEqual((first["outcome"], first["product_acceptance"]), ("qualified", "not_recorded"))
        self.set_gh(me="ada-pm")
        return commit, str(self.eng / ".factory/release/r1/readiness.json")

    def test_acceptance_is_recorded_on_the_epic_and_read_never_inferred(self):
        commit, readiness = self.through_issues()
        base = ("acceptance", "record", "EPIC-001", "--release", "r1", "--commit", commit)
        self.assertIn("readiness snapshot", self.studio_refused(self.a, *base, "--decision", "accepted"))
        self.assertIn("not for release", self.studio_refused(self.a, "acceptance", "record", "EPIC-001", "--release", "r2", "--commit", commit,
                                                       "--decision", "accepted", "--readiness", readiness))
        recorded = self.ok(self.a, *base, "--decision", "accepted", "--readiness", readiness)
        self.assertEqual((recorded["decision"], recorded["factory_authorized"]), ("accepted", False))
        epic = next(i for i in self.gh()["issues"].values() if "mach:epic" in [l["name"] for l in i["labels"]])
        self.assertTrue(epic["comments"][-1]["body"].startswith(f"Product decision recorded in MACH Product Studio by ada-pm: release r1 at commit {commit[:12]} is accepted for EPIC-001."))
        self.assertEqual(self.ok(self.a, *base, "--decision", "accepted", "--readiness", readiness)["already_recorded"], True)  # never twice
        self.set_gh(me="erin-eng")
        again = self.release("qualify", "--epic", "EPIC-001", "--release", "r1", "--commit", commit)
        self.assertEqual((again["outcome"], again["product_acceptance"]), ("qualified", "accepted"))
        data = self.readiness("r1")
        self.assertEqual((data["product_acceptance"]["by"], data["scope"]["epic"]["epic_id"]), ("ada-pm", "EPIC-001"))

    def test_an_edited_or_forged_decision_does_not_count(self):
        commit, readiness = self.through_issues()
        self.ok(self.a, "acceptance", "record", "EPIC-001", "--release", "r1", "--commit", commit, "--decision", "accepted", "--readiness", readiness)
        state = self.gh()
        epic = next(i for i in state["issues"].values() if "mach:epic" in [l["name"] for l in i["labels"]])
        epic["comments"][-1]["updated_at"] = "2026-11-19T00:00:00Z"
        epic["comments"].append({**epic["comments"][-1], "login": "mallory", "id": 6666, "updated_at": epic["comments"][-1]["created_at"]})
        self.gh_state.write_text(json.dumps(state))
        self.set_gh(me="erin-eng")
        again = self.release("qualify", "--epic", "EPIC-001", "--release", "r1", "--commit", commit)
        self.assertEqual(again["product_acceptance"], "not_recorded")
        ignored = {item["why"] for item in self.readiness("r1")["product_acceptance"]["ignored"]}
        self.assertEqual(ignored, {"it was edited after it was written", "it was not written by the account it names"})

    def test_an_unqualified_release_can_only_be_rejected(self):
        self.set_gh(me="ada-pm")
        self.project_and_epic()
        self.drafted()
        number = self.ok(self.a, "slice", "ready", "SLICE-001")["issue"]
        self.set_gh(me="erin-eng")
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        commit = self.finish(str(number))
        self.assertEqual(self.release("qualify", "--epic", "EPIC-001", "--release", "r1")["outcome"], "incomplete")
        self.set_gh(me="ada-pm")
        base = ("acceptance", "record", "EPIC-001", "--release", "r1", "--commit", commit, "--readiness", str(self.eng / ".factory/release/r1/readiness.json"))
        self.assertIn("incomplete", self.studio_refused(self.a, *base, "--decision", "accepted"))
        self.assertEqual(self.ok(self.a, *base, "--decision", "rejected")["decision"], "rejected")

    def test_a_list_of_slices_has_no_product_acceptance(self):
        self.built()
        data = self.readiness(self.release("qualify", "SLICE-001", "--release", "r1")["release_id"])
        self.assertEqual(data["product_acceptance"]["reason"], "Product acceptance is recorded per epic; this release names slices.")


class ContractTest(Base):
    """D2: a contract shared by slices is judged against the latest reviewed change to it."""

    def two_slices(self):
        self.built(contract=("proto/api.yaml", "version: 1\n"))
        second = self.slice(self.a, "Second")
        self.publish(self.a, second)
        self.product("intake")
        self.product("dispatch", second)
        self.finish("LOCAL-002", contract=("proto/api.yaml", "version: 2\n"))

    def contract_checks(self, *slices):
        data = self.readiness(self.release("qualify", *slices)["release_id"])
        return data, {c["id"]: c for c in data["checks"] if c["id"].startswith("contract.")}

    def test_a_later_reviewed_change_supersedes_an_earlier_one(self):
        self.two_slices()
        data, checks = self.contract_checks("SLICE-001", "SLICE-002")
        first, second = checks["contract.SLICE-001.proto/api.yaml"], checks["contract.SLICE-002.proto/api.yaml"]
        self.assertEqual((first["status"], second["status"]), ("pass", "pass"))
        self.assertIn("Superseded by SLICE-002", first["detail"])
        self.assertEqual(data["slices"][0]["contracts"][0]["superseded_by"], "SLICE-002")
        self.assertNotIn("contract.SLICE-001.proto/api.yaml", data["unresolved_blockers"] + data["incomplete"])

    def test_a_change_outside_review_fails(self):
        self.two_slices()
        (self.eng / "proto/api.yaml").write_text("version: 3\n")
        git(self.eng, "commit", "-q", "-am", "edit the contract by hand")
        data, checks = self.contract_checks("SLICE-001", "SLICE-002")
        self.assertEqual({c["status"] for c in checks.values()}, {"fail"})
        self.assertIn("changed outside review", checks["contract.SLICE-002.proto/api.yaml"]["detail"])
        self.assertEqual(data["outcome"], "blocked")

    def test_a_change_from_outside_the_release_is_incomplete(self):
        self.two_slices()
        data, checks = self.contract_checks("SLICE-001")
        check = checks["contract.SLICE-001.proto/api.yaml"]
        self.assertEqual(check["status"], "missing")
        self.assertIn("SLICE-002 (LOCAL-002) outside this release", check["detail"])
        self.assertIn("contract.SLICE-001.proto/api.yaml", data["incomplete"])

    def test_a_missing_review_record_is_missing(self):
        self.two_slices()
        runs = self.eng / ".factory/archive/runs.jsonl"
        lines = [json.loads(line) for line in runs.read_text().splitlines()]
        lines[0]["integration"]["approved_commit"] = "0" * 40
        runs.write_text("".join(json.dumps(line) + "\n" for line in lines))
        _, checks = self.contract_checks("SLICE-001", "SLICE-002")
        self.assertEqual(checks["contract.SLICE-001.proto/api.yaml"]["status"], "missing")


class GuardTest(unittest.TestCase):
    def test_it_lands_publishes_and_starts_nothing(self):
        source = QUALIFY.read_text()
        used = set(re.findall(r"_git(?:_bytes)?\(\"([a-z-]+)\"", source))
        self.assertEqual(used, {"merge-base", "show", "rev-parse", "archive", "ls-tree"})
        self.assertEqual(len(re.findall(r"subprocess\.run\(", source)), 2)  # only the two read-only Git helpers
        for word in ('"push"', '"tag"', '"merge"', '"checkout"', '"fetch"', '"worktree"', "deploy", "Popen", "os.system", "slice-status", '"comment"',
                     "claude", "Workflow", "runner.json", "read_local_policy", "factory_started\": True"):
            self.assertNotIn(word, source, word)

    def test_no_station_agent_or_workflow_calls_it(self):
        allowed = {ROOT / "skills/run/scripts/qualify.py", ROOT / "skills/run/scripts/run.py", ROOT / "skills/run/SKILL.md"}
        found = []
        for top in ("skills", "agents", "workflows", "templates", "bin"):
            for path in sorted((ROOT / top).rglob("*")):
                if path.is_file() and "__pycache__" not in path.parts and path not in allowed:
                    text = path.read_text(encoding="utf-8", errors="ignore")
                    found += [f"{path.relative_to(ROOT)}: {word}" for word in ("qualify", "readiness.json", "release except") if word in text]
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main()
