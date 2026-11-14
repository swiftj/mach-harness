"""Execution provenance (M6.5): a snapshot of what an unattended execution was started with, taken once at start.

Two kinds of test:
- the snapshot on its own (provenance.py), against a small stand-in plugin in a temporary folder;
- the supervisor with it: recorded on the claim record and on execution.started, and unable to change what
  the supervisor does. The supervisor's start is run twice from the same files, once as it was before
  provenance existed and once with it, and every file it leaves is compared byte for byte.

Claude Code is the stand-in from the supervisor tests; no real agent is started.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "skills" / "run" / "scripts"
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(SCRIPTS))
import executor  # noqa: E402
import intake  # noqa: E402
import policy  # noqa: E402
import provenance  # noqa: E402
import run  # noqa: E402
import supervisor  # noqa: E402
from test_mach_factory_supervisor import Base  # noqa: E402

HEX64 = "0123456789abcdef" * 4
TOP = {"schema", "mach", "line", "config", "policy", "ticket", "source", "config_id"}


def stand_in_plugin(folder: Path) -> Path:
    files = {".claude-plugin/plugin.json": json.dumps({"name": "mach", "version": "9.9.9"}),
             "skills/build/SKILL.md": "---\nname: build\n---\nBuild.\n", "skills/build/scripts/build.py": "print('build')\n",
             "skills/run/SKILL.md": "---\nname: run\n---\nRun.\n", "agents/builder.md": "Builder.\n", "workflows/belt.js": "export default 1\n"}
    for name, text in files.items():
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    cache = folder / "skills/build/scripts/__pycache__"
    cache.mkdir()
    (cache / "build.cpython-312.pyc").write_bytes(b"compiled")
    return folder


POLICY = {"autonomy": "supervised", "max_risk": "Medium", "allow_merge": False, "limits": {"max_parallel": 2},
          "allowed_tools": ["Workflow", "Read", f"Bash({sys.executable} *)"], "claude": "/usr/local/bin/claude", "project_root": "/Users/someone/project"}


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mach-provenance-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.plugin = stand_in_plugin(self.tmp / "plugin")
        self.project = self.tmp / "project"
        (self.project / ".factory/worktrees/LOCAL-001").mkdir(parents=True)
        (self.project / ".factory/config.json").write_text(json.dumps(json.loads((ROOT / "templates/config.json").read_text())))
        (self.project / ".factory/worktrees/LOCAL-001/cell.json").write_text(json.dumps({"risk": "Medium", "app_type": "cli", "stage": "planned"}))
        self.ledger = {"source": {"commit": "a" * 40, "branch": "main"},
                       "slices": {"SLICE-001": {"revision": 2, "digest": HEX64, "spec_sha256": HEX64[::-1], "spec_path": "specs/slices/SLICE-001-x.md"}}}
        self.boundary = {"kind": "plugin", "plugin_dir": self.plugin, "workflow": "mach:belt", "add_dirs": [self.plugin], "denied": []}

    def snap(self, **changes):
        args = {"root": self.project, "boundary": self.boundary, "pol": POLICY, "ticket_id": "LOCAL-001", "slice_id": "SLICE-001", "ledger": self.ledger}
        args.update(changes)
        return provenance.capture(**args)

    def test_the_snapshot_holds_digests_versions_and_identifiers_only(self):
        got = self.snap()
        self.assertEqual(set(got), {"provenance"})
        snap = got["provenance"]
        self.assertEqual(set(snap), TOP)
        self.assertEqual(snap["schema"], 1)
        self.assertEqual(snap["mach"], {"version": "9.9.9", "install": "plugin", "commit": None})  # not a Git checkout: no commit is invented
        self.assertEqual(sorted(snap["line"]["files"]), ["agent:builder", "plugin:manifest", "skill:build", "skill:run", "workflow:belt"])
        self.assertEqual(snap["line"]["count"], 5)
        self.assertEqual(snap["line"]["files"]["agent:builder"], hashlib.sha256(b"Builder.\n").hexdigest())
        self.assertEqual(snap["config"]["models"], {"build": "sonnet", "contracts": "opus", "planning": "fable", "utility": "haiku"})
        self.assertEqual(snap["config"]["review"]["tiers"]["high"], {"approvals": 3, "reviewers": 3, "human_approval": True})
        self.assertEqual((snap["config"]["review"]["max_loops"], snap["config"]["review"]["security_veto"], snap["config"]["max_parallel"]), (3, None, 3))
        placeholder = [tool.replace(sys.executable, "<python>") for tool in POLICY["allowed_tools"]]  # the same on every machine
        tools = hashlib.sha256(json.dumps(placeholder, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(snap["policy"], {"autonomy": "supervised", "max_risk": "Medium", "allow_merge": False, "max_parallel": 2,
                                          "allowed_tools_digest": tools, "allowed_tools_count": 3})
        self.assertEqual(snap["ticket"], {"risk": "Medium", "app_type": "cli"})
        self.assertEqual(snap["source"], {"commit": "a" * 40, "slice_revision": 2, "slice_digest": HEX64, "spec_sha256": HEX64[::-1]})
        text = json.dumps(snap)
        for never in (str(self.tmp), str(self.plugin), "/Users", "/usr/local", sys.executable, "Bash(", "Workflow", "SLICE-001-x.md", "/"):
            self.assertNotIn(never, text)

    def test_config_id_compares_configuration_and_nothing_else(self):
        first = self.snap()["provenance"]
        self.assertEqual(self.snap()["provenance"], first)  # nothing changed: the same snapshot
        # Facts about this run are not configuration.
        other_ticket = self.snap(ledger={"source": {"commit": "b" * 40}, "slices": {}})["provenance"]
        self.assertEqual(other_ticket["config_id"], first["config_id"])
        self.assertNotEqual(other_ticket["source"], first["source"])
        # A changed skill file, model tier, review threshold, policy mode or tool list is a different configuration.
        time.sleep(0.01)
        (self.plugin / "skills/build/SKILL.md").write_text("---\nname: build\n---\nBuild, changed.\n")
        changed = self.snap()["provenance"]
        self.assertNotEqual(changed["line"]["files"]["skill:build"], first["line"]["files"]["skill:build"])
        self.assertEqual(changed["line"]["files"]["skill:run"], first["line"]["files"]["skill:run"])
        self.assertNotEqual(changed["config_id"], first["config_id"])
        ids = {changed["config_id"]}
        config = json.loads((self.project / ".factory/config.json").read_text())
        config["models"]["build"] = "opus"
        (self.project / ".factory/config.json").write_text(json.dumps(config))
        ids.add(self.snap()["provenance"]["config_id"])
        config["review"]["security_veto"] = False
        (self.project / ".factory/config.json").write_text(json.dumps(config))
        vetoless = self.snap()["provenance"]
        self.assertIs(vetoless["config"]["review"]["security_veto"], False)
        ids.add(vetoless["config_id"])
        ids.add(self.snap(pol={**POLICY, "allowed_tools": POLICY["allowed_tools"] + ["Grep"]})["provenance"]["config_id"])
        ids.add(self.snap(pol={**POLICY, "autonomy": "observe"})["provenance"]["config_id"])
        self.assertEqual(len(ids), 5)

    def test_a_rewrite_that_keeps_size_and_time_is_still_seen(self):
        path = self.plugin / "agents/builder.md"
        first = self.snap()["provenance"]["line"]["files"]["agent:builder"]
        stamp = path.stat().st_mtime_ns
        path.write_text("Builder!\n")  # the same size
        os.utime(str(path), ns=(stamp, stamp))  # and the same modification time
        self.assertNotEqual(self.snap()["provenance"]["line"]["files"]["agent:builder"], first)

    def test_absent_or_unusable_settings_are_not_recorded_never_defaulted(self):
        (self.project / ".factory/config.json").unlink()
        (self.project / ".factory/worktrees/LOCAL-001/cell.json").write_text(json.dumps({"risk": "Extreme", "app_type": "/Users/x"}))
        snap = self.snap(ledger={}, pol={"autonomy": "supervised"})["provenance"]
        self.assertEqual(snap["config"], {"recorded": False, "digest": None, "models": None, "review": None, "max_parallel": None})
        self.assertEqual(snap["ticket"], {"risk": None, "app_type": None})
        self.assertEqual(snap["source"], {"commit": None, "slice_revision": None, "slice_digest": None, "spec_sha256": None})
        self.assertEqual((snap["policy"]["allowed_tools_digest"], snap["policy"]["allowed_tools_count"], snap["policy"]["max_parallel"]), (None, None, None))
        # A tier that is not an identifier is left out of what is shown (the config digest still covers it); a model
        # name that is not an identifier is shown by its digest only.
        (self.project / ".factory/config.json").write_text(json.dumps({"models": {"build": "/Users/x/model", "Weird Tier": "opus", "planning": "fable"}}))
        snap = self.snap()["provenance"]
        self.assertEqual(snap["config"]["models"], {"planning": "fable", "build": "sha256:" + hashlib.sha256(b"/Users/x/model").hexdigest()})
        self.assertIsNone(snap["config"]["review"])  # not configured: not recorded, and no default stands in for it

    def test_the_harness_commit_is_read_from_a_checkout_only(self):
        snap = self.snap(boundary={**self.boundary, "plugin_dir": ROOT})["provenance"]
        head = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        self.assertEqual(snap["mach"]["commit"], head)
        self.assertEqual(snap["mach"]["version"], json.loads((ROOT / ".claude-plugin/plugin.json").read_text())["version"])
        self.assertIsNone(self.snap(boundary={**self.boundary, "plugin_dir": ROOT, "kind": "project"})["provenance"]["mach"]["commit"])

    def test_any_failure_is_recorded_as_such_and_never_raised(self):
        for failure in (OSError("/Users/someone/secret"), ValueError("x"), KeyError("plugin_dir"), RecursionError(), provenance.TooLarge("files")):
            with mock.patch.object(provenance, "line", side_effect=failure):
                self.assertEqual(self.snap(), {"provenance": None, "provenance_reason": "capture-failed"})
        self.assertEqual(self.snap(boundary={}), {"provenance": None, "provenance_reason": "capture-failed"})
        with mock.patch.object(provenance, "MAX_FILES", 2):
            provenance._CACHE.clear()
            self.assertEqual(self.snap(), {"provenance": None, "provenance_reason": "capture-failed"})  # bounded: never a partial digest

    def test_capture_is_bounded_and_cached(self):
        provenance._CACHE.clear()
        boundary = {**self.boundary, "plugin_dir": ROOT}
        began = time.perf_counter()
        cold = self.snap(boundary=boundary)["provenance"]
        cold_ms = (time.perf_counter() - began) * 1000
        began = time.perf_counter()
        warm = self.snap(boundary=boundary)["provenance"]
        warm_ms = (time.perf_counter() - began) * 1000
        self.assertEqual(cold["line"], warm["line"])
        self.assertLess(cold_ms, 5000)
        self.assertLess(warm_ms, 5000)
        sys.stderr.write(f"\nprovenance capture on MACH's own plugin ({cold['line']['count']} parts): cold {cold_ms:.1f} ms, warm {warm_ms:.1f} ms\n")


class ReviewFixesTest(unittest.TestCase):
    """The independent review's findings, one test each."""

    setUp = SnapshotTest.setUp
    snap = SnapshotTest.snap

    def write_config(self, data):
        (self.project / ".factory/config.json").write_text(json.dumps(data))

    def test_1_every_configured_key_is_in_the_identity_and_no_model_name_is_dropped(self):
        config = json.loads((ROOT / "templates/config.json").read_text())
        first = self.snap()["provenance"]
        self.assertRegex(first["config"]["digest"], r"^[0-9a-f]{64}$")
        ids = {first["config_id"]}
        for change in (("merge", "mode", "manual"), ("audit", "gold", 95), ("observe", "every", 7), ("review", "max_rounds_note", 1)):
            changed = json.loads(json.dumps(config))
            changed.setdefault(change[0], {})[change[1]] = change[2]
            self.write_config(changed)
            ids.add(self.snap()["provenance"]["config_id"])
        changed = json.loads(json.dumps(config))
        changed["app_type"] = "web"
        self.write_config(changed)
        ids.add(self.snap()["provenance"]["config_id"])
        self.assertEqual(len(ids), 6)
        # A model name outside the plain pattern is recorded by its digest, never dropped; two different names differ.
        arns = []
        for arn in ("arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus", "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-opus"):
            changed = json.loads(json.dumps(config))
            changed["models"]["contracts"] = arn
            self.write_config(changed)
            snap = self.snap()["provenance"]
            self.assertEqual(snap["config"]["models"]["contracts"], "sha256:" + hashlib.sha256(arn.encode()).hexdigest())
            self.assertNotIn("123456789012", json.dumps(snap))
            arns.append(snap["config_id"])
        self.assertNotEqual(arns[0], arns[1])
        # The content is never recorded, only its digest.
        changed = json.loads(json.dumps(config))
        changed["tickets"] = {"provider": "jira", "url": "https://someone:secret@jira.example.com"}
        self.write_config(changed)
        self.assertNotIn("secret", json.dumps(self.snap()["provenance"]))

    def test_2_the_interpreter_path_does_not_change_the_tool_digest(self):
        digests = set()
        for python in ("/Users/alice/.venv/bin/python3", "/opt/homebrew/bin/python3.14", sys.executable):
            with mock.patch.object(provenance.sys, "executable", python):
                pol = {**POLICY, "allowed_tools": ["Workflow", "Read", f"Bash({python} *)"]}
                snap = self.snap(pol=pol)["provenance"]
            digests.add((snap["policy"]["allowed_tools_digest"], snap["config_id"]))
        self.assertEqual(len(digests), 1)

    def test_3_an_unreadable_folder_fails_the_capture_instead_of_a_partial_digest(self):
        hidden = self.plugin / "skills/build/references"
        hidden.mkdir()
        (hidden / "a.md").write_text("a\n")
        os.chmod(str(hidden), 0)
        self.addCleanup(os.chmod, str(hidden), 0o755)
        if os.access(str(hidden), os.R_OK):
            self.skipTest("running as a user who can read anything")
        self.assertEqual(self.snap(), {"provenance": None, "provenance_reason": "capture-failed"})

    def test_5_listing_is_bounded_by_entries_and_by_time(self):
        scripts = self.plugin / "skills/build/scripts"
        for n in range(50):
            (scripts / f"m{n}.pyc").write_bytes(b"x")  # skipped, but listed
        with mock.patch.object(provenance, "MAX_ENTRIES", 40):
            self.assertEqual(self.snap(), {"provenance": None, "provenance_reason": "capture-failed"})  # skipped entries count too
        clock = iter([0.0] + [10.0] * 10000)
        with mock.patch.object(provenance.time, "monotonic", lambda: next(clock)):
            self.assertEqual(self.snap(), {"provenance": None, "provenance_reason": "capture-failed"})  # past the deadline
        self.assertIsNotNone(self.snap()["provenance"])

    def test_6_canonical_numbers_freshness_veto_as_written(self):
        config = json.loads((ROOT / "templates/config.json").read_text())
        self.write_config(config)
        two = self.snap()["provenance"]
        config["factory"]["max_parallel"] = 3.0
        config["review"]["max_loops"] = 3.0
        self.write_config(config)
        self.assertEqual(self.snap()["provenance"]["config_id"], two["config_id"])  # 3 and 3.0 are the same setting
        self.assertEqual(self.snap(pol={**POLICY, "limits": {"max_parallel": 2.0}})["provenance"]["config_id"], two["config_id"])
        self.assertIsNone(two["config"]["review"]["security_veto"])  # not set: recorded as not set
        config["review"]["security_veto"] = True
        self.write_config(config)
        self.assertIs(self.snap()["provenance"]["config"]["review"]["security_veto"], True)
        # Freshness is judged by the later of mtime and ctime: a file whose time was set back but whose inode changed
        # just now is not trusted from the cache.
        path = self.plugin / "agents/builder.md"
        old = time.time() - 3600
        os.utime(str(path), (old, old))  # mtime an hour ago; ctime now
        info = path.stat()
        provenance._CACHE[str(path)] = ((info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino), time.time(), "f" * 64)
        self.assertEqual(self.snap()["provenance"]["line"]["files"]["agent:builder"], hashlib.sha256(b"Builder.\n").hexdigest())


FIXED_NOW = datetime.now(timezone.utc).replace(microsecond=0)  # held for every start in a test run; near the lease's own clock
FIXED_STAMP = FIXED_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")


class SupervisorTest(Base):
    def started(self):
        return next(e for e in self.events() if e["type"] == "execution.started")

    def test_the_snapshot_is_on_the_claim_record_and_the_started_event(self):
        self.supervised()
        report = self.tick()
        self.assertEqual([item["started"] for item in report["started"]], [True])
        self.wait()
        record = list(self.executions().values())[0]
        snap = record["provenance"]
        self.assertEqual(set(snap), TOP)
        self.assertNotIn("provenance_reason", record)
        started = self.started()
        self.assertEqual(started["data"]["provenance"], snap)  # the same object in both places
        self.assertNotIn("provenance_reason", started["data"])
        self.assertEqual((snap["mach"]["install"], snap["ticket"]["risk"], snap["policy"]["autonomy"]), ("plugin", self.cell("LOCAL-001").get("risk"), "supervised"))
        self.assertEqual(snap["source"]["commit"], started["source_commit"])
        self.assertEqual(snap["policy"]["allowed_tools_count"], len(policy.read(self.eng)["allowed_tools"]))
        text = json.dumps(snap)
        for never in (str(self.eng), str(ROOT), str(self.home), sys.executable, "Bash(", "Run the workflow named", "--allowedTools", "/"):
            self.assertNotIn(never, text)
        # Recorded once: later passes settle the execution and leave the snapshot as it was.
        self.tick()
        self.assertEqual(list(self.executions().values())[0]["provenance"], snap)

    def test_a_failing_capture_starts_the_execution_exactly_as_before(self):
        self.supervised()
        with mock.patch.object(provenance, "snapshot", side_effect=RuntimeError(f"{self.eng}/secret")):
            code, out, err = self.run_factory("tick")
        self.assertEqual(code, 0, err)
        report = json.loads(out)
        self.assertEqual([(item["ticket_id"], item["started"]) for item in report["started"]], [("LOCAL-001", True)])
        self.wait()
        self.assertEqual(len(self.calls()), 1)  # the run was started
        record = list(self.executions().values())[0]
        self.assertEqual((record["provenance"], record["provenance_reason"], record["state"]), (None, "capture-failed", "started"))
        started = self.started()
        self.assertEqual((started["data"]["provenance"], started["data"]["provenance_reason"]), (None, "capture-failed"))
        self.assertNotIn("secret", (self.eng / ".factory/intake/events.jsonl").read_text())

    def test_4_without_the_provenance_module_the_factory_still_starts_and_stops(self):
        """provenance.py missing (a partial install): tick starts the run, and status, pause, resume, stop and disable work."""
        self.supervised()
        script = ("import json, sys\n"
                  f"sys.path.insert(0, {str(SCRIPTS)!r})\n"
                  "sys.modules['provenance'] = None  # import provenance raises ImportError\n"
                  "import run\n"
                  "codes = []\n"
                  "for action in sys.argv[2:]:\n"
                  "    codes.append(run.main(['--project', sys.argv[1], 'factory', action]))\n"
                  "sys.stderr.write('CODES ' + json.dumps(codes) + '\\n')\n")
        done = subprocess.run([sys.executable, "-c", script, str(self.eng), "status", "tick"], capture_output=True, text=True, timeout=300)
        self.assertIn("CODES [0, 0]", done.stderr, done.stderr[-2000:])
        self.wait()
        record = list(self.executions().values())[0]
        self.assertEqual((record["state"], record["provenance"], record["provenance_reason"]), ("started", None, "capture-failed"))
        self.assertEqual((self.started()["data"]["provenance"], self.started()["data"]["provenance_reason"]), (None, "capture-failed"))
        self.assertEqual(len(self.calls()), 1)
        done = subprocess.run([sys.executable, "-c", script, str(self.eng), "pause", "resume", "stop", "disable", "status"], capture_output=True, text=True, timeout=300)
        self.assertIn("CODES [0, 0, 0, 0, 0]", done.stderr, done.stderr[-2000:])
        self.assertFalse(policy.read(self.eng)["enabled"])

    # ---- the supervisor's start, before and after ----

    def files(self):
        found = {}
        for path in sorted(self.eng.rglob("*")):
            relative = path.relative_to(self.eng)
            if ".git" in relative.parts or not path.is_file() or path.is_symlink():
                continue
            found[relative.as_posix()] = path.read_bytes()
        return found

    def start_once(self, sup, capture):
        """The supervisor's start() for LOCAL-001 with time, identifiers and the process launch held fixed."""
        ids = iter(uuid.UUID(int=n) for n in range(1, 100))
        with mock.patch.object(provenance, "capture", capture), mock.patch("secrets.token_hex", return_value="0123456789ab"), \
                mock.patch("uuid.uuid4", side_effect=lambda: next(ids)), mock.patch.object(supervisor, "now", return_value=FIXED_NOW), \
                mock.patch.object(intake, "now", return_value=FIXED_STAMP), mock.patch.object(executor, "now", return_value=FIXED_STAMP), \
                mock.patch.object(executor, "launch", return_value=424242) as launch:
            pol = sup.policy()
            sup.attach(pol)
            with sup.line.lock("supervisor"):
                ledger = sup.line.ledger()
                budget, over = sup.allowance(ledger, pol)
                self.assertIsNone(over)
                result = sup.start(ledger, pol, "LOCAL-001", "SLICE-001", budget)
        self.assertEqual(launch.call_count, 1, result)
        return result, self.files()

    def test_start_leaves_every_file_byte_identical_apart_from_the_added_field(self):
        self.supervised()
        with mock.patch.object(supervisor.Supervisor, "start", lambda self, ledger, pol, ticket, slice_id, budget_usd=None: {"ticket_id": ticket, "why": "held by the test"}):
            self.tick()  # dispatched, not started
        project = run.Project(self.eng)
        _, line = run.factory(project)
        sup = supervisor.Supervisor(project.root, project.config, line, next_step=lambda t: run.next_step(run.Project(self.eng), t, True),
                                    audit=project.audit, git=run.git, run_script=SCRIPTS / "run.py", workflow="mach:belt")
        sup.lease.runner_id = policy.read(self.eng)["runner_id"]
        sup.lease.acquire()
        self.addCleanup(sup.lease.release)
        backup = self.root / "backup"
        shutil.copytree(str(self.eng), str(backup), symlinks=True)

        def restore():
            shutil.rmtree(str(self.eng))
            shutil.copytree(str(backup), str(self.eng), symlinks=True)

        began = time.perf_counter()
        before_result, before = self.start_once(sup, lambda *args, **kwargs: {})  # exactly what start() did before provenance existed
        without_ms = (time.perf_counter() - began) * 1000
        restore()
        provenance._CACHE.clear()  # the first start of a supervisor process: nothing cached
        began = time.perf_counter()
        after_result, after = self.start_once(sup, provenance.capture)
        with_ms = (time.perf_counter() - began) * 1000
        restore()
        failed_result, failed = self.start_once(sup, lambda *args, **kwargs: {"provenance": None, "provenance_reason": "capture-failed"})
        sys.stderr.write(f"\nsupervisor start(): {without_ms:.1f} ms without provenance, {with_ms:.1f} ms with it (uncached)\n")

        self.assertEqual(before_result, after_result)
        self.assertEqual(before_result, failed_result)
        self.assertTrue(before_result["started"])
        for variant, added in ((after, {"provenance"}), (failed, {"provenance", "provenance_reason"})):
            self.assertEqual(sorted(variant), sorted(before))
            changed = sorted(name for name in before if before[name] != variant[name])
            self.assertEqual(changed, [".factory/intake/events.jsonl", ".factory/intake/ledger.json"])
            # The ledger: the execution's record gains the field(s), and nothing else changes, byte for byte.
            ledger = json.loads(variant[".factory/intake/ledger.json"])
            record = ledger["supervisor"]["executions"]["x0123456789ab"]
            self.assertEqual(set(record) - set(json.loads(before[".factory/intake/ledger.json"])["supervisor"]["executions"]["x0123456789ab"]), added)
            for key in added:
                record.pop(key)
            self.assertEqual(intake.canonical(ledger).encode("utf-8"), before[".factory/intake/ledger.json"])
            # The event log: only execution.started's data gains the field(s).
            old_lines = before[".factory/intake/events.jsonl"].decode().splitlines()
            new_lines = variant[".factory/intake/events.jsonl"].decode().splitlines()
            self.assertEqual(len(old_lines), len(new_lines))
            for old, new in zip(old_lines, new_lines):
                if old == new:
                    continue
                event = json.loads(new)
                self.assertEqual(event["type"], "execution.started")
                self.assertEqual(set(event["data"]) - set(json.loads(old)["data"]), added)
                for key in added:
                    event["data"].pop(key)
                self.assertEqual(json.dumps(event, sort_keys=True, ensure_ascii=False), old)
        # What the run was asked to do is the same, word for word.
        spec = ".factory/local/executions/x0123456789ab/spec.json"
        self.assertEqual(before[spec], after[spec])

    def test_scheduling_authorization_and_gates_are_untouched(self):
        """The supervisor refers to provenance in exactly one place, after every decision, and only records what it returns."""
        text = (SCRIPTS / "supervisor.py").read_text()
        self.assertEqual(text.count("provenance."), 1)
        self.assertEqual(len(re.findall(r"\bcontext\b", text)), 3)  # captured, added to the record, added to execution.started
        start = text.index("    def start(")
        call = text.index("provenance.capture(")
        for decided in ("self.authorize({})", "if not allowed:", "executor.plugin(self.root"):
            self.assertLess(start, text.index(decided, start))
            self.assertLess(text.index(decided, start), call)
        self.assertLess(call, text.index("executor.command(", start))
        for name in ("authorize", "schedule", "allowance", "budget", "tick", "recover", "finish", "risk_of"):
            body = text[text.index(f"    def {name}("):]
            body = body[:body.index("\n    def ", 1)]
            self.assertNotIn("provenance", body, name)
        source = (SCRIPTS / "provenance.py").read_text()
        for never in ("import supervisor", "import policy", "import intake", "import executor", ".write_", "open(\"w", "os.replace", "unlink", "rmtree",
                      "environ.get(\"ANTHROPIC", "argv"):
            self.assertNotIn(never, source)


if __name__ == "__main__":
    unittest.main()
