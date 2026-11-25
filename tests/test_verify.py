"""Tests for verify.py: start gates, evidence records, and the verdict."""

import io
import json
import os
import sys
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "verify" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import verify  # noqa: E402
from test_build import Base as BuildBase, git  # noqa: E402
import class_template  # noqa: E402  (a step taken from the same starting folder is run once per class)

TARGETS = ["AC-01", "AC-02", "AC-03", "R1", "R2", "R3", "R4", "R5"]
NOTE = "Called invite() as a consumer and observed the expected outcome and unchanged seat count."


def fake_tools(*names):
    """A `which` that finds only the named tools."""
    return lambda name: f"/fake/bin/{name}" if name in names else None


def fake_start(code=0, output="A headless browser started and closed."):
    """A browser start that never runs anything: it records what was asked and answers as told."""
    calls = []

    def start(argv, cwd, env, timeout):
        calls.append(list(argv))
        return code, output
    start.calls = calls
    return start


class Base(BuildBase):
    def setUp(self):
        super().setUp()
        self.evidence = self.cellroot / "evidence"
        # No test starts a real browser: by default one "starts" through a Playwright on PATH.
        self.browser(fake_start(), fake_tools("node", "playwright"))

    def browser(self, start, which=None):
        for name, value in (("BROWSER_LAUNCH", start), ("BROWSER_WHICH", which or fake_tools("node", "playwright"))):
            old = getattr(verify, name)
            setattr(verify, name, value)
            self.addCleanup(setattr, verify, name, old)
        return start

    def built(self):
        class_template.step(self, "built", Path(self.tmp.name).resolve(), self._built)

    def _built(self):
        self.ready()
        self.ok("start", "LOCAL-001")
        self.build_through("T05")
        self.ok("finish", "LOCAL-001")

    def run_verify(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = verify.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def v_ok(self, *argv):
        code, out, err = self.run_verify(*argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def v_refused(self, *argv):
        code, out, err = self.run_verify(*argv)
        self.assertEqual(code, 1, out)
        return err + out

    def capture(self, name="consumer-run.log", text="AC-01 ok\n"):
        path = self.evidence / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return name

    def record(self, target, result="pass", evidence=None, note=NOTE):
        return self.v_ok("record", "LOCAL-001", target, "--result", result, "--evidence", evidence or self.capture(), "--note", note)

    def cell_json(self):
        return json.loads((self.cellroot / "cell.json").read_text())


class StartTest(Base):
    def test_only_an_unchanged_built_cell_can_be_verified(self):
        self.ready()
        self.assertIn("Only a built cell can be verified", self.v_refused("start", "LOCAL-001"))
        self.ok("start", "LOCAL-001")
        self.build_through("T05")
        self.ok("finish", "LOCAL-001")
        self.put(self.work, {"stray.txt": "x"})
        self.assertIn("uncommitted changes", self.v_refused("start", "LOCAL-001"))
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "sneaky")
        self.assertIn("changed after the build finished", self.v_refused("start", "LOCAL-001"))

    def test_start_reruns_the_suite_and_lists_what_to_prove(self):
        self.built()
        self.put(self.project, {".factory/holdouts/LOCAL-001/edge case.md": "Invite with an upper-case address."})
        started = self.v_ok("start", "LOCAL-001")
        self.assertEqual((started["status"], started["app_type"], started["suite"]["passed"], started["contracts"]["valid"]), ("STARTED", "library", True, True))
        self.assertEqual([t["id"] for t in started["prove"]], TARGETS + ["H-edge-case"])
        self.assertEqual(started["prove"][3]["conditions"]["Admin active"], ["No"])
        self.assertIn("with data you choose yourself", started["prove"][3]["prove"])
        self.assertIn("transcript of calling the library", started["required_evidence"][0])
        log = (self.evidence / "test-suite.log").read_text()
        self.assertIn("exit code: 0", log)
        self.assertIn("no contract files", (self.evidence / "contract-check.log").read_text())
        self.assertEqual(git(self.work, "status", "--porcelain").stdout, "")

    def test_byproducts_of_running_tests_do_not_block_verification(self):
        self.built()
        self.put(self.work, {"src/__pycache__/a.cpython-314.pyc": "x", ".pytest_cache/README.md": "x"})
        self.assertEqual(self.v_ok("start", "LOCAL-001")["status"], "STARTED")

    def test_restart_archives_earlier_evidence(self):
        self.built()
        self.v_ok("start", "LOCAL-001")
        self.record("AC-01")
        self.v_ok("start", "LOCAL-001")
        self.assertTrue((self.evidence / "previous-1/consumer-run.log").is_file())
        self.assertEqual(self.v_ok("status", "LOCAL-001")["remaining"], TARGETS)


class RecordTest(Base):
    def setUp(self):
        super().setUp()
        self.built()

    def test_record_needs_start_and_real_fresh_evidence(self):
        self.assertIn("has not started", self.v_refused("record", "LOCAL-001", "AC-01", "--result", "pass", "--evidence", "x.log", "--note", NOTE))
        self.v_ok("start", "LOCAL-001")
        name = self.capture()
        base = ["record", "LOCAL-001", "AC-01", "--result", "pass"]
        self.assertIn("is not something this verification must prove", self.v_refused("record", "LOCAL-001", "AC-99", "--result", "pass", "--evidence", name, "--note", NOTE))
        self.assertIn("what you did and what you observed", self.v_refused(*base, "--evidence", name, "--note", "works"))
        self.assertIn("does not exist or is empty", self.v_refused(*base, "--evidence", "missing.log", "--note", NOTE))
        self.assertIn("does not exist or is empty", self.v_refused(*base, "--evidence", self.capture("empty.log", ""), "--note", NOTE))
        self.assertIn("outside the evidence folder", self.v_refused(*base, "--evidence", "../plan.md", "--note", NOTE))
        self.assertIn("builder's own test run is not evidence", self.v_refused(*base, "--evidence", "test-suite.log", "--note", NOTE))
        old = self.evidence / self.capture("old.log")
        os.utime(old, (time.time() - 3600, time.time() - 3600))
        self.assertIn("older than this verification run", self.v_refused(*base, "--evidence", "old.log", "--note", NOTE))
        done = self.record("AC-01")
        self.assertEqual((done["status"], done["remaining"]), ("RECORDED", TARGETS[1:]))


DRIVER = """import os, sys
from app.invite import invite
print("argv", sys.argv[1:])
print("cwd is workdir", os.getcwd() == os.environ["MACH_VERIFY_WORKDIR"])
for check in ("AC-01", "AC-02", "AC-03", "R1", "R2", "R3", "R4", "R5"):
    print(check, "invite('sam@example.com') returned", repr(invite("sam@example.com")))
if not sys.stdin.isatty():
    print("stdin", sys.stdin.read().strip() or "(empty)")
print("to stderr", file=sys.stderr)
sys.exit(int(os.environ.get("DRIVER_EXIT", "0")))
"""


class CaptureTest(Base):
    """D22: the verifier's transcript without a shell redirect, a heredoc or a change of directory."""

    def setUp(self):
        super().setUp()
        self.built()

    def driver(self, name="driver.py", text=DRIVER):
        return self.capture(name, text)

    def test_capture_runs_the_driver_as_a_consumer_and_saves_its_transcript(self):
        self.assertIn("has not started", self.v_refused("capture", "LOCAL-001", "driver.py", "--out", "consumer-run.log"))
        self.v_ok("start", "LOCAL-001")
        self.driver()
        self.capture("answers.txt", "yes\n")
        done = self.v_ok("capture", "LOCAL-001", "driver.py", "--out", "consumer-run.log", "--input", "answers.txt", "--", "--seats", "5")
        self.assertEqual((done["status"], done["file"], done["exit_code"]), ("CAPTURED", "consumer-run.log", 0))
        log = (self.evidence / "consumer-run.log").read_text()
        self.assertTrue(log.startswith("$ python3 -B evidence/driver.py --seats 5 < evidence/answers.txt\n(in "), log)
        for line in ("argv ['--seats', '5']", "cwd is workdir True", "R5 invite('sam@example.com') returned 'sent'", "stdin yes",
                     "--- standard error ---\nto stderr", "exit code: 0"):
            self.assertIn(line, log)
        # The verifier never changes the cell: nothing is left in the checkout, not even byte code.
        self.assertEqual(git(self.work, "status", "--porcelain", "--ignored").stdout, "")
        # What capture wrote is ordinary evidence: fresh, recordable, and enough for the verdict.
        for target in TARGETS:
            self.record(target, evidence="consumer-run.log")
        self.assertEqual(self.v_ok("finish", "LOCAL-001")["status"], "PASS")

    def test_a_failing_driver_is_captured_not_hidden(self):
        self.v_ok("start", "LOCAL-001")
        self.driver()
        os.environ["DRIVER_EXIT"] = "3"
        self.addCleanup(os.environ.pop, "DRIVER_EXIT", None)
        done = self.v_ok("capture", "LOCAL-001", "driver.py", "--out", "run.log")
        self.assertEqual(done["exit_code"], 3)
        self.assertIn("exit code: 3", (self.evidence / "run.log").read_text())
        self.capture("slow.py", "import time\ntime.sleep(30)\n")
        done = self.v_ok("capture", "LOCAL-001", "slow.py", "--out", "slow.log", "--timeout", "1")
        self.assertEqual(done["exit_code"], 124)
        self.assertIn("Still running after 1 seconds; stopped.", (self.evidence / "slow.log").read_text())

    def test_capture_runs_only_a_script_in_the_evidence_folder_and_writes_only_there(self):
        self.v_ok("start", "LOCAL-001")
        self.driver()
        base = ["capture", "LOCAL-001"]
        self.assertIn("not a Python script in the evidence folder", self.v_refused(*base, "missing.py", "--out", "a.log"))
        self.assertIn("not a Python script in the evidence folder", self.v_refused(*base, self.capture("notes.txt", "x"), "--out", "a.log"))
        self.assertIn("outside the evidence folder", self.v_refused(*base, "../repo/app/invite.py", "--out", "a.log"))
        self.assertIn("relative to the evidence folder", self.v_refused(*base, str(self.work / "app/invite.py"), "--out", "a.log"))
        self.assertIn("outside the evidence folder", self.v_refused(*base, "driver.py", "--out", "../plan.md"))
        self.assertIn("outside the evidence folder", self.v_refused(*base, "driver.py", "--out", "../repo/app/invite.py"))
        for reserved in ("test-suite.log", "results.json", "summary.json", "contract-check.log", "driver.py", "other.py", "previous-1/x.log"):
            self.assertIn("cannot be written by capture", self.v_refused(*base, "driver.py", "--out", reserved))
        self.assertIn("does not exist in the evidence folder", self.v_refused(*base, "driver.py", "--out", "a.log", "--input", "nothing.txt"))
        self.assertIn("from 1 to 3600", self.v_refused(*base, "driver.py", "--out", "a.log", "--timeout", "0"))
        self.assertIn("exit code: 0", (self.evidence / "test-suite.log").read_text())  # untouched
        self.assertFalse((self.evidence / "a.log").exists())


class RecordFromTest(Base):
    """D22: every check recorded from one file the verifier wrote with its file tools, instead of chained commands."""

    def setUp(self):
        super().setUp()
        self.built()
        self.started = self.v_ok("start", "LOCAL-001")
        self.records_file = Path(self.started["records_file"])

    def write(self, records, path=None):
        path = path or self.records_file
        path.write_text(json.dumps(records))
        return str(path)

    def entries(self, failing=()):
        name = self.capture()
        return [{"id": t, "result": "fail" if t in failing else "pass", "evidence": [name] if t != "R5" else name,
                 "note": NOTE if t not in failing else f"The spec expects a refusal; {t} was accepted and a seat was taken."} for t in TARGETS]

    def test_records_every_check_from_one_file(self):
        self.assertEqual(self.records_file, self.cellroot / "verify-records.json")
        done = self.v_ok("record", "LOCAL-001", "--from", self.write(self.entries(failing=("R4",))))
        self.assertEqual((done["status"], done["ids"], done["results"]["R4"], done["remaining"]), ("RECORDED", TARGETS, "fail", "none; run finish"))
        code, out, _ = self.run_verify("finish", "LOCAL-001")
        self.assertEqual((code, json.loads(out)["status"]), (1, "FAIL_WITH_EVIDENCE"))
        self.assertIn("1. R4 (matrix rule): The spec expects a refusal", (self.evidence / "findings.md").read_text())

    def test_a_file_with_one_bad_check_records_nothing(self):
        entries = self.entries()
        old = self.evidence / self.capture("old.log")
        os.utime(old, (time.time() - 3600, time.time() - 3600))
        for broken, expected in (({"evidence": ["old.log"]}, "older than this verification run"), ({"evidence": ["test-suite.log"]}, "builder's own test run"),
                                 ({"evidence": ["../plan.md"]}, "outside the evidence folder"), ({"evidence": []}, "name at least one evidence file"),
                                 ({"note": "works"}, "what you did and what you observed"), ({"id": "AC-99"}, "is not something this verification must prove"),
                                 ({"result": "maybe"}, "must be 'pass' or 'fail'"), ({"evidence": ["summary.json"]}, "does not exist or is empty")):
            changed = [dict(entry) for entry in entries]
            changed[-1].update(broken)
            self.assertIn(expected, self.v_refused("record", "LOCAL-001", "--from", self.write(changed)))
            self.assertEqual(self.v_ok("status", "LOCAL-001")["remaining"], TARGETS)  # nothing was recorded
        self.assertIn("more than once", self.v_refused("record", "LOCAL-001", "--from", self.write(entries + entries[:1])))
        self.assertIn("must be a JSON list", self.v_refused("record", "LOCAL-001", "--from", self.write({"AC-01": "pass"})))
        self.assertIn("is missing or is not valid JSON", self.v_refused("record", "LOCAL-001", "--from", str(self.cellroot / "nothing.json")))

    def test_the_records_file_is_never_evidence(self):
        inside = self.write(self.entries(), self.evidence / "records.json")
        self.assertIn("must not be in the evidence folder", self.v_refused("record", "LOCAL-001", "--from", inside))
        self.assertIn("either --from with a records file, or one check", self.v_refused("record", "LOCAL-001", "AC-01", "--from", self.write(self.entries())))
        self.assertIn("record needs --result, --evidence, --note", self.v_refused("record", "LOCAL-001", "AC-01"))
        # A relative name is found in the cell folder, so no change of directory is needed.
        self.write(self.entries())
        self.assertEqual(self.v_ok("record", "LOCAL-001", "--from", "verify-records.json")["status"], "RECORDED")
        # A new run starts from nothing: the applied records file is removed with the earlier evidence archived.
        self.v_ok("start", "LOCAL-001")
        self.assertFalse(self.records_file.exists())


class FinishTest(Base):
    def setUp(self):
        super().setUp()
        self.built()
        self.v_ok("start", "LOCAL-001")

    def prove_all(self, failing=()):
        for target in TARGETS:
            if target in failing:
                self.record(target, "fail", note=f"The spec expects the invitation to be refused; {target} was accepted and a seat was taken.")
            else:
                self.record(target)

    def test_incomplete_until_everything_is_proven(self):
        self.record("AC-01")
        out = self.v_refused("finish", "LOCAL-001")
        self.assertIn("INCOMPLETE_EVIDENCE", out)
        self.assertIn("Not proven yet: AC-02, AC-03, R1, R2, R3, R4, R5", out)
        self.assertFalse((self.evidence / "summary.json").exists())
        self.assertEqual(self.cell_json()["stage"], "built")

    def test_pass(self):
        self.prove_all()
        done = self.v_ok("finish", "LOCAL-001")
        self.assertEqual((done["status"], done["checks_passed"], done["checks_failed"]), ("PASS", 8, 0))
        summary = json.loads((self.evidence / "summary.json").read_text())
        self.assertEqual((summary["status"], summary["contract_valid"], summary["holdout_tests_passed"], summary["app_type"]), ("PASS", True, True, "library"))
        self.assertEqual(sorted(e["file"] for e in summary["evidence_files"]), ["consumer-run.log", "contract-check.log", "test-suite.log"])
        self.assertEqual(summary["checks"]["R2"]["kind"], "matrix rule")
        cell = self.cell_json()
        self.assertEqual((cell["stage"], cell["verification"]), ("verified", "PASS"))

    def test_failure_writes_findings_and_returns_to_build(self):
        self.prove_all(failing=("R4",))
        code, out, _ = self.run_verify("finish", "LOCAL-001")
        done = json.loads(out)
        self.assertEqual((code, done["status"], done["checks_failed"]), (1, "FAIL_WITH_EVIDENCE", 1))
        findings = (self.evidence / "findings.md").read_text()
        self.assertIn("1. R4 (matrix rule): The spec expects the invitation to be refused", findings)
        summary = json.loads((self.evidence / "summary.json").read_text())
        self.assertEqual((summary["status"], summary["holdout_tests_passed"]), ("FAIL_WITH_EVIDENCE", False))
        self.assertEqual(self.cell_json()["stage"], "built")
        revising = self.ok("revise", "LOCAL-001", "--findings", str(self.evidence / "findings.md"))
        self.assertEqual((revising["status"], revising["loop"]), ("REVISING", 1))
        self.assertIn("Only a built cell can be verified", self.v_refused("start", "LOCAL-001"))

    def test_tampered_evidence_and_edited_code_are_caught(self):
        self.prove_all()
        (self.evidence / "consumer-run.log").write_text("rewritten afterwards\n")
        self.put(self.work, {"app/invite.py": "def invite(email):\n    return 'patched'\n"})
        out = self.v_refused("finish", "LOCAL-001")
        self.assertIn("changed or disappeared after it was recorded", out)
        self.assertIn("A verifier never edits the cell's code", out)

    def test_required_evidence_depends_on_app_type(self):
        cell = self.cell_json()
        cell["app_type"] = "web"
        (self.cellroot / "cell.json").write_text(json.dumps(cell))
        self.prove_all()
        out = self.v_refused("finish", "LOCAL-001")
        self.assertIn("No screenshot was captured", out)
        self.assertIn("No recording of the flow was captured", out)
        self.capture("ac-01.png", "png")
        self.capture("flow.webm", "video")
        self.assertEqual(self.v_ok("finish", "LOCAL-001")["status"], "PASS")

    def test_cli_exit_codes_must_be_real_and_cover_every_check(self):
        cell = self.cell_json()
        cell["app_type"] = "cli"
        (self.cellroot / "cell.json").write_text(json.dumps(cell))
        self.v_ok("start", "LOCAL-001")  # the app type is fixed when verification starts
        self.prove_all()
        self.capture("exit-codes.json", "[]")
        self.assertIn("exit-codes.json must be a list of", self.v_refused("finish", "LOCAL-001"))
        self.capture("exit-codes.json", json.dumps([{"command": "tool count a.txt", "exit_code": 0, "check": "AC-01"}, {"command": "tool count b.txt", "exit_code": 2, "check": ["AC-02", "R1"]}]))
        self.assertIn("exit-codes.json has no command for: AC-03, R2, R3, R4, R5", self.v_refused("finish", "LOCAL-001"))
        self.capture("exit-codes.json", json.dumps([{"command": f"tool check {t}", "exit_code": 0, "check": t} for t in TARGETS]))
        done = self.v_ok("finish", "LOCAL-001")
        summary = json.loads((self.evidence / "summary.json").read_text())
        self.assertEqual(done["status"], "PASS")
        self.assertEqual(summary["evidence_kinds"], {"terminal session": ["consumer-run.log"], "exit codes": ["exit-codes.json"]})
        self.assertIsInstance(summary["tools_available"], list)

    def test_required_evidence_can_be_set_in_config(self):
        self.put(self.project, {".factory/config.json": json.dumps({"verify": {"required_evidence": {"library": ["api-surface.txt"]}}})})
        self.prove_all()
        self.assertIn("No api-surface.txt was captured", self.v_refused("finish", "LOCAL-001"))


SANDBOX = "browserType.launch: Failed to launch chromium because executable doesn't start\nError: spawn EPERM: Operation not permitted\n"
HEADLESS_SAID = "No browser could start here, so there are no screenshots; this was verified from logs and saved pages."


class ClassifyTest(unittest.TestCase):
    """browser.py names why a browser did not start, in plain words, from the tool's own output."""

    def check(self, code, output, tools=("node", "playwright")):
        return verify.browser.check("web", Path("/nonexistent"), network_re=verify.command_env.NETWORK_RE,
                                    launch=fake_start(code, output), which=fake_tools(*tools))

    def test_each_failure_is_named(self):
        cases = {
            "browser-missing": (1, "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1/chrome\n"
                                   "Looks like Playwright was just installed. Please run: npx playwright install"),
            "sandbox": (1, SANDBOX),
            "network": (1, "Downloading Chromium\nError: getaddrinfo ENOTFOUND playwright.azureedge.net"),
            "timed-out": (None, ""),
            "failed": (1, "something unexpected"),
        }
        for reason, (code, output) in cases.items():
            found = self.check(code, output)
            self.assertEqual((found["can_capture"], found["reason"]), (False, reason), reason)
            self.assertTrue(found["words"] and found["at"])
        self.assertIn("ENOTFOUND", self.check(*cases["network"])["why"], "the tool's own line, as data")
        self.assertIn("refused to start a browser", self.check(*cases["sandbox"])["words"])

    def test_no_tool_installed(self):
        found = self.check(0, "", tools=())
        self.assertEqual((found["can_capture"], found["reason"]), (False, "not-installed"))
        self.assertEqual([item["tool"] for item in found["tried"]], ["playwright (project-local)", "playwright", "cypress"])
        self.assertEqual(found["words"], "no tool that can start a browser is installed here")

    def test_the_project_playwright_is_tried_first_and_the_line_is_capped(self):
        with self.subTest("order"):
            import tempfile
            with tempfile.TemporaryDirectory() as folder:
                (Path(folder) / "node_modules" / "@playwright" / "test").mkdir(parents=True)
                start = fake_start(1, "x" * 900 + "\nOperation not permitted " + "y" * 900)
                found = verify.browser.check("web", Path(folder), launch=start, which=fake_tools("node", "playwright"))
                self.assertEqual([call[0] for call in start.calls], ["/fake/bin/node", "/fake/bin/playwright"])
                self.assertEqual([item["tool"] for item in found["tried"]], ["playwright (project-local)", "playwright", "cypress"])
                self.assertLessEqual(len(found["why"]), verify.browser.LINE_LIMIT)


class ScreenEvidenceTest(Base):
    """A web slice needs screenshots when a browser can start here, and is verified without them when none can."""

    def setUp(self):
        super().setUp()
        self.built()

    def web(self, config=None, app_type="web"):
        cell = self.cell_json()
        cell["app_type"] = app_type
        (self.cellroot / "cell.json").write_text(json.dumps(cell))
        if config is not None:
            self.put(self.project, {".factory/config.json": json.dumps({"verify": config})})
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "settings", "--allow-empty")

    def prove_all(self):
        for target in TARGETS:
            self.record(target)

    def summary(self):
        return json.loads((self.evidence / "summary.json").read_text())

    def test_screenshots_stay_the_default_when_a_browser_starts(self):
        self.web()
        started = self.v_ok("start", "LOCAL-001")
        self.assertEqual((started["evidence_mode"], started["browser_check"]["can_capture"]), ("screen", True))
        self.assertTrue(any(item.startswith("screenshot") for item in started["required_evidence"]))
        self.assertNotIn("capture_instead", started)
        self.prove_all()
        self.capture("page.html", "<p>Invited</p>")
        out = self.v_refused("finish", "LOCAL-001")
        self.assertIn("No screenshot was captured", out)
        self.assertNotIn("nothing goes back to the builder", out)
        self.capture("ac-01.png", "png")
        self.capture("flow.webm", "video")
        done = self.v_ok("finish", "LOCAL-001")
        self.assertEqual(done["status"], "PASS")
        self.assertNotIn("evidence", done)
        self.assertEqual(self.summary()["evidence_mode"]["mode"], "screen")

    def test_no_browser_here_falls_back_and_passes(self):
        self.web()
        self.browser(fake_start(1, SANDBOX))
        started = self.v_ok("start", "LOCAL-001")
        self.assertEqual((started["evidence_mode"], started["browser_check"]["reason"]), ("headless", "sandbox"))
        self.assertIn("Do not try to start a browser", started["capture_instead"])
        self.assertIn("without a browser", started["required_evidence"][0])
        self.assertIn("without a screen", started["next"])
        status = self.v_ok("status", "LOCAL-001")
        self.assertEqual(status["evidence_mode"], "headless")
        self.assertIn("capture_instead", status)
        self.prove_all()
        self.capture("ac-01-page.html", "<p>Invited 3 of 5</p>")
        done = self.v_ok("finish", "LOCAL-001")
        self.assertEqual((done["status"], done["evidence_mode"], done["evidence"]), ("PASS", "headless", HEADLESS_SAID))
        summary = self.summary()
        self.assertEqual((summary["evidence_mode"]["mode"], summary["evidence_mode"]["reason"], summary["evidence_mode"]["said"]),
                         ("headless", "no-capture", HEADLESS_SAID))
        self.assertEqual(summary["browser_check"]["reason"], "sandbox")
        self.assertEqual(self.cell_json()["stage"], "verified")

    def test_the_fallback_still_needs_a_file_and_says_what_to_capture(self):
        self.web()
        self.browser(fake_start(1, SANDBOX))
        self.v_ok("start", "LOCAL-001")
        self.prove_all()  # consumer-run.log is captured by the records: remove it to leave nothing headless
        for name in ("consumer-run.log",):
            (self.evidence / name).unlink()
        self.capture("notes.md", "not evidence of the right kind")
        out = self.v_refused("finish", "LOCAL-001")
        self.assertIn("INCOMPLETE_EVIDENCE", out)
        self.assertIn("No record of driving the app without a browser", out)
        self.assertIn("*.html", out)
        self.assertIn("This is the verifier's own next step; nothing goes back to the builder.", out)
        self.assertNotIn("screenshot was captured", out)
        self.assertFalse((self.evidence / "summary.json").exists())
        self.assertEqual(self.cell_json()["stage"], "built")

    def test_a_browser_that_stops_starting_during_the_run(self):
        self.web()
        self.assertEqual(self.v_ok("start", "LOCAL-001")["evidence_mode"], "screen")
        self.browser(fake_start(1, SANDBOX))
        self.prove_all()
        done = self.v_ok("finish", "LOCAL-001")  # finish sees no screenshot, checks again, and applies the fallback
        self.assertEqual((done["status"], done["evidence"]), ("PASS", HEADLESS_SAID))
        self.assertEqual(self.summary()["browser_check"]["can_capture"], False)

    def test_browser_check_during_the_run_records_the_answer(self):
        self.web()
        self.v_ok("start", "LOCAL-001")
        self.browser(fake_start(None, ""))
        checked = self.v_ok("browser-check", "LOCAL-001")
        self.assertEqual((checked["status"], checked["evidence_mode"], checked["browser_check"]["reason"]), ("NO_SCREEN", "headless", "timed-out"))
        self.assertIn("Capture instead", checked["capture_instead"])
        self.assertEqual(json.loads((self.evidence / "results.json").read_text())["browser_check"]["reason"], "timed-out")

    def test_require_waits_for_a_person_and_never_goes_to_the_builder(self):
        self.web({"screen_evidence": "require"})
        self.browser(fake_start(1, SANDBOX))
        out = self.v_refused("start", "LOCAL-001")
        self.assertIn("verify.screen_evidence is 'require'", out)
        self.assertIn("not sent back to the builder: it waits for a person", out)
        self.assertIn("set verify.screen_evidence to 'prefer'", out)
        self.assertFalse((self.evidence / "results.json").exists())
        # A browser that starts at first and stops during the run: still screenshots, and the same words.
        self.browser(fake_start())
        self.v_ok("start", "LOCAL-001")
        self.browser(fake_start(1, SANDBOX))
        self.prove_all()
        out = self.v_refused("finish", "LOCAL-001")
        self.assertIn("No screenshot was captured", out)
        self.assertIn("it waits for a person", out)
        self.assertEqual(self.cell_json()["stage"], "built")

    def test_never_tries_no_browser(self):
        self.web({"screen_evidence": "never"})
        start = self.browser(fake_start())
        started = self.v_ok("start", "LOCAL-001")
        self.assertEqual(start.calls, [])
        self.assertEqual(started["evidence_mode"], "headless")
        self.assertNotIn("browser_check", started)
        self.prove_all()
        done = self.v_ok("finish", "LOCAL-001")
        self.assertEqual(start.calls, [])
        self.assertEqual(done["status"], "PASS")
        self.assertIn("settings say not to capture the screen", done["evidence"])

    def test_required_evidence_in_the_settings_still_wins(self):
        self.web({"required_evidence": {"web": ["*.log"]}, "screen_evidence": "require"})
        start = self.browser(fake_start(1, SANDBOX))
        started = self.v_ok("start", "LOCAL-001")
        self.assertEqual(start.calls, [])
        self.assertEqual(started["required_evidence"], ["*.log (*.log)"])
        self.prove_all()
        done = self.v_ok("finish", "LOCAL-001")
        self.assertEqual(done["status"], "PASS")
        self.assertEqual(self.summary()["evidence_mode"]["reason"], "setting")

    def test_desktop_and_mobile_are_treated_the_same(self):
        for app_type, tool in (("desktop", "screencapture"), ("mobile", "xcrun")):
            with self.subTest(app_type):
                self.web(app_type=app_type)  # a verified cell may be verified again
                start = self.browser(fake_start(1, "could not create image from display"), fake_tools(tool))
                started = self.v_ok("start", "LOCAL-001")
                self.assertEqual(started["evidence_mode"], "headless")
                if app_type == "mobile" or sys.platform == "darwin":
                    self.assertEqual(start.calls[0][0], f"/fake/bin/{tool}")
                self.prove_all()
                done = self.v_ok("finish", "LOCAL-001")
                self.assertEqual(done["status"], "PASS")
                self.assertIn("Nothing here could capture the app's screen", done["evidence"])

    def test_other_app_types_are_unchanged(self):
        start = self.browser(fake_start())
        started = self.v_ok("start", "LOCAL-001")
        self.assertEqual(start.calls, [])
        self.assertNotIn("evidence_mode", started)
        self.prove_all()
        self.v_ok("finish", "LOCAL-001")
        self.assertNotIn("evidence_mode", self.summary())


class AutomaticCheckTest(Base):
    def test_failing_suite_or_bad_contract_fails_verification(self):
        self.built()
        report = json.loads((self.cellroot / "build-report.json").read_text())
        report["tests"]["command"] = f"{sys.executable} -c 'raise SystemExit(4)'"
        (self.cellroot / "build-report.json").write_text(json.dumps(report))
        cell = self.cell_json()
        cell["contracts"] = ["app/__init__.py", "proto/missing.schema.json"]
        (self.cellroot / "cell.json").write_text(json.dumps(cell))
        started = self.v_ok("start", "LOCAL-001")
        self.assertEqual((started["suite"]["passed"], started["contracts"]["valid"]), (False, False))
        self.assertIn("FAIL proto/missing.schema.json: missing", (self.evidence / "contract-check.log").read_text())
        for target in TARGETS:
            self.record(target)
        code, out, _ = self.run_verify("finish", "LOCAL-001")
        done = json.loads(out)
        self.assertEqual((code, done["status"]), (1, "FAIL_WITH_EVIDENCE"))
        self.assertEqual(len(done["failures"]), 2)


if __name__ == "__main__":
    unittest.main()
