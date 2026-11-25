"""M16 part A: Shape's commands in Product Studio (shape.py), run through studio.main in temporary Git projects.

Ideas, their sources and lookups, the brief and its revisions, the case, the verdict going stale when the brief
changes, publishing with the stand-in for gh from test_mach_product_issues (once, again, interrupted two ways, with
GitHub unreachable, and the folder form), refresh flagging an issue changed after its verdict, and no brief or idea
text reaching the Factory's intake. Nothing reaches the network.
"""

import io
import json
import re
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
for folder in ("ticket", "intent", "studio"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
import issue_rules  # noqa: E402
import studio  # noqa: E402
from test_mach_product_issues import FIXTURE, REPO, IssuesBase, NETWORK_DOWN, git  # noqa: E402
from test_mach_product_intake import Base as IntakeBase  # noqa: E402
from test_mach_shape_brief import BRIEF, CASE  # noqa: E402

FAULT = "AUTO-20261120T101500Z"
SHIPPED_BRIEF = BRIEF.replace("- Shipped rules: SLICE-004/FR-02, SLICE-007/INV-01", "- Shipped rules: SLICE-001/FR-01, SLICE-001/INV-02")
REQUEST_BODY = "Members keep phoning to renew. Please let them renew online. Contact ada@example.com."
TEMPLATE_BODY = issue_rules.idea_body({"problem": "Renewals take calls.", "outcome": "Members renew themselves.", "affected": "Members and desk staff.",
                                       "constraints": "Same limits as the desk.", "open_questions": "- Who answers when it is refused?"})
# What the app is never shown: terminal commands, options, or Git words (as AppWordingTest holds for the rest of Studio).
BANNED = re.compile(r"studio\.py|--[a-z]|\bbranch\b|\b(idea (add|list|show|stage|lookups|publish|renumber)|brief (check|show)|case (show|check)|verdict record)\b")


class ShapeBase(IssuesBase):
    def setUp(self):
        super().setUp()
        spec = self.eng / "specs" / "slices" / "SLICE-001-invite-teammate.md"
        spec.parent.mkdir(parents=True)
        spec.write_text(FIXTURE)
        git(self.eng, "add", "-A")
        git(self.eng, "commit", "-q", "-m", "SLICE-001 shipped")
        git(self.eng, "push", "-q", "origin", "main")
        git(self.a, "pull", "-q")  # the product manager's copy; Studio itself never fetches

    # ---- the workspace ----

    def add(self, title="Let members renew a loan themselves", *extra, project=None):
        return self.ok(project or self.a, "idea", "add", title, *extra)["idea"]

    def path(self, relative, project=None):
        return self.draft(project or self.a, relative)

    def write_brief(self, idea_id="IDEA-001", text=SHIPPED_BRIEF, project=None):
        target = self.path(f"product/briefs/{idea_id}.md", project)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def write_case(self, idea_id="IDEA-001", text=CASE):
        self.path(f"product/briefs/{idea_id}.case.md").write_text(text)

    def record(self, idea_id="IDEA-001", project=None):
        return json.loads(self.path(f"product/ideas/{idea_id}.json", project).read_text())

    def shape_ledger(self, project=None):
        return json.loads(((project or self.a) / ".factory/studio/ideas.json").read_text())

    def requests_cache(self, items):
        """The request cache as a refresh leaves it: these requests, each accepted (labelled by a writer)."""
        home = self.a / ".factory/studio"
        home.mkdir(parents=True, exist_ok=True)
        (home / "requests.json").write_text(json.dumps({"schema_version": 1, "repository": REPO, "nonce": "0" * 32, "picked": {}, "outbox": [],
                                                        "items": {str(n): {"number": n, "title": t, "body": b, "labels": ["mach:request"],
                                                                           "decision": {"state": state, "labelled_by": "ben-pm",
                                                                                        **({"reason": "Not accepted."} if state != "accepted" else {})}}
                                                                  for n, t, b, state in items}}))

    def decided(self, decision="go", reason="Members ask for it at every desk."):
        self.add()
        self.write_brief()
        return self.ok(self.a, "verdict", "record", "IDEA-001", "--decision", decision, "--reason", reason)

    def idea_issues(self):
        return self.issues(issue_rules.SHAPE_IDEA_LABEL)

    def not_a_choice(self, *argv):
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            studio.main(["--project", str(self.a), *argv])

    def app_refusal(self, *argv):
        code, out, err = self.run_studio(self.a, "--app", *argv)
        self.assertEqual(code, 1, out)
        message = err.strip().splitlines()[-1]
        self.assertTrue(message.startswith("refused: "), err)
        self.assertIsNone(BANNED.search(err), err)
        return message


class IdeaTest(ShapeBase):
    def test_add_list_show_and_the_one_stage_set_by_hand(self):
        self.project_and_epic()
        self.assertNotIn("ideas", self.ok(self.a, "status"))  # a project that never opens Shape reports as before
        idea = self.add()
        self.assertEqual((idea["idea_id"], idea["stage"], idea["revision"], idea["source"]), ("IDEA-001", "new", 0, {"kind": "typed"}))
        self.assertEqual(self.add("Email a reminder before a loan is due")["idea_id"], "IDEA-002")
        listed = self.ok(self.a, "idea", "list")
        self.assertEqual(listed["by_stage"]["new"], ["IDEA-001", "IDEA-002"])
        self.assertIs(listed["factory_authorized"], False)
        self.assertEqual(listed["ideas"][0]["next"]["kind"], "explore")
        self.assertEqual(self.ok(self.a, "idea", "stage", "IDEA-001", "exploring")["changed"], True)
        self.assertEqual(self.ok(self.a, "idea", "stage", "IDEA-001", "exploring")["changed"], False)
        status = self.ok(self.a, "status")["ideas"]
        self.assertEqual(status["counts"], {"new": 1, "exploring": 1, "brief": 0, "decided": 0, "shaped": 0})
        self.assertEqual({row["idea_id"]: row["next"]["kind"] for row in status["ideas"]}, {"IDEA-001": "write_brief", "IDEA-002": "explore"})
        shown = self.ok(self.a, "idea", "show", "IDEA-001")
        self.assertEqual((shown["brief"]["exists"], shown["case"]["exists"], shown["verdict"], shown["lookups"]), (False, False, None, None))
        self.assertEqual(shown["source"], {"kind": "typed", "words": "Typed by the product manager"})
        self.not_a_choice("idea", "stage", "IDEA-001", "decided")  # only exploring is set by hand
        self.write_brief()
        self.ok(self.a, "brief", "check", "IDEA-001")
        self.assertIn("past exploring", self.refused(self.a, "idea", "stage", "IDEA-001", "exploring"))
        for bad in (("idea", "add", "  "), ("idea", "add", "x" * 121), ("idea", "show", "IDEA-1"), ("idea", "show", "IDEA-009"),
                    ("idea", "add", "Use token ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")):
            self.refused(self.a, *bad)
        self.ok(self.a, "validate")  # the product artifacts are untouched by Shape's files

    def test_an_idea_from_a_request_or_an_idea_template_keeps_identifiers_and_shows_the_text_fenced(self):
        self.requests_cache([(57, "Renew online", REQUEST_BODY, "accepted"), (58, "Renew it myself", TEMPLATE_BODY, "accepted"),
                             (59, "Not counted", "Body", "not_accepted")])
        self.assertIn("not in the idea template", self.refused(self.a, "idea", "add", "Renew online", "--from-issue", "57"))
        idea = self.add("Renew online", "--from-request", "57")
        self.assertEqual(self.record()["source"], {"kind": "request", "repository": REPO, "number": 57})
        self.assertNotIn("phoning", json.dumps(self.record()))  # identifiers only in the record
        shown = self.ok(self.a, "idea", "show", idea["idea_id"])
        self.assertTrue(shown["source"]["fenced"].startswith("<<<REQUEST-DATA issue=#57"))
        self.assertIn("<email>", shown["source"]["fenced"])  # redacted
        self.assertNotIn("ada@example.com", json.dumps(shown))
        templated = self.add("Renew it myself", "--from-issue", "58")
        self.assertEqual(self.record(templated["idea_id"])["source"]["kind"], "idea")
        parts = self.ok(self.a, "idea", "show", templated["idea_id"])["source"]["parts"]
        self.assertEqual([p["part"] for p in parts], [key for key, _ in issue_rules.IDEA_SECTIONS])
        self.assertIn("IDEA-001 was already started from #57", self.refused(self.a, "idea", "add", "Again", "--from-request", "57"))
        self.assertIn("cannot be used", self.refused(self.a, "idea", "add", "No", "--from-request", "59"))
        self.assertIn("No request #60", self.refused(self.a, "idea", "add", "No", "--from-request", "60"))
        self.assertFalse(self.path("product/briefs/IDEA-001.md").exists())  # the engine never writes a brief from a request
        self.assertEqual(self.gh()["calls"], [])  # nothing read from or written to GitHub

    def test_an_idea_from_a_fault(self):
        self.assertIn("not a fault ticket's ID", self.refused(self.a, "idea", "add", "Fine shown twice", "--from-fault", "LOCAL-001"))
        idea = self.add("Fine shown twice", "--from-fault", FAULT)
        self.assertEqual(self.record(idea["idea_id"])["source"], {"kind": "fault", "ticket": FAULT})
        self.assertFalse(self.ok(self.a, "idea", "show", idea["idea_id"])["source"]["text_shown"])
        inbox = self.a / ".factory/inbox"
        inbox.mkdir(parents=True)
        (inbox / f"{FAULT}.json").write_text(json.dumps({"ticket_id": FAULT, "title": "TypeError in fines.py", "body": "Stack <<<trace>>> token=abcdefabcdef123456"}))
        source = self.ok(self.a, "idea", "show", idea["idea_id"])["source"]
        self.assertTrue(source["fenced"].startswith(f"<<<FAULT-DATA ticket={FAULT}"))
        self.assertEqual(source["fenced"].count("<<<"), 2)  # the fault's own marks cannot open or close a fence
        self.assertNotIn("abcdefabcdef123456", source["fenced"])

    def test_lookups_are_checked_and_shown_as_data(self):
        self.add()
        self.add("Another idea")
        self.requests_cache([(57, "Renew online", REQUEST_BODY, "accepted")])
        source = self.root / "lookups.json"

        def lookups(data):
            source.write_text(json.dumps(data))
            return self.run_studio(self.a, "idea", "lookups", "IDEA-001", "--from", str(source))

        for bad, words in (({"shipped_rules": [{"rule": "SLICE-009/FR-01"}]}, "not in any shipped spec"),
                           ({"similar": [{"idea": "IDEA-007"}]}, "not an idea in this workspace"),
                           ({"similar": [{"request": 99}]}, "request 99 is not known"),
                           ({"principles": [{"id": "PP-01"}]}, "not one of this project's principles"),
                           ({"policies": [{"id": "POL-lending-03"}]}, "not in the organisation's policy packs"),
                           ({"elsewhere": []}, "one JSON object"), ({"shipped_rules": [{"rule": "SLICE-001/FR-01", "text": "x"}]}, "is not {rule")):
            code, _, err = lookups(bad)
            self.assertEqual(code, 1)
            self.assertIn(words, err)
        self.assertFalse(self.path("product/ideas/IDEA-001.lookups.json").exists())
        code, out, err = lookups({"shipped_rules": [{"rule": "SLICE-001/FR-01", "note": "An admin invites <<<you>>> by email ada@example.com"}],
                                  "similar": [{"idea": "IDEA-002", "note": "Close to this"}, {"request": 57}]})
        self.assertEqual(code, 0, err)
        shown = json.loads(out)["lookups"]
        self.assertEqual(shown["ids"]["shipped_rules"], ["SLICE-001/FR-01"])
        self.assertEqual(shown["fenced"].count("<<<"), 2)
        self.assertNotIn("ada@example.com", shown["fenced"])
        saved = json.loads(self.path("product/ideas/IDEA-001.lookups.json").read_text())
        self.assertEqual(saved["shipped_rules"][0]["in_force"], True)
        self.assertEqual(self.ok(self.a, "idea", "show", "IDEA-001")["lookups"]["counts"], {"shipped_rules": 1, "similar": 2, "principles": 0, "policies": 0})
        # The terminal gets the entries fenced only; the app also gets each entry in its group (M16 app foundation), as recorded.
        self.assertNotIn("items", shown)
        self.assertNotIn("items", self.ok(self.a, "idea", "show", "IDEA-001")["lookups"])
        items = self.ok(self.a, "--app", "idea", "show", "IDEA-001")["lookups"]["items"]
        self.assertEqual(items["shipped_rules"], saved["shipped_rules"])
        self.assertNotIn("ada@example.com", json.dumps(items))
        self.assertEqual(([i.get("idea") or i.get("request") for i in items["similar"]], items["principles"], items["policies"]), (["IDEA-002", 57], [], []))


class BriefAndVerdictTest(ShapeBase):
    def test_a_new_text_is_the_next_revision_and_an_id_taken_out_is_never_reused(self):
        self.add()
        self.assertIn("no brief yet", self.refused(self.a, "brief", "check", "IDEA-001"))
        self.write_brief()
        first = self.ok(self.a, "brief", "check", "IDEA-001")
        self.assertEqual((first["revision"], first["new_revision"], first["passes"], first["stage"]), (1, True, True, "brief"))
        self.assertEqual(first["counts"], {"outcomes": 2, "assumptions": 2, "open_questions": 0, "shipped_rules": 2, "capabilities": 2})
        self.assertEqual(self.ok(self.a, "brief", "check", "IDEA-001")["new_revision"], False)
        self.write_brief(text=SHIPPED_BRIEF.replace("SLICE-001/INV-02", "SLICE-001/INV-09"))
        broken = self.ok(self.a, "brief", "check", "IDEA-001")
        self.assertEqual((broken["revision"], broken["passes"], broken["stage"]), (2, False, "exploring"))
        self.assertTrue(any("SLICE-001/INV-09 is not in any shipped spec" in e for e in broken["errors"]))
        start, end = SHIPPED_BRIEF.index("- **O-2:**"), SHIPPED_BRIEF.index("## Not doing")
        without = SHIPPED_BRIEF[:start] + "\n" + SHIPPED_BRIEF[end:]
        self.write_brief(text=without)
        self.assertTrue(self.ok(self.a, "brief", "check", "IDEA-001")["passes"])
        self.assertEqual(self.record()["brief"]["ids"]["O-2"], "removed")
        self.write_brief()
        back = self.ok(self.a, "brief", "check", "IDEA-001")
        self.assertFalse(back["passes"])
        self.assertTrue(any("O-2 was taken out of an earlier revision" in e for e in back["errors"]))
        shown = self.ok(self.a, "brief", "show", "IDEA-001")
        self.assertEqual((shown["text"], shown["changed_since_check"]), (SHIPPED_BRIEF, False))

    def test_the_verdict_is_a_person_s_and_goes_stale_when_the_brief_changes(self):
        self.add()
        refused = self.refused(self.a, "verdict", "record", "IDEA-001", "--decision", "go", "--reason", "Yes.")
        self.assertIn("Go needs a brief that passes its check", refused)
        not_now = self.ok(self.a, "verdict", "record", "IDEA-001", "--decision", "not-now", "--reason", "After the summer.")
        self.assertEqual((not_now["verdict"]["by"], not_now["verdict"]["brief_sha256"], not_now["verdict"]["holds"]), ("ada-pm", None, True))
        self.write_brief()
        self.assertEqual(self.ok(self.a, "idea", "show", "IDEA-001")["verdict"]["stale"], True)  # written after the verdict
        go = self.ok(self.a, "verdict", "record", "IDEA-001", "--decision", "go", "--reason", "Members ask for it at every desk.")
        digest = issue_rules.text_sha256_of(SHIPPED_BRIEF)
        self.assertEqual(go["verdict"]["brief_sha256"], digest)
        self.assertEqual((go["replaced"]["decision"], go["stage"], self.record()["stage"], self.record()["verdict"]["revision"]), ("not-now", "decided", "decided", 1))
        self.assertIs(go["factory_authorized"], False)
        self.write_brief(text=SHIPPED_BRIEF.replace("under 15", "under 10"))
        shown = self.ok(self.a, "idea", "show", "IDEA-001")
        self.assertEqual((shown["verdict"]["holds"], shown["verdict"]["stale"]), (False, True))
        self.assertIn("The brief changed after this verdict was recorded", shown["verdict"]["stale_note"])
        checked = self.ok(self.a, "brief", "check", "IDEA-001")
        self.assertEqual((checked["revision"], checked["stage"], checked["verdict"]["stale"]), (2, "brief", True))
        self.assertEqual(self.ok(self.a, "idea", "list")["ideas"][0]["next"]["kind"], "record_verdict")
        for reason in ("", "x" * 501, "token ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", "Yes <!-- mach:idea-verdict -->"):
            self.refused(self.a, "verdict", "record", "IDEA-001", "--decision", "no", "--reason", reason)
        self.not_a_choice("verdict", "record", "IDEA-001", "--decision", "maybe", "--reason", "x")
        # MACH never recommends one: nothing the engine says names a verdict as advised.
        for out in (shown, checked, self.ok(self.a, "status"), self.ok(self.a, "idea", "list")):
            self.assertNotRegex(json.dumps(out).lower(), r"recommend(?!s a verdict)(?!ed)")

    def test_a_shaped_idea_keeps_its_verdict(self):
        self.decided()
        record = self.record()
        record.update(stage="shaped", made={"epics": ["EPIC-004"], "slices": ["SLICE-012"]})
        self.path("product/ideas/IDEA-001.json").write_text(json.dumps(record))
        self.assertIn("already shaped", self.refused(self.a, "verdict", "record", "IDEA-001", "--decision", "no", "--reason", "Changed my mind."))
        record["route"] = {"route": "epic", "counted": {"outcomes": 2}, "why": "Both outcomes sit in lending.", "at": "2026-11-20T10:00:00Z"}
        record["lookback"] = {"outcomes": {"O-1": {"result": "met", "note": "Down to 11.", "by": "ada-pm", "at": "2026-11-21T10:00:00Z"}}}
        self.path("product/ideas/IDEA-001.json").write_text(json.dumps(record))
        self.ok(self.a, "brief", "check", "IDEA-001")
        after = self.record()
        self.assertEqual((after["route"], after["made"], after["lookback"]), (record["route"], record["made"], record["lookback"]))  # untouched
        record["route"]["route"] = "a-small-change"  # the light path is deferred
        self.path("product/ideas/IDEA-001.json").write_text(json.dumps(record))
        self.assertIn("route.route is small-change, one-slice, epic or several-epics", self.refused(self.a, "idea", "show", "IDEA-001"))

    def test_the_case_is_checked(self):
        self.add()
        self.assertIn("no case yet", self.refused(self.a, "case", "check", "IDEA-001"))
        self.write_brief()
        self.write_case()
        checked = self.ok(self.a, "case", "check", "IDEA-001")
        self.assertEqual((checked["passes"], checked["model"]["answered"], checked["model"]["not_answered"]), (True, 2, 1))
        self.assertNotIn("text", checked)
        self.write_case(text=CASE.replace("  - Not answered: the product manager wants the first month's numbers first.\n", ""))
        checked = self.ok(self.a, "case", "check", "IDEA-001")
        self.assertFalse(checked["passes"])
        self.assertIn("Q-3 is not answered yet", " ".join(checked["errors"]))
        self.assertIn("## Hard questions", self.ok(self.a, "case", "show", "IDEA-001")["text"])
        self.assertEqual(self.ok(self.a, "idea", "show", "IDEA-001")["case"]["open"], 1)


class PublishTest(ShapeBase):
    def test_the_idea_becomes_one_issue_with_its_brief_its_state_and_the_verdict(self):
        self.decided()
        before = self.checkout_state(self.a)
        saved = self.ok(self.a, "idea", "publish", "IDEA-001")
        self.assertEqual((saved["saved_to"], saved["state_label"], saved["verdict_posted"], saved["by"]), ("github", "mach:idea-go", True, "ada-pm"))
        (issue,) = self.idea_issues()
        self.assertEqual(issue["title"], "IDEA-001: Let members renew a loan themselves")
        self.assertEqual(sorted(self.labels_of(issue["number"])), ["mach:idea", "mach:idea-go"])
        parsed = issue_rules.parse_shape_body(issue["body"])
        self.assertEqual((parsed["idea_id"], parsed["revision"], parsed["brief"], parsed["intact"]), ("IDEA-001", 1, SHIPPED_BRIEF, True))
        (comment,) = issue["comments"]
        self.assertEqual(issue_rules.shape_verdicts([comment["body"]]),
                         [{"idea_id": "IDEA-001", "revision": 1, "decision": "go", "by": "ada-pm", "brief_sha256": issue_rules.text_sha256_of(SHIPPED_BRIEF)}])
        self.assertIn("Their reason: Members ask for it at every desk.", comment["body"])
        self.assertEqual(self.record()["issue"], {"number": issue["number"], "state": "open"})
        self.assertEqual(self.checkout_state(self.a), before)  # the product manager's checkout is untouched
        status = self.ok(self.a, "status")
        row = status["ideas"]["ideas"][0]
        self.assertEqual((row["github"]["saved"], row["github"]["up_to_date"], row["next"]["kind"]), ("github", True, "size"))
        self.assertTrue(status["saved"]["everything_saved"])
        # The calls made: reads, the labels, one issue and one comment. No other kind of write, and nothing for the Factory.
        kinds = sorted({" ".join(call[:2]) for call in self.writes()})
        self.assertEqual(kinds, ["issue comment", "issue create", "label create"])
        self.assertFalse(any(name in json.dumps(self.gh()["calls"]) for name in ("mach:ready", "mach:slice", "mach:request")))
        # Again: nothing is made twice.
        writes = len(self.writes())
        self.ok(self.a, "idea", "publish", "IDEA-001")
        self.assertEqual(len(self.writes()), writes)

    def test_a_changed_brief_replaces_the_body_and_the_state_but_never_the_verdict_comment(self):
        self.decided()
        number = self.ok(self.a, "idea", "publish", "IDEA-001")["issue"]
        self.write_brief(text=SHIPPED_BRIEF.replace("under 15", "under 10"))
        self.assertEqual(self.ok(self.a, "status")["saved"]["not_saved"][0]["kind"], "idea_changed")
        saved = self.ok(self.a, "idea", "publish", "IDEA-001")
        self.assertEqual((saved["revision"], saved["state_label"], saved["verdict_posted"]), (2, "mach:idea-brief", False))
        issue = self.issue(number)
        self.assertEqual(sorted(self.labels_of(number)), ["mach:idea", "mach:idea-brief"])
        self.assertEqual(issue_rules.parse_shape_body(issue["body"])["revision"], 2)
        self.assertEqual(len(issue["comments"]), 1)  # the old verdict stays, for the old brief
        self.ok(self.a, "verdict", "record", "IDEA-001", "--decision", "no", "--reason", "The insurer said no.")
        self.ok(self.a, "idea", "publish", "IDEA-001")
        self.assertEqual(sorted(self.labels_of(number)), ["mach:idea", "mach:idea-no"])
        self.assertEqual([v["decision"] for v in issue_rules.shape_verdicts(c["body"] for c in self.issue(number)["comments"])], ["go", "no"])

    def test_an_interrupted_publish_finishes_and_makes_nothing_twice(self):
        self.decided()
        self.lose("issue create:mach:idea")  # created on GitHub, but the answer never arrived
        self.assertIn("stopped part way", self.refused(self.a, "idea", "publish", "IDEA-001"))
        self.assertEqual(len(self.idea_issues()), 1)
        self.assertEqual(self.ok(self.a, "status")["saved"]["not_saved"][0]["kind"], "idea_unfinished")
        self.assertEqual(self.ok(self.a, "idea", "list")["ideas"][0]["next"]["kind"], "publish")
        self.gh_fails("issue comment")  # then the verdict comment fails before it is written
        self.assertIn("stopped part way", self.refused(self.a, "idea", "publish", "IDEA-001"))
        self.lose("issue comment")  # and then it is written but the answer is lost
        self.refused(self.a, "idea", "publish", "IDEA-001")
        self.ok(self.a, "idea", "publish", "IDEA-001")
        (issue,) = self.idea_issues()
        self.assertEqual(len(issue["comments"]), 1)
        self.assertEqual(self.shape_ledger()["ideas"]["IDEA-001"]["run"], None)
        self.assertTrue(self.ok(self.a, "status")["saved"]["everything_saved"])

    def test_github_unreachable_saves_nothing(self):
        self.decided()
        self.gh_fails("repo view", NETWORK_DOWN, once=False)
        self.assertIn("Nothing was saved", self.refused(self.a, "idea", "publish", "IDEA-001"))
        self.assertEqual(self.idea_issues(), [])
        self.assertFalse((self.a / ".factory/studio/ideas.json").exists() and self.shape_ledger()["ideas"].get("IDEA-001", {}).get("saved"))
        self.assertFalse(self.path("product/ready/IDEAS").exists())  # a passing failure never falls back to the folder
        self.assertIn("could not be reached", self.refused(self.a, "verdict", "record", "IDEA-001", "--decision", "no", "--reason", "x"))

    def test_without_github_the_idea_goes_to_the_folder(self):
        self.set_gh(signed_in=False)
        self.add()
        self.write_brief()
        recorded = self.ok(self.a, "verdict", "record", "IDEA-001", "--decision", "go", "--reason", "Members ask for it.")
        self.assertEqual((recorded["verdict"]["by"], recorded["recorded_without_github"]), (None, True))
        saved = self.ok(self.a, "idea", "publish", "IDEA-001")
        self.assertEqual(saved["saved_to"], "folder")
        folder = self.path("product/ready/IDEAS/IDEA-001")
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["brief.md", "idea.json"])
        self.assertEqual((folder / "brief.md").read_text(), SHIPPED_BRIEF)
        data = json.loads((folder / "idea.json").read_text())
        self.assertEqual((data["brief_sha256"], data["verdict"]["decision"], data["state_label"]), (issue_rules.text_sha256_of(SHIPPED_BRIEF), "go", "mach:idea-go"))
        self.assertEqual(self.idea_issues(), [])
        # Signed in later, the verdict recorded without a login is not posted as someone's: it is recorded again first.
        self.set_gh(signed_in=True)
        self.assertIn("Record the verdict again", self.refused(self.a, "idea", "publish", "IDEA-001"))
        self.assertEqual(self.idea_issues(), [])

    def test_an_issue_without_its_label_or_another_idea_s_number_is_left_alone(self):
        self.decided()
        number = self.ok(self.a, "idea", "publish", "IDEA-001")["issue"]
        self.change_issue(number, labels=[{"name": "bug"}])
        self.write_brief(text=SHIPPED_BRIEF.replace("under 15", "under 12"))
        self.assertIn("no longer marked as an idea", self.refused(self.a, "idea", "publish", "IDEA-001"))
        self.assertEqual(issue_rules.parse_shape_body(self.issue(number)["body"])["revision"], 1)
        # Another product manager's IDEA-002 is on GitHub; this workspace's own IDEA-002 must take another number.
        self.set_gh(me="ben-pm")
        self.ok(self.b, "idea", "add", "Their idea")
        self.ok(self.b, "idea", "add", "Their second idea")
        self.ok(self.b, "idea", "publish", "IDEA-002")
        self.set_gh(me="ada-pm")
        self.add("Mine")
        # Never blocked: publishing gives it the next free number and saves it, in the same act.
        published = self.ok(self.a, "idea", "publish", "IDEA-002")
        self.assertEqual((published["renumbered"], published["idea_id"], published["saved_to"]),
                         ({"from": "IDEA-002", "to": "IDEA-003"}, "IDEA-003", "github"))
        self.assertTrue(published["note"].startswith("IDEA-002 was already used on GitHub by another idea (#"))
        self.assertIn("so MACH gave yours the next free number: IDEA-002 is now IDEA-003", published["note"])
        self.assertEqual(issue_rules.parse_shape_body(self.issue(published["issue"])["body"])["idea_id"], "IDEA-003")
        self.assertIn("already saved", self.refused(self.a, "idea", "renumber", "IDEA-003"))


class RefreshTest(ShapeBase):
    def test_refresh_without_ideas_makes_no_call_for_them(self):
        self.ok(self.a, "refresh")
        self.assertNotIn("ideas", self.ok(self.a, "refresh"))
        self.assertFalse(any("mach:idea" in call for call in self.gh()["calls"]))

    def test_an_issue_changed_on_github_after_its_verdict_is_flagged(self):
        self.decided()
        number = self.ok(self.a, "idea", "publish", "IDEA-001")["issue"]
        quiet = self.ok(self.a, "refresh")["ideas"]
        self.assertEqual((quiet["refreshed"], quiet["issues"], quiet["changed_on_github"]), (True, 1, []))
        writes = len(self.writes())
        self.change_issue(number, body=self.issue(number)["body"].replace("under 15", "under 5"))
        found = self.ok(self.a, "refresh")["ideas"]
        self.assertEqual(len(self.writes()), writes)  # refresh only reads
        self.assertEqual([(c["idea_id"], c["issue"], c["after_verdict"]) for c in found["changed_on_github"]], [("IDEA-001", number, True)])
        row = self.ok(self.a, "idea", "list")["ideas"][0]
        self.assertEqual((row["github"]["changed_on_github"], row["github"]["changed_after_verdict"], row["next"]["kind"]), (True, True, "publish"))
        self.ok(self.a, "idea", "publish", "IDEA-001")  # puts the approved brief back
        self.assertTrue(issue_rules.parse_shape_body(self.issue(number)["body"])["intact"])
        self.assertEqual(self.ok(self.a, "refresh")["ideas"]["changed_on_github"], [])

    def test_a_verdict_comment_gone_and_a_closed_issue_are_seen(self):
        self.decided()
        number = self.ok(self.a, "idea", "publish", "IDEA-001")["issue"]
        self.change_issue(number, comments=[], state="CLOSED")
        self.ok(self.a, "refresh")
        row = self.ok(self.a, "idea", "list")["ideas"][0]
        self.assertEqual((row["github"]["verdict_on_github"], row["github"]["state"]), (False, "closed"))
        self.assertEqual(self.record()["issue"]["state"], "closed")

    def test_refresh_without_github_says_so(self):
        self.add()
        self.set_gh(signed_in=False)
        found = self.ok(self.a, "refresh")["ideas"]
        self.assertEqual(found["refreshed"], False)
        self.assertIn("not signed in", found["problem"])


class AppWordingTest(ShapeBase):
    def test_refusals_for_the_app_name_no_command(self):
        self.add()
        self.requests_cache([(57, "Renew online", REQUEST_BODY, "accepted")])
        for argv in (("brief", "check", "IDEA-001"), ("case", "show", "IDEA-001"), ("verdict", "record", "IDEA-001", "--decision", "go", "--reason", "Yes."),
                     ("idea", "add", "x", "--from-issue", "57"), ("idea", "add", "x", "--from-request", "60")):
            self.app_refusal(*argv)
        self.decided()
        self.lose("issue create:mach:idea")
        self.app_refusal("idea", "publish", "IDEA-001")
        self.add("A second idea")
        code, out, err = self.run_studio(self.a, "--app", "status")
        self.assertEqual(code, 0, err)
        status = json.loads(out)
        sentences = [row["next"]["sentence"] for row in status["ideas"]["ideas"]] + [item["text"] for item in status["saved"]["not_saved"]]
        self.assertGreaterEqual(len(sentences), 3)
        self.assertIn("idea_unfinished", [item["kind"] for item in status["saved"]["not_saved"]])
        for sentence in sentences:
            self.assertIsNone(BANNED.search(sentence), sentence)


class FactoryTest(IntakeBase):
    """No brief or idea text reaches the Factory: intake reads neither the idea issues nor product/ready/IDEAS/."""

    def test_intake_takes_no_idea_from_github_or_the_folder(self):
        self.first()
        self.set_gh(me="ada-pm")
        self.ok(self.a, "idea", "add", "Let members renew a loan themselves")
        brief = self.a / ".factory/studio/draft/product/briefs/IDEA-001.md"
        brief.write_text(BRIEF.replace("- Shipped rules: SLICE-004/FR-02, SLICE-007/INV-01", "- Shipped rules: None."))
        self.ok(self.a, "verdict", "record", "IDEA-001", "--decision", "go", "--reason", "Members ask for it at every desk.")
        self.ok(self.a, "idea", "publish", "IDEA-001")
        target = self.a / "product/ready/IDEAS/IDEA-001"
        target.mkdir(parents=True)
        (target / "brief.md").write_text(BRIEF)
        (target / "idea.json").write_text(json.dumps({"idea_id": "IDEA-001"}))
        git(self.a, "add", "product")
        git(self.a, "commit", "-q", "-m", "an idea, committed by hand")
        git(self.a, "push", "-q", "origin", "main")
        git(self.eng, "pull", "-q", "--ff-only")
        self.set_gh(me="erin-eng")
        taken = self.product("intake")
        self.assertEqual([row["slice_id"] for row in taken["created"]], ["SLICE-001"])
        self.assertEqual(taken["not_accepted"], [])
        kept = " ".join(path.read_text(errors="ignore") for path in (self.eng / ".factory").rglob("*") if path.is_file())
        for words in ("renew a loan", "IDEA-001", "renewal calls", "mach:idea"):
            self.assertNotIn(words, kept)


if __name__ == "__main__":
    unittest.main()
