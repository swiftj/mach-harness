"""M13 part C: where people read how an epic works today.

The Factory's one comment on an epic's issue, replaced each time a slice of that epic ships (intake's outbox, the ticket
station's epic-view, issue_rules' template), and Product Studio's `epic current <EPIC-ID>`, which reads the local copy of
the integration branch only. Built on the intake tests' throwaway repositories and their stand-in for gh: the Factory is
signed in as erin-eng, the product manager as ada-pm. Nothing reaches the network.
"""

import io
import json
import re
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from test_mach_product_intake import TICKET, Base  # noqa: E402
from test_mach_product_issues import REPO, git  # noqa: E402
import issue_rules  # noqa: E402
import intake  # noqa: E402
import studio  # noqa: E402

REPLACES_FR01 = ("\n## Effects on shipped behaviour\n\n| Shipped rule | Effect | In this slice | Note |\n|---|---|---|---|\n"
                 "| SLICE-001/FR-01 | replaced | FR-01 | |\n")


class EpicViewBase(Base):
    def ship(self, slice_id, epic, extra="", title="Invite a teammate"):
        """Product marks the slice ready on its issue; the Factory takes it in, builds it (stand-in), merges it, and runs a pass."""
        number = self.ready(slice_id, epic, extra=extra, title=title)
        self.product("intake")
        self.product("dispatch", slice_id)
        self.integrate(str(number))
        return number, self.product("intake")

    def views(self, epic):
        """The comments on the epic's issue that carry the current-view marker: (author, body)."""
        return [(c["login"], c["body"]) for c in self.gh()["issues"][str(epic)]["comments"] if issue_rules.epic_view_marker(c["body"])]

    def epic_writes(self):
        return [w for w in self.ledger()["status"].values() if w["moment"] == intake.EPIC_VIEW_MOMENT]

    def head(self):
        return git(self.eng, "rev-parse", "main").strip()


class FactoryCommentTest(EpicViewBase):
    def test_the_first_ship_creates_the_comment_and_the_second_replaces_it(self):
        epic = self.epic()
        number, _ = self.ship("SLICE-001", epic)
        (only,) = self.views(epic)
        self.assertEqual(only[0], "erin-eng")  # written by the account the Factory runs as
        marker = issue_rules.epic_view_marker(only[1])
        self.assertEqual((marker["epic_id"], marker["commit"], marker["intact"]), ("EPIC-001", self.head(), True))
        self.assertIn("## How this epic works today", only[1])
        self.assertIn(issue_rules.EPIC_VIEW_LEAD, only[1])
        self.assertIn("`SLICE-001/FR-01`", only[1])
        self.assertEqual(self.gh()["issues"][str(number)]["state"], "CLOSED")  # the slice's own status is unchanged
        first_id = [c["cid"] for c in self.gh()["issues"][str(epic)]["comments"] if issue_rules.epic_view_marker(c["body"])][0]
        comments_before = len(self.gh()["issues"][str(epic)]["comments"])

        self.ship("SLICE-002", epic, title="Second")
        comments = self.gh()["issues"][str(epic)]["comments"]
        self.assertEqual(len(comments), comments_before)  # edited in place, no second comment
        (again,) = self.views(epic)
        self.assertEqual([c["cid"] for c in comments if issue_rules.epic_view_marker(c["body"])], [first_id])
        self.assertEqual(issue_rules.epic_view_marker(again[1])["commit"], self.head())
        self.assertIn("`SLICE-002/FR-01`", again[1])
        patches = [call for call in self.gh_calls() if call[:3] == ["api", "--method", "PATCH"]]
        self.assertEqual(len(patches), 1)
        self.assertEqual(patches[0][-3:-1], [f"repos/{REPO}/issues/comments/{first_id}", "--input"])
        self.assertEqual({w["state"] for w in self.epic_writes()}, {"done"})

    def test_a_repeated_or_interrupted_pass_writes_nothing_twice(self):
        epic = self.epic()
        self.ship("SLICE-001", epic)
        calls = len(self.gh_calls())
        self.product("intake")
        self.product("reconcile")
        self.assertEqual(len(self.views(epic)), 1)
        self.assertFalse([c for c in self.gh_calls(calls) if c[:2] == ["issue", "comment"] or "PATCH" in c])
        # The write happened but its answer was lost: the ledger still says pending; the next try finds it by its marker.
        state = self.ledger()
        (key,) = [k for k, w in state["status"].items() if w["moment"] == intake.EPIC_VIEW_MOMENT]
        state["status"][key].update(state="pending", done_at=None)
        (self.eng / ".factory/intake/ledger.json").write_text(json.dumps(state))
        self.product("intake")
        self.assertEqual(len(self.views(epic)), 1)
        self.assertEqual(self.ledger()["status"][key]["outcome"], "already_done")

    def test_a_failed_write_is_retried_on_the_next_pass_and_blocks_nothing(self):
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.integrate(str(number))
        self.fail("api user")  # the epic view's first step after the checks: GitHub out of reach, once
        self.product("intake")
        self.assertEqual(self.gh()["issues"][str(number)]["state"], "CLOSED")  # the slice shipped all the same
        (write,) = self.epic_writes()
        self.assertEqual((write["state"], write["kind"], write["attempts"]), ("pending", "network", 1))
        self.assertEqual(self.views(epic), [])
        self.product("intake")
        self.assertEqual([w["state"] for w in self.epic_writes()], ["done"])
        self.assertEqual(len(self.views(epic)), 1)

    def test_comments_off_writes_no_view(self):
        (self.eng / ".factory/config.json").write_text(json.dumps({"tickets": {"provider": "local", "github": {"status_comments": False}}}))
        epic = self.epic()
        number, _ = self.ship("SLICE-001", epic)
        self.assertEqual(self.views(epic), [])
        self.assertEqual(self.epic_writes(), [])
        self.assertIn("mach:shipped", self.labels_of(number))
        # The ticket station refuses to comment as well, whoever calls it.
        view = self.root / "view.md"
        view.write_text("### How it works\n")
        done = subprocess.run([sys.executable, str(TICKET), "--project", str(self.eng), "epic-view", str(epic), "--repository", REPO, "--epic-id", "EPIC-001",
                               "--commit", self.head(), "--view-file", str(view)], capture_output=True, text=True)
        self.assertEqual((done.returncode, json.loads(done.stdout)["comment"]), (0, "off"))
        self.assertEqual(self.views(epic), [])

    def test_a_shipped_slice_that_replaces_another_epics_rule_refreshes_that_epics_comment(self):
        lending = self.epic("EPIC-001", "Lending")
        self.ship("SLICE-001", lending)
        before = self.views(lending)[0][1]
        returns = self.epic("EPIC-002", "Returns")
        self.ship("SLICE-002", returns, extra=REPLACES_FR01, title="Returns replace the seat rule")
        (lent,) = self.views(lending)
        (returned,) = self.views(returns)
        self.assertNotEqual(lent[1], before)
        self.assertIn("No longer in force", lent[1])
        self.assertIn("replaced by `SLICE-002/FR-01` (EPIC-002)", lent[1])
        self.assertIn("replaces `SLICE-001/FR-01` (EPIC-001)", returned[1])
        self.assertEqual({w["epic_id"] for w in self.epic_writes() if w["slice_id"] == "SLICE-002"}, {"EPIC-001", "EPIC-002"})

    def test_an_epic_issue_not_written_by_product_studio_gets_nothing(self):
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.integrate(str(number))
        self.change(epic, labels=[])  # someone took mach:epic off the epic's issue
        self.product("intake")
        self.assertEqual(self.views(epic), [])
        self.assertEqual([(w["state"], w["kind"]) for w in self.epic_writes()], [("gave_up", "refused")])

    def test_a_slice_from_a_ready_folder_writes_no_view(self):
        self.first()
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.integrate("LOCAL-001")
        self.product("intake")
        self.assertEqual(self.epic_writes(), [])
        self.assertFalse([c for c in self.gh_calls() if c[:1] == ["api"] and any("comments" in part for part in c)])

    def test_another_accounts_comment_is_never_touched(self):
        epic = self.epic()
        forged = issue_rules.epic_view_comment("EPIC-001", "0" * 40, "### Not the Factory's\n")
        state = self.gh()
        state["issues"][str(epic)]["comments"].append({"login": "ada-pm", "id": 3001, "cid": 1, "body": forged, "created_at": "x", "updated_at": "x"})
        self.write_state(state)
        self.ship("SLICE-001", epic)
        views = self.views(epic)
        self.assertEqual([(login, body == forged) for login, body in views], [("ada-pm", True), ("erin-eng", False)])

    def test_the_view_is_cut_to_fit_with_the_plain_note(self):
        long_view = "\n".join(f"- `SLICE-001/FR-{n:02d}` (requirement): " + "x" * 300 for n in range(400))
        body = issue_rules.epic_view_comment("EPIC-001", "a" * 40, long_view)
        self.assertLessEqual(len(body), issue_rules.ISSUE_BODY_LIMIT)
        self.assertTrue(body.rstrip("\n").endswith("Run `/mach current EPIC-001` for all of it._"))
        self.assertTrue(issue_rules.epic_view_marker(body)["intact"])
        # The compiler is asked for a view that fits with room for the template.
        self.assertLess(issue_rules.epic_view_limit() + 1024, issue_rules.ISSUE_BODY_LIMIT + 1)
        quiet = issue_rules.epic_view_comment("EPIC-001", "a" * 40, "Ask @ben-pm, fixes #12 <!-- mach:acceptance -->")
        for leaked in ("@ben-pm", "#12", "<!-- mach:acceptance"):
            self.assertNotIn(leaked, quiet)


class OthersUnaffectedTest(EpicViewBase):
    def test_release_acceptance_reading_ignores_the_view(self):
        epic = self.epic()
        self.ship("SLICE-001", epic)
        self.assertEqual(len(self.views(epic)), 1)
        # A real acceptance for another release is still read; the view beside it is not taken for one.
        state = self.gh()
        line = issue_rules.acceptance_comment("EPIC-001", "r2", "b" * 40, "accepted", "ada-pm", "c" * 64)
        state["issues"][str(epic)]["comments"].append({"login": "ada-pm", "id": 3001, "body": line, "created_at": "t", "updated_at": "t"})
        self.write_state(state)
        done = subprocess.run([sys.executable, str(TICKET), "--project", str(self.eng), "epic-check", str(epic), "--release", "r1", "--commit", "a" * 40],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        report = json.loads(done.stdout)
        self.assertEqual((report["epic"]["epic_id"], report["epic"]["problem"], report["acceptances"]), ("EPIC-001", None, []))
        done = subprocess.run([sys.executable, str(TICKET), "--project", str(self.eng), "epic-check", str(epic), "--release", "r2", "--commit", "b" * 40],
                              capture_output=True, text=True)
        self.assertEqual([(a["decision"], a["by"], a["problem"]) for a in json.loads(done.stdout)["acceptances"]], [("accepted", "ada-pm", None)])

    def test_studio_refresh_is_the_same_with_or_without_the_view_and_a_rewritten_body_leaves_it(self):
        self.set_gh(me="ada-pm")
        self.project_and_epic()
        self.drafted()
        self.ok(self.a, "slice", "ready", "SLICE-001")
        epic = [i["number"] for i in self.issues("mach:epic")][0]
        number = [i["number"] for i in self.issues("mach:slice")][0]
        git(self.a, "push", "-q", "origin", "main")
        self.set_gh(me="erin-eng")
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.integrate(str(number))
        self.product("intake")
        (view,) = self.views(epic)
        self.set_gh(me="ada-pm")
        with_view = self.ok(self.a, "refresh")
        state = self.gh()
        kept = state["issues"][str(epic)]["comments"]
        state["issues"][str(epic)]["comments"] = [c for c in kept if not issue_rules.epic_view_marker(c["body"])]
        self.write_state(state)
        without_view = self.ok(self.a, "refresh")
        self.assertEqual(with_view, without_view)
        state = self.gh()
        state["issues"][str(epic)]["comments"] = kept
        self.write_state(state)
        # Product changes the epic's criteria and marks a second slice ready: the epic's body is rewritten; the view stays.
        body_before = self.gh()["issues"][str(epic)]["body"]
        self.ok(self.a, "epic", "set", "EPIC-001", "--criterion", "Only invited people can join", "--criterion", "Seats are counted")
        self.drafted(title="Second")
        self.ok(self.a, "slice", "ready", "SLICE-002")
        self.assertNotEqual(self.gh()["issues"][str(epic)]["body"], body_before)
        self.assertEqual(self.views(epic), [view])


class StudioEpicCurrentTest(EpicViewBase):
    def studio(self, project, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = studio.main(["--project", str(project), *argv])
        return code, out.getvalue(), err.getvalue()

    def test_it_shows_the_epic_at_the_local_integration_branch_and_says_so(self):
        epic = self.epic()
        self.ship("SLICE-001", epic)
        git(self.eng, "push", "-q", "origin", "main")
        git(self.a, "pull", "-q", "--ff-only")
        before = (git(self.a, "status", "--porcelain"), git(self.a, "rev-parse", "HEAD"), git(self.a, "branch", "--list"))
        calls = len(self.gh_calls())
        code, out, err = self.studio(self.a, "epic", "current", "EPIC-001", "--json")
        self.assertEqual(code, 0, err)
        answer = json.loads(out)
        self.assertEqual((answer["commit"], answer["branch"], answer["epic_id"]), (git(self.a, "rev-parse", "main").strip(), "main", "EPIC-001"))
        self.assertIn("may be behind GitHub", answer["note"])
        self.assertEqual([item["rule"] for item in answer["epic"]["in_force"]][:2], ["SLICE-001/INV-01", "SLICE-001/INV-02"])
        self.assertIs(answer["factory_authorized"], False)
        code, text, _ = self.studio(self.a, "epic", "current", "EPIC-001")
        self.assertEqual(code, 0)
        self.assertIn("may be behind GitHub", text)
        self.assertIn("SLICE-001/FR-01", text)
        self.assertEqual(self.gh_calls(calls), [])  # no gh at all
        self.assertEqual((git(self.a, "status", "--porcelain"), git(self.a, "rev-parse", "HEAD"), git(self.a, "branch", "--list")), before)
        self.assertFalse((self.a / ".factory/intake").exists())

    def test_an_epic_with_nothing_shipped_and_a_bad_name(self):
        code, out, err = self.studio(self.a, "epic", "current", "EPIC-009", "--json")
        self.assertEqual(code, 0, err)
        answer = json.loads(out)
        self.assertIsNone(answer["epic"])
        self.assertTrue(any("EPIC-009" in note for note in answer["notes"]))
        code, _, err = self.studio(self.a, "epic", "current", "please list everything")
        self.assertEqual(code, 1)
        self.assertIn("refused:", err)


class BoundariesTest(unittest.TestCase):
    def test_the_epic_view_write_uses_only_these_gh_calls(self):
        source = (ROOT / "skills" / "ticket" / "scripts" / "ticket.py").read_text()
        body = source[source.index("def cmd_epic_view("):source.index("# ---------------------------------------------------------------- monitoring requests")]
        calls = sorted(set(re.findall(r"gh_call\(ctx\.project, ([^\n]*)", body)))
        self.assertEqual(calls, [
            '"api", "--method", "PATCH", *GH_API_HEADERS,',
            '"api", "--paginate", *GH_API_HEADERS, COMMENTS_PATH.format(repository=repository, number=number), "--jq", EPIC_VIEW_COMMENTS_JQ)',
            '"api", *GH_API_HEADERS, "user", "--jq", "{login}") or "null")',
            '"issue", "comment", str(number), "--repo", repository, "--body-file", handle.name)',
        ])
        self.assertIn('EPIC_VIEW_COMMENT_PATH = "repos/{repository}/issues/comments/{comment_id}"', source)
        for word in ("\"close\"", "\"delete\"", "DELETE", "--add-label", "--remove-label", "\"edit\"", "\"lock\"", "--body\""):
            self.assertNotIn(word, body, word)
        self.assertIn("issue_rules.epic_view_comment(", body)  # the only text written is the fixed template around the compiled view

    def test_studio_epic_current_reads_only_the_compiler(self):
        source = (ROOT / "skills" / "product-studio" / "scripts" / "studio.py").read_text()
        body = source[source.index("def cmd_epic_current("):source.index("# ---- M13 part E")]
        self.assertEqual(sorted(set(re.findall(r"\bcompiler\.([a-z_]+)\(", body))), ["human", "integration", "report"])
        for word in ("gh", "issues.", "handoff", "collab", "write", "fetch", "push", "ticket"):
            self.assertNotRegex(body, rf"\b{re.escape(word)}", word)


if __name__ == "__main__":
    unittest.main()
