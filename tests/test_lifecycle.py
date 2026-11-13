"""Tests for the cell lifecycle log (M6.1): what each station records, in what order, and that telemetry never changes a result.

The station scripts stay authoritative; .factory/worktrees/<ticket>/lifecycle.jsonl only reports what they recorded.
"""

import errno
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import textwrap
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
for station in ("audit", "merge", "cleanup", "review", "verify", "build", "intent"):
    sys.path.insert(0, str(ROOT / "skills" / station / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import audit  # noqa: E402
import cleanup  # noqa: E402
import lifecycle  # noqa: E402
import merge  # noqa: E402
import verify  # noqa: E402
from test_build import IMPL, IMPL2, RED_TEST, SCENARIO_TEST  # noqa: E402
from test_review import Base as ReviewBase, NOTE, DETAIL, TARGETS, TICKET  # noqa: E402

SCHEMA = json.loads((ROOT / "docs" / "mach-next" / "schemas" / "cell-lifecycle.schema.json").read_text())
EXECUTION = "x0123456789ab"
# Keys whose values would be prose, commands, people or environment: none may appear in a record.
FORBIDDEN_KEYS = {"command", "commands", "prompt", "note", "detail", "summary", "title", "by", "env", "environment", "output", "output_tail",
                  "findings", "text", "message", "reason", "workdir", "cwd"}


# ---- a small validator for the subset of JSON Schema the lifecycle schema uses ----

def schema_errors(value, schema, root=SCHEMA, where="$"):
    if "$ref" in schema:
        target = root
        for part in schema["$ref"].lstrip("#/").split("/"):
            target = target[part]
        return schema_errors(value, target, root, where)
    errors = []
    kinds = schema.get("type")
    if kinds is not None:
        kinds = kinds if isinstance(kinds, list) else [kinds]
        checks = {"null": value is None, "boolean": isinstance(value, bool), "integer": isinstance(value, int) and not isinstance(value, bool),
                  "number": isinstance(value, (int, float)) and not isinstance(value, bool), "string": isinstance(value, str),
                  "array": isinstance(value, list), "object": isinstance(value, dict)}
        if not any(checks[kind] for kind in kinds):
            return [f"{where}: {value!r} is not {kinds}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{where}: {value!r} != {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{where}: {value!r} not in {schema['enum']}")
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{where}: {value!r} does not match {schema['pattern']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{where}: too long")
    if isinstance(value, int) and not isinstance(value, bool) and "minimum" in schema and value < schema["minimum"]:
        errors.append(f"{where}: {value} < {schema['minimum']}")
    if isinstance(value, list):
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{where}: too many items")
        for index, item in enumerate(value):
            errors += schema_errors(item, schema.get("items", {}), root, f"{where}[{index}]")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{where}: missing {key}")
        properties = schema.get("properties", {})
        for key, item in value.items():
            if "propertyNames" in schema:
                errors += schema_errors(key, schema["propertyNames"], root, f"{where}.<{key}>")
            if key in properties:
                errors += schema_errors(item, properties[key], root, f"{where}.{key}")
            elif schema.get("additionalProperties") is False:
                errors.append(f"{where}: unexpected {key}")
            elif isinstance(schema.get("additionalProperties"), dict):
                errors += schema_errors(item, schema["additionalProperties"], root, f"{where}.{key}")
    if "anyOf" in schema and not any(not schema_errors(value, option, root, where) for option in schema["anyOf"]):
        errors.append(f"{where}: matches none of anyOf")
    for part in schema.get("allOf", []):
        if "if" in part:
            if not schema_errors(value, part["if"], root, where):
                errors += schema_errors(value, part["then"], root, where)
        else:
            errors += schema_errors(value, part, root, where)
    return errors


class Base(ReviewBase):
    def history(self, raw=None):
        return lifecycle.parse(raw) if raw is not None else lifecycle.read(self.cellroot)

    def kinds(self, records=None):
        return [(r["type"], r["station"], r["visit"], r["round"]) for r in (records if records is not None else self.history())]

    def assert_valid_and_safe(self, raw):
        records = lifecycle.parse(raw)
        self.assertEqual(len(records), len([line for line in raw.split(b"\n") if line.strip()]), "every line is a whole record")
        for record in records:
            self.assertEqual(schema_errors(record, SCHEMA), [], record)
        text = raw.decode("utf-8")
        self.assertNotIn(self.tmp.name, text, "no absolute path")
        self.assertNotIn(str(Path(self.tmp.name).resolve()), text, "no absolute path")
        for prose in (NOTE, DETAIL, "Sam Approver", "ignores the email"):
            self.assertNotIn(prose, text, "no finding text, note or person's name")

        def walk(value, path="data"):
            if isinstance(value, dict):
                for key, item in value.items():
                    self.assertNotIn(key, FORBIDDEN_KEYS, f"{path}.{key}")
                    walk(item, f"{path}.{key}")
            elif isinstance(value, list):
                for item in value:
                    walk(item, path)
            elif isinstance(value, str):
                self.assertFalse(value.startswith(("/", "~", "\\")), f"{path}: {value}")
        for record in records:
            walk(record["data"])
        return records

    def vrun(self, *argv):
        return self.run_main(verify, *argv)

    def v_ok(self, *argv):
        code, out, err = self.vrun(*argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def v_refused(self, *argv):
        code, out, err = self.vrun(*argv)
        self.assertEqual(code, 1, out)
        return err + out

    def run_main(self, module, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = module.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def revise(self, findings, loop):
        self.ok("revise", TICKET, "--findings", str(findings))
        self.ok("add-task", TICKET, "--kind", "docs", "--text", f"Explain round {loop} (FR-01)", "--file", "README.md")
        self.put(self.work, {"README.md": f"# Sample\n\nRound {loop}.\n"})
        self.ok("done", TICKET, f"R{loop}-T01")
        self.ok("finish", TICKET)

    def verify_all(self, failing=()):
        self.vrun("start", TICKET)
        (self.evidence / "consumer-run.log").write_text("checked\n")
        for target in TARGETS:
            self.vrun("record", TICKET, target, "--result", "fail" if target in failing else "pass", "--evidence", "consumer-run.log", "--note", NOTE)
        code, out, _ = self.vrun("finish", TICKET)
        return code, json.loads(out)


class WholeBeltTest(Base):
    """One ticket through every station: a failed verification, two review rounds, a person's approval, a merge and cleanup."""

    def test_every_station_and_record_type_in_one_history(self):
        self.config({"review": {"medium": {"human_approval": True}}})
        self.groom()
        # The audit is repository-wide; it is recorded in the cell that waits on it. Without commands it scores Bronze here.
        self.run_main(audit, "run", "--no-run", "--json")
        self.audit_report("Gold")
        self.assertIn("Only a built cell can be verified", self.v_refused("start", TICKET))  # a gate refused at verify's door
        self.ok("start", TICKET)
        with mock.patch.dict(os.environ, {lifecycle.ENV: EXECUTION}):  # supervisor-run work carries its execution ID
            self.build_through("T05")
        self.ok("finish", TICKET)

        code, verdict = self.verify_all(failing=("AC-02",))  # round 1: verification fails
        self.assertEqual((code, verdict["status"]), (1, "FAIL_WITH_EVIDENCE"))
        self.revise(self.evidence / "findings.md", 1)
        self.assertEqual(self.verify_all()[1]["status"], "PASS")  # round 2: verified
        self.r_ok("start", TICKET)
        self.cast(rejecting=("architecture", "product"))
        self.assertEqual(self.tally()[1]["outcome"], "REJECTED")  # round 2: the panel rejects
        self.revise(self.cellroot / "review" / "round-2" / "findings.md", 2)
        self.assertEqual(self.verify_all()[1]["status"], "PASS")  # round 3: verified again
        self.r_ok("start", TICKET)
        self.cast()
        self.assertEqual(self.tally()[1]["outcome"], "AWAITING_HUMAN")
        self.r_ok("approve-human", TICKET, "--by", "Sam Approver")
        code, out, err = self.run_main(merge, "run", TICKET, "--by-person")
        self.assertEqual(code, 0, err + out)
        live = (self.cellroot / lifecycle.FILE).read_bytes()
        code, out, err = self.run_main(cleanup, "run", TICKET)
        self.assertEqual(code, 0, err + out)
        self.assertFalse(self.cellroot.exists())

        # Replay from the archive: the live history, then cleanup's own records.
        with tarfile.open(str(self.project / ".factory/archive/LOCAL-001.tar.gz")) as tar:
            archived = tar.extractfile(f"{TICKET}/{lifecycle.FILE}").read()
        self.assertTrue(archived.startswith(live), "the archive keeps the whole live history unchanged")
        records = self.assert_valid_and_safe(archived)
        self.assertEqual(set(r["type"] for r in records), set(lifecycle.TYPES), "every record type is emitted by a real flow")
        self.assertEqual([r["seq"] for r in records], list(range(1, len(records) + 1)), "one writer at a time: seq is 1..n in file order")
        self.assertEqual({r["ticket_id"] for r in records}, {TICKET})

        entered = [(r["visit"], r["round"]) for r in records if r["type"] == "station.entered"]
        self.assertEqual(entered, [("groom#1", None), ("plan#1", None), ("audit#1", None), ("build#1", 1), ("verify#1", 1), ("build#2", 2), ("verify#2", 2),
                                   ("review#1", 2), ("build#3", 3), ("verify#3", 3), ("review#2", 3), ("human-approval#1", 3), ("merge#1", None),
                                   ("cleanup#1", None)])
        exits = {r["visit"]: r["data"]["outcome"] for r in records if r["type"] == "station.exited"}
        self.assertEqual(exits, {"groom#1": "spec-ready", "plan#1": "planned", "audit#1": "bronze", "build#1": "built", "verify#1": "FAIL_WITH_EVIDENCE",
                                 "build#2": "built", "verify#2": "PASS", "review#1": "REJECTED", "build#3": "built", "verify#3": "PASS",
                                 "review#2": "AWAITING_HUMAN", "human-approval#1": "approved", "merge#1": "merged", "cleanup#1": "merged"})

        refused_at_door = [r for r in records if r["type"] == "gate.evaluated" and r["data"]["outcome"] == "refuse" and r["station"] == "verify"]
        self.assertEqual([(r["visit"], r["data"]["gate"], r["data"]["reason_code"]) for r in refused_at_door],
                         [("verify#1", "verify.start", "wrong-stage"), ("verify#1", "verify.verdict", "FAIL_WITH_EVIDENCE")])
        tasks = [r for r in records if r["type"] == "build.task_completed"]
        self.assertEqual([(r["data"]["task"], r["data"]["step"], r["data"]["first_run"], r["round"]) for r in tasks],
                         [("T01", "red", "fail", 1), ("T02", "green", None, 1), ("T03", "red", "fail", 1), ("T04", "green", None, 1),
                          ("T05", "done", None, 1), ("R1-T01", "done", None, 2), ("R2-T01", "done", None, 3)])
        self.assertTrue(all(re.match(r"^[0-9a-f]{12}$", r["data"]["commit"]) for r in tasks))
        self.assertEqual({r["execution_id"] for r in tasks[:5]}, {EXECUTION})
        self.assertEqual({r["execution_id"] for r in records if r not in tasks[:5]}, {None})

        checks = [r for r in records if r["type"] == "verify.check_recorded"]
        self.assertEqual(len(checks), 3 * len(TARGETS))
        failed = [r for r in checks if r["data"]["result"] == "fail"]
        self.assertEqual([(r["visit"], r["round"], r["data"]["item"]) for r in failed], [("verify#1", 1, "AC-02")])
        self.assertEqual(failed[0]["data"]["evidence"][0]["path"], "evidence/consumer-run.log")

        rounds = [(r["visit"], r["data"]["round"], r["data"]["seats"], r["data"]["approvals_needed"]) for r in records if r["type"] == "review.round_started"]
        self.assertEqual(rounds, [("review#1", 2, ["architecture", "security", "product"], 2), ("review#2", 3, ["architecture", "security", "product"], 2)])
        votes = [(r["visit"], r["data"]["seat"], r["data"]["vote"], r["data"]["blockers"], r["data"]["rules"]) for r in records if r["type"] == "review.verdict_submitted"]
        self.assertEqual(votes[:3], [("review#1", "architecture", "REJECT", 1, ["FR-01"]), ("review#1", "security", "APPROVE", 0, []),
                                     ("review#1", "product", "REJECT", 1, ["FR-01"])])
        self.assertEqual(len(votes), 6)
        decided = [(r["visit"], r["data"]["decision"], r["data"]["approvals"], r["data"]["needed"]) for r in records if r["type"] == "review.decided"]
        self.assertEqual(decided, [("review#1", "REJECTED", 1, 2), ("review#2", "AWAITING_HUMAN", 3, 2)])
        approval = next(r for r in records if r["type"] == "human.approval_recorded")
        self.assertEqual((approval["visit"], approval["round"], approval["data"]["decision"]), ("human-approval#1", 3, "APPROVED"))
        landed = next(r for r in records if r["type"] == "merge.completed")["data"]
        self.assertEqual((landed["method"], landed["pull_request"], landed["approved_commit"]), ("local", None, landed["landed_commit"]))
        done = next(r for r in records if r["type"] == "cleanup.completed")["data"]
        self.assertEqual((done["outcome"], done["archive"]), ("merged", ".factory/archive/LOCAL-001.tar.gz"))
        audit_gate = next(r for r in records if r["station"] == "audit" and r["type"] == "gate.evaluated")["data"]
        self.assertEqual((audit_gate["outcome"], audit_gate["reason_code"]), ("refuse", "bronze"))


class HistoryTest(Base):
    def test_overrides_and_refusals_keep_their_history(self):
        self.ready()
        self.ok("start", TICKET)
        self.put(self.work, {"tests/test_invite.py": "import unittest\n\n# FR-01\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n"})
        self.assertIn("never seen failing", self.refused("red", TICKET, "T01"))
        self.ok("red", TICKET, "T01", "--covered", "Earlier work in the base suite already satisfies this check.")
        gates = [(r["visit"], r["data"]["gate"], r["data"]["outcome"], r["data"]["reason_code"], r["data"]["overridden_by_reason"])
                 for r in self.history() if r["type"] == "gate.evaluated"]
        self.assertEqual(gates[-2:], [("build#1", "build.red", "refuse", "red-before-green", False),
                                      ("build#1", "red-before-green", "override", "test-passed-first-run", True)])
        self.assertNotIn("Earlier work", (self.cellroot / lifecycle.FILE).read_text(), "the override's reason stays in build.json")

    def test_escalation_is_an_exit_with_its_outcome(self):
        self.config({"review": {"max_loops": 2}})
        self.ready()
        self.ok("start", TICKET)
        self.build_through("T05")
        self.ok("finish", TICKET)
        self.ok("revise", TICKET)
        self.ok("finish", TICKET)
        code, out, _ = self.run_build("revise", TICKET)
        self.assertEqual((code, json.loads(out)["status"]), (1, "ESCALATE"))
        tail = self.history()[-3:]
        self.assertEqual([(r["type"], r["visit"], r["round"], r["data"].get("outcome")) for r in tail],
                         [("gate.evaluated", "build#3", 2, "refuse"), ("station.entered", "build#3", 2, None), ("station.exited", "build#3", 2, "escalated")])

    def test_abandoning_closes_the_open_visit_in_the_archive(self):
        self.ready()
        self.ok("start", TICKET)
        self.build_through("T02")
        code, out, err = self.run_main(cleanup, "run", TICKET, "--abandon", "Product cancelled the feature this week.")
        self.assertEqual(code, 0, err + out)
        with tarfile.open(str(self.project / ".factory/archive/LOCAL-001.tar.gz")) as tar:
            records = self.assert_valid_and_safe(tar.extractfile(f"{TICKET}/{lifecycle.FILE}").read())
        self.assertEqual([(r["type"], r["visit"], r["data"].get("outcome")) for r in records[-5:]],
                         [("station.exited", "build#1", "abandoned"), ("gate.evaluated", "cleanup#1", "pass"), ("station.entered", "cleanup#1", None),
                          ("cleanup.completed", "cleanup#1", "abandoned"), ("station.exited", "cleanup#1", "abandoned")])

    def test_a_restarted_visit_says_the_earlier_one_never_exited(self):
        self.built()
        self.v_ok("start", TICKET)
        self.v_ok("start", TICKET)
        entered = [r for r in self.history() if r["type"] == "station.entered" and r["station"] == "verify"]
        self.assertEqual([(r["visit"], r["data"].get("unclosed_visit")) for r in entered], [("verify#1", None), ("verify#2", "verify#1")])
        self.assertEqual(entered[1]["data"]["previous_evidence"], "evidence/previous-1")

    def test_resuming_grooming_is_the_same_visit(self):
        self.cell_cmd("open", TICKET)
        self.cell_cmd("open", TICKET)
        self.assertEqual(self.kinds(), [("station.entered", "groom", "groom#1", None)])

    def test_invalid_execution_id_is_not_recorded(self):
        with mock.patch.dict(os.environ, {lifecycle.ENV: "$(whoami) /etc/passwd"}):
            self.cell_cmd("open", TICKET)
        self.assertIsNone(self.history()[0]["execution_id"])


class FailureTest(Base):
    """A telemetry failure never changes a station's exit code, its output, or its files."""

    def flow(self):
        """Build, verify and review a ticket, returning every step's exit code and normalised output."""
        steps = []

        def keep(code, out, err):
            normal = re.sub(r"[0-9a-f]{7,40}", "<sha>", out.replace(str(self.project), "<project>"))
            normal = re.sub(r"\d{4}-\d{2}-\d{2}T[\d:.+Z-]+", "<time>", normal)
            normal = re.sub(r'"seconds": [\d.]+', '"seconds": 0', normal)
            steps.append((code, normal, [line for line in err.splitlines() if not line.startswith("mach lifecycle:")]))

        keep(*self.run_build("start", TICKET))
        for task, step, files in (("T01", "red", {"tests/test_invite.py": RED_TEST}), ("T02", "green", {"app/invite.py": IMPL}),
                                  ("T03", "red", {"tests/test_scenarios.py": SCENARIO_TEST}), ("T04", "green", {"app/invite.py": IMPL2}),
                                  ("T05", "done", {"README.md": "# Sample\n\nInvites.\n"})):
            self.put(self.work, files)
            keep(*self.run_build(step, TICKET, task))
        keep(*self.run_build("finish", TICKET))
        keep(*self.vrun("start", TICKET))
        (self.evidence / "consumer-run.log").write_text("checked\n")
        for target in TARGETS:
            keep(*self.vrun("record", TICKET, target, "--result", "pass", "--evidence", "consumer-run.log", "--note", NOTE))
        keep(*self.vrun("finish", TICKET))
        keep(*self.run_review("start", TICKET))
        for role in ("architecture", "security", "product"):
            keep(*self.submit(role))
        keep(*self.run_review("tally", TICKET))
        keep(*self.run_build("start", TICKET))  # a refusal, recorded when telemetry works
        stage = json.loads((self.cellroot / "cell.json").read_text())["stage"]
        return steps, stage

    def baseline(self):
        self.ready()
        expected = self.flow()
        self.assertEqual(expected[1], "approved")
        self.assertGreater(len(self.history()), 20)
        self.setUp()  # a second, fresh project for the same flow
        self.ready()
        return expected

    def test_a_directory_in_place_of_the_log(self):
        expected = self.baseline()
        (self.cellroot / lifecycle.FILE).unlink()
        (self.cellroot / lifecycle.FILE).mkdir()
        self.assertEqual(self.flow(), expected)
        self.assertTrue((self.cellroot / lifecycle.FILE).is_dir())

    def test_a_full_disk(self):
        expected = self.baseline()
        before = (self.cellroot / lifecycle.FILE).read_bytes()
        with mock.patch.object(lifecycle, "_write_all", side_effect=OSError(errno.ENOSPC, "No space left on device")):
            self.assertEqual(self.flow(), expected)
        self.assertEqual((self.cellroot / lifecycle.FILE).read_bytes(), before)

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root ignores file permissions")
    def test_a_read_only_cell_folder(self):
        self.built()
        self.v_ok("start", TICKET)
        (self.cellroot / lifecycle.FILE).unlink()
        os.chmod(self.cellroot, 0o555)
        self.addCleanup(os.chmod, self.cellroot, 0o755)
        recorded = self.record_target("AC-01")
        self.assertEqual((recorded["status"], recorded["id"]), ("RECORDED", "AC-01"))
        self.assertIn("AC-01", json.loads((self.evidence / "results.json").read_text())["records"])
        self.assertFalse((self.cellroot / lifecycle.FILE).exists())

    def record_target(self, target):
        (self.evidence / "consumer-run.log").write_text("checked\n")
        return self.v_ok("record", TICKET, target, "--result", "pass", "--evidence", "consumer-run.log", "--note", NOTE)

    def test_a_torn_last_line_does_not_break_later_records(self):
        self.ready()
        path = self.cellroot / lifecycle.FILE
        last = self.history()[-1]["seq"]
        with path.open("ab") as handle:
            handle.write(b'{"v":1,"seq":999,"at":"2026-11-12T00:00:00.000Z","type":"station.ent')  # a writer killed mid-line
        self.ok("start", TICKET)
        raw = path.read_bytes()
        self.assertIn(b'"type":"station.ent\n{"v":1,', raw, "the next record starts on a new line")
        unreadable = [line for line in raw.split(b"\n") if line.strip() and not lifecycle.parse(line)]
        self.assertEqual(len(unreadable), 1)
        self.assertTrue(unreadable[0].endswith(b'"type":"station.ent'))
        records = self.history()
        self.assertEqual([r["seq"] for r in records][-2:], [last + 1, last + 2], "the torn line is skipped, never counted")
        self.assertEqual([r["type"] for r in records][-2:], ["gate.evaluated", "station.entered"])
        for record in records:
            self.assertEqual(schema_errors(record, SCHEMA), [], record)

    def test_an_interruption_between_the_station_write_and_the_log_write(self):
        self.ready()
        self.ok("start", TICKET)
        self.build_through("T05")
        with mock.patch.object(lifecycle, "_write_all", side_effect=KeyboardInterrupt):  # the process dies after build.json and cell.json are written
            with self.assertRaises(KeyboardInterrupt):
                self.run_build("finish", TICKET)
        self.assertEqual(json.loads((self.cellroot / "cell.json").read_text())["stage"], "built", "the station's own state is authoritative")
        self.v_ok("start", TICKET)
        build_events = [r["type"] for r in self.history() if r["station"] == "build"]
        self.assertNotIn("station.exited", build_events, "the lost exit is missing, not invented")
        self.assertEqual(self.history()[-1]["type"], "station.entered")
        self.assertEqual(self.history()[-1]["visit"], "verify#1")


class ConcurrencyTest(unittest.TestCase):
    def test_two_processes_append_whole_lines_with_unique_seq(self):
        import tempfile
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cell = Path(tmp.name) / ".factory" / "worktrees" / TICKET
        cell.mkdir(parents=True)
        (cell / "cell.json").write_text("{}")
        writer = textwrap.dedent(f"""
            import sys
            sys.path.insert(0, {str(ROOT / 'skills' / 'intent' / 'scripts')!r})
            import lifecycle
            for n in range(150):
                lifecycle.record(sys.argv[1], "gate.evaluated", "build", {{"gate": "writer-" + sys.argv[2], "outcome": "pass", "reason_code": None,
                                                                          "overridden_by_reason": False, "n": n}})
        """)
        procs = [subprocess.Popen([sys.executable, "-c", writer, str(cell), name]) for name in ("a", "b")]
        for proc in procs:
            self.assertEqual(proc.wait(timeout=120), 0)
        raw = (cell / lifecycle.FILE).read_bytes()
        lines = raw.split(b"\n")
        self.assertEqual(lines[-1], b"")
        records = [json.loads(line) for line in lines[:-1]]  # every line is a whole JSON object
        self.assertEqual(len(records), 300)
        for name in ("a", "b"):
            self.assertEqual([r["data"]["n"] for r in records if r["data"]["gate"] == f"writer-{name}"], list(range(150)))
        seqs = [r["seq"] for r in records if r["seq"] is not None]
        self.assertEqual(seqs, sorted(set(seqs)), "unique and increasing in file order")
        self.assertGreater(len(seqs), 250, "the lock is normally free within the wait")


class ModuleTest(unittest.TestCase):
    def test_never_creates_a_cell_and_never_raises(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / ".factory" / "worktrees" / TICKET
            self.assertIsNone(lifecycle.record(missing, "station.entered", "build", {"stage": "x"}))
            self.assertFalse(missing.exists())
            missing.mkdir(parents=True)
            (missing / "cell.json").write_text("{}")
            err = io.StringIO()
            with redirect_stderr(err):
                self.assertIsNone(lifecycle.record(missing, "no.such.type", "build"))
                self.assertIsNone(lifecycle.record(missing, "station.entered", "build", lambda: 1 / 0))
                self.assertIsNone(lifecycle.record(Path(tmp) / ".factory" / "worktrees" / ".." / "worktrees" / TICKET, "station.entered", "build", {"stage": "x"}))
            self.assertLessEqual(len(err.getvalue().splitlines()), 1, "at most one line on stderr")
            self.assertFalse((missing / lifecycle.FILE).exists() and lifecycle.read(missing))

    def test_safe_drops_paths_and_prose_shapes(self):
        self.assertEqual(lifecycle.safe({"a": "/Users/x/secret", "b": "C:\\x", "c": "~/x", "d": "evidence/a.log", "Bad Key": 1, "e": "two\nlines", "f": [1, "/etc"]}),
                         {"a": None, "b": None, "c": None, "d": "evidence/a.log", "e": None, "f": [1, None]})
        self.assertEqual(lifecycle.rule_ids("Breaks FR-04 and the REVIEW.md rule on R2; see AC-01."), ["AC-01", "FR-04", "R2"])
        self.assertEqual(lifecycle.short("0123456789abcdef0123"), "0123456789ab")
        self.assertIsNone(lifecycle.short("not a commit"))


if __name__ == "__main__":
    unittest.main()
