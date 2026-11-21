"""Tests for merge.py: approvals bound to a commit, revalidation against main, local and pull-request merges."""

import io
import json
import os
import re
import stat
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "merge" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import merge  # noqa: E402
from test_build import git  # noqa: E402
from test_run import Base as RunBase  # noqa: E402
import class_template  # noqa: E402  (a step taken from the same starting folder is run once per class)

FAKE_GH = '''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
state = os.environ["FAKE_GH_STATE"]
with open(os.environ["FAKE_GH_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
if args[:2] == ["pr", "create"]:
    print("https://github.com/acme/app/pull/12")
elif args[:2] == ["pr", "merge"]:
    if os.environ.get("FAKE_GH_BLOCK"):
        sys.stderr.write("Pull request is not mergeable: required status checks are pending\\n")
        sys.exit(1)
    open(state, "w").write("merged")
elif args[:2] == ["pr", "view"]:
    merged = os.path.exists(state)
    print(json.dumps({"state": "MERGED" if merged else "OPEN", "mergeCommit": {"oid": "f" * 40} if merged else None, "headRefOid": "x"}))
elif args[:1] == ["api"] or args[:2] == ["pr", "comment"]:
    data = sys.stdin.read()
    with open(os.environ["FAKE_GH_LOG"] + ".stdin", "a") as log:
        log.write(json.dumps({"args": args, "stdin": data}) + "\\n")
    if os.environ.get("FAKE_GH_API_FAIL" if args[0] == "api" else "FAKE_GH_COMMENT_FAIL"):
        sys.stderr.write("HTTP 422: Unprocessable Entity\\n")
        sys.exit(1)
    print("{}")
'''


class Base(RunBase):
    def approved(self, **config):
        self.verified()
        head = git(self.work, "rev-parse", "HEAD").stdout.strip()
        self.put(self.cellroot, {"review/decision.json": json.dumps({
            "outcome": "APPROVED", "head": head, "round": 1, "votes": {"architecture": "APPROVE", "security": "APPROVE", "product": "APPROVE"},
            "blockers": 0, "human_approval_required": False, "human_approval": None, "findings": str(self.cellroot / "review/round-1/findings.md")})})
        self.set_cell(stage="approved", review="APPROVED")
        if config:
            self.put(self.project, {".factory/config.json": json.dumps({"merge": config})})
        return head

    def m(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = merge.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def m_ok(self, *argv):
        code, out, err = self.m(*argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def m_refused(self, *argv):
        code, out, err = self.m(*argv)
        self.assertEqual(code, 1, out)
        return err

    def main_log(self):
        return git(self.project, "log", "--format=%s", "main").stdout.splitlines()

    def record_commit(self, on):
        """The change record commit the station added (M13), checked to sit directly on `on` and to add only the record."""
        record = self.cell_json()["change_record"]
        self.assertEqual(git(self.work, "rev-list", "--parents", "-n", "1", record["commit"]).stdout.split(), [record["commit"], on])
        self.assertEqual(git(self.work, "diff-tree", "--no-commit-id", "--name-status", "-r", on, record["commit"]).stdout.splitlines(), [f"A\t{record['path']}"])
        return record["commit"]


class PolicyTest(Base):
    def test_manual_mode_leaves_the_merge_to_a_person(self):
        self.approved()
        plan = self.m_ok("plan", "LOCAL-001")
        self.assertEqual((plan["allowed"], plan["mode"], plan["approval_valid"]), (False, "manual", True))
        self.assertIn("a person merges this ticket", plan["refusals"][0])
        self.assertIn("a person merges this ticket", self.m_refused("run", "LOCAL-001"))
        self.assertEqual(self.main_log(), ["work"])
        self.assertTrue(self.m_ok("plan", "LOCAL-001", "--by-person")["allowed"])
        self.assertEqual(self.next()["needs"], "merge")

    def test_auto_mode_merges_locally_and_the_line_cleans_up(self):
        head = self.approved(mode="auto")
        self.assertEqual((self.next()["action"], self.next()["prompt"]), ("merge", "Use the MACH merge skill: /mach:merge LOCAL-001"))
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual((done["status"], done["approved_commit"], done["landed_commit"], done["revalidated"]), ("MERGED", head, self.record_commit(head), None))
        self.assertEqual(done["change_record"]["path"], "docs/changes/LOCAL-001.md")
        self.assertTrue((self.project / "docs/changes/LOCAL-001.md").is_file(), "the record lands with the change")
        self.assertEqual(self.main_log()[0], "Merge LOCAL-001: Invite a teammate by email")
        self.assertEqual(git(self.project, "merge-base", "--is-ancestor", head, "main").returncode, 0)
        self.assertEqual(self.cell_json()["stage"], "merged")
        self.assertEqual(self.next()["action"], "cleanup")
        self.assertIn("already merged", self.m_refused("run", "LOCAL-001"))

    def test_a_risk_tier_can_be_kept_for_a_person(self):
        self.approved(mode="auto", auto={"medium": False})
        self.assertIn("Medium-risk tickets are merged by a person", self.m_refused("run", "LOCAL-001"))
        self.assertEqual(self.next()["needs"], "merge")
        self.assertEqual(self.m_ok("run", "LOCAL-001", "--by-person")["status"], "MERGED")

    def test_only_an_approved_ticket_with_any_required_sign_off_merges(self):
        self.verified()
        self.put(self.project, {".factory/config.json": json.dumps({"merge": {"mode": "auto"}})})
        refusal = self.m_refused("run", "LOCAL-001")
        self.assertIn("Only an approved ticket can be merged", refusal)
        self.assertIn("no approval on record", refusal)
        self.approved_decision = json.loads((self.cellroot / "review/decision.json").read_text()) if (self.cellroot / "review/decision.json").exists() else {}
        head = git(self.work, "rev-parse", "HEAD").stdout.strip()
        self.put(self.cellroot, {"review/decision.json": json.dumps({"outcome": "APPROVED", "head": head, "human_approval_required": True, "human_approval": None})})
        self.set_cell(stage="approved")
        self.assertIn("requires a person's approval and none is recorded", self.m_refused("run", "LOCAL-001"))

    def test_main_checkout_must_be_clean_and_on_the_main_branch(self):
        self.approved(mode="auto")
        self.put(self.project, {"scratch.txt": "x", "app/__pycache__/a.pyc": "x"})
        self.assertIn("uncommitted changes (scratch.txt)", self.m_refused("run", "LOCAL-001"))
        (self.project / "scratch.txt").unlink()
        git(self.project, "checkout", "-q", "-b", "other")
        self.assertIn("not on main", self.m_refused("run", "LOCAL-001"))


class ApprovalTest(Base):
    def test_a_commit_added_after_approval_voids_it(self):
        self.approved(mode="auto")
        self.put(self.work, {"app/extra.py": "SNEAKY = True\n"})
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "added after review")
        plan = self.m_ok("plan", "LOCAL-001")
        self.assertEqual((plan["allowed"], plan["approval_valid"]), (False, False))
        self.assertEqual(self.cell_json()["stage"], "approved", "plan changes nothing")
        self.assertEqual(self.next()["action"], "merge", "the line sends it to the merge station, which voids the approval")
        refusal = self.m_refused("run", "LOCAL-001")
        self.assertIn("something was added after review", refusal)
        self.assertEqual(self.main_log(), ["work"])
        cell = self.cell_json()
        self.assertEqual((cell["stage"], cell["review"]), ("built", "VOID"))
        self.assertEqual(json.loads((self.cellroot / "review/decision.json").read_text())["outcome"], "VOID")
        self.assertEqual(self.next()["action"], "verify", "it is verified and reviewed again")

    def test_voiding_keeps_the_rounds_own_record_with_the_persons_approval(self):
        """M7 D3, in the shape of the real records: round-2/decision.json and the latest copy, with a person's sign-off."""
        head = self.approved(mode="auto")
        decision = json.loads((self.cellroot / "review/decision.json").read_text())
        decision.update(round=2, findings=str(self.cellroot / "review/round-2/findings.md"), human_approval_required=True,
                        human_approval={"by": "Engineer", "note": None, "recorded_at": "2026-11-13T10:00:00Z", "recorded_by": "an agent"})
        self.put(self.cellroot, {"review/decision.json": json.dumps(decision), "review/round-2/decision.json": json.dumps(decision),
                                 "review/round-2/findings.md": "# findings\n"})
        self.put(self.work, {"app/extra.py": "LATER = True\n"})
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "added after review")
        self.assertIn("something was added after review", self.m_refused("run", "LOCAL-001"))
        kept = json.loads((self.cellroot / "review/round-2/decision.json").read_text())
        self.assertEqual((kept["outcome"], kept["outcome_before_void"], kept["human_approval"]["by"], kept["head"]), ("VOID", "APPROVED", "Engineer", head))
        self.assertEqual((kept["void"]["approved_commit"], kept["void"]["branch_commit"]), (head, git(self.work, "rev-parse", "HEAD").stdout.strip()))
        self.assertEqual(json.loads((self.cellroot / "review/decision.json").read_text())["void"], kept["void"])


class RevalidationTest(Base):
    def test_main_moved_cleanly_the_branch_is_updated_retested_and_merged(self):
        head = self.approved(mode="auto")
        self.put(self.project, {"app/later.py": "VALUE = 1\n"})
        self.commit_main()
        self.assertTrue(self.m_ok("plan", "LOCAL-001")["behind_main"])
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        self.assertNotEqual(done["landed_commit"], head)
        self.assertEqual(self.record_commit(done["revalidated"]["head"]), done["landed_commit"], "the record sits on the revalidated commit")
        self.assertTrue((self.project / "app/invite.py").is_file() and (self.project / "app/later.py").is_file())

    def test_main_moved_and_the_suite_now_fails_goes_back_to_build(self):
        self.approved(mode="auto")
        self.put(self.project, {"tests/test_clash.py": "import unittest\n\nclass C(unittest.TestCase):\n    def test_clash(self):\n        import app.invite\n        self.fail('main now disagrees with this ticket')\n"})
        self.commit_main()
        self.put(self.project, {".factory/config.json": json.dumps({"merge": {"mode": "auto"}})})
        refusal = self.m_refused("run", "LOCAL-001")
        self.assertIn("the test suite fails, so nothing was merged", refusal)
        self.assertNotIn("Merge LOCAL-001", " ".join(self.main_log()))
        decision = json.loads((self.cellroot / "review/decision.json").read_text())
        self.assertEqual((decision["outcome"], decision["rejected_by"]), ("REJECTED", "merge station"))
        self.assertIn("main now disagrees", (self.cellroot / "review/merge-findings.md").read_text())
        step = self.next()
        self.assertEqual((step["action"], step["reason"]), ("revise", "The merge station sent this build back."))
        self.assertTrue(step["findings"].endswith("merge-findings.md"))
        self.assertEqual(self.ok("revise", "LOCAL-001", "--findings", step["findings"])["status"], "REVISING")

    def test_main_moved_with_a_conflict_needs_a_person(self):
        self.approved(mode="auto")
        self.put(self.project, {"README.md": "# Sample\n\nmain rewrote this\n"})
        self.commit_main()
        refusal = self.m_refused("run", "LOCAL-001")
        self.assertIn("conflicts in README.md", refusal)
        self.assertEqual(self.cell_json()["stage"], "approved")
        self.assertEqual(git(self.work, "status", "--porcelain").stdout, "")


class PullRequestBase(Base):
    def setUp(self):
        super().setUp()
        root = Path(self.tmp.name).resolve()
        origin = root / "origin.git"
        bin_dir = root / "fakebin"
        self.origin = origin
        class_template.step(self, "origin", root, lambda: self.remote_and_gh(root, origin, bin_dir))
        self.gh_log = root / "gh.log"
        env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "FAKE_GH_LOG": str(self.gh_log), "FAKE_GH_STATE": str(root / "merged.flag")}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)

    def remote_and_gh(self, root, origin, bin_dir):
        """A shared remote holding main, and the stand-in for gh; files only."""
        git(root, "init", "-q", "--bare", str(origin))
        git(self.project, "remote", "add", "origin", str(origin))
        git(self.project, "push", "-q", "-u", "origin", "main")
        bin_dir.mkdir()
        fake = bin_dir / "gh"
        fake.write_text(FAKE_GH)
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)

    def calls(self):
        return [json.loads(line) for line in self.gh_log.read_text().splitlines()] if self.gh_log.exists() else []


class PullRequestTest(PullRequestBase):
    def test_pull_request_is_opened_and_merged_at_the_approved_commit(self):
        head = self.approved(mode="auto", method="pr")
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual((done["status"], done["pull_request"], done["merge_commit"]), ("MERGED", "https://github.com/acme/app/pull/12", "f" * 40))
        tip = self.record_commit(head)
        self.assertEqual(git(self.project, "ls-remote", str(self.origin), "refs/heads/feature/LOCAL-001").stdout.split()[0], tip)
        created = next(call for call in self.calls() if call[:2] == ["pr", "create"])
        self.assertEqual(created[created.index("--title") + 1], "LOCAL-001: Invite a teammate by email")
        body = created[created.index("--body") + 1]
        for expected in ("**Risk tier:** Medium", "PASS: 8 of 8 checks passed", "architecture APPROVE", "No person's approval was required", f"Approved commit: `{head}`"):
            self.assertIn(expected, body)
        merged = next(call for call in self.calls() if call[:2] == ["pr", "merge"])
        self.assertEqual(merged[merged.index("--match-head-commit") + 1], tip, "the platform merges only the approved commit and its record")
        self.assertIn(f"Change record: `docs/changes/LOCAL-001.md`", body, "origin has no GitHub name here, so the path is given without a link")
        self.assertEqual(self.cell_json()["stage"], "merged")
        self.assertEqual(self.main_log(), ["work"], "with a pull request, nothing is merged into the local checkout")

    def test_pull_request_that_cannot_merge_yet_is_left_open(self):
        self.approved(mode="auto", method="pr")
        with mock.patch.dict(os.environ, {"FAKE_GH_BLOCK": "1"}):
            code, out, _ = self.m("run", "LOCAL-001")
        result = json.loads(out)
        self.assertEqual((code, result["status"]), (3, "PR_OPEN"))
        self.assertIn("required status checks are pending", result["note"])
        cell = self.cell_json()
        self.assertEqual((cell["stage"], cell["pull_request"]), ("pr-open", "https://github.com/acme/app/pull/12"))
        self.assertEqual(self.next()["action"], "merge")
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        self.assertEqual(sum(1 for call in self.calls() if call[:2] == ["pr", "create"]), 1, "the pull request is not opened twice")

    def test_manual_mode_opens_the_pull_request_for_a_person_to_merge(self):
        self.approved(mode="manual", method="pr")
        self.assertIn("a person merges this ticket", self.m_refused("run", "LOCAL-001"))
        self.assertEqual(self.calls(), [])


# A closing keyword followed by an issue reference, in any of the forms GitHub reads.
CLOSING = re.compile(r"(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s:]*(?:(?:[\w.-]+/[\w.-]+)?#\d|GH-\d|https?://\S+/(?:issues|pull)/\d)")
HOSTILE = "Fixes #3, closes acme/app#4, Resolved: https://github.com/acme/app/issues/5, fix GH-6"
TOKEN = "ghp_" + "A1b2" * 9


class ReferenceTest(PullRequestBase):
    """M11: the pull request refers to the slice's own issue, and never closes it (the Factory closes it once the merge is seen)."""

    def body(self):
        return merge.pr_body(merge.Cell(self.project, "LOCAL-001"))

    def name_origin(self, repository):
        """Give origin a GitHub address while pushes still reach the local bare repository."""
        address = f"https://github.com/{repository}.git"
        git(self.project, "config", f"url.{self.origin}.insteadOf", address)
        git(self.project, "remote", "set-url", "origin", address)

    def request(self, repository="acme/app", number=42):
        self.set_cell(product={"slice_id": "SLICE-001", "issue": {"repository": repository, "number": number}})

    def test_same_repository_refers_by_number(self):
        self.approved(mode="auto", method="pr")
        self.name_origin("acme/app")
        self.request("acme/app", 42)
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        created = next(call for call in self.calls() if call[:2] == ["pr", "create"])
        self.assertEqual(created[created.index("--body") + 1].splitlines()[-1], "Refs #42")

    def test_other_repository_refers_by_full_name(self):
        self.approved(mode="auto", method="pr")
        self.name_origin("acme/app")
        self.request("acme/requests", 7)
        self.assertEqual(self.body().splitlines()[-1], "Refs acme/requests#7")
        git(self.project, "remote", "set-url", "origin", str(self.origin))  # an address with no owner/name
        self.request("acme/app", 7)
        self.assertEqual(self.body().splitlines()[-1], "Refs acme/app#7")

    def test_an_invalid_or_missing_origin_adds_nothing(self):
        self.approved(mode="auto", method="pr")
        self.assertNotIn("Refs", self.body())
        for repository, number in (("acme/app", 0), ("acme/app", -1), ("acme/app", "42"), ("acme/app", True), ("acme/app", 10 ** 9),
                                   ("acme", 4), ("../x/y", 4), ("acme/app b", 4), ("acme/app/extra", 4), (None, 4), ("-acme/app", 4)):
            self.request(repository, number)
            self.assertNotIn("Refs", self.body(), (repository, number))
        self.set_cell(product={"origin": {"kind": "github_issue", "repository": "acme/app", "number": 4}})  # a request: no longer referred to
        self.assertNotIn("Refs", self.body())
        self.set_cell(product={"issue": "acme/app#4"})
        self.assertNotIn("Refs", self.body())

    def test_no_body_closes_an_issue_whatever_the_cell_says(self):
        self.approved(mode="auto", method="pr")
        self.request("acme/app", 42)
        self.set_cell(title=HOSTILE, slice_id=HOSTILE, spec_path=HOSTILE, risk=HOSTILE)
        cell = merge.Cell(self.project, "LOCAL-001")
        cell.build["diff"] = HOSTILE
        cell.summary["status"] = HOSTILE
        cell.decision.update(votes={HOSTILE: HOSTILE}, human_approval={"by": HOSTILE}, round=HOSTILE, blockers=HOSTILE, head=HOSTILE)
        body, title = merge.pr_body(cell), merge.pr_title(cell)
        self.assertTrue(CLOSING.search(HOSTILE), "the pattern finds what it is meant to find")
        self.assertIsNone(CLOSING.search(body), body)
        self.assertIsNone(CLOSING.search(title), title)
        self.assertEqual(body.splitlines()[-1], "Refs acme/app#42")
        self.assertIn("Fixes", body, "the words stay readable; only the references are broken")


class FindingsTest(PullRequestBase):
    """Design 2.2: the approving round's findings are posted once, as one review of type comment."""

    def votes(self, by_seat):
        self.put(self.cellroot, {f"review/round-1/votes/{seat}.json": json.dumps({"reviewer": seat, "vote": "APPROVE", "summary": "s", "findings": findings})
                                 for seat, findings in by_seat.items()})

    def posts(self):
        log = Path(str(self.gh_log) + ".stdin")
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    @staticmethod
    def note(title, file=None, line=None, **extra):
        return {"severity": "note", "title": title, "detail": f"About {title}.", "file": file, "line": line, "rule": None, **extra}

    def test_findings_on_lines_in_the_diff_are_inline_the_rest_in_the_summary(self):
        head = self.approved(mode="auto", method="pr")
        self.votes({
            "architecture": [self.note("On a changed line", "app/invite.py", 1, rule="FR-01")],
            "security": [self.note("On an unchanged file", ".gitignore", 1, **{"class": "security", "impact": "low"}),
                         self.note("Past the end", "app/invite.py", 9999), self.note("Outside", "../etc/passwd", 1)],
            "product": [self.note("No file at all")],
        })
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        self.assertEqual(done["findings_posted"], {"posted": True, "how": "review", "inline": 1, "summary": 4, "not_shown": 0})
        [post] = self.posts()
        self.assertEqual(post["args"], ["api", "--method", "POST", "repos/acme/app/pulls/12/reviews", "--input", "-"])
        review = json.loads(post["stdin"])
        tip = self.record_commit(head)
        self.assertEqual((review["event"], review["commit_id"]), ("COMMENT", tip))
        self.assertIn(f"This pull request is at `{tip[:12]}`: the approved commit with its change record added.", review["body"])
        [inline] = review["comments"]
        self.assertEqual((inline["path"], inline["line"], inline["side"]), ("app/invite.py", 1, "RIGHT"))
        self.assertIn("**architecture** · note: **On a changed line**", inline["body"])
        self.assertIn("Cites: FR-01", inline["body"])
        for expected in ("`.gitignore:1`", "security, low impact", "`app/invite.py:9999`", "file not shown: **Outside**", "no file: **No file at all**"):
            self.assertIn(expected, review["body"])
        self.assertNotIn("../etc/passwd", review["body"])
        record = self.cell_json()["pull_request_findings"]
        self.assertEqual((record["how"], record["round"], record["head"], record["inline"], record["summary"], record["pull_request"]),
                         ("review", 1, tip, 1, 4, "https://github.com/acme/app/pull/12"))
        self.assertLess(self.calls().index(["api", "--method", "POST", "repos/acme/app/pulls/12/reviews", "--input", "-"]),
                        next(i for i, call in enumerate(self.calls()) if call[:2] == ["pr", "merge"]), "posted after opening, before merging")

    def test_reviewer_text_is_redacted_and_mentions_are_broken(self):
        self.approved(mode="auto", method="pr")
        hostile = f"Seen token={TOKEN} and {TOKEN}; ask @octocat or @acme/owners, mail a@b.example. Fixes #3.\x1b[31m" + "x" * 2000
        self.votes({"security": [{"severity": "note", "title": "Hi @octocat", "detail": hostile, "file": "app/invite.py", "line": 1, "rule": "@rule"}]})
        self.m_ok("run", "LOCAL-001")
        text = self.posts()[0]["stdin"]
        review = json.loads(text)
        body = review["comments"][0]["body"]
        self.assertNotIn(TOKEN, text)
        self.assertIn("<redacted>", body)
        self.assertNotIn("a@b.example", body)
        for name in ("@octocat", "@acme/owners", "@rule"):
            self.assertNotIn(name, body)
        self.assertIn("@\u200boctocat", body)
        self.assertIsNone(CLOSING.search(body))
        self.assertNotIn("\x1b", body)
        self.assertLess(len(body), 900, "the detail is bounded")

    def test_at_most_sixty_findings_are_posted_and_the_rest_counted(self):
        self.approved(mode="auto", method="pr")
        self.votes({"architecture": [self.note(f"Note {n}", "app/invite.py", 1) for n in range(70)]})
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["findings_posted"], {"posted": True, "how": "review", "inline": 60, "summary": 0, "not_shown": 10})
        review = json.loads(self.posts()[0]["stdin"])
        self.assertEqual(len(review["comments"]), 60)
        self.assertIn("10 more findings are not shown", review["body"])

    def test_a_failed_review_falls_back_to_one_plain_comment(self):
        self.approved(mode="auto", method="pr")
        self.votes({"architecture": [self.note("On a changed line", "app/invite.py", 1)]})
        with mock.patch.dict(os.environ, {"FAKE_GH_API_FAIL": "1"}):
            done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        self.assertEqual((done["findings_posted"]["how"], done["findings_posted"]["summary"], done["findings_posted"]["review_failed"]),
                         ("comment", 1, "HTTP 422: Unprocessable Entity"))
        api, comment = self.posts()
        self.assertEqual(comment["args"], ["pr", "comment", "12", "--repo", "acme/app", "--body-file", "-"])
        self.assertIn("`app/invite.py:1`: **On a changed line**", comment["stdin"])
        self.assertEqual(self.cell_json()["pull_request_findings"]["how"], "comment")

    def test_when_nothing_can_be_posted_the_merge_still_happens_and_tries_stop_at_three(self):
        self.approved(mode="auto", method="pr")
        self.votes({"architecture": [self.note("On a changed line", "app/invite.py", 1)]})
        with mock.patch.dict(os.environ, {"FAKE_GH_API_FAIL": "1", "FAKE_GH_COMMENT_FAIL": "1", "FAKE_GH_BLOCK": "1"}):
            results = [json.loads(self.m("run", "LOCAL-001")[1]) for _ in range(4)]
        self.assertEqual([r["status"] for r in results], ["PR_OPEN"] * 4)
        self.assertIn("nor a plain comment", results[0]["findings_posted"]["reason"])
        self.assertIn("Not tried again", results[3]["findings_posted"]["reason"])
        self.assertEqual(sum(1 for post in self.posts() if post["args"][0] == "api"), 3)
        self.assertEqual(self.cell_json()["pull_request_findings"]["attempts"], 3)
        with mock.patch.dict(os.environ, {"FAKE_GH_API_FAIL": "1", "FAKE_GH_COMMENT_FAIL": "1"}):
            done = self.m_ok("run", "LOCAL-001")
        self.assertEqual((done["status"], done["findings_posted"]["posted"]), ("MERGED", False))

    def test_a_total_failure_on_the_first_run_still_merges(self):
        self.approved(mode="auto", method="pr")
        self.votes({"architecture": [self.note("On a changed line", "app/invite.py", 1)]})
        with mock.patch.dict(os.environ, {"FAKE_GH_API_FAIL": "1", "FAKE_GH_COMMENT_FAIL": "1"}):
            done = self.m_ok("run", "LOCAL-001")
        self.assertEqual((done["status"], done["findings_posted"]["posted"]), ("MERGED", False))
        self.assertIn("the merge went ahead", done["findings_posted"]["reason"])
        self.assertEqual((self.cell_json()["pull_request_findings"]["how"], self.cell_json()["stage"]), ("failed", "merged"))

    def test_findings_are_posted_once_across_runs(self):
        self.approved(mode="auto", method="pr")
        self.votes({"architecture": [self.note("On a changed line", "app/invite.py", 1)]})
        with mock.patch.dict(os.environ, {"FAKE_GH_BLOCK": "1"}):
            first = json.loads(self.m("run", "LOCAL-001")[1])
        self.assertEqual((first["status"], first["findings_posted"]["posted"]), ("PR_OPEN", True))
        second = self.m_ok("run", "LOCAL-001")
        self.assertEqual(second["status"], "MERGED")
        self.assertFalse(second["findings_posted"]["posted"])
        self.assertIn("Already done", second["findings_posted"]["reason"])
        self.assertEqual(len(self.posts()), 1)

    def test_the_setting_off_posts_nothing(self):
        self.approved(mode="auto", method="pr", pr={"inline_findings": False})
        self.votes({"architecture": [self.note("On a changed line", "app/invite.py", 1)]})
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        self.assertIn("inline_findings is false", done["findings_posted"]["reason"])
        self.assertEqual(self.posts(), [])
        self.assertNotIn("pull_request_findings", self.cell_json())

    def test_no_findings_posts_nothing_and_says_so(self):
        self.approved(mode="auto", method="pr", pr={"inline_findings": "yes"})
        self.votes({"architecture": [], "security": [], "product": []})
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["findings_posted"]["posted"], False)
        self.assertIn("no findings", done["findings_posted"]["reason"])
        self.assertEqual(self.posts(), [])
        self.assertEqual(self.cell_json()["pull_request_findings"]["how"], "nothing to post")

    def test_local_merges_post_nothing(self):
        self.approved(mode="auto")
        self.votes({"architecture": [self.note("On a changed line", "app/invite.py", 1)]})
        self.assertNotIn("findings_posted", self.m_ok("run", "LOCAL-001"))
        self.assertEqual(self.posts(), [])


if __name__ == "__main__":
    unittest.main()
