"""Architecture decisions (ADRs), M11 section 7: the shared helper (adr.py), and every station rule built on it.

Each rule in the design has a test here: the header and its strictness, reading committed ADRs, the plan's rules in
check-plan, a plan that cannot comply (a stop, an exception, a re-plan after supersession), a ticket's own proposal
(Low and Medium go on, High waits for acceptance), the builder's lack of any override, the review packet and the
citation check, timing (flagged, never blocked), the run skill's adr list and adr new, the audit note, the tuning
ticket's refusal, and the refusal of a person's acts inside a supervised execution.
"""

import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
for folder in ("intent", "run", "review", "build", "audit"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import adr  # noqa: E402
import adr_baseline_fixture  # noqa: E402
import audit  # noqa: E402
import cell as cell_script  # noqa: E402
import review  # noqa: E402
import run  # noqa: E402
from test_build import INTENT, PLAN, SPEC, SPEC_NAME, git  # noqa: E402
from test_review import Base as ReviewBase, SUMMARY, DETAIL, TICKET  # noqa: E402

UNATTENDED = {"MACH_EXECUTION_ID": "x0123456789ab"}
PLAN_ADR = PLAN.replace("- **ADRs:** None.", "- **ADRs:** ADR-0001")


def adr_text(title, status="accepted", applies=None, extra=""):
    head = ["---", f"status: {status}", "date: 2026-11-01"]
    if applies is not None:
        head += ["applies-to:"] + [f"  - {item}" for item in applies]
    return "\n".join(head + ["---", "", f"# {title}", "", "## Context and Problem Statement", "", "Plain text." + extra, ""])


PYTHON_ADR = adr_text("Write the service in Python", applies=["path:app/**"])


class ParseTest(unittest.TestCase):
    def test_a_well_formed_accepted_adr_binds(self):
        record = adr.parse(PYTHON_ADR, "docs/adr/0001-use-python.md")
        self.assertEqual((record["id"], record["status"], record["title"], record["applies_to"], record["problems"], record["binding"]),
                         ("ADR-0001", "accepted", "Write the service in Python", ["path:app/**"], [], True))

    def test_missing_applies_to_means_all(self):
        record = adr.parse(adr_text("Use UTC everywhere"), "docs/adr/0002-utc.md")
        self.assertEqual((record["applies_to"], record["applies_to_given"], record["binding"]), (["all"], False, True))

    def test_statuses(self):
        cases = {"proposed": ("proposed", None), "deprecated": ("deprecated", None), "rejected": ("rejected", None),
                 "superseded by ADR-0009": ("superseded", "ADR-0009"), "superseded by [ADR-0009](0009-x.md)": ("superseded", "ADR-0009")}
        for given, (status, by) in cases.items():
            with self.subTest(given=given):
                record = adr.parse(adr_text("A decision here", status=given), "docs/adr/0003-x.md")
                self.assertEqual((record["status"], record["superseded_by"], record["binding"]), (status, by, False))

    def test_malformed_adrs_are_problems_never_silently_accepted(self):
        cases = {
            "not one of": adr_text("A decision here", status="Accepted!"),
            "no header": "# A decision\n\nstatus: accepted\n",
            "not closed": "---\nstatus: accepted\n# A decision\n",
            "no 'status' field": "---\ndate: 2026-01-01\n---\n\n# A decision\n",
            "tab": "---\nstatus:\taccepted\n---\n\n# A decision\n",
            "not 'key: value'": "---\nstatus: accepted\nthis is not a field\n---\n\n# A decision\n",
            "belongs to no field": "---\n  - path:app/**\nstatus: accepted\n---\n\n# A decision\n",
            "names 'status' twice": "---\nstatus: proposed\nstatus: accepted\n---\n\n# A decision\n",
            "MACH reads 'applies-to'": "---\nstatus: accepted\napplies_to: all\n---\n\n# A decision\n",
            "is empty": "---\nstatus: accepted\napplies-to:\n---\n\n# A decision\n",
            "the app type must be one of": adr_text("A decision", applies=["app:website"]),
            "is not path:<glob>": adr_text("A decision", applies=["module:billing"]),
            "uses only *, ** and ?": adr_text("A decision", applies=["path:src/{a,b}/**"]),
            "relative to the repository root": adr_text("A decision", applies=["path:/etc/**"]),
            "'.' or '..'": adr_text("A decision", applies=["path:../x/**"]),
            "a topic is one lowercase word": adr_text("A decision", applies=["topic:Data Base"]),
            "has no title": "---\nstatus: accepted\n---\n\nNo heading here.\n",
        }
        for expected, text in cases.items():
            with self.subTest(expected=expected):
                record = adr.parse(text, "docs/adr/0004-x.md")
                self.assertFalse(record["binding"])
                self.assertTrue(any(expected in problem for problem in record["problems"]), record["problems"])

    def test_a_header_line_with_a_list_in_brackets(self):
        record = adr.parse("---\nstatus: accepted\napplies-to: [app:api, topic:database]\n---\n\n# Use Postgres\n", "docs/adr/0005-pg.md")
        self.assertEqual((record["applies_to"], record["binding"]), (["app:api", "topic:database"], True))

    def test_serves_names_technical_needs_at_their_revision(self):
        """M17: `serves` is optional; an ADR without it carries no key, so nothing changes for it."""
        self.assertNotIn("serves", adr.parse(PYTHON_ADR, "docs/adr/0001-use-python.md"))
        self.assertNotIn("serves", adr.public(adr.parse(PYTHON_ADR, "docs/adr/0001-use-python.md")))
        for header in ("serves: TN-01@2, TN-04@1", "serves: [TN-01@2, TN-04@1]", "serves:\n  - TN-01@2\n  - TN-04@1"):
            with self.subTest(header=header):
                record = adr.parse(f"---\nstatus: accepted\n{header}\n---\n\n# Use Postgres\n", "docs/adr/0005-pg.md")
                self.assertEqual((record["serves"], record["problems"], record["binding"]),
                                 ([{"need_id": "TN-01", "revision": 2}, {"need_id": "TN-04", "revision": 1}], [], True))
                self.assertEqual(adr.public(record)["serves"], record["serves"])

    def test_a_malformed_serves_is_a_problem_with_its_reason(self):
        cases = {"serves:": "'serves' is empty", "serves: TN-01": "is not a technical need at a revision", "serves: TN-1@2": "is not a technical need",
                 "serves: TN-01@0": "is not a technical need", "serves: tn-01@2": "is not a technical need", "serves: ADR-0001@1": "is not a technical need",
                 "serves: TN-01@1, TN-01@2": "names TN-01 twice"}
        for header, expected in cases.items():
            with self.subTest(header=header):
                record = adr.parse(f"---\nstatus: accepted\n{header}\n---\n\n# Use Postgres\n", "docs/adr/0005-pg.md")
                self.assertFalse(record["binding"])
                self.assertTrue(any(expected in problem for problem in record["problems"]), record["problems"])

    def test_render_writes_serves_in_the_header_and_parses_back(self):
        text = adr.render("Keep data in PostgreSQL", applies_to=["topic:storage"], context="Why now here.", options=["PostgreSQL", "SQLite"],
                          decision="PostgreSQL, for the reason given.", consequences=["Good."], serves=["TN-02@3", "TN-05@1"])
        self.assertIn("applies-to:\n  - topic:storage\nserves: TN-02@3, TN-05@1\n---", text)
        record = adr.parse(text, "docs/adr/0001-pg.md")
        self.assertEqual((record["serves"], record["problems"]), ([{"need_id": "TN-02", "revision": 3}, {"need_id": "TN-05", "revision": 1}], []))
        self.assertNotIn("serves:", adr.render("Keep data in PostgreSQL", context="Why now here.", decision="PostgreSQL, for the reason."))

    def test_serves_flags(self):
        def record(ident, status, serves):
            return {"id": ident, "file": f"docs/adr/{ident[4:]}-x.md", "status": status, "serves": [{"need_id": n, "revision": r} for n, r in serves]}
        needs = [{"need_id": "TN-01", "revision": 2, "status": "active"}, {"need_id": "TN-02", "revision": 1, "status": "retired"}]
        records = [record("ADR-0001", "accepted", [("TN-01", 1)]), record("ADR-0002", "proposed", [("TN-02", 1)]),
                   record("ADR-0003", "proposed", [("TN-09", 1)]), record("ADR-0004", "accepted", [("TN-01", 2)]),
                   record("ADR-0005", "rejected", [("TN-01", 1)]), record("ADR-0006", "superseded", [("TN-09", 1)]),
                   record("ADR-0007", "accepted", [("TN-01", 3)]), {"id": "ADR-0008", "status": "accepted"}]
        flags = adr.serves_flags(records, needs)
        self.assertEqual([(flag["id"], flag["need_id"], flag["change"], flag["published_revision"]) for flag in flags],
                         [("ADR-0001", "TN-01", "older-revision", 2), ("ADR-0002", "TN-02", "retired", 1), ("ADR-0003", "TN-09", "missing", None),
                          ("ADR-0007", "TN-01", "unknown-revision", 2)])
        self.assertIn("ADR-0001 serves TN-01 at revision 1; the published need is at revision 2.", flags[0]["say"])
        self.assertTrue(all("nothing is reopened or blocked" in flag["say"] for flag in flags))
        self.assertEqual(adr.serves_flags(records, None), [], "an unreadable needs file judges nothing")
        self.assertEqual([flag["change"] for flag in adr.serves_flags(records[:1], [])], ["missing"], "no needs published: every served need is missing")

    def test_the_folder_names_files_and_numbers(self):
        files = {"docs/adr/0001-a.md": adr_text("First decision"), "docs/adr/0001-b.md": adr_text("Second decision"),
                 "docs/adr/12-bad.md": adr_text("Badly named"), "docs/adr/README.md": "# About ADRs\n", "docs/adr/template.md": "x",
                 "docs/adr/0003-old.md": adr_text("Old decision", status="superseded by ADR-0042"), "docs/adr/sub/0009-deep.md": adr_text("Nested decision")}
        records, problems = adr.read_folder(files, "docs/adr")
        self.assertEqual(sorted(record["file"] for record in records), ["docs/adr/0001-a.md", "docs/adr/0001-b.md", "docs/adr/0003-old.md", "docs/adr/12-bad.md"])
        text = "\n".join(problems)
        self.assertIn("docs/adr/0001-a.md: another file has the same number: docs/adr/0001-b.md", text)
        self.assertIn("docs/adr/12-bad.md: the file name must be NNNN-title.md", text)
        self.assertIn("superseded by ADR-0042, which does not exist", text)
        self.assertFalse(any(record["binding"] for record in records))

    def test_globs(self):
        cases = [("app/**", "app/invite.py", True), ("app/**", "app/x/y.py", True), ("app/**", "apps/x.py", False), ("app/*.py", "app/x/y.py", False),
                 ("**/*.sql", "db/migrations/1.sql", True), ("**/*.sql", "top.sql", True), ("services/api", "services/api/main.go", True),
                 ("services/api/", "services/api/main.go", True), ("src/?.ts", "src/a.ts", True), ("src/?.ts", "src/ab.ts", False)]
        for pattern, path, expected in cases:
            with self.subTest(pattern=pattern, path=path):
                self.assertEqual(adr.glob_match(pattern, path), expected)

    def test_the_folder_setting(self):
        self.assertEqual(adr.folder_of({}), ("docs/adr", None))
        self.assertEqual(adr.folder_of({"adr": {"dir": "architecture/decisions/"}}), ("architecture/decisions", None))
        for bad in ("/etc", "../x", ".factory/adr", "", 7, "a\\b"):
            with self.subTest(bad=bad):
                folder, problem = adr.folder_of({"adr": {"dir": bad}})
                self.assertEqual(folder, "docs/adr")
                self.assertIn("adr.dir", problem)

    def test_app_types_are_the_intent_stations(self):
        self.assertEqual(adr.APP_TYPES, cell_script.APP_TYPES)

    def test_text_shown_to_a_model_is_bounded_and_inert(self):
        text = adr.bounded("a\x1b[31m\x07b" + "x" * 7000)
        self.assertNotIn("\x1b", text)
        self.assertNotIn("\x07", text)
        self.assertIn("[cut here", text)
        self.assertLess(len(text), adr.TEXT_LIMIT + 200)

    def test_set_status_changes_only_the_status_line(self):
        text = adr.render("Use SQLite for invitations", applies_to=["path:app/**"], context="Why now.", decision="Chosen.")
        accepted = adr.set_status(text, "accepted")
        self.assertEqual(accepted.replace("status: accepted", "status: proposed"), text)
        self.assertTrue(adr.parse(accepted, "docs/adr/0002-x.md")["binding"])


class Project(ReviewBase):
    """A project whose main branch has one accepted ADR covering app/**, with helpers to plan a ticket under it."""

    def setUp(self):
        super().setUp()
        self.put(self.project, {"docs/adr/0001-use-python.md": PYTHON_ADR, "docs/adr/README.md": "# Decisions\n"})
        self.commit_main()
        adr._LISTINGS.clear()

    def ready(self, tier="Gold", plan=PLAN_ADR):
        super().ready(tier, plan)

    def spec_ready(self):
        info = json.loads(self.cell_cmd("open", TICKET))
        self.put(Path(info["workdir"]), {f"specs/slices/{SPEC_NAME}": SPEC})
        self.put(self.cellroot, {"intent.md": INTENT})
        self.cell_cmd("finalize", TICKET, "--spec", f"specs/slices/{SPEC_NAME}")

    def cell_run(self, *argv, env=None):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, env or {}), redirect_stdout(out), redirect_stderr(err):
            code = cell_script.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def check(self, plan):
        self.put(self.cellroot, {"plan.md": plan})
        return self.cell_run("check-plan", TICKET)

    def main_adr(self, name, text):
        self.put(self.project, {f"docs/adr/{name}": text})
        self.commit_main()
        adr._LISTINGS.clear()

    def run_cmd(self, *argv, env=None):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, env or {}), redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def next(self, *extra):
        code, out, err = self.run_cmd("next", TICKET, *extra)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def decide(self):
        code, out, err = self.run_cmd("decide", "--json", TICKET)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def draft(self, title="Store invitations in SQLite", applies=("path:app/**",)):
        code, out, err = self.cell_run("adr-draft", TICKET, "--title", title, *[arg for item in applies for arg in ("--applies-to", item)])
        self.assertEqual(code, 0, err + out)
        drafted = json.loads(out)
        path = Path(drafted["path"])
        text = path.read_text()
        for comment in ("<!-- What needs deciding, and why now. Two or three sentences. -->", "<!-- One line per option, the chosen one included. -->",
                        "<!-- Chosen option, and why it was chosen over the others. -->", "<!-- Good, because ... / Bad, because ... -->"):
            text = text.replace(comment, "Filled in by the contract engineer.")
        path.write_text(text)
        return drafted

    def cell_json(self):
        return json.loads((self.cellroot / "cell.json").read_text())


class CheckPlanTest(Project):
    def test_a_plan_naming_the_adr_its_files_fall_under_passes_and_records_what_it_was_made_under(self):
        self.spec_ready()
        code, out, err = self.check(PLAN_ADR)
        self.assertEqual(code, 0, err + out)
        planned = self.cell_json()["adrs"]
        self.assertEqual((planned["named"], planned["applied"]), (["ADR-0001"], ["ADR-0001"]))
        self.assertEqual([item["id"] for item in planned["planned_under"]], ["ADR-0000", "ADR-0001"], "the test project's baseline, then its own")
        self.assertEqual(planned["planned_under"][1]["digest"], adr.digest(PYTHON_ADR))
        self.assertEqual(planned["main_commit"], git(self.project, "rev-parse", "HEAD").stdout.strip())
        self.assertEqual((self.cellroot / "adrs" / "ADR-0001.md").read_text(), PYTHON_ADR, "the text in force is kept in the cell")

    def test_refusals(self):
        self.main_adr("0002-old-orm.md", adr_text("Use the old ORM", status="superseded by ADR-0001"))
        self.main_adr("0003-maybe.md", adr_text("Maybe use Rust", status="proposed"))
        self.spec_ready()
        cases = {
            "fall under ADR-0001 (Write the service in Python) by its path globs, but 'ADRs' does not name it": PLAN,
            "'ADRs' names ADR-0042, which does not exist in docs/adr": PLAN_ADR.replace("ADR-0001", "ADR-0001, ADR-0042"),
            "'ADRs' names ADR-0002, which is superseded by ADR-0001, not accepted": PLAN_ADR.replace("ADR-0001", "ADR-0001, ADR-0002"),
            "'ADRs' names ADR-0003, which is proposed, not accepted": PLAN_ADR.replace("ADR-0001", "ADR-0001, ADR-0003"),
            "'ADRs' lists ADR IDs such as ADR-0007": PLAN_ADR.replace("ADR-0001", "ADR-0001, the python one"),
            "missing header line '- **ADRs:** ...'": PLAN.replace("- **ADRs:** None.\n", ""),
            "the plan's tasks change ADR files (docs/adr/0001-use-python.md)": PLAN_ADR.replace("| `README.md` | modify | T05 |",
                                                                                             "| `README.md` | modify | T05 |\n| `docs/adr/0001-use-python.md` | modify | T05 |"),
        }
        for expected, plan in cases.items():
            with self.subTest(expected=expected):
                code, out, _ = self.check(plan)
                self.assertEqual(code, 1, out)
                self.assertIn(expected, out)
                self.assertEqual(self.cell_json()["stage"], "spec-ready")

    def test_a_branch_that_changes_an_adr_on_main_is_refused(self):
        self.spec_ready()
        self.put(self.work, {"docs/adr/0001-use-python.md": PYTHON_ADR.replace("Plain text.", "Edited by a ticket.")})
        code, out, _ = self.check(PLAN_ADR)
        self.assertEqual(code, 1)
        self.assertIn("docs/adr/0001-use-python.md: this ticket's branch changes it; only people change an ADR", out)

    def test_a_malformed_adr_on_main_stops_planning_for_an_engineer(self):
        self.main_adr("0002-broken.md", "---\nstatus: acepted\n---\n\n# Broken\n")
        self.spec_ready()
        step = self.next()
        self.assertEqual((step["action"], step["needs"]), ("stop", "adr-fix"))
        self.assertIn("docs/adr/0002-broken.md: status 'acepted' is not one of", step["reason"])
        waiting = self.decide()["tickets"][0]
        self.assertEqual(waiting["state"], "adr-fix")
        self.assertEqual([choice["key"] for choice in waiting["options"]], ["run", "abandon"])
        code, out, _ = self.check(PLAN_ADR)
        self.assertEqual(code, 1)
        self.assertIn("an ADR on the main branch cannot be read", out)


class ProposalTest(Project):
    def test_a_ticket_proposes_an_adr_numbered_past_every_other_and_check_plan_commits_it(self):
        self.spec_ready()
        drafted = self.draft()
        self.assertEqual((drafted["id"], drafted["file"]), ("ADR-0002", "docs/adr/0002-store-invitations-in-sqlite.md"))
        code, out, _ = self.check(PLAN_ADR)
        self.assertEqual(code, 1)
        self.assertIn("this ticket proposes ADR-0002 (docs/adr/0002-store-invitations-in-sqlite.md), but 'ADRs' does not list it", out)
        code, out, err = self.check(PLAN_ADR.replace("ADR-0001", "ADR-0001, ADR-0002"))
        self.assertEqual(code, 0, err + out)
        self.assertEqual(json.loads(out[out.index("{"):])["adrs"]["proposed"], ["ADR-0002"])
        self.assertEqual(git(self.work, "status", "--porcelain").stdout.strip(), "", "the proposal is committed on the ticket's branch")
        shown = git(self.work, "show", "HEAD:docs/adr/0002-store-invitations-in-sqlite.md").stdout
        self.assertIn("status: proposed", shown)
        self.assertNotIn("docs/adr/0002", git(self.project, "ls-files").stdout, "nothing is written to the main checkout")

    def test_a_draft_with_template_comments_left_is_refused(self):
        self.spec_ready()
        code, out, err = self.cell_run("adr-draft", TICKET, "--title", "Store invitations in SQLite")
        self.assertEqual(code, 0, err)
        code, out, _ = self.check(PLAN_ADR.replace("ADR-0001", "ADR-0001, ADR-0002"))
        self.assertEqual(code, 1)
        self.assertIn("remove the template comment", out)

    def test_a_tickets_own_adr_written_as_accepted_is_refused(self):
        self.spec_ready()
        drafted = self.draft()
        path = Path(drafted["path"])
        path.write_text(path.read_text().replace("status: proposed", "status: accepted"))
        code, out, _ = self.check(PLAN_ADR.replace("ADR-0001", "ADR-0001, ADR-0002"))
        self.assertEqual(code, 1)
        self.assertIn("it says accepted, but no person accepted this text", out)

    def test_a_medium_risk_ticket_goes_on_with_its_proposal(self):
        self.spec_ready()
        self.draft()
        self.assertEqual(self.check(PLAN_ADR.replace("ADR-0001", "ADR-0001, ADR-0002"))[0], 0)
        self.audit_report()
        self.assertEqual(self.next()["action"], "build")
        self.ok("start", TICKET)

    def test_a_high_risk_ticket_waits_for_an_engineer_to_accept_its_proposal(self):
        self.spec_ready()
        self.draft()
        high = PLAN_ADR.replace("ADR-0001", "ADR-0001, ADR-0002").replace("**Risk tier:** Medium", "**Risk tier:** High")
        code, out, _ = self.check(high)
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out[out.index("{"):])["waits_for_acceptance"], ["ADR-0002"])
        self.audit_report()
        step = self.next()
        self.assertEqual((step["action"], step["needs"], step["adrs"]), ("stop", "adr-acceptance", ["ADR-0002"]))
        self.assertEqual(step["digest"]["needs_person"], run.NEEDS_TEXT["adr-acceptance"])
        self.assertIn("no engineer has accepted it yet", self.refused("start", TICKET))
        waiting = self.decide()["tickets"][0]
        self.assertEqual(waiting["state"], "adr-acceptance")
        self.assertEqual(waiting["options"][0]["route"], "adr accept LOCAL-001 ADR-0002")
        self.assertFalse(any(choice["recommended"] for choice in waiting["options"]), "accepting is never recommended by rule")
        self.assertIn(".factory/worktrees/LOCAL-001/repo/docs/adr/0002-store-invitations-in-sqlite.md", waiting["show_first"])
        # A person's act: refused unattended, and only for an ADR this plan proposes.
        code, _, err = self.cell_run("adr-accept", TICKET, "--adr", "ADR-0002", "--by", "Dana", env=UNATTENDED)
        self.assertEqual(code, 2)
        self.assertIn("Inside a supervised Factory execution nobody is here to decide", err)
        code, _, err = self.cell_run("adr-accept", TICKET, "--adr", "ADR-0001", "--by", "Dana")
        self.assertIn("ADR-0001 is not an ADR this ticket's plan proposes", err)
        code, out, err = self.cell_run("adr-accept", TICKET, "--adr", "ADR-0002", "--by", "Dana Smith")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["accepted"], ["ADR-0002"])
        shown = git(self.work, "show", "HEAD:docs/adr/0002-store-invitations-in-sqlite.md").stdout
        self.assertIn("status: accepted", shown)
        self.assertEqual(git(self.work, "log", "-1", "--format=%s").stdout.strip(), "adr(ADR-0002): accepted by Dana Smith [LOCAL-001]")
        self.assertEqual(self.cell_json()["adr_acceptances"][0]["by"], "Dana Smith")
        self.assertEqual(self.next()["action"], "build")
        started = self.ok("start", TICKET)
        self.assertEqual(sorted(item["id"] for item in started["adrs"]["apply"]), ["ADR-0001", "ADR-0002"])

    def test_a_tuning_ticket_never_proposes_or_touches_an_adr(self):
        self.put(self.project, {".factory/tickets/LOCAL-001.md": '---\nid: LOCAL-001\nstate: open\nlabels: ["factory-tuning"]\n---\n\n# Tune\n'})
        self.spec_ready()
        code, _, err = self.cell_run("adr-draft", TICKET, "--title", "Store invitations in SQLite")
        self.assertEqual(code, 2)
        self.assertIn("A factory-tuning ticket never proposes an ADR", err)
        self.put(self.work, {"docs/adr/0002-x.md": adr_text("Sneaked in", status="proposed")})
        code, out, _ = self.check(PLAN_ADR.replace("ADR-0001", "ADR-0001, ADR-0002"))
        self.assertEqual(code, 1)
        self.assertIn("a factory-tuning ticket never proposes, changes or supersedes an ADR", out)


class ConflictTest(Project):
    def conflict(self):
        self.spec_ready()
        code, out, err = self.cell_run("adr-conflict", TICKET, "--adr", "ADR-0001", "--reason", "The invitation worker must run inside the Go job runner.")
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def test_a_plan_that_cannot_comply_stops_for_an_engineer(self):
        self.assertEqual(self.conflict()["status"], "STOPPED")
        step = self.next()
        self.assertEqual((step["action"], step["needs"], step["adr"]), ("stop", "adr-decision", "ADR-0001"))
        self.assertIn("The invitation worker must run inside the Go job runner.", step["reason"])
        code, out, _ = self.check(PLAN_ADR)
        self.assertEqual(code, 1)
        self.assertIn("the plan cannot follow ADR-0001, as recorded", out)
        waiting = self.decide()["tickets"][0]
        self.assertEqual(waiting["state"], "adr-conflict")
        self.assertEqual([choice["key"] for choice in waiting["options"]], ["exception", "abandon"], "no re-plan while the ADR is unchanged")
        self.assertEqual(waiting["options"][0]["route"], 'adr except LOCAL-001 ADR-0001 "<why>"')
        self.assertTrue(waiting["options"][0]["needs_reason"])
        self.assertEqual(waiting["recommendation"], {"basis": "judgement"})
        self.assertIn("docs/adr/0001-use-python.md", waiting["show_first"])
        explained = json.loads(self.run_cmd("explain", TICKET, "--json")[1])
        self.assertEqual(explained["adrs"]["conflict"]["adr"], "ADR-0001")

    def test_conflict_needs_a_binding_adr_and_a_reason(self):
        self.spec_ready()
        for argv, expected in ((("--adr", "ADR-0042", "--reason", "x" * 30), "ADR-0042 does not exist"),
                               (("--adr", "ADR-0001", "--reason", "too short"), "--reason must say"),
                               (("--adr", "adr 1", "--reason", "x" * 30), "is not an ADR ID")):
            with self.subTest(argv=argv):
                code, _, err = self.cell_run("adr-conflict", TICKET, *argv)
                self.assertEqual(code, 2)
                self.assertIn(expected, err)

    def test_an_exception_is_a_persons_act_and_lets_the_plan_go_on(self):
        self.conflict()
        argv = ("adr-exception", TICKET, "--adr", "ADR-0001", "--by", "Dana Smith", "--reason", "The job runner is Go; this one worker may be Go.")
        code, _, err = self.cell_run(*argv, env=UNATTENDED)
        self.assertEqual(code, 2)
        self.assertIn("Inside a supervised Factory execution nobody is here to decide", err)
        self.assertNotIn("adr_exceptions", self.cell_json())
        code, out, err = self.cell_run(*argv)
        self.assertEqual(code, 0, err)
        self.assertTrue(json.loads(out)["conflict_cleared"])
        self.assertEqual(self.next()["action"], "plan")
        code, out, err = self.check(PLAN)  # the touch map falls under ADR-0001's globs; the exception carries it
        self.assertEqual(code, 0, err + out)
        self.audit_report()
        started = self.ok("start", TICKET)
        self.assertEqual(started["adrs"]["exceptions"][0]["reason"], "The job runner is Go; this one worker may be Go.")
        code, _, err = self.cell_run(*argv)
        self.assertIn("is spec-ready", err, "an exception is recorded before the ticket is planned")

    def test_re_planning_needs_the_adr_superseded_first(self):
        self.conflict()
        code, _, err = self.cell_run("replan", TICKET, "--reason", "The engineer superseded the Python rule.")
        self.assertEqual(code, 2)
        self.assertIn("ADR-0001 is unchanged on the main branch and still accepted", err)
        self.main_adr("0001-use-python.md", PYTHON_ADR.replace("status: accepted", "status: superseded by ADR-0002"))
        self.main_adr("0002-python-or-go.md", adr_text("Write services in Python or Go", applies=["path:app/**"]))
        waiting = self.decide()["tickets"][0]
        self.assertEqual([choice["key"] for choice in waiting["options"]], ["exception", "replan", "abandon"])
        self.assertEqual(waiting["options"][1]["route"], 'replan LOCAL-001 "<why>"')
        code, out, err = self.cell_run("replan", TICKET, "--reason", "The engineer superseded the Python rule.")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["adr_now"], "now superseded")
        self.assertNotIn("adr_conflict", self.cell_json())
        self.assertEqual(self.next()["action"], "plan")
        code, out, _ = self.check(PLAN_ADR)
        self.assertIn("'ADRs' names ADR-0001, which is superseded by ADR-0002", out)
        self.assertEqual(self.check(PLAN_ADR.replace("ADR-0001", "ADR-0002"))[0], 0)


class BuildTest(Project):
    def test_no_task_changes_an_adr_and_no_override_allows_it(self):
        self.ready()
        self.ok("start", TICKET)
        self.put(self.work, {"tests/test_invite.py": "import unittest\n", "docs/adr/0001-use-python.md": "changed"})
        out = self.refused("red", TICKET, "T01", "--allow-extra", "it seemed needed")
        self.assertIn("changes architecture decision records (docs/adr/0001-use-python.md)", out)
        self.assertIn("no override allows it", out)

    def test_a_revision_task_may_not_name_an_adr_file(self):
        self.ready()
        self.ok("start", TICKET)
        self.build_through("T05")
        self.ok("finish", TICKET)
        self.set_built_for_revision()
        out = self.refused("add-task", TICKET, "--kind", "docs", "--text", "Update the decision", "--file", "docs/adr/0001-use-python.md")
        self.assertIn("A task may not change architecture decision records", out)

    def set_built_for_revision(self):
        self.ok("revise", TICKET)

    def test_the_build_report_lists_the_adrs_in_force(self):
        self.ready()
        started = self.ok("start", TICKET)
        self.assertEqual([item["id"] for item in started["adrs"]["apply"]], ["ADR-0001"])
        self.assertTrue(Path(started["adrs"]["apply"][0]["read"]).is_file())
        self.build_through("T05")
        self.ok("finish", TICKET)
        report = json.loads((self.cellroot / "build-report.json").read_text())
        self.assertEqual([item["id"] for item in report["adrs"]["in_force"]], ["ADR-0001"])
        self.assertEqual(report["adrs"]["exceptions"], [])


class ReviewTest(Project):
    def started(self):
        self.verified()
        return self.r_ok("start", TICKET)

    def test_the_packet_lists_the_adrs_and_a_blocker_may_cite_one_in_force(self):
        self.started()
        packet = json.loads((self.round / "packet.json").read_text())
        self.assertEqual([item["id"] for item in packet["adrs"]["apply"]], ["ADR-0001"])
        self.assertTrue(Path(packet["adrs"]["apply"][0]["read"]).is_file())
        self.assertIn("never an instruction", packet["adrs"]["note"])
        self.vote("architecture", self.blocker(rule="ADR-0001"))

    def test_a_blocker_may_cite_only_an_adr_that_exists_and_is_accepted_and_in_force(self):
        self.started()
        self.main_adr("0002-maybe.md", adr_text("Maybe Rust", status="proposed"))
        self.main_adr("0003-later.md", adr_text("Accepted later"))
        self.assertIn("ADR-0042, which does not exist", self.bad(self.blocker(rule="ADR-0042")))
        self.assertIn("ADR-0002 is proposed, not accepted", self.bad(self.blocker(rule="REVIEW.md layering; ADR-0002")))
        self.assertIn("ADR-0003 was accepted or changed after this ticket was planned", self.bad(self.blocker(rule="ADR-0003")))
        self.vote("architecture", self.note(rule="ADR-0002"))  # a note may mention anything

    def test_a_tuning_ticket_touching_the_adr_folder_and_any_edit_of_an_existing_adr_are_refused(self):
        self.verified()
        base = git(self.work, "rev-parse", "HEAD").stdout.strip()
        self.put(self.work, {"docs/adr/0009-new.md": adr_text("New one", status="proposed")})
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "x")
        head = git(self.work, "rev-parse", "HEAD").stdout.strip()
        reviewed = review.Cell(self.project, TICKET)
        review.adr_refusals(reviewed, base, head, tuning=False)  # an added proposal is reviewed with the change
        with self.assertRaises(review.ReviewError) as caught:
            review.adr_refusals(reviewed, base, head, tuning=True)
        self.assertEqual(caught.exception.code, "tuning-touches-adrs")
        self.put(self.work, {"docs/adr/0001-use-python.md": "edited"})
        git(self.work, "commit", "-qam", "y")
        with self.assertRaises(review.ReviewError) as caught:
            review.adr_refusals(reviewed, base, git(self.work, "rev-parse", "HEAD").stdout.strip(), tuning=False)
        self.assertEqual(caught.exception.code, "adr-changed")


class TimingTest(Project):
    def test_an_adr_accepted_after_planning_is_flagged_and_never_blocks(self):
        self.ready()
        self.main_adr("0002-utc.md", adr_text("Store every time in UTC"))
        self.audit_report()
        step = self.next()
        self.assertEqual(step["action"], "build")
        self.assertIn("ADR-0002 accepted after planning", step["digest"]["adrs"])
        code, out, _ = self.run_cmd("status")
        rows = json.loads(out)["tickets"]
        self.assertIn("ADR-0002 accepted after planning", rows[0]["adrs"])
        explained = json.loads(self.run_cmd("explain", TICKET, "--json")[1])
        self.assertEqual(explained["adrs"]["changed_since_plan"][0], {"adr": "ADR-0002", "change": "accepted after planning", "title": "Store every time in UTC"})
        self.ok("start", TICKET)
        self.assertEqual([item["id"] for item in self.cell_json()["adrs"]["planned_under"]], ["ADR-0000", "ADR-0001"], "nothing is re-planned")

    def test_a_changed_adr_is_flagged_as_changed(self):
        self.ready()
        self.main_adr("0001-use-python.md", PYTHON_ADR.replace("Plain text.", "Python 3.12 or later."))
        self.assertIn("ADR-0001 changed after planning", self.next()["digest"]["adrs"])

    def test_nothing_is_flagged_when_nothing_changed(self):
        self.ready()
        self.assertNotIn("adrs", self.next()["digest"])


class CommandsTest(Project):
    def test_adr_list_reads_only(self):
        (self.project / ".factory").mkdir(exist_ok=True)
        self.main_adr("0002-broken.md", "---\nstatus: maybe\n---\n\n# Broken\n")
        self.put(self.project, {"docs/adr/0003-draft.md": adr_text("A draft not committed", status="proposed")})
        before = git(self.project, "status", "--porcelain").stdout
        code, out, err = self.run_cmd("adr", "list")
        self.assertEqual(code, 0, err)
        listed = json.loads(out)
        self.assertEqual([item["id"] for item in listed["adrs"]], ["ADR-0000", "ADR-0001", "ADR-0002", "ADR-0003"])
        self.assertEqual(listed["accepted"], 2)
        self.assertEqual(listed["adrs"][1]["applies_to"], ["path:app/**"])
        self.assertIn("status 'maybe' is not one of", " ".join(listed["problems"]))
        self.assertEqual(listed["uncommitted"], ["docs/adr/0003-draft.md"])
        self.assertFalse(listed["adrs"][3]["committed"])
        self.assertEqual(git(self.project, "status", "--porcelain").stdout, before)

    def test_adr_new_writes_a_proposed_file_and_commits_nothing(self):
        self.spec_ready()
        self.draft()  # ADR-0002 is taken on the ticket's branch: the next one is 0003
        argv = ("adr", "new", "--title", "Use PostgreSQL for invitations", "--context", "Invitations need durable storage.",
                "--decision", "PostgreSQL, because the team runs it already.", "--option", "PostgreSQL", "--option", "SQLite",
                "--consequence", "Good, because backups exist.", "--applies-to", "topic:database")
        code, _, err = self.run_cmd(*argv, env=UNATTENDED)
        self.assertEqual(code, 1)
        self.assertIn("refused:", err)
        code, out, err = self.run_cmd(*argv)
        self.assertEqual(code, 0, err)
        written = json.loads(out)
        self.assertEqual((written["id"], written["file"], written["committed"]), ("ADR-0003", "docs/adr/0003-use-postgresql-for-invitations.md", False))
        record = adr.parse((self.project / written["file"]).read_text(), written["file"])
        self.assertEqual((record["status"], record["applies_to"], record["problems"]), ("proposed", ["topic:database"], []))
        self.assertIn("?? docs/adr/0003-use-postgresql-for-invitations.md", git(self.project, "status", "--porcelain").stdout)
        code, _, err = self.run_cmd("adr", "new", "--title", "Short", "--context", "x", "--decision", "y")
        self.assertEqual(code, 1)
        code, _, err = self.run_cmd("adr", "new", "--title", "Use a bad applies-to", "--context", "Long enough context.", "--decision", "Long enough decision.",
                                    "--applies-to", "app:website")
        self.assertIn("the app type must be one of", err)


class AuditNoteTest(Project):
    def audit(self):
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            audit.main(["--project", str(self.project), "run", "--json", "--no-run"])
        return json.loads(out.getvalue())

    def test_a_note_naming_the_missing_required_topics_and_no_score_change(self):
        with_one = self.audit()
        self.assertEqual(with_one["notes"], [])
        self.main_adr("0000-test-project-baseline.md", adr_baseline_fixture.TEXT.replace("  - topic:storage\n", "").replace("  - topic:testing\n", ""))
        without = self.audit()
        self.assertIn("Required topics with no accepted architecture decision (ADR) on the main branch in docs/adr: storage, testing.", without["notes"][0])
        self.assertIn("No ticket is planned until each has one", without["notes"][0])
        self.assertEqual((without["readiness_score"], without["blockers"]), (with_one["readiness_score"], with_one["blockers"]))


class InstructionsTest(unittest.TestCase):
    def test_observe_and_review_say_the_factory_never_changes_an_adr(self):
        for name in ("skills/observe/SKILL.md", "skills/review/SKILL.md", "skills/review/references/architecture.md"):
            with self.subTest(name=name):
                self.assertIn("ADR", (ROOT / name).read_text())
        self.assertIn("never accept, change or supersede an adr", (ROOT / "skills/observe/SKILL.md").read_text().lower())

    def test_the_config_template_lists_the_adr_folder(self):
        self.assertEqual(json.loads((ROOT / "templates/config.json").read_text())["adr"],
                         {"dir": "docs/adr", "landing": "pull-request", "required_topics": ["language", "framework", "storage", "testing", "deployment", "coding-standards"]})
        self.assertEqual(list(adr.REQUIRED_TOPICS), json.loads((ROOT / "templates/config.json").read_text())["adr"]["required_topics"])


if __name__ == "__main__":
    unittest.main()
