"""Release qualification (run.py release ...) and product acceptance (Product Studio's acceptance record).

Each test hands a slice over as Product Studio does (a ready folder on the shared branch, or a slice
issue), has an "engineer" take it in, dispatch it and merge the ticket's branch, and leaves the
archive the cleanup station would leave. Verdicts are written as the verification and review stations record them:
simulated station records, real Git, a real rerun of the project's suite.
"""

import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "merge" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "ticket" / "scripts"))
import change_record  # noqa: E402
import issue_rules  # noqa: E402
import merge  # noqa: E402
import run  # noqa: E402
from test_mach_product_intake import Base as IntakeBase, git  # noqa: E402
from test_mach_product_issues import ADDRESS  # noqa: E402
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

    def finish(self, ticket_id="LOCAL-001", verdict="PASS", outcome="APPROVED", blockers=(), contract=None, exceptions=None, human_required=False):
        """The ticket goes through the line: verified and reviewed in its cell, its change record committed on its branch by the
        merge station's own code, merged into main, then archived as the cleanup station would.
        With `contract` (path, text), the slice's plan names that contract and its build writes it."""
        cell_dir = self.eng / ".factory/worktrees" / ticket_id
        repo = cell_dir / "repo"
        if contract:
            path, text = contract
            target = repo / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
            self.set_cell(ticket_id, contracts=[path])
        (repo / f"t{ticket_id.lower()}.py").write_text("print('built')\n")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", f"build {ticket_id}")
        approved = git(repo, "rev-parse", "HEAD").strip()
        evidence = {f"ac-{n}.log": f"AC-0{n} proven\n".encode() for n in (1, 2, 3)}
        summary = {"status": verdict, "head": approved, "checks": {f"AC-0{n}": {"kind": "scenario", "result": "pass", "note": None, "evidence": [f"ac-{n}.log"]} for n in (1, 2, 3)},
                   "evidence_files": [{"file": name, "sha256": hashlib.sha256(data).hexdigest()} for name, data in evidence.items()]}
        decision = {"outcome": outcome, "head": approved, "round": 1, "risk": "Medium", "blockers": len(blockers), "human_approval_required": human_required, "human_approval": None}
        if exceptions is not None:
            decision["exceptions"] = [{**item, "head": approved} for item in exceptions]
        (cell_dir / "evidence").mkdir(exist_ok=True)
        (cell_dir / "review/round-1/votes").mkdir(parents=True, exist_ok=True)
        (cell_dir / "evidence/summary.json").write_text(json.dumps(summary))
        for name, data in evidence.items():
            (cell_dir / "evidence" / name).write_bytes(data)
        (cell_dir / "review/decision.json").write_text(json.dumps(decision))
        (cell_dir / "review/round-1/decision.json").write_text(json.dumps(decision))
        seats = {}
        for blocker in blockers:
            seats.setdefault(blocker["reviewer"], []).append({"severity": "blocker", **{key: value for key, value in blocker.items() if key != "reviewer"}})
        for seat, findings in seats.items():
            (cell_dir / "review/round-1/votes" / f"{seat}.json").write_text(json.dumps({"reviewer": seat, "vote": "REJECT", "findings": findings}))
        record_commit = self.record(ticket_id, approved)
        git(self.eng, "merge", "-q", "--no-ff", "-m", f"Merge feature/{ticket_id}", f"feature/{ticket_id}")
        merge_commit = self.head()
        self.set_cell(ticket_id, stage="merged", merged={"commit": merge_commit, "landed_commit": record_commit, "method": "local"})
        archive = self.eng / ".factory/archive"
        archive.mkdir(exist_ok=True)
        name, number = archive / f"{ticket_id}.tar.gz", 1
        while name.exists():
            name, number = archive / f"{ticket_id}-{number}.tar.gz", number + 1
        with tempfile.TemporaryDirectory() as folder:
            staged = Path(folder) / ticket_id
            staged.mkdir()
            for part in ("cell.json", "evidence", "review"):
                (shutil.copytree if (cell_dir / part).is_dir() else shutil.copy)(cell_dir / part, staged / part)
            with tarfile.open(str(name), "w:gz") as tar:
                tar.add(str(staged), arcname=ticket_id)
        run_record = {"record_version": 2, "ticket_id": ticket_id, "outcome": "merged", "archive": str(name.relative_to(self.eng)),
                      "integration": {"approved_commit": approved, "landed_commit": record_commit, "merge_commit": merge_commit, "method": "local"},
                      "blockers": [{"round": 1, **b} for b in blockers]}
        with (archive / "runs.jsonl").open("a") as handle:
            handle.write(json.dumps(run_record) + "\n")
        git(self.eng, "worktree", "remove", "--force", str(repo))
        git(self.eng, "branch", "-D", f"feature/{ticket_id}")
        shutil.rmtree(cell_dir)
        return merge_commit

    def record(self, ticket_id, approved):
        """The change record, written and committed alone on the ticket's branch with the merge station's own functions."""
        cell_dir = self.eng / ".factory/worktrees" / ticket_id
        repo = cell_dir / "repo"
        info = json.loads((cell_dir / "cell.json").read_text())
        path = change_record.path_for("docs/changes", ticket_id, lambda candidate: (repo / candidate).exists())
        text = change_record.render(cell_dir, info, ticket_id, {"approved": approved, "revalidated": None, "onto": None, "base": approved}, issue_rules,
                                    spec_sha256=merge.approved_spec_sha(types.SimpleNamespace(info=info, work=repo), approved))
        (repo / path).parent.mkdir(parents=True, exist_ok=True)
        (repo / path).write_text(text, encoding="utf-8")
        git(repo, "add", "--", path)
        git(repo, "commit", "-q", "-m", f"Change record for {ticket_id}")
        return git(repo, "rev-parse", "HEAD").strip()

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
        self.assertEqual((data["schema_version"], data["scope"]), (3, {"epic": None, "slices": ["SLICE-001"], "issues_not_taken_in": []}))
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
                            blockers=[{"reviewer": "security", "rule": "INV-01", "title": "retries are unbounded", "file": "a.py"}])
        self.configure(integration_command=f"{sys.executable} check.py")
        self.scan(commit, [{"id": "X-1", "severity": "high", "title": "bad"}])
        data = self.readiness(self.release("qualify", "SLICE-001", "--release", "r2")["release_id"])
        self.assertEqual(data["outcome"], "blocked")
        self.assertIn("slice.SLICE-001.verification", data["unresolved_blockers"])
        self.assertIn("blocker.SLICE-001.r1.1", data["unresolved_blockers"])
        self.assertIn("security.scan.scanner", data["unresolved_blockers"])
        self.assertEqual(data["security"]["open_review_blockers"][0]["title"], "retries are unbounded")

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

    def test_the_latest_change_is_found_by_its_change_record_alone(self):
        self.two_slices()
        shutil.rmtree(self.eng / ".factory/archive")  # as on a machine that built neither slice
        _, checks = self.contract_checks("SLICE-001")
        self.assertIn("SLICE-002 (LOCAL-002) outside this release", checks["contract.SLICE-001.proto/api.yaml"]["detail"])


class RecordTest(Base):
    """A6: a slice's execution is read from the change record on the branch, and only from one that is bound to its commit and its spec."""

    def qualified(self):
        commit = self.built()
        self.configure(integration_command=f"{sys.executable} check.py")
        self.scan(commit)
        self.assertEqual(self.release("qualify", "SLICE-001", "--release", "r1")["outcome"], "qualified")
        return commit

    def again(self, release_id):
        self.scan(self.head())
        result = self.release("qualify", "SLICE-001", "--release", release_id)
        return result, self.checks(self.readiness(release_id))

    def test_the_snapshot_names_the_record_and_where_the_evidence_was_checked(self):
        self.qualified()
        row = self.readiness("r1")["slices"][0]
        record = self.eng / "docs/changes/LOCAL-001.md"
        self.assertEqual((row["change_record"]["path"], row["change_record"]["sha256"]), ("docs/changes/LOCAL-001.md", hashlib.sha256(record.read_bytes()).hexdigest()))
        self.assertEqual((row["verification"]["source"], row["review"]["source"], row["integration"]["recorded_in"]), ("docs/changes/LOCAL-001.md",) * 3)
        self.assertNotIn(".factory/archive", json.dumps(self.readiness("r1")), "the decision names nothing that only this machine holds")
        run_file = json.loads((self.eng / ".factory/release/r1/run.json").read_text())
        self.assertEqual(run_file["evidence_files"], {"checked_in_this_machines_archive": 3, "held_on_another_machine": 0})

    def test_a_record_edited_after_it_landed_does_not_count(self):
        self.qualified()
        record = self.eng / "docs/changes/LOCAL-001.md"
        record.write_text(record.read_text().replace('"risk": "Medium"', '"risk": "Low"'))
        git(self.eng, "commit", "-q", "-am", "tidy the record")
        result, checks = self.again("r2")
        self.assertEqual(result["outcome"], "blocked")
        self.assertEqual(checks["slice.SLICE-001.integrated"]["status"], "fail")
        self.assertIn("changed after it landed", checks["slice.SLICE-001.integrated"]["detail"])
        self.assertEqual((checks["slice.SLICE-001.verification"]["status"], checks["slice.SLICE-001.review"]["status"]), ("missing", "missing"))
        self.assertEqual(self.readiness("r2")["slices"][0]["verification"]["verdict"], None, "nothing is read from a record that does not count")

    def test_a_record_put_on_the_branch_by_hand_does_not_count(self):
        self.qualified()
        record = self.eng / "docs/changes/LOCAL-001.md"
        text = record.read_text()
        git(self.eng, "rm", "-q", "docs/changes/LOCAL-001.md")
        git(self.eng, "commit", "-q", "-m", "drop the record")
        record.parent.mkdir(parents=True, exist_ok=True)
        record.write_text(text)
        git(self.eng, "add", "docs/changes/LOCAL-001.md")
        git(self.eng, "commit", "-q", "-m", "put the same record back")
        result, checks = self.again("r2")
        self.assertEqual((result["outcome"], checks["slice.SLICE-001.integrated"]["status"]), ("blocked", "fail"))

    def test_a_record_does_not_count_for_a_spec_changed_after_it(self):
        self.qualified()
        spec = next((self.eng / "specs/slices").glob("SLICE-001-*.md"))
        spec.write_text(spec.read_text() + "\nOne more rule, added on main.\n")
        git(self.eng, "commit", "-q", "-am", "change the spec by hand")
        result, checks = self.again("r2")
        self.assertEqual((result["outcome"], checks["slice.SLICE-001.ticket"]["status"]), ("blocked", "fail"))
        self.assertIn("not the one a change record on the branch was written for", checks["slice.SLICE-001.ticket"]["detail"])

    def test_a_file_that_is_not_a_record_with_facts_is_passed_over(self):
        commit = self.built()
        (self.eng / "docs/changes/NOTES.md").write_text("# Notes\n\n" + change_record.FACTS_MARK + "\n```json\n{\"version\": 1}\n```\n")
        git(self.eng, "add", "docs/changes/NOTES.md")
        git(self.eng, "commit", "-q", "-m", "a note among the records")
        self.configure(integration_command=f"{sys.executable} check.py")
        self.scan(self.head())
        self.assertEqual(self.release("qualify", "SLICE-001", "--release", "r1")["outcome"], "qualified")
        self.assertNotEqual(commit, self.head())

    def test_an_evidence_file_held_here_that_differs_is_not_shown(self):
        self.qualified()
        archive = self.eng / ".factory/archive/LOCAL-001.tar.gz"
        with tempfile.TemporaryDirectory() as folder:
            with tarfile.open(str(archive)) as tar:
                tar.extractall(folder, **({"filter": "data"} if hasattr(tarfile, "data_filter") else {}))
            (Path(folder) / "LOCAL-001/evidence/ac-2.log").write_text("something else\n")
            with tarfile.open(str(archive), "w:gz") as tar:
                tar.add(str(Path(folder) / "LOCAL-001"), arcname="LOCAL-001")
        result, checks = self.again("r1")
        self.assertEqual(result["outcome"], "incomplete")
        self.assertEqual((checks["scenario.SLICE-001.AC-01"]["status"], checks["scenario.SLICE-001.AC-02"]["status"]), ("pass", "missing"))
        self.assertIn("differs from the SHA-256 the change record names", checks["scenario.SLICE-001.AC-02"]["detail"])

    def test_a_persons_approval_that_was_required_and_not_given_fails(self):
        commit = self.built(human_required=True)
        self.configure(integration_command=f"{sys.executable} check.py")
        self.scan(commit)
        data = self.readiness(self.release("qualify", "SLICE-001", "--release", "r1")["release_id"])
        self.assertEqual(self.checks(data)["slice.SLICE-001.review"]["detail"], "Review required a person's approval and none is recorded.")


class AcrossMachinesTest(Base):
    """A6: the slices of one epic built by two Factories on two machines, qualified and accepted from a third that built neither."""

    def machine(self, name):
        """A fresh clone of the shared repository set up as a Factory, as on another engineer's machine. It becomes self.eng."""
        folder = self.root / name
        subprocess.run(["git", "clone", "-q", str(self.origin), str(folder)], check=True, capture_output=True)
        git(folder, "remote", "set-url", "origin", ADDRESS)
        git(folder, "config", f"url.{self.origin}.insteadOf", ADDRESS)
        for key in ("user.name", "user.email"):
            value = subprocess.run(["git", "config", key], cwd=str(self.eng), capture_output=True, text=True).stdout.strip()
            if value:
                git(folder, "config", key, value)
        (folder / ".factory").mkdir()
        self.eng = folder
        self.configure(integration_command=f"{sys.executable} check.py")
        return folder

    def test_an_epic_built_on_two_machines_is_qualified_and_accepted_from_a_third(self):
        self.set_gh(me="ada-pm")
        self.project_and_epic()
        first = self.drafted()
        second = self.drafted(title="Remove a teammate", depends=[first])
        numbers = {name: self.ok(self.a, "slice", "ready", name)["issue"] for name in (first, second)}
        self.set_gh(me="erin-eng")

        self.product("intake")  # machine one builds the first slice
        self.product("dispatch", first)
        self.finish(str(numbers[first]))
        git(self.eng, "push", "-q", "origin", "main")
        one = self.eng

        two = self.machine("machine-two")  # machine two builds the second, which depends on the first
        self.product("intake")
        self.product("dispatch", second)
        commit = self.finish(str(numbers[second]))
        git(self.eng, "push", "-q", "origin", "main")

        three = self.machine("machine-three")  # machine three built nothing and took nothing in
        self.assertFalse((three / ".factory/archive").exists() or (three / ".factory/intake").exists())
        outcomes, statuses = {}, {}
        for name, folder in (("one", one), ("two", two), ("three", three)):
            self.eng = folder
            if folder is one:
                git(folder, "pull", "-q", "--ff-only")
                self.configure(integration_command=f"{sys.executable} check.py")
            self.assertEqual(self.head(), commit)
            self.scan(commit)
            result = self.release("qualify", "--epic", "EPIC-001", "--release", "r1")
            outcomes[name] = (result["outcome"], result["outcome_summary"], result["evidence_files"])
            statuses[name] = {key: (item["status"], item["detail"]) for key, item in self.checks(self.readiness("r1")).items()}
        self.assertEqual(outcomes["three"][:2], ("qualified", "qualified; not assessed: performance (not configured)"))
        self.assertEqual(outcomes["three"][2], {"checked_in_this_machines_archive": 0, "held_on_another_machine": 6})
        self.assertEqual(outcomes["one"][2], {"checked_in_this_machines_archive": 3, "held_on_another_machine": 3})
        self.assertEqual((outcomes["one"][:2], outcomes["two"][:2]), (outcomes["three"][:2],) * 2)
        self.assertEqual((statuses["one"], statuses["two"]), (statuses["three"],) * 2, "every check, and what it says, is the same on each machine")
        self.assertEqual(statuses["three"][f"dependency.{second}.{first}"][0], "pass")
        rows = {row["slice_id"]: row for row in self.readiness("r1")["slices"]}
        self.assertEqual({key: (row["ticket_id"], row["verification"]["verdict"], row["review"]["decision"]) for key, row in rows.items()},
                         {first: (str(numbers[first]), "PASS", "APPROVED"), second: (str(numbers[second]), "PASS", "APPROVED")})

        # Product accepts from the snapshot machine three made, and machine three reads the decision back.
        self.set_gh(me="ada-pm")
        recorded = self.ok(self.a, "acceptance", "record", "EPIC-001", "--release", "r1", "--commit", commit, "--decision", "accepted",
                           "--readiness", str(three / ".factory/release/r1/readiness.json"))
        self.assertEqual(recorded["decision"], "accepted")
        self.set_gh(me="erin-eng")
        self.assertEqual(self.release("qualify", "--epic", "EPIC-001", "--release", "r1")["product_acceptance"], "accepted")


class GuardTest(unittest.TestCase):
    def test_it_lands_publishes_and_starts_nothing(self):
        source = QUALIFY.read_text()
        used = set(re.findall(r"_git(?:_bytes)?\(\"([a-z-]+)\"", source))
        self.assertEqual(used, {"merge-base", "show", "rev-parse", "archive", "ls-tree", "log", "rev-list"})  # every one reads only
        self.assertEqual(len(re.findall(r"subprocess\.run\(", source)), 2)  # only the two read-only Git helpers
        for word in ('"push"', '"tag"', '_git("merge"', '"checkout"', '"fetch"', '"worktree"', "deploy", "Popen", "os.system", "slice-status", '"comment"', '"commit", "-', '"add"',
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
