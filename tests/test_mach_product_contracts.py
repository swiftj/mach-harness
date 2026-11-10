"""MACH Next M0 structural and fail-closed guardrail tests (stdlib only)."""

import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from mach_product import read_local_policy, validate_workspace

SEED = Path(__file__).resolve().parents[1] / "docs" / "mach-next" / "example-project"
ROOT = Path(__file__).resolve().parents[1]


class ProductValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "repo"
        shutil.copytree(SEED, self.root)

    def doc(self, relative):
        return self.root / relative

    def edit(self, relative, f):
        path = self.doc(relative)
        data = json.loads(path.read_text())
        f(data)
        path.write_text(json.dumps(data, indent=2) + "\n")

    def approved(self):
        location = "specs/slices/SLICE-001-invite-member.md"
        target = self.doc(location)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("# SLICE-001: Invite member\n\nTest-only content; not a valid MACH intent spec.\n")
        digest = hashlib.sha256(target.read_bytes()).hexdigest()

        def approve_slice(obj):
            obj.update({"status": "approved_for_engineering", "open_questions": [], "spec_path": location, "spec_sha256": digest})

        def approve_wave(obj):
            obj.update({"status": "approved_for_engineering", "approval": {"actor": "PM A", "approved_at": "2026-11-10T14:00:00Z"}})

        self.edit("product/slices/SLICE-001.json", approve_slice)
        self.edit("product/delivery-waves/WAVE-001.json", approve_wave)
        return target

    def test_draft_project_is_valid_but_not_authorized(self):
        report = validate_workspace(self.root)
        self.assertTrue(report["valid"], report["errors"])
        self.assertFalse(report["factory_authorized"])
        self.assertEqual(report["counts"], {"epics": 1, "slices": 1, "waves": 1})

    def test_approved_structural_wave_is_still_not_factory_authorized(self):
        self.approved()
        report = validate_workspace(self.root)
        self.assertTrue(report["valid"], report["errors"])
        self.assertFalse(report["factory_authorized"])

    def test_open_questions_block_approved_slice(self):
        self.approved()
        self.edit("product/slices/SLICE-001.json", lambda d: d.update(open_questions=["Undecided pricing"] ))
        self.assertIn("approved slice must have no open questions", " ".join(validate_workspace(self.root)["errors"]))

    def test_tampered_spec_is_rejected(self):
        spec = self.approved()
        spec.write_text(spec.read_text() + "changed\n")
        self.assertIn("spec_sha256 does not match", " ".join(validate_workspace(self.root)["errors"]))

    def test_path_escape_rejected(self):
        self.approved()
        self.edit("product/slices/SLICE-001.json", lambda d: d.update(spec_path="../../../etc/passwd"))
        self.assertFalse(validate_workspace(self.root)["valid"])

    def test_unknown_epic_rejected(self):
        self.edit("product/slices/SLICE-001.json", lambda d: d.update(epic_id="EPIC-999"))
        self.assertIn("epic_id is unknown", " ".join(validate_workspace(self.root)["errors"]))

    def test_missing_dependency_rejected(self):
        self.edit("product/slices/SLICE-001.json", lambda d: d.update(dependencies=["SLICE-777"]))
        self.assertIn("unknown dependency", " ".join(validate_workspace(self.root)["errors"]))

    def test_dependency_cycle_rejected(self):
        source = self.doc("product/slices/SLICE-001.json")
        other = self.doc("product/slices/SLICE-002.json")
        second = json.loads(source.read_text())
        second.update({"slice_id": "SLICE-002", "dependencies": ["SLICE-001"]})
        other.write_text(json.dumps(second))
        self.edit("product/slices/SLICE-001.json", lambda d: d.update(dependencies=["SLICE-002"]))
        self.assertIn("dependency cycle", " ".join(validate_workspace(self.root)["errors"]))

    def test_wave_cannot_approve_draft_slice(self):
        self.edit("product/delivery-waves/WAVE-001.json", lambda d: d.update(status="approved_for_engineering", approval={"actor": "PM", "approved_at": "2026-11-10T14:00:00Z"}))
        report = validate_workspace(self.root)
        self.assertIn("unapproved slice", " ".join(report["errors"]))

    def test_wave_baseline_cannot_be_future(self):
        self.edit("product/delivery-waves/WAVE-001.json", lambda d: d.update(base_project_revision=99))
        self.assertIn("baseline is newer", " ".join(validate_workspace(self.root)["errors"]))

    def test_schema_files_parse(self):
        for path in (ROOT / "docs" / "mach-next" / "schemas").glob("*.json"):
            schema = json.loads(path.read_text())
            self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")


class LocalPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_absent_policy_is_disabled(self):
        state = read_local_policy(self.root)
        self.assertFalse(state["enabled"])
        self.assertFalse(state["auto_sync"])

    def test_malformed_policy_fails_closed(self):
        folder = self.root / ".factory" / "local"
        folder.mkdir(parents=True)
        (folder / "runner.json").write_text('{"enabled": true}')
        state = read_local_policy(self.root)
        self.assertFalse(state["enabled"])
        self.assertEqual(state["source"], "default-disabled")

    def test_valid_explicit_local_policy_is_read_but_not_dispatched(self):
        folder = self.root / ".factory" / "local"
        folder.mkdir(parents=True)
        (folder / "runner.json").write_text(json.dumps({"schema_version": 1, "enabled": True, "paused": False, "auto_sync": False, "autonomy": "observe"}))
        state = read_local_policy(self.root)
        self.assertTrue(state["enabled"])
        self.assertEqual(state["autonomy"], "observe")

    def test_invalid_policy_boolean_fails_closed(self):
        folder = self.root / ".factory" / "local"
        folder.mkdir(parents=True)
        (folder / "runner.json").write_text(json.dumps({"schema_version": 1, "enabled": 1, "paused": False, "auto_sync": False, "autonomy": "supervised"}))
        self.assertFalse(read_local_policy(self.root)["enabled"])


if __name__ == "__main__":
    unittest.main()
