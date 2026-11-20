"""Tests for notifications (M10, docs/mach-next/M10_NOTIFICATIONS.md): one message when unattended work waits for a person.

The receiver is a local HTTP server on 127.0.0.1. The production sender refuses anything but https, so tests
replace only its transport, in Python (notify.make_opener): every https request is carried to the local receiver
over plain HTTP, through notify's own redirect refusal and urllib's error handling. No real host is ever contacted.
"""

import builtins
import http.client
import io
import json
import os
import platform
import re
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "skills" / "run" / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(ROOT / "tests"))
import notify  # noqa: E402

ORIGINAL_RUN_OSASCRIPT = notify.run_osascript
import run  # noqa: E402

URL = "https://hooks.example.test/services/T000/B000/XXXX"  # obviously fake; the opener carries it to 127.0.0.1
SECRET = "T000/B000/XXXX"  # the part of the address that must never show
DISCORD_URL = "https://discord.com/api/webhooks/0/XXXX"  # used only to choose the body's shape; never contacted


class Receiver:
    """A channel on 127.0.0.1 that records each POST and answers as told."""

    def __init__(self):
        self.requests = []
        self.behaviour = {"status": 200}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                outer.requests.append({"path": self.path, "host": self.headers.get("Host"), "type": self.headers.get("Content-Type"),
                                       "body": json.loads(body.decode("utf-8"))})
                told = dict(outer.behaviour)
                if told.get("sleep"):
                    time.sleep(told["sleep"])
                if told.get("redirect"):
                    self.send_response(302)
                    self.send_header("Location", told["redirect"])
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(told.get("status", 200))
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.server.handle_error = lambda request, address: None  # a client that timed out is expected in one test
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def texts(self):
        return [request["body"].get("text", request["body"].get("content")) for request in self.requests]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def local_opener(port):
    """notify's redirect refusal and urllib's error handling, with https carried to the receiver over plain HTTP."""

    class ToReceiver(urllib.request.AbstractHTTPHandler):
        def https_open(self, req):
            return self.do_open(lambda host, **kw: http.client.HTTPConnection("127.0.0.1", port, **kw), req)

        https_request = urllib.request.AbstractHTTPHandler.do_request_

    opener = urllib.request.OpenerDirector()
    for handler in (ToReceiver(), notify.RefuseRedirects(), urllib.request.HTTPDefaultErrorHandler(), urllib.request.HTTPErrorProcessor()):
        opener.add_handler(handler)
    return opener


class Banners:
    """A stand-in for osascript, installed for every test: it records each argv and answers as told. The real
    osascript is never run in these tests; the system's name is a Mac unless a test says otherwise."""

    def __init__(self, case, system="Darwin"):
        self.calls = []
        self.behaviour = {"exit": 0}
        self.system = system
        folder = Path(tempfile.mkdtemp(prefix="mach-osa-"))
        case.addCleanup(shutil.rmtree, folder, True)
        self.path = folder / "osascript"
        self.path.write_text("a stand-in; never run\n")
        for name, value in (("OSASCRIPT", str(self.path)), ("run_osascript", self.run), ("system_name", lambda: self.system)):
            patcher = mock.patch.object(notify, name, value)
            patcher.start()
            case.addCleanup(patcher.stop)

    def run(self, argv, timeout):
        self.calls.append({"argv": list(argv), "timeout": timeout})
        if self.behaviour.get("raise"):
            raise RuntimeError("the runner broke")
        if self.behaviour.get("timeout"):
            return False, "timeout"
        code = self.behaviour.get("exit", 0)
        return (True, None) if code == 0 else (False, f"exit-{code}")

    def texts(self):
        return [call["argv"][7:] for call in self.calls]


FIXED_SCRIPT = ["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)", "-e", "end run"]


class Base(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="mach-notify-")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.project = self.root / "shop-app"
        (self.project / ".factory").mkdir(parents=True)
        self.write_config({"tickets": {"provider": "local"}})
        self.outside = self.root / "outside"
        self.outside.mkdir()
        self.receiver = Receiver()
        self.addCleanup(self.receiver.close)
        patcher = mock.patch.object(notify, "make_opener", lambda: local_opener(self.receiver.port))
        patcher.start()
        self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ, {})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(run.EXECUTION_ENV, None)
        self.outputs = []
        self.banners = Banners(self)

    def write_config(self, data):
        (self.project / ".factory" / "config.json").write_text(json.dumps(data))

    def cell(self, ticket, stage):
        folder = self.project / ".factory" / "worktrees" / ticket
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "cell.json").write_text(json.dumps({"ticket_id": ticket, "stage": stage}))

    def run_cmd(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            try:
                code = run.main(["--project", str(self.project), *argv])
            except SystemExit as exc:
                code = exc.code
        self.outputs += [out.getvalue(), err.getvalue()]
        return code, out.getvalue(), err.getvalue()

    def ok(self, *argv):
        code, out, err = self.run_cmd(*argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def refused(self, *argv):
        code, out, err = self.run_cmd(*argv)
        self.assertNotEqual(code, 0, out)
        return err + out

    def address_file(self, text=URL + "\n"):
        path = self.outside / "hook.txt"
        path.write_text(text)
        return path

    def set_address(self, *extra):
        return self.ok("notify", "set", "--from-file", str(self.address_file()), *extra)

    def next(self, ticket, *extra):
        return self.ok("next", ticket, *extra)

    def local(self, name):
        return self.project / ".factory" / "local" / name

    def stored(self):
        return json.loads(self.local("notify.json").read_text())

    def state(self):
        return json.loads(self.local("notify-state.json").read_text())

    def assert_address_nowhere(self):
        """Not in any output, nor in any file of the project but the setting itself."""
        for text in self.outputs:
            self.assertNotIn(SECRET, text)
        for path in (self.project / ".factory").rglob("*"):
            if path.is_file() and path != self.local("notify.json"):
                self.assertNotIn(SECRET, path.read_text(errors="ignore"), str(path))


class AddressTest(Base):
    def test_set_from_a_file_stores_it_privately_and_sends_nothing(self):
        result = self.set_address()
        self.assertEqual((result["stored"], result["host"], result["label"], result["sent"]), (True, "hooks.example.test", "shop-app", False))
        data = self.stored()
        self.assertEqual(set(data), {"version", "url", "label", "created_at", "machine", "project_root"})
        self.assertEqual((data["version"], data["url"], data["machine"], data["project_root"]), (1, URL, platform.node(), str(self.project)))
        self.assertEqual(self.local("notify.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.local("").stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.receiver.requests, [])
        self.assert_address_nowhere()

    def test_set_from_an_environment_variable_with_a_label(self):
        os.environ["MACH_NOTIFY_URL"] = URL
        result = self.ok("notify", "set", "--from-env", "MACH_NOTIFY_URL", "--label", "Shop team")
        self.assertEqual((result["host"], result["label"]), ("hooks.example.test", "Shop team"))
        status = self.ok("notify", "status")
        self.assertEqual((status["on"], status["webhook"]["host"], status["label"], status["webhook"]["last_sent"]), (True, "hooks.example.test", "Shop team", None))
        self.assertEqual((status["banner"]["on"], status["banner"]["why_off"]), (False, "The banner is not turned on here."))
        self.assert_address_nowhere()

    def test_refused_addresses_store_nothing_and_never_repeat_the_address(self):
        cases = {
            "http://hooks.example.test/services/T000/B000/XXXX": "must start with https://",
            "https://user:pw@hooks.example.test/services/T000/B000/XXXX": "user name or password",
            "https://user@hooks.example.test/services/T000/B000/XXXX": "user name or password",
            "https:///services/T000/B000/XXXX": "must name a host",
            "https://hooks.example.test/services/T000/B000/XXXX/" + "a" * 2048: "longer than 2048",
            "https://hooks.example.test/services/T000/B000/XXXX two": "printable characters",
        }
        for address, why in cases.items():
            with self.subTest(address=address[:40]):
                text = self.refused("notify", "set", "--from-file", str(self.address_file(address + "\n")))
                self.assertIn(why, text)
                self.assertNotIn(SECRET, text)
                with self.assertRaises(notify.NotifyError) as caught:
                    notify.store(self.project, {}, address, None)
                self.assertNotIn(SECRET, str(caught.exception))
        for text in ("", "\n\n", URL + "\n" + URL + "\n"):
            self.assertIn("one line and nothing else", self.refused("notify", "set", "--from-file", str(self.address_file(text))))
        os.environ["EMPTY_HOOK"] = ""
        self.assertIn("not set, or is empty", self.refused("notify", "set", "--from-env", "EMPTY_HOOK"))
        self.assertIn("cannot be read", self.refused("notify", "set", "--from-file", str(self.outside / "missing.txt")))
        self.assertFalse(self.local("notify.json").exists())
        self.assert_address_nowhere()

    def test_an_address_given_any_other_way_is_refused_without_being_repeated(self):
        for argv in (("notify", "set", URL), ("notify", URL), ("notify", "set", "--url", URL), ("notify", "set", "--from-file", str(self.address_file()), URL),
                     ("notify", "set", "--from", URL), ("notify", "set", "--from-env", URL), ("notify", "set", "--from-file", URL),
                     ("notify", "set", "--from-file", str(self.address_file()), "--label", URL), ("notify", "set")):
            with self.subTest(argv=argv[1:3]):
                text = self.refused(*argv)
                self.assertNotIn(SECRET, text)
                self.assertNotIn("hooks.example.test", text)
        self.assertFalse(self.local("notify.json").exists())

    def test_set_refuses_when_the_local_folder_would_be_committed(self):
        import subprocess
        subprocess.run(["git", "init", "-q"], cwd=str(self.project), check=True)
        self.assertIn("not ignored by Git", self.refused("notify", "set", "--from-file", str(self.address_file())))
        (self.project / ".gitignore").write_text(".factory/local/\n")
        self.set_address()

    def test_a_discord_address_gets_a_discord_body_and_anything_else_a_slack_body(self):
        self.assertEqual(json.loads(notify.body_for(DISCORD_URL, "hi")), {"content": "hi"})
        self.assertEqual(json.loads(notify.body_for("https://ptb.discord.com/api/webhooks/0/XXXX", "hi")), {"content": "hi"})
        self.assertEqual(json.loads(notify.body_for("https://discordapp.com/api/webhooks/0/XXXX", "hi")), {"content": "hi"})
        self.assertEqual(json.loads(notify.body_for("https://notdiscord.com.example.test/x", "hi")), {"text": "hi"})
        self.assertEqual(json.loads(notify.body_for(URL, "hi")), {"text": "hi"})
        self.set_address()
        self.ok("notify", "test")
        self.assertEqual(list(self.receiver.requests[0]["body"]), ["text"])
        self.assertEqual((self.receiver.requests[0]["path"], self.receiver.requests[0]["type"]), ("/services/T000/B000/XXXX", "application/json"))
        notify.store(self.project, {}, DISCORD_URL, None)
        self.ok("notify", "test")
        self.assertEqual(list(self.receiver.requests[1]["body"]), ["content"])

    def test_off_removes_the_address(self):
        self.set_address()
        self.assertEqual(self.ok("notify", "off")["removed"], True)
        self.assertFalse(self.local("notify.json").exists())
        status = self.ok("notify", "status")
        self.assertEqual((status["on"], status["webhook"]["host"]), (False, None))
        self.assertIn("off", self.refused("notify", "test"))
        self.assertEqual(self.receiver.requests, [])


class ReadsAsOffTest(Base):
    def setUp(self):
        super().setUp()
        self.cell("T-1", "awaiting-human")

    def assert_off(self, why):
        status = self.ok("notify", "status")
        self.assertFalse(status["on"])
        self.assertIn(why, status["webhook"]["why_off"])
        self.next("T-1", "--headless")
        self.assertEqual(self.receiver.requests, [])

    def rewrite(self, **changes):
        data = {**self.stored(), **changes}
        self.local("notify.json").write_text(json.dumps(data))

    def test_missing(self):
        self.assert_off("No address is stored")

    def test_malformed(self):
        self.set_address()
        self.local("notify.json").write_text("{not json")
        self.assert_off("cannot be read")
        self.local("notify.json").write_text(json.dumps(["a list"]))
        self.assert_off("not version 1")

    def test_wrong_permissions(self):
        self.set_address()
        for mode in (0o644, 0o640, 0o660, 0o604):
            os.chmod(self.local("notify.json"), mode)
            self.assert_off("other users")
        os.chmod(self.local("notify.json"), 0o600)
        self.next("T-1", "--headless")
        self.assertEqual(len(self.receiver.requests), 1)

    def test_a_symbolic_link(self):
        self.set_address()
        real = self.outside / "elsewhere.json"
        real.write_text(self.local("notify.json").read_text())
        os.chmod(real, 0o600)
        self.local("notify.json").unlink()
        self.local("notify.json").symlink_to(real)
        self.assert_off("symbolic link")

    def test_another_machine(self):
        self.set_address()
        self.rewrite(machine="someone-elses-laptop")
        self.assert_off("another machine")

    def test_another_folder(self):
        self.set_address()
        self.rewrite(project_root=str(self.root / "copy-of-shop-app"))
        self.assert_off("different folder")

    def test_a_stored_http_address(self):
        self.set_address()
        self.rewrite(url="http://hooks.example.test/services/T000/B000/XXXX")
        self.assert_off("not one MACH sends to")

    def test_forbidden_by_the_tracked_settings_everywhere_including_test(self):
        self.set_address()
        self.write_config({"tickets": {"provider": "local"}, "factory": {"notifications": False}})
        status = self.ok("notify", "status")
        self.assertEqual((status["on"], status["forbidden_by_project"]), (False, True))
        self.assertIn("forbid", self.refused("notify", "test"))
        self.assertIn("forbid", self.refused("notify", "set", "--from-file", str(self.address_file())))
        self.next("T-1", "--headless")
        self.assertEqual(self.receiver.requests, [])
        self.assertFalse(notify.Notifier(self.project, {}, run.NEEDS_TEXT, "/mach decide").wait("T-1", "awaiting-human", "human-approval")["sent"])
        self.assertEqual(self.receiver.requests, [])

    def test_no_tracked_setting_turns_it_on(self):
        self.write_config({"tickets": {"provider": "local"}, "factory": {"notifications": True}, "notify": {"url": URL}})
        self.assert_off("No address is stored")


class MessageTest(Base):
    def test_the_exact_text_for_each_kind_of_wait_in_both_install_forms(self):
        self.set_address("--label", "Shop team")
        waits = [needs for needs in run.NEEDS_TEXT if needs not in notify.QUIET_NEEDS]
        self.assertEqual(sorted(waits), ["adr-acceptance", "adr-baseline", "adr-decision", "adr-fix", "answers", "dispatch", "human-approval", "main-conflict", "merge", "person", "person-to-take-over",
                                         "product-answer", "repository-hardening", "security-exception-expired"])
        for install, command in ((True, "/mach decide"), (False, "/mach:run decide")):
            with mock.patch.object(run, "PROJECT_INSTALL", install):
                sender = run.notifier(run.Project(self.project))
            for number, needs in enumerate(waits):
                ticket = f"LOCAL-{number:03d}"
                self.receiver.requests.clear()
                self.assertTrue(sender.wait(ticket, f"stage-{install}", needs)["sent"])
                self.assertEqual(self.receiver.texts(), [f"MACH · Shop team: {ticket} is waiting for a person.\n{run.NEEDS_TEXT[needs]}\nIn Claude Code: {command}"])
        self.assertEqual(self.receiver.texts(), ["MACH · Shop team: LOCAL-013 is waiting for a person.\n"
                                                 "Bringing the ticket's branch up to date with the main branch conflicts: merge it in the cell and resolve it, "
                                                 "then the build carries on.\nIn Claude Code: /mach:run decide"])

    def test_the_exact_text_for_each_parked_reason_code(self):
        self.set_address()
        expected = {
            "budget": "The Factory's limits on runs or spending for the day stopped it; a person decides whether it goes on.",
            "risk": "Its risk tier is above what this machine runs unattended; a person runs it or decides.",
            "no-progress": "Its executions ended without moving it on; running it again would repeat that.",
            "tool-refused": "It made no progress and asked for a tool this machine does not allow; a person decides.",
            "outcome-unknown": "Its execution was lost and what it did is not known; a person checks it before it goes on.",
            "grooming": "Grooming without a person stopped; it needs a person to go on.",
            "merge": "It is approved, and this machine does not merge unattended; a person merges it.",
            "general": "The Factory stopped running it; a person decides what happens next.",
        }
        self.assertEqual(notify.PARK_TEXT, expected)
        for install, command in ((True, "/mach decide"), (False, "/mach:run decide")):
            with mock.patch.object(run, "PROJECT_INSTALL", install):
                sender = run.notifier(run.Project(self.project))
            for code, sentence in expected.items():
                self.receiver.requests.clear()
                ticket = f"P-{code}"
                self.assertTrue(sender.parked(ticket, f"building-{install}", code)["sent"])
                self.assertEqual(self.receiver.texts(), [f"MACH · shop-app: {ticket} is waiting for a person.\n{sentence}\nIn Claude Code: {command}"])
        self.receiver.requests.clear()
        sender.parked("P-x", "building", "anything else")
        self.assertIn(expected["general"], self.receiver.texts()[0])

    def test_the_test_message(self):
        self.set_address("--label", "Shop team")
        result = self.ok("notify", "test")
        self.assertEqual((result["webhook"]["sent"], result["webhook"]["host"], result["banner"]["on"]), (True, "hooks.example.test", False))
        self.assertEqual(self.receiver.texts(), ["MACH · Shop team: this is a test message.\n"
                                                 "Nothing is waiting; notifications are on for this project on this machine.\nIn Claude Code: /mach:run notify"])
        self.assertTrue(self.ok("notify", "status")["last_test"]["webhook"]["sent"])

    def test_labels_that_could_carry_a_link_or_a_mention_are_refused(self):
        for label in ("https://x", "a:b", "@channel", "<!here>", "x" * 61, "a/b", "a&b", "line\nbreak", ""):
            with self.subTest(label=label):
                self.assertIn("The label may use", self.refused("notify", "set", "--from-file", str(self.address_file()), "--label", label))
        self.assertEqual(notify.default_label(Path("/x/my:app@home")), "my-app-home")


class BannerTest(Base):
    """A macOS Notification Center banner, beside or instead of the webhook (design section 9)."""

    def setUp(self):
        super().setUp()
        self.cell("T-1", "awaiting-human")

    def expected_argv(self, body, title, subtitle):
        return [str(self.banners.path), *FIXED_SCRIPT, body, title, subtitle]

    def test_on_and_off_store_only_the_switch_and_send_nothing(self):
        result = self.ok("notify", "banner", "on", "--label", "Shop team")
        self.assertEqual((result["banner"], result["label"], result["webhook_still_on"], result["sent"]), ("on", "Shop team", False, False))
        data = self.stored()
        self.assertEqual(set(data), {"version", "banner", "label", "created_at", "machine", "project_root"})
        self.assertEqual((data["banner"], data["machine"], data["project_root"]), (True, platform.node(), str(self.project)))
        self.assertEqual(self.local("notify.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.banners.calls, [])
        status = self.ok("notify", "status")
        self.assertEqual((status["on"], status["banner"]["on"], status["webhook"]["on"], status["webhook"]["why_off"]),
                         (True, True, False, "No address is stored on this machine for this project."))
        self.assertIn("osascript exited 0", status["banner"]["meaning"])
        self.assertIn("cannot see whether macOS displayed", status["banner"]["meaning"])
        self.assertEqual(self.ok("notify", "banner", "off"), {"banner": "off", "webhook_still_on": False})
        self.assertFalse(self.local("notify.json").exists())

    def test_not_a_mac_refuses_on_and_ignores_a_stored_switch(self):
        self.banners.system = "Linux"
        self.assertIn("only on macOS, and this machine is not a Mac", self.refused("notify", "banner", "on"))
        self.assertFalse(self.local("notify.json").exists())
        self.banners.system = "Darwin"
        self.ok("notify", "banner", "on")
        self.banners.system = "Linux"
        status = self.ok("notify", "status")
        self.assertEqual((status["on"], status["banner"]["on"]), (False, False))
        self.assertIn("ignored", status["banner"]["why_off"])
        step = self.next("T-1", "--headless")
        self.assertEqual(step["needs"], "human-approval")
        self.assertEqual(self.banners.calls, [])
        self.assertEqual(self.ok("notify", "banner", "off")["banner"], "off")  # turning it off works anywhere

    def test_the_exact_argv_for_a_wait_and_a_parked_code_in_both_install_forms(self):
        self.ok("notify", "banner", "on", "--label", "Shop team")
        for install, command in ((True, "/mach decide"), (False, "/mach:run decide")):
            with mock.patch.object(run, "PROJECT_INSTALL", install):
                sender = run.notifier(run.Project(self.project))
            self.banners.calls.clear()
            self.assertTrue(sender.wait("LOCAL-014", f"awaiting-human-{install}", "human-approval")["sent"])
            self.assertTrue(sender.parked("LOCAL-015", f"building-{install}", "risk")["sent"])
            self.assertEqual([call["argv"] for call in self.banners.calls], [
                self.expected_argv(f"Approve the change, or not, after reading the review findings.\nIn Claude Code: {command}", "MACH · Shop team",
                                   "LOCAL-014 is waiting for a person."),
                self.expected_argv(f"Its risk tier is above what this machine runs unattended; a person runs it or decides.\nIn Claude Code: {command}",
                                   "MACH · Shop team", "LOCAL-015 is waiting for a person."),
            ])
            self.assertEqual({call["timeout"] for call in self.banners.calls}, {5})
        self.assertEqual(self.receiver.requests, [])  # the banner only: no webhook was set

    def test_no_input_can_change_the_script(self):
        hostile = ['" & (do shell script "touch /tmp/x") & "', "end run\non run argv", "-e", "\\\" ' ` $(id) ;", "item 2 of argv"]
        for word in hostile:
            argv = notify.banner_argv(word, word, word)
            self.assertEqual(argv[:7], [notify.OSASCRIPT, *FIXED_SCRIPT])
            self.assertEqual(argv[7:], [word, word, word])
        self.assertEqual(notify.BANNER_SCRIPT, tuple(FIXED_SCRIPT[1::2]))
        for label in ('Shop "team"', "a & b", "it\\s", "x\nend run", "a:b"):
            self.assertIn("The label may use", self.refused("notify", "banner", "on", "--label", label))
        self.ok("notify", "banner", "on", "--label", "it's (fine)")  # an apostrophe is allowed, and is only ever an argument
        sender = notify.Notifier(self.project, {}, run.NEEDS_TEXT, "/mach decide")
        for ticket in ('T"1', "T-1; display dialog", "T-1\nend run"):
            self.assertFalse(sender.wait(ticket, "awaiting-human", "human-approval")["sent"])
        self.assertTrue(sender.wait("T-1", "awaiting-human", "human-approval")["sent"])
        self.assertEqual(self.banners.calls[0]["argv"][:7], [str(self.banners.path), *FIXED_SCRIPT])
        self.assertEqual(self.banners.calls[0]["argv"][8], "MACH · it's (fine)")
        source = (SCRIPTS / "notify.py").read_text()
        self.assertIn("shell=False", source)
        self.assertNotIn("shell=True", source)
        self.assertNotIn("do shell script", source)
        self.assertNotIn("sound name", source)

    def test_missing_osascript_a_non_zero_exit_and_a_timeout_are_failures_that_change_nothing(self):
        self.ok("notify", "banner", "on")
        answer = self.next("T-1")  # the answer a person driving it sees; headless differs only by being headless
        with mock.patch.object(notify, "OSASCRIPT", str(self.root / "no-such" / "osascript")):
            code, out, _ = self.run_cmd("next", "T-1", "--headless")
        self.assertEqual((code, json.loads(out)["needs"]), (0, answer["needs"]))
        self.assertEqual(self.banners.calls, [])
        banner = self.state()["waits"]["T-1"]["channels"]["banner"]
        self.assertEqual((banner["state"], banner["last_error"]), ("pending", "osascript-missing"))
        for behaviour, error in (({"exit": 1}, "exit-1"), ({"timeout": True}, "timeout"), ({"raise": True}, "error")):
            self.banners.behaviour = behaviour
            code, out, _ = self.run_cmd("next", "T-1", "--headless")
            self.assertEqual((code, json.loads(out)["needs"]), (0, "human-approval"))
            self.assertEqual(self.state()["waits"]["T-1"]["channels"]["banner"]["last_error"], error)
        self.assertEqual(self.ok("notify", "status")["banner"]["failing"][0]["last_error"], "error")

    def test_the_real_runner_reports_exit_codes_and_timeouts_without_a_shell(self):
        with mock.patch.object(notify, "run_osascript", ORIGINAL_RUN_OSASCRIPT):
            self.assertEqual(notify.run_osascript([sys.executable, "-c", "pass"], 5), (True, None))
            self.assertEqual(notify.run_osascript([sys.executable, "-c", "raise SystemExit(3)"], 5), (False, "exit-3"))
            started = time.time()
            self.assertEqual(notify.run_osascript([sys.executable, "-c", "import time; time.sleep(5)"], 0.3), (False, "timeout"))
            self.assertLess(time.time() - started, 4)
            self.assertEqual(notify.run_osascript([str(self.root / "no-such-program")], 5), (False, "osascript-failed-to-start"))

    def test_both_channels_each_announced_once_and_failing_independently(self):
        self.set_address()
        self.ok("notify", "banner", "on")
        self.receiver.behaviour = {"status": 500}
        self.next("T-1", "--headless")
        self.assertEqual((len(self.receiver.requests), len(self.banners.calls)), (1, 1))  # the webhook's failure did not stop the banner
        channels = self.state()["waits"]["T-1"]["channels"]
        self.assertEqual((channels["webhook"]["state"], channels["banner"]["state"]), ("pending", "sent"))
        self.receiver.behaviour = {"status": 200}
        self.next("T-1", "--headless")
        self.next("T-1", "--headless")
        self.assertEqual((len(self.receiver.requests), len(self.banners.calls)), (2, 1))  # retried on its own channel only
        status = self.ok("notify", "status")
        self.assertEqual((status["webhook"]["last_sent"]["ticket_id"], status["banner"]["last_ran"]["ticket_id"]), ("T-1", "T-1"))
        # the other way round, at a new wait: the banner fails five times and is given up; the webhook is sent once
        self.cell("T-1", "blocked")
        self.banners.behaviour = {"exit": 1}
        for _ in range(7):
            self.next("T-1", "--headless")
        self.assertEqual((len(self.receiver.requests), len(self.banners.calls)), (3, 6))
        channels = self.state()["waits"]["T-1"]["channels"]
        self.assertEqual((channels["webhook"]["state"], channels["banner"]["state"], channels["banner"]["attempts"]), ("sent", "given-up", 5))
        status = self.ok("notify", "status")
        self.assertEqual([(row["ticket_id"], row["last_error"]) for row in status["banner"]["given_up"]], [("T-1", "exit-1")])
        self.assertEqual(status["webhook"]["given_up"], [])
        self.assert_address_nowhere()

    def test_webhook_only_never_runs_the_banner(self):
        self.set_address()
        self.next("T-1", "--headless")
        self.assertEqual((len(self.receiver.requests), self.banners.calls), (1, []))

    def test_notify_off_removes_the_address_and_says_the_banner_stays(self):
        self.set_address()
        self.ok("notify", "banner", "on")
        result = self.ok("notify", "off")
        self.assertEqual((result["removed"], result["banner_still_on"], result["still_on"]), (True, True, ["banner"]))
        self.assertNotIn("url", self.stored())
        status = self.ok("notify", "status")
        self.assertEqual((status["webhook"]["on"], status["banner"]["on"]), (False, True))
        self.next("T-1", "--headless")
        self.assertEqual((len(self.receiver.requests), len(self.banners.calls)), (0, 1))
        self.set_address()
        self.assertEqual(self.ok("notify", "banner", "off"), {"banner": "off", "webhook_still_on": True})
        self.assertEqual(self.stored()["url"], URL)
        self.assertNotIn("banner", self.stored())

    def test_notify_test_reports_each_channel(self):
        self.set_address("--label", "Shop team")
        self.ok("notify", "banner", "on")
        result = self.ok("notify", "test")
        self.assertEqual((result["webhook"]["sent"], result["banner"]["ran"]), (True, True))
        self.assertIn("cannot see whether macOS displayed", result["banner"]["meaning"])
        self.assertEqual(self.banners.texts(), [["Nothing is waiting; notifications are on for this project on this machine.\nIn Claude Code: /mach:run notify",
                                                 "MACH · Shop team", "This is a test message."]])
        self.banners.behaviour = {"exit": 1}
        code, out, _ = self.run_cmd("notify", "test")
        self.assertEqual((code, json.loads(out)["banner"]["ran"], json.loads(out)["banner"]["error"], json.loads(out)["webhook"]["sent"]), (0, False, "exit-1", True))
        self.assertEqual(self.ok("notify", "status")["last_test"]["banner"], {"ran": False, "error": "exit-1"})

    def test_forbidden_by_the_tracked_settings_including_test(self):
        self.ok("notify", "banner", "on")
        self.write_config({"tickets": {"provider": "local"}, "factory": {"notifications": False}})
        status = self.ok("notify", "status")
        self.assertEqual((status["banner"]["on"], status["forbidden_by_project"]), (False, True))
        self.assertIn("forbid", self.refused("notify", "test"))
        self.assertIn("forbid", self.refused("notify", "banner", "on"))
        self.next("T-1", "--headless")
        self.assertEqual(self.banners.calls, [])
        self.assertEqual(self.ok("notify", "banner", "off")["banner"], "off")  # turning it off is always allowed

    def test_a_banner_switch_from_another_machine_or_folder_reads_as_off(self):
        self.ok("notify", "banner", "on")
        for changes, why in (({"machine": "someone-elses-laptop"}, "another machine"), ({"project_root": str(self.root / "copy")}, "different folder"),
                             ({"banner": "yes"}, "not valid")):
            data = {**json.loads(self.local("notify.json").read_text()), **changes}
            self.local("notify.json").write_text(json.dumps(data))
            status = self.ok("notify", "status")
            self.assertFalse(status["banner"]["on"])
            self.assertIn(why, status["banner"]["why_off"])
            self.next("T-1", "--headless")
            self.assertEqual(self.banners.calls, [])
            self.local("notify.json").unlink()
            self.ok("notify", "banner", "on")


class TriggerTest(Base):
    def test_next_headless_sends_once_per_wait_and_again_at_a_new_stage(self):
        self.set_address()
        self.cell("T-1", "spec-open")
        first = self.next("T-1", "--headless")
        self.assertEqual(first["needs"], "answers")
        self.assertEqual(self.next("T-1", "--headless"), first)
        self.assertEqual(len(self.receiver.requests), 1)
        self.assertIn("Answer the spec's open questions", self.receiver.texts()[0])
        self.cell("T-1", "awaiting-human")
        self.next("T-1", "--headless")
        self.next("T-1", "--headless")
        self.assertEqual(len(self.receiver.requests), 2)
        self.assertIn("Approve the change, or not", self.receiver.texts()[1])
        state = self.state()
        self.assertEqual((state["waits"]["T-1"]["stage"], state["waits"]["T-1"]["channels"]["webhook"]["state"]), ("awaiting-human", "sent"))
        self.assertEqual(state["last_sent"]["webhook"]["ticket_id"], "T-1")
        self.assertEqual(self.local("notify-state.json").stat().st_mode & 0o777, 0o600)
        self.assert_address_nowhere()

    def test_a_person_driving_one_ticket_and_reading_commands_send_nothing(self):
        self.set_address()
        self.cell("T-1", "awaiting-human")
        self.cell("T-2", "blocked")
        self.assertEqual(self.next("T-1")["needs"], "human-approval")
        self.ok("status")
        self.ok("status", "--headless")
        self.run_cmd("explain", "T-1", "--json")
        self.run_cmd("decide", "--json")
        self.run_cmd("doctor", "--json")
        self.run_cmd("schedule", "T-1", "T-2")
        self.assertEqual(self.receiver.requests, [])
        self.assertFalse(self.local("notify-state.json").exists())

    def test_a_stop_nobody_has_to_act_on_sends_nothing(self):
        self.set_address()
        (self.project / ".factory" / "tickets").mkdir()
        (self.project / ".factory" / "tickets" / "T-9.md").write_text("---\nid: T-9\nstate: closed\nlabels: []\n---\n")
        self.assertEqual(self.next("T-9", "--headless")["needs"], "nothing")
        self.cell("T-3", "verified")
        self.assertEqual(self.next("T-3", "--headless")["action"], "review")
        sender = notify.Notifier(self.project, {}, run.NEEDS_TEXT, "/mach decide")
        self.assertFalse(sender.wait("T-3", "verified", "worker-in-cell")["sent"])
        self.assertEqual(self.receiver.requests, [])

    def test_inside_a_supervised_execution_it_neither_sends_nor_opens_the_setting(self):
        self.set_address()
        self.ok("notify", "banner", "on")
        self.cell("T-1", "awaiting-human")
        intake = self.project / ".factory" / "intake"
        intake.mkdir()
        (intake / "ledger.json").write_text(json.dumps({"supervisor": {"executions": {"x0123456789ab": {"ticket_id": "T-1", "state": "started"}}}}))
        os.environ[run.EXECUTION_ENV] = "x0123456789ab"
        touched = []
        real_open, real_path_open, real_read, real_bytes = builtins.open, Path.open, Path.read_text, Path.read_bytes

        def note(file):
            if Path(str(file)).name.startswith("notify"):
                touched.append(str(file))

        def spy_open(file, *a, **k):
            note(file)
            return real_open(file, *a, **k)

        def spy_path_open(self_, *a, **k):
            note(self_)
            return real_path_open(self_, *a, **k)

        def spy_read(self_, *a, **k):
            note(self_)
            return real_read(self_, *a, **k)

        def spy_bytes(self_, *a, **k):
            note(self_)
            return real_bytes(self_, *a, **k)

        with mock.patch("builtins.open", spy_open), mock.patch.object(Path, "open", spy_path_open), \
                mock.patch.object(Path, "read_text", spy_read), mock.patch.object(Path, "read_bytes", spy_bytes), \
                mock.patch.object(notify, "read", wraps=notify.read) as reader, mock.patch.object(notify, "post", wraps=notify.post) as poster:
            step = self.next("T-1", "--headless")
        self.assertEqual(step["needs"], "human-approval")
        self.assertEqual(touched, [])
        reader.assert_not_called()
        poster.assert_not_called()
        self.assertEqual(self.banners.calls, [])
        self.assertEqual(self.receiver.requests, [])
        self.assertFalse(self.local("notify-state.json").exists())
        self.assertIn("person's setting", self.refused("notify", "status"))

    def test_a_redirect_is_a_failure_and_is_not_followed(self):
        self.set_address()
        self.cell("T-1", "awaiting-human")
        self.receiver.behaviour = {"redirect": "https://elsewhere.example.test/catch"}
        self.next("T-1", "--headless")
        self.assertEqual([request["path"] for request in self.receiver.requests], ["/services/T000/B000/XXXX"])
        wait = self.state()["waits"]["T-1"]["channels"]["webhook"]
        self.assertEqual((wait["state"], wait["last_error"], wait["attempts"]), ("pending", "redirect-refused", 1))

    def test_failures_change_no_answer_or_exit_code_and_are_given_up_after_five(self):
        self.cell("T-1", "awaiting-human")
        quiet = self.next("T-1", "--headless")
        self.set_address()
        self.receiver.behaviour = {"status": 500}
        for _ in range(7):
            self.assertEqual(self.next("T-1", "--headless"), quiet)
        self.assertEqual(len(self.receiver.requests), 5)
        wait = self.state()["waits"]["T-1"]["channels"]["webhook"]
        self.assertEqual((wait["state"], wait["attempts"], wait["last_error"]), ("given-up", 5, "http-500"))
        status = self.ok("notify", "status")
        self.assertEqual([(row["ticket_id"], row["last_error"]) for row in status["webhook"]["given_up"]], [("T-1", "http-500")])
        self.receiver.behaviour = {"status": 200}
        self.next("T-1", "--headless")
        self.assertEqual(len(self.receiver.requests), 5)  # given up stays given up for this wait
        self.cell("T-1", "blocked")  # a new wait
        self.next("T-1", "--headless")
        self.assertEqual(len(self.receiver.requests), 6)
        self.assert_address_nowhere()

    def test_a_timeout_is_recorded_and_retried_on_the_next_occasion(self):
        self.assertEqual(notify.TIMEOUT_SECONDS, 5)
        self.set_address()
        self.cell("T-1", "awaiting-human")
        self.receiver.behaviour = {"sleep": 1.0}
        with mock.patch.object(notify, "TIMEOUT_SECONDS", 0.2):
            started = time.time()
            code, out, _ = self.run_cmd("next", "T-1", "--headless")
            self.assertLess(time.time() - started, 5)
        self.assertEqual((code, json.loads(out)["needs"]), (0, "human-approval"))
        wait = self.state()["waits"]["T-1"]["channels"]["webhook"]
        self.assertEqual((wait["state"], wait["last_error"]), ("pending", "timeout"))
        self.assertEqual(self.ok("notify", "status")["webhook"]["failing"][0]["last_error"], "timeout")
        self.receiver.behaviour = {"status": 200}
        self.next("T-1", "--headless")
        self.assertEqual(self.state()["waits"]["T-1"]["channels"]["webhook"]["state"], "sent")
        self.assertEqual(self.state()["waits"]["T-1"]["channels"]["webhook"]["attempts"], 2)

    def test_the_sender_uses_one_post_with_a_five_second_timeout_and_never_raises(self):
        calls = []

        class Opener:
            def open(self, request, timeout=None):
                calls.append((request.get_method(), request.full_url, timeout))
                raise RuntimeError("boom " + request.full_url)

        self.assertEqual(notify.post(URL, "hi", Opener()), (False, "error"))
        self.assertEqual(calls, [("POST", URL, 5)])
        self.set_address()
        with mock.patch.object(notify, "post", side_effect=RuntimeError(URL)):
            self.assertEqual(notify.Notifier(self.project, {}, run.NEEDS_TEXT, "/mach decide").wait("T-1", "x", "merge"), {"sent": False, "why": "error"})


from test_mach_factory_supervisor import Base as SupervisorBase  # noqa: E402  (its stand-in for Claude Code and its helpers)


class SupervisorTriggerTest(SupervisorBase):
    """The supervisor's two triggers, with the supervisor tests' own stand-in for Claude Code."""

    def setUp(self):
        super().setUp()
        self.receiver = Receiver()
        self.addCleanup(self.receiver.close)
        patcher = mock.patch.object(notify, "make_opener", lambda: local_opener(self.receiver.port))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.banners = Banners(self)
        hook = self.root / "hook.txt"
        hook.write_text(URL + "\n")
        code, out, err = self.run_cmd("notify", "set", "--from-file", str(hook), "--label", "Shop team")
        self.assertEqual(code, 0, err + out)

    def run_cmd(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.eng), *argv])
        return code, out.getvalue(), err.getvalue()

    def expected(self, ticket, middle):
        return f"MACH · Shop team: {ticket} is waiting for a person.\n{middle}\nIn Claude Code: /mach:run decide"

    def test_an_execution_that_ends_waiting_for_a_person_is_announced_once_across_both_triggers(self):
        self.supervised()
        self.tick()
        self.wait()
        self.tick()
        self.assertEqual(run.next_step(run.Project(self.eng.resolve()), "LOCAL-001", True)["needs"], "merge")
        self.assertEqual(self.receiver.texts(), [self.expected("LOCAL-001", run.NEEDS_TEXT["merge"])])
        code, out, _ = self.run_cmd("next", "LOCAL-001", "--headless")
        self.assertEqual((code, json.loads(out)["needs"]), (0, "merge"))
        self.tick()
        self.assertEqual(len(self.receiver.requests), 1)
        self.assert_nowhere()

    def test_an_approved_ticket_this_machine_will_not_merge_is_announced_once(self):
        """The project would let the line merge, this machine does not merge unattended: neither a stop nor a park, and still a wait."""
        self.first()
        self.config(build={"require_audit": False}, merge={"mode": "auto", "method": "local"})
        self.enable("--include-backlog")
        self.claude({"default": {"stage": "approved"}})
        self.tick()
        self.wait()
        for _ in range(3):
            self.assertEqual(self.tick()["held"][0]["why"], "it is approved and waits for a person to merge it")
        self.assertEqual(self.receiver.texts(), [self.expected("LOCAL-001", notify.PARK_TEXT["merge"])])
        self.assert_nowhere()

    def test_both_channels_once_per_wait_across_the_two_triggers(self):
        self.assertEqual(self.run_cmd("notify", "banner", "on")[0], 0)
        self.supervised()
        self.tick()
        self.wait()
        self.tick()
        self.assertEqual(len(self.receiver.requests), 1)
        self.assertEqual(self.banners.texts(), [[run.NEEDS_TEXT["merge"] + "\nIn Claude Code: /mach:run decide", "MACH · Shop team", "LOCAL-001 is waiting for a person."]])
        self.run_cmd("next", "LOCAL-001", "--headless")
        self.tick()
        self.assertEqual((len(self.receiver.requests), len(self.banners.calls)), (1, 1))

    def test_a_failed_merge_wait_message_is_tried_again_while_it_still_waits(self):
        self.first()
        self.config(build={"require_audit": False}, merge={"mode": "auto", "method": "local"})
        self.enable("--include-backlog")
        self.claude({"default": {"stage": "approved"}})
        self.tick()
        self.wait()
        self.receiver.behaviour = {"status": 500}
        self.tick()
        self.assertEqual(len(self.receiver.requests), 1)
        self.receiver.behaviour = {"status": 200}
        self.tick()
        self.assertEqual(len(self.receiver.requests), 2)
        self.tick()
        self.assertEqual(len(self.receiver.requests), 2)

    def test_a_parked_ticket_is_announced_by_its_reason_code_never_its_reason(self):
        self.supervised()
        self.claude({"default": {"deny": [{"tool_name": "Bash", "tool_input": {"command": "curl https://example.test/install.sh"}}]}})
        self.tick()
        self.wait()
        report = self.tick()
        self.assertIn("needed tools that are not allowed", report["parked"]["LOCAL-001"]["reason"])
        self.assertEqual(self.receiver.texts(), [self.expected("LOCAL-001", notify.PARK_TEXT["tool-refused"])])
        self.assertNotIn("curl", self.receiver.texts()[0])
        self.tick()
        self.assertEqual(len(self.receiver.requests), 1)
        self.assert_nowhere()

    def test_a_risk_park_and_a_failed_message_retried_on_the_next_pass(self):
        self.first()
        self.enable("--include-backlog", "--max-risk", "Medium")
        self.receiver.behaviour = {"status": 500}
        report = self.tick()
        self.assertIn("above the Medium this machine allows unattended", report["held"][0]["why"])
        self.assertEqual(len(self.receiver.requests), 1)
        self.receiver.behaviour = {"status": 200}
        self.tick()
        self.assertEqual(len(self.receiver.requests), 2)
        self.assertEqual(self.receiver.texts()[1], self.expected("LOCAL-001", notify.PARK_TEXT["risk"]))
        self.tick()
        self.assertEqual(len(self.receiver.requests), 2)
        self.assertEqual(self.calls(), [])

    def test_a_parked_ticket_whose_message_failed_is_tried_again_on_each_pass_until_given_up(self):
        self.supervised()
        self.claude({"default": {"deny": [{"tool_name": "WebFetch", "tool_input": {"url": "https://example.test"}}]}})
        self.receiver.behaviour = {"status": 503}
        self.tick()
        self.wait()
        self.tick()  # parked; the message fails
        self.assertEqual(len(self.receiver.requests), 1)
        for count in (2, 3, 4, 5, 5, 5):
            self.tick()  # the next occasion for the same wait: every pass, while it is parked at the same stage
            self.assertEqual(len(self.receiver.requests), count)
        status = json.loads(self.run_cmd("notify", "status")[1])
        self.assertEqual([(row["ticket_id"], row["last_error"], row["attempts"]) for row in status["webhook"]["given_up"]], [("LOCAL-001", "http-503", 5)])
        self.assertEqual(len(self.calls()), 1)  # nothing about the line changed
        self.assert_nowhere()

    def test_a_person_stopping_an_execution_is_not_announced_to_them(self):
        self.supervised()
        self.claude({"default": {"hang": True}})
        self.tick()
        self.factory("stop")
        self.assertIn("stopped by a person", self.ledger()["supervisor"]["parked"]["LOCAL-001"]["reason"])
        self.assertEqual(self.receiver.requests, [])

    def test_no_address_no_message_and_nothing_changes(self):
        self.run_cmd("notify", "off")
        self.supervised()
        self.tick()
        self.wait()
        self.tick()
        self.assertEqual(self.receiver.requests, [])
        self.assertFalse((self.eng / ".factory/local/notify-state.json").exists())

    def assert_nowhere(self):
        for path in (self.eng / ".factory").rglob("*"):
            if path.is_file() and path.name != "notify.json":
                self.assertNotIn(SECRET, path.read_text(errors="ignore"), str(path))


class BoundaryTest(unittest.TestCase):
    """Design section 7: what never reads the address or sends."""

    def test_the_production_sender_refuses_redirects_and_nothing_relaxes_https(self):
        opener = notify.make_opener()
        self.assertTrue(any(isinstance(handler, notify.RefuseRedirects) for handler in opener.handlers))
        self.assertFalse(any(type(handler) is urllib.request.HTTPRedirectHandler for handler in opener.handlers))
        source = (SCRIPTS / "notify.py").read_text()
        self.assertEqual(len(re.findall(r"os\.environ", source)), 1)  # only --from-env reads the environment: no switch relaxes https
        for address in ("http://hooks.example.test/x", "ftp://hooks.example.test/x", "HTTP://hooks.example.test/x", "//hooks.example.test/x"):
            self.assertIsNotNone(notify.check_address(address), address)
        self.assertIsNone(notify.check_address(URL))

    WORDS = ("notify.json", "notify-state", "import notify", "from notify", "notify.Notifier")

    def test_the_named_readers_never_name_the_setting_or_the_module(self):
        files = [SCRIPTS / name for name in ("intake.py", "qualify.py", "doctor.py", "explain.py", "decide.py")]
        files += sorted((ROOT / "skills" / "product-studio").rglob("*.py"))
        files += sorted((ROOT / "apps" / "observer").rglob("*.go"))
        self.assertTrue(any(path.suffix == ".go" for path in files))
        found = [f"{path.relative_to(ROOT)}: {word}" for path in files for word in self.WORDS if word in path.read_text(encoding="utf-8", errors="ignore")]
        self.assertEqual(found, [])

    def test_only_the_run_script_loads_it_and_only_the_module_names_its_files(self):
        loaders, namers = [], []
        for top in ("skills", "agents", "workflows", "templates", "bin"):
            for path in sorted((ROOT / top).rglob("*")):
                if not path.is_file() or "__pycache__" in path.parts:
                    continue
                text = path.read_text(encoding="utf-8", errors="ignore")
                if re.search(r"^\s*(import notify|from notify import)", text, re.MULTILINE):
                    loaders.append(str(path.relative_to(ROOT)))
                if "notify.json" in text or "notify-state.json" in text:
                    namers.append(str(path.relative_to(ROOT)))
        self.assertEqual(loaders, ["skills/run/scripts/run.py"])
        self.assertEqual(namers, ["skills/run/scripts/notify.py"])

    def test_the_skill_never_asks_for_the_address_in_the_conversation(self):
        text = (ROOT / "skills" / "run" / "SKILL.md").read_text(encoding="utf-8")
        start = text.index("\n### Notifications\n")
        section = text[start:text.index("\n### ", start + 5)]
        for phrase in ("RUN notify set --from-file <path>", "RUN notify set --from-env <NAME>", "Never ask the person to paste it here",
                       "never read the file they put it in", "delete the file", "can approve, start or change nothing",
                       "RUN notify banner on", "RUN notify banner off", "Script Editor", "only whether the command ran", "never \"delivered\""):
            self.assertIn(phrase, section)
        head = text.split("\n---", 1)[0]
        hint = re.search(r'^argument-hint: "(.*)"$', head, re.MULTILINE).group(1)
        self.assertIn("notify [status|set|banner|test|off]", hint)
        self.assertNotIn('"', hint)


if __name__ == "__main__":
    unittest.main()
