"""Tests for lanes in the build station (M22 design, piece C1): build.py builds a plan's independent parts at the same time,
each lane in its own worktree with its own state file, under the same gates, and joins them at the end.

Every scenario runs real Git in a temporary project with a small Python project and its test suite, as test_build does.
The join calls landing.py (piece C2); where that module is not installed yet, a stand-in with the same interface, defined
here, does the landing with real Git, so the station's own part is tested either way.
"""

import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "skills" / "build" / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import build  # noqa: E402
import test_build  # noqa: E402  (its fixtures: the sample project, the spec and the plan)
from test_build import IMPL, IMPL2, PLAN, RED_TEST, SCENARIO_TEST, git  # noqa: E402

# build.py as it was before lanes were added to it (blob of skills/build/scripts/build.py at the lane calculator's merge).
BEFORE_LANES_BLOB = "67f37ddd1ce0378d7094f624ce38d2bab3daf3df"


def build_before_lanes():
    """The build station from before this change, loaded from the repository's history; None where the history is not here."""
    done = subprocess.run(["git", "cat-file", "-p", BEFORE_LANES_BLOB], cwd=str(ROOT), capture_output=True, text=True)
    if done.returncode != 0:
        return None
    folder = Path(tempfile.mkdtemp(prefix="mach-build-before-"))
    path = folder / "build_before_lanes.py"
    path.write_text(done.stdout, encoding="utf-8")
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec = importlib.util.spec_from_file_location("mach_build_before_lanes", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


TIME_RE = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?")
HEX_RE = re.compile(r"\b[0-9a-f]{7,40}\b")
RAN_RE = re.compile(r"\bin \d+\.\d+s\b")


def mask(value, project):
    """A recorded value with what differs between two identical builds made a moment apart masked: the project's folder,
    clock times, durations and commit IDs. Nothing else."""
    if isinstance(value, dict):
        return {key: ("<seconds>" if "seconds" in key and isinstance(item, (int, float)) else mask(item, project))
                for key, item in value.items()}
    if isinstance(value, list):
        return [mask(item, project) for item in value]
    if isinstance(value, str):
        text = value.replace(str(project), "<P>")
        text = TIME_RE.sub("<T>", text)
        text = RAN_RE.sub("in <S>s", text)
        return HEX_RE.sub("<H>", text)
    return value


class SequentialAsBeforeTest(test_build.Base):
    """Design 15, scenario 12, with the owner's decision: a plan written without the parts or `after` marks is built exactly as
    before, whatever build.max_lanes says. The fixture plan would split into two lanes by the lane rule (T05 touches only the
    README), so it is the plan that decides, not the rule."""

    module = build

    def run_build(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = self.module.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def script(self, setting):
        """A whole build through the station: start, every task (with refusals on the way), finish, one revision round and its
        finish. Returns everything it printed and recorded, masked."""
        if setting is not None:
            self.put(self.project, {".factory/config.json": json.dumps({"build": {"max_lanes": setting}})})
        self.ready()
        outputs = []

        def call(*argv):
            code, out, err = self.run_build(*argv)
            try:
                printed = json.loads(out)
            except ValueError:
                printed = out
            outputs.append([code, printed, err])

        call("start", "LOCAL-001")
        call("next", "LOCAL-001")
        call("red", "LOCAL-001", "T01")
        call("green", "LOCAL-001", "T02")
        steps = [("T01", "red", {"tests/test_invite.py": RED_TEST}), ("T02", "green", {"app/invite.py": IMPL}),
                 ("T03", "red", {"tests/test_scenarios.py": SCENARIO_TEST}), ("T04", "green", {"app/invite.py": IMPL2}),
                 ("T05", "done", {"README.md": "# Sample\n\nAdmins can invite teammates.\n"})]
        for task, step, files in steps:
            self.put(self.work, files)
            call(step, "LOCAL-001", task)
            call("next", "LOCAL-001")
        call("status", "LOCAL-001")
        call("finish", "LOCAL-001")
        report = json.loads((self.cellroot / "build-report.json").read_text())
        findings = Path(self.tmp.name) / "findings.md"
        findings.write_text("1. The README does not say who may invite.\n")
        call("revise", "LOCAL-001", "--findings", str(findings))
        call("add-task", "LOCAL-001", "--kind", "docs", "--text", "Say who may invite (FR-01)", "--file", "README.md")
        self.put(self.work, {"README.md": "# Sample\n\nAdmins can invite teammates.\n"})
        call("done", "LOCAL-001", "R1-T01")
        self.put(self.work, {"README.md": "# Sample\n\nOnly admins can invite teammates.\n"})
        call("done", "LOCAL-001", "R1-T01")
        call("finish", "LOCAL-001")
        lifecycle = [{"type": r["type"], "data": r["data"]} for r in
                     (json.loads(line) for line in (self.cellroot / "lifecycle.jsonl").read_text().splitlines())]
        recorded = {
            "outputs": outputs, "first_report": report,
            "build.json": json.loads((self.cellroot / "build.json").read_text()),
            "build-report.json": json.loads((self.cellroot / "build-report.json").read_text()),
            "cell.json": json.loads((self.cellroot / "cell.json").read_text()),
            "plan.md": (self.cellroot / "plan.md").read_text(), "lifecycle": lifecycle,
            "cell files": sorted(p.name for p in self.cellroot.iterdir()),
        }
        history = git(self.work, "log", "--format=%T %s").stdout  # trees are content only, so they are compared unmasked
        return mask(recorded, self.project), history

    def recorded_before(self):
        cached = getattr(type(self), "_recorded", None)
        if cached is not None:
            return cached
        old = build_before_lanes()
        if old is None:
            self.skipTest("the build station from before lanes is not in this repository's history")
        self.module = old
        try:
            result = self.script(None)
        finally:
            self.module = build
        type(self)._recorded = result
        return result

    def check_same(self, setting):
        fresh = getattr(type(self), "_recorded", None) is None
        before = self.recorded_before()
        if fresh:  # the build before used this test's project: start again from a new one at the same path
            self.tmp.cleanup()
            Path(self.tmp.name).mkdir()
            test_build.class_template.step(self, "project", self.project.parent, self.sample_project)
        after = self.script(setting)
        self.maxDiff = None
        self.assertEqual(after[1], before[1], "the same commits, with the same trees and messages")
        self.assertEqual(after[0]["outputs"], before[0]["outputs"], "every command prints the same")
        for name in ("build.json", "build-report.json", "first_report", "cell.json", "plan.md", "lifecycle", "cell files"):
            self.assertEqual(after[0][name], before[0][name], name)
        self.assertFalse((self.cellroot / "lanes").exists(), "no lane is ever made")

    def test_with_no_setting(self):
        self.check_same(None)

    def test_at_one(self):
        self.check_same(1)

    def test_at_three(self):
        self.check_same(3)

    def test_at_an_unusable_setting(self):
        self.check_same("four")


if __name__ == "__main__":
    unittest.main()
