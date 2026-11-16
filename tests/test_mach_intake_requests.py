"""M8 batch 3: intake's status writes on a slice's request, and the origin from slice to run record.

A product manager picks GitHub issue #42 up in Product Studio, approves and sends the slice, and
engineering merges it. The engineer's Factory then takes it in. Runs against a local bare
repository reached through a github.com address (url.insteadOf), with the stand-in for gh from
tests/test_mach_requests.py, extended to remove a label. Nothing reaches the network.
"""

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "ticket" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "cleanup" / "scripts"))
import cleanup  # noqa: E402
import issue_rules  # noqa: E402
import test_mach_product_intake as intake_tests  # noqa: E402
import test_mach_requests as request_tests  # noqa: E402
from test_mach_product_collab import git  # noqa: E402

REPO = request_tests.REPO
ADDRESS = request_tests.ADDRESS
TICKET = ROOT / "skills" / "ticket" / "scripts" / "ticket.py"
NETWORK_DOWN = "Post https://api.github.com/graphql: dial tcp: lookup api.github.com: no such host"

# The batch 1 stand-in handles --add-label only; intake's merged moment also removes mach:grooming.
REMOVE_LABEL = r'''
elif args[:2] == ["issue", "edit"] and "--remove-label" in args:
    state.setdefault("calls", []).append(args)
    fails = state.get("issue_fail") or {}
    message = fails.get("issue edit") or fails.get("*")
    if message:
        print(message, file=sys.stderr)
        done(1)
    issue = state["issues"][args[2]]
    issue["labels"] = [l for l in issue["labels"] if l["name"] != value("--remove-label")]'''
SPLIT = '\nelif args[0] in ("issue", "api", "repo", "label"):'
assert request_tests.FAKE.count(SPLIT) == 1
FAKE = request_tests.FAKE.replace(SPLIT, REMOVE_LABEL + SPLIT, 1)

OLD_INTAKE = None


def intake_before_m8_batch3():
    """intake.py as it was before this batch (commit b596d8a), to compare a slice with no origin."""
    global OLD_INTAKE
    if OLD_INTAKE is None:
        source = subprocess.run(["git", "show", "b596d8a:skills/run/scripts/intake.py"], cwd=str(ROOT), capture_output=True, text=True)
        if source.returncode != 0:
            return None
        path = Path(__file__).resolve().parent / "__pycache__" / "intake_before_m8_batch3.py"
        path.parent.mkdir(exist_ok=True)
        path.write_text(source.stdout)
        spec = importlib.util.spec_from_file_location("intake_before_m8_batch3", str(path))
        OLD_INTAKE = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(OLD_INTAKE)
    return OLD_INTAKE


class Base(intake_tests.Base, request_tests.RequestBase):
    """The intake test project (engineer's Factory, local tickets) with the requests stand-in for gh."""

    def setUp(self):
        super().setUp()
        (self.root / "bin" / "gh").write_text(FAKE.replace("#!/usr/bin/env python3", "#!" + sys.executable, 1))
        git(self.eng, "remote", "set-url", "origin", ADDRESS)
        git(self.eng, "config", f"url.{self.origin}.insteadOf", ADDRESS)
        self.set_gh(missing_labels=["mach:grooming", "mach:ready"])

    def config(self, **tickets):
        path = self.eng / ".factory/config.json"
        data = json.loads(path.read_text())
        data["tickets"].update(tickets)
        path.write_text(json.dumps(data))

    def requested(self):
        """Ada picks #42 up, approves and sends the slice; engineering merges it."""
        self.ready(self.a)
        self.request(self.a)
        slice_id = self.ok(self.a, "request", "pick", "42", "--epic", "EPIC-001", "--title", "Invite a teammate")["slice"]["slice_id"]
        self.write_slice(self.a, slice_id)
        self.ok(self.a, "slice", "approve", slice_id)
        wave = self.new_wave(self.a, slice_id)
        self.ok(self.a, "send", wave)
        self.land(f"product/{wave}")
        self.ok(self.a, "refresh")
        return slice_id

    def moment(self, moment):
        return [body for body in self.comments() if f"moment={moment} " in body]

    def labels(self):
        return [label["name"] for label in self.gh()["issues"]["42"]["labels"]]

    def status_calls(self):
        """gh calls made for status writes: label changes, comment reads and comments."""
        return [call for call in self.gh().get("calls", []) if call[:2] in (["issue", "edit"], ["issue", "comment"], ["label", "create"])
                or (call[:2] == ["issue", "view"] and "comments" in call)]

    def outbox(self):
        return self.ledger().get("request_status") or {}

    def merged_body(self, slice_id="SLICE-001", ticket_id="LOCAL-001"):
        revision = self.ledger()["slices"][slice_id]["revision"]
        return issue_rules.comment("merged", [f"{slice_id}@r{revision}", f"ticket:{ticket_id}"], self.nonce_eng())["body"]

    def nonce_eng(self):
        """The Factory's own marker nonce, kept in its intake ledger."""
        path = self.eng / ".factory/intake/ledger.json"
        ledger = self.ledger() if path.is_file() else {"schema_version": 1}
        if "request_status_nonce" not in ledger:  # made when the first write is queued; a test may need it earlier
            ledger["request_status_nonce"] = "0123456789abcdef0123456789abcdef"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(ledger))
        return ledger["request_status_nonce"]

    def request_status(self, *argv, nonce="0123456789abcdef0123456789abcdef"):
        extra = ["--nonce", nonce] if nonce else []
        return subprocess.run([sys.executable, str(TICKET), "--project", str(self.eng), "request-status", *argv, *extra], capture_output=True, text=True)


class MergedTest(Base):
    def test_merged_slice_with_origin_sets_ready_and_comments_once(self):
        slice_id = self.requested()
        self.assertIn("mach:grooming", self.labels())
        taken = self.product("intake")
        self.assertEqual([item["ticket_id"] for item in taken["created"]], ["LOCAL-001"])
        self.assertEqual(taken["request_status"], {"pending": 0, "done": 1, "refused": 0})
        self.assertEqual(self.moment("merged"), [self.merged_body(slice_id)])
        self.assertTrue(self.moment("merged")[0].startswith(f"{slice_id} revision "))
        self.assertIn("is approved and merged; the Factory may take it (ticket LOCAL-001).", self.moment("merged")[0])
        self.assertIn("mach:ready", self.labels())
        self.assertNotIn("mach:grooming", self.labels())
        made = [call for call in self.gh()["calls"] if call[:2] == ["label", "create"] and call[2] == "mach:ready"]
        self.assertEqual(len(made), 1)
        self.assertNotIn("--force", made[0])
        self.assertEqual(made[0][made[0].index("--repo") + 1], REPO)
        (write,) = self.outbox().values()
        self.assertEqual((write["moment"], write["repository"], write["number"], write["state"], write["outcome"], write["attempts"]),
                         ("merged", REPO, 42, "done", "done", 1))
        # Idempotent across intakes and reconciles: a done write is never tried again.
        calls = len(self.status_calls())
        self.product("intake")
        self.product("reconcile")
        self.assertEqual(len(self.status_calls()), calls)
        self.assertEqual(len(self.moment("merged")), 1)
        # A write whose answer was lost is found on the issue by its marker and not made again.
        ledger = self.ledger()
        for item in ledger["request_status"].values():
            item.update(state="pending", outcome=None)
        (self.eng / ".factory/intake/ledger.json").write_text(json.dumps(ledger))
        self.product("intake")
        self.assertEqual(len(self.moment("merged")), 1)
        (write,) = self.outbox().values()
        self.assertEqual((write["state"], write["outcome"]), ("done", "already_done"))

    def test_intake_offline_records_pending_and_files_tickets_anyway(self):
        self.requested()
        self.set_gh(issue_fail={"*": NETWORK_DOWN})
        code, out, err = self.run_product("intake")
        self.assertEqual(code, 0, err + out)
        taken = json.loads(out)
        self.assertEqual([item["ticket_id"] for item in taken["created"]], ["LOCAL-001"])
        self.assertEqual(self.tickets(), ["LOCAL-001"])
        self.assertEqual(self.ledger()["slices"]["SLICE-001"]["ticket_id"], "LOCAL-001")
        self.assertEqual(taken["request_status"], {"pending": 1, "done": 0, "refused": 0})
        (write,) = self.outbox().values()
        self.assertEqual((write["state"], write["kind"], write["attempts"]), ("pending", "network", 1))
        for text in (out, err, (self.eng / ".factory/intake/ledger.json").read_text()):
            self.assertNotIn("no such host", text)  # gh's own words are never relayed, only the kind
        self.assertEqual(self.moment("merged"), [])
        # GitHub is back: the next reconcile makes the write, once.
        self.set_gh(issue_fail={})
        result = self.product("reconcile")
        self.assertEqual(result["intake"]["request_status"], {"pending": 0, "done": 1, "refused": 0})
        self.assertEqual(self.moment("merged"), [self.merged_body()])
        self.product("reconcile")
        self.assertEqual(len(self.moment("merged")), 1)

    def test_a_comment_already_carrying_the_key_is_not_posted_again(self):
        self.requested()
        self.product("intake", "--dry-run")
        # The comment is already on the issue, as if an earlier write's answer was lost before it was recorded.
        revision = json.loads(git(self.eng, "show", "origin/main:product/slices/SLICE-001.json"))["revision"]
        body = issue_rules.comment("merged", [f"SLICE-001@r{revision}", "ticket:LOCAL-001"], self.nonce_eng())["body"]
        self.issue(comments=[*self.comments(), body])
        self.product("intake")
        self.assertEqual(self.moment("merged"), [body])
        self.assertFalse([call for call in self.gh()["calls"] if call[:2] == ["issue", "comment"] and "moment=merged" in " ".join(call)])
        (write,) = self.outbox().values()
        self.assertEqual((write["state"], write["outcome"]), ("done", "already_done"))
        self.assertIn("mach:ready", self.labels())  # labels are set-like and still written

    def test_status_comments_off_sets_the_label_and_posts_nothing(self):
        self.requested()
        self.config(github={"status_comments": False})
        before, calls = len(self.comments()), len(self.gh()["calls"])
        self.product("intake")
        self.assertIn("mach:ready", self.labels())
        self.assertNotIn("mach:grooming", self.labels())
        self.assertEqual(len(self.comments()), before)
        self.assertEqual(self.moment("merged"), [])
        self.assertFalse([call for call in self.gh()["calls"][calls:] if call[:2] == ["issue", "comment"] or "comments" in call])
        (write,) = self.outbox().values()
        self.assertEqual(write["state"], "done")


class BlockedTest(Base):
    def test_blocked_cell_comments_on_its_request_once(self):
        self.requested()
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.product("reconcile")
        self.assertEqual(self.moment("blocked"), [])
        self.set_cell("LOCAL-001", stage="blocked")
        self.set_gh(issue_fail={"*": NETWORK_DOWN})
        self.product("reconcile")  # queued first; GitHub is down, so it waits
        self.assertEqual([w["state"] for w in self.outbox().values() if w["moment"] == "blocked"], ["pending"])
        self.set_gh(issue_fail={})
        self.product("reconcile")
        self.product("reconcile")
        self.product("intake")
        expected = issue_rules.comment("blocked", ["ticket:LOCAL-001"], self.nonce_eng())["body"]
        self.assertEqual(self.moment("blocked"), [expected])
        self.assertTrue(expected.startswith("Ticket LOCAL-001 is blocked and waits for a person."))
        self.assertNotIn("mach:blocked", self.labels())  # a product request's issue mirrors no line state
        # Unblocked and blocked again: still one comment.
        self.set_cell("LOCAL-001", stage="building")
        self.product("reconcile")
        self.set_cell("LOCAL-001", stage="blocked")
        self.product("reconcile")
        self.assertEqual(len(self.moment("blocked")), 1)
        self.assertEqual(len([w for w in self.outbox().values() if w["moment"] == "blocked"]), 1)


class OriginTest(Base):
    def test_origin_flows_to_ticket_cell_and_run_record(self):
        self.requested()
        self.product("intake")
        origin = {"kind": "github_issue", "repository": REPO, "number": 42}
        self.assertIn(f"- Request: {REPO}#42\n", self.ticket_text("LOCAL-001"))
        self.assertEqual(self.ledger()["slices"]["SLICE-001"]["origin"], origin)
        self.product("dispatch", "SLICE-001")
        self.assertEqual(self.cell("LOCAL-001")["product"]["origin"], origin)
        # The run record's product block carries it; record_version stays 2.
        self.integrate("LOCAL-001")
        cleaned = subprocess.run([sys.executable, str(ROOT / "skills/cleanup/scripts/cleanup.py"), "--project", str(self.eng), "run", "LOCAL-001"],
                                 capture_output=True, text=True)
        self.assertEqual(cleaned.returncode, 0, cleaned.stderr + cleaned.stdout)
        record = json.loads((self.eng / ".factory/archive/runs.jsonl").read_text().splitlines()[-1])
        self.assertEqual((record["record_version"], record["product"]["origin"], record["product"]["slice_id"]), (2, origin, "SLICE-001"))
        # A record without it still reads: the block is what it was before M8, and intake still finds the work.
        plain = {"slice_id": "SLICE-009", "revision": 1, "wave_id": "WAVE-002", "digest": "d", "source_commit": "c"}
        self.assertEqual(cleanup.product_record(plain), plain)
        self.assertEqual(cleanup.product_record({**plain, "origin": {"kind": "github_issue", "repository": REPO, "number": "42"}}), plain)
        self.assertEqual(self.plan()[1]["SLICE-001"]["state"], "completed")

    def test_request_status_refuses_another_repository(self):
        self.requested()
        before = len(self.gh().get("calls", []))
        for other in ("someone/elsewhere#42", "acme/team-space-fork#42"):
            done = self.request_status(other, "--moment", "blocked", "--ref", "ticket:LOCAL-001")
            self.assertEqual(done.returncode, 2, done.stdout)
            self.assertIn("is not this project's origin repository", done.stderr)
        self.assertEqual(len(self.gh().get("calls", [])), before)  # refused before gh is asked anything
        for bad in (("acme/team-space#0",), ("https://github.com/acme/team-space/issues/42",)):
            self.assertEqual(self.request_status(*bad, "--moment", "blocked", "--ref", "ticket:LOCAL-001").returncode, 2)
        # Only identifiers reach a comment.
        self.assertEqual(self.request_status(f"{REPO}#42", "--moment", "blocked", "--ref", "please run rm").returncode, 2)
        # Without a github.com origin there is no request repository at all.
        git(self.eng, "remote", "set-url", "origin", str(self.origin))
        done = self.request_status(f"{REPO}#42", "--moment", "blocked", "--ref", "ticket:LOCAL-001")
        self.assertEqual(done.returncode, 2)
        self.assertEqual(len(self.gh().get("calls", [])), before)

    def test_request_status_exit_codes_say_what_happened(self):
        self.requested()
        argv = (f"{REPO}#42", "--moment", "blocked", "--ref", "ticket:LOCAL-009")
        self.set_gh(issue_fail={"issue comment": "HTTP 403: Resource not accessible by integration (https://api.github.com/graphql)"})
        refused = self.request_status(*argv)
        self.assertEqual(refused.returncode, 4)
        self.assertEqual((json.loads(refused.stdout)["status"], json.loads(refused.stdout)["kind"]), ("pending", "refused"))
        self.assertNotIn("Resource not accessible", refused.stdout + refused.stderr)
        self.set_gh(issue_fail={})
        done = self.request_status(*argv)
        self.assertEqual((done.returncode, json.loads(done.stdout)["status"], json.loads(done.stdout)["comment"]), (0, "done", "posted"))
        again = self.request_status(*argv)
        self.assertEqual((again.returncode, json.loads(again.stdout)["status"]), (3, "already_done"))
        self.assertEqual(len(self.moment("blocked")), 1)

    def test_a_slice_with_no_origin_is_byte_identical_to_before(self):
        old = intake_before_m8_batch3()
        if old is None:
            self.skipTest("the commit before this batch is not in this checkout")
        self.first()  # Ada's plain slice: no request
        calls = list(self.gh().get("calls", []))
        taken = self.product("intake")
        self.assertNotIn("request_status", taken)
        self.assertNotIn("request_status", self.ledger())
        self.assertNotIn("origin", self.ledger()["slices"]["SLICE-001"])
        self.assertEqual(self.gh().get("calls", []), calls)  # GitHub is never asked about a slice with no request
        _, line = intake_tests.run.factory(intake_tests.run.Project(self.eng))
        found = line.discover()
        snap = found.pop("_snapshot")
        (row,) = [item for item in found["slices"] if item["slice_id"] == "SLICE-001"]
        self.assertNotIn("origin", row)
        self.assertEqual(line.ticket_text(row, snap), old.Factory.ticket_text(line, row, snap))
        self.assertEqual(json.dumps(line.definition(row, snap)), json.dumps(old.Factory.definition(line, row, snap)))
        _, body = line.ticket_text(row, snap)
        self.assertIn(body, self.ticket_text("LOCAL-001"))
        self.product("dispatch", "SLICE-001")
        self.assertEqual(list(self.cell("LOCAL-001")["product"]), ["slice_id", "revision", "wave_id", "digest", "spec_sha256", "source_commit"])


class SecurityReviewTest(Base):
    """Regression tests for the ticket and intake side of the security review."""

    def test_l2_request_status_needs_the_nonce_and_a_forged_marker_does_not_stop_it(self):
        import hashlib
        self.requested()
        argv = (f"{REPO}#42", "--moment", "blocked", "--ref", "ticket:LOCAL-009")
        before = len(self.gh().get("calls", []))
        for nonce in (None, "short", "Z" * 32):
            done = self.request_status(*argv, nonce=nonce)
            self.assertEqual(done.returncode, 2, done.stdout)
            self.assertIn("nonce", done.stderr)
        self.assertEqual(len(self.gh().get("calls", [])), before)
        old_key = hashlib.sha256(("blocked\nticket:LOCAL-009").encode()).hexdigest()[:16]
        self.issue(comments=[*self.comments(), "spoof " + issue_rules.marker("blocked", old_key)])
        done = self.request_status(*argv)
        self.assertEqual((done.returncode, json.loads(done.stdout)["comment"]), (0, "posted"))
        self.assertEqual(len(self.moment("blocked")), 2)  # the forgery and the real one

    def test_l2_intake_keeps_its_own_random_nonce(self):
        self.requested()
        self.product("intake")
        nonce = self.ledger()["request_status_nonce"]
        self.assertTrue(issue_rules.is_nonce(nonce))
        self.assertNotEqual(nonce, "0123456789abcdef0123456789abcdef")
        self.assertEqual(self.moment("merged"), [self.merged_body()])

    def test_l3_ticket_classifier_tells_not_found_from_network(self):
        sys.path.insert(0, str(TICKET.parent))
        import ticket
        self.assertEqual(ticket.gh_failure_kind("GraphQL: Could not resolve to an issue or pull request with the number of 42."), "not_found")
        self.assertEqual(ticket.gh_failure_kind("GraphQL: Could not resolve to a Repository with the name 'a/b'."), "not_found")
        self.assertEqual(ticket.gh_failure_kind("dial tcp: lookup api.github.com: no such host"), "network")
        self.assertEqual(ticket.gh_failure_kind("Could not resolve host: api.github.com"), "network")
        self.assertIsNone(ticket.GITHUB_REMOTE_RE.fullmatch("git@github.com:-evil/repo.git"))  # N7

    def test_l6_intake_gives_up_on_unfixable_writes_and_caps_retries(self):
        self.requested()
        self.set_gh(issue_fail={"issue edit": "HTTP 403: Resource not accessible by integration"})
        taken = self.product("intake")
        self.assertEqual(taken["request_status"]["gave_up"], 1)
        (write,) = self.outbox().values()
        self.assertEqual((write["state"], write["kind"], write["attempts"]), ("gave_up", "refused", 1))
        self.set_gh(issue_fail={})
        calls = len(self.status_calls())
        self.product("reconcile")
        self.assertEqual(len(self.status_calls()), calls)  # never tried again
        status = self.product("status")
        self.assertEqual(status["request_status_updates"], {"gave_up": 1})
        # A network failure is retried, but at most 20 times.
        ledger = self.ledger()
        for item in ledger["request_status"].values():
            item.update(state="pending", kind="network", attempts=20)
        (self.eng / ".factory/intake/ledger.json").write_text(json.dumps(ledger))
        self.assertEqual(self.product("status")["request_status_updates"], {"waiting": 1})
        self.product("reconcile")
        self.assertEqual(len(self.status_calls()), calls)
        (write,) = self.outbox().values()
        self.assertEqual(write["state"], "gave_up")

    def test_status_without_requests_prints_what_it_printed_before(self):
        self.first()
        self.product("intake")
        self.assertNotIn("request_status_updates", self.product("status"))

    def test_n6_moved_issue_is_never_written_and_given_up(self):
        self.requested()
        self.issue(url="https://github.com/someone/else/issues/9")
        calls = len(self.status_calls())
        taken = self.product("intake")
        self.assertEqual(len(self.status_calls()), calls)  # no label, no comment
        (write,) = self.outbox().values()
        self.assertEqual((write["state"], write["kind"]), ("gave_up", "moved"))
        self.assertEqual(taken["request_status"]["gave_up"], 1)
        self.assertNotIn("mach:ready", self.labels())


if __name__ == "__main__":
    unittest.main()
