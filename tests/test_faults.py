"""MACH's own internal errors, recorded on this machine (M14 part E): skills/intent/scripts/faults.py.

What is held here:
- every MACH script with an entry point carries the two-line wrapper, and the wrapper finds faults.py from where the
  script lives (the plugin's layout and a project install's);
- recording changes no exit code, stdout or stderr: for a crash, a refusal, a usage error, a stop and a success;
- only an internal error is recorded; one file per fingerprint, counted when it recurs, at most MAX_RECORDS kept,
  private, ignored by Git, and nothing at all where there is no .factory folder; a failure to record is silent;
- a record never holds argument values, the project's repository or organisation names, ticket IDs or titles, spec
  text, file contents, environment values, the user's name or home folder, the host name, a webhook address or a token.

The crash scripts here are written into a throwaway copy of MACH's layout (skills/<skill>/scripts/) beside a copy of
faults.py and the two helpers it redacts with, so each is one of "MACH's own scripts" to the helper.
"""
import getpass
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FAULTS = ROOT / "skills" / "intent" / "scripts" / "faults.py"
MAIN_GUARD = 'if __name__ == "__main__":'


def wrapper_lines():
    """The two lines faults.py's own documentation gives, exactly as a script carries them."""
    text = FAULTS.read_text(encoding="utf-8")
    lines = [line for line in text.splitlines() if line.startswith("        import contextlib as _c") or line.startswith("        with _c.suppress")]
    assert len(lines) == 2, lines
    return [line[4:] for line in lines]


def entry_points():
    """Every MACH script that can be run: any file under skills/*/scripts/ or bin/ with a __main__ block."""
    files = sorted((ROOT / "skills").glob("*/scripts/*.py")) + sorted(path for path in (ROOT / "bin").iterdir() if path.is_file())
    return [path for path in files if MAIN_GUARD in path.read_text(encoding="utf-8", errors="ignore")]


class WrapperPresenceTest(unittest.TestCase):
    def test_every_entry_point_is_wrapped(self):
        """A new script (a new station, the idea skill, the evals) passes by adding the two lines from faults.py's docstring
        between `if __name__ == "__main__":` and `sys.exit(main())`."""
        first, second = wrapper_lines()
        missing = []
        for path in entry_points():
            block = path.read_text(encoding="utf-8").split(MAIN_GUARD, 1)[1].splitlines()[1:4]
            body = [line.strip() for line in block]
            if body[0] != first.strip() or not (body[1].startswith("with _c.suppress(Exception): _r.run_path(") and body[1].endswith('["install"](__file__)'))\
                    or "faults.py" not in body[1] or body[2] != "sys.exit(main())":
                missing.append(str(path.relative_to(ROOT)))
        self.assertEqual(missing, [], "add the two lines from skills/intent/scripts/faults.py's docstring to each of these entry points")
        self.assertGreaterEqual(len(entry_points()), 15)

    def test_skill_scripts_carry_the_documented_line_exactly(self):
        _, second = wrapper_lines()
        for path in entry_points():
            if path.parent.name == "scripts":
                self.assertIn("    " + second.strip() + "\n", path.read_text(encoding="utf-8"), path.name)

    def test_the_wrapper_finds_the_helper_from_every_script(self):
        for path in entry_points():
            base = os.path.abspath(path)
            if path.parent.name == "scripts":
                candidates = [os.path.join(base.rsplit(os.sep, 3)[0], d, "scripts", "faults.py") for d in ("intent", "mach-intent")]
            else:
                candidates = [os.path.join(base.rsplit(os.sep, 2)[0], *d, "scripts", "faults.py") for d in (("skills", "intent"), ("..", ".claude", "skills", "mach-intent"))]
            self.assertTrue(any(os.path.isfile(p) for p in candidates), path)

    def test_the_project_install_layout_is_found(self):
        """Installed into a project the intent skill is .claude/skills/mach-intent and the installer's copy is .factory/bin/mach."""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / ".claude/skills/mach-intent/scripts").mkdir(parents=True)
            (project / ".claude/skills/mach/scripts").mkdir(parents=True)
            (project / ".factory/bin").mkdir(parents=True)
            (project / ".claude/skills/mach-intent/scripts/faults.py").write_text("")
            run_py = str(project / ".claude/skills/mach/scripts/run.py")
            mach = str(project / ".factory/bin/mach")
            found = [p for p in (os.path.join(run_py.rsplit(os.sep, 3)[0], d, "scripts", "faults.py") for d in ("intent", "mach-intent")) if os.path.isfile(p)]
            self.assertEqual(len(found), 1)
            found = [p for p in (os.path.join(mach.rsplit(os.sep, 2)[0], *d, "scripts", "faults.py") for d in (("skills", "intent"), ("..", ".claude", "skills", "mach-intent"))) if os.path.isfile(p)]
            self.assertEqual(len(found), 1)


DEMO = '''import argparse, os, sys


class DemoError(Exception):
    """This script's own refusal."""


def main():
    parser = argparse.ArgumentParser(prog="demo")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("explode")
    p.add_argument("ticket")
    p.add_argument("--title")
    for name in ("refuse", "stop", "interrupt", "pipe", "fine", "uncaught-refusal"):
        sub.add_parser(name)
    args = parser.parse_args()
    if args.command == "fine":
        print("all well")
        return 0
    if args.command == "refuse":
        try:
            raise DemoError("no")
        except DemoError as exc:
            print(f"refused: {exc}", file=sys.stderr)
            return 1
    if args.command == "uncaught-refusal":
        raise DemoError("a gate said no")
    if args.command == "stop":
        raise SystemExit(3)
    if args.command == "interrupt":
        raise KeyboardInterrupt()
    if args.command == "pipe":
        raise BrokenPipeError()
    spec_text = open(os.environ["DEMO_SPEC"], encoding="utf-8").read().strip()
    token, hook = os.environ["DEMO_TOKEN"], os.environ["DEMO_HOOK"]
    raise RuntimeError(f"cannot read {args.ticket} titled {args.title} for {spec_text} with {token} via {hook} in {os.getcwd()} "
                       f"for {getpass_user()} on {host()} below {os.path.expanduser('~')}")


def getpass_user():
    import getpass
    return getpass.getuser()


def host():
    import socket
    return socket.gethostname()


if __name__ == "__main__":
@@WRAPPER@@
    sys.exit(main())
'''


class Layout:
    """A throwaway copy of MACH's layout, with the demo script as one of its scripts, and a project beside it."""

    def __init__(self, tmp: Path, with_helper: bool = True):
        self.tmp = tmp
        skills = tmp / "mach" / "skills"
        for folder in ("intent", "ticket", "demo"):
            (skills / folder / "scripts").mkdir(parents=True)
        if with_helper:
            shutil.copy(FAULTS, skills / "intent/scripts/faults.py")
        shutil.copy(ROOT / "skills/intent/scripts/scan.py", skills / "intent/scripts/scan.py")
        shutil.copy(ROOT / "skills/ticket/scripts/issue_rules.py", skills / "ticket/scripts/issue_rules.py")
        (tmp / "mach" / ".claude-plugin").mkdir()
        (tmp / "mach" / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "mach", "version": "9.8.7"}))
        self.script = skills / "demo/scripts/demo.py"
        self.script.write_text(DEMO.replace("@@WRAPPER@@", "\n".join("    " + line.strip() for line in wrapper_lines())))
        self.project = tmp / "work" / "acme-orbital-ledger"
        (self.project / ".factory" / "tickets").mkdir(parents=True)
        self.spec = tmp / "spec.md"
        self.spec.write_text("Zebrafish quarterly ledgers reconcile for Quillmont patrons ghp_" + "R" * 36 + "\n")

    def run(self, *argv, cwd=None, env=None):
        environment = {**os.environ, "DEMO_SPEC": str(self.spec), "DEMO_TOKEN": "ghp_" + "Q" * 36,
                       "DEMO_HOOK": "https://hooks.example.test/services/T000/B000/zyxwvut", **(env or {})}
        environment.pop("MACH_EXECUTION_ID", None)
        environment.update(env or {})
        return subprocess.run([sys.executable, str(self.script), *argv], cwd=str(cwd or self.project), env=environment, capture_output=True, text=True)

    def records(self):
        folder = self.project / ".factory" / "local" / "faults"
        return sorted(folder.glob("*.json")) if folder.is_dir() else []


class RecordingTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.mach = Layout(self.tmp / "a")
        self.bare = Layout(self.tmp / "b", with_helper=False)  # the same script with no helper beside it: the wrapper does nothing

    def same(self, *argv, env=None):
        """Run with and without the helper: the exit code, stdout and stderr must be the same, apart from the folder names."""
        with_it = self.mach.run(*argv, env=env)
        without = self.bare.run(*argv, env=env)
        self.assertEqual(with_it.returncode, without.returncode, argv)
        self.assertEqual(with_it.stdout, without.stdout.replace(str(self.tmp / "b"), str(self.tmp / "a")), argv)
        self.assertEqual(with_it.stderr.replace(str(self.tmp / "a"), "<tmp>"), without.stderr.replace(str(self.tmp / "b"), "<tmp>"), argv)
        return with_it

    def test_a_crash_is_recorded_and_nothing_it_prints_or_returns_changes(self):
        done = self.same("explode", "ACME-7", "--title", "Orbital invoices")
        self.assertEqual(done.returncode, 1)
        self.assertIn("Traceback (most recent call last)", done.stderr)
        self.assertIn("RuntimeError: cannot read ACME-7", done.stderr)
        (path,) = self.mach.records()
        record = json.loads(path.read_text())
        self.assertEqual(record["schema"], 1)
        self.assertEqual(record["script"], "demo/scripts/demo.py")
        self.assertEqual(record["command"], ["explode"])
        self.assertEqual(record["exception"], "RuntimeError")
        self.assertEqual(record["mach"], {"version": "9.8.7", "install": "plugin"})
        self.assertEqual([frame["function"] for frame in record["traceback"]], ["<module>", "main"])
        self.assertTrue(all(frame["file"] == "demo/scripts/demo.py" and frame["line"] > 0 for frame in record["traceback"]))
        self.assertEqual(record["count"], 1)
        self.assertIsNone(record["reported"])
        self.assertFalse(record["supervised"])
        self.assertEqual(path.name, record["id"] + ".json")
        self.assertEqual(record["fingerprint"][:12], record["id"])
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual((path.parent / ".gitignore").read_text(), "*\n")
        self.assertTrue(record["message"].startswith("cannot read <"), record["message"])
        self.assertEqual(self.bare.records(), [])

    def test_refusals_stops_usage_errors_and_successes_are_not_recorded_and_unchanged(self):
        self.assertEqual(self.same("fine").stdout, "all well\n")
        self.assertEqual(self.same("refuse").returncode, 1)
        self.assertEqual(self.same("stop").returncode, 3)
        self.assertEqual(self.same("--no-such-option").returncode, 2)
        self.assertEqual(self.same("uncaught-refusal").returncode, 1)  # MACH's own class: a gate's refusal, never a fault
        self.same("interrupt")
        self.same("pipe")
        self.assertEqual(self.mach.records(), [])

    def test_the_same_fault_again_is_counted_not_filed_twice(self):
        self.mach.run("explode", "ACME-7")
        first = json.loads(self.mach.records()[0].read_text())
        self.mach.run("explode", "ACME-8", "--title", "Other words", env={"MACH_EXECUTION_ID": "x0123456789ab"})
        (path,) = self.mach.records()
        record = json.loads(path.read_text())
        self.assertEqual(record["count"], 2)
        self.assertEqual(record["first_seen"], first["first_seen"])
        self.assertTrue(record["supervised"])

    def test_at_most_the_cap_is_kept_and_reported_ones_go_first(self):
        sys.path.insert(0, str(FAULTS.parent))
        import faults
        folder = self.mach.project / ".factory" / "local" / "faults"
        folder.mkdir(parents=True)
        for index in range(faults.MAX_RECORDS):
            ident = f"{index:012x}"
            data = {"schema": 1, "id": ident, "fingerprint": ident + "0" * 52, "count": 1, "first_seen": "2026-01-01T00:00:00Z",
                    "last_seen": f"2026-01-{index % 28 + 1:02d}T00:00:00Z", "reported": {"url": "x"} if index == 40 else None}
            (folder / f"{ident}.json").write_text(json.dumps(data))
        self.mach.run("explode", "ACME-7")
        names = {path.name for path in self.mach.records()}
        self.assertEqual(len(names), faults.MAX_RECORDS)
        self.assertNotIn(f"{40:012x}.json", names)  # the reported one went first
        self.assertTrue(any(json.loads(p.read_text()).get("exception") == "RuntimeError" for p in self.mach.records()))

    def test_nothing_is_recorded_without_a_factory_folder(self):
        elsewhere = self.tmp / "plain"
        elsewhere.mkdir()
        done = self.mach.run("explode", "ACME-7", cwd=elsewhere)
        self.assertEqual(done.returncode, 1)
        self.assertEqual(list(elsewhere.rglob("*")), [])

    def test_a_failure_to_record_is_silent(self):
        (self.mach.project / ".factory" / "local").write_text("in the way")
        (self.bare.project / ".factory" / "local").write_text("in the way")
        self.same("explode", "ACME-7")
        self.assertEqual((self.mach.project / ".factory" / "local").read_text(), "in the way")

    def test_a_record_holds_nothing_of_the_person_the_project_or_the_machine(self):
        project = self.mach.project
        subprocess.run(["git", "init", "-q", str(project)], check=True)
        subprocess.run(["git", "-C", str(project), "remote", "add", "origin", "git@github.com:quorvex-industries/hollowmere-billing.git"], check=True)
        (project / ".factory" / "tickets" / "ACME-7.md").write_text("---\nid: ACME-7\ntitle: Orbital invoices for Vantablue\nstate: open\n---\nBody of the ticket.\n")
        values = {"ticket": "ACME-7", "title": "Orbital invoices for Vantablue", "spec": "Zebrafish", "spec2": "Quillmont",
                  "token": "ghp_" + "Q" * 36, "hook": "hooks.example.test", "hook2": "zyxwvut", "env": "Plumbago-Nightjar-41",
                  "org": "quorvex-industries", "repo": "hollowmere-billing", "folder": "acme-orbital-ledger",
                  "user": getpass.getuser(), "home": os.path.expanduser("~"), "host": socket.gethostname().split(".")[0]}
        done = self.mach.run("explode", "ACME-7", "--title", values["title"], env={"DEMO_EXTRA": values["env"], "DEMO_TOKEN": values["token"] + " " + values["env"]})
        self.assertEqual(done.returncode, 1)
        for planted in (values["title"], values["env"], values["user"]):
            self.assertIn(planted, done.stderr)  # Python's own traceback still says everything, unchanged
        (path,) = self.mach.records()
        text = path.read_text()
        for name, value in values.items():
            self.assertNotIn(value.lower(), text.lower(), name)
        self.assertNotIn("ghp_", text)  # a token read from a file, known to nobody: masked by its shape
        self.assertNotIn("Body of the ticket", text)
        self.assertNotIn("        raise RuntimeError", text)  # no source line
        message = json.loads(text)["message"]
        self.assertIn("<value>", message)
        self.assertIn("<redacted>", message)


MIXED_CALLER = '''import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "@@TICKET@@", "scripts"))
import issue_rules


def main():
    if sys.argv[1:] == ["missing"]:
        return issue_rules.slice_ready_event([])
    if sys.argv[1:] == ["import"]:
        from issue_rules import needs_none_problems  # noqa: F401
    if sys.argv[1:] == ["own-bug"]:
        return os.no_such_thing
    return 0


if __name__ == "__main__":
@@WRAPPER@@
    sys.exit(main())
'''


class MixedVersionsTest(unittest.TestCase):
    """Where the installer put MACH in a project and one of its scripts is from another version than the script that
    calls it, the person is told to run the installer again: no traceback, nothing recorded, nothing to report. In this
    repository's layout (and a plugin's) the same error is a defect and is recorded."""

    def layout(self, installed: bool):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        project = Path(tmp.name) / "proj"
        prefix = "mach-" if installed else ""
        skills = project / ".claude" / "skills" if installed else Path(tmp.name) / "mach" / "skills"
        for folder in ("intent", "ticket", "demo"):
            (skills / (prefix + folder) / "scripts").mkdir(parents=True)
        shutil.copy(FAULTS, skills / (prefix + "intent") / "scripts" / "faults.py")
        shutil.copy(ROOT / "skills/intent/scripts/scan.py", skills / (prefix + "intent") / "scripts" / "scan.py")
        (skills / (prefix + "ticket") / "scripts" / "issue_rules.py").write_text("OLDER = True\n")  # an older copy: the newer names are missing
        script = skills / (prefix + "demo") / "scripts" / "demo.py"
        script.write_text(MIXED_CALLER.replace("@@TICKET@@", prefix + "ticket").replace("@@WRAPPER@@", "\n".join("    " + line.strip() for line in wrapper_lines())))
        (project / ".factory" / "tickets").mkdir(parents=True)
        (project / ".factory" / ".mach-manifest.json").write_text(json.dumps({"version": "0.20.0", "files": {}}))
        env = {**os.environ}
        env.pop("MACH_EXECUTION_ID", None)

        def run(*argv):
            return subprocess.run([sys.executable, str(script), *argv], cwd=str(project), env=env, capture_output=True, text=True)

        return run, project / ".factory" / "local" / "faults", skills / (prefix + "intent") / "scripts"

    def test_an_installed_project_is_told_to_run_the_installer_again(self):
        run, faults, _ = self.layout(installed=True)
        for argv in (["missing"], ["import"]):
            done = run(*argv)
            self.assertEqual(done.returncode, 1, argv)
            self.assertEqual(done.stderr.strip(), "MACH: MACH's files in this project are from different versions; run the installer again.", argv)
            self.assertFalse(faults.is_dir() and list(faults.glob("*.json")), argv)

    def test_another_error_in_an_installed_project_is_still_recorded(self):
        run, faults, _ = self.layout(installed=True)
        done = run("own-bug")
        self.assertEqual(done.returncode, 1)
        self.assertIn("AttributeError", done.stderr)
        self.assertEqual(len(list(faults.glob("*.json"))), 1)

    def test_in_the_repository_layout_the_same_error_is_a_defect(self):
        run, faults, _ = self.layout(installed=False)
        done = run("missing")
        self.assertEqual(done.returncode, 1)
        self.assertIn("Traceback", done.stderr)
        self.assertEqual(len(list(faults.glob("*.json"))), 1)

    def test_a_record_of_it_from_an_earlier_version_is_no_longer_offered(self):
        _, faults, helper = self.layout(installed=True)
        faults.mkdir(parents=True)
        base = {"schema": 1, "first_seen": "2026-11-23T10:00:00Z", "last_seen": "2026-11-23T10:00:00Z",
                "count": 2, "reported": None, "script": "ticket/scripts/ticket.py", "command": ["slice-check"], "exception": "AttributeError",
                "message": "module 'issue_rules' has no attribute 'slice_ready_event'", "traceback": []}
        for ident, extra in (("96424cb9f8c4", {"mach": {"version": "0.19.1", "install": "project"}}),
                             ("aaaaaaaaaaaa", {"mach": {"version": "0.20.0", "install": "project"}}),
                             ("bbbbbbbbbbbb", {"exception": "KeyError", "message": "'x'", "mach": {"version": "0.19.1", "install": "project"}})):
            (faults / (ident + ".json")).write_text(json.dumps({**base, "id": ident, "fingerprint": ident + "0" * 52, **extra}))
        code = "import sys, json; sys.path.insert(0, sys.argv[1]); import faults; print(json.dumps(sorted(i['id'] for i in faults.unreported(sys.argv[2]))))"
        done = subprocess.run([sys.executable, "-c", code, str(helper), str(faults.parents[2])], capture_output=True, text=True)
        self.assertEqual(json.loads(done.stdout), ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], done.stderr)


class RealScriptTest(unittest.TestCase):
    """The wrapper in a real station script, in this repository's own layout: run.py status meeting a ticket file
    that is a folder is an internal error (IsADirectoryError), and the next status offers to report it."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.project = Path(tmp.name) / "proj"
        (self.project / ".factory" / "tickets").mkdir(parents=True)
        (self.project / ".factory" / "config.json").write_text("{}")
        bin_dir = Path(tmp.name) / "bin"
        bin_dir.mkdir()
        (bin_dir / "git").symlink_to(shutil.which("git"))
        self.env = {**os.environ, "PATH": str(bin_dir)}  # git only: the doctor asks no other program here
        self.env.pop("MACH_EXECUTION_ID", None)

    def run_py(self, *argv, env=None):
        return subprocess.run([sys.executable, str(ROOT / "skills/run/scripts/run.py"), "--project", str(self.project), *argv],
                              cwd=str(self.project), env={**self.env, **(env or {})}, capture_output=True, text=True)

    def crash(self):
        (self.project / ".factory" / "tickets" / "BROKEN-1.md").mkdir()
        done = self.run_py("status")
        self.assertEqual(done.returncode, 1)
        self.assertIn("IsADirectoryError", done.stderr)
        (self.project / ".factory" / "tickets" / "BROKEN-1.md").rmdir()

    def test_a_real_crash_is_recorded_and_offered_once(self):
        before = json.loads(self.run_py("status").stdout)
        self.assertNotIn("faults", before["digest"])
        self.crash()
        (path,) = sorted((self.project / ".factory/local/faults").glob("*.json"))
        record = json.loads(path.read_text())
        self.assertEqual((record["script"], record["command"], record["exception"]), ("run/scripts/run.py", ["status"], "IsADirectoryError"))
        self.assertIn("run/scripts/run.py", {frame["file"] for frame in record["traceback"]})
        self.assertIn("cmd_status", {frame["function"] for frame in record["traceback"]})
        self.assertNotIn("BROKEN-1", path.read_text())
        self.assertNotIn(str(self.project), path.read_text())
        after = json.loads(self.run_py("status").stdout)
        self.assertEqual(after["digest"]["faults"], "MACH hit 1 internal error on this machine. /mach:run report shows what would be sent.")
        doctor = self.run_py("doctor")
        self.assertEqual(doctor.stdout.count("MACH hit 1 internal error on this machine."), 1)
        self.assertIn(record["id"] + " (IsADirectoryError in run.py status, 1 time)", doctor.stdout)
        checks = {c["id"]: c for c in json.loads(self.run_py("doctor", "--json").stdout)["checks"]}
        self.assertEqual(checks["faults"]["status"], "warn")

    def test_switched_off_there_is_no_offer(self):
        self.crash()
        (self.project / ".factory" / "config.json").write_text(json.dumps({"report": {"enabled": False}}))
        self.assertNotIn("faults", json.loads(self.run_py("status").stdout)["digest"])
        self.assertNotIn("internal error", self.run_py("doctor").stdout)

    def test_inside_a_supervised_execution_nothing_is_offered(self):
        sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
        import run
        from unittest import mock
        self.crash()
        self.assertTrue(run.unreported_faults(self.project, {}))
        with mock.patch.dict(os.environ, {"MACH_EXECUTION_ID": "x0123456789ab"}):
            self.assertIsNone(run.unreported_faults(self.project, {}))
        self.assertIsNone(run.unreported_faults(self.project, {"report": {"enabled": False}}))


if __name__ == "__main__":
    unittest.main()
