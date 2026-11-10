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


if __name__ == "__main__":
    unittest.main()
