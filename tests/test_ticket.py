"""Tests for ticket.py: local tickets, tracker CLIs (faked), and telemetry ingestion."""

import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "ticket" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
import cell  # noqa: E402
import ticket  # noqa: E402

FAKE_CLI = '''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(json.dumps([os.path.basename(sys.argv[0])] + args) + "\\n")
for prefix, out, code in json.load(open(os.environ["FAKE_RESPONSES"])):
    if args[:len(prefix)] == prefix:
        sys.stdout.write(out)
        sys.exit(code)
'''

GH_ISSUE = {
    "number": 42, "title": "Invite  teammates", "state": "OPEN", "url": "https://github.com/acme/app/issues/42",
    "body": "Admins cannot add people.\n\n## Acceptance criteria\n- An admin can invite by email\n- A full workspace is refused\n\n## Notes\n- not a criterion",
    "labels": [{"name": "feature"}, {"name": "mach:blocked"}], "comments": [{"body": "x"}],
}

SENTRY = {
    "action": "triggered",
    "data": {
        "issue": {"title": "KeyError: 'plan'", "userCount": 12, "count": "340", "permalink": "https://sentry.example/issues/1"},
        "event": {
            "release": "app@1.4.2", "environment": "production",
            "user": {"email": "jane.doe@example.com", "id": "u_991"},
            "request": {"headers": [["Cookie", "session=abc"]]},
            "exception": {"values": [{
                "type": "KeyError", "value": "'plan' missing for jane.doe@example.com token=FAKEFAKE1234567890fakefake1234567890",
                "stacktrace": {"frames": [
                    {"filename": "django/core/handlers/base.py", "lineno": 181, "function": "_get_response", "in_app": False},
                    {"filename": "billing/views.py", "lineno": 57, "function": "pause", "in_app": True},
                    {"filename": "billing/plans.py", "lineno": 23, "function": "lookup", "in_app": True},
                    {"filename": "lib/python3.12/collections/__init__.py", "lineno": 1100, "function": "__getitem__", "in_app": False},
                ]},
            }]},
        },
    },
}

PYTEST_LOG = """build\tRun tests\t2026-11-09T10:00:00Z ##[group]Run pytest -q
============================= test session starts ==============================
tests/test_pause.py F.                                                    [100%]
    def test_pause_twice():
>       assert pause(sub) is None
E       AssertionError: assert 'paused' is None
tests/test_pause.py:14: AssertionError
FAILED tests/test_pause.py::test_pause_twice - AssertionError: assert 'paused' is None
##[error]Process completed with exit code 1.
"""


def run(*argv, project, stdin=None):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err), mock.patch("sys.stdin", io.StringIO(stdin or "")):
        code = ticket.main(["--project", str(project), *argv])
    return code, out.getvalue(), err.getvalue()


class Base(unittest.TestCase):
    provider = "local"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name).resolve()
        self.project = root / "project"
        (self.project / ".factory").mkdir(parents=True)
        self.configure({"tickets": {"provider": self.provider}})
        self.bin = root / "bin"
        self.bin.mkdir()
        self.log = root / "calls.log"
        self.responses = root / "responses.json"
        self.respond()
        env = {"PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}", "FAKE_LOG": str(self.log), "FAKE_RESPONSES": str(self.responses)}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("ISSUE_PROVIDER", None)
        os.environ.pop("TELEMETRY_PROVIDER", None)

    def configure(self, config):
        (self.project / ".factory/config.json").write_text(json.dumps(config))

    def fake(self, name):
        path = self.bin / name
        path.write_text(FAKE_CLI)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)

    def respond(self, *responses):
        self.responses.write_text(json.dumps([list(r) for r in responses]))

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def ok(self, *argv, stdin=None):
        code, out, err = run(*argv, project=self.project, stdin=stdin)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def payload(self, name, content):
        path = Path(self.tmp.name) / name
        path.write_text(content if isinstance(content, str) else json.dumps(content))
        return str(path)


class LocalTest(Base):
    def test_create_view_and_inbox(self):
        made = self.ok("create", "--title", "Invite teammates", "--label", "feature", "--body",
                       "Admins cannot add people.\n\n- [ ] An admin can invite by email\n- [x] A full workspace is refused")
        self.assertEqual(made["ticket_id"], "LOCAL-001")
        seen = self.ok("view", "LOCAL-001")
        self.assertEqual((seen["title"], seen["state"], seen["labels"], seen["provider"]), ("Invite teammates", "open", ["feature"], "local"))
        self.assertEqual(seen["summary"], "Admins cannot add people.")
        self.assertEqual(seen["acceptance_criteria"], ["An admin can invite by email", "A full workspace is refused"])
        self.assertNotIn("Activity Log", seen["body"])
        inbox = json.loads((self.project / ".factory/inbox/LOCAL-001.json").read_text())
        self.assertEqual(inbox["raw_payload_path"], ".factory/inbox/LOCAL-001.raw")
        self.assertTrue((self.project / ".factory/inbox/LOCAL-001.raw").is_file())

    def test_update_comment_and_list(self):
        self.ok("create", "--title", "One")
        self.ok("create", "--title", "Two", "--label", "bug")
        changed = self.ok("update", "LOCAL-001", "--state", "blocked", "--label", "blocked-requires-sme", "--comment", "Needs Finance.\nSee Q3.")
        self.assertEqual(changed["changes"], ["State set to blocked.", "Label added: blocked-requires-sme.", "Comment added."])
        self.ok("comment", "LOCAL-001", "--body", "-", stdin="From stdin.")
        self.ok("update", "LOCAL-001", "--remove-label", "blocked-requires-sme", "--state", "closed")
        text = (self.project / ".factory/tickets/LOCAL-001.md").read_text()
        self.assertIn("state: closed", text)
        self.assertIn("labels: []", text)
        self.assertIn("Needs Finance.\n  See Q3.", text)
        self.assertIn("From stdin.", text)
        self.assertEqual([t["ticket_id"] for t in self.ok("list")], ["LOCAL-002"])
        self.assertEqual(len(self.ok("list", "--all")), 2)
        self.assertEqual(self.ok("list", "--label", "feature"), [])
        again = self.ok("update", "LOCAL-002", "--state", "open")
        self.assertIn("Nothing changed", again["changes"][0])

    def test_new_ticket_numbers_never_reuse_a_finished_or_groomed_ticket(self):
        self.payload("unused", "")
        (self.project / ".factory/archive").mkdir(parents=True)
        (self.project / ".factory/archive/runs.jsonl").write_text(json.dumps({"ticket_id": "LOCAL-004"}) + "\nnot json\n")
        (self.project / ".factory/worktrees/LOCAL-006").mkdir(parents=True)
        self.assertEqual(self.ok("create", "--title", "Next")["ticket_id"], "LOCAL-007")
        with redirect_stdout(io.StringIO()) as out:
            cell.main(["--project", str(self.project), "ticket-new", "--title", "From intent"])
        self.assertEqual(json.loads(out.getvalue())["ticket_id"], "LOCAL-008")

    def test_new_ticket_numbers_never_reuse_a_branch_name(self):
        """On a fresh clone the local records are gone, but earlier tickets' branches are still on the remote."""
        git = lambda *args: subprocess.run(["git", *args], cwd=str(self.project), capture_output=True, text=True)
        git("init", "-q", "-b", "main")
        git("-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "start")
        git("branch", "feature/LOCAL-003")
        git("update-ref", "refs/remotes/origin/feature/LOCAL-009", "HEAD")
        git("update-ref", "refs/remotes/origin/feature/OTHER-040", "HEAD")
        self.assertEqual(self.ok("create", "--title", "Next")["ticket_id"], "LOCAL-010")
        with redirect_stdout(io.StringIO()) as out:
            cell.main(["--project", str(self.project), "ticket-new", "--title", "From intent"])
        self.assertEqual(json.loads(out.getvalue())["ticket_id"], "LOCAL-011")

    def test_front_matter_extras_and_title_with_quotes(self):
        self.ok("create", "--title", 'Fix "pause" button')
        path = self.project / ".factory/tickets/LOCAL-001.md"
        path.write_text(path.read_text().replace("state: open", "state: open\nepic: Self-service billing"))
        seen = self.ok("view", "LOCAL-001")
        self.assertEqual((seen["title"], seen["epic"]), ('Fix "pause" button', "Self-service billing"))

    def test_works_with_tickets_made_by_the_intent_skill(self):
        with redirect_stdout(io.StringIO()):
            cell.main(["--project", str(self.project), "ticket-new", "--title", "From intent", "--body", "Words.", "--label", "a"])
        self.assertEqual(self.ok("view", "LOCAL-001")["summary"], "Words.")
        self.ok("update", "LOCAL-001", "--label", "b")
        with redirect_stdout(io.StringIO()):
            self.assertEqual(cell.main(["--project", str(self.project), "ticket-note", "LOCAL-001", "--remove-label", "a"]), 0)
        self.assertEqual(self.ok("view", "LOCAL-001")["labels"], ["b"])

    def test_errors(self):
        for argv, expected in (
            (["view", "LOCAL-404"], "No local ticket LOCAL-404"),
            (["view", "../x"], "not a usable ticket ID"),
            (["update", "LOCAL-404"], "Nothing to change"),
            (["--provider", "github", "view", "1"], "'gh' is not installed"),
        ):
            with self.subTest(argv=argv), mock.patch.object(ticket.shutil, "which", return_value=None):
                code, _, err = run(*argv, project=self.project)
                self.assertEqual(code, 2)
                self.assertIn(expected, err)

    def test_environment_overrides_config(self):
        with mock.patch.dict(os.environ, {"ISSUE_PROVIDER": "bugzilla"}):
            code, _, err = run("list", project=self.project)
        self.assertEqual(code, 2)
        self.assertIn("Unknown ticket provider 'bugzilla'", err)


class GitHubTest(Base):
    provider = "github"

    def setUp(self):
        super().setUp()
        self.fake("gh")

    def test_view_normalizes(self):
        self.respond((["issue", "view", "42"], json.dumps(GH_ISSUE), 0))
        seen = self.ok("view", "#42")
        self.assertEqual((seen["ticket_id"], seen["title"], seen["state"], seen["labels"]), ("42", "Invite teammates", "blocked", ["feature"]))
        self.assertEqual(seen["acceptance_criteria"], ["An admin can invite by email", "A full workspace is refused"])
        self.assertEqual((seen["url"], seen["comments"]), ("https://github.com/acme/app/issues/42", 1))
        self.assertEqual(json.loads((self.project / ".factory/inbox/42.raw").read_text())["number"], 42)

    def test_state_change_swaps_state_labels(self):
        self.respond((["issue", "view", "42"], json.dumps(GH_ISSUE), 0))
        self.ok("update", "42", "--state", "in_progress", "--comment", "Started.")
        calls = [c[1:] for c in self.calls()]
        self.assertIn(["issue", "edit", "42", "--remove-label", "mach:blocked"], calls)
        self.assertIn(["issue", "edit", "42", "--add-label", "mach:in_progress"], calls)
        self.assertIn(["issue", "comment", "42", "--body", "Started."], calls)
        self.assertFalse(any(c[:2] in (["issue", "close"], ["issue", "reopen"]) for c in calls))

    def test_close_and_reopen(self):
        self.respond((["issue", "view", "42"], json.dumps(GH_ISSUE), 0))
        self.ok("update", "42", "--state", "closed")
        self.assertIn(["gh", "issue", "close", "42"], self.calls())
        self.assertIn(["gh", "issue", "edit", "42", "--remove-label", "mach:blocked"], self.calls())
        self.log.unlink()
        self.respond((["issue", "view", "42"], json.dumps({**GH_ISSUE, "state": "CLOSED", "labels": []}), 0))
        self.ok("update", "42", "--state", "open")
        self.assertIn(["gh", "issue", "reopen", "42"], self.calls())

    def test_missing_label_is_created_then_added(self):
        self.respond((["issue", "edit", "42", "--add-label"], "", 1), (["label", "create"], "", 0))
        code, _, err = run("update", "42", "--label", "groomed", project=self.project)
        self.assertEqual(code, 2, "the fake keeps refusing, so the retry fails too")
        self.assertIn(["gh", "label", "create", "groomed", "--force"], self.calls())

    def test_create_reads_the_issue_number(self):
        self.respond((["issue", "create"], "https://github.com/acme/app/issues/77\n", 0))
        made = self.ok("create", "--title", "New", "--body", "Text", "--label", "bug")
        self.assertEqual((made["ticket_id"], made["tracker_id"], made["url"]), ("77", "77", "https://github.com/acme/app/issues/77"))
        self.assertEqual(self.calls()[-1], ["gh", "issue", "create", "--title", "New", "--body", "Text", "--label", "bug"])

    def test_list(self):
        self.respond((["issue", "list"], json.dumps([{"number": 1, "title": "A", "state": "OPEN", "labels": [{"name": "mach:needs_review"}, {"name": "ui"}]}]), 0))
        self.assertEqual(self.ok("list", "--label", "ui"), [{"ticket_id": "1", "title": "A", "state": "needs_review", "labels": ["ui"]}])
        self.assertEqual(self.calls()[-1][-2:], ["--label", "ui"])

    def test_tracker_failure_is_reported(self):
        self.respond((["issue", "view"], "", 1))
        code, _, err = run("view", "9", project=self.project)
        self.assertEqual(code, 2)
        self.assertIn("failed", err)


class GenericProviderTest(Base):
    provider = "gitea-cli"

    def setUp(self):
        super().setUp()
        self.fake("gt")

    def test_view_hands_raw_output_to_the_caller_then_save_validates(self):
        self.respond((["issue", "view", "7"], "\x1b[1m#7 Slow export\x1b[0m\nState: open\n\nExports take minutes.\n", 0))
        raw = self.ok("view", "7")
        self.assertEqual(raw["status"], "RAW")
        self.assertEqual(Path(raw["raw_path"]).read_text(), "#7 Slow export\nState: open\n\nExports take minutes.\n")
        saved = self.ok("save", "7", stdin=json.dumps({"title": "Slow export", "body": "Exports take minutes.\n\n- [ ] Under 10 seconds", "labels": ["perf"], "state": "open", "epic": "Reporting"}))
        self.assertEqual((saved["provider"], saved["acceptance_criteria"], saved["epic"]), ("gitea-cli", ["Under 10 seconds"], "Reporting"))
        self.assertEqual(saved["raw_payload_path"], ".factory/inbox/7.raw")
        for bad, expected in (("not json", "Expected one JSON object"), ('{"title": ""}', "non-empty string 'title'"), ('{"title": "x", "state": "done"}', "'state' must be one of")):
            code, _, err = run("save", "7", project=self.project, stdin=bad)
            self.assertEqual(code, 2)
            self.assertIn(expected, err)

    def test_update_maps_states(self):
        self.ok("update", "7", "--state", "closed")
        self.assertEqual(self.calls()[-1], ["gt", "issue", "edit", "7", "--state", "closed"])
        self.ok("update", "7", "--state", "needs_review")
        self.assertEqual(self.calls()[-2:], [["gt", "issue", "edit", "7", "--state", "open"], ["gt", "issue", "label", "add", "7", "mach:needs_review"]])

    def test_commands_and_state_names_can_be_replaced_in_config(self):
        self.fake("tea")
        self.configure({"tickets": {"provider": "gitea-cli", "commands": {"comment": ["tea", "comment", "{id}", "{body}"]}}})
        self.ok("comment", "7", "--body", "Hello")
        self.assertEqual(self.calls()[-1], ["tea", "comment", "7", "Hello"])
        self.fake("jira")
        self.configure({"tickets": {"provider": "jira", "state_names": {"closed": "Shipped"}}})
        self.ok("update", "APP-3", "--state", "closed")
        self.assertEqual(self.calls()[-1], ["jira", "issue", "move", "APP-3", "Shipped"])

    def test_unsupported_action_names_the_setting(self):
        self.fake("fossil")
        self.configure({"tickets": {"provider": "fossil"}})
        code, _, err = run("update", "abc123", "--label", "x", project=self.project)
        self.assertEqual(code, 2)
        self.assertIn("tickets.commands.add_label", err)


class TelemetryTest(Base):
    def test_sentry_becomes_a_redacted_auto_ticket(self):
        made = self.ok("ingest-telemetry", "sentry", self.payload("sentry.json", SENTRY))
        ticket_id = made["ticket_id"]
        self.assertEqual(made["status"], "CREATED")
        self.assertRegex(ticket_id, r"^AUTO-\d{8}T\d{6}Z$")
        self.assertTrue(made["title"].startswith("[BUG/Telemetry] KeyError: 'plan' missing for <email>"))
        self.assertTrue(made["title"].endswith(" in billing/plans.py"))
        self.assertEqual(made["labels"], ["bug", "telemetry-auto-generated", "sentry", "severity-high"])
        record = json.loads((self.project / f".factory/inbox/{ticket_id}.json").read_text())
        self.assertEqual((record["telemetry"]["culprit_file"], record["telemetry"]["line"]), ("billing/plans.py", 23))
        self.assertEqual(record["telemetry"]["details"]["users_affected"], 12)
        seed = (self.project / f".factory/inbox/{ticket_id}-intent.md").read_text()
        self.assertIn("- **Culprit File**: `billing/plans.py:23`", seed)
        self.assertIn("billing/views.py:57 in pause", seed)
        local = (self.project / f".factory/tickets/{ticket_id}.md").read_text()
        for written in (json.dumps(record), seed, local):
            for secret in ("jane.doe", "FAKEFAKE", "u_991", "session=abc"):
                self.assertNotIn(secret, written)
        self.assertIn("jane.doe", (self.project / f".factory/inbox/{ticket_id}.raw").read_text(), "the raw payload is kept unedited")
        seen = self.ok("view", ticket_id)
        self.assertEqual(seen["telemetry"]["source"], "sentry")
        self.assertEqual(len(seen["acceptance_criteria"]), 3)
        with redirect_stdout(io.StringIO()) as out:
            cell.main(["--project", str(self.project), "open", ticket_id, "--headless"])
        self.assertTrue(json.loads(out.getvalue())["ticket"]["seeded_intent"].endswith(f"{ticket_id}-intent.md"))

    def test_same_fault_is_not_ticketed_twice(self):
        path = self.payload("sentry.json", SENTRY)
        first = self.ok("ingest-telemetry", "sentry", path)
        again = self.ok("ingest-telemetry", "sentry", path)
        self.assertEqual((again["status"], again["ticket_id"], again["occurrences_ingested"]), ("DUPLICATE", first["ticket_id"], 2))
        self.assertEqual(len(list((self.project / ".factory/tickets").glob("AUTO-*.md"))), 1)
        self.ok("update", first["ticket_id"], "--state", "closed")
        self.ok("view", first["ticket_id"])
        self.assertEqual(self.ok("ingest-telemetry", "sentry", path)["status"], "CREATED", "a closed fault that returns is a new ticket")

    def test_posthog(self):
        event = {"event": "$exception", "distinct_id": "user-77", "properties": {
            "$exception_type": "TypeError", "$exception_message": "x is undefined",
            "$current_url": "https://app.example.com/billing?email=jo@example.com", "$browser": "Safari"}}
        made = self.ok("ingest-telemetry", "posthog", self.payload("ph.json", event), "--no-sync")
        self.assertEqual(made["title"], "[BUG/Telemetry] PostHog Error: TypeError on https://app.example.com/billing")
        self.assertEqual(made["tracker"], "not synced")
        self.assertFalse((self.project / ".factory/tickets").exists())
        self.assertNotIn("user-77", (self.project / f".factory/inbox/{made['ticket_id']}.json").read_text())

    def test_datadog(self):
        alert = {"alert_title": "p95 latency above 2s", "tags": "service:checkout,env:prod", "hostname": "web-3", "alert_metric": "http.latency.p95", "text_only_msg": "Latency is high."}
        made = self.ok("ingest-telemetry", "datadog", self.payload("dd.json", alert))
        self.assertEqual(made["title"], "[ALERT/Telemetry] Datadog: p95 latency above 2s (checkout)")
        self.assertEqual(made["labels"], ["alert", "telemetry-auto-generated", "datadog"])

    def test_ci_log(self):
        made = self.ok("ingest-telemetry", "github-actions", self.payload("run.log", PYTEST_LOG), "--commit", "abc1234")
        self.assertEqual(made["title"], "[CI/Failure] Build Failed in Run tests: tests/test_pause.py::test_pause_twice")
        self.assertEqual(made["labels"], ["ci-failure", "telemetry-auto-generated", "automated-repair"])
        record = json.loads(Path(made["inbox_path"]).read_text())
        self.assertEqual((record["telemetry"]["culprit_file"], record["telemetry"]["line"], record["telemetry"]["details"]["commit"]), ("tests/test_pause.py", 14, "abc1234"))

    def test_python_traceback_log(self):
        log = 'Traceback (most recent call last):\n  File "app/main.py", line 10, in run\n    go()\n  File "app/jobs.py", line 44, in go\n    raise ValueError("bad plan")\nValueError: bad plan\n'
        made = self.ok("ingest-telemetry", "local-log", self.payload("app.log", log))
        self.assertEqual(made["title"], "[BUG/Telemetry] ValueError: bad plan")
        self.assertIn("`app/jobs.py:44`", Path(made["seeded_intent"]).read_text())

    def test_source_defaults_from_config_and_bad_payloads_are_refused(self):
        self.configure({"tickets": {"provider": "local"}, "telemetry": {"provider": "sentry"}})
        self.assertEqual(self.ok("ingest-telemetry", self.payload("s.json", SENTRY))["status"], "CREATED")
        for source, content, expected in (
            ("sentry", "not json", "not valid JSON"),
            ("sentry", {"hello": "world"}, "Nothing in the payload looks like a sentry error"),
            ("ci-log", "all 12 tests passed\n", "Nothing in the payload looks like a ci-log error"),
        ):
            code, _, err = run("ingest-telemetry", source, self.payload("bad", content), project=self.project)
            self.assertEqual(code, 2)
            self.assertIn(expected, err)
        self.assertEqual(len(list((self.project / ".factory/inbox").glob("AUTO-*.json"))), 1)

    def test_remote_tracker_id_is_remembered(self):
        self.fake("gh")
        self.configure({"tickets": {"provider": "github"}})
        self.respond((["issue", "create"], "https://github.com/acme/app/issues/88\n", 0), (["issue", "view", "88"], json.dumps({**GH_ISSUE, "number": 88, "labels": []}), 0))
        made = self.ok("ingest-telemetry", "sentry", self.payload("s.json", SENTRY))
        self.assertEqual(made["tracker"]["tracker_id"], "88")
        self.ok("update", made["ticket_id"], "--state", "blocked")
        self.assertIn(["gh", "issue", "edit", "88", "--add-label", "mach:blocked"], self.calls())
        self.assertEqual(self.ok("view", made["ticket_id"])["telemetry"]["source"], "sentry")


class HelperTest(unittest.TestCase):
    def test_redact(self):
        text = ticket.redact('user bob@corp.io sent Authorization: Bearer abc.def password="hunter2" id 0123456789abcdef0123456789abcdef01 ok')
        for secret in ("bob@corp.io", "abc.def", "hunter2", "0123456789abcdef"):
            self.assertNotIn(secret, text)
        self.assertEqual(ticket.redact("KeyError in billing/plans.py line 23"), "KeyError in billing/plans.py line 23")

    def test_acceptance_criteria_only_from_checklists_or_an_acceptance_heading(self):
        body = "Intro\n- loose bullet\n\n**Acceptance Criteria:**\n1. First\n2) Second\n\n### Other\n- no\n- [ ] boxed anywhere"
        self.assertEqual(ticket.acceptance_criteria(body), ["First", "Second", "boxed anywhere"])


if __name__ == "__main__":
    unittest.main()
