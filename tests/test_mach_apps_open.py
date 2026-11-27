"""/mach-studio and /mach floor: MACH's two web apps, Product Studio and the Factory Floor, opened in the person's
browser, always the release of MACH installed in the project. skills/run/scripts/app.py decides every step, and the
studio and run skills run it first (`for-skill`) with the words typed after the command; these tests replace what would
start a program, signal one, read the process table or open a browser, so nothing here starts a real host or a browser."""

import fcntl
import importlib.util
import io
import json
import os
import re
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "skills" / "run" / "scripts" / "app.py"
_spec = importlib.util.spec_from_file_location("mach_app", SCRIPT)
app = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(app)

TOKEN = "A" * 43


def link(port, n=0):
    return f"http://127.0.0.1:{port}/?t={TOKEN[:-3]}{n:03d}"


class World:
    """A stand-in computer: which programs exist and what they say, what runs, what a browser did."""

    def __init__(self, test, project, root):
        self.test, self.project, self.root = test, project, root
        self.versions = {}          # program path -> what its --version says
        self.running = {}           # app key -> {"pid", "version", "program", "ours"}
        self.next_pid = 5000
        self.started = []           # argv of each start
        self.signalled = []
        self.opened = []
        self.open_fails = None
        self.installer_calls = []
        self.installer_answer = None  # callable(argv) -> (code, out, err), or None: "nothing to do"
        self.stops_on_signal = True
        self.processes = []         # extra (pid, command) rows for ps

    def folder(self, a):
        return self.project / a.folder

    def install(self, a, version, here=True):
        path = (self.project / ".factory" / "bin" / a.program) if here else (self.root / a.build)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/bin/sh\n")
        self.versions[str(path)] = version
        return path

    def run_already(self, a, version, ours=True, host_file=True, port=4100):
        pid = self.next_pid
        self.next_pid += 1
        self.running[a.key] = {"pid": pid, "version": version, "program": a.program if ours else "something-else"}
        folder = self.folder(a)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "lock").write_text("")
        if host_file:
            (folder / "host.json").write_text(json.dumps({"program": a.program, "version": version, "pid": pid, "port": port}))
        (folder / "link").write_text(link(port) + "\n")
        return pid

    # ---- the replaced functions ----

    def program_version(self, path):
        return self.versions.get(str(path))

    def start_detached(self, argv, cwd, log):
        self.test.assertEqual(Path(cwd), self.project)
        self.started.append(argv)
        a = next(x for x in app.APPS.values() if Path(argv[0]).name == x.program)
        pid = self.next_pid
        self.next_pid += 1
        port = 4200 + len(self.started)
        self.running[a.key] = {"pid": pid, "version": self.versions.get(argv[0]), "program": a.program}
        folder = self.folder(a)
        (folder / "lock").write_text("")
        (folder / "host.json").write_text(json.dumps({"program": a.program, "version": self.versions.get(argv[0]), "pid": pid, "port": port}))
        (folder / "link").write_text(link(port) + "\n")
        return pid

    def by_pid(self, pid):
        return next(((key, info) for key, info in self.running.items() if info["pid"] == pid), (None, None))

    def process_alive(self, pid):
        return self.by_pid(pid)[1] is not None or any(p == pid for p, _ in self.processes)

    def command_line(self, pid):
        key, info = self.by_pid(pid)
        if info is None:
            return next((words for p, words in self.processes if p == pid), "")
        return f"/somewhere/{info['program']} --project {self.project} --no-open"

    def all_processes(self):
        rows = [(info["pid"], self.command_line(info["pid"])) for info in self.running.values()]
        return rows + list(self.processes)

    def signal_process(self, pid):
        self.signalled.append(pid)
        if self.stops_on_signal:
            key, _ = self.by_pid(pid)
            del self.running[key]
            for name in ("host.json", "link"):
                (self.folder(app.APPS[key]) / name).unlink(missing_ok=True)

    def lock_held(self, path):
        key = next((a.key for a in app.APPS.values() if path == self.project / a.folder / "lock"), None)
        return key in self.running

    def open_in_browser(self, url):
        if self.open_fails:
            return self.open_fails
        self.opened.append(url)
        # The program trades the link and keeps the next one.
        for a in app.APPS.values():
            path = self.folder(a) / "link"
            if path.is_file() and path.read_text().strip() == url:
                path.write_text(url[:-3] + "999\n")
        return None

    def run_installer(self, path, argv):
        self.installer_calls.append(argv)
        if self.installer_answer:
            return self.installer_answer(argv)
        name = argv[argv.index("--only") + 1]
        here = self.project / ".factory" / "bin" / name
        result = {"name": name, "path": str(here), "version": self.versions.get(str(here)), "updated": False, "checked": None, "problem": None}
        return 0, json.dumps({"version": argv[argv.index("--release") + 1], "programs": [result], "newer": None}), ""


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name).resolve()
        self.project = base / "project"
        (self.project / ".factory" / "bin").mkdir(parents=True)
        self.root = base / "mach"
        (self.root / ".claude-plugin").mkdir(parents=True)
        (self.root / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "mach", "version": "0.26.0"}))
        self.world = World(self, self.project, self.root)
        replaced = {"mach_root": lambda: self.root, "installer": lambda root, project: root / "bin" / "mach"}
        for name in ("program_version", "start_detached", "process_alive", "command_line", "all_processes", "signal_process",
                     "lock_held", "open_in_browser", "run_installer"):
            replaced[name] = getattr(self.world, name)
        for name, value in replaced.items():
            previous = getattr(app, name)
            setattr(app, name, value)
            self.addCleanup(setattr, app, name, previous)
        for name, value in (("START_WAIT", 2.0), ("STOP_WAIT", 1.0), ("FRESH_WAIT", 0.5), ("POLL", 0.01)):
            previous = getattr(app, name)
            setattr(app, name, value)
            self.addCleanup(setattr, app, name, previous)

    def mach_app(self, *words):
        out = io.StringIO()
        with redirect_stdout(out):
            code = app.main([*words, "--project", str(self.project), "--json"])
        return code, json.loads(out.getvalue())

    def said(self, result):
        return "\n".join(result["in_words"])


class ChoosingTheProgramTest(Base):
    def test_the_installed_release_is_started_and_opened(self):
        program = self.world.install(app.STUDIO, "0.26.0")
        code, result = self.mach_app()
        self.assertEqual(code, 0, result)
        self.assertEqual((result["running"], result["version"], result["opened"], result["program"]), ("started", "0.26.0", True, str(program)))
        argv = self.world.started[0]
        self.assertEqual(argv[:3], [str(program), "--project", str(self.project)])
        self.assertIn("--no-open", argv)
        self.assertEqual(Path(argv[argv.index("--engine") + 1]).name, "studio.py")
        self.assertEqual(self.world.opened, [link(4201)])
        self.assertEqual(result["link"], link(4201)[:-3] + "999", "after opening, the answer gives the fresh link, never the spent one")
        self.assertEqual(result["in_words"][0], "Product Studio 0.26.0 is open in your browser.")
        self.assertEqual(result["in_words"][-1], f"For another browser on this computer, this link works once: {result['link']}")
        self.assertIsNone(result["problem"])
        self.assertEqual(result["log"], str(self.project / ".factory/local/studio/app.log"))

    def test_the_text_answer_is_only_the_sentences(self):
        self.world.install(app.STUDIO, "0.26.0")
        out = io.StringIO()
        with redirect_stdout(out):
            code = app.main(["--project", str(self.project)])
        self.assertEqual(code, 0)
        self.assertEqual(out.getvalue().splitlines(), ["Product Studio 0.26.0 is open in your browser.",
                                                       f"For another browser on this computer, this link works once: {link(4201)[:-3]}999"])

    def test_a_checkout_build_of_this_release_is_used_before_the_project_copy(self):
        self.world.install(app.STUDIO, "0.24.0")
        built = self.world.install(app.STUDIO, "dev", here=False)
        code, result = self.mach_app()
        self.assertEqual((code, result["program"], result["version"]), (0, str(built), "dev"))
        self.assertEqual(self.world.installer_calls, [], "a local build is used as it is; nothing is fetched")
        self.assertEqual(result["in_words"][0], "Product Studio (a local build) is open in your browser.")

    def test_a_checkout_build_of_another_release_is_passed_over(self):
        self.world.install(app.STUDIO, "0.25.0", here=False)
        here = self.world.install(app.STUDIO, "0.26.0")
        code, result = self.mach_app()
        self.assertEqual((code, result["program"]), (0, str(here)))

    def test_the_installers_programs_command_is_asked_for_this_release(self):
        self.world.install(app.STUDIO, "0.26.0")
        self.mach_app()
        self.assertEqual(self.world.installer_calls, [["programs", "--project", str(self.project), "--only", "mach-studio",
                                                       "--release", "0.26.0", "--json", "--newer"]])

    def test_a_project_install_takes_its_release_from_the_install_record(self):
        (self.root / ".claude-plugin" / "plugin.json").unlink()
        (self.project / ".factory/.mach-manifest.json").write_text(json.dumps({"version": "0.25.1"}))
        self.world.install(app.STUDIO, "0.25.1")
        code, result = self.mach_app()
        self.assertEqual((code, result["version"]), (0, "0.25.1"))
        self.assertIn("--release", self.world.installer_calls[0])
        self.assertEqual(self.world.installer_calls[0][self.world.installer_calls[0].index("--release") + 1], "0.25.1")


class BringingItUpToDateTest(Base):
    def answer(self, updated=False, problem=None, newer=None, new_version=None):
        def respond(argv):
            here = self.project / ".factory/bin/mach-studio"
            if updated:
                self.world.versions[str(here)] = new_version or "0.26.0"
            result = {"name": "mach-studio", "path": str(here), "version": self.world.versions.get(str(here)), "updated": updated,
                      "checked": "checked against the release's checksum" if updated else None, "problem": problem}
            return 0, json.dumps({"version": "0.26.0", "programs": [result], "newer": newer}), ""
        self.world.installer_answer = respond

    def test_an_older_program_is_replaced_after_a_verified_download(self):
        self.world.install(app.STUDIO, "0.24.0")
        self.answer(updated=True)
        code, result = self.mach_app()
        self.assertEqual(code, 0, result)
        self.assertEqual((result["version"], result["updated_program"], result["running"]), ("0.26.0", True, "started"))
        self.assertNotIn("not 0.26.0", self.said(result))

    def test_a_failed_check_keeps_the_older_program_and_says_how_to_update(self):
        self.world.install(app.STUDIO, "0.24.0")
        self.answer(problem="MACH could not fetch it: mach-studio-darwin-arm64 does not match the release's published checksum, so it was refused.")
        code, result = self.mach_app()
        self.assertEqual(code, 0, "the program that is here still opens")
        self.assertEqual((result["version"], result["updated_program"]), ("0.24.0", False))
        self.assertIn("This Product Studio is for MACH 0.24.0, not 0.26.0 (MACH could not fetch it: mach-studio-darwin-arm64 does not match the release's "
                      "published checksum, so it was refused). Running MACH's installer again brings it up to date.", result["in_words"])
        self.assertIn("refused", result["problem"])

    def test_no_network_starts_the_program_that_is_here(self):
        self.world.install(app.STUDIO, "0.24.0")
        self.answer(problem="MACH could not fetch it: SHA256SUMS could not be downloaded; check the internet connection.")
        code, result = self.mach_app()
        self.assertEqual((code, result["running"], result["version"]), (0, "started", "0.24.0"))
        self.assertIn("check the internet connection", self.said(result))

    def test_no_program_and_no_build_for_this_machine_says_the_one_command(self):
        self.answer(problem="MACH could not fetch it: no build is published for Darwin x86_64.")
        code, result = self.mach_app()
        self.assertEqual(code, 1)
        self.assertEqual(result["in_words"], ["Product Studio is not installed on this computer (MACH could not fetch it: no build is published for Darwin x86_64). "
                                              "Running MACH's installer again in this project fetches it; then /mach:studio again."])
        self.assertEqual(self.world.started, [])

    def test_a_newer_release_is_mentioned_in_one_line(self):
        self.world.install(app.STUDIO, "0.26.0")
        self.answer(newer="0.27.0")
        code, result = self.mach_app()
        self.assertEqual(code, 0)
        self.assertEqual(result["in_words"][-1], "MACH 0.27.0 is available; this project has 0.26.0. Running MACH's installer again updates it.")

    def test_an_installer_that_cannot_answer_is_said_and_the_program_here_runs(self):
        self.world.install(app.STUDIO, "0.26.0")
        self.world.installer_answer = lambda argv: (2, "", "error: something went wrong")
        code, result = self.mach_app()
        self.assertEqual((code, result["version"]), (0, "0.26.0"))


class RunningOneTest(Base):
    def test_the_running_current_release_is_reused(self):
        self.world.install(app.STUDIO, "0.26.0")
        self.world.run_already(app.STUDIO, "0.26.0")
        code, result = self.mach_app()
        self.assertEqual(code, 0)
        self.assertEqual((result["running"], self.world.started, self.world.signalled), ("already", [], []))
        self.assertEqual(self.world.opened, [link(4100)])
        self.assertEqual(result["in_words"][:2], ["Product Studio 0.26.0 is open in your browser.", "It was already running."])

    def test_an_older_running_one_is_stopped_only_when_it_is_this_projects_and_then_replaced(self):
        self.world.install(app.STUDIO, "0.26.0")
        pid = self.world.run_already(app.STUDIO, "0.24.0")
        code, result = self.mach_app()
        self.assertEqual(code, 0, result)
        self.assertEqual((self.world.signalled, result["running"], result["version"]), ([pid], "replaced", "0.26.0"))
        self.assertIn("An older Product Studio (0.24.0) was running for this project; MACH stopped it and started 0.26.0.", result["in_words"])
        self.assertIn("Your drafts were saved as you wrote them; a reply the interviewer was still writing was stopped, and you can ask again.",
                      result["in_words"])

    def test_a_running_one_that_is_not_verifiably_this_projects_is_never_signalled(self):
        self.world.install(app.STUDIO, "0.26.0")
        self.world.run_already(app.STUDIO, "0.24.0", ours=False)
        code, result = self.mach_app()
        self.assertEqual(code, 0)
        self.assertEqual((self.world.signalled, self.world.started, result["running"]), ([], [], "already"))
        self.assertIn("MACH left it running because MACH cannot tell which process it is", self.said(result))

    def test_another_projects_studio_is_never_signalled(self):
        self.world.install(app.STUDIO, "0.26.0")
        pid = self.world.run_already(app.STUDIO, "0.24.0", host_file=False)
        self.world.running["studio"]["program"] = "mach-studio"
        self.world.command_line = lambda p: f"/x/mach-studio --project /elsewhere --no-open"
        app.command_line = self.world.command_line
        self.world.processes = [(pid, "/x/mach-studio --project /elsewhere --no-open")]
        self.world.all_processes = lambda: list(self.world.processes)
        app.all_processes = self.world.all_processes
        code, result = self.mach_app()
        self.assertEqual(self.world.signalled, [])

    def test_a_host_from_before_host_json_is_found_by_its_command_line_and_replaced(self):
        self.world.install(app.STUDIO, "0.26.0")
        pid = self.world.run_already(app.STUDIO, "0.24.0", host_file=False)
        code, result = self.mach_app()
        self.assertEqual((code, self.world.signalled, result["running"]), (0, [pid], "replaced"))
        self.assertIn("An older Product Studio (an earlier release) was running for this project; MACH stopped it and started 0.26.0.", result["in_words"])

    def test_an_older_program_here_never_replaces_a_running_newer_one(self):
        self.world.install(app.STUDIO, "0.24.0")
        self.world.installer_answer = lambda argv: (0, json.dumps({"version": "0.26.0", "programs": [{"updated": False, "problem": "No network."}], "newer": None}), "")
        self.world.run_already(app.STUDIO, "0.26.0")
        code, result = self.mach_app()
        self.assertEqual((code, self.world.signalled, result["running"], result["version"]), (0, [], "already", "0.26.0"))

    def test_a_stale_lock_and_host_file_are_taken_over(self):
        self.world.install(app.STUDIO, "0.26.0")
        self.world.run_already(app.STUDIO, "0.26.0")
        del self.world.running["studio"]  # the program is gone; its files are left
        code, result = self.mach_app()
        self.assertEqual((code, result["running"], self.world.signalled), (0, "started", []))

    def test_a_program_that_did_not_stop_is_left_running_and_said(self):
        self.world.install(app.STUDIO, "0.26.0")
        self.world.run_already(app.STUDIO, "0.24.0")
        self.world.stops_on_signal = False
        code, result = self.mach_app()
        self.assertEqual((code, result["running"], self.world.started), (0, "already", []))
        self.assertIn("did not stop within 1 seconds", self.said(result))

    def test_a_program_that_stops_as_it_starts_says_why(self):
        self.world.install(app.STUDIO, "0.26.0")

        def dies(argv, cwd, log):
            log.write_text("mach-studio: python3 was not found on PATH\n")
            return 9999
        app.start_detached = dies
        code, result = self.mach_app()
        self.assertEqual(code, 1)
        self.assertEqual(result["in_words"], ["Product Studio stopped as it started: python3 was not found on PATH. "
                                              "Its output is in .factory/local/studio/app.log."])


class BrowserAndWordsTest(Base):
    def test_the_browser_cannot_be_opened_the_link_is_given_and_it_is_still_success(self):
        self.world.install(app.STUDIO, "0.26.0")
        self.world.open_fails = "this computer has no browser opener MACH knows (open on macOS, xdg-open on Linux)"
        code, result = self.mach_app()
        self.assertEqual((code, result["opened"], result["link"]), (0, False, link(4201)))
        self.assertEqual(result["in_words"][0], "Product Studio 0.26.0 is running, but MACH could not open a browser here: "
                                                "this computer has no browser opener MACH knows (open on macOS, xdg-open on Linux).")
        self.assertEqual(result["in_words"][-1], f"Open this link in a browser on this computer; it works once: {link(4201)}")

    def test_no_browser_gives_the_link(self):
        self.world.install(app.STUDIO, "0.26.0")
        code, result = self.mach_app("--no-browser")
        self.assertEqual((code, result["opened"], self.world.opened, result["link"]), (0, False, [], link(4201)))
        self.assertEqual(result["in_words"][0], "Product Studio 0.26.0 is running on this computer.")

    def test_link_gives_a_fresh_link_without_a_browser(self):
        self.world.install(app.STUDIO, "0.26.0")
        self.world.run_already(app.STUDIO, "0.26.0")
        code, result = self.mach_app("link")
        self.assertEqual((code, self.world.opened, result["link"]), (0, [], link(4100)))
        self.assertEqual(result["in_words"], ["Product Studio 0.26.0 was already running on this computer.",
                                              f"Open this link in a browser on this computer; it works once: {link(4100)}"])

    def test_stop_stops_this_projects_one(self):
        pid = self.world.run_already(app.STUDIO, "0.26.0")
        code, result = self.mach_app("stop")
        self.assertEqual((code, self.world.signalled, result["in_words"]), (0, [pid], ["Product Studio is stopped."]))

    def test_stop_with_nothing_running(self):
        code, result = self.mach_app("stop")
        self.assertEqual((code, result["in_words"]), (0, ["Product Studio was not running for this project."]))

    def test_stop_never_signals_another_program(self):
        self.world.run_already(app.STUDIO, "0.26.0", ours=False)
        code, result = self.mach_app("stop")
        self.assertEqual((code, self.world.signalled), (1, []))
        self.assertIn("MACH did not stop it: MACH cannot tell which process it is.", self.said(result))

    def test_unknown_words_say_the_forms(self):
        code, result = self.mach_app("please", "dance")
        self.assertEqual(code, 2)
        self.assertEqual(result["in_words"], ["MACH did not understand 'please dance'. /mach:studio opens Product Studio; /mach:studio link gives its "
                                              "link without a browser; /mach:studio stop stops it. /mach:run floor, /mach:run floor link and "
                                              "/mach:run floor stop do the same for the Factory Floor."])

    def test_the_words_arrive_as_one_argument_from_the_skill(self):
        pid = self.world.run_already(app.STUDIO, "0.26.0")
        code, result = self.mach_app("stop ")
        self.assertEqual((code, self.world.signalled), (0, [pid]))
        code, result = self.mach_app("")
        self.assertEqual(result["action"], "open")

    def test_a_project_without_a_factory_folder_is_told_the_one_command(self):
        (self.project / ".factory/bin").rmdir()
        (self.project / ".factory").rmdir()
        code, result = self.mach_app()
        self.assertEqual(code, 1)
        self.assertIn("has no .factory folder", self.said(result))
        self.assertIn("Run MACH's installer in this project (or /mach:init with the plugin), then /mach:studio again.", self.said(result))

    def test_the_commands_are_named_as_this_install_types_them(self):
        self.assertEqual((app.command_name(self.root, app.STUDIO), app.command_name(self.root, app.FLOOR)), ("/mach:studio", "/mach:run floor"))
        project_install = self.project / ".claude"
        project_install.mkdir()
        self.assertEqual((app.command_name(project_install, app.STUDIO), app.command_name(project_install, app.FLOOR)), ("/mach-studio", "/mach floor"))


class FactoryFloorTest(Base):
    def test_the_floor_opens_the_same_way_with_its_own_options(self):
        program = self.world.install(app.FLOOR, "0.26.0")
        code, result = self.mach_app("floor")
        self.assertEqual((code, result["app"], result["running"]), (0, "floor", "started"))
        argv = self.world.started[0]
        self.assertEqual(argv[:3], [str(program), "--project", str(self.project)])
        self.assertNotIn("--engine", argv)
        self.assertNotIn("--no-open", argv)
        self.assertEqual(Path(argv[argv.index("--mach-run") + 1]).name, "run.py")
        self.assertEqual(result["in_words"][0], "The Factory Floor 0.26.0 is open in your browser.")
        self.assertEqual(self.world.installer_calls[0][4], "mach-observer")
        self.assertEqual(result["log"], str(self.project / ".factory/local/observer/app.log"))

    def test_an_older_floor_is_replaced_and_stop_stops_it(self):
        self.world.install(app.FLOOR, "0.26.0")
        pid = self.world.run_already(app.FLOOR, "0.25.0")
        code, result = self.mach_app("floor", "--no-browser")
        self.assertEqual((code, self.world.signalled, result["running"]), (0, [pid], "replaced"))
        self.assertIn("An older Factory Floor (0.25.0) was running for this project; MACH stopped it and started 0.26.0.", result["in_words"])
        self.assertNotIn("drafts", self.said(result))
        code, result = self.mach_app("stop", "floor")
        self.assertEqual(result["in_words"], ["The Factory Floor is stopped."])


class NothingStartsInTestsTest(unittest.TestCase):
    """The real functions, with MACH_APP_NO_START set (tests/in_parallel.py sets it for every test class)."""

    def setUp(self):
        previous = os.environ.get(app.NO_START_ENV)
        os.environ[app.NO_START_ENV] = "1"
        self.addCleanup(lambda: os.environ.pop(app.NO_START_ENV, None) if previous is None else os.environ.__setitem__(app.NO_START_ENV, previous))

    def test_starting_signalling_and_opening_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(OSError):
                app.start_detached(["/bin/sleep", "60"], Path(tmp), Path(tmp) / "log")
            self.assertFalse((Path(tmp) / "log").exists())
        with self.assertRaises(OSError):
            app.signal_process(os.getpid())
        self.assertIn("switched off", app.open_in_browser(link(4100)))

    def test_the_suite_runner_sets_the_switch(self):
        self.assertIn('"MACH_APP_NO_START": "1"', (ROOT / "tests" / "in_parallel.py").read_text())


class RealPiecesTest(unittest.TestCase):
    def test_only_a_loopback_one_time_link_is_ever_opened(self):
        previous = os.environ.pop(app.NO_START_ENV, None)
        self.addCleanup(lambda: previous is not None and os.environ.__setitem__(app.NO_START_ENV, previous))
        for bad in ("https://example.com/?t=" + TOKEN, "http://127.0.0.1:80/", "http://localhost:4100/?t=" + TOKEN, link(4100) + " --x", "file:///etc/passwd"):
            self.assertEqual(app.open_in_browser(bad), "the link is not one of MACH's own", bad)

    def test_the_lock_probe_sees_a_held_lock_and_never_creates_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "lock"
            self.assertFalse(app.lock_held(path))
            self.assertFalse(path.exists(), "the probe never creates the lock file")
            path.write_text("")
            self.assertFalse(app.lock_held(path))
            with open(path) as held:
                fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertTrue(app.lock_held(path))
            self.assertFalse(app.lock_held(path))

    def test_a_planted_link_file_is_not_followed(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / "elsewhere").write_text(link(4100) + "\n")
            (folder / "link").symlink_to(folder / "elsewhere")
            self.assertIsNone(app.read_link(folder))
            (folder / "link").unlink()
            (folder / "link").write_text("http://example.com/?t=" + TOKEN + "\n")
            self.assertIsNone(app.read_link(folder))

    def test_is_ours_reads_the_program_name_and_the_project(self):
        lines = {11: "/p/.factory/bin/mach-studio --project /proj --engine /e/studio.py --no-open",
                 12: "/usr/bin/python3 mach-studio --project /proj", 13: "/p/mach-studio --project /proj2"}
        previous = (app.command_line, app.process_alive)
        app.command_line, app.process_alive = lines.get, (lambda pid: pid in lines)
        self.addCleanup(lambda: (setattr(app, "command_line", previous[0]), setattr(app, "process_alive", previous[1])))
        self.assertTrue(app.is_ours(app.STUDIO, 11, Path("/proj")))
        self.assertFalse(app.is_ours(app.STUDIO, 12, Path("/proj")))
        self.assertFalse(app.is_ours(app.STUDIO, 13, Path("/proj")))
        self.assertFalse(app.is_ours(app.FLOOR, 11, Path("/proj")))
        self.assertFalse(app.is_ours(app.STUDIO, 14, Path("/proj")))


class ForSkillTest(Base):
    """The skills' first line: MACH acts, and prints anything, only for an app's exact form."""

    def for_skill(self, skill, typed):
        out = io.StringIO()
        with redirect_stdout(out):
            code = app.main_for_skill([skill, "--project", str(self.project)], stdin=io.StringIO(typed))
        self.assertEqual(code, 0, "the skill's first line never fails")
        return out.getvalue()

    def answer_lines(self, printed):
        lines = printed.splitlines()
        self.assertEqual((lines[0], lines[-1]), (app.ANSWER_BEGIN, app.ANSWER_END), printed)
        return lines[1:-1]

    def test_nothing_typed_opens_product_studio_with_one_line_on_the_terminal(self):
        self.world.install(app.STUDIO, "0.26.0")
        said = self.answer_lines(self.for_skill("studio", "\n"))
        self.assertEqual(said[0], "Product Studio 0.26.0 is open in your browser.")
        self.assertEqual(said[-1], "To work here in the terminal instead, type /mach:studio status, or say what you want after /mach:studio.")
        self.assertEqual(self.world.opened, [link(4201)])

    def test_floor_opens_the_factory_floor_and_studio_opens_product_studio_from_the_run_skill(self):
        self.world.install(app.FLOOR, "0.26.0")
        self.world.install(app.STUDIO, "0.26.0")
        said = self.answer_lines(self.for_skill("run", "floor\n"))
        self.assertEqual(said[0], "The Factory Floor 0.26.0 is open in your browser.")
        self.assertNotIn("terminal", " ".join(said))
        said = self.answer_lines(self.for_skill("run", "  Studio \n"))
        self.assertEqual(said[0], "Product Studio 0.26.0 is open in your browser.")
        self.assertIn("/mach:studio status", said[-1], "/mach studio is the same as /mach-studio on its own")
        self.assertEqual(len(self.world.opened), 2)

    def test_link_and_stop_are_the_apps_own_forms(self):
        self.world.install(app.STUDIO, "0.26.0")
        pid = self.world.run_already(app.STUDIO, "0.26.0")
        said = self.answer_lines(self.for_skill("studio", "link\n"))
        self.assertEqual(said[-1], f"Open this link in a browser on this computer; it works once: {link(4100)}")
        self.assertEqual(self.world.opened, [])
        self.assertEqual(self.answer_lines(self.for_skill("studio", "stop\n")), ["Product Studio is stopped."])
        self.assertEqual(self.world.signalled, [pid])
        self.world.install(app.FLOOR, "0.26.0")
        self.world.run_already(app.FLOOR, "0.26.0", port=4300)
        self.assertIn(link(4300), self.answer_lines(self.for_skill("run", "floor link\n"))[-1])
        self.assertEqual(self.answer_lines(self.for_skill("run", "floor stop\n")), ["The Factory Floor is stopped."])

    def test_any_other_input_prints_nothing_and_does_nothing(self):
        self.world.install(app.STUDIO, "0.26.0")
        self.world.install(app.FLOOR, "0.26.0")
        quiet = {
            "studio": ["status", "where do things stand", "open the app", "floor", "studio", "link SLICE-004", "stop the interview",
                       "add an epic", "SLICE-007", "\\!", "link\nstop", "x" * 5000],
            "run": ["", "4", "status", "floor please", "floors", "floor link stop", "studio link", "pull", "LOCAL-004", "floor\nfloor",
                    "--dry-run floor", "factory start"],
        }
        for skill, inputs in quiet.items():
            for typed in inputs:
                self.assertEqual(self.for_skill(skill, typed + "\n"), "", (skill, typed))
        self.assertEqual((self.world.started, self.world.opened, self.world.installer_calls), ([], [], []))

    def test_unknown_skills_bad_arguments_and_no_input_print_nothing(self):
        class Terminal(io.StringIO):
            def isatty(self):
                return True

        out = io.StringIO()
        with redirect_stdout(out):
            for argv in (["build"], [], ["studio", "--json"], ["studio", "--project"]):
                self.assertEqual(app.main_for_skill(argv, stdin=io.StringIO("")), 0)
            self.assertEqual(app.main_for_skill(["studio"], stdin=Terminal("")), 0)
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(self.world.started, [])

    def test_nothing_opens_inside_a_supervised_factory_execution(self):
        self.world.install(app.STUDIO, "0.26.0")
        previous = os.environ.get(app.EXECUTION_ENV)
        os.environ[app.EXECUTION_ENV] = "exec-1"
        self.addCleanup(lambda: os.environ.pop(app.EXECUTION_ENV, None) if previous is None else os.environ.__setitem__(app.EXECUTION_ENV, previous))
        self.assertEqual(self.for_skill("studio", "\n"), "")
        self.assertEqual(self.for_skill("run", "floor\n"), "")
        self.assertEqual((self.world.started, self.world.opened), ([], []))

    def test_a_failure_is_said_between_the_lines_and_still_succeeds(self):
        (self.project / ".factory/bin").rmdir()
        (self.project / ".factory").rmdir()
        said = self.answer_lines(self.for_skill("run", "floor\n"))
        self.assertIn("has no .factory folder", said[0])
        self.assertIn("then /mach:run floor again.", said[0])


FENCED = re.compile(r"```!\s*\n?([\s\S]*?)\n?```")  # Claude Code's own pattern for a skill's fenced `!` command


def skill_block(skill):
    """The skill's first `!` command as written, and the text before it."""
    text = (ROOT / "skills" / skill / "SKILL.md").read_text()
    found = FENCED.search(text)
    return found.group(1).strip(), text[:found.start()]


def rendered(command, typed, skill_dir):
    """The command as Claude Code renders it: the words put in place of $ARGUMENTS as they are, with no quoting. Only a
    `!` beside a backtick, at the start of a line or after a blank is escaped (Claude Code's own rule for typed words,
    so they cannot start a command of their own)."""
    typed = re.sub(r"(^|\s)!", r"\1\\!", typed.replace("`!", "` !").replace("!`", "! `"), flags=re.M)
    return command.replace("${CLAUDE_SKILL_DIR}", str(skill_dir)).replace("$ARGUMENTS", typed)


HOSTILE = [
    'what"; touch "$SENTINEL"; echo "',
    "what's next'; touch \"$SENTINEL\"; echo '",
    "$(touch \"$SENTINEL\")",
    "`touch \"$SENTINEL\"`",
    "${IFS}$(touch${IFS}$SENTINEL)",
    "line one\n$(touch \"$SENTINEL\")\nline three",
    "!MACH_TYPED_WORDS_END\ntouch \"$SENTINEL\"",
    "  !MACH_TYPED_WORDS_END\ntouch \"$SENTINEL\"",
    "EOF\ntouch \"$SENTINEL\"",
    "\\\\ \\$HOME \\` \\\n",
    "floor; touch \"$SENTINEL\"",
    "|| touch \"$SENTINEL\" &",
]


class TheWordsNeverReachAShellTest(unittest.TestCase):
    """The skills hand the person's words to MACH in a quoted here-document. Whatever they hold (quotes, $( ), backticks,
    newlines, the here-document's own last line), the shell runs nothing of it, and MACH receives exactly what was typed."""

    def run_rendered(self, command, workdir):
        env = {**os.environ, "SENTINEL": str(workdir / "ran"), "MACH_APP_NO_START": "1"}
        for shell in ("/bin/bash", "/bin/zsh", "/bin/sh"):
            if Path(shell).exists():
                yield shell, subprocess.run([shell, "-c", command], cwd=str(workdir), env=env, capture_output=True, text=True, timeout=60)

    def test_hostile_words_run_nothing_and_print_nothing(self):
        for skill in ("studio", "run"):
            command, _ = skill_block(skill)
            for typed in HOSTILE:
                with tempfile.TemporaryDirectory() as tmp:
                    workdir = Path(tmp).resolve()
                    for shell, done in self.run_rendered(rendered(command, typed, ROOT / "skills" / skill), workdir):
                        self.assertFalse((workdir / "ran").exists(), (skill, shell, typed))
                        self.assertEqual((done.returncode, done.stdout), (0, ""), (skill, shell, typed, done.stderr))

    def test_the_words_arrive_exactly(self):
        command, _ = skill_block("studio")
        head, _, rest = command.partition(" <<")
        self.assertEqual(head, 'python3 "${CLAUDE_SKILL_DIR}/../run/scripts/app.py" for-skill studio')
        probe = "python3 -c \"import sys; open(sys.argv[1], 'w').write(sys.stdin.read())\" received <<" + rest
        for typed in HOSTILE[:6] + ["", "floor", "a \\ b $HOME `x` 'y' \"z\""]:
            with tempfile.TemporaryDirectory() as tmp:
                workdir = Path(tmp).resolve()
                for shell, done in self.run_rendered(rendered(probe, typed, ROOT), workdir):
                    self.assertEqual(done.returncode, 0, (shell, done.stderr))
                    self.assertEqual((workdir / "received").read_text(), typed + "\n", (shell, typed))
                    self.assertFalse((workdir / "ran").exists())

    def test_the_exact_forms_reach_mach_through_the_shell(self):
        """End to end through a real shell, in a folder that is no project: MACH answers, and nothing opens in a test."""
        for skill, typed in (("studio", ""), ("run", "floor"), ("run", " studio ")):
            command, _ = skill_block(skill)
            with tempfile.TemporaryDirectory() as tmp:
                workdir = Path(tmp).resolve()
                for shell, done in self.run_rendered(rendered(command, typed, ROOT / "skills" / skill), workdir):
                    lines = done.stdout.splitlines()
                    self.assertEqual((done.returncode, lines[:1], lines[-1:]), (0, [app.ANSWER_BEGIN], [app.ANSWER_END]), (skill, shell, done.stderr))
                    self.assertIn("has no .factory folder", lines[1])


class SkillTest(unittest.TestCase):
    def read(self, skill):
        text = (ROOT / "skills" / skill / "SKILL.md").read_text()
        return text.split("\n---", 1)[0], text

    def test_each_skill_runs_mach_first_and_is_told_to_reply_with_its_answer_and_stop(self):
        for skill, script in (("studio", "${CLAUDE_SKILL_DIR}/../run/scripts/app.py"), ("run", "${CLAUDE_SKILL_DIR}/scripts/app.py")):
            head, text = self.read(skill)
            self.assertNotIn("disable-model-invocation", head, "both skills are also loaded by Claude")
            self.assertIn(f'  - Bash(python3 "{script}" *)\n', head)
            command, before = skill_block(skill)
            self.assertEqual(command, f'python3 "{script}" for-skill {skill} <<\'!MACH_TYPED_WORDS_END\'\n$ARGUMENTS\n!MACH_TYPED_WORDS_END')
            self.assertNotIn("$ARGUMENTS", before, "the command comes before anything else")
            first = text[text.index("!MACH_TYPED_WORDS_END\n```"):].split("\n\n", 2)[1]
            for words in ("**First, MACH's answer.**", "MACH-ANSWER-BEGIN", "MACH-ANSWER-END", "Reply with exactly the sentences",
                          "Add nothing, ask nothing, run nothing else, and stop", "If nothing from MACH stands there, read on."):
                self.assertIn(words, first, (skill, words))
            self.assertNotIn("—", first)
            self.assertEqual(text.count("```!"), 1, skill)

    def test_the_hints_name_the_opening_forms(self):
        self.assertIn("nothing to open Product Studio in your browser | status", self.read("studio")[0])
        self.assertIn("| studio | floor [link | stop] |", self.read("run")[0])

    def test_studio_keeps_where_things_stand_in_words(self):
        _, text = self.read("studio")
        self.assertIn('`status`, "where do things stand" or "where are we": summarize the status', text)
        self.assertIn("when loading this skill yourself, pass the person's request as its input", text)

    def test_no_skill_names_the_old_command(self):
        for path in sorted((ROOT / "skills").rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                text = path.read_text(encoding="utf-8", errors="ignore")
                for word in ("/mach-app", "/mach:app", "../app/"):
                    self.assertNotIn(word, text, (path, word))

    def test_no_word_a_person_must_not_read(self):
        source = SCRIPT.read_text()
        for sentence in re.findall(r'f?"([^"\n]*(?:MACH|Product Studio|Factory Floor|terminal)[^"\n]*)"', source):
            self.assertNotRegex(sentence.lower(), r"\bengine\b|\bkind\b|\bscript\b", sentence)
        self.assertNotIn("—", source)


if __name__ == "__main__":
    unittest.main()
