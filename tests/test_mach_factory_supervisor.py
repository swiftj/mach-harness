"""Acceptance tests for the Factory Supervisor (run.py factory ...).

Claude Code is replaced by a stand-in program on the PATH, so these tests are deterministic and
start no real agent. The stand-in records how it was called and, when told to, moves a cell's
stage the way a station would. A real end-to-end run is a separate, opt-in smoke test.
"""

import io
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "skills" / "run" / "scripts"
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(SCRIPTS))
import activation  # noqa: E402
import executor  # noqa: E402
import intake  # noqa: E402
import policy  # noqa: E402
import run  # noqa: E402
import service  # noqa: E402
import supervisor  # noqa: E402
from test_mach_product_collab import git  # noqa: E402
from test_mach_product_intake import Base as IntakeBase  # noqa: E402

FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, re, sys, time
# The run gets a minimal environment, so the stand-in finds its scenario and log by fixed paths, not variables.
argv = sys.argv[1:]
scenario = json.load(open("@@SCENARIO@@"))
if argv == ["--help"]:
    flags = ["--add-dir <directories...>", "--allowedTools, --allowed-tools <tools...>", "--disallowedTools, --disallowed-tools <tools...>",
             "--max-budget-usd <amount>", "--output-format <format>", "--permission-mode <mode>", "--permission-prompts <target>",
             "--plugin-dir <path>", "--restricted", "--session-id <uuid>", "--strict-mcp-config", "--tools <tools...>", "--verbose"]
    if scenario.get("help") == "old":  # a Claude Code from before restricted mode
        flags = [flag for flag in flags if not flag.startswith(("--restricted", "--permission-prompts"))]
    print("Usage: claude [options] [command] [prompt]\n\nOptions:\n" + "\n".join("  " + flag + "   what it does" for flag in flags))
    sys.exit(0)
prompt = argv[argv.index("-p") + 1]
with open("@@LOG@@", "a") as log:
    log.write(json.dumps({"argv": argv, "cwd": os.getcwd(), "env_wait": os.environ.get("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"), "env": dict(os.environ)}) + "\n")
if prompt.startswith("Reply with the single word READY"):
    if scenario.get("probe") == "fail":
        print(json.dumps({"type": "result", "is_error": True, "subtype": "error_auth", "result": None}))
        sys.exit(1)
    tools = argv[argv.index("--tools") + 1].split(",") if "--tools" in argv and argv[argv.index("--tools") + 1] else []
    print(json.dumps({"type": "system", "subtype": "init", "session_id": "probe", "permissionMode": argv[argv.index("--permission-mode") + 1],
                      "mcp_servers": scenario.get("probe_mcp", []), "tools": tools, "skills": ["mach:belt"] if "--plugin-dir" in argv else []}))
    print(json.dumps({"type": "result", "is_error": False, "subtype": "success", "result": "READY", "session_id": "probe"}))
    sys.exit(0)
args = json.loads(re.search(r"with args (\{.*?\})\. Use the Workflow tool", prompt).group(1))
session = argv[argv.index("--session-id") + 1]
print(json.dumps({"type": "system", "subtype": "init", "session_id": session}), flush=True)
tickets = []
for ticket in args["tickets"]:
    plan = scenario.get("tickets", {}).get(ticket, scenario.get("default", {}))
    for denied in plan.get("deny", []):
        print(json.dumps({"type": "system", "subtype": "permission_denied", "tool_name": denied["tool_name"], "tool_input": denied.get("tool_input")}), flush=True)
    if plan.get("hang"):
        time.sleep(600)
    time.sleep(plan.get("sleep", 0))
    if plan.get("stage"):
        path = os.path.join(".factory", "worktrees", ticket, "cell.json")
        cell = json.load(open(path))
        cell["stage"] = plan["stage"]
        json.dump(cell, open(path, "w"))
        repo = os.path.join(".factory", "worktrees", ticket, "repo")  # a station that got this far has built something
        built = os.path.join(repo, ticket.lower() + ".py")
        if not os.path.exists(built):
            open(built, "w").write("print('built')\n")
            import subprocess
            subprocess.run(["git", "add", "-A"], cwd=repo, capture_output=True)
            subprocess.run(["git", "-c", "user.name=line", "-c", "user.email=line@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "build"], cwd=repo, capture_output=True)
    if plan.get("vanish"):
        os._exit(7)
    tickets.append({"ticket": ticket, "outcome": "stopped", "stage": plan.get("stage", ""), "waiting_for": "merge"})
result = {"type": "result", "subtype": "success" if not plan.get("is_error") else "error_during_execution", "is_error": bool(plan.get("is_error")),
          "session_id": session, "total_cost_usd": plan.get("cost", 0.5), "permission_denials": [],
          "result": json.dumps({"tickets": tickets, "waiting_on_a_person": [], "finished": [], "problems": []})}
print(json.dumps(result), flush=True)
sys.exit(plan.get("exit", 0))
'''
OS_ADDED_ENV = {"__CF_USER_TEXT_ENCODING"}  # macOS adds this to every process itself; it is not passed by the wrapper
FAKE_LAUNCHCTL = r'''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["FAKE_LAUNCHCTL_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\n")
'''


class Base(IntakeBase):
    def setUp(self):
        super().setUp()
        self.bin = self.root / "bin"
        self.scenario = self.root / "claude-scenario.json"
        self.claude_log = self.root / "claude.log"
        for name, text in (("claude", FAKE_CLAUDE.replace("@@SCENARIO@@", str(self.scenario)).replace("@@LOG@@", str(self.claude_log))), ("launchctl", FAKE_LAUNCHCTL)):
            path = self.bin / name
            path.write_text(text.replace("#!/usr/bin/env python3", "#!" + sys.executable, 1))
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
        self.launchctl_log = self.root / "launchctl.log"
        self.home = self.root / "home"
        self.home.mkdir()
        os.environ.update({"FAKE_CLAUDE_SCENARIO": str(self.scenario), "FAKE_CLAUDE_LOG": str(self.claude_log),
                           "FAKE_LAUNCHCTL_LOG": str(self.launchctl_log), "HOME": str(self.home)})
        for clone in (self.eng, self.a, self.b):  # HOME moved, so each clone carries its own identity
            git(clone, "config", "commit.gpgsign", "false")
        self.claude({"default": {"stage": "approved"}})
        self.config(build={"require_audit": False})
        self.addCleanup(self.end_executions)

    # ---- helpers ----

    def claude(self, scenario):
        self.scenario.write_text(json.dumps(scenario))

    def config(self, **sections):
        path = self.eng / ".factory/config.json"
        data = json.loads(path.read_text())
        data.update(sections)
        path.write_text(json.dumps(data))

    def calls(self, runs_only=True):
        if not self.claude_log.exists():
            return []
        found = [json.loads(line) for line in self.claude_log.read_text().splitlines()]
        return [call for call in found if not runs_only or "READY" not in call["argv"][1]]

    def run_factory(self, *argv, project=None):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(project or self.eng), "factory", *argv])
        return code, out.getvalue(), err.getvalue()

    def factory(self, *argv, project=None):
        code, out, err = self.run_factory(*argv, project=project)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def refused_factory(self, *argv):
        code, out, err = self.run_factory(*argv)
        self.assertEqual(code, 1, out)
        return err + out

    def enable(self, *flags, autonomy="supervised"):
        code, out, err = self.run_factory("enable", "--autonomy", autonomy, *flags)
        asked = json.loads(out)
        self.assertTrue(asked.get("ready"), out + err)
        return self.factory("enable", "--confirm", asked["confirm_with"])

    def tick(self):
        return self.factory("tick")

    def local(self, name):
        return self.eng / ".factory/local" / name

    def executions(self):
        return self.ledger()["supervisor"]["executions"]

    def wait(self, seconds=30):
        """Until every started execution has left a result."""
        deadline = time.time() + seconds
        while time.time() < deadline:
            live = [key for key, record in self.executions().items() if record["state"] in ("claimed", "started")
                    and not (self.local("executions") / key / "result.json").exists()]
            if not live:
                return
            time.sleep(0.1)
        self.fail("executions did not end: " + ", ".join(live))

    def end_executions(self):
        """Leave no stand-in process behind, whatever state a test ended in."""
        folder = self.local("executions")
        pids = []
        try:
            pids += [record.get("wrapper_pid") for record in self.executions().values()]
        except (OSError, ValueError, KeyError):
            pass
        for started in folder.glob("*/started.json") if folder.is_dir() else []:
            data = json.loads(started.read_text())
            pids += [data.get("child_pid"), data.get("wrapper_pid")]
        for home in folder.glob("*") if folder.is_dir() else []:
            if (home / "result.json").exists():
                continue
            for pid in pids:
                if isinstance(pid, int) and (executor.alive(pid, home.name) or "claude" in executor.command_of(pid)):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except OSError:
                        pass
        deadline = time.time() + 5
        while time.time() < deadline and any(isinstance(pid, int) and supervisor.pid_alive(pid) and "factory exec" in executor.command_of(pid) for pid in pids):
            time.sleep(0.1)

    def kinds(self, since=0):
        return [event["type"] for event in self.events(since)]

    def supervised(self, *flags):
        """A merged wave with SLICE-001, and Supervised Autopilot enabled."""
        self.first()
        return self.enable("--include-backlog", *flags)


class ActivationTest(Base):
    def test_a_fresh_clone_is_disabled_and_asking_changes_nothing(self):
        self.first()
        for project in (self.eng, self.a):
            for _ in range(2):
                status = self.factory("status", project=project)
                self.assertEqual((status["factory"], status["enabled_here"], status["policy"], status["factory_started"]), ("disabled", False, None, False))
            self.assertFalse((project / ".factory/local").exists())
            self.assertEqual(policy.read(project)["source"], "default-disabled")
        self.assertEqual(self.tick()["state"], "disabled")
        self.assertEqual(self.calls(runs_only=False), [])
        self.assertEqual(self.tickets(), [])  # a disabled Factory does not even take work in
        self.assertFalse((self.eng / ".factory/intake").exists())

    def test_enable_shows_what_it_would_do_and_needs_the_code(self):
        self.first()
        code, out, _ = self.run_factory("enable", "--autonomy", "supervised", "--include-backlog", "--max-parallel", "1")
        asked = json.loads(out)
        self.assertEqual((code, asked["ready"], asked["enabled"]), (0, True, False))
        self.assertFalse(self.local("runner.json").exists())  # nothing is enabled by asking
        self.assertEqual(self.factory("status")["factory"], "disabled")
        would = asked["would_enable"]
        self.assertEqual((would["autonomy"], would["limits"]["max_parallel"], would["work_already_here"][0]["slice_id"]), ("supervised", 1, "SLICE-001"))
        self.assertIn("Never merges", would["merges"])
        self.assertIn(f"Bash({sys.executable} *)", would["tools_each_execution_may_use"])
        self.assertIn("run this repository's tests", would["runs_repository_code"])
        self.assertIn("restricted mode", would["execution_boundary"])
        self.assertIn("not a sandbox", would["execution_boundary"])
        ready = next(item for item in asked["checks"] if item["check"] == "claude_ready")
        self.assertIn("inside the execution boundary", ready["detail"])  # the probe ran with the execution's own flags
        self.assertTrue(all(item["ok"] for item in asked["checks"] if item["required"]))
        self.assertIn("not the confirmation code", self.refused_factory("enable", "--confirm", "000000"))
        self.assertFalse(self.local("runner.json").exists())
        done = self.factory("enable", "--confirm", asked["confirm_with"])
        self.assertEqual((done["enabled"], done["factory"], done["policy"]["limits"]["max_parallel"], done["policy"]["allow_merge"]), (True, "supervised", 1, False))
        self.assertEqual(done["policy"]["enabled_by"], "Erin Engineer")
        self.assertEqual(stat.S_IMODE(self.local("runner.json").stat().st_mode), 0o600)
        self.assertEqual(subprocess.run(["git", "status", "--porcelain"], cwd=str(self.eng), capture_output=True, text=True).stdout, "")  # never visible to Git
        self.assertIn("Nothing is waiting to be confirmed", self.refused_factory("enable", "--confirm", asked["confirm_with"]))  # a code works once
        self.assertIn("already enabled", self.refused_factory("enable"))
        self.assertEqual(self.kinds().count("factory.activated"), 1)

    def test_a_confirmation_expires(self):
        self.first()
        asked = json.loads(self.run_factory("enable", "--autonomy", "observe")[1])
        pending = json.loads(self.local("pending-enable.json").read_text())
        pending["expires_at"] = "2026-01-01T00:00:00Z"
        self.local("pending-enable.json").write_text(json.dumps(pending))
        self.assertIn("expired", self.refused_factory("enable", "--confirm", asked["confirm_with"]))
        self.assertFalse(self.local("runner.json").exists())

    def test_preflight_failures_give_no_code(self):
        self.first()
        cases = [
            (lambda: self.config(build={"require_audit": True}), "audit", "no readiness audit report"),
            (lambda: self.claude({"probe": "fail"}), "claude_ready", "reported an error"),
            # A Claude Code without restricted mode cannot keep the person's own settings, plugins and MCP servers out of a run.
            (lambda: self.claude({"help": "old"}), "claude_ready", "lacks --restricted, --permission-prompts"),
            (lambda: self.claude({"probe_mcp": [{"name": "gmail", "status": "connected"}]}), "claude_ready", "MCP servers were loaded"),
            (lambda: self.config(review={"security_veto": False}), "security_review", "could be outvoted"),
            (lambda: self.config(factory={"supervisor": False}), "project_allows", "not allowed here"),
            (lambda: self.local("supervisor.json").parent.mkdir(exist_ok=True) or self.local("supervisor.json").write_text(json.dumps(
                {"instance": "other", "runner_id": "r", "pid": os.getpid(), "host": supervisor.platform.node(), "heartbeat_at": "x", "expires_at": "2099-01-01T00:00:00Z"})),
             "ownership", "Another supervisor"),
        ]
        for break_it, name, words in cases:
            with self.subTest(check=name):
                self.config(build={"require_audit": False}, review={}, factory={"max_parallel": 3})
                self.claude({"default": {"stage": "approved"}})
                if self.local("supervisor.json").exists():
                    self.local("supervisor.json").unlink()
                break_it()
                code, out, _ = self.run_factory("enable", "--autonomy", "supervised", "--include-backlog")
                asked = json.loads(out)
                self.assertEqual((code, asked["ready"]), (1, False))
                self.assertNotIn("confirm_with", asked)
                self.assertEqual([item["check"] for item in asked["failed"]], [name])
                self.assertIn(words, asked["failed"][0]["detail"])
                self.assertFalse(self.local("runner.json").exists())
                self.assertFalse(self.local("pending-enable.json").exists())

    def test_wrong_branch_and_bad_limits(self):
        self.first()
        self.assertIn("must be a number from 1 to 8", self.refused_factory("enable", "--max-parallel", "50"))
        git(self.eng, "switch", "-q", "-c", "elsewhere")
        asked = json.loads(self.run_factory("enable", "--autonomy", "supervised", "--include-backlog")[1])
        self.assertEqual([item["check"] for item in asked["failed"]], ["checkout"])

    def test_work_already_here_needs_a_decision(self):
        self.first()
        code, out, _ = self.run_factory("enable", "--autonomy", "supervised")
        asked = json.loads(out)
        self.assertEqual((code, asked["ready"]), (1, False))
        self.assertIn("--include-backlog", asked["why"])
        self.assertEqual([item["slice_id"] for item in asked["would_enable"]["work_already_here"]], ["SLICE-001"])
        self.assertNotIn("confirm_with", asked)
        self.enable("--exclude-backlog")
        self.assertEqual(policy.read(self.eng)["excluded_slices"], ["SLICE-001"])
        report = self.tick()
        self.assertEqual(self.tickets(), ["LOCAL-001"])  # taken in, as a ticket
        self.assertEqual((report["dispatched"], report["started"]), ([], []))
        self.assertIn("left to the engineer", report["held"][0]["why"])
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.product("dispatch", "SLICE-001")["tickets"], ["LOCAL-001"])  # the engineer still can
        # New work that arrives after activation is the supervisor's.
        self.publish(self.a, self.slice(self.a, "Arrived later"))
        report = self.tick()
        self.assertEqual([item["slice_id"] for item in report["dispatched"]], ["SLICE-002"])

    def test_authorization_does_not_travel(self):
        self.supervised()
        good = self.local("runner.json").read_text()
        # Copied to a product manager's clone of the same repository, on the same machine.
        (self.a / ".factory/local").mkdir(parents=True)
        (self.a / ".factory/local/runner.json").write_text(good)
        os.chmod(str(self.a / ".factory/local/runner.json"), 0o600)
        read = policy.read(self.a)
        self.assertEqual((read["enabled"], read["source"]), (False, "invalid-file"))
        self.assertIn("different folder", read["problems"][0])
        self.assertEqual(self.factory("status", project=self.a)["factory"], "disabled")
        cases = {"another machine": lambda d: d.update(machine="someone-elses-macbook"), "version": lambda d: d.update(schema_version=1),
                 "every shell command": lambda d: d.update(allowed_tools=["Bash"]), "limit": lambda d: d["limits"].update(max_parallel=99),
                 "autonomy": lambda d: d.update(autonomy="extended")}
        for words, change in cases.items():
            with self.subTest(words=words):
                data = json.loads(good)
                change(data)
                self.local("runner.json").write_text(json.dumps(data))
                read = policy.read(self.eng)
                self.assertEqual((read["enabled"], read["source"]), (False, "invalid-file"), words)
                self.assertEqual(self.tick()["state"], "disabled")
        self.local("runner.json").write_text(good)
        os.chmod(str(self.local("runner.json")), 0o664)
        self.assertIn("other users", policy.read(self.eng)["problems"][0])
        os.chmod(str(self.local("runner.json")), 0o600)
        self.assertTrue(policy.read(self.eng)["enabled"])
        self.assertEqual(self.calls(), [])

    def test_product_studio_cannot_activate_the_factory(self):
        """A product manager's whole workflow, including publishing, leaves every machine's Factory as it was."""
        self.first()
        self.ok(self.b, "refresh")
        self.publish(self.b, self.slice(self.b, "Ben's"))
        self.ok(self.a, "feedback")
        for project in (self.a, self.b):
            self.assertFalse((project / ".factory/local").exists())
            self.assertEqual(self.factory("status", project=project)["factory"], "disabled")
        tracked = git(self.origin, "ls-tree", "-r", "--name-only", "main").split()
        self.assertEqual([name for name in tracked if ".factory/local" in name or "runner" in name], [])
        studio_sources = "".join((ROOT / "skills/product-studio/scripts" / name).read_text() for name in ("studio.py", "collab.py"))
        for word in ("policy.py", "import policy", "activation", "factory enable", ".factory/local"):
            self.assertNotIn(word, studio_sources)


class ObserveTest(Base):
    def test_observe_discovers_and_plans_and_never_starts_an_agent(self):
        self.first()
        done = self.enable(autonomy="observe")
        self.assertEqual(done["policy"]["allowed_tools"][0], "Workflow")
        self.assertEqual(self.calls(runs_only=False), [])  # observe does not even need Claude to answer
        for _ in range(3):
            report = self.tick()
            self.assertEqual((report["state"], report["dispatched"], report["started"], report["factory_started"]), ("observe", [], [], False))
        self.assertEqual(self.tickets(), ["LOCAL-001"])
        self.assertEqual(report["held"], [{"slice_id": "SLICE-001", "why": "the Factory is in observe mode, which never starts work"}])
        self.assertFalse((self.eng / ".factory/worktrees").exists())
        self.assertEqual(self.calls(runs_only=False), [])
        self.assertEqual(self.kinds().count("scheduling.decided"), 1)  # said once, not on every pass
        self.assertEqual(self.factory("status")["plan"]["dispatchable"], ["SLICE-001"])


class SupervisedTest(Base):
    def test_supervised_runs_approved_eligible_work_and_stops_at_the_gate(self):
        self.supervised()
        report = self.tick()
        self.assertEqual((report["state"], report["factory_started"]), ("supervised", True))
        self.assertEqual(report["dispatched"], [{"slice_id": "SLICE-001", "ticket_id": "LOCAL-001"}])
        self.assertEqual([(item["ticket_id"], item["started"]) for item in report["started"]], [("LOCAL-001", True)])
        self.wait()
        call = self.calls()[0]
        argv = call["argv"]
        self.assertEqual((Path(call["cwd"]).resolve(), call["env_wait"]), (self.eng.resolve(), "0"))
        self.assertEqual(argv[1], 'Run the workflow named mach:belt with args {"tickets": ["LOCAL-001"], "until": "merge"}. Use the Workflow tool. '
                                  "When it has finished, reply with only the JSON it returned. If you are refused, say so and stop.")
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "default")  # the tool list is a real limit, whatever this machine's own settings
        self.assertEqual(argv[argv.index("--output-format") + 1], "stream-json")
        self.assertEqual(argv[argv.index("--max-budget-usd") + 1], "25")
        # The person's own settings, plugins, MCP servers and hooks stay out; MACH (here, this repository as a plugin) is the only plugin.
        self.assertEqual(argv[argv.index("-p") + 2:argv.index("--max-budget-usd")],
                         ["--output-format", "stream-json", "--verbose", "--restricted", "--strict-mcp-config", "--plugin-dir", str(ROOT),
                          "--permission-mode", "default", "--permission-prompts", "none", "--tools", "Workflow,Skill,Agent,Read,Write,Edit,Glob,Grep,Bash",
                          "--add-dir", str(ROOT), "--disallowedTools", f"Edit(/{ROOT}/**)", f"Edit(/{self.eng}/.factory/local/**)", f"Edit(/{self.eng}/.claude/**)"])
        tools = argv[argv.index("--allowedTools") + 1:]
        self.assertEqual(tools, policy.read(self.eng)["allowed_tools"])  # exactly what the person consented to, and last
        self.assertIn(f"Bash({sys.executable} *)", tools)
        self.assertFalse([part for part in argv if "dangerously" in part or part in ("Bash", "Bash(*)", "bypassPermissions", "--bare", "--setting-sources")])
        allowed_env = set(executor.PASSED_ENV) | set(executor.PROXY_ENV) | set(executor.ENV) | {executor.EXECUTION_ENV}
        self.assertTrue(set(call["env"]) - OS_ADDED_ENV <= allowed_env, sorted(call["env"]))
        self.assertEqual((call["env"]["HOME"], call["env"]["GIT_TERMINAL_PROMPT"]), (str(self.home), "0"))
        record = list(self.executions().values())[0]
        # M6.1: the run carries its own execution ID, so the station scripts it starts stamp their lifecycle records with it.
        self.assertEqual(call["env"][executor.EXECUTION_ENV], record["execution_id"])
        self.assertEqual(argv[argv.index("--session-id") + 1], record["session_id"])
        self.assertEqual((record["stage_at_start"], record["action_at_start"], record["until"], record["attempt"]), ("spec-ready", "plan", "merge", 1))
        # The next pass reads the cell's own record of where the ticket stands.
        report = self.tick()
        self.assertEqual(report["recovered"], [{"execution_id": record["execution_id"], "ticket_id": "LOCAL-001", "found": "ended"}])
        self.assertEqual((report["started"], report["running"], report["needs_person"]), ([], [], ["SLICE-001"]))
        record = list(self.executions().values())[0]
        self.assertEqual((record["state"], record["how"], record["stage_at_end"], record["next_at_end"], record["moved"], record["cost_usd"]),
                         ("finished", "exited", "approved", "stop", True, 0.5))
        kinds = self.kinds()
        for kind in ("factory.activated", "revision.discovered", "wave.discovered", "intake.validated", "slice.materialized", "work.scheduled", "scheduling.decided",
                     "work.claimed", "execution.started", "station.observed", "execution.completed", "human.required"):
            self.assertIn(kind, kinds)
        self.assertLess(kinds.index("work.claimed"), kinds.index("execution.started"))  # claimed, durably, before anything ran
        scheduled = next(e for e in self.events() if e["type"] == "work.scheduled")
        self.assertEqual((scheduled["source"], scheduled["data"]["by"], scheduled["runner_id"]), ("supervisor", "supervisor", policy.read(self.eng)["runner_id"]))
        completed = next(e for e in self.events() if e["type"] == "execution.completed")
        self.assertEqual((completed["execution_id"], completed["data"]["stage"], completed["data"]["waiting_for"], completed["refs"]["cell"]),
                         (record["execution_id"], "approved", "merge", ".factory/worktrees/LOCAL-001/cell.json"))
        # Further passes do nothing: the ticket waits for a person to merge it.
        for _ in range(2):
            self.assertEqual(self.tick()["started"], [])
        self.assertEqual(len(self.calls()), 1)

    def test_an_approved_ticket_waits_for_a_person_to_merge_and_is_said_once(self):
        """Where the project lets the line merge, an unattended run still stops before merging unless this machine allowed it."""
        self.first()
        self.config(build={"require_audit": False}, merge={"mode": "auto", "method": "local"})
        self.enable("--include-backlog")
        self.claude({"default": {"stage": "approved", "deny": [{"tool_name": "Bash", "tool_input": {"command": "cd /tmp && ls"}}]}})
        self.tick()
        self.wait()
        seq = len(self.events())
        for _ in range(3):
            report = self.tick()
            self.assertEqual(report["started"], [])
            self.assertEqual(report["held"], [{"ticket_id": "LOCAL-001", "slice_id": "SLICE-001", "why": "it is approved and waits for a person to merge it"}])
        self.assertEqual(run.next_step(run.Project(self.eng), "LOCAL-001", True)["action"], "merge")  # the project would have merged it
        self.assertEqual((len(self.calls()), len(self.executions())), (1, 1))  # no claim is made and thrown away on every pass
        told = [e for e in self.events(seq) if e["type"] == "human.required"]
        self.assertEqual([e["data"]["reason"] for e in told], ["It is approved. This machine does not merge unattended, so a person merges it."])
        completed = next(e for e in self.events() if e["type"] == "execution.completed")
        self.assertEqual(completed["data"]["refused_tools"], ["Bash: cd"])  # refusals the workers got past are reported, not hidden
        self.assertEqual(self.ledger()["supervisor"]["parked"], {})

    def test_repeated_passes_and_notifications_never_duplicate_work(self):
        self.supervised("--hooks")
        self.claude({"default": {"sleep": 2, "stage": "approved"}})
        for _ in range(5):
            self.assertEqual(self.run_factory("wake", "--event", "post-merge")[0], 0)
        first = self.tick()
        for _ in range(3):
            again = self.tick()
            self.assertEqual((again["dispatched"], again["started"], again["running"]), ([], [], ["LOCAL-001"]))
            self.factory("status")
        self.wait()
        for _ in range(2):
            self.tick()
        self.assertEqual((self.tickets(), len(self.executions()), len(self.calls())), (["LOCAL-001"], 1, 1))
        self.assertEqual(git(self.eng, "worktree", "list").count("\n"), 2)
        kinds = self.kinds()
        self.assertEqual((kinds.count("slice.materialized"), kinds.count("work.scheduled"), kinds.count("execution.started")), (1, 1, 1))
        self.assertEqual(len(first["started"]), 1)

    def test_missing_audit_policy_or_human_approval_prevents_dispatch(self):
        self.supervised()
        self.config(build={"require_audit": True})  # the audit report is missing
        report = self.tick()
        self.assertEqual((report["dispatched"], report["started"]), ([], []))
        self.assertIn("the readiness audit is missing", report["held"][0]["why"])
        self.assertFalse((self.eng / ".factory/worktrees").exists())
        self.config(build={"require_audit": False})
        self.claude({"default": {"stage": "awaiting-human"}})
        self.tick()
        self.wait()
        report = self.tick()  # the panel approved a change that needs a person: the supervisor never approves for them
        self.assertEqual((report["started"], report["needs_person"]), ([], ["SLICE-001"]))
        self.assertEqual(self.cell("LOCAL-001")["stage"], "awaiting-human")
        self.assertEqual(len(self.calls()), 1)
        self.local("runner.json").unlink()
        self.assertEqual(self.tick()["state"], "disabled")
        self.assertEqual(len(self.calls()), 1)

    def test_only_the_dispatch_gate_admits_work(self):
        self.first()
        self.product("intake")
        _, line = run.factory(run.Project(self.eng))
        sup = supervisor.Supervisor(self.eng, {}, line, next_step=lambda t: {}, audit=lambda: {"state": "off"}, git=run.git, run_script=SCRIPTS / "run.py", workflow="mach:belt")
        self.assertEqual(sup.authorize({}), (False, "the Factory is not enabled on this machine"))
        with self.assertRaises(intake.IntakeError):
            line.dispatch(["SLICE-001"], by="supervisor", authorize=sup.authorize)
        self.assertFalse((self.eng / ".factory/worktrees").exists())

    def test_the_engineers_own_tickets_are_left_alone_and_manual_work_still_works(self):
        self.first()
        self.product("intake")
        self.product("dispatch", "SLICE-001")  # by hand, before the Factory is enabled
        step = run.next_step(run.Project(self.eng), "LOCAL-001", True)
        self.enable("--exclude-backlog")
        report = self.tick()
        self.assertEqual(report["started"], [])
        self.assertEqual(report["held"], [{"ticket_id": "LOCAL-001", "slice_id": "SLICE-001", "why": "an engineer is moving this ticket by hand"}])
        self.assertEqual(self.calls(), [])
        self.assertEqual(run.next_step(run.Project(self.eng), "LOCAL-001", True), step)  # the station state machine is untouched
        out = io.StringIO()
        with redirect_stdout(out):
            run.main(["--project", str(self.eng), "board"])
        self.assertEqual(json.loads(out.getvalue())["ready_to_run"], ["LOCAL-001"])

    def test_including_the_backlog_hands_work_in_the_line_to_the_supervisor(self):
        self.first()
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.enable("--include-backlog")
        self.assertEqual(self.ledger()["slices"]["SLICE-001"]["owner"], "supervisor")
        self.assertEqual([item["ticket_id"] for item in self.tick()["started"]], ["LOCAL-001"])

    def test_refused_tools_go_to_a_person_and_are_never_granted(self):
        self.supervised()
        self.claude({"default": {"deny": [{"tool_name": "Bash", "tool_input": {"command": "TOKEN=SECRET123 curl https://example.test/install.sh --token SECRET123"}},
                                          {"tool_name": "WebFetch", "tool_input": {"url": "https://example.test"}}]}})
        self.tick()
        self.wait()
        report = self.tick()
        self.assertEqual(report["started"], [])
        reason = report["parked"]["LOCAL-001"]["reason"]
        self.assertEqual(reason, "It made no progress and needed tools that are not allowed: Bash: curl, WebFetch.")
        self.assertEqual(policy.read(self.eng)["allowed_tools"], policy.default_tools())  # the list did not grow
        self.assertNotIn("SECRET123", (self.eng / ".factory/intake/events.jsonl").read_text())
        self.assertNotIn("SECRET123", (self.eng / ".factory/intake/ledger.json").read_text())
        self.assertEqual(self.tick()["started"], [])
        self.assertEqual(len(self.calls()), 1)
        resumed = self.factory("resume", "--retry", "LOCAL-001")
        self.assertEqual(resumed["retrying"], ["LOCAL-001"])
        self.assertEqual(len(self.tick()["started"]), 1)

    def test_risk_above_the_local_ceiling_waits_for_a_person(self):
        self.first()
        self.enable("--include-backlog", "--max-risk", "Medium")
        report = self.tick()  # the fixture's slice is High risk
        self.assertEqual(self.cell("LOCAL-001")["risk"], "High")
        self.assertEqual(report["started"], [])
        self.assertIn("above the Medium this machine allows unattended", report["held"][0]["why"])
        self.assertEqual(self.calls(), [])


class LimitsTest(Base):
    def waves(self, count):
        self.first()
        for index in range(count - 1):
            self.publish(self.a, self.slice(self.a, f"Slice {index + 2}"))

    def test_places_are_limited(self):
        self.waves(3)
        self.claude({"default": {"sleep": 2, "stage": "approved"}})
        self.enable("--include-backlog", "--max-parallel", "1")
        report = self.tick()
        self.assertEqual(([item["slice_id"] for item in report["dispatched"]], [item["ticket_id"] for item in report["started"]]), (["SLICE-001"], ["LOCAL-001"]))
        again = self.tick()
        self.assertEqual((again["dispatched"], again["started"], again["running"]), ([], [], ["LOCAL-001"]))
        self.assertEqual(sorted(p.name for p in (self.eng / ".factory/worktrees").iterdir()), ["LOCAL-001"])  # the others were not even dispatched
        self.wait()
        self.assertEqual(len(self.calls()), 1)

    def test_the_project_can_restrict_but_never_widen(self):
        self.waves(3)
        self.claude({"default": {"sleep": 2, "stage": "approved"}})
        self.enable("--include-backlog", "--max-parallel", "2")
        self.config(factory={"max_parallel": 8, "max_runs_per_day": 500, "max_risk": "High", "supervisor": True, "autonomy_ceiling": "extended", "allow_merge": True,
                             "allowed_tools": ["Bash"], "enabled": True})  # tracked settings asking for more than the machine granted
        effective = policy.effective(policy.read(self.eng), json.loads((self.eng / ".factory/config.json").read_text()))
        self.assertEqual((effective["limits"]["max_parallel"], effective["allow_merge"], effective["allowed_tools"], effective["restricted_by_project"]),
                         (2, False, policy.default_tools(), []))
        self.assertEqual(len(self.tick()["started"]), 2)
        self.wait()
        self.assertNotIn("Bash", self.calls()[0]["argv"][self.calls()[0]["argv"].index("--allowedTools") + 1:])
        self.config(factory={"max_parallel": 1, "autonomy_ceiling": "observe"})
        effective = policy.effective(policy.read(self.eng), json.loads((self.eng / ".factory/config.json").read_text()))
        self.assertEqual((effective["limits"]["max_parallel"], effective["autonomy"]), (1, "observe"))
        self.assertEqual(self.tick()["state"], "observe")
        self.config(factory={"supervisor": False})
        report = self.tick()
        self.assertEqual(report["state"], "disabled")
        self.assertIn("does not allow unattended execution", report["why"])

    def test_runs_and_money_per_day_are_limited(self):
        self.waves(2)
        self.enable("--include-backlog", "--max-runs-per-day", "1")
        report = self.tick()
        self.assertEqual(len(report["started"]), 1)
        self.assertIn("limit of 1 executions in 24 hours", json.dumps(report["held"]))
        self.wait()
        self.assertEqual(self.tick()["started"], [])  # the first run is settled; the second still waits for tomorrow
        self.factory("disable")
        self.enable("--include-backlog", "--budget-per-day", "1")
        ledger = self.ledger()
        for record in ledger["supervisor"]["executions"].values():
            record["cost_usd"] = 1.5
        (self.eng / ".factory/intake/ledger.json").write_text(json.dumps(ledger))
        report = self.tick()
        self.assertEqual(report["started"], [])
        self.assertIn("limit of $1 in 24 hours is reached ($1.50 spent;", json.dumps(report["held"]))

    def budgets(self):
        return [call["argv"][call["argv"].index("--max-budget-usd") + 1] for call in self.calls()]

    def test_a_run_is_given_no_more_than_the_day_has_left(self):
        # D21 (M6.2 acceptance): a day limit of $5.50, a first run that cost $1.68, and the next run was still given $5.
        self.first()
        self.claude({"default": {"stage": "approved", "cost": 1.68}})
        self.enable("--include-backlog", "--max-parallel", "2", "--budget-per-run", "5", "--budget-per-day", "5.5")
        self.assertEqual(len(self.tick()["started"]), 1)
        self.wait()
        self.publish(self.a, self.slice(self.a, "Slice 2"))
        report = self.tick()  # settles the first run ($1.68 spent), then starts the second
        self.assertEqual([item["ticket_id"] for item in report["started"]], ["LOCAL-002"])
        self.wait()
        self.assertEqual(self.budgets(), ["5", "3.82"])  # 5.50 - 1.68, never the whole $5
        second = [r for r in self.executions().values() if r["ticket_id"] == "LOCAL-002"][0]
        self.assertEqual(second["budget_usd"], 3.82)
        started = [e for e in self.events() if e["type"] == "execution.started"]
        self.assertEqual([e["data"]["limits"]["budget_usd"] for e in started], [5, 3.82])

    def test_runs_started_in_one_pass_never_add_up_to_more_than_the_day(self):
        self.waves(3)
        self.claude({"default": {"sleep": 2, "stage": "approved"}})
        self.enable("--include-backlog", "--max-parallel", "3", "--budget-per-run", "3", "--budget-per-day", "5.5")
        report = self.tick()
        self.assertEqual(len(report["started"]), 2)
        # The first two hold $3 and $2.50 between them while they run; nothing is left for a third.
        self.assertIn("limit of $5.5 in 24 hours is reached ($0.00 spent, $5.50 committed to executions still running or of unknown cost; "
                      "a run is not started with less than $1)", json.dumps(report["held"]))
        self.wait()
        self.assertEqual(self.budgets(), ["3", "2.5"])
        self.assertLessEqual(sum(float(budget) for budget in self.budgets()), 5.5)

    def test_too_little_left_to_start_is_the_daily_budget_reached(self):
        self.waves(2)
        self.claude({"default": {"sleep": 2, "stage": "approved"}})
        self.enable("--include-backlog", "--max-parallel", "2", "--budget-per-run", "5", "--budget-per-day", "5.5")
        report = self.tick()
        self.assertEqual(len(report["started"]), 1)  # $0.50 would be left for the second: below the $1 a run is started with
        self.assertIn("limit of $5.5 in 24 hours is reached ($0.00 spent, $5.00 committed", json.dumps(report["held"]))
        self.wait()
        self.assertEqual(self.budgets(), ["5"])

    def test_an_execution_of_unknown_cost_counts_at_the_limit_it_was_given(self):
        self.supervised("--budget-per-run", "4", "--budget-per-day", "6")
        ledger = {"supervisor": {"executions": {
            "x000000000001": {"state": "unknown", "started_at": supervisor.stamp(), "cost_usd": None, "budget_usd": 4},
            "x000000000002": {"state": "finished", "started_at": supervisor.stamp(), "cost_usd": 1.25, "budget_usd": 4},
            "x000000000003": {"state": "finished", "started_at": "2000-01-01T00:00:00Z", "cost_usd": 400, "budget_usd": 4},  # another day
            "x000000000004": {"state": "released", "started_at": None, "budget_usd": 4},  # claimed and given back: never ran
        }}}
        pol = policy.read(self.eng)
        allowance = supervisor.Supervisor.allowance
        budget, why = allowance(None, ledger, pol)
        self.assertEqual((budget, why), (None, "the limit of $6 in 24 hours is reached ($1.25 spent, $4.00 committed to executions still running or of "
                                               "unknown cost; a run is not started with less than $1)"))
        ledger["supervisor"]["executions"]["x000000000001"].update({"state": "finished", "cost_usd": 0.5})
        self.assertEqual(allowance(None, ledger, pol), (4, None))  # 6 - 1.75 leaves more than the per-run limit
        ledger["supervisor"]["executions"]["x000000000005"] = {"state": "claimed", "started_at": None}  # an older claim without a recorded budget
        budget, why = allowance(None, ledger, pol)  # counted at the whole per-run limit: 6 - 1.75 - 4 leaves less than $1
        self.assertEqual(budget, None)
        self.assertIn("($1.75 spent, $4.00 committed", why)
        del ledger["supervisor"]["executions"]["x000000000005"]
        ledger["supervisor"]["executions"]["x000000000002"]["cost_usd"] = 2.255
        self.assertEqual(allowance(None, ledger, pol), (3.24, None))  # 6 - 2.755 = 3.245, rounded down to whole cents

    def test_an_execution_that_runs_too_long_is_stopped(self):
        self.supervised()
        self.claude({"default": {"hang": True}})
        home = executor.prepare(self.eng, "x000000000001", [str(self.bin / "claude"), "-p", 'Run the workflow named mach:belt with args {"tickets": ["LOCAL-001"]}. Use the Workflow tool.',
                                                            "--session-id", "s-1"], timeout_minutes=1 / 60)
        with mock.patch.object(executor, "GRACE_SECONDS", 2):
            self.assertEqual(executor.wrapper(self.eng, "x000000000001"), 0)
        result = json.loads((home / "result.json").read_text())
        self.assertEqual(result["ended"], "timed-out")
        self.assertEqual(executor.wrapper(self.eng, "x000000000001"), 2)  # an execution is never run a second time
        facts = executor.outcome(self.eng, "x000000000001")
        self.assertEqual((facts["ended"], facts["how"], facts["session_id"], facts["is_error"]), (True, "timed-out", "s-1", None))

    def test_failures_are_retried_within_the_limit_then_a_person_is_asked(self):
        self.supervised()
        self.claude({"default": {"is_error": True, "exit": 1}})  # ends without moving the ticket
        self.tick()
        self.wait()
        report = self.tick()  # attempt 1 failed: one more try
        self.assertEqual(len(report["started"]), 1)
        self.wait()
        report = self.tick()
        self.assertEqual(report["started"], [])
        self.assertEqual(report["parked"]["LOCAL-001"]["reason"], "2 execution(s) ended without moving it past 'spec-ready'.")
        failed = [e for e in self.events() if e["type"] == "execution.failed"]
        self.assertEqual([(e["data"]["attempt"], e["data"]["claude_error"]) for e in failed], [(1, "error_during_execution"), (2, "error_during_execution")])
        for _ in range(2):
            self.assertEqual(self.tick()["started"], [])
        self.assertEqual(len(self.calls()), 2)


class LifecycleTest(Base):
    def test_pause_and_resume(self):
        self.supervised()
        paused = self.factory("pause")
        self.assertEqual(paused["paused"], True)
        report = self.tick()
        self.assertEqual((report["state"], report["dispatched"], report["started"]), ("paused", [], []))
        self.assertEqual(report["held"][0]["why"], "the Factory is paused")
        self.assertEqual(self.tickets(), ["LOCAL-001"])  # discovery continues; nothing is dispatched
        self.assertFalse((self.eng / ".factory/worktrees").exists())
        self.config(build={"require_audit": True})
        stuck = self.factory("resume")
        self.assertEqual((stuck["resumed"], [item["check"] for item in stuck["failed"]]), (False, ["audit"]))
        self.assertEqual(self.tick()["state"], "paused")
        self.config(build={"require_audit": False})
        self.assertEqual(self.factory("resume")["resumed"], True)
        self.assertEqual(len(self.tick()["started"]), 1)
        self.assertEqual([k for k in self.kinds() if k.startswith("factory.")], ["factory.activated", "factory.paused", "factory.resumed"])

    def test_disable_revokes_and_cleans_up(self):
        self.supervised("--hooks", "--persistent")
        self.assertTrue(service.agent_path(self.eng).exists())
        self.assertEqual(service.hooks_status(self.eng), list(service.HOOKS))
        done = self.factory("disable")
        self.assertEqual((done["disabled"], done["was_enabled"], done["git_hooks_removed"], done["persistent_service_removed"]), (True, True, list(service.HOOKS), True))
        self.assertEqual((policy.read(self.eng)["enabled"], self.factory("status")["factory"]), (False, "disabled"))
        self.assertEqual(self.tick()["state"], "disabled")
        self.assertEqual((self.calls(), self.tickets()), ([], []))
        self.assertFalse(service.agent_path(self.eng).exists())
        self.assertEqual(service.hooks_status(self.eng), [])
        self.assertEqual(self.run_factory("wake", "--event", "post-merge")[0], 0)
        self.assertFalse(self.local("wake").read_text().startswith("{"))  # a hook's note is ignored once disabled
        self.assertEqual(self.factory("disable")["was_enabled"], False)
        self.assertIn("nothing to pause", self.refused_factory("pause"))
        self.assertEqual(self.kinds().count("factory.disabled"), 1)

    def test_emergency_stop(self):
        self.supervised()
        self.claude({"default": {"hang": True}})
        self.tick()
        record = list(self.executions().values())[0]
        deadline = time.time() + 15
        while not (self.local("executions") / record["execution_id"] / "started.json").exists() and time.time() < deadline:
            time.sleep(0.1)
        with mock.patch.object(executor, "GRACE_SECONDS", 2):
            stopped = self.factory("stop")
        self.assertEqual([(item["ticket_id"], item["signalled"]) for item in stopped["stopped"]], [("LOCAL-001", True)])
        self.wait()
        self.assertEqual(json.loads((self.local("executions") / record["execution_id"] / "result.json").read_text())["ended"], "interrupted")
        report = self.tick()
        self.assertEqual((report["state"], report["started"]), ("paused", []))
        self.assertIn("stopped by a person", report["parked"]["LOCAL-001"]["reason"])
        self.assertEqual(self.factory("resume")["still_waiting_for_a_person"], ["LOCAL-001"])
        self.assertEqual(self.tick()["started"], [])  # resumed, but that ticket still waits for a person
        self.assertEqual(len(self.calls()), 1)


class RecoveryTest(Base):
    def test_work_that_finished_while_no_supervisor_ran_is_not_run_again(self):
        self.supervised()
        self.tick()
        self.wait()  # it ended; no supervisor has looked since
        report = self.tick()
        self.assertEqual([item["found"] for item in report["recovered"]], ["ended"])
        self.assertEqual(report["started"], [])
        self.assertEqual(len(self.calls()), 1)
        recovery = [e["data"]["kind"] for e in self.events() if e["type"] == "recovery.started"]
        self.assertEqual(recovery, ["ended-while-unwatched"])

    def test_a_claim_that_never_started_is_released(self):
        self.supervised()
        with mock.patch.object(executor, "launch", side_effect=RuntimeError("power cut")):
            with self.assertRaises(RuntimeError):
                self.run_factory("tick")
        record = list(self.executions().values())[0]
        self.assertEqual((record["state"], record["wrapper_pid"]), ("claimed", None))  # the claim was on disk before anything started
        self.assertEqual(self.calls(), [])
        if self.local("supervisor.json").exists():
            self.local("supervisor.json").unlink()
        report = self.tick()
        self.assertEqual(report["recovered"][0]["found"], "claimed, never started")
        self.assertEqual(len(report["started"]), 1)  # nothing ran, so nothing was uncertain: it starts cleanly
        self.assertEqual(self.executions()[record["execution_id"]]["state"], "released")

    def test_a_live_execution_is_adopted_not_restarted(self):
        self.supervised()
        self.claude({"default": {"sleep": 4, "stage": "approved"}})
        self.tick()
        report = self.tick()  # a new supervisor process finds it still running
        self.assertEqual([item["found"] for item in report["recovered"]], ["still running"])
        self.assertEqual((report["started"], report["running"]), ([], ["LOCAL-001"]))
        self.wait()
        self.tick()
        self.assertEqual(len(self.calls()), 1)

    def lose(self):
        """Start an execution, then kill it so hard that it leaves no result."""
        self.tick()
        record = next(record for record in self.executions().values() if record["state"] in ("claimed", "started"))  # the one running now
        started = self.local("executions") / record["execution_id"] / "started.json"
        deadline = time.time() + 15
        while not started.exists() and time.time() < deadline:
            time.sleep(0.1)
        data = json.loads(started.read_text())
        for pid in (data["wrapper_pid"], data["child_pid"]):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        deadline = time.time() + 10
        while executor.alive(data["wrapper_pid"], record["execution_id"]) and time.time() < deadline:
            time.sleep(0.1)
        return record

    def test_an_unknown_outcome_is_counted_and_then_escalated(self):
        self.supervised()
        self.claude({"default": {"hang": True}})
        record = self.lose()
        report = self.tick()
        self.assertEqual(report["recovered"], [{"execution_id": record["execution_id"], "ticket_id": "LOCAL-001", "found": "outcome unknown"}])
        self.assertEqual(self.executions()[record["execution_id"]]["state"], "unknown")
        # The planning station records its own progress and is safe to resume, so one more counted attempt is made.
        self.assertEqual(len(report["started"]), 1)
        self.lose()
        report = self.tick()
        self.assertEqual(report["started"], [])
        self.assertIn("2 execution(s) ended without moving it", report["parked"]["LOCAL-001"]["reason"])
        failed = [(e["data"]["how"], e["data"]["attempt"]) for e in self.events() if e["type"] == "execution.failed"]
        self.assertEqual(failed, [("unknown", 1), ("unknown", 2)])

    def test_an_unknown_outcome_at_the_merge_station_is_never_retried(self):
        self.first()
        self.config(build={"require_audit": False}, merge={"mode": "auto", "method": "local"})
        self.enable("--include-backlog", "--allow-merge")
        self.claude({"default": {"stage": "approved"}})
        self.tick()
        self.wait()
        self.claude({"default": {"hang": True}})
        self.tick()  # settle the first run; the line may merge here, so the next station is merge
        record = self.lose()
        self.assertEqual((record["action_at_start"], record["until"]), ("merge", None))
        report = self.tick()
        self.assertEqual(report["started"], [])
        self.assertIn("merge station was running when its execution was lost", report["parked"]["LOCAL-001"]["reason"])
        self.assertIn("never retried automatically", report["parked"]["LOCAL-001"]["reason"])
        self.assertEqual(self.tick()["started"], [])

    def test_progress_recorded_by_the_stations_counts_even_if_the_run_was_lost(self):
        self.supervised()
        self.claude({"default": {"stage": "built", "vanish": True}})  # the station moved the cell on, then the process died
        self.tick()
        self.wait()
        report = self.tick()
        completed = [e for e in self.events() if e["type"] == "execution.completed"]
        self.assertEqual([(e["data"]["stage"], e["data"]["next"]) for e in completed], [("built", "verify")])
        self.assertEqual(len(report["started"]), 1)  # the line carries on from where the records say it is
        self.assertNotIn("LOCAL-001", report["parked"])


class OwnershipTest(Base):
    def test_two_supervisors_cannot_both_own_a_project(self):
        self.supervised()
        self.local("supervisor.json").write_text(json.dumps({"instance": "the-other", "runner_id": "r", "pid": os.getpid(), "host": supervisor.platform.node(),
                                                             "started_at": "x", "heartbeat_at": "x", "expires_at": "2099-01-01T00:00:00Z"}))
        for argv in (("tick",), ("serve", "--max-ticks", "1")):
            message = self.refused_factory(*argv)
            self.assertIn("Another supervisor already owns this project", message)
        self.assertEqual((self.calls(), self.tickets()), ([], []))
        self.assertEqual(self.factory("status")["supervisor"]["running"], True)

    def test_a_dead_or_expired_owner_is_taken_over(self):
        self.supervised()
        gone = subprocess.Popen([sys.executable, "-c", "pass"])
        gone.wait()
        self.local("supervisor.json").write_text(json.dumps({"instance": "dead", "runner_id": "r", "pid": gone.pid, "host": supervisor.platform.node(),
                                                             "started_at": "x", "heartbeat_at": "2026-11-10T00:00:00Z", "expires_at": "2099-01-01T00:00:00Z"}))
        self.assertEqual(self.factory("status")["supervisor"]["running"], False)
        served = self.factory("serve", "--max-ticks", "1", "--interval", "30")
        self.assertEqual(served["served"], 1)
        self.assertIn("took-over-from-dead-supervisor", [e["data"].get("kind") for e in self.events() if e["type"] == "recovery.started"])
        self.assertFalse(self.local("supervisor.json").exists())  # released on the way out
        self.local("supervisor.json").write_text(json.dumps({"instance": "old", "pid": os.getpid(), "host": "another-machine", "expires_at": "2026-01-01T00:00:00Z"}))
        self.tick()  # an expired lease, whoever held it, no longer counts

    def test_a_supervisor_that_lost_ownership_stops(self):
        self.supervised()
        _, line = run.factory(run.Project(self.eng))
        sup = supervisor.Supervisor(self.eng, json.loads((self.eng / ".factory/config.json").read_text()), line, next_step=lambda t: run.next_step(run.Project(self.eng), t, True),
                                    audit=run.Project(self.eng).audit, git=run.git, run_script=SCRIPTS / "run.py", workflow="mach:belt")
        sup.lease.acquire()
        other = supervisor.Lease(self.eng, "r")
        self.local("supervisor.json").write_text(json.dumps({"instance": other.instance, "pid": os.getpid(), "host": supervisor.platform.node(), "expires_at": "2099-01-01T00:00:00Z"}))
        with self.assertRaises(supervisor.SupervisorError):
            sup.tick()
        self.assertEqual(sup.authorize({})[0], False)
        self.assertEqual(self.calls(), [])

    def test_serve_ticks_until_disabled_and_wakes_on_a_note(self):
        self.supervised()
        self.assertEqual(self.factory("serve", "--max-ticks", "2", "--interval", "1")["served"], 2)
        self.factory("disable")
        served = self.factory("serve", "--interval", "1")
        self.assertEqual(served, {"served": 0, "stopped": "the Factory is not enabled on this machine"})


class GitTest(Base):
    def test_offline_changes_nothing_but_a_note(self):
        self.supervised("--auto-sync")
        git(self.eng, "remote", "set-url", "origin", str(self.root / "no-such-remote.git"))
        report = self.tick()
        self.assertEqual(report["notes"], ["Could not reach the shared repository; using what was fetched before."])
        self.assertEqual((report["state"], len(report["started"])), ("supervised", 1))
        self.wait()
        self.tick()
        json.loads((self.eng / ".factory/intake/ledger.json").read_text())
        self.assertEqual([e["seq"] for e in self.events()], list(range(1, len(self.events()) + 1)))

    def test_fetched_work_is_discovered_without_moving_the_checkout(self):
        self.first()
        self.enable("--include-backlog", "--auto-sync")
        self.tick()
        self.wait()
        self.tick()
        # A new wave is merged on the shared repository by someone else; the engineer has not pulled.
        other = self.clone("eng2", "Other Engineer")
        self.ok(self.a, "refresh")
        wave = self.new_wave(self.a, self.slice(self.a, "Arrived while away"))
        self.ok(self.a, "send", wave)
        git(other, "fetch", "-q", "origin")
        git(other, "merge", "-q", "--no-ff", "-m", "merge", f"origin/product/{wave}")
        git(other, "push", "-q", "origin", "main")
        before = self.checkout()
        report = self.tick()
        self.assertEqual(self.checkout(), before)  # fetched, never checked out or reset
        self.assertEqual(self.tickets(), ["LOCAL-001", "LOCAL-002"])  # discovered and taken in
        self.assertEqual(report["dispatched"], [])
        self.assertIn("is not the approved spec. Update the checkout", json.dumps(report["held"]))  # a person brings the checkout up to date
        git(self.eng, "merge", "-q", "--ff-only", "origin/main")
        self.assertEqual([item["slice_id"] for item in self.tick()["dispatched"]], ["SLICE-002"])

    def test_existing_hooks_are_preserved(self):
        self.first()
        hooks = self.eng / ".git/hooks"
        hooks.mkdir(exist_ok=True)
        mine = "#!/bin/sh\n# my own hook\necho merged >> \"$(git rev-parse --show-toplevel)/my-hook.log\"\n"
        (hooks / "post-merge").write_text(mine)
        (hooks / "post-merge").chmod(0o755)
        self.enable("--include-backlog", "--hooks")
        text = (hooks / "post-merge").read_text()
        self.assertTrue(text.startswith(mine))
        self.assertIn(service.BEGIN, text)
        self.assertIn(" factory wake --event post-merge", text)
        self.assertEqual(subprocess.run(["git", "config", "--get", "core.hooksPath"], cwd=str(self.eng), capture_output=True, text=True).stdout, "")  # never set
        done = subprocess.run(["sh", str(hooks / "post-merge")], cwd=str(self.eng), capture_output=True, text=True)
        self.assertEqual((done.returncode, done.stdout, done.stderr), (0, "", ""))
        deadline = time.time() + 10
        while not self.local("wake").exists() and time.time() < deadline:
            time.sleep(0.1)
        self.assertEqual(json.loads(self.local("wake").read_text())["event"], "post-merge")
        self.assertEqual((self.eng / "my-hook.log").read_text(), "merged\n")
        self.assertEqual(self.calls(), [])  # a hook starts no agent
        self.factory("disable")
        self.assertEqual((hooks / "post-merge").read_text(), mine)
        self.assertTrue(os.access(str(hooks / "post-merge"), os.X_OK))
        self.assertFalse((hooks / "post-checkout").exists())  # the ones MACH created are gone

    def test_a_project_that_manages_its_own_hooks_is_left_alone(self):
        self.first()
        git(self.eng, "config", "core.hooksPath", ".husky")
        done = self.enable("--include-backlog", "--hooks")
        self.assertEqual(done["git_hooks"]["installed"], [])
        self.assertIn("manages its own hooks", done["git_hooks"]["skipped"])
        self.assertEqual(git(self.eng, "config", "--get", "core.hooksPath").strip(), ".husky")
        self.assertFalse((self.eng / ".husky").exists())

    def test_a_broken_hook_target_never_fails_git(self):
        self.supervised("--hooks")
        text = (self.eng / ".git/hooks/post-merge").read_text().replace(str(SCRIPTS / "run.py"), "/no/such/run.py")
        (self.eng / ".git/hooks/post-merge").write_text(text)
        self.assertEqual(subprocess.run(["sh", str(self.eng / ".git/hooks/post-merge")], cwd=str(self.eng), capture_output=True).returncode, 0)


class ServiceTest(Base):
    def test_the_persistent_service_is_installed_only_on_request_and_binds_nothing(self):
        self.first()
        self.enable("--include-backlog")
        self.assertFalse((self.home / "Library").exists())  # enabling alone installs no service
        self.assertFalse(self.launchctl_log.exists())
        self.factory("disable")
        done = self.enable("--include-backlog", "--persistent")
        import plistlib
        path = service.agent_path(self.eng)
        self.assertEqual(Path(done["persistent_service"]["definition"]), path)
        self.assertTrue(str(path).startswith(str(self.home)))
        with path.open("rb") as handle:
            definition = plistlib.load(handle)
        self.assertEqual(definition["ProgramArguments"], [sys.executable, str(SCRIPTS / "run.py"), "--project", str(self.eng), "factory", "serve"])
        self.assertEqual((definition["RunAtLoad"], definition["KeepAlive"]), (True, {"SuccessfulExit": False}))
        for key in ("Sockets", "MachServices", "inetdCompatibility", "UserName", "GroupName"):
            self.assertNotIn(key, definition)  # no listener of any kind, and never another user
        calls = [json.loads(line) for line in self.launchctl_log.read_text().splitlines()]
        self.assertEqual([call[0] for call in calls], ["bootout", "bootstrap"])
        self.assertEqual(calls[1], ["bootstrap", f"gui/{os.getuid()}", str(path)])
        self.assertTrue(policy.read(self.eng)["persistent"])
        self.factory("disable")
        self.assertFalse(path.exists())
        self.assertEqual(json.loads(self.launchctl_log.read_text().splitlines()[-1]), ["bootout", f"gui/{os.getuid()}/{service.label(self.eng)}"])

    def test_no_module_opens_a_network_listener(self):
        for name in ("supervisor.py", "executor.py", "policy.py", "activation.py", "service.py", "intake.py", "run.py"):
            source = (SCRIPTS / name).read_text()
            for word in ("import socket", "socketserver", "http.server", "HTTPServer", ".bind(", ".listen(", "0.0.0.0", "asyncio.start_server", "xmlrpc"):
                self.assertNotIn(word, source, f"{name}: {word}")
            for word in ("dangerously", "bypassPermissions", "--no-verify", "sudo "):
                self.assertNotIn(word, source.replace('"dangerously" in tool', ""), f"{name}: {word}")

    def test_only_macos_gets_a_persistent_service(self):
        with mock.patch.object(service.sys, "platform", "linux"):
            with self.assertRaises(service.ServiceError):
                service.install_agent(self.eng, SCRIPTS / "run.py")
        self.assertFalse(self.launchctl_log.exists())


class BoundaryTest(Base):
    """The allow list is a real boundary only with restricted mode, no MCP servers, MACH as the only plugin and a clean environment."""

    def test_the_command_is_restricted_and_the_consented_list_comes_last(self):
        argv = executor.command("claude", "mach:belt", ["LOCAL-001"], "merge", ["Read", "Bash(git log *)", "Edit", "mcp__mail__send"], 5, "s-1",
                                Path("/plugins/mach"), [Path("/plugins/mach")], ["Edit(//plugins/mach/**)"])
        for flag in ("--restricted", "--strict-mcp-config"):
            self.assertIn(flag, argv)
        self.assertEqual([argv[argv.index(flag) + 1] for flag in ("--permission-mode", "--permission-prompts", "--tools", "--plugin-dir", "--add-dir")],
                         ["default", "none", "Read,Bash,Edit", "/plugins/mach", "/plugins/mach"])  # only built-in tools the list names exist in the run
        self.assertEqual(argv[argv.index("--allowedTools") + 1:], ["Read", "Bash(git log *)", "Edit", "mcp__mail__send"])
        self.assertEqual(argv[argv.index("--disallowedTools") + 1:argv.index("--max-budget-usd")], ["Edit(//plugins/mach/**)"])
        self.assertFalse([part for part in argv if "dangerously" in part or "bypass" in part.lower() or part == "--bare"])
        with self.assertRaises(ValueError):
            executor.command("claude", "mach:belt", ["LOCAL-001"], None, ["Read"], 5, "s-1", Path("relative/plugin"))
        with self.assertRaises(ValueError):
            executor.command("claude", "mach:belt", ["LOCAL-001"], None, ["Bash(*)"], 5, "s-1", Path("/plugins/mach"))

    def test_no_key_token_or_secret_reaches_the_run(self):
        leaked = {"ANTHROPIC_API_KEY": "sk-ant-leak-1", "CLAUDE_CODE_OAUTH_TOKEN": "oauth-leak-2", "GITHUB_TOKEN": "ghp-leak-3", "AWS_SECRET_ACCESS_KEY": "aws-leak-4",
                  "NPM_TOKEN": "npm-leak-5", "DB_PASSWORD": "pw-leak-6", "SSH_AUTH_SOCK": "/tmp/agent-leak-7", "HTTPS_PROXY": "http://user:pw-leak-8@proxy.test:8080",
                  "CLAUDE_CODE_SESSION_ID": "session-leak-9", "LANG": "en_US.UTF-8", "NO_PROXY": "localhost"}
        with mock.patch.dict(os.environ, leaked):
            self.supervised()
            self.tick()
            self.wait()
        calls = self.calls(runs_only=False)
        self.assertEqual(len(calls), 2)  # the preflight's probe and the execution: both get the same clean environment
        for call in calls:
            env = call["env"]
            self.assertEqual([name for name in env if re.search("KEY|TOKEN|SECRET", name, re.IGNORECASE)], [])
            for value in leaked.values():
                if "leak" in value:
                    self.assertNotIn(value, json.dumps(env))
            self.assertEqual((env["LANG"], env["NO_PROXY"], env["CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"]), ("en_US.UTF-8", "localhost", "0"))
            self.assertTrue(set(env) - OS_ADDED_ENV <= set(executor.PASSED_ENV) | set(executor.PROXY_ENV) | set(executor.ENV) | {executor.EXECUTION_ENV}, sorted(env))
        self.assertEqual(executor.environment({"PATH": "/bin", "HTTPS_PROXY": "http://proxy.test:3128", "MY_API_KEY": "k"}),
                         {"PATH": "/bin", "HTTPS_PROXY": "http://proxy.test:3128", **executor.ENV})

    def test_a_script_install_gets_a_stable_generated_plugin_in_ignored_local_state(self):
        installed = subprocess.run([sys.executable, str(ROOT / "bin" / "mach"), "install", "--project", str(self.eng)], capture_output=True, text=True)
        self.assertEqual(installed.returncode, 0, installed.stderr + installed.stdout)
        run_script = self.eng / ".claude/skills/mach-run/scripts/run.py"
        folder = self.eng / ".factory/local/claude-plugin"
        first = executor.plugin(self.eng, run_script)
        self.assertEqual((first["kind"], first["plugin_dir"], first["workflow"], first["add_dirs"]), ("project", folder, "mach:belt", []))
        self.assertIn(f"Edit(/{folder}/**)", first["denied"])
        self.assertEqual(subprocess.run(["git", "check-ignore", "-q", ".factory/local/claude-plugin/workflows/belt.js"], cwd=str(self.eng)).returncode, 0)
        # The installer's renames are undone exactly: the run sees MACH as the plugin it was installed from.
        self.assertEqual((folder / "workflows/belt.js").read_text(), (ROOT / "workflows/belt.js").read_text())
        for agent in (ROOT / "agents").glob("*.md"):
            self.assertEqual((folder / "agents" / agent.name).read_text(), agent.read_text(), agent.name)
        for name in ("run", "build", "intent", "review", "verify", "audit", "merge", "cleanup", "observe", "ticket"):
            source = ROOT / "skills" / name
            for path in source.rglob("*"):
                if path.is_file() and "__pycache__" not in path.parts:
                    self.assertEqual((folder / "skills" / name / path.relative_to(source)).read_bytes(), path.read_bytes(), str(path))
        self.assertFalse((folder / "skills/product-studio").exists())  # a product manager's skill has no place in an unattended run
        self.assertEqual(json.loads((folder / ".claude-plugin/plugin.json").read_text())["name"], "mach")
        # The path never changes, and an unchanged install is not rewritten under a running execution.
        stamp = (folder / executor.PLUGIN_STAMP).stat().st_mtime_ns
        self.assertEqual(executor.plugin(self.eng, run_script)["plugin_dir"], folder)
        self.assertEqual((folder / executor.PLUGIN_STAMP).stat().st_mtime_ns, stamp)
        # A reinstall or an edit to the installed files is picked up, at the same path, with nothing left beside it.
        with (self.eng / ".claude/agents/mach-builder.md").open("a") as out:
            out.write("\nChanged by the engineer.\n")
        self.assertEqual(executor.plugin(self.eng, run_script)["plugin_dir"], folder)
        self.assertTrue((folder / "agents/builder.md").read_text().endswith("Changed by the engineer.\n"))
        self.assertEqual(sorted(path.name for path in (self.eng / ".factory/local").iterdir()), ["claude-plugin"])
        # Never through a symbolic link, which could point anywhere.
        shutil.rmtree(str(folder))
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        folder.symlink_to(elsewhere)
        with self.assertRaises(executor.PluginError):
            executor.plugin(self.eng, run_script)
        self.assertEqual(list(elsewhere.iterdir()), [])
        # Installed as a plugin, MACH is loaded from the plugin's own folder, which the file tools may read but not change.
        as_plugin = executor.plugin(self.eng, SCRIPTS / "run.py")
        self.assertEqual((as_plugin["kind"], as_plugin["plugin_dir"], as_plugin["add_dirs"]), ("plugin", ROOT, [ROOT]))
        self.assertIn(f"Edit(/{ROOT}/**)", as_plugin["denied"])


class EventsTest(Base):
    def test_supervisor_events_are_versioned_attributed_and_carry_no_prompt(self):
        self.supervised()
        self.tick()
        self.wait()
        self.tick()
        events = self.events()
        runner = policy.read(self.eng)["runner_id"]
        keys = {"schema_version", "seq", "at", "type", "project_id", "source_commit", "wave_id", "slice_id", "revision", "ticket_id",
                "runner_id", "execution_id", "source", "cause", "refs", "data"}
        for event in events:
            self.assertEqual(set(event), keys)
            self.assertEqual(event["schema_version"], 2)
            self.assertIn(event["type"], intake.EVENT_TYPES)
            self.assertIn(event["source"], ("supervisor", "engineer", "intake"))
            self.assertEqual(event["runner_id"], runner)
        started = next(e for e in events if e["type"] == "execution.started")
        self.assertEqual((started["ticket_id"], started["slice_id"], started["data"]["workflow"], started["data"]["until"]), ("LOCAL-001", "SLICE-001", "mach:belt", "merge"))
        self.assertEqual(started["refs"], {"execution": f".factory/local/executions/{started['execution_id']}/", "cell": ".factory/worktrees/LOCAL-001/cell.json"})
        log = (self.eng / ".factory/intake/events.jsonl").read_text()
        for secret in ("Run the workflow named", "--allowedTools", "Use the Workflow tool"):
            self.assertNotIn(secret, log)
        schema = json.loads((ROOT / "docs/mach-next/schemas/factory-event.schema.json").read_text())
        self.assertEqual((sorted(schema["required"]), schema["properties"]["type"]["enum"], schema["properties"]["schema_version"]), (sorted(keys), list(intake.EVENT_TYPES), {"const": 2}))
        policy_schema = json.loads((ROOT / "docs/mach-next/schemas/runner-policy.schema.json").read_text())
        stored = json.loads(self.local("runner.json").read_text())
        self.assertEqual(sorted(policy_schema["required"]), sorted(stored))
        self.assertEqual(policy_schema["properties"]["schema_version"], {"const": policy.POLICY_VERSION})


if __name__ == "__main__":
    unittest.main()
