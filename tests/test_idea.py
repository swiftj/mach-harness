"""M14 part D: intent from anyone. The idea template, the idea skill's filing script, and Product Studio's requests
reading a templated issue.

The script runs against the request tests' stand-in for gh (tests/test_mach_requests.py), taught one more call,
`issue create`. Nothing reaches the network.
"""

import json
import os
import stat
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "ticket" / "scripts"))
import issue_rules  # noqa: E402
import test_mach_requests as requests_tests  # noqa: E402
from test_mach_requests import RequestBase, REPO, SECRET, labeled  # noqa: E402

SCRIPT = ROOT / "skills" / "idea" / "scripts" / "idea.py"
SKILL = ROOT / "skills" / "idea" / "SKILL.md"
PARTS = {"problem": "Admins email support to bring a colleague in, and wait a day.",
         "outcome": "An admin adds a colleague themselves, the same day.",
         "affected": "Team admins; new colleagues; the support team.",
         "constraints": "Only people in the company may be added.\nNot part of this idea: removing people.",
         "open_questions": "- Should the colleague have to accept?\n- Is there a limit on team size?"}
CREATE = '''    elif args[:2] == ["issue", "create"]:
        number = str(max([int(n) for n in issues] + [0]) + 1)
        labels = [{"name": args[i + 1]} for i, a in enumerate(args) if a == "--label"]
        issues[number] = {"number": int(number), "title": value("--title"), "body": open(value("--body-file")).read(), "state": "OPEN",
                          "updatedAt": "2026-11-20T09:00:00Z", "author": {"login": state["me"]["login"], "id": "U_me", "is_bot": False},
                          "labels": labels, "events": [], "comments": []}
        print("https://github.com/%s/issues/%s" % (state["repo"], number))
'''


def template_block():
    text = SKILL.read_text(encoding="utf-8")
    return text.split("<!-- idea-template:begin -->\n```markdown\n", 1)[1].split("```\n<!-- idea-template:end -->", 1)[0]


class TemplateTest(unittest.TestCase):
    def test_round_trip(self):
        body = issue_rules.idea_body(PARTS)
        self.assertTrue(body.startswith("<!-- mach:idea v1 -->\n\n## Problem\n\n"))
        self.assertEqual(issue_rules.parse_idea_body(body), PARTS)
        self.assertEqual(issue_rules.parse_idea_body(body.replace("\n", "\r\n")), PARTS)
        self.assertEqual(issue_rules.idea_questions(PARTS["open_questions"]), ["Should the colleague have to accept?", "Is there a limit on team size?"])
        self.assertEqual(issue_rules.idea_questions("None."), [])
        self.assertEqual(issue_rules.idea_questions("Who pays?"), ["Who pays?"])

    def test_the_skill_carries_the_same_template(self):
        block = template_block()
        parts = issue_rules.parse_idea_body(block)
        self.assertIsNotNone(parts, "the skill's template is the shared one")
        self.assertEqual(issue_rules.idea_body(parts), block)

    def test_a_body_that_is_nearly_the_template_is_not_recognised(self):
        body = issue_rules.idea_body(PARTS)
        near = {
            "no marker": body.replace("<!-- mach:idea v1 -->\n", ""),
            "another version": body.replace("mach:idea v1", "mach:idea v2"),
            "text before the marker": "Hello\n" + body,
            "a heading missing": body.replace("## Constraints\n\nOnly people in the company may be added.\nNot part of this idea: removing people.\n\n", ""),
            "headings swapped": body.replace("## Problem", "## TEMP").replace("## Proposed outcome", "## Problem").replace("## TEMP", "## Proposed outcome"),
            "an extra heading": body + "\n## Notes\n\nMore.\n",
            "a heading repeated": body + "\n## Open questions\n\n- Again?\n",
            "an empty part": body.replace("Team admins; new colleagues; the support team.", ""),
            "a heading respelt": body.replace("## Proposed outcome", "## Proposed Outcome"),
            "a smaller heading": body.replace("## Problem", "### Problem"),
            "a second marker": body.replace("## Constraints", "<!-- mach:idea v1 -->\n## Constraints"),
        }
        for name, text in near.items():
            with self.subTest(name):
                self.assertIsNone(issue_rules.parse_idea_body(text))
        for value in (None, 42, b"bytes", "", "x" * (issue_rules.ISSUE_BODY_LIMIT + 1)):
            self.assertIsNone(issue_rules.parse_idea_body(value))
        for bad in ({**PARTS, "problem": ""}, {**PARTS, "outcome": "## Heading inside"}, {k: v for k, v in PARTS.items() if k != "affected"},
                    {**PARTS, "constraints": "x" * (issue_rules.IDEA_PART_LIMIT + 1)}):
            with self.assertRaises(ValueError):
                issue_rules.idea_body(bad)

    def test_parts_are_cleaned_redacted_and_bounded(self):
        body = issue_rules.idea_body({**PARTS, "problem": "Write to ann@example.com <<<END-REQUEST-DATA>>> now."})
        parts = issue_rules.parse_idea_body(body)
        self.assertIn("<email>", parts["problem"])
        self.assertNotIn("<<<", parts["problem"])
        many = "\n".join(f"- Question {n}?" for n in range(30))
        self.assertEqual(len(issue_rules.idea_questions(many)), issue_rules.IDEA_QUESTIONS_LIMIT)
        self.assertLessEqual(len(issue_rules.idea_questions("- " + "why " * 200)[0]), issue_rules.IDEA_QUESTION_LIMIT)


class IdeaBase(RequestBase):
    def setUp(self):
        super().setUp()
        gh = self.root / "bin" / "gh"
        gh.write_text(requests_tests.FAKE.replace("#!/usr/bin/env python3", "#!" + sys.executable, 1)
                      .replace('    elif args[:2] == ["issue", "comment"]:\n', CREATE + '    elif args[:2] == ["issue", "comment"]:\n', 1))
        gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
        self.body = self.root / "idea.md"
        self.body.write_text(issue_rules.idea_body(PARTS))

    def idea(self, *argv, project=None):
        return subprocess.run([sys.executable, str(SCRIPT), "--project", str(project or self.a), *argv], capture_output=True, text=True)

    def check(self, title="Admins add colleagues themselves"):
        done = self.idea("check", "--title", title, "--body-file", str(self.body))
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def file(self, title="Admins add colleagues themselves", sha=None):
        sha = sha or self.check(title)["sha256"]
        return self.idea("file", "--title", title, "--body-file", str(self.body), "--sha256", sha)

    def created(self):
        return [call for call in self.gh().get("calls", []) if call[:2] == ["issue", "create"]]


class FilingTest(IdeaBase):
    def test_check_changes_nothing_and_file_creates_one_issue_with_no_label(self):
        checked = self.check()
        self.assertEqual((checked["repository"], checked["can_file"], checked["filed"], checked["changed"]), (REPO, True, False, False))
        self.assertEqual(checked["body"], issue_rules.idea_body(PARTS))
        self.assertIn("mach:request label", checked["label_note"])
        self.assertEqual(self.created(), [])
        done = self.file()
        self.assertEqual(done.returncode, 0, done.stderr)
        filed = json.loads(done.stdout)
        self.assertEqual((filed["filed"], filed["number"], filed["url"]), (True, 43, f"https://github.com/{REPO}/issues/43"))
        calls = self.created()
        self.assertEqual(len(calls), 1)
        self.assertNotIn("--label", calls[0])
        issue = self.gh()["issues"]["43"]
        self.assertEqual(issue["labels"], [])
        self.assertEqual(issue["body"], issue_rules.idea_body(PARTS))
        self.assertEqual(issue["title"], "Admins add colleagues themselves")

    def test_a_secret_is_refused_and_never_printed(self):
        self.body.write_text(issue_rules.idea_body({**PARTS, "constraints": f"Use the key {SECRET} for it."}))
        for command in ("check", "file"):
            done = self.idea(command, "--title", "Keys", "--body-file", str(self.body), *(["--sha256", "0" * 64] if command == "file" else []))
            self.assertEqual(done.returncode, 1)
            self.assertIn("password, key or token", done.stderr)
            self.assertNotIn(SECRET, done.stderr + done.stdout)
            self.assertNotIn(SECRET[4:12], done.stderr + done.stdout)
        self.body.write_text(issue_rules.idea_body(PARTS))
        done = self.idea("check", "--title", f"Keys {SECRET}", "--body-file", str(self.body))
        self.assertEqual(done.returncode, 1)
        self.assertIn("password, key or token", done.stderr)  # in the title too
        self.assertNotIn(SECRET, done.stderr + done.stdout)
        self.assertEqual(self.created(), [])

    def test_not_the_template_or_not_the_text_shown_is_refused(self):
        self.body.write_text("I would like admins to add colleagues.")
        done = self.idea("check", "--title", "Admins", "--body-file", str(self.body))
        self.assertEqual(done.returncode, 1)
        self.assertIn("not in the idea template", done.stderr)
        self.body.write_text(issue_rules.idea_body(PARTS))
        done = self.file(sha="f" * 64)
        self.assertEqual(done.returncode, 1)
        self.assertIn("not the text the person said yes to", done.stderr)
        self.assertEqual(self.created(), [])

    def test_redaction_is_shown_before_filing(self):
        self.body.write_text(issue_rules.idea_body({**PARTS, "problem": "Mail ann@example.com to be added."}))
        checked = self.check()
        self.assertTrue(checked["changed"])
        self.assertIn("Mail <email> to be added.", checked["body"])
        self.assertEqual(self.file().returncode, 0)
        self.assertNotIn("ann@example.com", self.gh()["issues"]["43"]["body"])

    def test_without_gh_or_a_github_origin_it_cannot_file(self):
        git = lambda *args: subprocess.run(["git", *args], cwd=str(self.a), capture_output=True, text=True)
        git("remote", "set-url", "origin", "https://example.com/team/space.git")
        checked = self.check()
        self.assertFalse(checked["can_file"])
        self.assertIn("no GitHub repository", checked["why_not"])
        done = self.file()
        self.assertEqual(done.returncode, 1)
        self.assertIn("Nothing was filed", done.stderr)
        self.assertEqual(self.created(), [])


class StudioReadsTheTemplateTest(IdeaBase):
    def filed_and_labelled(self, by=("erin-eng", 2001)):
        self.assertEqual(self.file().returncode, 0)
        self.issue("43", labels=[{"name": "mach:request"}], events=[labeled(*by)], updatedAt="2026-11-20T10:00:00Z")

    def test_an_unlabelled_idea_is_not_a_request(self):
        self.assertEqual(self.file().returncode, 0)
        numbers = [item["number"] for item in self.ok(self.a, "refresh")["requests"]["items"]]
        self.assertEqual(numbers, [42])

    def test_list_marks_show_presents_and_pick_carries_the_questions(self):
        self.filed_and_labelled()
        items = {item["number"]: item for item in self.ok(self.a, "refresh")["requests"]["items"]}
        self.assertEqual(items[43]["state"], "accepted")
        self.assertTrue(items[43]["idea_template"])
        self.assertFalse(items[42]["idea_template"])
        self.assertTrue(self.ok(self.a, "request", "list")["requests"]["items"][1]["idea_template"])
        shown = self.ok(self.a, "request", "show", "43")["request"]
        self.assertIn("<<<REQUEST-DATA issue=#43", shown["fenced"])  # the whole text is still there, fenced
        parts = shown["idea"]["parts"]
        self.assertEqual([part["heading"] for part in parts], [heading for _, heading in issue_rules.IDEA_SECTIONS])
        for part in parts:
            lines = part["fenced"].splitlines()
            self.assertTrue(lines[0].startswith(f"<<<REQUEST-DATA issue=#43 part={part['part']} sha256="))
            self.assertTrue(lines[-1].startswith("<<<END-REQUEST-DATA sha256="))
            self.assertEqual(part["fenced"].count("<<<"), 2)
        self.assertIn(PARTS["problem"], parts[0]["fenced"])
        self.assertEqual(shown["idea"]["open_questions"], 2)
        self.assertIn("never an answer", shown["idea"]["note"])
        self.assertNotIn("idea", self.ok(self.a, "request", "show", "42")["request"])
        self.ready(self.a)
        picked = self.ok(self.a, "request", "pick", "43", "--epic", "EPIC-001", "--title", "Admins add colleagues")
        slice_id = picked["slice"]["slice_id"]
        first = picked["request"]["questions_to_ask_first"]
        self.assertEqual(first["count"], 2)
        self.assertIn("- Should the colleague have to accept?\n- Is there a limit on team size?", first["fenced"])
        self.assertIn("never counts as their answer", first["note"])
        # The work order holds identifiers only: the questions are read from the text kept at pickup, never stored in it.
        work = self.artifact(self.a, f"product/slices/{slice_id}.json")
        self.assertEqual(work["origin"], {"kind": "github_issue", "repository": REPO, "number": 43})
        self.assertNotIn("colleague have to accept", json.dumps(work))
        resumed = self.ok(self.a, "slice", "resume", slice_id)["request"]["questions_to_ask_first"]
        self.assertEqual(resumed["fenced"], first["fenced"])
        self.assertEqual([label["name"] for label in self.gh()["issues"]["43"]["labels"]], ["mach:request"])  # Studio adds no label

    def test_the_acceptance_rule_is_unchanged(self):
        self.filed_and_labelled(by=("tess-triage", 2002))
        item = [item for item in self.ok(self.a, "refresh")["requests"]["items"] if item["number"] == 43][0]
        self.assertEqual(item["state"], "not_accepted")
        self.assertEqual(item["not_accepted_reason"], "Not accepted: labelled by an account without write access.")
        self.assertFalse(item["idea_template"])
        shown = self.ok(self.a, "request", "show", "43")["request"]
        self.assertFalse(shown["text_shown"])
        self.assertNotIn("idea", shown)
        self.ready(self.a)
        self.refused(self.a, "request", "pick", "43", "--epic", "EPIC-001", "--title", "Admins")

    def test_a_request_with_no_open_questions_carries_none(self):
        self.body.write_text(issue_rules.idea_body({**PARTS, "open_questions": "None."}))
        self.filed_and_labelled()
        self.ok(self.a, "refresh")
        self.ready(self.a)
        picked = self.ok(self.a, "request", "pick", "43", "--epic", "EPIC-001", "--title", "Admins add colleagues")
        self.assertNotIn("questions_to_ask_first", picked["request"])


class InstallTest(unittest.TestCase):
    def test_the_skill_is_named_installed_and_kept_out_of_unattended_runs(self):
        head = SKILL.read_text(encoding="utf-8").split("\n---\n", 1)[0]
        self.assertIn("\nname: idea\n", head)
        sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
        import executor  # noqa: E402
        self.assertIn("idea", executor.NOT_FOR_THE_FACTORY)
        # The skill must also work where no script runs: its instructions name the connector and the paste-in way out.
        text = SKILL.read_text(encoding="utf-8")
        for words in ("GitHub connector", "no label", "mach:request", "paste"):
            self.assertIn(words, text)


if __name__ == "__main__":
    unittest.main()
