"""Factory evals (M14 part B): cases from archives, the status digests, the plan, a confined replay, compare, and the tuning packet.

Claude Code is replaced by a stand-in program on the PATH, as in the supervisor's tests: no real model, Factory or
supervisor is ever started. The stand-in records how it was called and where, tries to push, and writes the cell files a
station would, so the eval's reading of a replay is tested without a model.
"""

import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "observe" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "review" / "scripts"))
import adr_baseline_fixture  # noqa: E402
import evals  # noqa: E402
import policy  # noqa: E402
import review  # noqa: E402
import run  # noqa: E402
from test_build import INTENT, SPEC, SPEC_NAME  # noqa: E402

FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
argv = sys.argv[1:]
scenario = json.load(open("@@SCENARIO@@"))
if argv == ["--help"]:
    flags = ["--add-dir", "--allowedTools", "--disallowedTools", "--max-budget-usd", "--output-format", "--permission-mode", "--permission-prompts",
             "--plugin-dir", "--restricted", "--session-id", "--strict-mcp-config", "--tools", "--verbose"]
    if scenario.get("help") == "old":
        flags.remove("--restricted")
    print("Options:\n" + "\n".join("  " + flag + " <x>  what it does" for flag in flags))
    sys.exit(0)
ledger = json.load(open(os.path.join(".factory", "intake", "ledger.json")))
record = next(iter(ledger["supervisor"]["executions"].values()))
ticket, case = record["ticket_id"], record["eval_case"]
plan = scenario.get("cases", {}).get(case, scenario.get("default", {}))
remote = subprocess.run(["git", "remote"], capture_output=True, text=True).stdout.strip()
push = subprocess.run(["git", "push", "@@PROJECT@@", "HEAD:refs/heads/from-eval"], capture_output=True, text=True).returncode
with open("@@LOG@@", "a") as log:
    log.write(json.dumps({"argv": argv, "cwd": os.getcwd(), "env": dict(os.environ), "remote": remote, "push": push, "case": case, "ticket": ticket}) + "\n")
cell = os.path.join(".factory", "worktrees", ticket)
info = json.load(open(os.path.join(cell, "cell.json")))
if plan.get("planned", True):
    open(os.path.join(cell, "plan.md"), "w").write("# Plan\n")
    info["stage"] = "planned"
if plan.get("built", True):
    json.dump({"status": "BUILT", "review_loop": plan.get("loop", 0), "deviations": [{"type": "scope", "task": "T02"}] * plan.get("deviations", 0)},
              open(os.path.join(cell, "build-report.json"), "w"))
    info["stage"] = "built"
if plan.get("verdict"):
    os.makedirs(os.path.join(cell, "evidence"), exist_ok=True)
    json.dump({"status": plan["verdict"]}, open(os.path.join(cell, "evidence", "summary.json"), "w"))
    info["stage"] = "verified" if plan["verdict"] == "PASS" else "built"
json.dump(info, open(os.path.join(cell, "cell.json"), "w"))
print(json.dumps({"type": "system", "subtype": "init", "session_id": argv[argv.index("--session-id") + 1]}), flush=True)
cost = plan.get("cost", 0.75)
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "session_id": argv[argv.index("--session-id") + 1],
                  "total_cost_usd": cost, "permission_denials": [],
                  "result": json.dumps({"tickets": [{"ticket": ticket, "outcome": "stopped", "stage": info["stage"], "waiting_for": "a person: stopped before review, as asked"}]})}))
'''


def git(folder, *args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    return subprocess.run(["git", *args], cwd=str(folder), capture_output=True, text=True, env=env)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.top = Path(self.tmp.name).resolve()
        self.project = self.top / "project"
        self.project.mkdir()
        self.put({".gitignore": ".factory/\n__pycache__/\n", "README.md": "# Sample\n", "app/__init__.py": "", "CLAUDE.md": "# Rules\n", "REVIEW.md": "# Review\n",
                  "tests/test_base.py": "import unittest\n\nclass B(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n",
                  **adr_baseline_fixture.files()})
        git(self.project, "init", "-q", "-b", "main")
        for key, value in (("user.name", "t"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")):
            git(self.project, "config", key, value)
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "start")
        self.base = git(self.project, "rev-parse", "HEAD").stdout.strip()
        # A ticket's branch: the spec commit, a build commit, merged with a merge commit, then the branch removed.
        git(self.project, "checkout", "-q", "-b", "feature/LOCAL-001")
        self.put({f"specs/slices/{SPEC_NAME}": SPEC})
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "spec")
        self.spec_commit = git(self.project, "rev-parse", "HEAD").stdout.strip()
        self.put({"app/invite.py": "def invite(email):\n    return 'sent'\n"})
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "build")
        git(self.project, "checkout", "-q", "main")
        self.put({"docs/notes.md": "main moved on\n"})
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "main moved")
        git(self.project, "merge", "-q", "--no-ff", "-m", "merge LOCAL-001", "feature/LOCAL-001")
        self.merge = git(self.project, "rev-parse", "HEAD").stdout.strip()
        git(self.project, "branch", "-q", "-D", "feature/LOCAL-001")
        self.put({".factory/config.json": json.dumps({"tickets": {"provider": "local", "local_prefix": "LOCAL"},
                                                      "models": {"planning": "fable", "contracts": "opus", "build": "sonnet", "utility": "haiku"},
                                                      "merge": {"mode": "auto"}, "records": {"publish_command": ["true"]}})})
        self.archive("LOCAL-001")
        self.runs([{"record_version": 2, "ticket_id": "LOCAL-001", "outcome": "merged", "rounds": 1, "first_pass": True, "verify_failures": 0, "review_rejections": 0,
                    "deviations": [{"type": "scope", "task": "T02", "detail": "touched README for ann@example.com"}], "title": "Invite a teammate (ask ann@example.com)",
                    "integration": {"merge_commit": self.merge}, "archive": ".factory/archive/LOCAL-001.tar.gz", "closed_at": "2026-11-01T10:00:00+00:00"},
                   {"record_version": 2, "ticket_id": "LOCAL-002", "outcome": "abandoned", "archive": ".factory/archive/LOCAL-002.tar.gz"}])
        # The stand-in Claude Code.
        self.bin = self.top / "bin"
        self.bin.mkdir()
        self.scenario = self.top / "scenario.json"
        self.log = self.top / "claude.log"
        self.claude({"default": {"verdict": "PASS"}})
        fake = self.bin / "claude"
        fake.write_text(FAKE_CLAUDE.replace("#!/usr/bin/env python3", "#!" + sys.executable, 1).replace("@@SCENARIO@@", str(self.scenario))
                        .replace("@@LOG@@", str(self.log)).replace("@@PROJECT@@", str(self.project)))
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        saved = {name: os.environ.get(name) for name in ("PATH", "GH_TOKEN", evals.EXECUTION_ENV)}
        self.addCleanup(lambda: [os.environ.pop(name, None) if value is None else os.environ.__setitem__(name, value) for name, value in saved.items()])
        os.environ["PATH"] = str(self.bin) + os.pathsep + os.environ.get("PATH", "")
        os.environ["GH_TOKEN"] = "ghp_" + "x" * 36
        os.environ.pop(evals.EXECUTION_ENV, None)
        self.before = self.checkout()

    # ---- helpers ----

    def put(self, files):
        for name, text in files.items():
            path = self.project / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")

    def archive(self, ticket, spec=SPEC):
        folder = self.project / ".factory" / "archive"
        folder.mkdir(parents=True, exist_ok=True)
        members = {
            "cell.json": json.dumps({"ticket_id": ticket, "slice_id": "SLICE-001", "spec_path": f"specs/slices/{SPEC_NAME}", "spec_commit": self.spec_commit,
                                     "risk": "Medium", "app_type": "library", "stage": "merged", "title": "Invite teammates"}).encode(),
            "spec.md": spec.encode(), "intent.md": INTENT.encode(),
            "spec.json": json.dumps({"slice_id": "SLICE-001", "owner": "ann@example.com"}).encode(),
            "build.json": json.dumps({"tasks": [{"id": "T01", "tests_first_run": {"failed": ["tests.test_invite.T.test_invite"], "passed": []}}]}).encode(),
            "build-report.json": json.dumps({"test_files": ["tests/test_invite.py"], "review_loop": 0, "deviations": []}).encode(),
            "evidence/summary.json": json.dumps({"status": "PASS"}).encode(),
            "evidence/capture.png": b"\x89PNG\r\n\x1a\nnot really",
            "lifecycle.jsonl": b"{}\n",
        }
        with tarfile.open(str(folder / f"{ticket}.tar.gz"), "w:gz") as tar:
            for name, data in members.items():
                info = tarfile.TarInfo(f"{ticket}/{name}")
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))

    def runs(self, records):
        path = self.project / ".factory" / "archive" / "runs.jsonl"
        path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")

    def claude(self, scenario):
        self.scenario.write_text(json.dumps(scenario))

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def checkout(self):
        return (git(self.project, "status", "--porcelain").stdout, git(self.project, "rev-parse", "HEAD").stdout,
                git(self.project, "for-each-ref", "--format=%(refname) %(objectname)").stdout, git(self.project, "remote").stdout)

    def call(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.project), "eval", *argv])
        return code, out.getvalue(), err.getvalue()

    def ok(self, *argv):
        code, out, err = self.call(*argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def refused(self, *argv):
        code, out, err = self.call(*argv)
        self.assertEqual(code, 1, out)
        return err

    def planned(self, *extra, budget="10"):
        return self.ok("run", "--plan", "--budget", budget, *extra)

    def confirmed(self, *extra, budget="10", plan_args=()):
        plan = self.planned(*plan_args, budget=budget)
        return self.ok("run", "--confirm", plan["confirm_with"], "--accept-execution-risk", *extra)

    def eval_temp_folders(self):
        return sorted(path for path in Path(tempfile.gettempdir()).resolve().glob(evals.CLONE_PREFIX + "*") if path.name.startswith(evals.CLONE_PREFIX))


class CaseTest(Base):
    def test_collect_makes_a_redacted_case_from_a_merged_ticket_only(self):
        found = self.ok("collect")
        self.assertEqual([item["case_id"] for item in found["collected"]], ["LOCAL-001"])
        self.assertEqual(found["not_collected"][0]["ticket_id"], "LOCAL-002")
        folder = self.project / ".factory/evals/cases/LOCAL-001"
        self.assertEqual(sorted(path.name for path in folder.iterdir()), ["case.json", "intent.md", "spec.json", "spec.md"])  # never evidence media
        case = json.loads((folder / "case.json").read_text())
        self.assertEqual(case["schema"], 1)
        self.assertEqual(case["base_commit"], self.base)  # where the branch left main, not main as it was at the merge
        self.assertEqual(case["recorded"]["verdict"], "PASS")
        self.assertEqual(case["recorded"]["rounds"], 1)
        self.assertEqual(case["recorded"]["tests"], {"files": ["tests/test_invite.py"], "names": ["tests.test_invite.T.test_invite"]})
        self.assertEqual(case["recorded"]["deviations"], [{"type": "scope", "task": "T02"}])  # no prose detail
        self.assertNotIn("ann@example.com", (folder / "case.json").read_text() + (folder / "spec.json").read_text())
        self.assertTrue(case["redaction"]["changed_something"])
        self.assertEqual(case["spec"]["name"], SPEC_NAME)
        self.assertFalse(case["must_pass"])
        self.assertEqual(self.ok("collect")["already_cases"], [{"ticket_id": "LOCAL-001", "case_id": "LOCAL-001"}])

    def test_a_squashed_or_fast_forwarded_ticket_starts_from_the_spec_commits_parent(self):
        records = [json.loads(line) for line in (self.project / ".factory/archive/runs.jsonl").read_text().splitlines()]
        records[0]["integration"] = {"merge_commit": None}
        self.runs(records)
        self.ok("collect")
        case = json.loads((self.project / ".factory/evals/cases/LOCAL-001/case.json").read_text())
        self.assertEqual(case["base_commit"], self.base)
        self.assertEqual(case["base_commit_from"], "the parent of the commit that added the spec")

    def test_an_escaped_defect_becomes_a_must_pass_case_with_a_holdout(self):
        self.assertIn("own words", self.refused("add", "--from-ticket", "LOCAL-001", "--reason", "bad"))
        self.assertIn("abandoned", self.refused("add", "--from-ticket", "LOCAL-002", "--reason", "a defect that escaped review"))
        added = self.ok("add", "--from-ticket", "LOCAL-001", "--reason", "Inviting the same address twice sends two emails (mail bob@example.com)", "--must-pass")
        self.assertEqual((added["kind"], added["must_pass"]), ("escaped-defect", True))
        folder = self.project / ".factory/evals/cases/LOCAL-001"
        self.assertIn("sends two emails", (folder / "holdout.md").read_text())
        self.assertNotIn("bob@example.com", (folder / "holdout.md").read_text())
        self.assertEqual(self.ok("add", "--case", "LOCAL-001", "--no-must-pass"), {"case_id": "LOCAL-001", "must_pass": False})
        self.assertEqual(self.ok("collect")["already_cases"][0]["case_id"], "LOCAL-001")  # still one case for the ticket

    def test_a_case_by_hand_needs_a_spec_name_and_a_real_base(self):
        spec = self.top / SPEC_NAME
        spec.write_text(SPEC)
        self.assertIn("not a commit", self.refused("add", "--spec", str(spec), "--base", "nope", "--reason", "kept for the invite flow"))
        added = self.ok("add", "--spec", str(spec), "--base", self.base, "--reason", "kept for the invite flow")
        self.assertEqual(added["case_id"], "hand-slice-001")
        case = json.loads((self.project / ".factory/evals/cases/hand-slice-001/case.json").read_text())
        self.assertIsNone(case["recorded"]["verdict"])

    def test_writing_commands_are_refused_inside_a_supervised_execution(self):
        os.environ[evals.EXECUTION_ENV] = "x000000000001"
        for argv in (("collect",), ("add", "--case", "LOCAL-001", "--must-pass"), ("run", "--plan", "--budget", "5"), ("run", "--confirm", "abc", "--accept-execution-risk")):
            self.assertIn("refused inside a supervised Factory execution", self.refused(*argv))
        self.assertEqual(self.calls(), [])


class StatusTest(Base):
    def test_status_reports_the_configuration_and_what_changed_since_the_last_run(self):
        self.ok("collect")
        first = self.ok("status")
        self.assertEqual(first["cases"]["total"], 1)
        self.assertIsNone(first["last_run"])
        self.assertFalse(first["evaluated"])
        self.assertTrue(first["starts_nothing"])
        self.confirmed()
        after = self.ok("status")
        self.assertTrue(after["evaluated"])
        self.assertFalse(after["changed_since_last_run"]["any"])
        self.put({"REVIEW.md": "# Review\n\n- A new rule.\n"})
        config = json.loads((self.project / ".factory/config.json").read_text())
        config["models"]["build"] = "opus"
        self.put({".factory/config.json": json.dumps(config)})
        changed = self.ok("status")
        self.assertFalse(changed["evaluated"])
        self.assertEqual(changed["changed_since_last_run"]["rules"], ["REVIEW.md"])
        self.assertEqual(changed["changed_since_last_run"]["models"], ["build"])
        self.assertEqual(changed["changed_since_last_run"]["skills"], [])

    def test_the_line_digest_is_the_provenance_snapshots(self):
        import provenance
        current = self.ok("status")["configuration"]
        line = provenance.line(ROOT)
        rules = {name: evals.sha((self.project / name).read_bytes()) if (self.project / name).is_file() else None for name in evals.RULE_FILES}
        models = provenance.config(self.project)["models"]
        self.assertEqual(current["digest"], evals.sha(evals.canonical({"rules": rules, "line": line["digest"], "models": models})))


class PlanTest(Base):
    def test_the_plan_needs_a_budget_spends_nothing_and_shows_the_boundary(self):
        self.ok("collect")
        self.assertIn("starts with its plan", self.refused("run", "--budget", "5"))
        self.assertIn("explicit budget", self.refused("run", "--plan"))
        self.assertIn("less than 1 per case", self.refused("run", "--plan", "--budget", "0.5"))
        plan = self.planned(budget="7")
        self.assertTrue(plan["spends_nothing"])
        self.assertEqual(plan["will_run"][0]["case_id"], "LOCAL-001")
        self.assertEqual((plan["per_case_usd"], plan["ceiling_usd"]), (7.0, 7.0))
        self.assertEqual(plan["boundary"]["tools"], policy.default_tools())
        self.assertIn("never used", plan["boundary"]["machine_authorization"])
        self.assertTrue(plan["execution_risk"])
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.checkout(), self.before)

    def test_a_case_without_a_base_commit_is_listed_not_run(self):
        self.ok("collect")
        path = self.project / ".factory/evals/cases/LOCAL-001/case.json"
        case = json.loads(path.read_text())
        case["base_commit"] = None
        path.write_text(json.dumps(case))
        self.assertIn("No case can run", self.refused("run", "--plan", "--budget", "5"))

    def test_the_confirmation_needs_the_code_the_risk_and_an_unchanged_configuration(self):
        self.ok("collect")
        plan = self.planned()
        self.assertIn("--accept-execution-risk", self.refused("run", "--confirm", plan["confirm_with"]))
        self.assertIn("not the code", self.refused("run", "--confirm", "000000", "--accept-execution-risk"))
        self.put({"CLAUDE.md": "# Rules\n\nChanged after the plan.\n"})
        self.assertIn("configuration changed", self.refused("run", "--confirm", plan["confirm_with"], "--accept-execution-risk"))
        self.assertIn("No planned run", self.refused("run", "--confirm", plan["confirm_with"], "--accept-execution-risk"))  # used once
        self.assertEqual(self.calls(), [])

    def test_a_claude_code_without_the_boundary_flags_is_refused(self):
        self.ok("collect")
        self.claude({"help": "old"})
        plan = self.planned()
        self.assertIn("--restricted", self.refused("run", "--confirm", plan["confirm_with"], "--accept-execution-risk"))
        self.assertEqual(self.calls(), [])


class RunTest(Base):
    def test_a_run_is_confined_to_a_throwaway_clone_and_records_what_happened(self):
        self.ok("collect")
        before = self.eval_temp_folders()
        with mock.patch.object(policy, "read", side_effect=AssertionError("the machine's authorization was read")):
            done = self.confirmed(budget="4")
        self.assertEqual((done["passed"], done["of"]), (1, 1))
        [call] = self.calls()
        argv = call["argv"]
        clone = Path(call["cwd"]).resolve()
        self.assertFalse(evals.inside(clone, self.project))
        self.assertTrue(evals.inside(clone, Path(tempfile.gettempdir())))
        self.assertEqual(call["remote"], "")
        self.assertNotEqual(call["push"], 0)  # git's transports are off in the clone
        self.assertNotIn("GH_TOKEN", call["env"])
        for flag in ("--restricted", "--strict-mcp-config"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "default")
        self.assertEqual(argv[argv.index("--permission-prompts") + 1], "none")
        self.assertEqual(argv[argv.index("--max-budget-usd") + 1], "4")
        self.assertEqual(argv[argv.index("--allowedTools") + 1:], policy.default_tools())
        self.assertFalse([part for part in argv if "dangerously" in part or part in ("bypassPermissions", "acceptEdits")])
        self.assertIn('"until": "review"', argv[argv.index("-p") + 1])
        self.assertFalse(clone.parent.exists())  # the clone is gone
        self.assertTrue(clone.parent.name.startswith(evals.CLONE_PREFIX))
        self.assertNotIn(clone.parent, before)
        self.assertEqual(self.checkout(), self.before)  # the project's checkout, branches and remotes are untouched
        record = self.ok("show", done["run_id"])
        [case] = record["cases"]
        self.assertEqual((case["planned"], case["built"], case["verdict"], case["rounds"], case["cost_usd"]), (True, True, "PASS", 1, 0.75))
        self.assertIsInstance(case["seconds"], int)
        self.assertEqual(record["provenance"]["schema"], 1)
        self.assertEqual(record["configuration"]["digest"], self.ok("status")["configuration"]["digest"])

    def test_the_replay_starts_from_the_base_commit_with_the_configuration_laid_over_it(self):
        self.ok("collect")
        self.put({"REVIEW.md": "# Review\n\nThe rule under test.\n"})
        done = self.confirmed("--keep")
        [kept] = done["kept"]
        self.addCleanup(evals.remove_clone, Path(kept))
        clone = Path(kept) / "project"
        self.assertEqual((clone / "REVIEW.md").read_text(), "# Review\n\nThe rule under test.\n")
        self.assertEqual(git(clone, "rev-parse", "HEAD~1").stdout.strip(), self.base)  # one commit: the configuration under test
        self.assertFalse((clone / "docs/notes.md").exists())  # main as it was when the work started
        settings = json.loads((clone / ".factory/config.json").read_text())
        self.assertEqual((settings["tickets"]["provider"], settings["merge"]["mode"], settings["factory"]["supervisor"]), ("local", "manual", False))
        self.assertNotIn("publish_command", settings["records"])
        self.assertEqual(git(clone, "config", "protocol.allow").stdout.strip(), "never")
        ticket = done["cases"][0]["case_id"]
        self.assertEqual(ticket, "LOCAL-001")
        cell = json.loads(next((clone / ".factory/worktrees").glob("*/cell.json")).read_text())
        self.assertEqual(cell["slice_id"], "SLICE-001")

    def test_an_escaped_defect_reaches_the_replay_as_a_holdout_check(self):
        self.ok("add", "--from-ticket", "LOCAL-001", "--reason", "Inviting the same address twice sends two emails", "--must-pass")
        done = self.confirmed("--keep")
        self.addCleanup(evals.remove_clone, Path(done["kept"][0]))
        holdouts = list((Path(done["kept"][0]) / "project/.factory/holdouts").glob("*/escaped-defect.md"))
        self.assertEqual(len(holdouts), 1)
        self.assertIn("sends two emails", holdouts[0].read_text())

    def test_a_spec_the_gate_refuses_today_is_an_outcome_and_starts_nothing(self):
        self.archive("LOCAL-001", spec="# not a slice spec\n")
        self.ok("collect")
        done = self.confirmed()
        self.assertEqual(done["cases"][0]["outcome"], "not run")
        self.assertIn("refused the case's spec", done["cases"][0]["not_run"])
        self.assertEqual(self.calls(), [])

    def test_the_budget_stops_the_run_when_what_was_spent_leaves_too_little(self):
        spec = self.top / SPEC_NAME
        spec.write_text(SPEC)
        self.ok("collect")
        self.ok("add", "--spec", str(spec), "--base", self.base, "--intent", str(self.write_intent()), "--reason", "kept for the invite flow")
        self.claude({"default": {"verdict": "PASS", "cost": 1.5}})  # a run may end a little past its spending limit
        done = self.confirmed(budget="2")
        self.assertEqual([item["outcome"] for item in done["cases"]], ["passed", "not run"])
        self.assertEqual(done["cases"][1]["not_run"], "the run's budget was spent")
        self.assertEqual(done["stopped_early"], "budget spent")
        self.assertEqual(done["spent_usd_recorded"], 1.5)
        self.assertEqual(len(self.calls()), 1)

    def test_an_unrecorded_cost_is_not_recorded_never_zero(self):
        self.ok("collect")
        self.claude({"default": {"verdict": "PASS", "cost": None}})
        done = self.confirmed()
        self.assertIsNone(done["spent_usd_recorded"])
        self.assertIsNone(done["cases"][0]["cost_usd"])

    def write_intent(self):
        path = self.top / "intent.md"
        path.write_text(INTENT)
        return path

    def test_one_run_at_a_time(self):
        self.ok("collect")
        (self.project / ".factory/evals/runs").mkdir(parents=True, exist_ok=True)
        (self.project / ".factory/evals/runs/.running").write_text("1")
        plan = self.planned()
        self.assertIn("One at a time", self.refused("run", "--confirm", plan["confirm_with"], "--accept-execution-risk"))


class CompareTest(Base):
    def run_file(self, run_id, cases, source=None, digest="d1"):
        record = {"schema": 1, "run_id": run_id, "started_at": "2026-11-20T10:00:00Z", "ended_at": "2026-11-20T11:00:00Z",
                  "configuration": {"digest": digest, "source": source or {"kind": "checkout"}, "rules": {}, "line": {"files": {}}, "models": {}}, "cases": cases}
        path = self.project / ".factory/evals/runs" / run_id / "run.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record))

    def test_compare_is_deterministic_and_a_missing_value_is_never_a_pass(self):
        a, b = "eval-20261120T100000Z-aaaa", "eval-20261120T110000Z-bbbb"
        self.run_file(a, [{"case_id": "C1", "verdict": "PASS", "cost_usd": 1.0, "seconds": 60, "execution_id": "x1"},
                          {"case_id": "C2", "verdict": "PASS", "cost_usd": 2.0, "seconds": 90, "execution_id": "x2"},
                          {"case_id": "C3", "planned": True, "built": False}])
        self.run_file(b, [{"case_id": "C1", "verdict": "FAIL_WITH_EVIDENCE", "must_pass": True, "cost_usd": 1.5, "seconds": 70, "execution_id": "x3"},
                          {"case_id": "C2", "execution_id": "x4"},
                          {"case_id": "C3", "verdict": "PASS", "cost_usd": 0.5, "seconds": 30, "execution_id": "x5"}], digest="d2")
        first = self.ok("compare", a, b)
        self.assertEqual(first, self.ok("compare", a, b))
        self.assertEqual(first["before_totals"]["passed"], 2)
        self.assertEqual(first["after_totals"]["passed"], 1)
        self.assertEqual(first["after_totals"]["cases_without_cost"], 1)
        self.assertEqual(first["no_longer_passing"], ["C1", "C2"])
        self.assertEqual(first["now_passing"], ["C3"])
        self.assertEqual({item["case_id"]: item["after"] for item in first["changed_outcome"]}["C2"], "not recorded")
        self.assertEqual(first["must_pass_not_passing"], ["C1"])
        self.assertFalse(first["configurations"]["same"])
        self.assertEqual(self.ok("show", f"compare-{a}-{b}"), first)

    def test_the_tuning_packet_carries_the_comparison_for_exactly_that_change(self):
        head = "a" * 40
        self.assertEqual(evals.packet_entry(self.project, "LOCAL-009", head)["note"], "not evaluated")
        a, b = "eval-20261120T100000Z-aaaa", "eval-20261120T110000Z-bbbb"
        self.run_file(a, [{"case_id": "C1", "verdict": "PASS"}])
        self.run_file(b, [{"case_id": "C1", "verdict": "PASS"}], source={"kind": "ticket", "ticket": "LOCAL-009", "commit": head}, digest="d2")
        found = evals.packet_entry(self.project, "LOCAL-009", head)
        self.assertFalse(found["evaluated"])
        self.assertIn("was not compared", found["why"])
        self.ok("compare", a, b)
        found = evals.packet_entry(self.project, "LOCAL-009", head)
        self.assertTrue(found["evaluated"])
        self.assertEqual((found["before"], found["after"]), (a, b))
        self.assertFalse(evals.packet_entry(self.project, "LOCAL-009", "b" * 40)["evaluated"])  # the branch moved on: not this change
        self.assertFalse(evals.packet_entry(self.project, "LOCAL-010", head)["evaluated"])
        self.assertEqual(review.eval_comparison(self.project, "LOCAL-009", head), found)  # what review.py start puts in the packet

    def test_review_says_not_evaluated_when_the_records_cannot_be_read(self):
        runs = self.project / ".factory/evals/runs"
        runs.mkdir(parents=True)
        (runs / "compare-x.json").write_text("{not json")
        self.assertEqual(review.eval_comparison(self.project, "LOCAL-009", "a" * 40)["note"], "not evaluated")


class NothingElseStartsItTest(unittest.TestCase):
    def test_only_the_run_skill_and_its_script_name_an_eval_run(self):
        """No station script, agent, workflow or template starts an eval run or loads evals.py; the review station only reads
        the comparison for a tuning packet (packet_entry)."""
        allowed = {ROOT / "skills/run/SKILL.md", ROOT / "skills/run/scripts/run.py", ROOT / "skills/observe/scripts/evals.py",
                   ROOT / "skills/review/scripts/review.py"}
        found = []
        for top in ("skills", "agents", "workflows", "templates"):
            for path in sorted((ROOT / top).rglob("*")):
                if not path.is_file() or "__pycache__" in path.parts or path in allowed:
                    continue
                text = path.read_text(encoding="utf-8", errors="ignore")
                found += [f"{path.relative_to(ROOT)}: {word}" for word in ("evals.py", "eval run", "eval collect", "eval add") if word in text]
        self.assertEqual(found, [])
        source = (ROOT / "skills/review/scripts/review.py").read_text()
        self.assertNotIn("Evals(", source)
        self.assertIn("packet_entry", source)

    def test_the_eval_module_never_reads_the_machines_authorization(self):
        source = (ROOT / "skills/observe/scripts/evals.py").read_text()
        for word in ("runner.json\")", "policy.read(", ".read(self.root", "effective(", "may_execute", "dangerously-skip"):
            self.assertNotIn(word, source)


if __name__ == "__main__":
    unittest.main()
