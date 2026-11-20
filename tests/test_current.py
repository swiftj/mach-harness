"""Tests for current.py, reached as `run.py current`: how each epic works today, compiled from the shipped slice specs.

Each test builds a throwaway Git repository whose main branch holds slice specs (with the header intake writes under
the title), then reads the view as an engineer would. No .factory folder, no cells, no GitHub.
"""

import importlib.util
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
import current  # noqa: E402
import run  # noqa: E402

_spec = importlib.util.spec_from_file_location("effects_for_current_test", ROOT / "skills" / "intent" / "scripts" / "effects.py")
effects = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(effects)

EFFECTS_HEAD = "| Shipped rule | Effect | In this slice | Note |\n|---|---|---|---|\n"


def git(cwd: Path, *args: str) -> str:
    done = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)
    if done.returncode != 0:
        raise AssertionError(f"git {' '.join(args)}: {done.stderr}")
    return done.stdout


def make_spec(num: int, title: str, invs=(), frs=(), rules=(), scenarios=(("AC-01", "FR-01"),), effects_section=None,
              epic=None, issue=None) -> str:
    """A slice spec the validator can read: `rules` are (R-ID, signed-in value, outcome)."""
    sid = f"SLICE-{num:03d}"
    lines = [f"# {sid}: {title}", ""]
    if epic:
        name, epic_id, epic_issue = epic
        where = f"{epic_id}, issue #{epic_issue}" if epic_issue else epic_id
        lines += [f"> Epic: {name} ({where}). Slice issue: " + (f"#{issue}." if issue else "none."), ""]
    lines += ["## Summary", "", "- **Actor:** Member", "- **Trigger:** The member opens the page", "- **Outcome:** The page is shown", "",
              "## Scope", "", "### In scope", "", "- The page", "", "### Out of scope", "", "- Nothing else", "",
              "## Preconditions", "", "- The member is known", "", "## Invariants", ""]
    lines += [f"- **{ident}:** {text}" for ident, text in invs] + ["", "## Functional requirements", ""]
    lines += [f"- **{ident}:** [Ubiquitous] {text}" for ident, text in frs] + ["", "## Acceptance criteria", ""]
    if rules:
        lines += ["### Decision matrix", "", "| Rule | Signed in | Expected outcome | Side effects | Covers |", "|---|---|---|---|---|"]
        lines += [f"| {ident} | {value} | {outcome} | None | {frs[0][0] if frs else 'FR-01'} |" for ident, value, outcome in rules] + [""]
    lines += ["### Scenarios", ""]
    for ident, covers in scenarios:
        lines += [f"#### {ident}: It works", "", f"- **Covers:** {covers}", "- **Given** a member", "- **When** the member opens the page", "- **Then** the page is shown", ""]
    if effects_section is not None:
        lines += ["## Effects on shipped behaviour", "", effects_section.rstrip("\n"), ""]
    lines += ["## Open questions", "", "- None.", ""]
    return "\n".join(lines)


LENDING = ("Lending", "EPIC-001", 12)
RETURNS = ("Returns", "EPIC-002", 13)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.root = self.tmp / "project"
        (self.root / "specs" / "slices").mkdir(parents=True)
        git(self.root, "init", "-q", "-b", "main")
        git(self.root, "config", "user.email", "t@example.com")
        git(self.root, "config", "user.name", "T")
        git(self.root, "config", "commit.gpgsign", "false")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def add(self, num: int, name: str, text: str) -> None:
        (self.root / "specs" / "slices" / f"SLICE-{num:03d}-{name}.md").write_text(text)

    def commit(self, message="specs") -> str:
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", message)
        return git(self.root, "rev-parse", "HEAD").strip()

    def run_current(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.root), "current", *argv])
        return code, out.getvalue(), err.getvalue()

    def view(self, *argv):
        code, out, err = self.run_current("--json", *argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def epic(self, wanted, *argv):
        found = self.view("--epic", wanted, *argv)["epics"]
        self.assertEqual(len(found), 1, found)
        return found[0]

    def library(self):
        """Five shipped slices across two epics and none: unreconciled, kept, replaced, retired, changed (a chain) and broken."""
        self.add(1, "loans", make_spec(1, "Loans", invs=[("INV-01", "A loan MUST have one borrower.")],
                                       frs=[("FR-01", "The system SHALL list every loan."), ("FR-02", "The system SHALL mark a loan overdue after 14 days.")],
                                       rules=[("R1", "Yes", "Shown"), ("R2", "No", "Refused")], epic=LENDING, issue=41))
        self.add(2, "renewals", make_spec(2, "Renewals", frs=[("FR-01", "The system SHALL renew a loan once.")],
                                          effects_section="None.", epic=LENDING, issue=42))
        self.add(3, "returns", make_spec(3, "Returns", frs=[("FR-01", "The system SHALL mark a loan overdue after 21 days."),
                                                            ("FR-02", "The system SHALL record a return.")],
                                         scenarios=[("AC-01", "FR-01"), ("AC-02", "FR-02")],
                                         effects_section=EFFECTS_HEAD + "| SLICE-001/FR-01 | kept | AC-02 | A returned loan is still listed. |\n"
                                         "| SLICE-001/FR-02 | replaced | FR-01 | |\n| SLICE-001/R2 | retired | | Signed-out members are sent to sign in. |\n",
                                         epic=RETURNS, issue=43))
        self.add(4, "grace", make_spec(4, "Grace", frs=[("FR-01", "The system SHALL mark a loan overdue after 28 days.")],
                                       effects_section=EFFECTS_HEAD + "| SLICE-003/FR-01 | changed | FR-01 | |\n", epic=RETURNS, issue=44))
        self.add(5, "broken", make_spec(5, "Broken", frs=[("FR-01", "The system SHALL do one thing.")],
                                        effects_section=EFFECTS_HEAD + "| SLICE-001/INV-01 | retired | | |\n| SLICE-001/FR-09 | kept | AC-01 | |\n"))
        return self.commit()


class CompileTest(Base):
    def test_kept_replaced_retired_changed_across_epics(self):
        commit = self.library()
        lending = self.epic("EPIC-001")
        self.assertEqual((lending["title"], lending["issue"]), ("Lending", 12))
        self.assertEqual([item["rule"] for item in lending["in_force"]], ["SLICE-001/FR-01", "SLICE-002/FR-01"])
        kept = lending["in_force"][0]
        self.assertEqual(kept["confirmed_by"], [{"slice_id": "SLICE-003", "scenario": "AC-02", "note": "A returned loan is still listed."}])
        self.assertEqual([item["rule"] for item in lending["not_yet_reconciled"]], ["SLICE-001/INV-01", "SLICE-001/R1"])
        gone = {item["rule"]: item for item in lending["no_longer_in_force"]}
        self.assertEqual(sorted(gone), ["SLICE-001/FR-02", "SLICE-001/R2"])
        self.assertEqual(gone["SLICE-001/FR-02"]["superseded_by"][0]["by"], "SLICE-003/FR-01")
        self.assertEqual(gone["SLICE-001/FR-02"]["superseded_by"][0]["epic_id"], "EPIC-002", "the replacement is in another epic")
        self.assertEqual([item["rule"] for item in gone["SLICE-001/FR-02"]["now"]], ["SLICE-004/FR-01"], "the chain is followed to what is in force now")
        self.assertEqual(gone["SLICE-001/R2"]["superseded_by"][0]["effect"], "retired")
        self.assertEqual(gone["SLICE-001/R2"]["now"], [])
        self.assertEqual({item["slice_id"]: item["effects"] for item in lending["slices"]}, {"SLICE-001": "missing", "SLICE-002": "none"})

        returns = self.epic("13")  # by the epic's issue number
        self.assertEqual(returns["epic_id"], "EPIC-002")
        self.assertEqual([item["rule"] for item in returns["in_force"]], ["SLICE-003/FR-02", "SLICE-004/FR-01"])
        grace = returns["in_force"][1]
        self.assertEqual(grace["takes_the_place_of"], [{"effect": "changed", "rule": "SLICE-003/FR-01", "epic_id": "EPIC-002", "note": None}])
        self.assertEqual(grace["lineage"], ["SLICE-003/FR-01", "SLICE-001/FR-02"])
        self.assertEqual([item["rule"] for item in returns["no_longer_in_force"]], ["SLICE-003/FR-01"])
        self.assertEqual(returns["not_yet_reconciled"], [])

        orphan = self.epic("No epic")
        self.assertIsNone(orphan["epic_id"])
        self.assertEqual(orphan["not_applied"][0]["slice_id"], "SLICE-005")
        messages = [item["message"] for item in orphan["not_applied"][0]["problems"]]
        self.assertTrue(any("needs a Note" in text for text in messages), messages)
        self.assertTrue(any("SLICE-001 has no FR-09" in text for text in messages), messages)
        self.assertIn("SLICE-001/INV-01", [item["rule"] for item in lending["not_yet_reconciled"]], "a broken section is never applied")

        whole = self.view("--all")
        self.assertEqual(whole["commit"], commit)
        self.assertEqual(whole["branch"], "main")
        self.assertEqual([item["epic_id"] for item in whole["epics"]], ["EPIC-001", "EPIC-002", None])
        rules = {item["rule"]: item for item in whole["rules"]}
        self.assertFalse(rules["SLICE-001/FR-02"]["in_force"])
        self.assertTrue(rules["SLICE-004/FR-01"]["in_force"])
        self.assertFalse(rules["SLICE-001/R1"]["reconciled"])
        self.assertEqual(len(whole["rules"]), 10)

    def test_the_rules_list_feeds_the_parsers_check(self):
        self.library()
        rules = self.view()["rules"]
        draft = effects.parse(make_spec(9, "Next", frs=[("FR-01", "The system SHALL x.")],
                                        effects_section=EFFECTS_HEAD + "| SLICE-001/FR-02 | kept | AC-01 | |\n| SLICE-004/FR-01 | kept | AC-01 | |\n"))
        found = effects.check(draft, rules, slice_id="SLICE-009", own_ids={"FR-01", "AC-01"})
        self.assertEqual([item["code"] for item in found], ["effects-not-in-force"])
        self.assertIn("replaced by SLICE-003/FR-01", found[0]["message"])

    def test_a_conflict_is_listed_on_both_sides(self):
        self.library()
        self.add(6, "again", make_spec(6, "Again", frs=[("FR-01", "The system SHALL mark a loan overdue after 7 days.")],
                                       effects_section=EFFECTS_HEAD + "| SLICE-001/FR-02 | replaced | FR-01 | |\n", epic=LENDING))
        self.commit()
        lending = self.epic("EPIC-001")
        self.assertEqual(len(lending["conflicts"]), 1)
        self.assertIn("SLICE-006 says SLICE-001/FR-02 is replaced, but SLICE-003 already", lending["conflicts"][0])
        gone = next(item for item in lending["no_longer_in_force"] if item["rule"] == "SLICE-001/FR-02")
        self.assertEqual([item["slice_id"] for item in gone["superseded_by"]], ["SLICE-003", "SLICE-006"])
        self.assertEqual(self.epic("EPIC-002")["conflicts"], lending["conflicts"])

    def test_at_an_earlier_commit_and_off_the_branch(self):
        self.add(1, "loans", make_spec(1, "Loans", frs=[("FR-01", "The system SHALL list every loan.")], epic=LENDING))
        first = self.commit()
        self.library()
        then = self.view("--at", first, "--all")
        self.assertEqual((then["commit"], then["on_integration_branch"], then["slices"]), (first, True, 1))
        self.assertEqual([item["rule"] for item in then["epics"][0]["not_yet_reconciled"]], ["SLICE-001/FR-01"])
        self.assertEqual(self.view("--at", first[:10])["commit"], first)
        git(self.root, "checkout", "-q", "-b", "side")
        self.add(7, "side", make_spec(7, "Side", frs=[("FR-01", "The system SHALL x.")], effects_section="None."))
        side = self.commit()
        git(self.root, "checkout", "-q", "main")
        off = self.view("--at", side)
        self.assertFalse(off["on_integration_branch"])
        self.assertTrue(any("not on the integration branch" in note for note in off["notes"]))
        self.assertEqual(self.view()["slices"], 5, "without --at it is main's head")
        code, _, err = self.run_current("--at", "no-such-thing")
        self.assertEqual(code, 1)
        self.assertIn("is not a commit", err)

    def test_deterministic(self):
        self.library()
        first = [self.run_current(*argv)[1] for argv in (("--all", "--json"), ("--all",), ())]
        second = [self.run_current(*argv)[1] for argv in (("--all", "--json"), ("--all",), ())]
        self.assertEqual(first, second)
        self.assertNotRegex(first[0], r"20\d\d-\d\d-\d\dT")

    def test_plain_text(self):
        self.library()
        code, index, _ = self.run_current()
        self.assertEqual(code, 0)
        self.assertIn("- EPIC-001 Lending (issue #12): 2 slice(s), 2 rule(s) in force, 2 not yet reconciled", index)
        self.assertIn("- No epic: 1 slice(s)", index)
        _, text, _ = self.run_current("--epic", "EPIC-001")
        self.assertIn('- SLICE-001/FR-01 [requirement] "The system SHALL list every loan."\n    confirmed by SLICE-003 AC-02', text)
        self.assertIn("- SLICE-001/FR-02 [requirement]: replaced by SLICE-003/FR-01 (EPIC-002); in force now: SLICE-004/FR-01", text)
        self.assertIn('retired by SLICE-003 (EPIC-002): "Signed-out members are sent to sign in."', text)
        self.assertIn("Not yet reconciled", text)
        _, returns, _ = self.run_current("--epic", "#13")
        self.assertIn("    changes SLICE-003/FR-01\n    earlier forms: SLICE-003/FR-01, SLICE-001/FR-02", returns)

    def test_an_unknown_epic_and_an_empty_repository(self):
        self.add(1, "loans", make_spec(1, "Loans", frs=[("FR-01", "The system SHALL list every loan.")]))
        self.commit()
        empty = self.view("--epic", "EPIC-009")
        self.assertEqual(empty["epics"], [])
        self.assertTrue(any("EPIC-009" in note for note in empty["notes"]))
        shutil.rmtree(self.root / "specs")
        self.commit("no specs")
        self.assertTrue(any("no slice specs" in note for note in self.view()["notes"]))

    def test_spec_text_is_bounded_and_inert(self):
        long = "The system SHALL " + "wait " * 200 + "now."
        self.add(1, "loans", make_spec(1, "Loans", frs=[("FR-01", long), ("FR-02", "The system SHALL greet @octocat and <b>#7</b>.")], epic=LENDING))
        self.commit()
        lending = self.epic("EPIC-001")
        texts = [item["text"] for item in lending["not_yet_reconciled"]]
        self.assertLessEqual(len(texts[0]), current.TEXT_LIMIT)
        markdown = current.epic_markdown(lending, self.view()["commit"])
        self.assertNotIn("@octocat", markdown)
        self.assertNotIn("<b>", markdown)
        self.assertNotIn("#7", markdown)

    def test_no_factory_and_no_writes(self):
        self.library()
        before = git(self.root, "status", "--porcelain", "--ignored")
        self.view("--all")
        self.run_current("--all")
        self.assertEqual(git(self.root, "status", "--porcelain", "--ignored"), before)
        self.assertFalse((self.root / ".factory").exists())


class MarkdownTest(Base):
    def test_bounded_with_a_plain_note(self):
        commit = self.library()
        lending = self.epic("EPIC-001")
        whole = current.epic_markdown(lending, commit)
        self.assertIn(commit, whole)
        self.assertTrue(whole.startswith("### How EPIC-001 Lending (issue "), whole[:80])
        self.assertIn("confirmed by SLICE-003 AC-02", whole)
        self.assertNotIn("cut to fit", whole)
        for limit in (400, 600, len(whole) - 1):
            cut = current.epic_markdown(lending, commit, limit)
            self.assertLessEqual(len(cut), limit, limit)
            self.assertIn("This view was cut to fit. Run `/mach current EPIC-001` for all of it.", cut)
        self.assertEqual(current.epic_markdown(lending, commit, len(whole)), whole)

    def test_the_pure_compiler_needs_no_git(self):
        specs = {"SLICE-001": {"path": "specs/slices/SLICE-001-a.md", "text": make_spec(1, "A", frs=[("FR-01", "The system SHALL a.")]),
                               "epic_id": None, "epic_title": None, "epic_issue": None, "issue": None}}
        view = current.compile_view(specs)
        self.assertEqual(view["epics"][0]["title"], "No epic")
        self.assertEqual([item["rule"] for item in view["epics"][0]["not_yet_reconciled"]], ["SLICE-001/FR-01"])


class BoundariesTest(unittest.TestCase):
    def test_it_reads_only(self):
        source = (ROOT / "skills" / "run" / "scripts" / "current.py").read_text()
        for word in ("write_text", "write_bytes", '"w"', "'w'", "mkdir", '"fetch"', "runner.json", '/ "local"', "claude", "unlink", "rmtree"):
            self.assertNotIn(word, source.replace("Claude", ""), word)
        self.assertNotIn('".factory"', source, "it names no folder under .factory")

    def test_no_station_agent_or_workflow_calls_it(self):
        callers = []
        for top in ("skills", "agents", "workflows", "templates", "bin"):
            for path in sorted((ROOT / top).rglob("*")):
                if not path.is_file() or "__pycache__" in path.parts:
                    continue
                text = path.read_text(encoding="utf-8", errors="ignore")
                if re.search(r"current\.py|import current\b|\brun\.py current\b|RUN current\b", text):
                    callers.append(str(path.relative_to(ROOT)))
        # effects.py, validate_slice.py (its --shipped help) and spec-structure.md name it in prose; shipped.py loads it for the
        # intent station and Product Studio; Studio's `epic current` and intake's comment on the epic's issue load it too.
        self.assertEqual(callers, ["skills/intent/references/spec-structure.md", "skills/intent/scripts/effects.py", "skills/intent/scripts/shipped.py",
                                   "skills/intent/scripts/validate_slice.py", "skills/product-studio/scripts/studio.py", "skills/run/SKILL.md",
                                   "skills/run/scripts/current.py", "skills/run/scripts/intake.py", "skills/run/scripts/run.py"])


if __name__ == "__main__":
    unittest.main()
