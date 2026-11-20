"""M14 part A: policy packs, the organisation's policies applied while a slice's spec is written.

One reader (`skills/intent/scripts/policies.py`) finds, parses and selects packs from the main checkout's committed
files, as adr.py reads ADRs. The spec answers each pack that applies in `## Policies`; the validator is given the packs
as an input and stays pure. An open concern stops `slice ready` and `cell.py finalize` until the owner accepts it
(`policy accept`, a person's act). Review's packet carries the packs and a blocker may cite a statement only when the spec
lists its pack, never a concern the owner accepted.
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
for folder in ("intent", "review", "run"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
import cell  # noqa: E402
import policies  # noqa: E402
import review  # noqa: E402
import validate_slice  # noqa: E402
import adr_baseline_fixture  # noqa: E402
from test_adr import PLAN_ADR, Project as AdrProject  # noqa: E402
from test_cell import INTENT  # noqa: E402
from test_mach_product_issues import IssuesBase, git as issues_git  # noqa: E402

FIXTURE_NAME = "SLICE-001-invite-teammate.md"
FIXTURE = (ROOT / "tests" / "fixtures" / FIXTURE_NAME).read_text(encoding="utf-8")
OWNER = "Data protection officer (@acme/privacy)"
STATEMENT_1 = "An invitation email MUST name the workspace that sent it."
STATEMENT_2 = "Personal data MUST NOT be sent to a service outside the EU region."


def pack_text(name="privacy", applies=("all",), status="active", owner=OWNER, statements=(STATEMENT_1, STATEMENT_2), title="Privacy", extra=""):
    lines = ["---", f"id: POL-{name}", f"title: {title}", f"owner: {owner}", f"status: {status}", "applies-to:", *[f"  - {item}" for item in applies], "---", "",
             f"# {title}", "", *[f"- **POL-{name}-{number:02d}:** {text}" for number, text in enumerate(statements, start=1)], ""]
    return "\n".join(lines) + extra


def packs_for(*texts):
    """The validator's input for these packs ({pack name: text}), as for_validator gives it."""
    files = {f"policies/{name}/policy.md": text for name, text in texts}
    records, problems = policies.read_folder(files, "policies", [name for name, _ in texts])
    return policies.for_validator({"dir": "policies", "commit": None, "packs": records, "problems": problems})


def short(text):
    return policies.digest(text)[:12]


def with_section(text, body):
    return text.replace("## Dependencies and permissions", f"## Policies\n\n{body.strip()}\n\n## Dependencies and permissions", 1)


def followed(text, pack=None):
    pack = pack or pack_text()
    return with_section(text, f"- **POL-privacy** (sha256 {short(pack)}): Followed.")


def concern(text, resolution="open.", statement=STATEMENT_2, owner=OWNER, pack=None, ident="POL-privacy-02"):
    pack = pack or pack_text()
    return with_section(text, f"- **POL-privacy** (sha256 {short(pack)}): Concerns.\n"
                              f"  - **{ident}**: \"{statement}\" **Cannot be met:** The email service sits outside the EU. "
                              f"**Owner:** {owner}. **Resolution:** {resolution}")


def rules(findings, severity="error"):
    return sorted({f.rule for f in findings if f.severity == severity})


def run_git(folder, *args):
    return subprocess.run(["git", *args], cwd=str(folder), capture_output=True, text=True)


class ReaderTest(unittest.TestCase):
    """The pack's grammar: strict, standard library, a problem with its reason, never skipped in silence."""

    def test_a_good_pack(self):
        record = policies.parse(pack_text(), "policies/privacy/policy.md", "privacy")
        self.assertEqual(record["problems"], [])
        self.assertTrue(record["binding"])
        self.assertEqual((record["id"], record["owner_role"], record["owner_handle"]), ("POL-privacy", "Data protection officer", "@acme/privacy"))
        self.assertEqual([item["id"] for item in record["statements"]], ["POL-privacy-01", "POL-privacy-02"])
        self.assertFalse(policies.parse(pack_text(status="retired"), "p", "privacy")["binding"], "a retired pack binds nothing")
        self.assertEqual(policies.parse(pack_text(owner="Brand team"), "p", "privacy")["owner_handle"], None, "a GitHub handle is optional")

    def test_every_problem_is_named(self):
        def problems(text, pack="privacy"):
            return " | ".join(policies.parse(text, f"policies/{pack}/policy.md", pack)["problems"])
        self.assertIn("has no header", problems("# Privacy\n"))
        self.assertIn("a pack in the folder 'privacy' is POL-privacy", problems(pack_text().replace("id: POL-privacy", "id: POL-other")))
        self.assertIn("no 'owner' field", problems(pack_text().replace(f"owner: {OWNER}\n", "")))
        self.assertIn("not active or retired", problems(pack_text(status="draft")))
        self.assertIn("is not path:<glob>", problems(pack_text(applies=("everything",))))
        self.assertIn("no uppercase RFC 2119 keyword", problems(pack_text(statements=("Invitations name the workspace.",))))
        self.assertIn("more than one sentence", problems(pack_text(statements=("Invitations MUST name it. They MUST be short.",))))
        self.assertIn("a double quotation mark", problems(pack_text(statements=('An email MUST say "hello".',))))
        self.assertIn("has no statements", problems(pack_text(statements=())))
        self.assertIn("is not numbered POL-privacy-NN", problems(pack_text() + "- **POL-brand-01:** Logos MUST be blue.\n"))
        self.assertIn("appears twice", problems(pack_text() + f"- **POL-privacy-01:** {STATEMENT_1}\n"))
        self.assertIn("folder name", problems(pack_text(name="9lives"), pack="9lives"))
        self.assertIn("not a role or team", problems(pack_text(owner="@only-a-handle")))

    def test_a_folder_without_policy_md_and_a_malformed_pack_are_problems_never_skipped(self):
        records, found = policies.read_folder({"policies/privacy/policy.md": pack_text(statements=())}, "policies", ["privacy", "brand"])
        self.assertIn("policies/brand: the folder has no policy.md", found)
        self.assertTrue(any("has no statements" in item for item in found))
        given = policies.for_validator({"packs": records, "problems": found})
        self.assertEqual(given["packs"], [], "a malformed pack is never given to the validator as a pack")
        findings, _ = validate_slice.analyze(FIXTURE, FIXTURE_NAME, policies=given)
        self.assertIn("policy-problem", rules(findings))

    def test_selection_by_all_topic_and_app_never_by_path_while_the_spec_is_written(self):
        words = policies.spec_words(FIXTURE)
        def because(*applies):
            return policies.applies(policies.parse(pack_text(applies=applies), "p", "privacy"), words, None)
        self.assertEqual(because("all"), ["all"])
        self.assertEqual(because("topic:email"), ["topic:email"])
        self.assertEqual(because("topic:email-address"), ["topic:email-address"], "hyphen-joined pairs of words match")
        self.assertEqual(because("topic:payments"), [])
        self.assertEqual(because("path:app/**"), [])
        self.assertEqual(policies.applies(policies.parse(pack_text(applies=("app:web",)), "p", "privacy"), words, "web"), ["app:web"])
        self.assertNotIn("payments", policies.spec_words(with_section(FIXTURE, "- **POL-payments** (sha256 000000000000): Followed.")),
                         "the Policies section does not select its own packs")

    def test_seats(self):
        self.assertEqual(policies.seats({"applies_to": ["topic:privacy"]}), ["security"])
        self.assertEqual(policies.seats({"applies_to": ["topic:brand", "topic:security"]}), ["security", "product"])
        self.assertEqual(policies.seats({"applies_to": ["all"]}), ["all"])

    def test_the_starter_template_is_a_good_pack_and_is_not_installed(self):
        template = ROOT / "templates" / "policies" / "security" / "policy.md"
        record = policies.parse(template.read_text(), "policies/security/policy.md", "security")
        self.assertEqual(record["problems"], [])
        self.assertEqual(policies.seats(record), ["security"])
        installer = (ROOT / "bin" / "mach").read_text()
        self.assertNotIn("policies/", installer, "scaffolding never installs a pack; a team copies one in by pull request")
        self.assertEqual(json.loads((ROOT / "templates" / "config.json").read_text())["policies"], {"dir": "policies"})


class ValidatorTest(unittest.TestCase):
    """The validator, pure: the packs are an input."""

    def check(self, text, given=None, ready=False):
        return validate_slice.analyze(text, FIXTURE_NAME, policies=given, ready=ready)

    def test_without_packs_nothing_changes(self):
        findings, model = self.check(FIXTURE)
        self.assertEqual(rules(findings), [])
        self.assertNotIn("policies", model, "a spec without the section exports exactly as before")
        findings, model = self.check(FIXTURE, packs_for())
        self.assertEqual((rules(findings), "policies" in model), ([], False), "a project with no packs needs no section")

    def test_a_pack_that_applies_must_be_answered(self):
        given = packs_for(("privacy", pack_text()))
        findings, _ = self.check(FIXTURE, given)
        self.assertEqual(rules(findings), ["policy-unanswered"])
        self.assertIn("Missing section '## Policies'", next(f.message for f in findings if f.rule == "policy-unanswered"))
        topic = packs_for(("privacy", pack_text(applies=("topic:payments",))))
        self.assertEqual(rules(self.check(FIXTURE, topic)[0]), [], "a pack whose topic the spec never mentions does not apply")
        findings, model = self.check(followed(FIXTURE), given)
        self.assertEqual(rules(findings), [])
        self.assertEqual(model["policies"], [{"pack": "POL-privacy", "sha256": short(pack_text()), "answer": "followed", "concerns": []}])

    def test_an_open_concern_is_a_warning_while_drafting_and_an_error_when_ready(self):
        given = packs_for(("privacy", pack_text()))
        findings, model = self.check(concern(FIXTURE), given)
        self.assertEqual((rules(findings), rules(findings, "warning")), ([], ["policy-concern-open"]))
        self.assertEqual(model["policies"][0]["concerns"][0]["resolution"], "open")
        self.assertIn("policy-concern-open", rules(self.check(concern(FIXTURE), given, ready=True)[0]))
        self.assertIn("policy-concern-open", rules(self.check(concern(FIXTURE), None, ready=True)[0]), "rows are checked on their own too")

    def test_accepted_and_spec_changed_resolutions(self):
        given = packs_for(("privacy", pack_text()))
        accepted = concern(FIXTURE, 'accepted by Data protection officer on 2026-11-20: "Accepted for the pilot only."')
        findings, model = self.check(accepted, given, ready=True)
        self.assertEqual(rules(findings), [])
        self.assertEqual(model["policies"][0]["concerns"][0],
                         {"statement_id": "POL-privacy-02", "statement": STATEMENT_2, "why": "The email service sits outside the EU.", "owner": OWNER,
                          "resolution": "accepted", "by": "Data protection officer", "on": "2026-11-20", "words": "Accepted for the pilot only."})
        self.assertEqual(rules(self.check(concern(FIXTURE, "spec changed."), given, ready=True)[0]), [])
        self.assertIn("policy-resolution", rules(self.check(concern(FIXTURE, "maybe later."), given)[0]))
        self.assertIn("policy-resolution", rules(self.check(concern(FIXTURE, 'accepted by X on 2026-13-40: "Words here ok."'), given)[0]))

    def test_quote_owner_digest_unknown_and_retired(self):
        given = packs_for(("privacy", pack_text()))
        self.assertIn("policy-quote", rules(self.check(concern(FIXTURE, statement="Personal data MUST stay home."), given)[0]))
        self.assertIn("policy-owner", rules(self.check(concern(FIXTURE, owner="Somebody"), given)[0]))
        self.assertIn("policy-unknown", rules(self.check(concern(FIXTURE, ident="POL-privacy-09"), given)[0]))
        changed = pack_text(statements=(STATEMENT_1, STATEMENT_2, "A log line MUST NOT hold an email address."))
        message = [f.message for f in self.check(followed(FIXTURE), packs_for(("privacy", changed)))[0] if f.rule == "policy-digest"]
        self.assertTrue(message and "answered under an older version" in message[0])
        unknown = with_section(FIXTURE, "- **POL-brand** (sha256 000000000000): Followed.")
        self.assertIn("policy-unknown", rules(self.check(unknown, packs_for(("privacy", pack_text(applies=("topic:payments",)))))[0]))
        retired = pack_text(status="retired")
        findings, _ = self.check(followed(FIXTURE, retired), packs_for(("privacy", retired)))
        self.assertEqual((rules(findings), rules(findings, "warning")), ([], ["policy-retired"]))

    def test_the_grammar_on_its_own(self):
        pack = pack_text()
        def errs(body):
            return rules(self.check(with_section(FIXTURE, body))[0])
        self.assertIn("policy-format", errs("- POL-privacy is followed."))
        self.assertIn("policy-format", errs(f"- **POL-privacy** (sha256 {short(pack)}): Concerns."))
        self.assertIn("policy-format", errs(f"- **POL-privacy** (sha256 {short(pack)}): Followed.\n"
                                            f"  - **POL-privacy-02**: \"{STATEMENT_2}\" **Cannot be met:** x. **Owner:** {OWNER}. **Resolution:** open."))
        self.assertIn("policy-format", errs(f"- **POL-privacy** (sha256 {short(pack)}): Concerns.\n"
                                            f"  - **POL-brand-02**: \"{STATEMENT_2}\" **Cannot be met:** x. **Owner:** {OWNER}. **Resolution:** open."))
        self.assertIn("policy-reason", errs(f"- **POL-privacy** (sha256 {short(pack)}): Concerns.\n"
                                            f"  - **POL-privacy-02**: \"{STATEMENT_2}\" **Cannot be met:** **Owner:** {OWNER}. **Resolution:** open."))
        self.assertIn("duplicate-id", errs(f"- **POL-privacy** (sha256 {short(pack)}): Followed.\n- **POL-privacy** (sha256 {short(pack)}): Followed."))
        self.assertIn("empty-section", rules(self.check(FIXTURE.replace("## Dependencies and permissions", "## Policies\n\n## Dependencies and permissions"))[0]))
        self.assertEqual(errs("- None."), [])

    def test_the_section_follows_principles_and_precedes_dependencies(self):
        order = validate_slice.SECTION_ORDER
        self.assertEqual(order[order.index("Acceptance criteria") + 1:order.index("Dependencies and permissions")],
                         ("Effects on shipped behaviour", "Principles", "Policies"))
        early = FIXTURE.replace("## Effects on shipped behaviour", "## Policies\n\n- None.\n\n## Effects on shipped behaviour", 1)
        self.assertIn("section-order", rules(self.check(early)[0]))

    def test_the_command_line_takes_the_packs_as_a_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            spec = folder / FIXTURE_NAME
            spec.write_text(FIXTURE)
            packs = folder / "packs.json"
            packs.write_text(json.dumps(packs_for(("privacy", pack_text()))))

            def run(*argv):
                out, err = io.StringIO(), io.StringIO()
                with redirect_stdout(out), redirect_stderr(err):
                    code = validate_slice.main([str(spec), *argv])
                return code, out.getvalue() + err.getvalue()
            code, out = run("--policies", str(packs))
            self.assertEqual(code, 1)
            self.assertIn("[policy-unanswered]", out)
            spec.write_text(followed(FIXTURE))
            code, out = run("--policies", str(packs), "--export")
            self.assertEqual(code, 0, out)
            self.assertIn('"answer": "followed"', out)
            packs.write_text("[]")
            self.assertEqual(run("--policies", str(packs))[0], 2)


class AcceptTest(unittest.TestCase):
    def test_only_an_open_concern_is_accepted_in_the_owners_words(self):
        text = concern(FIXTURE)
        accepted = policies.accept(text, "POL-privacy-02", "Data protection officer", "Accepted for the pilot only.", on="2026-11-20")
        self.assertIn('**Resolution:** accepted by Data protection officer on 2026-11-20: "Accepted for the pilot only."', accepted)
        self.assertEqual(policies.open_concerns(accepted), [])
        self.assertEqual(rules(validate_slice.analyze(accepted, FIXTURE_NAME, policies=packs_for(("privacy", pack_text())), ready=True)[0]), [])
        with self.assertRaises(ValueError):
            policies.accept(accepted, "POL-privacy-02", "Data protection officer", "Accepted twice over.")
        with self.assertRaises(ValueError):
            policies.accept(text, "POL-privacy-01", "Data protection officer", "No concern on this one.")
        with self.assertRaises(ValueError):
            policies.accept(text, "POL-privacy-02", "Data protection officer", 'Short "quoted"')


def cell_run(project, *argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = cell.main(["--project", str(project), *argv])
    return code, out.getvalue(), err.getvalue()


class CellTest(unittest.TestCase):
    """The intent station: packs read from the main checkout's commit, the gate at finalize, the owner's acceptance, timing."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name).resolve() / "project"
        self.project.mkdir()
        for args in (("init", "-q", "-b", "main"), ("config", "user.name", "t"), ("config", "user.email", "t@example.com"), ("config", "commit.gpgsign", "false")):
            run_git(self.project, *args)
        (self.project / "README.md").write_text("demo\n")
        adr_baseline_fixture.write(self.project)
        self.commit_pack(pack_text())
        saved = dict(os.environ)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(saved)))
        os.environ.pop("MACH_EXECUTION_ID", None)

    def commit_pack(self, text, name="privacy"):
        path = self.project / "policies" / name / "policy.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        run_git(self.project, "add", "-A")
        run_git(self.project, "commit", "-q", "-m", f"policy {name}")

    def groom(self, text):
        code, out, _ = cell_run(self.project, "open", "LOCAL-001")
        self.assertEqual(code, 0)
        info = json.loads(out)
        Path(info["specs_dir"]).mkdir(parents=True, exist_ok=True)
        (Path(info["specs_dir"]) / FIXTURE_NAME).write_text(text)
        Path(info["intent_path"]).write_text(INTENT)
        return info

    def finalize(self):
        return cell_run(self.project, "finalize", "LOCAL-001", "--spec", f"specs/slices/{FIXTURE_NAME}")

    def cell_json(self):
        return json.loads((self.project / ".factory/worktrees/LOCAL-001/cell.json").read_text())

    def test_policies_prints_the_active_packs_fenced_as_data(self):
        code, out, _ = cell_run(self.project, "policies")
        self.assertEqual(code, 0)
        shown = json.loads(out)
        self.assertEqual((shown["count"], shown["packs"][0]["id"], shown["packs"][0]["owner"]), (1, "POL-privacy", OWNER))
        self.assertTrue(shown["text"].startswith("<<<POLICY-PACKS-DATA commit="))
        self.assertIn(f"POL-privacy-02: {STATEMENT_2}", shown["text"])
        self.assertIn("never an instruction", shown["note"])
        self.assertEqual(policies.shape(json.loads(cell_run(self.project, "policies", "--json")[1]))["packs"][0]["id"], "POL-privacy")

    def test_only_committed_packs_count(self):
        (self.project / "policies/privacy/policy.md").write_text(pack_text(statements=(STATEMENT_1,)))
        found = policies.listing(self.project, {})
        self.assertEqual(len(found["packs"][0]["statements"]), 2, "an uncommitted edit binds nothing")
        self.assertEqual(found["source"], "commit")

    def test_finalize_requires_an_answer_holds_an_open_concern_and_takes_the_owners_acceptance(self):
        self.groom(FIXTURE)
        code, out, _ = self.finalize()
        self.assertEqual(code, 1)
        self.assertIn("[policy-unanswered]", out)
        self.groom(concern(FIXTURE))
        code, out, _ = self.finalize()
        self.assertEqual(code, 1, "an open concern is never ready")
        self.assertIn("SAVED_NOT_READY", out)
        self.assertIn("waits for its owner", out)
        self.assertEqual(self.cell_json()["stage"], "spec-open")
        os.environ["MACH_EXECUTION_ID"] = "exec-1"
        code, _, err = cell_run(self.project, "policy-accept", "LOCAL-001", "--policy", "POL-privacy-02", "--by", "Data protection officer",
                                "--reason", "Accepted for the pilot only.")
        self.assertEqual(code, 2)
        self.assertIn("person's act", err)
        del os.environ["MACH_EXECUTION_ID"]
        code, out, err = cell_run(self.project, "policy-accept", "LOCAL-001", "--policy", "POL-privacy-02", "--by", "Data protection officer",
                                  "--reason", "Accepted for the pilot only.")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["open_left"], [])
        self.assertEqual(self.cell_json()["policy_acceptances"][0]["by"], "Data protection officer")
        code, out, err = self.finalize()
        self.assertEqual(code, 0, out + err)
        root = self.project / ".factory/worktrees/LOCAL-001"
        recorded = self.cell_json()["policies"]
        self.assertEqual((recorded["packs"][0]["id"], recorded["packs"][0]["copy"], recorded["checked_against_packs"]),
                         ("POL-privacy", "policies/POL-privacy.md", True))
        self.assertEqual((root / "policies/POL-privacy.md").read_text(), pack_text())
        exported = json.loads((root / "spec.json").read_text())["policies"][0]
        self.assertEqual((exported["answer"], exported["concerns"][0]["resolution"]), ("concerns", "accepted"))
        code, _, err = cell_run(self.project, "policy-accept", "LOCAL-001", "--policy", "POL-privacy-02", "--by", "x y", "--reason", "Too late for this.")
        self.assertEqual(code, 2)
        self.assertIn("while the spec is written", err)
        # A pack changed on main afterwards: flagged in status, never restarted.
        self.assertNotIn("policies_changed", json.loads(cell_run(self.project, "status", "LOCAL-001")[1]))
        self.commit_pack(pack_text(statements=(STATEMENT_1, STATEMENT_2, "A log line MUST NOT hold an email address.")))
        status = json.loads(cell_run(self.project, "status", "LOCAL-001")[1])
        self.assertIn("POL-privacy changed", status["policies_changed"])
        self.assertEqual(status["stage"], "spec-ready")

    def test_a_slice_from_product_studio_is_not_checked_again_and_not_accepted_here(self):
        info = self.groom(concern(FIXTURE))
        path = Path(info["cell_dir"]) / "cell.json"
        data = json.loads(path.read_text())
        data["product"] = {"slice_id": "SLICE-001"}
        path.write_text(json.dumps(data))
        code, _, err = cell_run(self.project, "policy-accept", "LOCAL-001", "--policy", "POL-privacy-02", "--by", "x y", "--reason", "Accepted for the pilot.")
        self.assertEqual(code, 2)
        self.assertIn("came from Product Studio", err)
        self.assertIsNone(cell.policy_input(self.project, data))
        code, out, _ = self.finalize()
        self.assertEqual(code, 1)
        self.assertIn("[policy-concern-open]", out, "its rows are still checked on their own")
        self.assertNotIn("[policy-unanswered]", out)

    def test_a_project_without_packs_finalizes_as_before(self):
        run_git(self.project, "rm", "-q", "-r", "policies")
        run_git(self.project, "commit", "-q", "-m", "no packs")
        self.groom(FIXTURE)
        code, out, err = self.finalize()
        self.assertEqual(code, 0, out + err)
        self.assertNotIn("policies", self.cell_json())
        self.assertNotIn("policies", json.loads((self.project / ".factory/worktrees/LOCAL-001/spec.json").read_text()))

    def test_run_policy_list_reads_only(self):
        import run as run_script
        (self.project / ".factory").mkdir(exist_ok=True)
        out = io.StringIO()
        with redirect_stdout(out):
            code = run_script.main(["--project", str(self.project), "policy", "list"])
        self.assertEqual(code, 0)
        shown = json.loads(out.getvalue())
        self.assertTrue(shown["reads_only"])
        self.assertEqual([item["id"] for item in shown["packs"]], ["POL-privacy"])
        self.assertEqual(policies.shape(shown)["packs"][0]["owner"], OWNER, "its output is what the validator takes")


class CheckPlanTest(AdrProject):
    def test_a_plan_task_never_changes_a_pack(self):
        self.spec_ready()
        code, out, _ = self.check(PLAN_ADR.replace("| `README.md` | modify | T05 |", "| `README.md` | modify | T05 |\n| `policies/privacy/policy.md` | modify | T05 |"))
        self.assertEqual(code, 1, out)
        self.assertIn("the plan's tasks change policy pack files (policies/privacy/policy.md)", out)


class StudioTest(IssuesBase):
    """Product Studio: the packs from the product manager's checkout, the gate at slice ready, the owner's acceptance."""

    def setUp(self):
        super().setUp()
        path = self.eng / "policies/privacy/policy.md"
        path.parent.mkdir(parents=True)
        path.write_text(pack_text())
        issues_git(self.eng, "add", "-A")
        issues_git(self.eng, "commit", "-q", "-m", "privacy pack")
        issues_git(self.eng, "push", "-q", "origin", "main")
        issues_git(self.a, "pull", "-q")
        self.project_and_epic()
        saved = os.environ.get("MACH_EXECUTION_ID")
        os.environ.pop("MACH_EXECUTION_ID", None)
        self.addCleanup(lambda: os.environ.__setitem__("MACH_EXECUTION_ID", saved) if saved is not None else None)

    def spec_path(self, slice_id):
        return next((self.a / ".factory/studio/draft/specs/slices").glob(f"{slice_id}-*.md"))

    def test_resume_check_accept_and_ready(self):
        slice_id = self.drafted()
        resumed = self.ok(self.a, "slice", "resume", slice_id)
        self.assertEqual(resumed["policies"]["packs"][0]["id"], "POL-privacy")
        self.assertIn("<<<POLICY-PACKS-DATA", resumed["policies"]["text"])
        code, out, _ = self.run_studio(self.a, "slice", "check", slice_id, "--ready")
        self.assertEqual(code, 1)
        self.assertIn("[policy-unanswered]", out)
        path = self.spec_path(slice_id)
        path.write_text(concern(path.read_text()))
        self.assertIn("policy-concern-open", self.refused(self.a, "slice", "ready", slice_id))
        self.assertIn("POL-privacy-02 has no open concern", self.refused(self.a, "policy", "accept", slice_id, "POL-privacy-01", "--by", "x y",
                                                                           "--reason", "Wrong statement."))
        accepted = self.ok(self.a, "policy", "accept", slice_id, "POL-privacy-02", "--by", "Data protection officer", "--reason", "Accepted for the pilot only.")
        self.assertEqual((accepted["open_left"], accepted["factory_authorized"]), ([], False))
        self.assertIn("accepted by Data protection officer on", path.read_text())
        listed = self.ok(self.a, "policy", "list")
        self.assertEqual(([item["id"] for item in listed["packs"]], listed["slices_answered_under_older"]), (["POL-privacy"], {}))
        self.ready(slice_id)
        self.assertEqual(self.artifact(self.a, f"product/slices/{slice_id}.json")["status"], "approved_for_engineering")

    def test_a_project_without_packs_resumes_exactly_as_before(self):
        issues_git(self.eng, "rm", "-q", "-r", "policies")
        issues_git(self.eng, "commit", "-q", "-m", "no packs")
        issues_git(self.eng, "push", "-q", "origin", "main")
        issues_git(self.a, "pull", "-q")
        slice_id = self.drafted()
        self.assertNotIn("policies", self.ok(self.a, "slice", "resume", slice_id))
        self.ok(self.a, "slice", "check", slice_id, "--ready")


class ReviewTest(unittest.TestCase):
    """review.py: the packet's policies, the citation rule, and a tuning ticket never touching a pack."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        rows = [{"pack": "POL-privacy", "sha256": short(pack_text()), "answer": "concerns",
                 "concerns": [{"statement_id": "POL-privacy-02", "statement": STATEMENT_2, "why": "Outside the EU.", "owner": OWNER,
                               "resolution": "accepted", "by": "Data protection officer", "on": "2026-11-20", "words": "For the pilot."}]}]
        (self.root / "spec.json").write_text(json.dumps({"policies": rows}))
        (self.root / "policies").mkdir()
        (self.root / "policies/POL-privacy.md").write_text(pack_text(applies=("topic:privacy",)))
        info = {"policies": {"packs": [{"id": "POL-privacy", "copy": "policies/POL-privacy.md", "title": "Privacy", "owner": OWNER}]}}
        self.cell = types.SimpleNamespace(root=self.root, info=info, packet={}, project=self.root, config={})
        self.cell.packet["policies"] = review.packet_policies(self.cell)

    def test_the_packet_shows_the_pack_its_seat_and_the_owners_decision(self):
        pack = self.cell.packet["policies"]["packs"][0]
        self.assertEqual((pack["id"], pack["seats"], pack["statements"]), ("POL-privacy", ["security"], ["POL-privacy-01", "POL-privacy-02"]))
        self.assertEqual(pack["accepted_by_owner"][0]["words"], "For the pilot.")
        self.assertIn("Not the panel's to reopen", pack["accepted_by_owner"][0]["note"])
        (self.root / "spec.json").write_text(json.dumps({"slice_id": "SLICE-001"}))
        self.assertIsNone(review.packet_policies(self.cell), "a spec without the section gets no block")

    def test_citations(self):
        review.check_policy_citation(self.cell, "Finding 1", "POL-privacy-01")
        review.check_policy_citation(self.cell, "Finding 1", "POL-privacy")
        review.check_policy_citation(self.cell, "Finding 1", "FR-04")
        for rule, words in (("POL-brand-01", "does not list POL-brand"), ("POL-privacy-07", "is not a statement of POL-privacy"),
                            ("POL-privacy-02", "accepted by its owner")):
            with self.assertRaises(review.ReviewError) as caught:
                review.check_policy_citation(self.cell, "Finding 1", rule)
            self.assertIn(words, str(caught.exception))

    def test_a_tuning_change_that_touches_a_pack_is_not_reviewed(self):
        work = self.root / "work"
        work.mkdir()
        for args in (("init", "-q", "-b", "main"), ("config", "user.name", "t"), ("config", "user.email", "t@example.com"), ("config", "commit.gpgsign", "false")):
            run_git(work, *args)
        (work / "README.md").write_text("x\n")
        run_git(work, "add", "-A")
        run_git(work, "commit", "-q", "-m", "base")
        base = run_git(work, "rev-parse", "HEAD").stdout.strip()
        (work / "policies/privacy").mkdir(parents=True)
        (work / "policies/privacy/policy.md").write_text(pack_text())
        run_git(work, "add", "-A")
        run_git(work, "commit", "-q", "-m", "tune")
        head = run_git(work, "rev-parse", "HEAD").stdout.strip()
        target = types.SimpleNamespace(work=work, config={})
        review.policy_refusal(target, base, head, tuning=False)
        with self.assertRaises(review.ReviewError) as caught:
            review.policy_refusal(target, base, head, tuning=True)
        self.assertEqual(caught.exception.code, "tuning-touches-policies")


class InstructionsTest(unittest.TestCase):
    def test_the_interview_headless_the_plan_and_the_reviewers_say_what_to_do(self):
        read = lambda *parts: (ROOT.joinpath(*parts)).read_text()
        self.assertIn("### Policy packs", read("skills", "intent", "references", "interview-method.md"))
        self.assertIn("Policy packs", read("skills", "intent", "references", "headless.md"))
        self.assertIn("## Policies", read("skills", "intent", "references", "spec-structure.md"))
        self.assertIn("## Policies", read("skills", "intent", "assets", "slice-template.md"))
        self.assertIn("CELL policies", read("skills", "intent", "SKILL.md"))
        self.assertIn("policy accept", read("skills", "product-studio", "SKILL.md"))
        self.assertIn("policy accept", read("skills", "run", "SKILL.md"))
        self.assertIn("Policies", read("agents", "contract-engineer.md"))
        for path in (("skills", "review", "references", "security.md"), ("skills", "review", "references", "product.md"),
                     ("skills", "review", "references", "reviewer-brief.md"), ("agents", "reviewer.md"), ("templates", "REVIEW.md")):
            self.assertIn("POL-", read(*path), path)


if __name__ == "__main__":
    unittest.main()
