"""M13 part E: a CSV file a person imports into Jira (`jira export`), and the Jira keys back (`jira keys`).

The export reads only the draft workspace and the last refresh: no GitHub, no Git write, no network. It writes one
self-contained file of epics and the stories beneath them in the product manager's order, with a README.txt, inside
Product Studio's own folder or outside the repository. `jira keys` records keys through the same path as `slice link`
and `epic link`. Neither has been tried against a real Jira."""

import ast
import csv
import io
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "product-studio" / "scripts"))
import jira_export  # noqa: E402
import test_mach_product_issues as issues_tests  # noqa: E402


def parse(path):
    with open(path, encoding="utf-8", newline="") as handle:
        rows = list(csv.reader(handle))
    return rows[0], rows[1:]


def column(header, rows, name):
    return [row[header.index(name)] for row in rows]


class NeutralTest(unittest.TestCase):
    def test_formula_cells_are_neutralised_and_ordinary_text_is_not(self):
        for dangerous in ("=1+2", "=HYPERLINK(\"http://x\",\"y\")", "@SUM(A1)", "+cmd|' /C calc'!A0", "-2+3+cmd|' /C calc'!A0",
                          "\t=1", "\r=1", "\n=1", "  =1+2", "＝1+2", "＠SUM(1)", "－1+SUM(1)", "+1 (555) 0100"):
            self.assertEqual(jira_export.neutral(dangerous), "'" + dangerous, repr(dangerous))
        for ordinary in ("- Fix the sign-in page", "+ Add a teammate", "-1", "-1+1", "- Fix the sign-in page, then sign out", "Invite a teammate", "", "SLICE-001", "mach-draft",
                         "MACH slice SLICE-001", "h3. Why", "100"):
            self.assertEqual(jira_export.neutral(ordinary), ordinary, repr(ordinary))
        self.assertEqual(jira_export.unneutral("'=1+2"), "=1+2")

    def test_markdown_becomes_wiki_markup_and_cannot_mention_or_call_a_macro(self):
        text = "## Head\n\n- **Given** a `code` value and [a link](https://example.org)\n  - nested\n1. first\n\n| A | B |\n|---|---|\n| x | y |\n"
        self.assertEqual(jira_export.to_wiki(text),
                         "h2. Head\n\n* *Given* a {{code}} value and a link (https://example.org)\n** nested\n# first\n\n||A||B||\n|x|y|")
        escaped = jira_export.to_wiki("Ask [~admin] about {code:java} and a|b")
        self.assertFalse(re.search(r"(?<!\\)\[~", escaped), escaped)
        self.assertIn("\\[~admin\\]", escaped)
        self.assertIn("\\{code:java\\}", escaped)
        self.assertEqual(jira_export.to_wiki("h1. not a heading"), "\\h1. not a heading")

    def test_labels_have_no_spaces(self):
        self.assertEqual(jira_export.label("mach-ready to build"), "mach-ready-to-build")


class ExportBase(issues_tests.IssuesBase):
    def three_slices(self):
        """SLICE-001 and SLICE-002 (which depends on it) marked ready; SLICE-003 a draft."""
        self.project_and_epic()
        self.drafted()
        self.ready()
        self.drafted(title="Remove a teammate", depends=("SLICE-001",))
        self.ready("SLICE-002")
        self.drafted(title="- Resend an invitation")

    def export(self, *argv):
        calls = len(self.gh()["calls"])
        result = self.ok(self.a, "jira", "export", *argv)
        self.assertEqual(len(self.gh()["calls"]), calls, "the export reaches no GitHub")
        self.assertFalse(result["factory_authorized"])
        return result


class ExportTest(ExportBase):
    def test_a_cloud_file_keeps_the_hierarchy_and_parses(self):
        self.three_slices()
        before = self.checkout_state(self.a)
        result = self.export()
        self.assertEqual(self.checkout_state(self.a), before, "the product manager's checkout is untouched")
        folder = Path(result["folder"])
        self.assertEqual(folder, (self.a / ".factory/studio/jira/cloud").resolve())
        header, rows = parse(result["file"])
        self.assertEqual(header, ["Work item ID", "Work type", "Summary", "Parent", "Description", "Labels", "Labels", "Labels",
                                  "MACH ID", "GitHub issue", "Blocks"])
        self.assertEqual(column(header, rows, "MACH ID"), ["EPIC-001", "SLICE-001", "SLICE-002"])
        self.assertEqual(column(header, rows, "Work type"), ["Epic", "Story", "Story"])
        self.assertEqual(column(header, rows, "Work item ID"), ["1000001", "2000001", "2000002"])
        self.assertEqual(column(header, rows, "Parent"), ["", "1000001", "1000001"], "each story names its epic's row")
        self.assertEqual(column(header, rows, "Blocks"), ["", "2000002", ""], "SLICE-001 blocks SLICE-002, which depends on it")
        self.assertEqual([row[5:8] for row in rows], [["mach", "EPIC-001", ""], ["mach", "SLICE-001", "mach-ready_to_build"],
                                                       ["mach", "SLICE-002", "mach-ready_to_build"]])
        for row in rows:
            self.assertFalse(any(" " in value for value in row[5:8]), "labels have no spaces")
        story = rows[1][header.index("Description")]
        self.assertIn("MACH slice SLICE-001", story)
        self.assertIn("h3. Why\n* *Problem:* An admin cannot bring a colleague in.", story)
        self.assertIn("h4. AC-01: Admin invites a teammate", story)
        url = column(header, rows, "GitHub issue")[1]
        self.assertRegex(url, r"^https://github\.com/[^/]+/[^/]+/issues/[0-9]+$")
        self.assertIn(f"GitHub issue: [{url}]", story)
        self.assertIn("Depends on: SLICE-001.", rows[2][header.index("Description")])
        self.assertEqual(result["exported"], ["EPIC-001", "SLICE-001", "SLICE-002"])
        self.assertEqual([item["id"] for item in result["left_out"]], ["SLICE-003"], "a draft is not agreed work")
        readme = Path(result["readme"]).read_text()
        for words in ("External System Import", "Work item ID", "Parent", "jira keys", "SLICE-003", "MACH ID"):
            self.assertIn(words, readme)

    def test_the_file_round_trips_through_the_csv_module(self):
        self.three_slices()
        result = self.export("--state", "all")
        raw = Path(result["file"]).read_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), "UTF-8 with no byte order mark")
        raw.decode("utf-8")
        header, rows = parse(result["file"])
        self.assertTrue(all(len(row) == len(header) for row in rows))
        self.assertEqual(jira_export.csv_text(header, rows).encode("utf-8"), raw)
        self.assertIn(b'""Acme Design""', raw, "a quote inside a cell is written twice")
        self.assertIn(b"\r\n\"2000001\"", raw, "records end with CRLF")
        self.assertIn("\nh3. Why\n", rows[1][header.index("Description")], "line breaks are kept inside a cell")

    def test_all_states_include_drafts_in_the_product_managers_order(self):
        self.three_slices()
        self.ok(self.a, "slice", "move", "SLICE-003", "--first")
        result = self.export("--state", "all")
        self.assertTrue(result["folder"].endswith("cloud-all"))
        header, rows = parse(result["file"])
        self.assertEqual(column(header, rows, "MACH ID"), ["EPIC-001", "SLICE-003", "SLICE-001", "SLICE-002"])
        self.assertEqual(rows[1][5:8], ["mach", "SLICE-003", "mach-draft"])
        self.assertEqual(column(header, rows, "Summary")[1], "- Resend an invitation", "a summary starting with a hyphen is not changed")

    def test_a_data_center_file_links_stories_by_epic_name(self):
        self.three_slices()
        header, rows = parse(self.export("--flavour", "data-center")["file"])
        self.assertEqual(header[:6], ["Issue Id", "Issue Type", "Summary", "Epic Name", "Epic Link", "Description"])
        self.assertNotIn("Parent", header)
        names, links = column(header, rows, "Epic Name"), column(header, rows, "Epic Link")
        self.assertEqual(names, ["EPIC-001 Team membership", "", ""])
        self.assertEqual(links, ["", "EPIC-001 Team membership", "EPIC-001 Team membership"])

    def test_one_epic_only_and_an_unknown_epic(self):
        self.three_slices()
        self.ok(self.a, "epic", "add", "--title", "Billing", "--criterion", "Invoices are correct")
        result = self.export("--epic", "EPIC-001")
        self.assertTrue(result["folder"].endswith("cloud-EPIC-001"))
        self.assertEqual(result["exported"], ["EPIC-001", "SLICE-001", "SLICE-002"])
        everything = self.export("--state", "all")
        self.assertIn("EPIC-002", everything["exported"], "with --state all an epic with no slices is still exported")
        self.assertIn("no epic EPIC-009", self.refused(self.a, "jira", "export", "--epic", "EPIC-009"))

    def test_the_same_workspace_gives_the_same_bytes(self):
        self.three_slices()
        first = Path(self.export()["file"]).read_bytes()
        outside = self.root / "handover"
        second = Path(self.export("--out", str(outside))["file"]).read_bytes()
        self.assertEqual(first, second)
        self.assertEqual(first, Path(self.export()["file"]).read_bytes())

    def test_a_folder_in_the_tracked_tree_is_refused(self):
        self.three_slices()
        for inside in (self.a / "exports", self.a, self.a / ".factory" / "release"):
            self.assertIn("inside the repository", self.refused(self.a, "jira", "export", "--out", str(inside)))
        self.assertFalse((self.a / "exports").exists())
        link = self.a / ".factory" / "studio" / "escape"
        link.symlink_to(self.a / "docs", target_is_directory=True)
        self.assertIn("inside the repository", self.refused(self.a, "jira", "export", "--out", str(link)), "a link is judged by where it leads")
        result = self.export("--out", str(self.root / "for-jira"))
        self.assertTrue(Path(result["file"]).is_file())
        self.assertTrue(Path(self.export("--out", str(self.a / ".factory/studio/mine"))["file"]).is_file())

    def test_formula_and_secret_text_leave_neutralised_and_redacted(self):
        self.project_and_epic()
        self.drafted(title="=HYPERLINK(\"http://evil.example\",\"click\")")
        intent = self.draft(self.a, "product/intents/SLICE-001.md")
        intent.write_text(intent.read_text().replace("An admin cannot bring a colleague in.",
                                                     "An admin cannot bring a colleague in. api_key = sk-live-abcdefghijklmnopqrstuvwx1234"))
        header, rows = parse(self.export("--state", "all")["file"])
        self.assertTrue(rows[1][header.index("Summary")].startswith("'=HYPERLINK"))
        description = rows[1][header.index("Description")]
        self.assertNotIn("sk-live-abcdefghijklmnopqrstuvwx1234", description)
        self.assertIn("<redacted>", description)
        self.assertNotIn("sam@example.com", description, "email addresses in scenarios are masked")
        for row in rows:
            for value in row:
                self.assertFalse(value[:1] in "=@\t\r" and value, value[:20])

    def test_a_long_why_is_cut_and_says_so(self):
        self.project_and_epic()
        self.drafted()
        intent = self.draft(self.a, "product/intents/SLICE-001.md")
        intent.write_text(intent.read_text().replace("An admin cannot bring a colleague in.", "word " * 4000))
        result = self.export("--state", "all")
        self.assertEqual(result["cut"], ["SLICE-001"])
        header, rows = parse(result["file"])
        description = rows[1][header.index("Description")]
        self.assertIn("Cut to fit", description)
        self.assertLessEqual(len(description), jira_export.DESCRIPTION_LIMIT)

    def test_items_already_in_jira_are_left_out_and_listed(self):
        self.project_and_epic()
        self.ok(self.a, "epic", "link", "EPIC-001", "--jira", "TEAM-1")
        self.drafted()
        self.ok(self.a, "slice", "link", "SLICE-001", "--jira", "TEAM-7")
        self.ready()
        self.drafted(title="Remove a teammate")
        self.ready("SLICE-002")
        result = self.export()
        header, rows = parse(result["file"])
        self.assertEqual(column(header, rows, "MACH ID"), ["SLICE-002"], "the epic and SLICE-001 are already in Jira")
        self.assertEqual(column(header, rows, "Parent"), [""], "an existing epic is never named in the Parent column")
        self.assertIn("already in Jira as TEAM-1", rows[0][header.index("Description")])
        left = {item["id"]: item for item in result["left_out"]}
        self.assertEqual((left["SLICE-001"]["jira"], left["EPIC-001"]["jira"]), ("TEAM-7", "TEAM-1"))
        readme = Path(result["readme"]).read_text()
        self.assertIn("SLICE-001: it is already in Jira as TEAM-7", readme)

    def test_nothing_ready_writes_an_empty_file_and_says_so(self):
        self.project_and_epic()
        self.drafted()
        result = self.export()
        self.assertEqual(result["counts"], {"epics": 0, "stories": 0})
        self.assertIn("no slice is marked ready", result["note"])


class KeysTest(ExportBase):
    def jira_file(self, rows, header=("Summary", "Issue key", "Issue id", "Labels", "Labels", "Custom field (MACH ID)")):
        path = self.root / "from-jira.csv"
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(header)
        writer.writerows(rows)
        path.write_text(buffer.getvalue(), encoding="utf-8")
        return str(path)

    def test_keys_are_linked_unmatched_refused_and_ready_slices_named(self):
        self.three_slices()
        calls = len(self.gh()["calls"])
        path = self.jira_file([
            ("Team membership", "TEAM-1", "10001", "mach", "EPIC-001", ""),
            ("- Resend an invitation", "TEAM-3", "10003", "mach", "SLICE-003", "SLICE-003"),
            ("Invite a teammate", "TEAM-2", "10002", "mach", "SLICE-001", "'SLICE-001"),
            ("Something else", "TEAM-4", "10004", "other", "", ""),
            ("Bad key", "team-5", "10005", "mach", "SLICE-002", ""),
            ("Not here", "TEAM-6", "10006", "mach", "SLICE-099", ""),
        ])
        dry = self.ok(self.a, "jira", "keys", path, "--dry-run")
        self.assertEqual([item["id"] for item in dry["linked"]], ["EPIC-001", "SLICE-003"])
        self.assertNotIn("tracking", self.ok(self.a, "slice", "show", "SLICE-003")["slice"], "a dry run changes nothing")
        result = self.ok(self.a, "jira", "keys", path)
        self.assertEqual(result["linked"], [{"id": "EPIC-001", "jira": "TEAM-1"}, {"id": "SLICE-003", "jira": "TEAM-3"}])
        self.assertEqual([item["id"] for item in result["needs_reopening"]], ["SLICE-001"])
        self.assertEqual(result["epics_with_ready_slices"], {"EPIC-001": ["SLICE-001", "SLICE-002"]})
        self.assertEqual([item["row"] for item in result["unmatched"] if "row" in item], [5])
        self.assertEqual([item.get("id") for item in result["unmatched"] if "row" not in item], ["SLICE-099"])
        self.assertEqual([(item.get("row"), item["id"]) for item in result["refused"]], [(6, "SLICE-002")])
        self.assertNotIn("team-5", json.dumps(result), "a bad key is not echoed")
        self.assertEqual(self.ok(self.a, "slice", "show", "SLICE-003")["slice"]["tracking"], {"jira": "TEAM-3"})
        self.assertNotIn("tracking", self.ok(self.a, "slice", "show", "SLICE-001")["slice"], "a ready slice is not silently changed")
        self.assertTrue(self.ok(self.a, "validate")["valid"])
        self.assertEqual(len(self.gh()["calls"]), calls, "recording keys reaches no GitHub")
        again = self.ok(self.a, "jira", "keys", path)
        self.assertEqual(again["linked"], [])
        self.assertEqual([item["id"] for item in again["already_linked"]], ["EPIC-001", "SLICE-003"])

    def test_conflicting_and_changed_keys_are_refused(self):
        self.three_slices()
        self.ok(self.a, "slice", "link", "SLICE-003", "--jira", "TEAM-30")
        path = self.jira_file([
            ("x", "TEAM-1", "1", "mach", "EPIC-001", ""), ("x", "TEAM-9", "2", "mach", "EPIC-001", ""),
            ("x", "TEAM-31", "3", "mach", "SLICE-003", ""),
        ])
        result = self.ok(self.a, "jira", "keys", path)
        self.assertEqual(result["linked"], [])
        reasons = {item["id"]: item["reason"] for item in result["refused"]}
        self.assertIn("more than one key", reasons["EPIC-001"])
        self.assertIn("already linked to TEAM-30", reasons["SLICE-003"])
        path = self.jira_file([("x", "TEAM-1", "1", "mach", "EPIC-001", ""), ("x", "TEAM-1", "2", "mach", "SLICE-003", "")])
        self.assertIn("more than one MACH item", json.dumps(self.ok(self.a, "jira", "keys", path)["refused"]))

    def test_a_file_that_is_too_large_or_has_no_key_column_is_refused(self):
        self.three_slices()
        big = self.root / "big.csv"
        big.write_bytes(b"Issue key,Labels\n" + b"TEAM-1,mach\n" * (jira_export.KEYS_MAX_BYTES // 12 + 1))
        self.assertIn("the most read is", self.refused(self.a, "jira", "keys", str(big)))
        many = self.jira_file([("x", f"TEAM-{n}", str(n), "mach", "", "") for n in range(1, jira_export.KEYS_MAX_ROWS + 3)])
        self.assertIn("more than 5000 rows", self.refused(self.a, "jira", "keys", many))
        nokey = self.jira_file([("x", "1", "mach")], header=("Summary", "Issue id", "Labels"))
        self.assertIn("no column of Jira keys", self.refused(self.a, "jira", "keys", nokey))
        binary = self.root / "bad.csv"
        binary.write_bytes(b"Issue key,Labels\n\xff\xfe,\n")
        self.assertIn("not UTF-8", self.refused(self.a, "jira", "keys", str(binary)))
        self.assertIn("is not a file", self.refused(self.a, "jira", "keys", str(self.root / "missing.csv")))

    def test_the_export_then_the_keys_back(self):
        """What a person would do: export, import into Jira (not done here), export from Jira with keys, hand it back."""
        self.project_and_epic()
        self.drafted()
        self.drafted(title="Remove a teammate")
        header, rows = parse(self.export("--state", "all")["file"])
        from_jira = [("Issue key", "Labels", "Labels", "Labels")]
        from_jira += [(f"TEAM-{n}", *row[5:8]) for n, row in enumerate(rows, start=1)]
        path = self.root / "jira-export.csv"
        path.write_text("".join(",".join(row) + "\n" for row in from_jira))
        result = self.ok(self.a, "jira", "keys", str(path))
        self.assertEqual(result["linked"], [{"id": "EPIC-001", "jira": "TEAM-1"}, {"id": "SLICE-001", "jira": "TEAM-2"}, {"id": "SLICE-002", "jira": "TEAM-3"}])
        self.assertEqual(self.export("--state", "all")["counts"], {"epics": 0, "stories": 0}, "everything is in Jira now")


class IsolationTest(unittest.TestCase):
    """The export and the keys reach neither GitHub, Git nor any network, and change Studio only through its link helpers."""

    def test_no_network_library_no_git_and_no_gh(self):
        source = (ROOT / "skills" / "product-studio" / "scripts" / "jira_export.py").read_text()
        imported = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                imported |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or "").split(".")[0])
        self.assertEqual(imported, {"argparse", "csv", "io", "re", "pathlib", "typing", "handoff"})
        self.assertFalse(re.findall(r"\b(?:git|git_bytes|gh|gh_json|gh_write|_gh_json|_gh_write)\(", source))
        for word in ("collab", "issues.", "requests()", "subprocess", "urllib", "socket", "http.", "jira.atlassian", "Popen", "os.system",
                     ".handoff().run", ".handoff().prepare", "write_folder"):
            self.assertNotIn(word, source, word)
        self.assertEqual(set(re.findall(r"\bhandoff\.([a-z_]+)\(", source)), {"order_rows", "slice_view", "epic_number"}, "handoff.py only for reading")
        self.assertEqual(set(re.findall(r"\bhost\.(link_[a-z]+)\(", source)), {"link_slice", "link_epic"})


if __name__ == "__main__":
    unittest.main()
