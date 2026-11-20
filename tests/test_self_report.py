"""MACH reports its own defects as GitHub issues, only on a person's yes (M14 part E): run.py report, selfreport.py.

GitHub is a stand-in program on the PATH that answers from a scenario file and logs every call with what it was given
on stdin. Nothing here reaches real GitHub. Held here:
- the exact `gh` commands: the sign-in check, the search for the fingerprint, the label check, and on --confirm only
  `issue create` or `issue comment`, each against github.com/<report.repository>;
- the preview sends nothing and prints a code; --confirm files exactly the previewed text, checked by its hash;
- an open issue with the same fingerprint gets a short comment instead; the label is added only where it exists;
- without gh, signed out or without access, the person gets the --print text and a plain sentence;
- refused inside a supervised execution and with report.enabled false; the record is marked reported after filing;
- the text holds nothing of the person's, the project's or the machine's; their own words are bounded and made inert;
- nothing but run.py loads the report, and no station, agent, workflow or the supervisor names it.
"""
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / "skills" / "run" / "scripts" / "run.py"
REPO = "github.com/swiftj/mach-harness"

FAKE_GH = r'''#!@@PYTHON@@
import json, os, sys
argv = sys.argv[1:]
given = sys.stdin.read() if "--body-file" in argv else None
with open(os.environ["FAKE_GH_LOG"], "a") as log:
    log.write(json.dumps({"argv": argv, "stdin": given}) + "\n")
scenario = json.load(open(os.environ["FAKE_GH_SCENARIO"]))
if argv[:2] == ["auth", "status"]:
    sys.stderr.write(scenario.get("auth_text", "Logged in to github.com\n"))
    sys.exit(scenario.get("auth", 0))
if argv[:2] == ["issue", "list"]:
    if scenario.get("no_access"):
        sys.stderr.write("HTTP 404: Not Found\n")
        sys.exit(1)
    print(json.dumps(scenario.get("open", [])))
    sys.exit(0)
if argv[:2] == ["label", "list"]:
    print(json.dumps([{"name": name} for name in scenario.get("labels", [])]))
    sys.exit(0)
if argv[:2] == ["issue", "create"]:
    print("https://github.com/swiftj/mach-harness/issues/321")
    sys.exit(0)
if argv[:2] == ["issue", "comment"]:
    print("https://github.com/swiftj/mach-harness/issues/" + argv[2] + "#issuecomment-99")
    sys.exit(0)
sys.stderr.write("unexpected gh call\n")
sys.exit(1)
'''


class ReportTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.project = self.tmp / "quorvex-ledger"
        (self.project / ".factory" / "tickets").mkdir(parents=True)
        self.config({})
        subprocess.run(["git", "init", "-q", str(self.project)], check=True)
        subprocess.run(["git", "-C", str(self.project), "remote", "add", "origin", "https://gitlab.example.test/quorvex-industries/hollowmere.git"], check=True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        (self.bin / "git").symlink_to(shutil.which("git"))
        self.log = self.tmp / "gh.log"
        self.scenario = self.tmp / "gh.json"
        self.github({})
        self.env = {**os.environ, "PATH": str(self.bin), "FAKE_GH_LOG": str(self.log), "FAKE_GH_SCENARIO": str(self.scenario)}
        self.env.pop("MACH_EXECUTION_ID", None)
        self.gh_installed(True)
        self.fault = self.crash()

    # helpers
    def config(self, data):
        (self.project / ".factory" / "config.json").write_text(json.dumps(data))

    def github(self, scenario):
        self.scenario.write_text(json.dumps(scenario))

    def gh_installed(self, present):
        gh = self.bin / "gh"
        if present:
            gh.write_text(FAKE_GH.replace("@@PYTHON@@", sys.executable))
            gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
        elif gh.exists():
            gh.unlink()

    def run_py(self, *argv, env=None):
        return subprocess.run([sys.executable, str(RUN), "--project", str(self.project), *argv], cwd=str(self.project),
                              env={**self.env, **(env or {})}, capture_output=True, text=True)

    def report(self, *argv, env=None):
        done = self.run_py("report", *argv, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def calls(self):
        if not self.log.is_file():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def crash(self):
        """A real internal error in run.py: a ticket file that is a folder (with a ticket ID and the project's names around it)."""
        broken = self.project / ".factory" / "tickets" / "ACME-77.md"
        broken.mkdir()
        done = self.run_py("status")
        self.assertIn("IsADirectoryError", done.stderr)
        broken.rmdir()
        (record,) = [json.loads(path.read_text()) for path in (self.project / ".factory/local/faults").glob("*.json")]
        return record

    def assert_clean(self, text):
        for value in ("quorvex", "hollowmere", "ACME-77", str(self.project), str(self.tmp), os.path.expanduser("~"), "gitlab.example.test"):
            self.assertNotIn(value.lower(), text.lower(), value)

    # tests
    def test_the_preview_shows_the_text_sends_nothing_and_asks_only_what_it_needs(self):
        shown = self.report()
        self.assertFalse(shown["sent"])
        self.assertTrue(shown["can_file"])
        self.assertEqual((shown["kind"], shown["repository"], shown["label"]), ("issue", "swiftj/mach-harness", None))
        self.assertEqual(shown["title"], "Internal error: IsADirectoryError in run.py status")
        self.assertRegex(shown["confirm_with"], r"^[0-9a-f]{6}$")
        body = shown["body"]
        fingerprint = self.fault["fingerprint"][:16]
        self.assertTrue(body.startswith(f"<!-- mach:self-report v1 fingerprint={fingerprint} -->\n## What happened"))
        for part in ("## Details", "## Traceback", "## Doctor", "- Script: `run/scripts/run.py`", "- Exception: `IsADirectoryError`",
                     "run/scripts/run.py, line ", "in cmd_status", "- git: ", "Seen: 1 time on this machine", "Filed with `/mach:run report`"):
            self.assertIn(part, body)
        self.assertNotIn("## In the reporter's words", body)
        self.assert_clean(shown["title"] + body)
        self.assertEqual([call["argv"] for call in self.calls()], [
            ["auth", "status", "--hostname", "github.com"],
            ["issue", "list", "--repo", REPO, "--state", "open", "--search", fingerprint, "--json", "number,url,body", "--limit", "20"],
            ["label", "list", "--repo", REPO, "--search", "mach:self-report", "--json", "name", "--limit", "20"]])
        self.assertIsNone(json.loads(next((self.project / ".factory/local/faults").glob(self.fault["id"] + ".json")).read_text())["reported"])

    def test_confirm_files_exactly_the_previewed_text_and_marks_the_fault_reported(self):
        shown = self.report()
        filed = self.report("--confirm", shown["confirm_with"])
        self.assertEqual(filed, {"sent": True, "kind": "issue", "repository": "swiftj/mach-harness", "url": "https://github.com/swiftj/mach-harness/issues/321",
                                 "issue": 321, "fault_id": self.fault["id"]})
        create = self.calls()[-1]
        self.assertEqual(create["argv"], ["issue", "create", "--repo", REPO, "--title", shown["title"], "--body-file", "-"])
        self.assertEqual(create["stdin"], shown["body"])
        self.assertEqual(sum(1 for call in self.calls() if call["argv"][:2] == ["issue", "create"]), 1)
        record = json.loads((self.project / ".factory/local/faults" / (self.fault["id"] + ".json")).read_text())
        self.assertEqual((record["reported"]["url"], record["reported"]["as"]), ("https://github.com/swiftj/mach-harness/issues/321", "issue"))
        self.assertNotIn("faults", json.loads(self.run_py("status").stdout)["digest"])
        again = self.run_py("report", "--confirm", shown["confirm_with"])  # a code works once
        self.assertEqual(again.returncode, 1)
        self.assertIn("Nothing is waiting to be confirmed", again.stderr)

    def test_the_label_is_added_only_where_it_already_exists(self):
        self.github({"labels": ["bug", "mach:self-report"]})
        shown = self.report()
        self.assertEqual(shown["label"], "mach:self-report")
        self.report("--confirm", shown["confirm_with"])
        self.assertEqual(self.calls()[-1]["argv"][-2:], ["--label", "mach:self-report"])
        self.assertFalse(any(call["argv"][:2] == ["label", "create"] for call in self.calls()))

    def test_an_open_issue_with_the_same_fingerprint_gets_a_comment_instead(self):
        fingerprint = self.fault["fingerprint"][:16]
        self.github({"open": [{"number": 7, "url": "https://github.com/swiftj/mach-harness/issues/7", "body": "unrelated"},
                              {"number": 12, "url": "https://github.com/swiftj/mach-harness/issues/12",
                               "body": f"<!-- mach:self-report v1 fingerprint={fingerprint} -->\n## What happened"}]})
        shown = self.report()
        self.assertEqual((shown["kind"], shown["duplicate"]), ("comment", {"number": 12, "url": "https://github.com/swiftj/mach-harness/issues/12"}))
        self.assertIsNone(shown["title"])
        self.assertTrue(shown["body"].startswith(f"<!-- mach:self-report-seen v1 fingerprint={fingerprint} -->\nSeen again on another machine: 1 time, last "))
        self.assertIn("Python ", shown["body"])
        self.assertEqual(len(shown["body"].splitlines()), 2)
        self.assertFalse(any(call["argv"][:2] == ["label", "list"] for call in self.calls()))
        filed = self.report("--confirm", shown["confirm_with"])
        self.assertEqual((filed["kind"], filed["issue"]), ("comment", 12))
        self.assertEqual(self.calls()[-1]["argv"], ["issue", "comment", "12", "--repo", REPO, "--body-file", "-"])
        self.assertEqual(self.calls()[-1]["stdin"], shown["body"])
        record = json.loads((self.project / ".factory/local/faults" / (self.fault["id"] + ".json")).read_text())
        self.assertEqual(record["reported"]["url"], "https://github.com/swiftj/mach-harness/issues/12")
        fresh = self.report(self.fault["id"], "--new")  # the person may still ask for a new issue
        self.assertEqual(fresh["kind"], "issue")

    def test_without_gh_signed_out_or_without_access_the_person_gets_the_text_and_a_sentence(self):
        printed = self.run_py("report", "--print")
        self.assertEqual(printed.returncode, 0)
        self.assertTrue(printed.stdout.startswith("Nothing was sent. To file it by hand, open https://github.com/swiftj/mach-harness/issues/new"))
        self.assertEqual(self.calls(), [])  # --print asks GitHub nothing
        for scenario, present, why in (({"auth": 1, "auth_text": "You are not logged into any GitHub hosts."}, True, "not signed in"),
                                       ({"auth": 1, "auth_text": "error connecting to api.github.com"}, True, "could not be reached"),
                                       ({"no_access": True}, True, "could not be searched"),
                                       ({}, False, "not installed")):
            self.github(scenario)
            self.gh_installed(present)
            shown = self.report()
            self.assertFalse(shown["sent"] or shown["can_file"])
            self.assertIn(why, shown["why"])
            self.assertIn(f"Title: {shown['title']}\n\n{shown['body']}", printed.stdout)
            self.assertNotIn("confirm_with", shown)
        self.assertFalse(any(call["argv"][:2] in (["issue", "create"], ["issue", "comment"]) for call in self.calls()))

    def test_a_wrong_or_expired_code_files_nothing(self):
        shown = self.report()
        wrong = self.run_py("report", "--confirm", "000000" if shown["confirm_with"] != "000000" else "111111")
        self.assertEqual(wrong.returncode, 1)
        self.assertIn("Nothing was sent", wrong.stderr)
        pending = self.project / ".factory/local/faults/pending-report.json"
        entry = json.loads(pending.read_text())
        entry["body"] += "something added after the person read it\n"
        pending.write_text(json.dumps(entry))
        changed = self.run_py("report", "--confirm", shown["confirm_with"])
        self.assertEqual(changed.returncode, 1)
        self.assertIn("not the text that was shown", changed.stderr)
        shown = self.report()
        entry = json.loads(pending.read_text())
        entry["expires_at"] = "2020-01-01T00:00:00Z"
        pending.write_text(json.dumps(entry))
        expired = self.run_py("report", "--confirm", shown["confirm_with"])
        self.assertIn("expired", expired.stderr)
        self.assertFalse(any(call["argv"][:2] == ["issue", "create"] for call in self.calls()))

    def test_refused_inside_a_supervised_execution_and_when_switched_off(self):
        done = self.run_py("report", env={"MACH_EXECUTION_ID": "x0123456789ab"})
        self.assertEqual(done.returncode, 1)
        self.assertIn("never made inside a supervised Factory execution", done.stderr)
        self.assertEqual(self.calls(), [])
        self.config({"report": {"enabled": False}})
        done = self.run_py("report")
        self.assertEqual(done.returncode, 1)
        self.assertIn("report.enabled is false", done.stderr)
        for bad in ("swiftj", "a/b/c", "https://github.com/swiftj/mach-harness", "owner/name.git", 7):
            self.config({"report": {"repository": bad}})
            self.assertIn("owner/name on github.com", self.run_py("report").stderr, bad)
        self.config({"report": {"repository": "someone-else/fork"}})
        self.assertEqual(self.report()["repository"], "someone-else/fork")
        self.assertIn("github.com/someone-else/fork", self.calls()[-1]["argv"])

    def test_the_persons_own_words_are_bounded_and_inert(self):
        words = ("The quorvex-industries/hollowmere board broke on ACME-77 again, ping @octocat about #12, "
                 "my key is ghp_" + "Z" * 36 + " " + "x" * 3000)
        shown = self.report(words)
        self.assertEqual(shown["title"], "A problem reported by a person using MACH " + json.loads((ROOT / ".claude-plugin/plugin.json").read_text())["version"])
        body = shown["body"]
        self.assertIn("No internal error was recorded with it.", body)
        quoted = body.split("## In the reporter's words\n\n", 1)[1].split("\n\n---", 1)[0]
        self.assertTrue(all(line.startswith("> ") for line in quoted.splitlines()))
        self.assertIn("broke on", quoted)
        self.assertNotIn("@octocat", quoted)  # a mention that notifies nobody
        self.assertNotIn("#12", quoted)  # a reference that links nothing
        self.assertNotIn("ghp_", body)
        self.assertLess(len(quoted), 2200)
        self.assert_clean(body)
        self.assertNotIn("fingerprint", body)
        self.assertFalse(any(call["argv"][:2] == ["issue", "list"] for call in self.calls()))  # nothing to look for
        both = self.report(self.fault["id"], "it happened while I looked at the status")
        self.assertIn("Internal error", both["title"])
        self.assertIn("> it happened while I looked at the status", both["body"])
        missing = self.run_py("report", "0123456789ab")
        self.assertIn("No internal error 0123456789ab", missing.stderr)

    def test_a_text_that_still_carries_a_credential_shape_is_refused(self):
        sys.path.insert(0, str(RUN.parent))
        import selfreport
        import run
        F = run.faults()
        rules, scan = F.helpers()

        class Leaky:
            def __getattr__(self, name):
                return getattr(F, name)

            @staticmethod
            def mask_secrets(text, rules_, scan_):
                return text  # as if the masking had missed it

        with self.assertRaises(selfreport.ReportError):
            selfreport.checked(Leaky(), "title", "body with ghp_" + "A" * 36)
        self.assertEqual(selfreport.checked(F, "title", "plain words"), ["title", "plain words"])


class WhoCallsItTest(unittest.TestCase):
    def test_only_run_py_loads_the_report_and_nothing_unattended_names_it(self):
        loaders, writers = [], []
        for top in ("skills", "agents", "workflows", "bin", "templates"):
            for path in sorted((ROOT / top).rglob("*")):
                if not path.is_file() or "__pycache__" in path.parts:
                    continue
                text = path.read_text(encoding="utf-8", errors="ignore")
                if re.search(r"^\s*(import selfreport|from selfreport import)", text, re.MULTILINE):
                    loaders.append(str(path.relative_to(ROOT)))
                if re.search(r"\.mark_reported\(|\.unreported\(", text):
                    writers.append(str(path.relative_to(ROOT)))
        self.assertEqual(loaders, ["skills/run/scripts/run.py"])
        self.assertEqual(sorted(writers), ["skills/run/scripts/run.py", "skills/run/scripts/selfreport.py"])
        unattended = [ROOT / "workflows" / "belt.js", *sorted((ROOT / "agents").glob("*.md"))]
        unattended += [ROOT / "skills" / "run" / "scripts" / name for name in ("supervisor.py", "executor.py", "service.py", "intake.py", "monitoring.py", "pull.py", "schedule.py")]
        unattended += [path for path in sorted((ROOT / "skills").glob("*/SKILL.md")) if path.parent.name != "run"]
        for path in unattended:
            text = path.read_text(encoding="utf-8")
            self.assertNotRegex(text, r"\breport --confirm|\breport\b[^\n]*--yes|selfreport|cmd_report", str(path.relative_to(ROOT)))

    def test_the_skill_says_to_show_everything_and_ask_first(self):
        text = (ROOT / "skills" / "run" / "SKILL.md").read_text(encoding="utf-8")
        section = text.split("### Reporting a problem in MACH", 1)[1].split("\n### ", 1)[0]
        for words in ("in full", "public repository", "--confirm", "Never add", "supervised"):
            self.assertIn(words, section)


if __name__ == "__main__":
    unittest.main()
