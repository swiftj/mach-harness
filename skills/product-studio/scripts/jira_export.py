#!/usr/bin/env python3
"""MACH Product Studio, M13 part E: a CSV file a person imports into Jira, and the keys back.

    jira export [--epic EPIC-NNN] [--state ready|all] [--out <folder>] [--flavour cloud|data-center]
        one CSV file of epics and the slices beneath them, in the product manager's order, with a
        README.txt beside it for the person who does the upload. Reads only the draft workspace and
        what the last refresh recorded; no network, no Git, no GitHub, no Jira.
    jira keys <csv file> [--dry-run]
        a CSV exported from Jira after the import: each row's Jira key recorded on its slice or epic
        through the same path as `slice link --jira` / `epic link --jira`.

MACH never calls Jira and holds no Jira credentials. The file is made for Jira's own CSV importer;
docs/mach-next/M13_JIRA_EXPORT.md says what Atlassian's documentation establishes and what it does not.

Spec and why text leaves the workspace only redacted (issue_rules.bound_text), bounded and converted
to Jira's wiki markup; every cell is neutralised against spreadsheet formulas. The same workspace
gives the same bytes: no clock, no random number, sorted order.

The handlers reach Product Studio's own code (load, the link helpers, the refusal) through the module
studio.py passes to add_commands, never by importing it. Standard library only.
"""

import argparse
import csv
import io
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import handoff

# ---- limits and shapes ----

FLAVOURS = ("cloud", "data-center")
STATES = ("ready", "all")
SLICE_ID_RE = re.compile(r"^SLICE-[0-9]{3,6}$")
EPIC_ID_RE = re.compile(r"^EPIC-[0-9]{3,6}$")
MACH_ID_RE = re.compile(r"^(?:SLICE|EPIC)-[0-9]{3,6}$")
LABEL_RE = re.compile(r"[^A-Za-z0-9_.-]+")

SUMMARY_LIMIT = 250          # Jira's summary holds 255 characters; a little room is kept
EPIC_NAME_LIMIT = 100        # Data Center's Epic Name: kept short, it is shown on cards
WHY_LIMIT = 8000
SCENARIOS_LIMIT = 18000
CRITERIA_LIMIT = 6000
DESCRIPTION_LIMIT = 30000    # below the 32,767 characters Jira's text fields are commonly said to hold

# Stable numeric row IDs: the same item always has the same ID in every export. Numbers, because the
# Cloud article on parent and child says the Parent column takes the parent row's numeric ID.
EPIC_ROW_BASE = 1_000_000
SLICE_ROW_BASE = 2_000_000

# Reading a file from Jira
KEYS_MAX_BYTES = 8 * 1024 * 1024
KEYS_MAX_ROWS = 5000
KEYS_MAX_COLUMNS = 500
REPORT_LIMIT = 200           # entries listed per heading in what `jira keys` returns
KEY_HEADERS = ("issue key", "work item key", "key")
ID_HEADERS = ("mach id", "custom field (mach id)")
LABEL_HEADERS = ("labels", "label")

# Where a slice is, as handoff.progress says it; the default export is what the product manager marked ready or further.
MARKED_READY = ("approved", "ready_to_build", "being_built", "question", "shipped")

COLUMNS = {
    "cloud": {"id": "Work item ID", "type": "Work type", "summary": "Summary", "parent": "Parent", "description": "Description",
              "label": "Labels", "mach": "MACH ID", "github": "GitHub issue", "blocks": "Blocks"},
    "data-center": {"id": "Issue Id", "type": "Issue Type", "summary": "Summary", "epic_name": "Epic Name", "epic_link": "Epic Link",
                    "description": "Description", "label": "Labels", "mach": "MACH ID", "github": "GitHub issue", "blocks": "Blocks"},
}


class ExportError(Exception):
    pass


# ---- spreadsheet formulas ----

ALWAYS = set("=@\t\r\n＝＠")
SIGNS = set("+-＋－")
# What a formula needs beyond a sign: a function call, a reference to another sheet or program (DDE), or another = or @.
FORMULA_MARKS = set("=()|!@＝（）｜！＠")


def neutral(value: str) -> str:
    """A cell that no spreadsheet program reads as a formula (OWASP's CSV injection advice: a single quote
    before a cell that starts with = + - @, tab, carriage return or line feed, or their full-width forms).

    A leading + or - is left alone when nothing after it could call a function or reach another sheet or
    program (no = ( ) | ! @): a summary such as "- Fix the sign-in page", or a plain number, is not changed. Leading spaces are
    looked through, since they can hide the first character."""
    stripped = value.lstrip(" ")
    if not stripped:
        return value
    first = stripped[0]
    if first in ALWAYS or (first in SIGNS and any(mark in FORMULA_MARKS for mark in stripped[1:])):
        return "'" + value
    return value


def unneutral(value: str) -> str:
    """A cell read back: the quote `neutral` adds is taken off before matching."""
    value = value.strip()
    return value[1:].strip() if value.startswith("'") else value


# ---- Markdown to Jira wiki markup ----

CODE_RE = re.compile(r"`([^`\n]+)`")
BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
LINK_RE = re.compile(r"\[([^\]\n]+)\]\(([^)\s]+)\)")
HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$")
BULLET_RE = re.compile(r"^([ \t]*)[-*+][ \t]+(.*)$")
NUMBERED_RE = re.compile(r"^([ \t]*)[0-9]{1,4}[.)][ \t]+(.*)$")
TABLE_SEPARATOR_RE = re.compile(r"^\|?[ \t:|-]+\|?$")
WIKI_SPECIAL_RE = re.compile(r"([\\{}\[\]|])")
WIKI_LINE_START_RE = re.compile(r"^(h[1-6]\.|bq\.|----)")


def escape_wiki(text: str) -> str:
    """Plain text that Jira's wiki renderer shows as written: no macro ({...}), no link or mention ([...], [~name]),
    no table cell break, and no line that reads as a heading, a quote or a rule."""
    text = WIKI_SPECIAL_RE.sub(r"\\\1", text)
    return "\\" + text if WIKI_LINE_START_RE.match(text) else text


def wiki_inline(text: str) -> str:
    """One line's inline Markdown in wiki markup: `code` to {{code}}, **bold** to *bold*, [text](url) to text (url)."""
    parts: List[str] = []
    last = 0
    for match in CODE_RE.finditer(text):
        parts.append(wiki_plain(text[last:match.start()]))
        parts.append("{{" + escape_wiki(match.group(1)).lstrip("\\") + "}}" if match.group(1).strip() else "")
        last = match.end()
    parts.append(wiki_plain(text[last:]))
    return "".join(parts)


def wiki_plain(text: str) -> str:
    text = LINK_RE.sub(lambda m: f"{m.group(1)} ({m.group(2)})", text)
    pieces = BOLD_RE.split(text)  # odd entries were bold
    return "".join(("*" + escape_wiki(piece).lstrip("\\") + "*") if index % 2 else escape_wiki(piece) for index, piece in enumerate(pieces))


def table_cells(line: str) -> List[str]:
    inner = line.strip()
    inner = inner[1:] if inner.startswith("|") else inner
    inner = inner[:-1] if inner.endswith("|") else inner
    return [cell.strip() for cell in inner.split("|")]


def to_wiki(markdown: str, heading_shift: int = 0) -> str:
    """The spec's Markdown in the wiki markup Jira's CSV importer stores in a description: headings, bullet and
    numbered lists, bold, inline code and tables. Anything else is plain, escaped text."""
    out: List[str] = []
    header_done = False
    in_table = False
    for raw in markdown.splitlines():
        line = raw.rstrip()
        if not line.strip():
            out.append("")
            in_table = header_done = False
            continue
        heading = HEADING_RE.match(line)
        if heading:
            level = min(6, len(heading.group(1)) + heading_shift)
            out.append(f"h{level}. {wiki_inline(heading.group(2))}")
            in_table = False
            continue
        if line.lstrip().startswith("|"):
            if TABLE_SEPARATOR_RE.match(line.strip()):
                continue
            cells = [wiki_inline(cell) or " " for cell in table_cells(line)]
            if not in_table and not header_done:
                out.append("||" + "||".join(cells) + "||")
                header_done = True
            else:
                out.append("|" + "|".join(cells) + "|")
            in_table = True
            continue
        in_table = False
        bullet, numbered = BULLET_RE.match(line), NUMBERED_RE.match(line)
        if bullet or numbered:
            found = bullet or numbered
            depth = 1 + len(found.group(1).expandtabs(4)) // 2
            out.append(("*" if bullet else "#") * min(depth, 4) + " " + wiki_inline(found.group(2)))
            continue
        out.append(wiki_inline(line.strip()))
    while out and not out[-1]:
        out.pop()
    return "\n".join(out)


# ---- reading the workspace ----

def section(text: str, heading: str, level: int) -> Optional[str]:
    """The body of the first heading of this level with this title, up to the next heading of the same or a higher level."""
    lines = text.splitlines()
    marker = "#" * level + " "
    start = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if start is None:
            if stripped.startswith(marker) and stripped[len(marker):].strip().lower() == heading.lower():
                start = index + 1
            continue
        found = re.match(r"^(#{1,6})\s", stripped)
        if found and len(found.group(1)) <= level:
            return "\n".join(lines[start:index]).strip("\n")
    return "\n".join(lines[start:]).strip("\n") if start is not None else None


def bounded(rules: Any, text: str, limit: int) -> Tuple[str, bool]:
    """Workspace text as it may leave: cleaned, redacted with the shared redaction, and cut at the limit."""
    return rules.bound_text(text, limit)


def label(value: str) -> str:
    """A Jira label: no spaces (Atlassian: labels cannot contain spaces), only letters, digits, '_', '.' and '-'."""
    return LABEL_RE.sub("-", value).strip("-")[:255]


def own_key(rules: Any, item: Dict[str, Any]) -> Optional[str]:
    tracking = item.get("tracking")
    key = tracking.get("jira") if isinstance(tracking, dict) else None
    return key if rules.is_jira_key(key) else None


def row_number(mach_id: str) -> int:
    number = int(mach_id.split("-")[1])
    return (EPIC_ROW_BASE if mach_id.startswith("EPIC-") else SLICE_ROW_BASE) + number


# ---- the export ----

def output_folder(host: Any, studio: Any, given: Optional[str], name: str) -> Path:
    """Inside the git-ignored Studio workspace by default. A folder a person names must be in that workspace or
    outside the repository altogether: never in the repository's tracked tree."""
    home, project = studio.home.resolve(), studio.project.resolve()
    folder = Path(given).expanduser() if given else studio.home / "jira" / name
    folder = (folder if folder.is_absolute() else Path.cwd() / folder).resolve()  # a symbolic link is judged by where it leads
    inside_project = folder == project or project in folder.parents
    inside_home = folder == home or home in folder.parents
    if inside_project and not inside_home:
        raise host.StudioError(f"{folder} is inside the repository, where it could be committed. Leave out --out to write into "
                               f"Product Studio's own folder ({studio.home / 'jira'}), or name a folder outside the repository.")
    return folder


def epic_description(rules: Any, epic_id: str, epic: Dict[str, Any], issue_url: Optional[str]) -> Tuple[str, bool]:
    criteria = "\n".join(f"- {item}" for item in epic.get("acceptance_criteria") or [] if isinstance(item, str))
    criteria, cut = bounded(rules, criteria, CRITERIA_LIMIT)
    lines = [f"MACH epic {epic_id}."]
    if issue_url:
        lines.append(f"GitHub issue: [{issue_url}]")
    if criteria:
        lines += ["", "h3. Acceptance criteria", to_wiki(criteria)]
    if cut:
        lines += ["", "_(Cut to fit. The full text is in MACH Product Studio.)_"]
    return "\n".join(lines), cut


def slice_description(rules: Any, slice_id: str, work: Dict[str, Any], epic_line: str, issue_url: Optional[str],
                      depends: Sequence[str], why: Optional[str], scenarios: Optional[str]) -> Tuple[str, bool]:
    cut = False
    lines = [f"MACH slice {slice_id}, revision {int(work.get('revision') or 1)}. {epic_line}"]
    if issue_url:
        lines.append(f"GitHub issue: [{issue_url}]")
    if depends:
        lines.append("Depends on: " + ", ".join(depends) + ".")
    for title, text, limit in (("Why", why, WHY_LIMIT), ("Scenarios", scenarios, SCENARIOS_LIMIT)):
        if text and text.strip():
            body, was_cut = bounded(rules, text, limit)
            cut = cut or was_cut
            lines += ["", f"h3. {title}", to_wiki(body, heading_shift=0)]
    text = "\n".join(lines)
    if len(text) > DESCRIPTION_LIMIT:
        text, cut = text[:DESCRIPTION_LIMIT - 200].rstrip(), True
    if cut:
        text += "\n\n_(Cut to fit. The full text is in the spec" + (" on the GitHub issue" if issue_url else " in MACH Product Studio") + ".)_"
    return text, cut


def plan_export(host: Any, studio: Any, epic_filter: Optional[str], state: str) -> Dict[str, Any]:
    """What goes in the file and what is left out, decided from the workspace and the last refresh only."""
    rules = host.ticket_rules()
    epics, slices = studio.all("epic"), studio.all("slice")
    ledger = studio.handoff().load()
    repository = ledger.get("repository")
    if epic_filter is not None:
        epic_filter = epic_filter.strip().upper()
        if not EPIC_ID_RE.fullmatch(epic_filter) or epic_filter not in epics:
            raise host.StudioError(f"There is no epic {epic_filter[:20]} in this workspace.")
    wanted_epics = [epic_filter] if epic_filter else list(epics)
    order = {row["epic_id"]: [item["slice_id"] for item in row["slices"]] for row in handoff.order_rows(ledger, slices, rules, wanted_epics)}

    def url(number: Any) -> Optional[str]:
        return rules.issue_url(repository, number) if repository and rules.is_issue_number(number) else None

    items: List[Dict[str, Any]] = []
    left_out: List[Dict[str, str]] = []
    for epic_id in wanted_epics:
        epic = epics[epic_id]
        members: List[Dict[str, Any]] = []
        for slice_id in order.get(epic_id, []):
            work = slices.get(slice_id)
            if work is None:
                left_out.append({"id": slice_id, "reason": "it is on GitHub but not in this workspace, so its spec is not here"})
                continue
            view = handoff.slice_view(ledger, slice_id, work, rules)
            progress = view["progress"]
            if progress == "superseded" or work.get("status") == "superseded":
                left_out.append({"id": slice_id, "reason": "it was superseded"})
                continue
            if state == "ready" and progress not in MARKED_READY:
                left_out.append({"id": slice_id, "reason": "it is not marked ready yet (export with --state all to include drafts)"})
                continue
            key = own_key(rules, work)
            if key:
                left_out.append({"id": slice_id, "reason": f"it is already in Jira as {key}", "jira": key})
                continue
            members.append({"kind": "slice", "id": slice_id, "data": work, "view": view, "progress": progress or "draft", "url": url(view["issue"])})
        if not members and state == "ready":
            left_out.append({"id": epic_id, "reason": "none of its slices is marked ready yet, or all of them are already in Jira"})
            continue
        key = own_key(rules, epic)
        epic_item = {"kind": "epic", "id": epic_id, "data": epic, "url": url(handoff.epic_number(ledger, epic_id)), "jira": key}
        if key:
            left_out.append({"id": epic_id, "reason": f"it is already in Jira as {key}; its slices below name it in their description", "jira": key})
        items.append({"epic": epic_item, "slices": members})
    return {"rules": rules, "groups": items, "left_out": left_out, "slices": slices}


def build_rows(studio: Any, plan: Dict[str, Any], flavour: str) -> Tuple[List[str], List[List[str]], List[str]]:
    """The header and the rows, parents before children. Returns the IDs whose description was cut."""
    rules, columns = plan["rules"], COLUMNS[flavour]
    exported = {member["id"] for group in plan["groups"] for member in group["slices"]}
    exported |= {group["epic"]["id"] for group in plan["groups"] if not group["epic"]["jira"]}
    blocks: Dict[str, List[str]] = {}
    for group in plan["groups"]:
        for member in group["slices"]:
            for dependency in member["data"].get("dependencies") or []:
                if dependency in exported:
                    blocks.setdefault(dependency, []).append(str(row_number(member["id"])))
    records: List[Dict[str, Any]] = []
    cut_ids: List[str] = []
    for group in plan["groups"]:
        epic = group["epic"]
        title = rules.bound_text(epic["data"].get("title") or epic["id"], SUMMARY_LIMIT, one_line=True)[0]
        if not epic["jira"]:
            description, cut = epic_description(rules, epic["id"], epic["data"], epic["url"])
            cut_ids += [epic["id"]] if cut else []
            records.append({"id": str(row_number(epic["id"])), "type": "Epic", "summary": title, "parent": "", "description": description,
                            "epic_name": rules.bound_text(f"{epic['id']} {title}", EPIC_NAME_LIMIT, one_line=True)[0], "epic_link": "",
                            "labels": ["mach", epic["id"]], "mach": epic["id"], "github": epic["url"] or "", "blocks": blocks.get(epic["id"], [])})
            epic_line = f"Epic: {epic['id']} ({title})."
        else:
            epic_line = f"Epic: {epic['id']} ({title}), already in Jira as {epic['jira']}: set it as this item's parent there."
        for member in group["slices"]:
            work = member["data"]
            spec = studio.spec_of(member["id"])
            spec_text = spec.read_text(encoding="utf-8-sig") if spec else ""
            intent = studio.intent_path(member["id"])
            why = section(intent.read_text(encoding="utf-8-sig"), "Why", 2) if intent.is_file() else None
            scenarios = section(spec_text, "Scenarios", 3)
            depends = [dep + (f" (Jira {own_key(rules, plan['slices'][dep])})" if dep in plan["slices"] and own_key(rules, plan["slices"][dep]) else "")
                       for dep in work.get("dependencies") or [] if isinstance(dep, str) and SLICE_ID_RE.fullmatch(dep)]
            description, cut = slice_description(rules, member["id"], work, epic_line, member["url"], depends, why, scenarios)
            cut_ids += [member["id"]] if cut else []
            in_file = not epic["jira"]
            records.append({"id": str(row_number(member["id"])), "type": "Story",
                            "summary": rules.bound_text(work.get("title") or member["id"], SUMMARY_LIMIT, one_line=True)[0],
                            "parent": str(row_number(epic["id"])) if in_file else "", "description": description, "epic_name": "",
                            "epic_link": "",
                            "labels": ["mach", member["id"], label("mach-" + member["progress"])], "mach": member["id"],
                            "github": member["url"] or "", "blocks": blocks.get(member["id"], [])})
            if in_file and flavour == "data-center":
                records[-1]["epic_link"] = rules.bound_text(f"{epic['id']} {title}", EPIC_NAME_LIMIT, one_line=True)[0]
    label_count = max([len(record["labels"]) for record in records] or [1])
    block_count = max([len(record["blocks"]) for record in records] or [0])
    if flavour == "cloud":
        fields = ["id", "type", "summary", "parent"]
    else:
        fields = ["id", "type", "summary", "epic_name", "epic_link"]
    fields += ["description"]
    header = [columns[name] for name in fields] + [columns["label"]] * label_count + [columns["mach"], columns["github"]] + [columns["blocks"]] * block_count
    rows = []
    for record in records:
        row = [record[name] for name in fields]
        row += record["labels"] + [""] * (label_count - len(record["labels"]))
        row += [record["mach"], record["github"]]
        row += record["blocks"] + [""] * (block_count - len(record["blocks"]))
        rows.append([neutral(value) for value in row])
    return [neutral(value) for value in header], rows, cut_ids


def csv_text(header: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    """RFC 4180: every field quoted, a quote written twice, lines ending CRLF, line breaks kept inside a field. UTF-8, no byte order mark."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)
    return buffer.getvalue()


def readme(flavour: str, header: Sequence[str], counts: Dict[str, int], left_out: Sequence[Dict[str, str]], csv_name: str) -> str:
    cloud = flavour == "cloud"
    blocks = "Blocks" in header
    lines = [
        "MACH export for Jira" + (" Cloud" if cloud else " Data Center"),
        "",
        f"{csv_name} holds {counts['epics']} epic(s) and {counts['stories']} story(ies) from MACH Product Studio. Each epic comes",
        "before its stories. Import it once; MACH does not connect to Jira, so nothing else is sent.",
        "",
        "Before you start",
        "- Try it first with a test project or a copy of a few rows.",
        "- If you want the MACH ID and the GitHub issue kept in fields of their own, ask a Jira administrator to create two",
        "  custom fields first: \"MACH ID\" (a short text field) and \"GitHub issue\" (a URL field). The administrator's",
        "  import can also create them during the import. Without them, both are still in each description.",
        "",
        "Where to import",
    ]
    if cloud:
        lines += [
            "- Jira administrators: Settings > System > External System Import > CSV (Atlassian: \"Import data from a CSV file\",",
            "  https://support.atlassian.com/jira-cloud-administration/docs/import-data-from-a-csv-file/).",
            "- Others may be able to use the space's own CSV import (\"Import work into an existing space in Jira using CSV\").",
            "  It keeps the hierarchy too, but may not offer every field below.",
        ]
    else:
        lines += [
            "- A Jira administrator: the cog > System > External System Import > CSV (Atlassian: \"Importing data from CSV\",",
            "  https://confluence.atlassian.com/display/ADMINJIRASERVER/Importing+data+from+CSV).",
            "  Atlassian's article on importing epics with their stories names this import, not the per-project one.",
        ]
    lines += [
        "",
        "Settings on the first screen",
        "- File encoding: UTF-8. Delimiter: comma. Leave the date format as it is: the file holds no dates.",
        "- Choose the Jira project (space) to import into on the import screen; the file does not name one.",
        "",
        "Map the columns",
    ]
    if cloud:
        lines += [
            "- Work item ID  -> Work item ID (the importer may call it Issue ID). Needed for the hierarchy.",
            "- Work type     -> Work type (Issue Type). Values are Epic and Story; if your project calls them something",
            "                   else, tick \"Map field value\" and choose yours.",
            "- Summary       -> Summary",
            "- Parent        -> Parent. Holds the epic's Work item ID from this file, so each story lands under its epic.",
        ]
    else:
        lines += [
            "- Issue Id      -> Issue Id",
            "- Issue Type    -> Issue Type. Values are Epic and Story; tick \"Map field value\" if yours differ.",
            "- Summary       -> Summary",
            "- Epic Name     -> Epic Name (filled on epic rows only)",
            "- Epic Link     -> Epic Link. Holds the epic's Epic Name from this file, which is how Atlassian's article",
            "                   links stories to epics imported in the same file.",
        ]
    lines += [
        "- Description   -> Description. Written in Jira's wiki markup (headings, lists, tables). Do NOT tick",
        "                   \"Map field value\" for it, or the formatting may be lost.",
        "- Labels        -> Labels (the column repeats; map each one). Every row has \"mach\" and its MACH ID.",
        "- MACH ID       -> your \"MACH ID\" field, or leave it unmapped (it is also a label).",
        "- GitHub issue  -> your \"GitHub issue\" URL field, or leave it unmapped (it is also in the description).",
    ]
    if blocks:
        lines += [
            "- Blocks        -> the \"Blocks\" link type. The row blocks the items whose ID is in this column (one slice",
            "                   depends on another). Atlassian documents this for Data Center; on Cloud, if the import screen",
            "                   does not offer it, leave it unmapped: each story's description names what it depends on.",
        ]
    lines += [
        "",
        "Cells that start with a character a spreadsheet program could read as a formula begin with a single quote (').",
        "Jira keeps that quote; remove it by hand if one appears in a summary.",
        "",
    ]
    if left_out:
        lines += ["Not in this file"]
        lines += [f"- {item['id']}: {item['reason']}." for item in left_out[:REPORT_LIMIT]]
        lines += [""]
    lines += [
        "After the import: hand the keys back",
        "1. In Jira, search for the imported items, for example:  labels = mach",
        "2. Export the results as CSV (all fields, or at least the key and the labels).",
        "3. Give that file to the product manager, who runs:  jira keys <file>",
        "   MACH then knows each item's Jira key, and its pull requests name it, so Jira's GitHub integration links them.",
        "",
    ]
    return "\n".join(lines)


def cmd_export(host: Any, studio: Any, args: argparse.Namespace) -> Dict[str, Any]:
    flavour, state = args.flavour, args.state
    plan = plan_export(host, studio, args.epic, state)
    name = flavour + (f"-{args.epic.strip().upper()}" if args.epic else "") + ("-all" if state == "all" else "")
    folder = output_folder(host, studio, args.out, name)
    header, rows, cut_ids = build_rows(studio, plan, flavour)
    counts = {"epics": sum(1 for row in rows if row[1] == "Epic"), "stories": sum(1 for row in rows if row[1] == "Story")}
    csv_name = "mach-jira.csv"
    folder.mkdir(parents=True, exist_ok=True)
    host.write(folder / csv_name, csv_text(header, rows))
    host.write(folder / "README.txt", readme(flavour, header, counts, plan["left_out"], csv_name))
    exported = [unneutral(row[header.index(COLUMNS[flavour]["mach"])]) for row in rows]
    note = (f"Wrote {counts['epics']} epic(s) and {counts['stories']} story(ies) for Jira {'Cloud' if flavour == 'cloud' else 'Data Center'}. "
            "Nothing was sent anywhere: hand the folder to the person who imports it. README.txt says which screen to use and how to hand the keys back.")
    if not rows:
        note = "Nothing to export: " + ("no slice is marked ready yet (export with --state all to include drafts)." if state == "ready" else "the workspace has no epics.")
    return {"folder": str(folder), "file": str(folder / csv_name), "readme": str(folder / "README.txt"), "flavour": flavour, "state": state,
            "epic": args.epic.strip().upper() if args.epic else None, "counts": counts, "exported": exported, "left_out": plan["left_out"],
            "cut": cut_ids, "factory_authorized": False, "note": note}


# ---- the keys back ----

def read_keys_file(host: Any, given: str) -> Tuple[List[str], List[List[str]]]:
    path = Path(given).expanduser()
    if path.is_symlink() or not path.is_file():
        raise host.StudioError(f"{given[:200]} is not a file.")
    size = path.stat().st_size
    if size > KEYS_MAX_BYTES:
        raise host.StudioError(f"The file is {size} bytes; the most read is {KEYS_MAX_BYTES}. Export fewer columns or fewer rows from Jira.")
    try:
        text = path.read_bytes().decode("utf-8-sig")
    except UnicodeDecodeError:
        raise host.StudioError("The file is not UTF-8 text. Export it from Jira again as CSV.")
    rows: List[List[str]] = []
    try:
        for row in csv.reader(io.StringIO(text, newline="")):
            if len(row) > KEYS_MAX_COLUMNS:
                raise host.StudioError(f"A row has more than {KEYS_MAX_COLUMNS} columns. Export fewer columns from Jira.")
            rows.append(row)
            if len(rows) > KEYS_MAX_ROWS + 1:
                raise host.StudioError(f"The file has more than {KEYS_MAX_ROWS} rows. Export it from Jira in parts.")
    except csv.Error as exc:
        raise host.StudioError(f"The file is not a CSV file MACH can read ({str(exc)[:100]}).")
    if not rows:
        raise host.StudioError("The file is empty.")
    return rows[0], rows[1:]


def find_columns(host: Any, header: Sequence[str]) -> Dict[str, Any]:
    names = [unneutral(name).lower() for name in header]
    keys = [index for index, name in enumerate(names) if name in KEY_HEADERS]
    if not keys:
        raise host.StudioError("The file has no column of Jira keys (Issue key or Work item key). Export it from Jira with the key column.")
    ids = [index for index, name in enumerate(names) if name in ID_HEADERS]
    labels = [index for index, name in enumerate(names) if name in LABEL_HEADERS]
    if not ids and not labels:
        raise host.StudioError("The file has neither a MACH ID column nor a Labels column, so no row can be matched. Export it with the labels.")
    return {"key": keys[0], "ids": ids, "labels": labels}


def row_ids(row: Sequence[str], columns: Dict[str, Any]) -> List[str]:
    """The MACH IDs a row names: in the MACH ID column, else among its labels (one label may hold several, space-separated)."""
    cell = lambda index: unneutral(row[index]) if index < len(row) else ""
    found = [cell(index).upper() for index in columns["ids"] if MACH_ID_RE.fullmatch(cell(index).upper())]
    if not found:
        for index in columns["labels"]:
            found += [word.upper() for word in cell(index).split() if MACH_ID_RE.fullmatch(word.upper())]
    return sorted(set(found))


def cmd_keys(host: Any, studio: Any, args: argparse.Namespace) -> Dict[str, Any]:
    rules = host.ticket_rules()
    header, rows = read_keys_file(host, args.file)
    columns = find_columns(host, header)
    unmatched: List[Dict[str, Any]] = []
    refused: List[Dict[str, Any]] = []
    wanted: Dict[str, Dict[str, Any]] = {}
    for number, row in enumerate(rows, start=2):  # row 1 is the header
        if not any(value.strip() for value in row):
            continue
        key = unneutral(row[columns["key"]]) if columns["key"] < len(row) else ""
        ids = row_ids(row, columns)
        if not ids:
            unmatched.append({"row": number, "reason": "it names no MACH ID (no MACH ID column value and no SLICE- or EPIC- label)"})
            continue
        if len(ids) > 1:
            unmatched.append({"row": number, "reason": f"it names more than one MACH item ({', '.join(ids[:5])})"})
            continue
        if not rules.is_jira_key(key):
            refused.append({"row": number, "id": ids[0], "reason": "its key is not in Jira's form (such as ABC-123)"})
            continue
        entry = wanted.setdefault(ids[0], {"keys": set(), "rows": []})
        entry["keys"].add(key)
        entry["rows"].append(number)
    by_key: Dict[str, List[str]] = {}
    for mach_id, entry in wanted.items():
        for key in entry["keys"]:
            by_key.setdefault(key, []).append(mach_id)
    epics, slices = studio.all("epic"), studio.all("slice")
    linked: List[Dict[str, str]] = []
    already: List[Dict[str, str]] = []
    reopen: List[Dict[str, str]] = []
    epic_ready: Dict[str, List[str]] = {}
    for mach_id in sorted(wanted):
        keys, where = sorted(wanted[mach_id]["keys"]), wanted[mach_id]["rows"]
        if len(keys) > 1:
            refused.append({"id": mach_id, "rows": where, "reason": f"rows give it more than one key ({', '.join(keys)})"})
            continue
        key = keys[0]
        if len(by_key[key]) > 1:
            refused.append({"id": mach_id, "rows": where, "reason": f"{key} is given to more than one MACH item ({', '.join(sorted(by_key[key]))})"})
            continue
        kind = "epic" if mach_id.startswith("EPIC-") else "slice"
        data = (epics if kind == "epic" else slices).get(mach_id)
        if data is None:
            unmatched.append({"rows": where, "id": mach_id, "reason": f"there is no {kind} {mach_id} in this workspace"})
            continue
        current = own_key(rules, data)
        if current == key:
            already.append({"id": mach_id, "jira": key})
            continue
        if current is not None:
            refused.append({"id": mach_id, "rows": where, "reason": f"it is already linked to {current}; to change it, use {kind} link {mach_id} --jira {key}"})
            continue
        if kind == "slice" and host.edit_refusal(mach_id, data) is not None:
            reopen.append({"id": mach_id, "jira": key, "reason": f"{mach_id} is marked ready; reopen it, then run jira keys again (or slice link {mach_id} --jira {key})"})
            continue
        if not args.dry_run:
            if kind == "slice":
                host.link_slice(studio, mach_id, key)
            else:
                ready = host.link_epic(studio, mach_id, key)
                if ready:
                    epic_ready[mach_id] = ready
        linked.append({"id": mach_id, "jira": key})
    note = (("Would link " if args.dry_run else "Linked ") + f"{len(linked)} item(s); {len(already)} already had that key; "
            f"{len(reopen)} need reopening first; {len(unmatched)} row(s) not matched; {len(refused)} refused. Nothing was sent to Jira or GitHub.")
    if epic_ready:
        note += " Slices already marked ready carry an epic's new key only once each is reopened and marked ready again: " + \
                "; ".join(f"{epic}: {', '.join(names)}" for epic, names in sorted(epic_ready.items())) + "."
    return {"dry_run": bool(args.dry_run), "rows_read": len(rows), "linked": linked[:REPORT_LIMIT], "already_linked": already[:REPORT_LIMIT],
            "needs_reopening": reopen[:REPORT_LIMIT], "unmatched": unmatched[:REPORT_LIMIT], "refused": refused[:REPORT_LIMIT],
            "epics_with_ready_slices": epic_ready, "factory_authorized": False, "note": note}


# ---- wiring ----

def add_commands(sub: Any, host: Any) -> None:
    """The `jira` commands, wired into studio.py's parser. `host` is studio.py's own module."""
    def run(handler: Callable[[Any, Any, argparse.Namespace], Dict[str, Any]], prepare: bool) -> Callable[[Any, argparse.Namespace], int]:
        def call(studio: Any, args: argparse.Namespace) -> int:
            if prepare:
                studio.prepare()
            return host.emit(handler(host, studio, args))
        return call

    group = sub.add_parser("jira", help="a CSV file to import into Jira, and the Jira keys back; MACH never calls Jira").add_subparsers(
        dest="action", required=True, metavar="{export,keys}")
    p = group.add_parser("export", help="write a CSV file of epics and slices for Jira's importer, with a README (only on the product manager's word)")
    p.add_argument("--epic", help="only this epic and its slices")
    p.add_argument("--state", choices=STATES, default="ready", help="ready (default): slices marked ready or further; all: drafts too")
    p.add_argument("--out", help="the folder to write into: inside Product Studio's own folder, or outside the repository")
    p.add_argument("--flavour", choices=FLAVOURS, default="cloud", help="the Jira the file is for (default cloud)")
    p.set_defaults(func=run(cmd_export, prepare=True))
    p = group.add_parser("keys", help="record the Jira keys from a CSV exported from Jira after the import (only on the product manager's word)")
    p.add_argument("file")
    p.add_argument("--dry-run", action="store_true", help="say what would be linked; change nothing")
    p.set_defaults(func=run(cmd_keys, prepare=True))
