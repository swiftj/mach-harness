"""The ADR baseline (decided 2026-11-18): no ticket is planned or built until every required topic has an accepted ADR
on the main branch, and `run.py adr baseline` drafts the missing ones from the repository.

Covered here: the required topics (defaults, an extended list, an empty list, a malformed setting); what covers a topic
(an accepted, committed ADR naming topic:<name>, including one that says the topic does not apply) and what does not
(proposed, malformed, `all`, a file only in the working tree); the stop before planning in `next`, its text in the
digest, status, explain and decide; the refusals of `cell.py claim plan` and `check-plan`; grooming, planned cells and
factory-tuning tickets left alone and repo-hardening tickets held; the evidence on small Python, Node and empty
repositories; the record, and a second run that redoes and overwrites nothing; `adr new --baseline`; `adr accept`
and its refusals, unattended included; `adr list`'s required topics; the audit and doctor notes.
"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
for folder in ("intent", "run", "audit", "ticket"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import adr  # noqa: E402
import adr_baseline_fixture  # noqa: E402
import baseline  # noqa: E402
import doctor  # noqa: E402
import run  # noqa: E402
from test_adr import PLAN_ADR, UNATTENDED, Project, adr_text  # noqa: E402
from test_build import git  # noqa: E402
from test_review import TICKET  # noqa: E402

DEFAULTS = ["language", "framework", "storage", "testing", "deployment", "coding-standards"]


class Uncovered(Project):
    """A project whose main branch has no baseline: the test projects' covered one is removed and committed."""

    def setUp(self):
        super().setUp()
        (self.project / adr_baseline_fixture.FILE).unlink()
        self.commit_main()
        (self.project / ".factory").mkdir(exist_ok=True)
        adr._LISTINGS.clear()

    def config(self, **adr_section):
        self.put(self.project, {".factory/config.json": json.dumps({"adr": adr_section})})

    def label(self, *labels):
        self.put(self.project, {f".factory/tickets/{TICKET}.md": f"---\nid: {TICKET}\nstate: open\nlabels: [{', '.join(labels)}]\n---\n\n# A ticket\n"})

    def cover(self, topics=DEFAULTS, name="0005-baseline.md", status="accepted", extra=()):
        self.main_adr(name, adr_text("The project's basic technical decisions", status=status, applies=[f"topic:{topic}" for topic in topics] + list(extra)))

    def json_cmd(self, *argv, env=None, code=0):
        got, out, err = self.run_cmd(*argv, env=env)
        self.assertEqual(got, code, err + out)
        return json.loads(out) if code == 0 else err


class RequiredTopicsTest(unittest.TestCase):
    def test_the_defaults_and_their_one_line_descriptions(self):
        self.assertEqual(adr.required_topics({}), (DEFAULTS, []))
        self.assertEqual(list(adr.REQUIRED_TOPICS), DEFAULTS)
        for topic in DEFAULTS:
            self.assertTrue(adr.describe_topic(topic).startswith(adr.topic_label(topic).capitalize()), topic)
        self.assertEqual(adr.describe_topic("security"), adr.ADDED_TOPIC)

    def test_a_team_extends_the_list_and_an_empty_list_requires_nothing(self):
        self.assertEqual(adr.required_topics({"adr": {"required_topics": DEFAULTS + ["security"]}}), (DEFAULTS + ["security"], []))
        self.assertEqual(adr.required_topics({"adr": {"required_topics": []}}), ([], []))

    def test_a_malformed_setting_is_reported_and_never_requires_less(self):
        topics, problems = adr.required_topics({"adr": {"required_topics": "language"}})
        self.assertEqual(topics, DEFAULTS)
        self.assertIn("is not a list", problems[0])
        topics, problems = adr.required_topics({"adr": {"required_topics": ["language", "Data Store"]}})
        self.assertEqual(topics, ["language", "Data Store"], "a bad name stays required: no ADR can cover it")
        self.assertIn("'Data Store', which is not a topic", problems[0])


class CoverageTest(Uncovered):
    def test_nothing_covers_a_project_without_a_baseline(self):
        self.assertEqual(adr.coverage(self.project, {})["missing"], DEFAULTS)

    def test_an_accepted_committed_adr_naming_the_topics_covers_them(self):
        self.cover(DEFAULTS[:3])
        found = adr.coverage(self.project, {})
        self.assertEqual(found["missing"], DEFAULTS[3:])
        self.assertEqual(found["topics"][0]["covered_by"], ["ADR-0005"])

    def test_an_adr_that_says_a_topic_does_not_apply_covers_it(self):
        self.cover(DEFAULTS[:2] + DEFAULTS[3:])
        self.main_adr("0006-no-storage.md", adr_text("This library stores no data", applies=["topic:storage"]))
        self.assertEqual(adr.coverage(self.project, {})["missing"], [])

    def test_what_does_not_cover(self):
        self.main_adr("0005-proposed.md", adr_text("Python and unittest", status="proposed", applies=["topic:language"]))
        self.main_adr("0006-broken.md", "---\nstatus: accepted\napplies-to: [topic:testing\n---\n\n# Broken\n")
        self.main_adr("0007-everything.md", adr_text("Applies to everything", applies=["all"]))
        self.put(self.project, {"docs/adr/0008-local.md": adr_text("Only on this disk", applies=["topic:storage"])})
        self.assertEqual(adr.coverage(self.project, {})["missing"], DEFAULTS)

    def test_an_extended_list_needs_its_own_topic_and_an_empty_list_needs_nothing(self):
        self.cover()
        self.assertEqual(adr.coverage(self.project, {"adr": {"required_topics": DEFAULTS + ["security"]}})["missing"], ["security"])
        self.assertEqual(adr.coverage(self.project, {"adr": {"required_topics": []}})["missing"], [])
        self.assertIsNone(adr.baseline_stop(self.project, {"adr": {"required_topics": []}}))

    def test_factory_tuning_tickets_are_never_held(self):
        self.assertIsNone(adr.baseline_stop(self.project, {}, ["factory-tuning"]))
        self.assertIsNotNone(adr.baseline_stop(self.project, {}, ["repo-hardening"]))


class StopTest(Uncovered):
    def test_spec_ready_stops_before_planning_with_the_missing_topics_and_the_command(self):
        self.spec_ready()
        step = self.next()
        self.assertEqual((step["action"], step["needs"], step["missing_topics"]), ("stop", "adr-baseline", DEFAULTS))
        self.assertIn("Missing: language (language and runtime); framework (framework and application type)", step["reason"])
        self.assertIn("adr baseline", step["command"])
        self.assertEqual(step["digest"]["needs_person"], run.NEEDS_TEXT["adr-baseline"])
        status = self.json_cmd("status")
        self.assertEqual(status["tickets"][0]["needs"], "adr-baseline")
        self.assertIn("missing: language, framework, storage, testing, deployment, coding-standards", status["digest"]["adr_baseline"])
        explained = self.json_cmd("explain", TICKET, "--json")
        self.assertEqual(explained["adrs"]["baseline_missing"], DEFAULTS)
        self.assertIn("required topics with no accepted ADR", self.run_cmd("explain", TICKET)[1])

    def test_the_walkthrough_offers_what_the_scripts_accept_and_recommends_nothing(self):
        self.spec_ready()
        waiting = self.decide()["tickets"][0]
        self.assertEqual(waiting["state"], "adr-baseline")
        self.assertEqual([(choice["key"], choice["route"]) for choice in waiting["options"]],
                         [("draft", "adr baseline"), ("new", 'adr new "<decision>"'), ("run", TICKET)])
        self.assertEqual(waiting["recommendation"], {"basis": "judgement"})
        self.assertFalse(any(choice["recommended"] for choice in waiting["options"]))
        self.assertEqual(waiting["situation"]["missing_topics"][0], {"topic": "language", "description": adr.REQUIRED_TOPICS["language"]})

    def test_claiming_the_plan_step_and_check_plan_are_refused(self):
        self.spec_ready()
        code, out, err = self.cell_run("claim", TICKET, "plan")
        self.assertEqual(code, 2)
        self.assertIn("not all written down as accepted ADRs", err + out)
        self.assertIn("Do not start the contract engineer", err + out)
        self.assertFalse((self.cellroot / "claim.json").exists())
        code, out, err = self.check(PLAN_ADR)
        self.assertEqual(code, 2)
        self.assertIn("Missing: language", err + out)
        self.assertEqual(self.cell_json()["stage"], "spec-ready")

    def test_once_covered_the_ticket_is_planned(self):
        self.spec_ready()
        self.cover()
        self.assertEqual(self.next()["action"], "plan")
        code, out, err = self.cell_run("claim", TICKET, "plan")
        self.assertEqual(code, 0, err)
        code, out, err = self.check(PLAN_ADR)
        self.assertEqual(code, 0, err + out)

    def test_grooming_is_not_held(self):
        self.assertEqual(self.next()["action"], "groom")

    def test_a_planned_cell_is_not_sent_back(self):
        self.cover()
        self.ready()
        (self.project / "docs/adr/0005-baseline.md").unlink()
        self.commit_main()
        adr._LISTINGS.clear()
        self.audit_report()
        step = self.next()
        self.assertEqual((step["action"], step["stage"]), ("build", "planned"))

    def test_factory_tuning_is_planned_and_repo_hardening_is_held(self):
        self.spec_ready()
        self.label("factory-tuning")
        self.assertEqual(self.next()["action"], "plan")
        self.label("repo-hardening")
        self.assertEqual(self.next()["needs"], "adr-baseline")

    def test_an_extended_list_holds_until_its_topic_is_covered_and_an_empty_list_holds_nothing(self):
        self.cover()
        self.spec_ready()
        self.config(required_topics=DEFAULTS + ["security"])
        self.assertEqual(self.next()["missing_topics"], ["security"])
        self.config(required_topics=[])
        self.assertEqual(self.next()["action"], "plan")

    def test_a_malformed_adr_never_covers_and_is_reported_first(self):
        self.spec_ready()
        self.main_adr("0005-broken.md", "---\nstatus: accepted\napplies-to: topic:Language\n---\n\n# Broken\n")
        self.assertEqual(self.next()["needs"], "adr-fix")
        self.assertIn("language", adr.coverage(self.project, {})["missing"])


class Repository(unittest.TestCase):
    """A small repository on disk, committed, with a .factory folder."""

    def make(self, files, commit=True):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name).resolve() / "project"
        (self.project / ".factory").mkdir(parents=True)
        for name, text in files.items():
            path = self.project / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        git(self.project, "init", "-q", "-b", "main")
        (self.project / ".gitignore").write_text(".factory/\n")
        if commit:
            git(self.project, "add", "-A")
            git(self.project, "commit", "-q", "-m", "first")
        adr._LISTINGS.clear()

    def run_cmd(self, *argv, env=None):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, env or {}), redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def baseline(self):
        code, out, err = self.run_cmd("adr", "baseline")
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def evidence(self, result, topic):
        return next(item for item in result["to_draft"] if item["topic"] == topic)["evidence"]

    def found(self, result, topic):
        return [(item["file"], item["found"]) for item in self.evidence(result, topic)]


PYTHON_REPO = {
    "pyproject.toml": "[project]\nname = 'shop'\nrequires-python = '>=3.11'\ndependencies = ['fastapi>=0.110', 'sqlalchemy==2.0.30', 'psycopg[binary]>=3.1']\n"
                      "[project.optional-dependencies]\ndev = ['pytest>=8', 'ruff']\n[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\naddopts = '-q'\n",
    "uv.lock": "version = 1\n",
    ".python-version": "3.12\n",
    "shop/__init__.py": "", "shop/api.py": "x = 1\n", "shop/models.py": "y = 2\n",
    "tests/test_api.py": "def test_a():\n    pass\n",
    "migrations/env.py": "", "migrations/versions/0001_first.py": "",
    "Dockerfile": "FROM python:3.12-slim\nCOPY . /app\n",
    "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n  app:\n    build: .\n",
    ".github/workflows/ci.yml": "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
    ".pre-commit-config.yaml": "repos: []\n",
}
NODE_REPO = {
    "package.json": json.dumps({"name": "web", "engines": {"node": ">=20"}, "scripts": {"test": "API_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 vitest run", "lint": "eslint ."},
                                "dependencies": {"next": "14.2.3", "react": "18.3.1", "@prisma/client": "5.14.0"},
                                "devDependencies": {"vitest": "1.6.0", "eslint": "8.57.0", "prettier": "3.2.5", "typescript": "5.4.5"}}),
    "package-lock.json": "{}\n", ".nvmrc": "20\n",
    "src/app/page.tsx": "export default 1\n", "src/lib/db.ts": "export {}\n", "src/lib/db.test.ts": "test('x', () => {})\n",
    "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
    "tsconfig.json": '{"compilerOptions": {"strict": true}}\n', ".eslintrc.json": "{}\n", "vercel.json": "{}\n",
}


class EvidenceTest(Repository):
    def test_a_python_repository(self):
        self.make(PYTHON_REPO)
        result = self.baseline()
        self.assertEqual([item["topic"] for item in result["to_draft"]], DEFAULTS)
        language = self.found(result, "language")
        self.assertIn((None, "languages by file count"), language)
        self.assertIn((".python-version", "runtime version file"), language)
        self.assertIn(("pyproject.toml", "manifest"), language)
        self.assertIn(("uv.lock", "lockfile: dependency versions are pinned"), language)
        self.assertIn("requires-python = '>=3.11'", next(item["excerpt"] for item in self.evidence(result, "language") if item["file"] == "pyproject.toml"))
        self.assertIn(("pyproject.toml", "framework named in dependencies: FastAPI"), self.found(result, "framework"))
        storage = self.found(result, "storage")
        self.assertIn(("pyproject.toml", "storage named in dependencies: PostgreSQL"), storage)
        self.assertIn(("pyproject.toml", "storage named in dependencies: SQLAlchemy"), storage)
        self.assertIn(("migrations", "migration or schema folder (2 files)"), storage)
        self.assertIn(("docker-compose.yml", "data service in the compose file"), storage)
        testing = self.found(result, "testing")
        self.assertIn(("pyproject.toml", "test tool named in dependencies: pytest"), testing)
        self.assertIn(("pyproject.toml", "test settings: pytest settings"), testing)
        self.assertIn((None, "test files (1)"), testing)
        deployment = self.found(result, "deployment")
        self.assertIn(("Dockerfile", "container image"), deployment)
        self.assertIn((".github/workflows/ci.yml", "CI workflow"), deployment)
        standards = self.found(result, "coding-standards")
        self.assertIn(("pyproject.toml", "standards tool named in dependencies: Ruff"), standards)
        self.assertIn(("pyproject.toml", "standards settings: ruff settings"), standards)
        self.assertIn((".pre-commit-config.yaml", "standards configuration"), standards)
        self.assertFalse(result["record_tracked"])

    def test_a_node_repository_and_redaction(self):
        self.make(NODE_REPO)
        result = self.baseline()
        self.assertIn(("package.json", "framework named in dependencies: Next.js"), self.found(result, "framework"))
        self.assertIn(("package.json", "storage named in dependencies: Prisma"), self.found(result, "storage"))
        self.assertIn(("prisma/schema.prisma", "storage configuration"), self.found(result, "storage"))
        self.assertIn(("package.json", "test tool named in dependencies: Vitest"), self.found(result, "testing"))
        self.assertIn(("package.json", "package script 'test'"), self.found(result, "testing"))
        self.assertIn(("vercel.json", "deployment or CI file"), self.found(result, "deployment"))
        self.assertIn(("tsconfig.json", "standards configuration"), self.found(result, "coding-standards"))
        self.assertIn(("package.json", "standards tool named in dependencies: ESLint"), self.found(result, "coding-standards"))
        self.assertIn('"node":', next(item["excerpt"] for item in self.evidence(result, "language") if item["file"] == "package.json"))
        text = json.dumps(result)
        self.assertNotIn("ghp_abcdefghijklmnopqrstuvwxyz0123", text)
        self.assertNotIn("ghp_abcdefghijklmnopqrstuvwxyz0123", (self.project / baseline.RECORD).read_text())

    def test_an_empty_repository_has_no_evidence_and_nothing_is_guessed(self):
        self.make({}, commit=False)
        result = self.baseline()
        self.assertEqual([(item["topic"], item["evidence"], item["no_evidence"]) for item in result["to_draft"]], [(topic, [], True) for topic in DEFAULTS])
        self.make({"README.md": "# New\n"})
        result = self.baseline()
        self.assertTrue(all(item["no_evidence"] for item in result["to_draft"]))

    def test_only_committed_files_are_read_and_output_is_bounded(self):
        self.make({"app.py": "x = 1\n"})
        files = {f"pkg/m{number}/Dockerfile": "FROM python:3\n" for number in range(40)}
        for name, text in {**files, "package.json": "{}"}.items():
            (self.project / name).parent.mkdir(parents=True, exist_ok=True)
            (self.project / name).write_text(text)
        result = self.baseline()
        self.assertEqual(self.evidence(result, "deployment"), [], "the working tree is never read")
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "more")
        (self.project / baseline.RECORD).unlink()
        self.assertEqual(len(self.evidence(self.baseline(), "deployment")), baseline.MAX_ITEMS)


class RecordTest(Repository):
    def setUp(self):
        self.make(PYTHON_REPO)

    def draft(self, topic, *extra):
        code, out, err = self.run_cmd("adr", "new", "--baseline", topic, "--title", f"Decide {topic} as the repository does",
                                      "--context", "Read from the repository.", "--decision", "What the repository already does.", *extra)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def test_the_record_is_written_once_and_a_second_run_redoes_nothing(self):
        first = self.baseline()
        record = json.loads((self.project / baseline.RECORD).read_text())
        head = git(self.project, "rev-parse", "HEAD").stdout.strip()
        self.assertEqual(set(record["topics"]), set(DEFAULTS))
        self.assertEqual(record["topics"]["language"]["commit"], head)
        self.assertEqual(record["topics"]["language"]["digest"], baseline.evidence_digest(record["topics"]["language"]["evidence"]))
        self.assertTrue(first["record_written"])
        with mock.patch.object(baseline, "gather", side_effect=AssertionError("gathered again")):
            second = self.baseline()
        self.assertFalse(second["record_written"])
        self.assertTrue(all(item["reused_from_record"] for item in second["to_draft"]))
        self.assertEqual(json.loads((self.project / baseline.RECORD).read_text()), record)

    def test_drafting_lists_the_evidence_records_the_adr_and_is_never_redone(self):
        self.baseline()
        written = self.draft("language", "--open-point", "Which Python versions are supported in production")
        self.assertEqual((written["id"], written["baseline_topic"], written["committed"]), ("ADR-0001", "language", False))
        text = (self.project / written["file"]).read_text()
        parsed = adr.parse(text, written["file"])
        self.assertEqual((parsed["status"], parsed["applies_to"], parsed["problems"]), ("proposed", ["topic:language"], []))
        self.assertIn(".python-version: runtime version file (3.12)", text)
        self.assertIn("- Which Python versions are supported in production", text)
        record = json.loads((self.project / baseline.RECORD).read_text())
        self.assertEqual(record["topics"]["language"]["adr"]["id"], "ADR-0001")
        before = text
        with mock.patch.object(baseline, "gather", side_effect=AssertionError("gathered again")):
            again = self.baseline()
        self.assertEqual([item["topic"] for item in again["waiting"]], ["language"])
        self.assertNotIn("language", [item["topic"] for item in again["to_draft"]])
        code, _, err = self.run_cmd("adr", "new", "--baseline", "language", "--title", "Decide language again", "--context", "Read again here.",
                                    "--decision", "Something else entirely.")
        self.assertEqual(code, 1)
        self.assertIn("already has an ADR (ADR-0001)", err)
        self.assertEqual((self.project / written["file"]).read_text(), before, "an existing ADR is never overwritten")
        self.assertEqual(sorted(path.name for path in (self.project / "docs/adr").iterdir()), [Path(written["file"]).name])

    def test_a_topic_with_a_hand_written_adr_is_not_drafted(self):
        (self.project / "docs/adr").mkdir(parents=True)
        (self.project / "docs/adr/0001-storage.md").write_text(adr_text("Use PostgreSQL", status="proposed", applies=["topic:storage"]))
        result = self.baseline()
        self.assertEqual(result["waiting"][0]["topic"], "storage")
        self.assertNotIn("storage", [item["topic"] for item in result["to_draft"]])

    def test_adr_new_baseline_refusals(self):
        code, _, err = self.run_cmd("adr", "new", "--baseline", "language", "--title", "Decide the language", "--context", "Read from the repository.",
                                    "--decision", "What the repository already does.")
        self.assertIn("No evidence is recorded for 'language' yet", err)
        self.baseline()
        code, _, err = self.run_cmd("adr", "new", "--baseline", "security", "--title", "Decide security", "--context", "Read from the repository.",
                                    "--decision", "What the repository already does.")
        self.assertIn("'security' is not one of the required topics", err)
        code, _, err = self.run_cmd("adr", "baseline", env=UNATTENDED)
        self.assertEqual(code, 1)
        self.assertIn("engineer's work", err)

    def test_the_record_is_git_ignored_by_the_installed_block(self):
        self.assertIn(".factory/adr-baseline.json", (ROOT / "templates/gitignore-block").read_text().splitlines())


class AcceptTest(Repository):
    def setUp(self):
        self.make({"app.py": "x = 1\n"})
        self.adr_dir = self.project / "docs/adr"
        self.adr_dir.mkdir(parents=True)

    def write(self, name, text):
        (self.adr_dir / name).write_text(text)

    def test_accept_sets_the_status_names_the_person_and_commits_nothing(self):
        self.write("0001-python.md", adr_text("Python 3.12 and the standard library", status="proposed", applies=["topic:language"]))
        code, _, err = self.run_cmd("adr", "accept", "ADR-0001", "--by", "Ana Silva", env=UNATTENDED)
        self.assertEqual(code, 1)
        self.assertIn("engineer's act", err)
        code, out, err = self.run_cmd("adr", "accept", "ADR-0001", "--by", "Ana Silva")
        self.assertEqual(code, 0, err)
        result = json.loads(out)
        self.assertEqual((result["status"], result["committed"]), ("ACCEPTED", False))
        text = (self.adr_dir / "0001-python.md").read_text()
        self.assertIn("status: accepted\ndecision-makers: Ana Silva\n", text)
        self.assertTrue(adr.parse(text, "docs/adr/0001-python.md")["binding"])
        self.assertEqual(git(self.project, "log", "--oneline").stdout.count("\n"), 1, "nothing is committed")
        self.assertIn("language", adr.coverage(self.project, {})["missing"], "it binds only once committed")
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "accept")
        adr._LISTINGS.clear()
        self.assertNotIn("language", adr.coverage(self.project, {})["missing"])

    def test_accept_refuses_what_is_not_ready_and_changes_nothing(self):
        self.write("0001-python.md", adr_text("Python 3.12 and the standard library", status="proposed", applies=["topic:language"]))
        self.write("0002-template.md", adr.render("Use something for storage", applies_to=["topic:storage"]))
        self.write("0003-open.md", adr.render("Deploy somewhere", applies_to=["topic:deployment"], context="Why now here.", options=["A"], decision="Chosen here.",
                                               consequences=["Good."], open_points=["Which region"]))
        self.write("0004-done.md", adr_text("Already accepted", applies=["topic:testing"]))
        cases = {"ADR-0002": "still holds a template comment", "ADR-0003": "still lists 1 open point(s)", "ADR-0004": "it is accepted, not proposed",
                 "ADR-0009": "no such ADR"}
        before = {path.name: path.read_text() for path in self.adr_dir.iterdir()}
        for ident, expected in cases.items():
            with self.subTest(ident=ident):
                code, _, err = self.run_cmd("adr", "accept", "ADR-0001", ident, "--by", "Ana")
                self.assertEqual(code, 1)
                self.assertIn(expected, err)
                self.assertIn("Nothing was accepted", err)
        self.assertEqual({path.name: path.read_text() for path in self.adr_dir.iterdir()}, before)


class ListAuditDoctorTest(Uncovered):
    def test_adr_list_shows_each_required_topic_and_what_covers_it(self):
        self.cover(["language", "framework"])
        self.put(self.project, {"docs/adr/0006-storage.md": adr_text("Keep data in SQLite", status="proposed", applies=["topic:storage"])})
        listed = self.json_cmd("adr", "list")["required_topics"]
        self.assertEqual(listed["required"], DEFAULTS)
        self.assertEqual(listed["missing"], DEFAULTS[2:])
        rows = {row["topic"]: row for row in listed["topics"]}
        self.assertEqual(rows["language"]["covered_by"], ["ADR-0005"])
        self.assertEqual(rows["storage"]["not_binding_yet"], ["ADR-0006"])
        self.assertIn("adr baseline", listed["next"])

    def test_doctor_warns_while_a_topic_is_missing(self):
        checks = {item["id"]: item for item in doctor.diagnose(self.project)["checks"]}
        self.assertEqual(checks["adr.baseline"]["status"], "warn")
        self.assertIn("language", checks["adr.baseline"]["detail"])
        self.cover()
        adr._LISTINGS.clear()
        checks = {item["id"]: item for item in doctor.diagnose(self.project)["checks"]}
        self.assertEqual(checks["adr.baseline"]["status"], "ok")


if __name__ == "__main__":
    unittest.main()
