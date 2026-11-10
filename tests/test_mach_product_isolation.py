"""MACH Next M0 must not change the existing line: nothing dispatches from product artifacts or the local policy."""

import ast
import hashlib
import json
import shutil
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from mach_product import read_local_policy, validate_workspace  # noqa: E402
from test_run import Base  # noqa: E402

SEED = ROOT / "docs" / "mach-next" / "example-project"
ENABLED = {"schema_version": 1, "enabled": True, "paused": False, "auto_sync": True, "autonomy": "extended"}


class LineIsUnchangedTest(Base):
    """run.py names the same next step whether or not approved product work and an enabled policy are present."""

    def add_approved_product_and_enabled_policy(self):
        shutil.copytree(SEED / "product", self.project / "product")
        spec = self.project / "specs/slices/SLICE-001-invite-member.md"
        spec.parent.mkdir(parents=True, exist_ok=True)
        spec.write_text("# SLICE-001: Invite member\n\nTest-only content; not a valid MACH intent spec.\n")
        for relative, change in (
            ("product/slices/SLICE-001.json", {"status": "approved_for_engineering", "open_questions": [],
                                               "spec_path": "specs/slices/SLICE-001-invite-member.md",
                                               "spec_sha256": hashlib.sha256(spec.read_bytes()).hexdigest()}),
            ("product/delivery-waves/WAVE-001.json", {"status": "approved_for_engineering",
                                                      "approval": {"actor": "PM A", "approved_at": "2026-11-10T14:00:00Z"}}),
        ):
            path = self.project / relative
            path.write_text(json.dumps({**json.loads(path.read_text()), **change}))
        local = self.project / ".factory/local"
        local.mkdir(parents=True)
        (local / "runner.json").write_text(json.dumps(ENABLED))

    def observe(self):
        code, board, err = self.run_cmd("board")
        self.assertEqual(code, 0, err)
        return {"next": self.next(), "headless": self.next("--headless"), "other": self.next(ticket="LOCAL-002"), "board": json.loads(board)}

    def check_unchanged(self):
        before = self.observe()
        self.add_approved_product_and_enabled_policy()
        report = validate_workspace(self.project)
        self.assertTrue(report["valid"], report["errors"])
        self.assertFalse(report["factory_authorized"])
        self.assertTrue(read_local_policy(self.project)["enabled"])  # the policy is readable, and still starts nothing
        self.assertEqual(self.observe(), before)
        self.assertFalse((self.project / ".factory/tickets").exists())
        self.assertFalse((self.project / ".factory/worktrees/LOCAL-002").exists())

    def test_with_no_cell(self):
        (self.project / ".factory").mkdir(exist_ok=True)
        self.check_unchanged()

    def test_with_an_open_cell(self):
        self.cell_cmd("open", "LOCAL-001")
        self.check_unchanged()

    def test_with_a_built_cell(self):
        self.built()
        self.check_unchanged()


class NothingIsWiredInTest(unittest.TestCase):
    def test_no_station_reads_the_product_package_or_the_local_policy(self):
        """Until the supervisor milestone, no skill, agent, workflow, template or installer may mention either."""
        found = []
        for top in ("skills", "agents", "workflows", "templates", "bin"):
            for path in sorted((ROOT / top).rglob("*")):
                if path.is_file() and "__pycache__" not in path.parts:
                    text = path.read_text(encoding="utf-8", errors="ignore")
                    found += [f"{path.relative_to(ROOT)}: {word}" for word in ("mach_product", "runner.json") if word in text]
        self.assertEqual(found, [])

    def test_the_product_package_cannot_start_or_serve_anything(self):
        """Standard-library reading and checking only: no processes, no network, no writing."""
        allowed = {"argparse", "datetime", "hashlib", "json", "re", "sys", "pathlib", "typing", "validate"}
        for path in sorted((ROOT / "mach_product").glob("*.py")):
            tree = ast.parse(path.read_text())
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [alias.name.split(".")[0] for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    names = [(node.module or "").split(".")[0]]
                for name in names:
                    self.assertIn(name, allowed, f"{path.name} imports {name}")
                if isinstance(node, ast.Attribute):
                    self.assertNotIn(node.attr, ("write_text", "write_bytes", "unlink", "mkdir", "rename", "system", "popen"), path.name)
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                    self.assertNotIn(node.func.id, ("open", "exec", "eval", "__import__"), path.name)

    def test_report_never_authorizes(self):
        source = (ROOT / "mach_product" / "validate.py").read_text()
        self.assertNotIn('"factory_authorized": True', source)
        self.assertEqual(source.count('"factory_authorized": False'), 2)


if __name__ == "__main__":
    unittest.main()
