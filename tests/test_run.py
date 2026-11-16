"""Tests for run.py (the next-step state machine) and the mach-run workflow script."""

import io
import json
import re
import shutil
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import run  # noqa: E402
from test_build import git  # noqa: E402
from test_verify import Base as VerifyBase, NOTE, TARGETS  # noqa: E402


class Base(VerifyBase):
    def next(self, *extra, ticket="LOCAL-001"):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.project), "next", ticket, *extra])
        self.assertEqual(code, 0, err.getvalue())
        return json.loads(out.getvalue())

    def run_cmd(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def set_cell(self, **changes):
        cell = self.cell_json()
        cell.update(changes)
        (self.cellroot / "cell.json").write_text(json.dumps(cell))

    def verified(self):
        self.built()
        self.v_ok("start", "LOCAL-001")
        for target in TARGETS:
            self.record(target)
        self.v_ok("finish", "LOCAL-001")


class GroomingTest(Base):
    def test_no_cell_means_groom(self):
        (self.project / ".factory").mkdir(exist_ok=True)
        step = self.next()
        self.assertEqual((step["action"], step["stop"], step["interactive"], step["model"]), ("groom", False, True, "fable"))
        self.assertEqual(step["prompt"], "Use the MACH intent skill: /mach:intent LOCAL-001")
        headless = self.next("--headless")
        self.assertEqual((headless["interactive"], headless["prompt"]), (False, "Use the MACH intent skill: /mach:intent LOCAL-001 --headless"))

    def test_grooming_stages(self):
        self.cell_cmd("open", "LOCAL-001")
        self.assertEqual(self.next()["action"], "groom")
        self.set_cell(stage="spec-open")
        self.assertEqual((self.next()["action"], self.next()["interactive"]), ("groom", True))
        stopped = self.next("--headless")
        self.assertEqual((stopped["action"], stopped["stop"], stopped["needs"]), ("stop", True, "answers"))
        self.set_cell(stage="spec-ready")
        step = self.next()
        self.assertEqual((step["action"], step["model"]), ("plan", "opus"))

    def test_finished_or_closed_ticket_needs_nothing(self):
        self.put(self.project, {".factory/archive/runs.jsonl": json.dumps({"ticket_id": "LOCAL-001", "outcome": "merged", "archive": ".factory/archive/LOCAL-001.tar.gz"}) + "\nnot json\n",
                                ".factory/tickets/LOCAL-002.md": "---\nid: LOCAL-002\nstate: closed\nlabels: []\n---\n"})
        done = self.next()
        self.assertEqual((done["action"], done["needs"]), ("stop", "nothing"))
        self.assertIn("merged and cleaned up", done["reason"])
        self.assertEqual((self.next(ticket="LOCAL-002")["needs"], self.next(ticket="LOCAL-003")["action"]), ("nothing", "groom"))

    def test_bad_ticket_id(self):
        (self.project / ".factory").mkdir(exist_ok=True)
        code, _, err = self.run_cmd("next", "../x")
        self.assertEqual(code, 1)
        self.assertIn("not a usable ticket ID", err)


class BuildGateTest(Base):
    def test_planned_cell_waits_for_the_audit(self):
        self.groom()
        step = self.next()
        self.assertEqual((step["action"], step["prompt"]), ("audit", "Use the MACH audit skill on the main checkout: /mach:audit"))
        self.audit_report(head="0" * 40)
        self.assertIn("stale", self.next()["reason"])
        self.audit_report("Bronze")
        stopped = self.next()
        self.assertEqual((stopped["action"], stopped["needs"]), ("stop", "repository-hardening"))
        self.put(self.project, {".factory/tickets/LOCAL-001.md": '---\nid: LOCAL-001\nstate: open\nlabels: ["repo-hardening"]\n---\n'})
        self.assertEqual(self.next()["action"], "build")
        self.audit_report("Gold")
        step = self.next()
        self.assertEqual((step["action"], step["agent_type"], step["prompt"], step["model"]), ("build", "mach:builder", "Build MACH ticket LOCAL-001.", None))

    def test_audit_gate_switched_off(self):
        self.groom()
        self.put(self.project, {".factory/config.json": json.dumps({"build": {"require_audit": False}, "models": {"planning": "opus"}})})
        self.assertEqual(self.next()["action"], "build")
        self.assertEqual(self.next(ticket="LOCAL-002")["model"], "opus")


class BeltTest(Base):
    def test_build_verify_review_in_order(self):
        self.ready()
        self.ok("start", "LOCAL-001")
        step = self.next()
        self.assertEqual((step["action"], step["agent_type"]), ("build", "mach:builder"))
        self.assertIn("continue from the next task", step["prompt"])
        self.build_through("T05")
        self.ok("finish", "LOCAL-001")
        step = self.next()
        self.assertEqual((step["action"], step["agent_type"], step["prompt"]), ("verify", "mach:verifier", "Verify MACH ticket LOCAL-001."))
        self.v_ok("start", "LOCAL-001")
        for target in TARGETS:
            self.record(target)
        self.v_ok("finish", "LOCAL-001")
        step = self.next()
        self.assertEqual((step["action"], step["risk"], step["prompt"]), ("review", "Medium", None))

    def test_failed_verification_goes_back_to_the_builder(self):
        self.built()
        self.v_ok("start", "LOCAL-001")
        for target in TARGETS:
            self.record(target, "fail" if target == "R4" else "pass", note="The spec expects a refusal; the invitation was accepted and a seat was taken.")
        self.run_verify("finish", "LOCAL-001")
        step = self.next()
        self.assertEqual((step["action"], step["agent_type"]), ("revise", "mach:builder"))
        self.assertTrue(step["findings"].endswith("evidence/findings.md"))
        self.ok("revise", "LOCAL-001", "--findings", step["findings"])
        resumed = self.next()
        self.assertEqual(resumed["action"], "build")
        self.assertIn("revision 1", resumed["prompt"])
        self.assertIn("review-findings-1.md", resumed["prompt"])

    def test_review_outcomes(self):
        self.verified()
        head = git(self.work, "rev-parse", "HEAD").stdout.strip()
        findings = self.cellroot / "review/round-1/findings.md"
        self.put(self.cellroot, {"review/round-1/findings.md": "x", "review/decision.json": json.dumps({"outcome": "REJECTED", "head": head, "findings": str(findings)})})
        self.set_cell(stage="built", review="REJECTED")
        step = self.next()
        self.assertEqual((step["action"], step["findings"]), ("revise", str(findings)))
        self.set_cell(stage="awaiting-human")
        self.assertEqual((self.next()["action"], self.next()["needs"]), ("stop", "human-approval"))
        self.set_cell(stage="blocked")
        self.assertEqual(self.next()["needs"], "person-to-take-over")
        self.set_cell(stage="mystery")
        self.assertIn("unknown stage", self.next()["reason"])

    def test_approved_waits_for_the_merge_then_cleans_up(self):
        self.verified()
        self.set_cell(stage="approved")
        waiting = self.next()
        self.assertEqual((waiting["action"], waiting["needs"]), ("stop", "merge"))
        self.assertIn("feature/LOCAL-001", waiting["reason"])
        merged = git(self.project, "merge", "-q", "--no-ff", "feature/LOCAL-001", "-m", "merge")
        self.assertEqual(merged.returncode, 0, merged.stderr)
        step = self.next()
        self.assertEqual((step["action"], step["model"], step["prompt"]), ("cleanup", "haiku", "Use the MACH cleanup skill: /mach:cleanup LOCAL-001"))


class ReviewRelayTest(Base):
    def test_review_start_gives_a_ready_prompt_per_seat_and_tally_passes_through(self):
        self.verified()
        code, out, err = self.run_cmd("review-start", "LOCAL-001")
        self.assertEqual(code, 0, err)
        started = json.loads(out)
        self.assertEqual([(s["role"], s["model"], s["agent_type"]) for s in started["seats"]],
                         [("architecture", "sonnet", "mach:reviewer"), ("security", "sonnet", "mach:reviewer"), ("product", "sonnet", "mach:reviewer")])
        prompt = started["seats"][2]["prompt"]
        self.assertIn("You are the product reviewer for MACH ticket LOCAL-001.", prompt)
        for line in prompt.splitlines()[1:]:
            path = Path(line.split(": ", 1)[1])
            self.assertTrue(path.is_file(), line)
        self.assertNotRegex(prompt.lower(), r"approve|reject|looks good|expected result")
        code, out, err = self.run_cmd("review-tally", "LOCAL-001")
        self.assertEqual(code, 1)
        self.assertIn("No vote yet from", err)

    def test_review_start_refusal_is_passed_on(self):
        self.built()
        code, _, err = self.run_cmd("review-start", "LOCAL-001")
        self.assertEqual(code, 1)
        self.assertIn("Only a verified cell can be reviewed", err)

    def test_general_seat_gets_all_three_checklists(self):
        self.verified()
        self.set_cell(risk="Low")
        _, out, _ = self.run_cmd("review-start", "LOCAL-001")
        seat = json.loads(out)["seats"][0]
        self.assertEqual(seat["role"], "general")
        self.assertEqual(len(re.findall(r"references/(?:architecture|security|product)\.md", seat["prompt"])), 3)


class BoardTest(Base):
    def test_board_lists_cells_and_ungroomed_tickets(self):
        self.ready()
        for title in ("First", "Second", "Third"):  # numbered 002 to 004: LOCAL-001 is already taken by the groomed cell
            self.cell_cmd("ticket-new", "--title", title)
        path = self.project / ".factory/tickets/LOCAL-003.md"
        path.write_text(path.read_text().replace("state: open", "state: closed"))
        self.cell_cmd("open", "LOCAL-009")
        (self.project / ".factory/worktrees/LOCAL-009/cell.json").write_text(json.dumps({"ticket_id": "LOCAL-009", "stage": "blocked"}))
        code, out, _ = self.run_cmd("board", "--headless")
        board = json.loads(out)
        self.assertEqual(code, 0)
        self.assertEqual(board["audit"]["state"], "ok")
        self.assertEqual([(t["ticket_id"], t["action"]) for t in board["tickets"]], [("LOCAL-001", "build"), ("LOCAL-009", "stop"), ("LOCAL-002", "groom"), ("LOCAL-004", "groom")])
        self.assertEqual((board["ready_to_run"], board["waiting_on_a_person"]), (["LOCAL-001", "LOCAL-002", "LOCAL-004"], ["LOCAL-009"]))
        self.assertEqual((board["observe_due"], board["factory_tuning_ready"]), (False, []))

    def test_board_says_when_observe_is_due_and_which_tuning_tickets_are_ready(self):
        runs = "".join(json.dumps({"ticket_id": f"T-{n}", "outcome": "merged"}) + "\n" for n in range(1, 6))
        self.put(self.project, {".factory/archive/runs.jsonl": runs,
                                ".factory/tickets/LOCAL-007.md": '---\nid: LOCAL-007\nstate: open\nlabels: ["factory-tuning"]\n---\n'})
        board = json.loads(self.run_cmd("board")[1])
        self.assertEqual((board["observe_due"], board["factory_tuning_ready"]), (True, ["LOCAL-007"]))
        self.put(self.project, {".factory/observations/last-pass.json": json.dumps({"runs_total": 5})})
        self.assertFalse(json.loads(self.run_cmd("board")[1])["observe_due"])
        self.put(self.project, {".factory/config.json": json.dumps({"observe": {"every": 2}}), ".factory/observations/last-pass.json": json.dumps({"runs_total": 3})})
        self.assertTrue(json.loads(self.run_cmd("board")[1])["observe_due"])


class NamingTest(Base):
    def test_project_install_uses_hyphenated_names(self):
        self.groom()
        self.audit_report()
        with mock.patch.object(run, "PROJECT_INSTALL", True):
            self.assertEqual(self.next()["agent_type"], "mach-builder")
            self.assertEqual(self.next(ticket="LOCAL-005")["prompt"], "Use the MACH intent skill: /mach-intent LOCAL-005")

    def test_where_gives_the_workflow_an_exact_command(self):
        code, out, _ = self.run_cmd("where")
        where = json.loads(out)
        self.assertEqual(code, 0)
        self.assertEqual((Path(where["run_script"]), Path(where["project"])), (ROOT / "skills/run/scripts/run.py", self.project))
        self.assertFalse(where["is_mach_project"])
        for command in (["next", "LOCAL-001"], ["board"], ["review-start", "LOCAL-001"]):
            code, _, err = self.run_cmd(*command)
            self.assertEqual(code, 1)
            self.assertIn("is not a MACH project", err)
        (self.project / ".factory").mkdir()
        self.assertTrue(json.loads(self.run_cmd("where")[1])["is_mach_project"])

    def test_sibling_lookup_finds_either_layout(self):
        self.assertEqual(run.sibling("review"), ROOT / "skills" / "review")
        with self.assertRaises(run.RunError):
            run.sibling("nonexistent")


class DigestTest(Base):
    def test_next_leads_with_the_digest_and_says_not_recorded_without_a_recorded_cost(self):
        self.ready()
        step = self.next()
        self.assertEqual(next(iter(step)), "digest", "the digest is printed first")
        digest = step["digest"]
        self.assertEqual(step["action"], "build", "the step itself is unchanged")
        self.assertEqual(digest["where"], "LOCAL-001: stage planned; next: build. Groomed and cleared to build.")
        self.assertEqual(digest["needs_person"], "Nothing")
        self.assertTrue(digest["time_and_cost"].endswith("; cost not recorded"))
        self.assertIsNone(digest["cost_usd"])

    def test_a_stop_says_what_a_person_decides(self):
        self.verified()
        self.set_cell(stage="awaiting-human")
        self.assertEqual(self.next()["digest"]["needs_person"], run.NEEDS_TEXT["human-approval"])
        self.assertEqual(self.next(ticket="LOCAL-002")["digest"]["needs_person"], "Answer the grooming interview, one question at a time.")

    def test_only_a_recorded_cost_is_shown_and_time_comes_from_the_cell(self):
        (self.project / ".factory").mkdir()
        self.put(self.project, {
            ".factory/intake/ledger.json": json.dumps({"supervisor": {"executions": {
                "x000000000001": {"ticket_id": "LOCAL-001", "cost_usd": 0.5}, "x000000000002": {"ticket_id": "LOCAL-001", "cost_usd": 0.25},
                "x000000000003": {"ticket_id": "LOCAL-001", "cost_usd": None}, "x000000000004": {"ticket_id": "LOCAL-001", "cost_usd": True},
                "x000000000005": {"ticket_id": "LOCAL-002", "cost_usd": 9.0}}}}),
            ".factory/worktrees/LOCAL-001/cell.json": json.dumps({"stage": "verified", "created_at": "2026-11-12T10:00:00+00:00", "updated_at": "2026-11-12T12:05:00+00:00"}),
        })
        digest = self.next()["digest"]
        self.assertEqual(digest["time_and_cost"], "2 h 5 min recorded; cost $0.75 recorded over 2 executions (2 more with no cost recorded)")
        self.assertEqual((digest["cost_usd"], digest["elapsed_seconds"]), (0.75, 7500.0))
        self.assertTrue(self.next(ticket="LOCAL-003")["digest"]["time_and_cost"].endswith("cost not recorded"))
        self.assertEqual(self.next(ticket="LOCAL-003")["digest"]["time_and_cost"], "time not recorded; cost not recorded")

    def test_board_carries_a_digest(self):
        self.ready()
        self.cell_cmd("open", "LOCAL-009")
        (self.project / ".factory/worktrees/LOCAL-009/cell.json").write_text(json.dumps({"ticket_id": "LOCAL-009", "stage": "blocked"}))
        board = json.loads(self.run_cmd("board")[1])
        self.assertEqual(next(iter(board)), "digest")
        self.assertEqual(board["digest"]["where"], "2 tickets: 1 ready to run, 1 waiting on a person")
        self.assertEqual(board["digest"]["needs_person"], "LOCAL-009: " + run.NEEDS_TEXT["person-to-take-over"])
        self.assertTrue(board["digest"]["time_and_cost"].endswith("cost not recorded"))

    def test_the_digest_reads_no_machine_local_file(self):
        """Cost comes from the intake ledger, which run.py already reads; nothing under .factory/local is opened for it."""
        for name in ("run.py", "explain.py"):
            source = (ROOT / "skills/run/scripts" / name).read_text()
            self.assertNotIn("runner.json", source)
            self.assertNotIn('/ "local"', source)


class BareNumberTest(Base):
    KNOWN = ["LOCAL-001", "LOCAL-004", "LOCAL-104", "GH-7", "LOCAL-007", "104"]

    def test_the_pure_resolver(self):
        resolve = run.resolve_ticket
        self.assertEqual(resolve("4", self.KNOWN), ("LOCAL-004", "4"))
        self.assertEqual(resolve("004", self.KNOWN), ("LOCAL-004", "004"))
        self.assertEqual(resolve("1", self.KNOWN), ("LOCAL-001", "1"))
        self.assertEqual(resolve("LOCAL-004", self.KNOWN), ("LOCAL-004", None), "a full ID is never reinterpreted")
        self.assertEqual(resolve("LOCAL-999", self.KNOWN), ("LOCAL-999", None))
        self.assertEqual(resolve("104", self.KNOWN), ("104", None), "a number that is itself a known ID stays as it is")
        with self.assertRaises(run.RunError) as ambiguous:
            resolve("7", self.KNOWN)
        self.assertIn("GH-7, LOCAL-007", str(ambiguous.exception))
        with self.assertRaises(run.RunError) as missing:
            resolve("55", self.KNOWN)
        self.assertIn("No known ticket has the number 55", str(missing.exception))
        self.assertEqual(resolve("55", self.KNOWN, native_numbers=True), ("55", None), "a GitHub-style tracker numbers its own tickets")
        with self.assertRaises(run.RunError):
            resolve("4", self.KNOWN, native_numbers=True)  # the tracker's own 4 and LOCAL-004

    def test_next_and_explain_accept_a_bare_number(self):
        self.ready()
        step = self.next(ticket="1")
        self.assertEqual((step["ticket_id"], step["resolved_from"], step["action"]), ("LOCAL-001", "1", "build"))
        self.assertNotIn("resolved_from", self.next(ticket="LOCAL-001"))
        code, out, err = self.run_cmd("explain", "001", "--json")
        self.assertEqual(code, 0, err)
        self.assertEqual((json.loads(out)["ticket_id"], json.loads(out)["resolved_from"]), ("LOCAL-001", "001"))

    def test_no_match_and_more_than_one_are_refused(self):
        (self.project / ".factory").mkdir()
        self.put(self.project, {".factory/tickets/LOCAL-004.md": "---\nid: LOCAL-004\nstate: open\nlabels: []\n---\n",
                                ".factory/inbox/JIRA-4.json": json.dumps({"ticket_id": "JIRA-4"})})
        code, _, err = self.run_cmd("next", "9")
        self.assertEqual(code, 1)
        self.assertIn("No known ticket has the number 9", err)
        code, out, err = self.run_cmd("next", "4")
        self.assertEqual((code, out), (1, ""))
        self.assertIn("JIRA-4, LOCAL-004", err)
        self.assertIn("nothing was done", err)


class DoctorTest(Base):
    def test_doctor_is_reachable_without_a_factory_folder(self):
        self.assertFalse((self.project / ".factory").exists())
        calls = []
        fake = type(sys)("doctor")
        fake.main = lambda argv=None, project=None: calls.append((list(argv or []), project)) or 0
        with mock.patch.dict(sys.modules, {"doctor": fake}):
            code, _, err = self.run_cmd("doctor", "--fix", "--json")
            self.assertEqual(code, 0, err)
            self.assertEqual(self.run_cmd("doctor")[0], 0)
        self.assertEqual(calls, [(["--fix", "--json"], self.project), ([], self.project)])
        self.assertFalse((self.project / ".factory").exists(), "run.py itself creates nothing for the doctor")


class WorkflowScriptTest(unittest.TestCase):
    SCRIPT = (ROOT / "workflows" / "belt.js").read_text(encoding="utf-8")

    def test_meta_is_a_pure_literal_at_the_top_with_matching_phases(self):
        self.assertTrue(self.SCRIPT.startswith("export const meta = {"))
        meta = self.SCRIPT[:self.SCRIPT.index("\n}\n") + 3]
        self.assertNotRegex(meta, r"\$\{|\.\.\.|\(\)")
        declared = set(re.findall(r"\{ title: '([^']+)'", meta))
        used = set(re.findall(r"phase\('([^']+)'\)", self.SCRIPT)) | set(re.findall(r": '(Preflight|Groom|Build|Verify|Review|Wrap up)'", self.SCRIPT))
        self.assertTrue(used and used <= declared, used - declared)

    def test_script_avoids_what_workflows_forbid(self):
        body = re.sub(r"//.*", "", self.SCRIPT)
        for banned in ("Date.now", "Math.random", "new Date(", "require(", "import ", "process.", ": string", "interface "):
            self.assertNotIn(banned, body)

    def test_the_script_never_decides_the_order_itself(self):
        self.assertIn("clerk(`next ${ticket} --headless`", self.SCRIPT)
        self.assertIn("/mach:run where", self.SCRIPT)
        self.assertIn("is_mach_project !== true", self.SCRIPT)
        self.assertNotIn("name: 'run'", self.SCRIPT, "the workflow must not share a name with the run skill")
        self.assertNotRegex(self.SCRIPT, r"/mach:(build|verify|review|intent|cleanup)\b", "stations are named by run.py, not hard-coded")

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_body_is_valid_javascript(self):
        body = self.SCRIPT.replace("export const meta", "const meta", 1)
        wrapped = "async function workflow(args, agent, parallel, pipeline, phase, log, budget) {\n" + body + "\n}\n"
        done = subprocess.run(["node", "--check", "-"], input=wrapped, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_a_relayed_step_is_cleaned_before_any_agent_starts(self):
        # M7 P3: a relay returned '""' or blank lines as the agent type; the belt passed it on and the step failed.
        source = self.SCRIPT[self.SCRIPT.index("// BEGIN cleanStep"):self.SCRIPT.index("// END cleanStep")]
        types = re.search(r"const AGENT_TYPES = (.*)\n", self.SCRIPT).group(1)
        cases = {
            "quotes": {"action": "plan", "stop": False, "reason": "r", "agent_type": '""', "model": "opus", "prompt": "Plan it."},
            "blank_lines": {"action": "plan", "stop": False, "reason": "r", "agent_type": "\n\n", "model": "", "prompt": "Plan it."},
            "known": {"action": "build", "stop": False, "reason": "r", "agent_type": " mach-builder ", "prompt": "Build it."},
            "unknown": {"action": "build", "stop": False, "reason": "r", "agent_type": "general-purpose", "prompt": "Build it."},
            "error": {"action": "ERROR", "stop": False, "reason": "refused: no such ticket"},
            "nothing": None,
            "no_prompt": {"action": "verify", "stop": False, "reason": "r", "agent_type": "mach:verifier", "prompt": "  "},
            "made_up": {"action": "deploy", "stop": False, "reason": "r", "prompt": "x"},
            "stop": {"action": "stop", "stop": True, "reason": "waiting", "needs": "human-approval", "agent_type": "''"},
        }
        program = (f"const AGENT_TYPES = {types}\n{source}\nconst cases = {json.dumps(cases)}\n"
                   "const out = {}; for (const [k, v] of Object.entries(cases)) out[k] = cleanStep(v, AGENT_TYPES)\n"
                   "process.stdout.write(JSON.stringify(out))\n")
        done = subprocess.run(["node", "-e", program], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        got = json.loads(done.stdout)
        self.assertEqual((got["quotes"]["step"]["agent_type"], got["quotes"]["step"]["model"], got["quotes"]["note"]), ("", "opus", ""))
        self.assertEqual(got["blank_lines"]["step"]["agent_type"], "")
        self.assertEqual(got["known"]["step"]["agent_type"], "mach-builder")
        self.assertEqual(got["unknown"]["step"]["agent_type"], "")
        self.assertIn("unknown agent type 'general-purpose' ignored", got["unknown"]["note"])
        self.assertEqual(got["error"], {"error": "refused: no such ticket"})
        self.assertEqual(got["nothing"], {"error": "run.py next returned nothing usable"})
        self.assertIn("no prompt", got["no_prompt"]["error"])
        self.assertIn("unknown step 'deploy'", got["made_up"]["error"])
        self.assertEqual((got["stop"]["step"]["stop"], got["stop"]["step"]["agent_type"]), (True, ""))

    def test_the_belt_uses_only_cleaned_steps_and_a_strict_schema(self):
        self.assertIn("const read = cleanStep(await clerk(`next ${ticket} --headless`, STEP", self.SCRIPT)
        self.assertIn("enum: ['', ...AGENT_TYPES]", self.SCRIPT)
        for name in ("builder", "contract-engineer", "verifier", "reviewer"):
            self.assertTrue((ROOT / "agents" / f"{name}.md").is_file(), name)
        shipped = {path.stem for path in (ROOT / "agents").glob("*.md")}
        self.assertEqual(shipped, {"builder", "contract-engineer", "verifier", "reviewer"}, "AGENT_TYPES in belt.js lists every shipped agent")


if __name__ == "__main__":
    unittest.main()
