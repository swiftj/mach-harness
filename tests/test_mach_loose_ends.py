"""M15 loose ends: the stop that waits for a policy owner, who accepted a concern, and work answered under older rules.

1. `run.py next` stops a cell held at spec-open only by a policy concern (`needs: policy-owner`), through the real
   `cell.py finalize`; a concern beside an ordinary open question takes the ordinary route; the hold lifts when the
   owner accepts and when the spec changes. The walkthrough (`decide`) offers what the scripts accept, neither
   recommended, and `explain` names the pack, the statement and the owner from the cell's own files.
2. `policy accept --by` is checked against a pack's owner where the owner names GitHub logins (case-insensitive,
   with or without '@'), or against `policies.accept_by`; otherwise the record says "not checked against the owner".
3. `run.py status`, the `next` digest and `explain` say, one fixed line each, when the principles, a policy pack or
   a shipped rule the spec names changed after the spec answered them. Flag only: the route is unchanged, and
   GitHub is never asked.
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
for folder in ("intent", "run"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
import cell  # noqa: E402
import policies  # noqa: E402
import run  # noqa: E402
import adr_baseline_fixture  # noqa: E402
from test_cell import INTENT  # noqa: E402
from test_mach_policy_packs import FIXTURE, FIXTURE_NAME, OWNER, STATEMENT_1, STATEMENT_2, concern, followed, pack_text  # noqa: E402
from test_mach_shipped_effects import effects, renamed  # noqa: E402
from test_mach_product_issues import IssuesBase, git as issues_git  # noqa: E402

TICKET = "LOCAL-001"
LOGINS_OWNER = "Data protection officer (@Dana, @lee)"
WITH_QUESTION = "## Open questions\n\n- What is the seat price? Follow up: Finance team."


def git(folder, *args):
    return subprocess.run(["git", *args], cwd=str(folder), capture_output=True, text=True)


def call(main, *argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(argv)
    return code, out.getvalue(), err.getvalue()


class Base(unittest.TestCase):
    """A Git project with the ADR baseline and one policy pack committed on main, and the cell helpers."""
    owner = OWNER

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name).resolve() / "project"
        self.project.mkdir()
        for args in (("init", "-q", "-b", "main"), ("config", "user.name", "t"), ("config", "user.email", "t@example.com"), ("config", "commit.gpgsign", "false")):
            git(self.project, *args)
        (self.project / "README.md").write_text("demo\n")
        adr_baseline_fixture.write(self.project)
        self.commit("policies/privacy/policy.md", pack_text(owner=self.owner), "policy privacy")
        saved = dict(os.environ)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(saved)))
        for name in ("MACH_EXECUTION_ID", "ISSUE_PROVIDER"):
            os.environ.pop(name, None)

    def commit(self, relative, text, message):
        path = self.project / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", message)
        return git(self.project, "rev-parse", "HEAD").stdout.strip()

    def cell(self, *argv):
        return call(cell.main, "--project", str(self.project), *argv)

    def run_cmd(self, *argv):
        return call(run.main, "--project", str(self.project), *argv)

    def json_cmd(self, *argv):
        code, out, err = self.run_cmd(*argv)
        self.assertEqual(code, 0, out + err)
        return json.loads(out)

    def groom(self, text, name=FIXTURE_NAME, intent=INTENT):
        if not getattr(self, "opened", None):
            code, out, err = self.cell("open", TICKET)
            self.assertEqual(code, 0, out + err)
            self.opened = json.loads(out)
        Path(self.opened["specs_dir"]).mkdir(parents=True, exist_ok=True)
        (Path(self.opened["specs_dir"]) / name).write_text(text)
        Path(self.opened["intent_path"]).write_text(intent)
        self.spec_name = name
        return self.opened

    def finalize(self):
        return self.cell("finalize", TICKET, "--spec", f"specs/slices/{self.spec_name}")

    def cell_json(self):
        return json.loads((self.project / ".factory/worktrees" / TICKET / "cell.json").read_text())

    def write_cell_json(self, data):
        (self.project / ".factory/worktrees" / TICKET / "cell.json").write_text(json.dumps(data, indent=2))

    def next(self, headless=False):
        return self.json_cmd("next", TICKET, *(["--headless"] if headless else []))


class PolicyOwnerStopTest(Base):
    """Item 1: the stop that waits for the policy's owner, end to end through the real finalize and next."""

    def held(self):
        self.groom(concern(FIXTURE))
        code, out, _ = self.finalize()
        self.assertEqual(code, 1)
        self.assertIn("SAVED_NOT_READY", out)
        self.assertEqual((self.cell_json()["stage"], self.cell_json()["policy_concerns_open"]), ("spec-open", 1))

    def test_a_concern_alone_waits_for_the_owner_in_both_modes(self):
        self.held()
        for headless in (False, True):
            step = self.next(headless)
            self.assertEqual((step["action"], step["needs"], step["stage"]), ("stop", "policy-owner", "spec-open"), f"headless={headless}")
            self.assertIn("1 policy concern waiting for the policy's owner", step["reason"])
            self.assertIn(f"policy accept {TICKET} <POL-id>", step["prompt"])
            self.assertEqual(step["digest"]["needs_person"], run.NEEDS_TEXT["policy-owner"])

    def test_a_concern_beside_an_open_question_takes_the_ordinary_route(self):
        self.groom(concern(FIXTURE).replace("## Open questions\n\n- None.", WITH_QUESTION))
        self.assertEqual(self.finalize()[0], 1)
        self.assertNotIn("policy_concerns_open", self.cell_json())
        step = self.next()
        self.assertEqual((step["action"], step["interactive"]), ("groom", True))
        step = self.next(headless=True)
        self.assertEqual((step["action"], step["needs"]), ("stop", "answers"))

    def test_the_owners_acceptance_lifts_the_hold(self):
        self.held()
        code, out, err = self.cell("policy-accept", TICKET, "--policy", "POL-privacy-02", "--by", "Data protection officer",
                                   "--reason", "Accepted for the pilot only.")
        self.assertEqual(code, 0, out + err)
        self.assertNotIn("policy_concerns_open", self.cell_json(), "the last open concern is settled")
        self.assertEqual(self.next()["action"], "groom", "the spec is finalized again before anything else moves")
        code, out, err = self.finalize()
        self.assertEqual(code, 0, out + err)
        self.assertEqual(self.next()["action"], "plan")

    def test_a_changed_spec_lifts_the_hold(self):
        self.held()
        self.groom(concern(FIXTURE, "spec changed."))
        code, out, err = self.finalize()
        self.assertEqual(code, 0, out + err)
        self.assertEqual(self.cell_json()["stage"], "spec-ready")
        self.assertNotIn("policy_concerns_open", self.cell_json())
        self.assertEqual(self.next()["action"], "plan")

    def test_one_of_two_concerns_accepted_still_waits(self):
        two = concern(FIXTURE).replace(
            "**Resolution:** open.",
            "**Resolution:** open.\n  - **POL-privacy-01**: \"" + STATEMENT_1 + "\" **Cannot be met:** The sender is hidden. **Owner:** " + OWNER
            + ". **Resolution:** open.", 1)
        self.groom(two)
        self.assertEqual(self.finalize()[0], 1)
        self.assertEqual(self.cell_json()["policy_concerns_open"], 2)
        self.assertEqual(self.cell("policy-accept", TICKET, "--policy", "POL-privacy-02", "--by", "Data protection officer",
                                   "--reason", "Accepted for the pilot only.")[0], 0)
        self.assertEqual(self.cell_json()["policy_concerns_open"], 1)
        self.assertEqual(self.next()["needs"], "policy-owner")

    def test_the_walkthrough_offers_what_the_scripts_accept_and_recommends_neither(self):
        self.held()
        report = self.json_cmd("decide", TICKET, "--json")
        record = report["tickets"][0]
        self.assertEqual(record["state"], "policy-owner")
        self.assertEqual([item["key"] for item in record["options"]], ["accept", "interview", "abandon"])
        self.assertEqual([item["recommended"] for item in record["options"]], [False, False, False])
        self.assertEqual(record["recommendation"], {"basis": "judgement"})
        self.assertEqual(record["options"][0]["route"], f'policy accept {TICKET} POL-privacy-02 "<their words>"')
        self.assertTrue(record["options"][0]["needs_reason"])
        self.assertTrue(record["options"][1]["route"].endswith(f" {TICKET}"))
        shown = record["situation"]["concerns"][0]
        self.assertEqual((shown["pack"], shown["statement_id"], shown["statement"], shown["owner"]), ("POL-privacy", "POL-privacy-02", STATEMENT_2, OWNER))
        self.assertIn(".factory/worktrees/LOCAL-001/spec.md", record["show_first"])
        import decide
        for field in ("situation.concerns[].statement", "situation.concerns[].why", "situation.concerns[].owner"):
            self.assertIn(field, decide.DATA_FIELDS)

    def test_a_product_studio_slice_is_not_offered_the_acceptance_here(self):
        self.held()
        data = self.cell_json()
        data["product"] = {"slice_id": "SLICE-001"}
        self.write_cell_json(data)
        record = self.json_cmd("decide", TICKET, "--json")["tickets"][0]
        self.assertEqual([item["key"] for item in record["options"]], ["wait", "abandon"])
        self.assertIn("Product Studio", record["situation"]["note"])

    def test_explain_names_the_pack_the_statement_and_the_owner(self):
        self.held()
        report = self.json_cmd("explain", TICKET, "--json")
        self.assertEqual(report["headline_code"], "waiting_for_person")
        concern_ = report["policies"]["open_concerns"][0]
        self.assertEqual((concern_["pack"], concern_["statement_id"], concern_["owner"], concern_["source_file"]),
                         ("POL-privacy", "POL-privacy-02", OWNER, "spec.md"))
        text = self.run_cmd("explain", TICKET)[1]
        self.assertIn(f"- [policy] POL-privacy-02 of POL-privacy waits for its owner, {OWNER}: \"{STATEMENT_2}\"", text)
        self.cell("policy-accept", TICKET, "--policy", "POL-privacy-02", "--by", "Data protection officer", "--reason", "Accepted for the pilot only.")
        accepted = self.json_cmd("explain", TICKET, "--json")["policies"]["acceptances"][0]
        self.assertEqual((accepted["statement_id"], accepted["by"], accepted["owner_check"]),
                         ("POL-privacy-02", "Data protection officer", policies.NOT_CHECKED))


class OwnerCheckTest(Base):
    """Item 2: the name given for an acceptance, checked against the pack's owner where that can be done without GitHub."""
    owner = LOGINS_OWNER

    def test_the_owner_grammar_takes_a_list_of_logins(self):
        record = policies.parse(pack_text(owner=LOGINS_OWNER), "p", "privacy")
        self.assertEqual((record["problems"], record["owner_handle"]), ([], "@Dana, @lee"))
        self.assertEqual(policies.owner_logins(LOGINS_OWNER), ["dana", "lee"])
        self.assertEqual(policies.owner_logins(OWNER), [], "a team cannot be checked without GitHub")
        self.assertEqual(policies.owner_logins("Privacy (@acme/privacy, @dana)"), [], "nor a team beside logins")
        self.assertEqual(policies.owner_logins("Brand team"), [])
        self.assertIn("not a role or team", " ".join(policies.parse(pack_text(owner="DPO (@dana,, @lee)"), "p", "privacy")["problems"]))

    def test_owner_check_rules(self):
        self.assertEqual(policies.owner_check(LOGINS_OWNER, "DANA"), policies.CHECKED_OWNER)
        self.assertEqual(policies.owner_check(LOGINS_OWNER, "@lee"), policies.CHECKED_OWNER)
        self.assertEqual(policies.owner_check(LOGINS_OWNER, "privacy-lead", ["@Privacy-Lead"]), policies.CHECKED_LIST)
        self.assertEqual(policies.owner_check(OWNER, "Anyone at all"), policies.NOT_CHECKED)
        self.assertEqual(policies.owner_check(OWNER, "Privacy-Lead", ["privacy-lead"]), policies.CHECKED_LIST)
        with self.assertRaises(ValueError) as caught:
            policies.owner_check(LOGINS_OWNER, "Data protection officer")
        self.assertIn("@dana, @lee", str(caught.exception))
        with self.assertRaises(ValueError):
            policies.owner_check(OWNER, "Someone else", ["privacy-lead"])
        self.assertEqual(policies.accept_by({}), [])
        self.assertEqual(policies.accept_by({"policies": {"accept_by": [" privacy  lead "]}}), ["privacy lead"])
        for wrong in ("dana", [""], [3]):
            with self.assertRaises(ValueError):
                policies.accept_by({"policies": {"accept_by": wrong}})
        self.assertIn("accident, not forgery", policies.ACCEPT_GUARD)

    def test_a_name_in_brackets_is_refused_so_only_accept_writes_the_check(self):
        text = concern(FIXTURE, owner=LOGINS_OWNER, pack=pack_text(owner=LOGINS_OWNER))
        with self.assertRaises(ValueError):
            policies.accept(text, "POL-privacy-02", "dana (checked against the pack's owner)", "Accepted for the pilot only.")

    def test_cell_accept_is_checked_recorded_and_exported(self):
        pack = pack_text(owner=LOGINS_OWNER)
        self.groom(concern(FIXTURE, owner=LOGINS_OWNER, pack=pack))
        self.assertEqual(self.finalize()[0], 1)
        code, _, err = self.cell("policy-accept", TICKET, "--policy", "POL-privacy-02", "--by", "Data protection officer", "--reason", "Accepted for the pilot.")
        self.assertEqual(code, 2)
        self.assertIn("is not one of the people who may accept this concern", err)
        code, out, err = self.cell("policy-accept", TICKET, "--policy", "POL-privacy-02", "--by", "@DANA", "--reason", "Accepted for the pilot.")
        self.assertEqual(code, 0, out + err)
        shown = json.loads(out)
        self.assertEqual(shown["owner_check"], policies.CHECKED_OWNER)
        self.assertIn("accident, not forgery", shown["owner_check_note"])
        self.assertEqual(self.cell_json()["policy_acceptances"][0]["owner_check"], policies.CHECKED_OWNER)
        code, out, err = self.finalize()
        self.assertEqual(code, 0, out + err)
        exported = json.loads((self.project / ".factory/worktrees" / TICKET / "spec.json").read_text())["policies"][0]["concerns"][0]
        self.assertEqual((exported["by"], exported["owner_check"]), ("@DANA (checked against the pack's owner)", policies.CHECKED_OWNER),
                         "reviewers read the check with the name, wherever the name is shown")

    def test_the_projects_list_is_read_from_the_settings(self):
        (self.project / ".factory").mkdir(exist_ok=True)
        (self.project / ".factory/config.json").write_text(json.dumps({"policies": {"dir": "policies", "accept_by": ["privacy-lead"]}}))
        self.groom(concern(FIXTURE, owner=LOGINS_OWNER, pack=pack_text(owner=LOGINS_OWNER)))
        self.finalize()
        code, out, err = self.cell("policy-accept", TICKET, "--policy", "POL-privacy-02", "--by", "Privacy-Lead", "--reason", "Accepted for the pilot.")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(json.loads(out)["owner_check"], policies.CHECKED_LIST)
        (self.project / ".factory/config.json").write_text(json.dumps({"policies": {"accept_by": "privacy-lead"}}))
        self.groom(concern(FIXTURE, owner=LOGINS_OWNER, pack=pack_text(owner=LOGINS_OWNER)))
        code, _, err = self.cell("policy-accept", TICKET, "--policy", "POL-privacy-02", "--by", "dana", "--reason", "Accepted for the pilot.")
        self.assertEqual(code, 2)
        self.assertIn("must be a list", err)


class OlderRulesTest(Base):
    """Item 3: principles, a policy pack and a shipped rule changed after the spec answered them: one fixed line each, in
    run.py status, the next digest and explain. The route is unchanged."""

    def setUp(self):
        super().setUp()
        self.commit("specs/slices/" + FIXTURE_NAME, FIXTURE, "SLICE-001 shipped")
        self.commit("product/ready/PRINCIPLES/principles.json", json.dumps({"revision": 1, "sha256": "a" * 64}), "principles r1")
        spec = followed(effects(renamed(FIXTURE, "SLICE-005"), "| SLICE-001/FR-01 | kept | AC-01 | A second invite still reserves a seat. |"))
        self.groom(spec, name="SLICE-005-invite-again.md", intent=INTENT.replace("SLICE-001 at specs/slices/SLICE-001-invite-teammate.md",
                                                                                  "SLICE-005 at specs/slices/SLICE-005-invite-again.md"))
        code, out, err = self.finalize()
        self.assertEqual(code, 0, out + err)
        data = self.cell_json()
        data["principles"] = {"source": "folder", "issue": None, "revision": 1, "sha256": "a" * 64, "read_at": "2026-11-01T00:00:00+00:00"}
        self.write_cell_json(data)

    def test_nothing_changed_nothing_said(self):
        self.assertNotIn("rules_changed", self.next()["digest"])
        status = self.json_cmd("status")
        self.assertNotIn("rules_changed", status["tickets"][0])
        self.assertNotIn("rules_changed", status["digest"])

    def test_each_change_is_one_fixed_line_and_the_route_is_unchanged(self):
        before = self.next()
        self.commit("product/ready/PRINCIPLES/principles.json", json.dumps({"revision": 2, "sha256": "b" * 64}), "principles r2")
        self.commit("policies/privacy/policy.md", pack_text(statements=(STATEMENT_1, STATEMENT_2, "A log line MUST NOT hold an email address.")), "pack")
        replacing = renamed(effects(FIXTURE, "| SLICE-001/FR-01 | replaced | FR-01 | |"), "SLICE-006", "Invite with approval")
        self.commit("specs/slices/SLICE-006-invite-with-approval.md", replacing, "SLICE-006 shipped")
        after = self.next()
        self.assertEqual({key: after[key] for key in ("action", "stop", "needs", "stage")}, {key: before[key] for key in ("action", "stop", "needs", "stage")})
        lines = after["digest"]["rules_changed"]
        self.assertEqual(len(lines), 3)
        self.assertTrue(lines[0].startswith("The product principles changed after this spec answered them (revision 1 answered; revision 2 is committed"))
        self.assertTrue(lines[1].startswith("Policy packs changed after this spec answered them (POL-privacy changed)"))
        self.assertTrue(lines[2].startswith("A shipped rule this spec names is no longer in force on the main branch (1 row;"))
        for line in lines:
            self.assertIn("not restarted", line)
        status = self.json_cmd("status")
        self.assertEqual(status["tickets"][0]["rules_changed"], lines)
        self.assertIn(f"changed after {TICKET} was answered", status["digest"]["rules_changed"])
        self.assertEqual(status["tickets"][0]["action"], before["action"])
        explained = self.json_cmd("explain", TICKET, "--json")
        self.assertEqual(explained["digest"]["rules_changed"], lines)
        text = self.run_cmd("explain", TICKET)[1]
        for line in lines:
            self.assertIn(f"- [older rules] {line}", text)
        self.assertEqual(self.cell_json()["stage"], "spec-ready", "flagged only")
        self.assertIn("principles_changed", json.loads(self.cell("status", TICKET)[1]))

    def test_principles_from_github_are_compared_with_the_newest_copy_here_and_github_is_never_asked(self):
        data = self.cell_json()
        data["principles"] = {"source": "github", "issue": 1, "revision": 1, "sha256": "a" * 64, "read_at": "2026-11-01T00:00:00+00:00"}
        self.write_cell_json(data)
        other = self.project / ".factory/worktrees/LOCAL-002"
        other.mkdir(parents=True)
        (other / "cell.json").write_text(json.dumps({"ticket_id": "LOCAL-002", "stage": "interview", "principles": {
            "source": "github", "issue": 1, "revision": 3, "sha256": "c" * 64, "read_at": "2026-11-15T09:00:00+00:00"}}))
        real = subprocess.run

        def guarded(argv, *args, **kwargs):
            command = " ".join(str(part) for part in argv)
            if "ticket.py" in command or command.startswith("gh "):
                raise AssertionError(f"GitHub was asked: {command}")
            return real(argv, *args, **kwargs)

        with mock.patch("subprocess.run", side_effect=guarded):
            lines = self.next()["digest"]["rules_changed"]
            self.json_cmd("status")
            self.json_cmd("explain", TICKET, "--json")
        self.assertEqual(lines, ["The product principles changed after this spec answered them (revision 1 answered; revision 3 was read from GitHub "
                                 "on 2026-11-15 for LOCAL-002, the newest copy on this machine). They bind slices marked ready from now on; this work "
                                 "goes on as it was answered, and is not restarted."])
        # An older copy elsewhere says nothing.
        (other / "cell.json").write_text(json.dumps({"ticket_id": "LOCAL-002", "stage": "interview", "principles": {
            "source": "github", "issue": 1, "revision": 0, "sha256": "c" * 64, "read_at": "2026-10-01T09:00:00+00:00"}}))
        self.assertNotIn("rules_changed", self.next()["digest"])

    def test_a_failure_to_check_is_said_and_routes_nothing(self):
        before = self.next()
        with mock.patch.object(run.intent_cell(), "principles_changed", side_effect=RuntimeError("boom")):
            after = self.next()
        self.assertEqual(after["action"], before["action"])
        self.assertEqual(after["digest"]["rules_changed"], ["Whether the product principles changed since this spec answered them could not be checked (RuntimeError)."])


class StudioTest(IssuesBase):
    """Product Studio: `policy accept` takes the project's list, and `status` flags a slice answered under an older pack."""

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

    def row(self, slice_id):
        return next(item for item in self.ok(self.a, "status")["slices"] if item["slice_id"] == slice_id)

    def test_accept_takes_the_projects_list_and_status_flags_an_older_pack(self):
        slice_id = self.drafted()
        path = self.spec_path(slice_id)
        original = path.read_text()
        path.write_text(concern(original))
        settings = self.a / ".factory/config.json"
        config = json.loads(settings.read_text()) if settings.is_file() else {}
        config["policies"] = {"dir": "policies", "accept_by": ["privacy-lead"]}
        settings.parent.mkdir(parents=True, exist_ok=True)
        settings.write_text(json.dumps(config))
        self.assertIn("is not one of the people", self.refused(self.a, "policy", "accept", slice_id, "POL-privacy-02", "--by", "Somebody",
                                                                "--reason", "Accepted for the pilot only."))
        accepted = self.ok(self.a, "policy", "accept", slice_id, "POL-privacy-02", "--by", "Privacy-Lead", "--reason", "Accepted for the pilot only.")
        self.assertEqual(accepted["owner_check"], policies.CHECKED_LIST)
        self.assertIn("accepted by Privacy-Lead (checked against the project's list) on", path.read_text())
        path.write_text(followed(original))
        self.assertNotIn("policies_changed", self.row(slice_id))
        changed = self.eng / "policies/privacy/policy.md"
        changed.write_text(pack_text(statements=(STATEMENT_1, STATEMENT_2, "A log line MUST NOT hold an email address.")))
        issues_git(self.eng, "commit", "-q", "-am", "privacy pack changed")
        issues_git(self.eng, "push", "-q", "origin", "main")
        issues_git(self.a, "pull", "-q")
        self.assertIn("POL-privacy changed", self.row(slice_id)["policies_changed"])


class DocumentsTest(unittest.TestCase):
    def test_the_as_built_note_and_claude_md_say_it(self):
        note = (ROOT / "docs/mach-next/M15_LOOSE_ENDS.md").read_text()
        for phrase in ("policy-owner", "not checked against the owner", "policies.accept_by", "rules_changed", "accident, not forgery"):
            self.assertIn(phrase, note)
        claude = (ROOT / "CLAUDE.md").read_text()
        self.assertIn("M15_LOOSE_ENDS.md", claude)


if __name__ == "__main__":
    unittest.main()
