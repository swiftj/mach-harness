"""MACH Next M0 structural and fail-closed guardrail tests (stdlib only)."""

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills" / "product-studio" / "scripts" / "product.py"
sys.path.insert(0, str(SCRIPT.parent))
import product as validate  # noqa: E402
from product import read_local_policy, validate_workspace  # noqa: E402

SEED = ROOT / "docs" / "mach-next" / "example-project"


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

    def test_malformed_json_is_reported_not_raised(self):
        self.doc("product/epics/EPIC-001.json").write_text("{not json")
        report = validate_workspace(self.root)
        self.assertFalse(report["valid"])
        self.assertTrue(any(e.startswith("product/epics/EPIC-001.json:") for e in report["errors"]), report["errors"])

    def test_missing_project_file_is_reported(self):
        self.doc("product/project.json").unlink()
        report = validate_workspace(self.root)
        self.assertFalse(report["valid"])
        self.assertFalse(report["factory_authorized"])

    def test_wrong_typed_fields_are_reported_not_raised(self):
        # A list or object where an ID or status belongs must produce an error, never a traceback.
        for field, value in (("epic_id", ["EPIC-001"]), ("epic_id", {"id": "EPIC-001"}), ("status", ["draft"]),
                             ("dependencies", "SLICE-001"), ("dependencies", [["SLICE-001"]]), ("revision", True)):
            with self.subTest(field=field, value=value):
                self.setUp()
                self.edit("product/slices/SLICE-001.json", lambda d: d.update({field: value}))
                self.assertFalse(validate_workspace(self.root)["valid"])

    def test_unknown_status_rejected_for_every_kind(self):
        for relative in ("product/project.json", "product/epics/EPIC-001.json",
                         "product/slices/SLICE-001.json", "product/delivery-waves/WAVE-001.json"):
            with self.subTest(relative=relative):
                self.setUp()
                self.edit(relative, lambda d: d.update(status="nonsense"))
                self.assertIn("invalid status", " ".join(validate_workspace(self.root)["errors"]))

    def test_unexpected_field_rejected(self):
        self.edit("product/slices/SLICE-001.json", lambda d: d.update(factory_authorized=True))
        report = validate_workspace(self.root)
        self.assertIn("unexpected field 'factory_authorized'", " ".join(report["errors"]))
        self.assertFalse(report["factory_authorized"])

    def test_approval_timestamp_must_be_a_date_time(self):
        self.approved()
        for stamp in ("yesterday", "2026-11-10", "2026-11-10 14:00:00", "2026-11-10T14:00:00", "2026-13-40T14:00:00Z", "2026-11-10T25:00:00Z"):
            with self.subTest(stamp=stamp):
                self.edit("product/delivery-waves/WAVE-001.json", lambda d: d["approval"].update(approved_at=stamp))
                self.assertIn("approved_at must be a date-time", " ".join(validate_workspace(self.root)["errors"]))
        for stamp in ("2026-11-10T14:00:00Z", "2026-11-10T14:00:00.250Z", "2026-11-10T09:00:00-05:00"):
            with self.subTest(stamp=stamp):
                self.edit("product/delivery-waves/WAVE-001.json", lambda d: d["approval"].update(approved_at=stamp))
                self.assertTrue(validate_workspace(self.root)["valid"])

    def test_approved_wave_needs_an_approval_record(self):
        self.approved()
        self.edit("product/delivery-waves/WAVE-001.json", lambda d: d.update(approval=None))
        self.assertIn("requires recorded author approval", " ".join(validate_workspace(self.root)["errors"]))

    def test_unsafe_spec_paths_rejected(self):
        self.approved()
        (self.root / "notes.md").write_text("x")
        for value in ("/etc/passwd", "specs/slices/../../notes.md", "specs\\slices\\SLICE-001-invite-member.md",
                      "specs/slices//SLICE-001-invite-member.md", "specs/slices/sub/SLICE-001-invite-member.md",
                      "specs/SLICE-001-invite-member.md", "notes.md", "specs/slices/SLICE-001-missing.md"):
            with self.subTest(value=value):
                self.edit("product/slices/SLICE-001.json", lambda d: d.update(spec_path=value))
                self.assertFalse(validate_workspace(self.root)["valid"])

    def test_spec_name_follows_the_intent_validator_rule(self):
        # Names validate_slice.py would refuse must be refused here too, and a spec named for another slice.
        spec = self.approved()
        for name in ("SLICE-001-.md", "SLICE-001--invite.md", "SLICE-001-invite-.md", "SLICE-001-Invite.md",
                     "SLICE-002-invite-member.md", "SLICE-0011-invite-member.md"):
            with self.subTest(name=name):
                shutil.copy(spec, spec.with_name(name))
                self.edit("product/slices/SLICE-001.json", lambda d: d.update(spec_path="specs/slices/" + name))
                self.assertIn("spec_path must match", " ".join(validate_workspace(self.root)["errors"]))

    def test_symlinked_spec_rejected(self):
        spec = self.approved()
        real = self.root / "elsewhere.md"
        shutil.move(str(spec), str(real))
        spec.symlink_to(real)
        self.assertIn("not a symlink", " ".join(validate_workspace(self.root)["errors"]))

    def test_symlinked_artifact_file_rejected(self):
        path = self.doc("product/slices/SLICE-001.json")
        real = self.root / "SLICE-001.real.json"
        shutil.move(str(path), str(real))
        path.symlink_to(real)
        self.assertIn("symlink not permitted", " ".join(validate_workspace(self.root)["errors"]))

    def test_symlinked_artifact_directory_rejected(self):
        folder = self.doc("product/slices")
        real = self.root / "slices-real"
        shutil.move(str(folder), str(real))
        folder.symlink_to(real, target_is_directory=True)
        self.assertIn("symlinked artifact directory", " ".join(validate_workspace(self.root)["errors"]))

    def test_symlinked_product_folder_rejected(self):
        real = self.root.parent / "outside-product"
        shutil.move(str(self.doc("product")), str(real))
        self.doc("product").symlink_to(real, target_is_directory=True)
        report = validate_workspace(self.root)
        self.assertEqual(report["errors"], ["product: symlinked artifact directory is not permitted"])
        self.assertFalse(report["factory_authorized"])

    def test_filename_must_match_id(self):
        path = self.doc("product/slices/SLICE-001.json")
        shutil.move(str(path), str(path.with_name("SLICE-009.json")))
        self.assertIn("filename must match slice_id", " ".join(validate_workspace(self.root)["errors"]))

    def test_command_line_reports_and_exit_codes(self):
        import subprocess

        def run(project):
            return subprocess.run([sys.executable, str(SCRIPT), "--project", str(project), "--policy"],
                                  cwd=str(ROOT), capture_output=True, text=True)
        good = run(self.root)
        self.assertEqual(good.returncode, 0, good.stderr)
        report = json.loads(good.stdout)
        self.assertEqual((report["valid"], report["factory_authorized"], report["local_policy"]["enabled"]), (True, False, False))
        self.edit("product/slices/SLICE-001.json", lambda d: d.update(epic_id=["EPIC-001"]))
        bad = run(self.root)
        self.assertEqual(bad.returncode, 1)
        self.assertNotIn("Traceback", bad.stderr)
        self.assertFalse(json.loads(bad.stdout)["factory_authorized"])

    def test_schema_files_parse(self):
        for path in (ROOT / "docs" / "mach-next" / "schemas").glob("*.json"):
            schema = json.loads(path.read_text())
            self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")


class SchemaParityTests(unittest.TestCase):
    """The JSON Schema files and the Python validator must describe the same shapes."""

    KINDS = {"project": "project", "epic": "epic", "slice": "slice", "wave": "delivery-wave"}

    def schema(self, kind):
        return json.loads((ROOT / "docs" / "mach-next" / "schemas" / (self.KINDS[kind] + ".schema.json")).read_text())

    def test_fields_match(self):
        for kind in self.KINDS:
            with self.subTest(kind=kind):
                schema = self.schema(kind)
                self.assertEqual(sorted(schema["required"]), sorted(validate.SHAPES[kind]))
                self.assertEqual(sorted(schema["properties"]), sorted(validate.SHAPES[kind]))
                self.assertIs(schema["additionalProperties"], False)
                self.assertEqual(schema["properties"]["schema_version"], {"const": 1})

    def test_status_values_match(self):
        for kind in self.KINDS:
            with self.subTest(kind=kind):
                self.assertEqual(tuple(self.schema(kind)["properties"]["status"]["enum"]), validate.ENUMS[kind]["status"])

    def test_id_patterns_match(self):
        rules = {"project_id": validate.PROJECT_RE, "epic_id": validate.EPIC_RE, "slice_id": validate.SLICE_RE, "wave_id": validate.WAVE_RE}
        for kind in self.KINDS:
            for field, rule in rules.items():
                if field in validate.SHAPES[kind]:
                    with self.subTest(kind=kind, field=field):
                        self.assertEqual(self.schema(kind)["properties"][field]["pattern"], rule.pattern)
        slice_schema, wave_schema = self.schema("slice")["properties"], self.schema("wave")["properties"]
        self.assertEqual(slice_schema["dependencies"]["items"]["pattern"], validate.SLICE_RE.pattern)
        self.assertEqual(wave_schema["slices"]["items"]["pattern"], validate.SLICE_RE.pattern)
        self.assertEqual(slice_schema["spec_sha256"]["pattern"], validate.HEX_RE.pattern)

    def test_example_project_satisfies_the_schema_fields(self):
        product = SEED / "product"
        files = {"project": [product / "project.json"], "epic": sorted((product / "epics").glob("*.json")),
                 "slice": sorted((product / "slices").glob("*.json")), "wave": sorted((product / "delivery-waves").glob("*.json"))}
        for kind, paths in files.items():
            self.assertTrue(paths, kind)
            for path in paths:
                self.assertEqual(sorted(json.loads(path.read_text())), sorted(self.schema(kind)["required"]), path.name)

    def test_spec_name_rule_is_the_intent_validators(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("validate_slice", ROOT / "skills" / "intent" / "scripts" / "validate_slice.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules["validate_slice"] = module  # dataclasses needs the module registered (Python 3.8)
        self.addCleanup(sys.modules.pop, "validate_slice", None)
        spec.loader.exec_module(module)
        for name in ("SLICE-001-invite-member.md", "SLICE-001-.md", "SLICE-001--a.md", "SLICE-001-a-.md", "SLICE-01-a.md",
                     "SLICE-1234-a1-b2.md", "SLICE-001-A.md", "SLICE-001-a.txt", "slice-001-a.md"):
            with self.subTest(name=name):
                self.assertEqual(bool(validate.SPEC_NAME_RE.fullmatch(name)), bool(module.FILENAME_RE.match(name)))


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

    def write(self, text):
        folder = self.root / ".factory" / "local"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "runner.json").write_text(text)

    def test_every_malformed_policy_fails_closed(self):
        good = {"schema_version": 1, "enabled": True, "paused": False, "auto_sync": True, "autonomy": "supervised"}
        cases = ["", "{not json", "[]", "null", json.dumps({**good, "schema_version": 2}), json.dumps({**good, "schema_version": True}),
                 json.dumps({**good, "autonomy": "unlimited"}), json.dumps({**good, "autonomy": ["observe"]}),
                 json.dumps({**good, "extra": 1}), json.dumps({k: v for k, v in good.items() if k != "paused"}),
                 json.dumps({**good, "enabled": "true"}), json.dumps({**good, "auto_sync": None})]
        for text in cases:
            with self.subTest(text=text):
                self.write(text)
                state = read_local_policy(self.root)
                self.assertEqual((state["enabled"], state["auto_sync"], state["source"]), (False, False, "default-disabled"))

    def test_symlinked_policy_fails_closed(self):
        real = self.root / "elsewhere.json"
        real.write_text(json.dumps({"schema_version": 1, "enabled": True, "paused": False, "auto_sync": True, "autonomy": "extended"}))
        folder = self.root / ".factory" / "local"
        folder.mkdir(parents=True)
        (folder / "runner.json").symlink_to(real)
        self.assertEqual(read_local_policy(self.root)["source"], "default-disabled")

    def test_reading_the_policy_never_creates_it(self):
        read_local_policy(self.root)
        self.assertFalse((self.root / ".factory").exists())


if __name__ == "__main__":
    unittest.main()
