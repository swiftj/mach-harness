"""The Go host (apps/studio) against the real engine: a short real flow over HTTP, and the
cross-client conformance check that it leaves byte-identical artifacts to studio.py run directly.

Skipped cleanly when Go is not installed.
"""

import base64
import http.client
import json
import re
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


TIME_RE = re.compile(rb"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")


COMMIT_RE = re.compile(rb"\b[0-9a-f]{40}\b")


def workspace(project: Path):
    """Every file Product Studio keeps, by path, with its bytes; the moments it records (when a
    slice was marked ready) are the only bytes that may differ between two runs."""
    home = project / ".factory" / "studio"
    found = {p.relative_to(home).as_posix(): TIME_RE.sub(b"<TIME>", p.read_bytes()) for p in sorted(home.rglob("*")) if p.is_file()}
    # A file may name the repository's own commits (the shipped rules a spec was checked against, what an idea's
    # lookups were read at), and two repositories made a moment apart never share one. A 40-character commit id is
    # replaced; the 64-character content hashes that must match are left alone.
    found = {name: COMMIT_RE.sub(b"<COMMIT>", data) for name, data in found.items()}
    return found


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
        approved = self.op("slice.ready", slice_id="SLICE-001")
        self.assertEqual((approved["slice"]["status"], approved["saved_to"]), ("approved_for_engineering", "folder"))
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
        self.studio("slice", "ready", "SLICE-001")

        host_files, direct_files = workspace(self.via_host), workspace(self.direct)
        self.assertEqual(sorted(host_files), sorted(direct_files))
        for name in host_files:
            self.assertEqual(host_files[name], direct_files[name], f"{name} differs between the host and the terminal")
        self.assertIn("draft/product/slices/SLICE-001.json", host_files)
        # Nothing outside the workspace changed in either project.
        for project in (self.via_host, self.direct):
            self.assertEqual(git(project, "status", "--porcelain").stdout, "")

    def test_the_m15_operations_write_the_same_bytes_as_the_terminal(self):
        """Every operation M15 put on the host's list, through the host as the app sends it (files as base64
        in the JSON body) and through studio.py as the terminal skill runs it: the same bytes in Product
        Studio's workspace, the export served exactly as written, and nothing staged left behind."""
        from mock_pictures import jpeg, png
        from test_mach_product_prd import ANSWERS, MAP, PRD_TEXT

        files = Path(self.tmp.name) / "files"
        files.mkdir()
        (files / "team-space.md").write_text(PRD_TEXT, encoding="utf-8")
        (files / "invite.png").write_bytes(png())
        (files / "whole.jpg").write_bytes(jpeg())
        (files / "map.json").write_text(json.dumps(MAP))
        (files / "answers.json").write_text(json.dumps(ANSWERS))
        keys_csv = "Issue key,Summary,Labels,Labels\r\nABC-7,Invite a teammate,mach,SLICE-001\r\nABC-8,Unrelated,other,\r\n"
        (files / "keys.csv").write_text(keys_csv)
        b64 = lambda name: base64.b64encode((files / name).read_bytes()).decode("ascii")
        upload = lambda name: {"name": name, "content_base64": b64(name)}

        def host_ok(operation, args):
            return self.api("POST", f"/api/ops/{operation}", args)

        def host_refused(operation, args):
            status, _, raw = self.request("POST", f"/api/ops/{operation}", args)
            envelope = json.loads(raw)
            self.assertFalse(envelope["ok"], f"{operation} was not refused")
            return envelope["error"]["kind"]

        # Through the host.
        self.login()
        host_ok("project.init", {"id": "team-space", "name": "Team Space", "vision": "Teams work together.", "outcome": ["Teams can work together"]})
        host_ok("epic.add", {"title": "Team membership", "criterion": ["Only invited people can join"]})
        host_ok("slice.new", {"epic": "EPIC-001", "title": "Invite a teammate"})
        self.api("PUT", "/api/drafts/spec/SLICE-001", {"markdown": FIXTURE.read_text(), "name": "invite-teammate"})
        self.api("PUT", "/api/drafts/intent/SLICE-001", {"markdown": INTENT_TEXT})
        host_ok("principle.add", {"title": "Versions stay", "statement": "A published version MUST NOT be edited in place.", "reason": "Readers rely on what they saw."})
        host_ok("principle.set", {"principle_id": "PP-01", "statement": "A published version MUST NOT be changed in place."})
        host_ok("principle.add", {"title": "Name the sender", "statement": "An invitation MUST name the person who sent it.", "reason": "People trust a name."})
        host_ok("principle.retire", {"principle_id": "PP-02"})
        listed = host_ok("principle.list", {})
        self.assertEqual(listed["active"], ["PP-01"])
        self.assertEqual(host_ok("principle.publish", {})["saved_to"], "folder")
        self.assertEqual(host_refused("reconcile.principles", {"take": "theirs"}), "refused")
        host_ok("epic.link", {"epic_id": "EPIC-001", "jira": "ABC-1"})
        host_ok("slice.link", {"slice_id": "SLICE-001", "jira": "ABC-2"})
        host_ok("slice.link", {"slice_id": "SLICE-001", "remove": True})
        added = host_ok("slice.mock.add", {"slice_id": "SLICE-001", "file": upload("invite.png"), "for": "AC-01", "binding": True, "note": "The invite form"})
        whole = host_ok("slice.mock.add", {"slice_id": "SLICE-001", "file": upload("whole.jpg")})["mock"]["sha256"]
        self.assertEqual(len(host_ok("slice.mock.list", {"slice_id": "SLICE-001"})["mocks"]), 2)
        host_ok("slice.mock.remove", {"slice_id": "SLICE-001", "mock": whole[:12]})
        self.assertTrue(added["mock"]["binding"])
        self.assertEqual(host_ok("prd.import", {"file": upload("team-space.md")})["prd"]["prd_id"], "PRD-01")
        host_ok("prd.list", {})
        self.assertIn("PRD-DATA", host_ok("prd.show", {"prd_id": "PRD-01", "lines": "1-9"})["fenced"])
        host_ok("prd.map", {"prd_id": "PRD-01", "map": MAP})
        waiting = host_ok("prd.status", {"prd_id": "PRD-01"})["not_covered"]
        self.assertTrue(waiting, "the PRD has sections no slice cites")
        for section in waiting:
            host_ok("prd.settle", {"prd_id": "PRD-01", "section": section, "as": "later", "reason": "Not this quarter."})
        made = host_ok("prd.apply", {"prd_id": "PRD-01"})["made"]["slices"]
        host_ok("prd.draft", {"slice_id": made[0], "answers": ANSWERS})
        host_ok("prd.confirm", {"slice_id": made[0], "accept": "all"})
        host_ok("policy.list", {})
        current_ok = json.loads(self.request("POST", "/api/ops/epic.current", {"epic_id": "EPIC-001"})[2])["ok"]
        exported = host_ok("jira.export", {"state": "all"})
        self.assertEqual([d["name"] for d in exported["downloads"]], ["mach-jira.csv", "README.txt"])
        for item in exported["downloads"]:
            status, headers, body = self.request("GET", item["url"])
            self.assertEqual(status, 200)
            self.assertEqual(body, (Path(exported["folder"]) / item["name"]).read_bytes())
            self.assertIn(("Content-Disposition", f'attachment; filename="{item["name"]}"'), headers)
        keyed = host_ok("jira.keys", {"file": upload("keys.csv")})
        self.assertEqual([row["id"] for row in keyed["linked"]], ["SLICE-001"])
        self.assertEqual(len(keyed["unmatched"]), 1)
        self.assertFalse((self.via_host / ".factory/studio/uploads").exists() and any((self.via_host / ".factory/studio/uploads").iterdir()))

        # Directly, as the terminal skill does.
        self.studio("status")
        self.studio("project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together.", "--outcome", "Teams can work together")
        self.studio("epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join")
        self.studio("slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate")
        draft = self.direct / ".factory/studio/draft"
        (draft / "specs/slices" / SPEC).write_text(FIXTURE.read_text())
        self.studio("slice", "check", "SLICE-001", expect=1)
        (draft / "product/intents/SLICE-001.md").write_text(INTENT_TEXT)
        self.studio("slice", "check", "SLICE-001")
        self.studio("principle", "add", "--title", "Versions stay", "--statement", "A published version MUST NOT be edited in place.", "--reason", "Readers rely on what they saw.")
        self.studio("principle", "set", "PP-01", "--statement", "A published version MUST NOT be changed in place.")
        self.studio("principle", "add", "--title", "Name the sender", "--statement", "An invitation MUST name the person who sent it.", "--reason", "People trust a name.")
        self.studio("principle", "retire", "PP-02")
        self.studio("principle", "list")
        self.studio("principle", "publish")
        self.studio("reconcile", "principles", "--take", "theirs", expect=1)
        self.studio("epic", "link", "EPIC-001", "--jira", "ABC-1")
        self.studio("slice", "link", "SLICE-001", "--jira", "ABC-2")
        self.studio("slice", "link", "SLICE-001", "--no-jira")
        self.studio("slice", "mock", "add", "SLICE-001", str(files / "invite.png"), "--for", "AC-01", "--binding", "--note", "The invite form")
        self.studio("slice", "mock", "add", "SLICE-001", str(files / "whole.jpg"))
        self.studio("slice", "mock", "list", "SLICE-001")
        self.studio("slice", "mock", "remove", "SLICE-001", whole[:12])
        self.studio("prd", "import", str(files / "team-space.md"))
        self.studio("prd", "list")
        self.studio("prd", "show", "PRD-01", "--lines", "1-9")
        self.studio("prd", "map", "PRD-01", "--from", str(files / "map.json"))
        self.studio("prd", "status", "PRD-01")
        for section in waiting:
            self.studio("prd", "settle", "PRD-01", "--section", str(section), "--as", "later", "--reason", "Not this quarter.")
        self.studio("prd", "apply", "PRD-01")
        self.studio("prd", "draft", made[0], "--from", str(files / "answers.json"))
        self.studio("prd", "confirm", made[0], "--accept", "all")
        self.studio("policy", "list")
        done = subprocess.run([sys.executable, str(STUDIO), "--project", str(self.direct), "epic", "current", "EPIC-001", "--json"], capture_output=True, text=True)
        self.assertEqual(done.returncode == 0, current_ok)
        self.studio("jira", "export", "--state", "all")
        self.studio("jira", "keys", str(files / "keys.csv"))

        host_files, direct_files = workspace(self.via_host), workspace(self.direct)
        self.assertEqual(sorted(host_files), sorted(direct_files))
        for name in host_files:
            self.assertEqual(host_files[name], direct_files[name], f"{name} differs between the host and the terminal")
        for expected in ("draft/product/principles.json", "draft/product/prds/PRD-01/document.md", "jira/cloud-all/mach-jira.csv"):
            self.assertIn(expected, host_files)
        self.assertTrue(any(name.startswith("draft/product/mocks/SLICE-001/") for name in host_files))
        for project in (self.via_host, self.direct):
            self.assertEqual(git(project, "status", "--porcelain").stdout, "")

    def test_the_m16_shape_operations_write_the_same_bytes_as_the_terminal(self):
        """Every Shape operation M16 put on the host's list, through the host as the app sends it (lookups and the
        map as JSON in the body) and through studio.py as the terminal skill runs it, with the brief and the case
        written into the workspace as the conversation writes them: the same bytes in Product Studio's workspace, the
        same refusals, and nothing staged left behind. No GitHub here: the idea is published to the folder."""
        from test_mach_shape import FAULT
        from test_mach_shape_brief import CASE
        from test_mach_shape_route import brief_with

        brief = brief_with(outcomes=1, capabilities="Lending (EPIC-001)", rules="None.")
        lookups = {"principles": [{"id": "PP-01", "note": "A renewal refused today is explained by a person."}],
                   "similar": [{"idea": "IDEA-002", "note": "Also about loans."}]}
        mapped = {"epics": [], "slices": [{"key": "S1", "title": "Renew a loan from my loans", "scope": "One loan, from the loans page",
                                           "epic": "EPIC-001", "depends_on": [], "outcomes": ["O-1"], "cites": ["9"]}]}
        files = Path(self.tmp.name) / "shape-files"
        files.mkdir()
        (files / "lookups.json").write_text(json.dumps(lookups))
        (files / "map.json").write_text(json.dumps(mapped))

        def write(project, name, text):
            path = project / ".factory/studio/draft/product/briefs" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

        def host_refused(operation, args):
            status, _, raw = self.request("POST", f"/api/ops/{operation}", args)
            envelope = json.loads(raw)
            self.assertFalse(envelope["ok"], f"{operation} was not refused")
            self.assertEqual((status, envelope["error"]["kind"]), (422, "refused"), envelope)
            return envelope["error"]["message"]

        # Through the host.
        self.login()
        self.op("project.init", id="team-space", name="Team Space", vision="Members borrow without friction.", outcome=["Members renew without calling"])
        self.op("epic.add", title="Lending", criterion=["Loans follow the desk's rules"])
        self.op("principle.add", title="Tell first", statement="A member MUST be told why a renewal is refused.", reason="Trust.")
        self.assertEqual(self.op("idea.add", title="Let members renew a loan themselves")["idea"]["idea_id"], "IDEA-001")
        self.assertEqual(self.op("idea.add", title="-renew by email, a title that starts with a hyphen")["idea"]["title"],
                         "-renew by email, a title that starts with a hyphen")
        self.assertEqual(self.op("idea.add", title="Fine shown twice", from_fault=FAULT)["idea"]["source"]["kind"], "fault")
        self.op("idea.stage", idea_id="IDEA-001", stage="exploring")
        self.op("idea.lookups", idea_id="IDEA-001", lookups=lookups)
        write(self.via_host, "IDEA-001.md", brief)
        checked = self.op("brief.check", idea_id="IDEA-001")
        self.assertEqual((checked["passes"], checked["stage"]), (True, "brief"), checked["errors"])
        self.op("brief.show", idea_id="IDEA-001")
        write(self.via_host, "IDEA-001.case.md", CASE)
        self.op("case.show", idea_id="IDEA-001")
        self.op("case.check", idea_id="IDEA-001")
        self.op("idea.show", idea_id="IDEA-001")
        self.op("idea.list")
        self.assertEqual(self.op("idea.faults")["faults"], [])
        self.assertIsNone(self.op("verdict.record", idea_id="IDEA-001", decision="go", reason="Members ask for it at every desk.")["verdict"]["by"])
        self.assertEqual(self.op("idea.size", idea_id="IDEA-001")["route"], "small-change")  # M18: one outcome, one capability, no rule
        self.op("idea.map", idea_id="IDEA-001", map=mapped)
        self.assertIn("already carried", host_refused("idea.settle", {"idea_id": "IDEA-001", "outcome": "O-1", "as": "later", "reason": "Next year."}))
        self.assertTrue(self.op("idea.map-status", idea_id="IDEA-001")["can_apply"])
        self.assertIn("which kind", host_refused("idea.apply", {"idea_id": "IDEA-001"}))
        self.assertEqual(self.op("idea.apply", idea_id="IDEA-001", change="adjustment")["stage"], "shaped")
        self.op("idea.chain", idea_id="IDEA-001")
        self.assertEqual(self.op("idea.publish", idea_id="IDEA-001")["saved_to"], "folder")
        host_refused("lookback.record", {"idea_id": "IDEA-001", "outcome": "O-1", "result": "met", "note": "Down to 11 a week."})
        host_refused("idea.change", {"rule": "SLICE-009/FR-01"})
        self.op("idea.renumber", idea_id="IDEA-003")
        self.assertFalse((self.via_host / ".factory/studio/uploads").exists() and any((self.via_host / ".factory/studio/uploads").iterdir()))

        # Directly, as the terminal skill does.
        self.studio("status")
        self.studio("project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Members borrow without friction.", "--outcome", "Members renew without calling")
        self.studio("epic", "add", "--title", "Lending", "--criterion", "Loans follow the desk's rules")
        self.studio("principle", "add", "--title", "Tell first", "--statement", "A member MUST be told why a renewal is refused.", "--reason", "Trust.")
        self.studio("idea", "add", "Let members renew a loan themselves")
        self.studio("idea", "add", "--", "-renew by email, a title that starts with a hyphen")
        self.studio("idea", "add", "Fine shown twice", "--from-fault", FAULT)
        self.studio("idea", "stage", "IDEA-001", "exploring")
        self.studio("idea", "lookups", "IDEA-001", "--from", str(files / "lookups.json"))
        write(self.direct, "IDEA-001.md", brief)
        self.studio("brief", "check", "IDEA-001")
        self.studio("brief", "show", "IDEA-001")
        write(self.direct, "IDEA-001.case.md", CASE)
        self.studio("case", "show", "IDEA-001")
        self.studio("case", "check", "IDEA-001")
        self.studio("idea", "show", "IDEA-001")
        self.studio("idea", "list")
        self.studio("idea", "faults")
        self.studio("verdict", "record", "IDEA-001", "--decision", "go", "--reason", "Members ask for it at every desk.")
        self.studio("idea", "size", "IDEA-001")
        self.studio("idea", "map", "IDEA-001", "--from", str(files / "map.json"))
        self.studio("idea", "settle", "IDEA-001", "--outcome", "O-1", "--as", "later", "--reason", "Next year.", expect=1)
        self.studio("idea", "map-status", "IDEA-001")
        self.studio("idea", "apply", "IDEA-001", expect=1)
        self.studio("idea", "apply", "IDEA-001", "--change", "adjustment")
        self.studio("idea", "chain", "IDEA-001")
        self.studio("idea", "publish", "IDEA-001")
        self.studio("lookback", "record", "IDEA-001", "--outcome", "O-1", "--result", "met", "--note", "Down to 11 a week.", expect=1)
        self.studio("idea", "change", "SLICE-009/FR-01", expect=1)
        self.studio("idea", "renumber", "IDEA-003")

        host_files, direct_files = workspace(self.via_host), workspace(self.direct)
        self.assertEqual(sorted(host_files), sorted(direct_files))
        for name in host_files:
            self.assertEqual(host_files[name], direct_files[name], f"{name} differs between the host and the terminal")
        for expected in ("draft/product/ideas/IDEA-001.json", "draft/product/ideas/IDEA-001.lookups.json", "draft/product/ideas/IDEA-001.map.json",
                         "draft/product/ready/IDEAS/IDEA-001/brief.md", "draft/product/ideas/IDEA-004.json"):
            self.assertIn(expected, host_files)
        for project in (self.via_host, self.direct):
            self.assertEqual(git(project, "status", "--porcelain").stdout, "")

    def test_the_m17_needs_and_design_operations_write_the_same_bytes_as_the_terminal(self):
        """Every technical needs and design operation M17 put on the host's list, through the host as the app sends it
        (the design as an upload in the body) and through studio.py as the terminal skill runs it; the design's map is
        recorded by studio.py in both, as the needs conversation records it (no button records a map). The same bytes
        in Product Studio's workspace, the same refusals, nothing staged left behind. No GitHub here: the needs and the
        design are published to the folder."""
        from test_mach_product_design import DESIGN_TEXT, a_map

        files = Path(self.tmp.name) / "needs-files"
        files.mkdir()
        (files / "architecture.md").write_text(DESIGN_TEXT, encoding="utf-8")
        (files / "map.json").write_text(json.dumps(a_map()))
        people = "About three hundred staff use it from two offices, busiest on Monday mornings."
        data = "Invitations are kept at most one year."
        given = "It runs on the company's PostgreSQL cluster."

        def host_refused(operation, args):
            status, _, raw = self.request("POST", f"/api/ops/{operation}", args)
            envelope = json.loads(raw)
            self.assertFalse(envelope["ok"], f"{operation} was not refused")
            self.assertEqual((status, envelope["error"]["kind"]), (422, "refused"), envelope)
            return envelope["error"]["message"]

        def mapped(project):
            done = subprocess.run([sys.executable, str(STUDIO), "--project", str(project), "design", "map", "DES-01", "--from", str(files / "map.json")],
                                  capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)

        # Through the host.
        self.login()
        self.op("project.init", id="team-space", name="Team Space", vision="Teams work together.", outcome=["Teams can work together"])
        self.assertEqual(self.op("need.list")["unanswered"], ["people", "data", "connections", "never", "priority", "given"])
        self.assertEqual(self.op("need.add", kind="people", statement=people, why="It sets the size.")["need"]["need_id"], "TN-01")
        self.assertIn("names technology", host_refused("need.add", {"kind": "data", "statement": "Kept in a database.", "why": "W."}))
        self.op("need.add", kind="data", statement=data, why="Privacy.")
        self.assertEqual(self.op("need.add", kind="given", statement=given, why="Already paid for.", said_by="Jo Bloggs, CTO", said_on="2026-11-02")
                         ["need"]["said_by"], "Jo Bloggs, CTO")
        self.assertEqual(self.op("need.set", need_id="TN-01", statement="About five hundred staff use it.")["need"]["revision"], 2)
        self.op("need.none", kind="never")
        self.op("need.add", kind="priority", statement="When safety and speed conflict, safety wins.", why="Mistakes cost more.")
        self.op("need.retire", need_id="TN-04")
        self.assertIn("no newer version", host_refused("reconcile.needs", {"take": "theirs"}))
        self.assertEqual(self.op("need.publish")["saved_to"], "folder")
        upload = {"name": "architecture.md", "content_base64": base64.b64encode(DESIGN_TEXT.encode("utf-8")).decode("ascii")}
        self.assertEqual(self.op("design.import", file=upload)["design"]["design_id"], "DES-01")
        self.assertTrue(self.op("design.import", file=upload)["already_imported"])
        self.op("design.list")
        self.op("design.show", design_id="DES-01", lines="5-9")
        self.assertIn("no map yet", host_refused("design.publish", {"design_id": "DES-01"}))
        mapped(self.via_host)
        self.assertIn("waits for your word", host_refused("design.publish", {"design_id": "DES-01"}))
        self.op("design.settle", design_id="DES-01", conflict=1, **{"as": "design-is-wrong"}, reason="The privacy review came later.")
        self.assertTrue(self.op("design.publish", design_id="DES-01")["changed"])
        self.op("design.show", design_id="DES-01")
        self.op("need.list")
        self.assertFalse((self.via_host / ".factory/studio/uploads").exists() and any((self.via_host / ".factory/studio/uploads").iterdir()))

        # Directly, as the terminal skill does.
        self.studio("status")
        self.studio("project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together.", "--outcome", "Teams can work together")
        self.studio("need", "list")
        self.studio("need", "add", "--kind", "people", "--statement", people, "--why", "It sets the size.")
        self.studio("need", "add", "--kind", "data", "--statement", "Kept in a database.", "--why", "W.", expect=1)
        self.studio("need", "add", "--kind", "data", "--statement", data, "--why", "Privacy.")
        self.studio("need", "add", "--kind", "given", "--statement", given, "--why", "Already paid for.", "--said-by", "Jo Bloggs, CTO", "--said-on", "2026-11-02")
        self.studio("need", "set", "TN-01", "--statement", "About five hundred staff use it.")
        self.studio("need", "none", "--kind", "never")
        self.studio("need", "add", "--kind", "priority", "--statement", "When safety and speed conflict, safety wins.", "--why", "Mistakes cost more.")
        self.studio("need", "retire", "TN-04")
        self.studio("reconcile", "needs", "--take", "theirs", expect=1)
        self.studio("need", "publish")
        self.studio("design", "import", str(files / "architecture.md"))
        self.studio("design", "import", str(files / "architecture.md"))
        self.studio("design", "list")
        self.studio("design", "show", "DES-01", "--lines", "5-9")
        self.studio("design", "publish", "DES-01", expect=1)
        mapped(self.direct)
        self.studio("design", "publish", "DES-01", expect=1)
        self.studio("design", "settle", "DES-01", "--conflict", "1", "--as", "design-is-wrong", "--reason", "The privacy review came later.")
        self.studio("design", "publish", "DES-01")
        self.studio("design", "show", "DES-01")
        self.studio("need", "list")

        host_files, direct_files = workspace(self.via_host), workspace(self.direct)
        # The published design.json carries the moment each conflict was settled, so the hash recorded of it in the map
        # differs between two runs as that moment does; design.json itself is compared with its moments masked.
        published = re.compile(rb'("published": \{[^}]*"sha256": ")[0-9a-f]{64}')
        for found in (host_files, direct_files):
            found["draft/product/designs/DES-01/map.json"] = published.sub(rb"\1<SHA256>", found["draft/product/designs/DES-01/map.json"])
        self.assertEqual(sorted(host_files), sorted(direct_files))
        for name in host_files:
            self.assertEqual(host_files[name], direct_files[name], f"{name} differs between the host and the terminal")
        for expected in ("draft/product/needs.json", "draft/product/ready/NEEDS/needs.json", "draft/product/designs/DES-01/map.json",
                         "draft/product/ready/DESIGN/DES-01/design.json", "draft/product/ready/DESIGN/DES-01/design.md"):
            self.assertIn(expected, host_files)
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
