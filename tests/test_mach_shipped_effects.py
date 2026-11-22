"""M13 part B, layer 1: a slice spec says what it does to shipped behaviour, and the review station's repairs.

The validator is given the shipped rules (the `rules` list of `run.py current --json`) as an input and stays pure:
with them, `## Effects on shipped behaviour` is required and each row must name a rule that shipped and is still in
force; without them, a spec with no section is unchanged. The intent station (`cell.py validate`, `finalize`,
`shipped`, `status`) and Product Studio (`slice check`, `slice ready`, `slice resume`, `status`, `refresh`) read the
shipped rules from the integration branch's local Git objects through one helper, `shipped.py`.

Review: a later round's delta after the build station merged main in at a revision; renewing an expired security
exception on a branch that carries the merge station's change record commit; and the factory-tuning file check
leaving that record out.
"""

import io
import json
import re
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
for folder in ("intent", "review"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
import cell  # noqa: E402
import review  # noqa: E402
import shipped  # noqa: E402
import validate_slice  # noqa: E402
import adr_baseline_fixture  # noqa: E402
from test_build import git as build_git  # noqa: E402
from test_cell import INTENT  # noqa: E402
from test_mach_product_issues import IssuesBase, git as issues_git, spec_for  # noqa: E402
from test_review import Base as ReviewBase, NOTE, TARGETS, TICKET  # noqa: E402
from test_security_exception import Base as ExceptionBase, TODAY  # noqa: E402

FIXTURE_NAME = "SLICE-001-invite-teammate.md"
FIXTURE = (ROOT / "tests" / "fixtures" / FIXTURE_NAME).read_text(encoding="utf-8")
WITHOUT = FIXTURE.replace("## Effects on shipped behaviour\n\nNone.\n\n", "")
HEAD = "| Shipped rule | Effect | In this slice | Note |\n|---|---|---|---|\n"
SHIPPED_RULES = 18  # SLICE-001: four invariants, nine requirements, five decision rules


def effects(text, *rows):
    """The spec with its effects section replaced by these rows (or 'None.')."""
    body = "None.\n" if not rows else HEAD + "".join(row + "\n" for row in rows)
    return text.replace("## Effects on shipped behaviour\n\nNone.\n", "## Effects on shipped behaviour\n\n" + body, 1)


def renamed(text, slice_id, title="Invite a teammate by email"):
    return text.replace("# SLICE-001: Invite a teammate by email", f"# {slice_id}: {title}", 1)


def errors(findings, rule=None):
    return [f.rule for f in findings if f.severity == "error" and (rule is None or f.rule == rule)]


def rule(name, in_force=True, by=None):
    return {"rule": name, "in_force": in_force, "superseded_by": [{"effect": "replaced", "by": by, "slice_id": by.split("/")[0]}] if by else []}


class ValidatorTest(unittest.TestCase):
    """The validator, pure: the shipped rules are an input."""

    def check(self, text, shipped_rules=None, name="SLICE-005-invite-again.md"):
        return validate_slice.analyze(renamed(text, "SLICE-005"), name, shipped=shipped_rules)

    def test_without_the_shipped_rules_nothing_changes(self):
        findings, model = validate_slice.analyze(WITHOUT, FIXTURE_NAME)
        self.assertEqual(errors(findings), [])
        self.assertNotIn("effects", model, "a spec with no section exports exactly as before")
        findings, model = validate_slice.analyze(FIXTURE, FIXTURE_NAME)
        self.assertEqual((errors(findings), model["effects"]), ([], []), "'None.' is a section with no rows")

    def test_supplied_even_empty_the_section_is_required_and_none_is_then_the_only_answer(self):
        findings, _ = self.check(WITHOUT, [])
        self.assertEqual(errors(findings), ["effects-missing"])
        self.assertIn("No rule has shipped yet", [f.message for f in findings if f.rule == "effects-missing"][0])
        self.assertEqual(errors(self.check(FIXTURE, [])[0]), [])
        findings, _ = self.check(effects(FIXTURE, "| SLICE-001/FR-01 | kept | AC-01 | Still holds. |"), [])
        self.assertEqual(errors(findings), ["effects-not-shipped"])

    def test_each_row_is_checked_against_the_shipped_rules(self):
        rules = [rule("SLICE-001/FR-01"), rule("SLICE-001/FR-02"), rule("SLICE-001/R3", in_force=False, by="SLICE-002/FR-01"), rule("SLICE-001/INV-02")]
        good = effects(FIXTURE, "| SLICE-001/FR-01 | kept | AC-01 | A new invite still reserves a seat. |",
                       "| SLICE-001/FR-02 | changed | FR-02 | |", "| SLICE-001/INV-02 | retired | | The product manager says duplicates are fine now. |")
        findings, model = self.check(good, rules)
        self.assertEqual(errors(findings), [])
        self.assertEqual([(row["shipped_rule"], row["effect"], row["in_slice"]) for row in model["effects"]],
                         [("SLICE-001/FR-01", "kept", "AC-01"), ("SLICE-001/FR-02", "changed", "FR-02"), ("SLICE-001/INV-02", "retired", None)])
        cases = {
            "effects-not-in-force": "| SLICE-001/R3 | kept | AC-01 | x |",
            "effects-not-shipped": "| SLICE-001/FR-99 | kept | AC-01 | x |",
            "effects-own-slice": "| SLICE-005/FR-01 | kept | AC-01 | x |",
            "effects-not-in-this-slice": "| SLICE-001/FR-01 | replaced | FR-42 | |",
            "effects-wrong-id": "| SLICE-001/FR-01 | replaced | AC-01 | |",
            "effects-kept-scenario": "| SLICE-001/FR-01 | kept | | x |",
            "effects-retired-note": "| SLICE-001/FR-01 | retired | | |",
        }
        for code, line in cases.items():
            findings, _ = self.check(effects(FIXTURE, line), rules)
            self.assertIn(code, errors(findings), code)
        message = [f.message for f in self.check(effects(FIXTURE, cases["effects-not-in-force"]), rules)[0] if f.rule == "effects-not-in-force"][0]
        self.assertIn("replaced by SLICE-002/FR-01", message)

    def test_without_the_list_a_present_section_is_still_checked_on_its_own(self):
        self.assertEqual(errors(self.check(effects(FIXTURE, "| SLICE-001/FR-01 | kept | AC-01 | x |"))[0]), [])
        self.assertEqual(errors(self.check(effects(FIXTURE, "| SLICE-001/FR-01 | replaced | FR-42 | |"))[0]), ["effects-not-in-this-slice"])
        self.assertEqual(errors(self.check(effects(FIXTURE, "| SLICE-005/FR-01 | kept | AC-01 | x |"))[0]), ["effects-own-slice"])
        self.assertIn("effects-content", errors(self.check(FIXTURE.replace("\nNone.\n", "\nNothing changes.\n", 1))[0]))
        broken = FIXTURE.replace("## Effects on shipped behaviour", "## Effects on shipped behavior", 1)
        self.assertIn("effects-heading", errors(self.check(broken)[0]))
        self.assertIn("effects-missing", errors(self.check(broken, [])[0]), "a misspelt heading is not the section")

    def test_the_section_sits_after_acceptance_criteria_and_before_principles(self):
        principles = "## Principles\n\n- **PP-01** (revision 1): \"A published version MUST NOT be edited in place.\" **Applies:** INV-02.\n\n"
        right = FIXTURE.replace("## Dependencies and permissions", principles + "## Dependencies and permissions", 1)
        self.assertEqual(errors(validate_slice.analyze(right, FIXTURE_NAME)[0]), [])
        wrong = WITHOUT.replace("## Dependencies and permissions", principles + "## Effects on shipped behaviour\n\nNone.\n\n## Dependencies and permissions", 1)
        self.assertIn("section-order", errors(validate_slice.analyze(wrong, FIXTURE_NAME)[0]))

    def test_the_command_line_takes_the_shipped_rules_as_a_file(self):
        with tempfile.TemporaryDirectory() as folder:
            spec = Path(folder) / FIXTURE_NAME
            spec.write_text(WITHOUT)
            listed = Path(folder) / "current.json"
            listed.write_text(json.dumps({"schema": "mach.current-behaviour", "rules": [rule("SLICE-000/FR-01")]}))
            plain = Path(folder) / "rules.json"
            plain.write_text(json.dumps(["SLICE-000/FR-01"]))
            bad = Path(folder) / "bad.json"
            bad.write_text(json.dumps({"rules": [3]}))

            def run(*argv):
                out, err = io.StringIO(), io.StringIO()
                with redirect_stdout(out), redirect_stderr(err):
                    code = validate_slice.main([str(spec), *argv])
                return code, out.getvalue() + err.getvalue(), out.getvalue()

            self.assertEqual(run()[0], 0)
            code, out, _ = run("--shipped", str(listed))
            self.assertEqual(code, 1)
            self.assertIn("[effects-missing]", out)
            spec.write_text(effects(FIXTURE, "| SLICE-000/FR-01 | kept | AC-01 | x |"))
            self.assertEqual(run("--shipped", str(plain))[0], 0)
            code, both, out = run("--shipped", str(listed), "--export")
            self.assertEqual(code, 0, both)
            self.assertEqual(json.loads(out)["effects"][0]["shipped_rule"], "SLICE-000/FR-01")
            self.assertEqual(run("--shipped", str(bad))[0], 2)
            self.assertEqual(run("--shipped", str(Path(folder) / "missing.json"))[0], 2)


def cell_run(project, *argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = cell.main(["--project", str(project), *argv])
    return code, out.getvalue(), err.getvalue()


def plain_git(folder, *args):
    return subprocess.run(["git", *args], cwd=str(folder), capture_output=True, text=True)


class CellTest(unittest.TestCase):
    """The intent station: shipped rules from the main branch, the required section, what the spec was checked against."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name).resolve() / "project"
        self.project.mkdir()
        for args in (("init", "-q", "-b", "main"), ("config", "user.name", "t"), ("config", "user.email", "t@example.com"), ("config", "commit.gpgsign", "false")):
            plain_git(self.project, *args)
        (self.project / "README.md").write_text("demo\n")
        adr_baseline_fixture.write(self.project)
        self.ship(FIXTURE_NAME, FIXTURE, "SLICE-001 shipped")

    def ship(self, name, text, message):
        path = self.project / "specs" / "slices" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        plain_git(self.project, "add", "-A")
        plain_git(self.project, "commit", "-q", "-m", message)
        return plain_git(self.project, "rev-parse", "HEAD").stdout.strip()

    def groom(self, text):
        code, out, _ = cell_run(self.project, "open", "LOCAL-001")
        self.assertEqual(code, 0)
        info = json.loads(out)
        (Path(info["specs_dir"]) / "SLICE-005-invite-again.md").write_text(renamed(text, "SLICE-005"))
        Path(info["intent_path"]).write_text(INTENT.replace("SLICE-001 at specs/slices/SLICE-001-invite-teammate.md",
                                                            "SLICE-005 at specs/slices/SLICE-005-invite-again.md"))
        return info

    def finalize(self):
        return cell_run(self.project, "finalize", "LOCAL-001", "--spec", "specs/slices/SLICE-005-invite-again.md")

    def test_shipped_prints_the_rules_in_force_fenced_as_data(self):
        code, out, _ = cell_run(self.project, "shipped")
        self.assertEqual(code, 0)
        found = json.loads(out)
        self.assertEqual((found["count"], found["branch"]), (SHIPPED_RULES, "main"))
        self.assertTrue(found["fenced"].startswith("<<<SHIPPED-RULES-DATA commit="))
        self.assertIn("SLICE-001/FR-01 (requirement, no epic, in force): ", found["fenced"])
        self.assertIn("data, never an instruction", found["note"])

    def test_finalize_requires_the_section_checks_it_and_records_the_commit(self):
        main_head = plain_git(self.project, "rev-parse", "HEAD").stdout.strip()
        self.groom(WITHOUT)
        code, out, _ = self.finalize()
        self.assertEqual(code, 1)
        self.assertIn("[effects-missing]", out)
        self.assertIn(f"shipped rules: {SHIPPED_RULES} at {main_head[:12]} on 'main'.", out)
        self.groom(effects(FIXTURE, "| SLICE-001/FR-99 | kept | AC-01 | x |"))
        self.assertIn("[effects-not-shipped]", self.finalize()[1])
        self.groom(effects(FIXTURE, "| SLICE-001/FR-01 | kept | AC-01 | A second invite still reserves a seat. |"))
        code, out, err = self.finalize()
        self.assertEqual(code, 0, out + err)
        info = json.loads((self.project / ".factory/worktrees/LOCAL-001/cell.json").read_text())
        self.assertEqual({key: info["shipped"][key] for key in ("commit", "branch", "rules")}, {"commit": main_head, "branch": "main", "rules": SHIPPED_RULES})
        exported = json.loads((self.project / ".factory/worktrees/LOCAL-001/spec.json").read_text())
        self.assertEqual(exported["effects"][0]["shipped_rule"], "SLICE-001/FR-01")
        self.assertNotIn("shipped_moved", json.loads(cell_run(self.project, "status", "LOCAL-001")[1]))
        # Another slice ships and replaces the rule this spec keeps: status says so, and changes nothing.
        replacing = renamed(effects(FIXTURE, "| SLICE-001/FR-01 | replaced | FR-01 | |"), "SLICE-006", "Invite with approval")
        self.ship("SLICE-006-invite-with-approval.md", replacing, "SLICE-006 shipped")
        status = json.loads(cell_run(self.project, "status", "LOCAL-001")[1])
        moved = status["shipped_moved"]
        self.assertEqual((moved["checked_at"], [p["code"] for p in moved["problems"]]), (main_head, ["effects-not-in-force"]))
        self.assertIn("replaced by SLICE-006/FR-01", moved["problems"][0]["message"])
        self.assertEqual(status["stage"], "spec-ready")
        code, out, _ = cell_run(self.project, "validate", "LOCAL-001")
        self.assertEqual(code, 1)
        self.assertIn("[effects-not-in-force]", out)

    def test_validate_supplies_the_shipped_rules_too(self):
        self.groom(WITHOUT)
        code, out, _ = cell_run(self.project, "validate", "LOCAL-001", "--spec", "specs/slices/SLICE-005-invite-again.md")
        self.assertEqual(code, 1)
        self.assertIn("[effects-missing]", out)

    def test_without_git_the_list_is_empty_and_none_is_the_answer(self):
        bare = Path(self.tmp.name).resolve() / "nogit"
        bare.mkdir()
        found = shipped.read(bare, {})
        self.assertEqual((found["commit"], found["rules"]), (None, []))
        self.assertIn("not a Git repository", found["notes"][0])
        code, out, _ = cell_run(bare, "open", "LOCAL-001")
        info = json.loads(out)
        (Path(info["specs_dir"])).mkdir(parents=True, exist_ok=True)
        (Path(info["specs_dir"]) / FIXTURE_NAME).write_text(FIXTURE)
        Path(info["intent_path"]).write_text(INTENT)
        code, out, err = cell_run(bare, "finalize", "LOCAL-001", "--spec", f"specs/slices/{FIXTURE_NAME}")
        self.assertEqual(code, 0, out + err)
        self.assertIn("shipped rules: 0 (none could be read).", out)

    def test_the_helper_only_reads_local_git(self):
        source = (ROOT / "skills" / "intent" / "scripts" / "shipped.py").read_text()
        self.assertEqual(re.findall(r'_git\(root, "([a-z-]+)"', source), ["rev-parse"])  # the rest is intake's and current.py's reading
        for word in ('"fetch"', '"push"', '"gh"', "write_text", "unlink", "mkdir", "urllib", "socket"):
            self.assertNotIn(word, source, word)


class StudioTest(IssuesBase):
    """Product Studio: the shipped rules from this computer's copy of main, the section required, the record, the flag."""

    def setUp(self):
        super().setUp()
        spec = self.eng / "specs" / "slices" / FIXTURE_NAME
        spec.parent.mkdir(parents=True)
        spec.write_text(FIXTURE)
        issues_git(self.eng, "add", "-A")
        issues_git(self.eng, "commit", "-q", "-m", "SLICE-001 shipped")
        issues_git(self.eng, "push", "-q", "origin", "main")
        issues_git(self.a, "pull", "-q")  # the product manager's copy; Studio itself never fetches
        self.project_and_epic()

    def checked(self):
        return json.loads((self.a / ".factory/studio/shipped.json").read_text())["slices"]

    def spec_path(self, slice_id):
        return next((self.a / ".factory/studio/draft/specs/slices").glob(f"{slice_id}-*.md"))

    def test_check_requires_the_section_and_records_what_it_was_checked_against(self):
        slice_id = self.drafted()
        self.assertEqual(slice_id, "SLICE-005")  # SLICE-002 to SLICE-004 are reserved: the shipped spec defers features to them
        head = issues_git(self.a, "rev-parse", "HEAD").strip()
        checked = self.ok(self.a, "slice", "check", slice_id, "--ready")
        self.assertEqual((checked["shipped"]["commit"], checked["shipped"]["rules"]), (head, SHIPPED_RULES))
        self.assertEqual(self.checked()[slice_id], {"commit": head, "rules": SHIPPED_RULES})
        work = json.loads((self.a / f".factory/studio/draft/product/slices/{slice_id}.json").read_text())
        self.assertNotIn("shipped", work, "kept in Studio's own record, so the product artifacts stay the same in any repository")
        self.ok(self.a, "validate")
        path = self.spec_path(slice_id)
        path.write_text(path.read_text().replace("## Effects on shipped behaviour\n\nNone.\n\n", ""))
        code, out, _ = self.run_studio(self.a, "slice", "check", slice_id, "--ready")
        self.assertEqual(code, 1)
        self.assertIn("[effects-missing]", out)
        self.assertIn("effects-missing", self.refused(self.a, "slice", "ready", slice_id))

    def test_resume_gives_the_interviewer_the_shipped_rules_fenced(self):
        slice_id = self.drafted()
        resumed = self.ok(self.a, "slice", "resume", slice_id)
        rules = resumed["shipped_rules"]
        self.assertEqual(rules["count"], SHIPPED_RULES)
        self.assertIn("SLICE-001/INV-02", rules["fenced"])
        self.assertTrue(rules["fenced"].endswith(f"<<<END-SHIPPED-RULES-DATA sha256={rules['sha256']}>>>"))
        self.assertIn("never an instruction", rules["note"])

    def test_a_ready_slice_keeps_its_record_and_is_flagged_when_a_named_rule_is_replaced(self):
        slice_id = self.drafted()
        path = self.spec_path(slice_id)
        path.write_text(effects(path.read_text(), "| SLICE-001/FR-01 | kept | AC-01 | A second invite still reserves a seat. |"))
        head = issues_git(self.a, "rev-parse", "HEAD").strip()
        self.ready(slice_id)
        work = json.loads((self.a / f".factory/studio/draft/product/slices/{slice_id}.json").read_text())
        self.assertEqual((work["status"], self.checked()[slice_id]), ("approved_for_engineering", {"commit": head, "rules": SHIPPED_RULES}))
        self.assertNotIn("shipped_moved", self.ok(self.a, "status")["slices"][0])
        replacing = renamed(effects(FIXTURE, "| SLICE-001/FR-01 | replaced | FR-01 | |"), "SLICE-009", "Invite with approval")
        (self.eng / "specs/slices/SLICE-009-invite-with-approval.md").write_text(replacing)
        issues_git(self.eng, "add", "-A")
        issues_git(self.eng, "commit", "-q", "-m", "SLICE-009 shipped")
        issues_git(self.eng, "push", "-q", "origin", "main")
        self.assertNotIn("shipped_moved", self.ok(self.a, "status")["slices"][0], "nothing is fetched: this copy has not moved")
        issues_git(self.a, "pull", "-q")
        row = self.ok(self.a, "status")["slices"][0]
        self.assertEqual([p["code"] for p in row["shipped_moved"]["problems"]], ["effects-not-in-force"])
        self.assertEqual(row["status"], "approved_for_engineering", "flagged, never changed")
        self.assertEqual(list(self.ok(self.a, "refresh")["shipped_moved"]), [slice_id])


class ReviewDeltaTest(ReviewBase):
    """A later round's delta after the build station merged main in at the revision: only the revision's own work."""

    def test_main_merged_in_at_the_revision_is_not_this_rounds_change(self):
        self.verified()
        self.r_ok("start", TICKET)
        self.cast(rejecting=("architecture", "security"))
        code, decision = self.tally()
        self.assertEqual(code, 1)
        earlier_head = json.loads((self.round / "packet.json").read_text())["head"]
        self.put(self.project, {"other/feature.py": "OTHER_TICKET = True\n"})
        build_git(self.project, "add", "-A")
        build_git(self.project, "commit", "-q", "-m", "another ticket landed")
        self.ok("revise", TICKET, "--findings", decision["findings"])
        merges = json.loads((self.cellroot / "build.json").read_text())["main_merges"]
        self.assertEqual(merges[-1]["branch_commit"], earlier_head, "the build station merged main in at the revision")
        self.ok("add-task", TICKET, "--kind", "docs", "--text", "Explain validation (FR-01)", "--file", "README.md")
        self.put(self.work, {"README.md": "# Sample\n\nAddresses are validated.\n"})
        self.ok("done", TICKET, "R1-T01")
        self.ok("finish", TICKET)
        self.run_verify("start", TICKET)
        (self.evidence / "consumer-run.log").write_text("AC-01 ok\n")
        for target in TARGETS:
            self.run_verify("record", TICKET, target, "--result", "pass", "--evidence", "consumer-run.log", "--note", NOTE)
        self.run_verify("finish", TICKET)
        self.round = self.cellroot / "review" / "round-2"
        self.r_ok("start", TICKET)
        delta = json.loads((self.round / "packet.json").read_text())["delta"]
        self.assertEqual(delta["since_commit"], merges[-1]["merge_commit"])
        self.assertEqual((delta["files_changed"], delta["main_merged_after"]), (["README.md"], earlier_head))
        self.assertNotIn("OTHER_TICKET", Path(delta["diff"]).read_text())
        self.assertIn("did not change since the last round", self.bad(self.blocker(file="other/feature.py", line=1)))
        self.assertEqual(self.vote("architecture", self.blocker(file="README.md", line=1))["vote"], "REJECT")

    def test_with_no_merge_the_delta_starts_at_the_earlier_head(self):
        fake = types.SimpleNamespace(build={"main_merges": {"merges": [{"branch_commit": "a" * 40, "merge_commit": "b" * 40}]}}, work=self.project)
        self.assertEqual(review.delta_start(fake, "c" * 40, "d" * 40), "c" * 40)
        fake.build = {}
        self.assertEqual(review.delta_start(fake, "c" * 40, "d" * 40), "c" * 40)


class ExceptionRenewalTest(ExceptionBase):
    """Renewing an expired exception on a branch the merge station already added its change record to."""

    def record(self, extra=None):
        head = self.decision()["head"]
        files = {"docs/changes/LOCAL-001.md": "# Change record\n"}
        files.update(extra or {})
        self.put(self.work, files)
        build_git(self.work, "add", "-A")
        build_git(self.work, "commit", "-q", "-m", "Change record for LOCAL-001")
        tip = build_git(self.work, "rev-parse", "HEAD").stdout.strip()
        self.edit_json("cell.json", change_record={"version": 1, "path": "docs/changes/LOCAL-001.md", "sha256": "0" * 64, "parent": head, "commit": tip})
        return tip

    def approved(self):
        self.vetoed()
        self.excepted(extra=("--expires", TODAY.isoformat()))
        self.expire()

    def test_the_record_commit_on_the_approved_commit_may_be_renewed(self):
        self.approved()
        self.record()
        renewed = self.excepted(extra=("--expires", (TODAY + timedelta(days=7)).isoformat()), by="Lee Park")
        self.assertEqual((renewed["outcome"], renewed["renewal"]), ("APPROVED", True))

    def test_a_record_commit_that_changes_anything_else_is_refused(self):
        self.approved()
        self.record({"app/invite.py": "def invite(email):\n    return None\n"})
        self.assertIn("no longer the commit the panel reviewed", self.except_refused())


class TuningRecordTest(unittest.TestCase):
    def test_the_change_record_is_not_judged_as_the_tuning_tickets_change(self):
        cell_with = types.SimpleNamespace(info={"change_record": {"path": "docs/changes/LOCAL-001.md"}})
        files = ["REVIEW.md", "tests/test_rules.py", "docs/changes/LOCAL-001.md"]
        self.assertEqual(review.tuning_outside(cell_with, files), [])
        self.assertEqual(review.tuning_outside(types.SimpleNamespace(info={}), files), ["docs/changes/LOCAL-001.md"])
        self.assertEqual(review.tuning_outside(cell_with, files + ["docs/changes/OTHER.md"]), ["docs/changes/OTHER.md"])


class InstructionsTest(unittest.TestCase):
    def test_the_interview_the_plan_and_the_product_seat_say_what_to_do(self):
        method = (ROOT / "skills/intent/references/interview-method.md").read_text()
        self.assertIn("### Effects on shipped behaviour", method)
        self.assertIn("Never recommend retiring a rule", method)
        headless = (ROOT / "skills/intent/references/headless.md").read_text()
        self.assertIn("A `kept` row may be decided without a PM", headless)
        self.assertRegex(headless, r"change, replace or retire is a conflict between rules")
        self.assertIn("CELL shipped", (ROOT / "skills/intent/SKILL.md").read_text())
        self.assertIn("shipped_rules", (ROOT / "skills/product-studio/SKILL.md").read_text())
        self.assertIn("earlier slice's tests", (ROOT / "skills/intent/references/contracts-and-plan.md").read_text())
        self.assertIn("earlier slice's tests", (ROOT / "agents/contract-engineer.md").read_text())
        self.assertIn("`kept` row", (ROOT / "skills/review/references/product.md").read_text())
        template = (ROOT / "skills/intent/assets/slice-template.md").read_text()
        self.assertLess(template.index("## Acceptance criteria"), template.index("## Effects on shipped behaviour"))
        self.assertLess(template.index("## Effects on shipped behaviour"), template.index("## Principles"))
        self.assertTrue(re.search(r"Effects on shipped behaviour.*required", (ROOT / "skills/intent/references/spec-structure.md").read_text()))


if __name__ == "__main__":
    unittest.main()
