"""The Go host (apps/studio) against the real engine: a short real flow over HTTP, and the
cross-client conformance check that it leaves byte-identical artifacts to studio.py run directly.

Skipped cleanly when Go is not installed.
"""

import http.client
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from test_mach_product_studio import FIXTURE, INTENT_TEXT, SPEC, git  # noqa: E402

APP = ROOT / "apps" / "studio"
STUDIO = ROOT / "skills" / "product-studio" / "scripts" / "studio.py"
GO = shutil.which("go")


def make_project(parent: Path, name: str) -> Path:
    project = parent / name
    project.mkdir()
    (project / "README.md").write_text("# Sample\n")
    git(project, "init", "-q", "-b", "main")
    for key, value in (("user.name", "Pat PM"), ("user.email", "pat@example.com"), ("commit.gpgsign", "false")):
        git(project, "config", key, value)
    git(project, "add", "-A")
    git(project, "commit", "-q", "-m", "start")
    return project


def workspace(project: Path):
    """Every file Product Studio keeps, by path, with its bytes."""
    home = project / ".factory" / "studio"
    return {p.relative_to(home).as_posix(): p.read_bytes() for p in sorted(home.rglob("*")) if p.is_file()}


@unittest.skipIf(GO is None, "go is not installed")
class HostConformanceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory()
        cls.binary = Path(cls.build.name) / "mach-studio"
        done = subprocess.run([GO, "build", "-o", str(cls.binary), "./cmd/mach-studio"], cwd=str(APP),
                              capture_output=True, text=True)
        if done.returncode != 0:
            cls.build.cleanup()
            raise AssertionError("go build failed:\n" + done.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        parent = Path(self.tmp.name).resolve()
        self.via_host = make_project(parent, "via-host")
        self.direct = make_project(parent, "direct")
        self.host = subprocess.Popen(
            [str(self.binary), "--no-open", "--project", str(self.via_host), "--port", "0",
             "--engine", str(STUDIO), "--python", sys.executable,
             # No interview here: this test is about the engine's artifacts, and never starts Claude Code.
             "--claude", str(Path(self.tmp.name) / "no-claude-here")],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.stop)
        url = None
        for _ in range(5):
            line = self.host.stdout.readline()
            if line.startswith("Open: "):
                url = line[len("Open: "):].strip()
                break
        self.assertIsNotNone(url, "the host did not print its address")
        self.assertTrue(url.startswith("http://127.0.0.1:"), url)
        hostport, _, query = url[len("http://"):].partition("/?")
        self.address = hostport
        self.port = int(hostport.rsplit(":", 1)[1])
        self.token = query[len("t="):]
        self.cookie = None
        self.csrf = None

    def stop(self):
        if self.host.poll() is None:
            self.host.terminate()
            try:
                self.host.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.host.kill()
                self.host.wait()
        self.host.stdout.close()
        self.host.stderr.close()

    # ---- HTTP as the app speaks it ----

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=120)
        try:
            all_headers = {"Host": self.address}
            if self.cookie:
                all_headers["Cookie"] = self.cookie
            if method != "GET":
                all_headers.update({"Origin": f"http://{self.address}", "Content-Type": "application/json", "X-MACH-CSRF": self.csrf or ""})
            all_headers.update(headers or {})
            conn.request(method, path, body=None if body is None else json.dumps(body), headers=all_headers)
            response = conn.getresponse()
            return response.status, response.getheaders(), response.read()
        finally:
            conn.close()

    def api(self, method, path, body=None):
        status, _, raw = self.request(method, path, body)
        envelope = json.loads(raw)
        self.assertTrue(envelope["ok"], f"{method} {path}: {status} {envelope.get('error')}")
        return envelope["data"]

    def op(self, operation, **args):
        return self.api("POST", f"/api/ops/{operation}", args)

    def login(self):
        status, headers, _ = self.request("GET", f"/?t={self.token}")
        self.assertEqual(status, 303)
        cookie = next(value for key, value in headers if key.lower() == "set-cookie")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.cookie = cookie.split(";", 1)[0]
        session = self.api("GET", "/api/session")
        self.csrf = session["csrf_token"]
        return session

    # ---- the same operations, by the terminal client ----

    def studio(self, *argv, expect=0):
        done = subprocess.run([sys.executable, str(STUDIO), "--project", str(self.direct), *argv], capture_output=True, text=True)
        self.assertEqual(done.returncode, expect, done.stderr + done.stdout)
        return json.loads(done.stdout) if done.stdout.strip() else None

    def test_a_real_flow_writes_the_same_bytes_as_the_terminal(self):
        # Through the host, as the web app would.
        session = self.login()
        self.assertIs(session["capabilities"]["interview"], False)
        self.assertIn("not installed", session["capabilities"]["interview_reason"])
        self.assertEqual(session["capabilities"]["continue_command"], "/mach:product-studio continue")
        self.assertEqual(session["project"]["folder"], "via-host")
        self.op("project.init", id="team-space", name="Team Space", vision="Teams work together.", outcome=["Teams can work together"])
        self.op("epic.add", title="Team membership", criterion=["Only invited people can join"])
        self.assertEqual(self.op("slice.new", epic="EPIC-001", title="Invite a teammate")["slice"]["slice_id"], "SLICE-001")
        written = self.api("PUT", "/api/drafts/spec/SLICE-001", {"markdown": FIXTURE.read_text(), "name": "invite-teammate"})
        self.assertEqual(written["path"], "specs/slices/" + SPEC)
        self.assertEqual(written["check"]["counts"]["scenarios"], 3)
        why = self.api("PUT", "/api/drafts/intent/SLICE-001", {"markdown": INTENT_TEXT})
        self.assertEqual(why["check"]["status"], "ready_for_approval")
        shown = self.op("slice.show", slice_id="SLICE-001")
        self.assertIs(shown["editable"], True)
        self.assertEqual(shown["spec"]["markdown"], FIXTURE.read_text())
        self.op("epic.approve", epic_id="EPIC-001")
        approved = self.op("slice.approve", slice_id="SLICE-001")
        self.assertEqual(approved["slice"]["status"], "approved_for_engineering")
        self.assertIs(approved["factory_authorized"], False)

        # Directly, as the terminal skill does.
        self.studio("status")  # what GET /api/session asked the engine
        self.studio("project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together.", "--outcome", "Teams can work together")
        self.studio("epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join")
        self.studio("slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate")
        draft = self.direct / ".factory/studio/draft"
        (draft / "specs/slices" / SPEC).write_text(FIXTURE.read_text())
        self.studio("slice", "check", "SLICE-001", expect=1)  # the why is still missing
        (draft / "product/intents/SLICE-001.md").write_text(INTENT_TEXT)
        self.studio("slice", "check", "SLICE-001")
        self.studio("slice", "show", "SLICE-001")
        self.studio("epic", "approve", "EPIC-001")
        self.studio("slice", "approve", "SLICE-001")

        host_files, direct_files = workspace(self.via_host), workspace(self.direct)
        self.assertEqual(sorted(host_files), sorted(direct_files))
        for name in host_files:
            self.assertEqual(host_files[name], direct_files[name], f"{name} differs between the host and the terminal")
        self.assertIn("draft/product/slices/SLICE-001.json", host_files)
        # Nothing outside the workspace changed in either project.
        for project in (self.via_host, self.direct):
            self.assertEqual(git(project, "status", "--porcelain").stdout, "")

    def test_the_host_refuses_without_a_session_and_from_another_origin(self):
        status, _, raw = self.request("POST", "/api/ops/status", {})
        self.assertEqual((status, json.loads(raw)["error"]["kind"]), (401, "unauthorized"))
        self.login()
        status, _, raw = self.request("POST", "/api/ops/status", {}, headers={"Origin": "http://evil.example"})
        self.assertEqual((status, json.loads(raw)["error"]["kind"]), (403, "unauthorized"))
        status, _, _ = self.request("GET", f"/?t={self.token}", headers={"Cookie": ""})
        self.assertEqual(status, 401)  # the start link works once


if __name__ == "__main__":
    unittest.main()
