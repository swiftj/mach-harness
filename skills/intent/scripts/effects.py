#!/usr/bin/env python3
"""MACH effects on shipped behaviour: the one parser of a slice spec's `## Effects on shipped behaviour`.

M13 part B gives every slice spec a section that says what the slice does to behaviour that has already
shipped. Its grammar is fixed so the validator, the current-behaviour view (`run.py current`) and anything
later read the same thing; nothing else parses the section. The section holds either the single line

    None.

or one table:

    | Shipped rule | Effect | In this slice | Note |
    |---|---|---|---|
    | SLICE-003/FR-02 | kept | AC-04 | A returned item is not overdue. |
    | SLICE-003/R3 | replaced | FR-05 | |
    | SLICE-002/INV-01 | retired | | The product manager's reason. |

`Shipped rule` is `SLICE-NNN/` and an `INV-NN`, `FR-NN` or `RN` of that slice. `Effect` is `kept`, `changed`,
`replaced` or `retired`. `In this slice` is an `AC-NN` for `kept`, an `INV-NN`, `FR-NN` or `RN` for `changed` and
`replaced`, and empty for `retired`, which needs a `Note`.

Two pure functions, total over any text and any input: they never read a file, run Git, print or raise.

    parse(text)      -> {"present", "none", "line", "rows", "problems"}
    check(parsed, shipped, slice_id=None, own_ids=None) -> [problem, ...]

A problem is {"line": int, "code": str, "message": str}: the line in the spec it is about (0 when it is about the
whole spec), a short code a validator can use as its rule name, and plain words. `describe(problem)` gives
"line N: message". Notes are returned as written (trimmed); a caller that shows them bounds them and treats them
as data.

Standard library only. Loaded by path by the scripts that use it, whichever way MACH is installed.
"""

import re
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set

HEADING = "Effects on shipped behaviour"
COLUMNS = ("Shipped rule", "Effect", "In this slice", "Note")
EFFECTS = ("kept", "changed", "replaced", "retired")
NONE_LINE = "None."

SHIPPED_RULE_RE = re.compile(r"^(SLICE-[0-9]{3,})/(INV-[0-9]{2,}|FR-[0-9]{2,}|R[0-9]+)$")
RULE_ID_RE = re.compile(r"^(?:INV-[0-9]{2,}|FR-[0-9]{2,}|R[0-9]+)$")
SCENARIO_ID_RE = re.compile(r"^AC-[0-9]{2,}$")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
SEPARATOR_CELL_RE = re.compile(r"^:?-+:?$")
NEAR_HEADING_RE = re.compile(r"^effects\s+on\s+shipped\s+behaviou?r\b", re.IGNORECASE)
NEAR_NONE_RE = re.compile(r"^\**\s*none\s*\.?\s*\**$", re.IGNORECASE)


def problem(line: int, code: str, message: str) -> Dict[str, Any]:
    return {"line": line, "code": code, "message": message}


def describe(item: Mapping[str, Any]) -> str:
    """One problem as a line of plain text."""
    line = item.get("line")
    return f"line {line}: {item.get('message')}" if line else str(item.get("message"))


def split_row(line: str) -> List[str]:
    """A Markdown table row's cells, trimmed; `\\|` is a literal bar inside a cell."""
    text = line.strip()
    if text.startswith("|"):
        text = text[1:]
    if text.endswith("|") and not text.endswith("\\|"):
        text = text[:-1]
    return [cell.strip().replace("\\|", "|") for cell in re.split(r"(?<!\\)\|", text)]


def _section_lines(lines: Sequence[str], problems: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Find the section: its heading's line and its body (line number, text), outside code fences."""
    found: Optional[Dict[str, Any]] = None
    in_fence = False
    for number, raw in enumerate(lines, start=1):
        line = raw.rstrip()
        if FENCE_RE.match(line):
            in_fence = not in_fence
            if found is not None and found.get("open"):
                found["body"].append((number, line))
            continue
        heading = None if in_fence else HEADING_RE.match(line)
        if heading:
            level, title = len(heading.group(1)), heading.group(2).strip()
            if found is not None and found.get("open"):
                if level <= 2:
                    found["open"] = False
                else:
                    found["body"].append((number, line))
                    continue
            exact = title.lower() == HEADING.lower()
            if exact and level == 2:
                if found is None:
                    found = {"line": number, "body": [], "open": True}
                else:
                    problems.append(problem(number, "effects-duplicate",
                                            f"'## {HEADING}' appears more than once. A spec has one such section; the one on line {found['line']} is read."))
            elif exact or NEAR_HEADING_RE.match(title):
                problems.append(problem(number, "effects-heading",
                                        f"Write this heading exactly as '## {HEADING}' (a second-level heading, spelt 'behaviour'). "
                                        "As written it is not read, so the slice declares no effects."))
            continue
        if found is not None and found.get("open"):
            found["body"].append((number, line))
    return found


def _without_comments(body: Sequence[Any]) -> List[Any]:
    """The body with HTML comments taken out (template hints are the validator's to report, not part of the grammar)."""
    kept: List[Any] = []
    in_comment = False
    for number, line in body:
        text = line
        out = ""
        while text:
            if in_comment:
                end = text.find("-->")
                if end < 0:
                    text = ""
                    break
                text, in_comment = text[end + 3:], False
                continue
            start = text.find("<!--")
            if start < 0:
                out += text
                break
            out += text[:start]
            text, in_comment = text[start + 4:], True
        kept.append((number, out.rstrip()))
    return kept


def _row(number: int, cells: List[str], problems: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if len(cells) != len(COLUMNS):
        problems.append(problem(number, "effects-row",
                                f"This row has {len(cells)} cells. Each row has four: Shipped rule, Effect, In this slice, Note (leave a cell empty, never out)."))
        return None
    shipped, effect, here, note = cells
    good = True
    match = SHIPPED_RULE_RE.match(shipped)
    if not match:
        problems.append(problem(number, "effects-rule",
                                f"'{shipped[:80]}' is not a shipped rule. Write SLICE-NNN/ followed by an INV-NN, FR-NN or RN of that slice, such as SLICE-003/FR-02."))
        good = False
    if effect not in EFFECTS:
        problems.append(problem(number, "effects-unknown-effect",
                                f"'{effect[:40]}' is not an effect. Write one of: kept, changed, replaced, retired."))
        return None
    if effect == "kept":
        if not here:
            problems.append(problem(number, "effects-kept-scenario",
                                    "A kept row names the scenario in this slice (AC-NN) that proves the shipped rule still holds with this slice's data."))
            good = False
        elif not SCENARIO_ID_RE.match(here):
            problems.append(problem(number, "effects-wrong-id",
                                    f"A kept row names a scenario (AC-NN) in 'In this slice', not '{here[:40]}'."))
            good = False
    elif effect in ("changed", "replaced"):
        if not here:
            problems.append(problem(number, "effects-replacement",
                                    f"A {effect} row names the invariant, requirement or decision rule in this slice (INV-NN, FR-NN or RN) that takes the shipped rule's place."))
            good = False
        elif not RULE_ID_RE.match(here):
            problems.append(problem(number, "effects-wrong-id",
                                    f"A {effect} row names an INV-NN, FR-NN or RN of this slice in 'In this slice', not '{here[:40]}'."))
            good = False
    else:
        if here:
            problems.append(problem(number, "effects-wrong-id",
                                    f"A retired row leaves 'In this slice' empty (it has '{here[:40]}'); nothing in this slice takes the rule's place."))
            good = False
        if not note:
            problems.append(problem(number, "effects-retired-note",
                                    "A retired row needs a Note: the product manager's reason, in their words."))
            good = False
    if not good or not match:
        return None
    return {"line": number, "shipped_rule": shipped, "slice_id": match.group(1), "rule_id": match.group(2),
            "effect": effect, "in_slice": here or None, "note": note}


def parse(text: Any) -> Dict[str, Any]:
    """Read the section from a spec's text.

    Returns {"present": bool, "none": bool, "line": int | None, "rows": [row, ...], "problems": [problem, ...]}.
    `present` is whether the spec has the section at all (a spec from before M13 has none); `none` whether it is the
    single line `None.`. Each row is {"line", "shipped_rule", "slice_id", "rule_id", "effect", "in_slice", "note"}
    (`in_slice` is None for a retired row); only rows that are well formed are listed, and a duplicate shipped rule is
    reported but both rows stay listed. A section with any problem must not be applied.
    """
    result: Dict[str, Any] = {"present": False, "none": False, "line": None, "rows": [], "problems": []}
    problems: List[Dict[str, Any]] = result["problems"]
    if not isinstance(text, str):
        return result
    section = _section_lines(text.splitlines(), problems)
    if section is None:
        return result
    result["present"], result["line"] = True, section["line"]
    body = _without_comments(section["body"])

    none_lines: List[int] = []
    tables: List[List[Any]] = []
    previous_table = False
    in_fence = False
    for number, line in body:
        stripped = line.strip()
        if FENCE_RE.match(line):
            in_fence = not in_fence
            problems.append(problem(number, "effects-content", f"The section holds only '{NONE_LINE}' or one table; a code block is not read."))
            previous_table = False
            continue
        if in_fence:
            continue
        if not stripped:
            previous_table = False
            continue
        if HEADING_RE.match(stripped):
            problems.append(problem(number, "effects-content", f"The section holds only '{NONE_LINE}' or one table, with no headings inside it."))
            previous_table = False
            continue
        if stripped.startswith("|"):
            if not previous_table:
                tables.append([])
            tables[-1].append((number, stripped))
            previous_table = True
            continue
        previous_table = False
        if stripped == NONE_LINE:
            none_lines.append(number)
        elif NEAR_NONE_RE.match(stripped):
            problems.append(problem(number, "effects-none", f"Write exactly '{NONE_LINE}' (the word None and a full stop) when the slice changes no shipped behaviour."))
        else:
            problems.append(problem(number, "effects-content",
                                    f"The section holds only '{NONE_LINE}' or one table; this line is neither: '{stripped[:80]}'."))

    if len(none_lines) > 1:
        problems.append(problem(none_lines[1], "effects-none", f"'{NONE_LINE}' is written once."))
    if none_lines and tables:
        problems.append(problem(tables[0][0][0], "effects-none-and-table",
                                f"The section has both '{NONE_LINE}' and a table. Keep the table if the slice affects shipped behaviour, otherwise only '{NONE_LINE}'."))
    if len(tables) > 1:
        problems.append(problem(tables[1][0][0], "effects-tables", "The section holds one table. Put every row in the first table."))
    result["none"] = bool(none_lines) and not tables
    if not none_lines and not tables:
        if not problems or all(item["code"] in ("effects-heading", "effects-duplicate") for item in problems):
            problems.append(problem(section["line"], "effects-empty",
                                    f"The section is empty. Write '{NONE_LINE}' if the slice changes no shipped behaviour, otherwise the table. Silence is never read as no effects."))
        return result
    if not tables:
        return result

    rows = tables[0]
    header = [cell.lower() for cell in split_row(rows[0][1])]
    if header != [name.lower() for name in COLUMNS]:
        problems.append(problem(rows[0][0], "effects-header", "The table's header row is exactly: | " + " | ".join(COLUMNS) + " |"))
        return result
    if len(rows) < 2 or not all(SEPARATOR_CELL_RE.match(cell) for cell in split_row(rows[1][1])) or len(split_row(rows[1][1])) != len(COLUMNS):
        problems.append(problem(rows[min(1, len(rows) - 1)][0], "effects-separator", "The second table row is the separator: |---|---|---|---|"))
        return result
    if len(rows) < 3:
        problems.append(problem(rows[0][0], "effects-no-rows",
                                f"The table has no rows. Add one row per shipped rule this slice affects, or write '{NONE_LINE}' instead of the table."))
        return result
    seen: Dict[str, int] = {}
    for number, line in rows[2:]:
        row = _row(number, split_row(line), problems)
        if row is None:
            continue
        first = seen.get(row["shipped_rule"])
        if first is not None:
            problems.append(problem(number, "effects-duplicate-rule",
                                    f"{row['shipped_rule']} is already named on line {first}. Name each shipped rule once, with one effect."))
        else:
            seen[row["shipped_rule"]] = number
        result["rows"].append(row)
    return result


def _index(shipped: Any) -> Dict[str, Dict[str, Any]]:
    """The caller's shipped rules as {"SLICE-NNN/ID": info}. Accepts a mapping (rule -> info or None), or an iterable
    of rule strings or of dicts with a "rule" key (such as `run.py current --json`'s `rules`)."""
    found: Dict[str, Dict[str, Any]] = {}
    if isinstance(shipped, Mapping):
        items: Iterable[Any] = ((key, value) for key, value in shipped.items())
    else:
        items = []
        for entry in shipped or ():
            if isinstance(entry, str):
                items.append((entry, None))  # type: ignore[attr-defined]
            elif isinstance(entry, Mapping) and isinstance(entry.get("rule"), str):
                items.append((entry["rule"], entry))  # type: ignore[attr-defined]
    for key, value in items:
        if isinstance(key, str):
            found[key] = dict(value) if isinstance(value, Mapping) else {}
    return found


def _superseded_words(item: Any) -> str:
    """{"effect", "by", "slice_id"} (as `run.py current --json` gives it) or a plain string, as words."""
    if isinstance(item, Mapping):
        if item.get("effect") == "retired":
            return f"retired by {item.get('slice_id')}"
        return f"{item.get('effect') or 'replaced'} by {item.get('by')}"
    return str(item)


def check(parsed: Mapping[str, Any], shipped: Any, slice_id: Optional[str] = None,
          own_ids: Optional[Iterable[str]] = None, pending: Any = None) -> List[Dict[str, Any]]:
    """Problems with the parsed rows against what has shipped. Pure: the caller supplies everything.

    `shipped` is the set of shipped rules (see `_index` for the shapes taken). An entry whose info says
    "in_force": false is a rule a later slice replaced or retired; naming it is a problem that says what took its
    place (from "superseded_by": {"effect", "by", "slice_id"} entries, or plain strings). `slice_id` is this slice's own ID: a row may
    not name this slice's own rules. `own_ids` are the IDs this slice's spec holds (INV, FR, R and AC): the ID named
    in 'In this slice' must be one of them.

    `pending` (the same shapes as `shipped`): rules of slices that have not shipped yet but ship before this one, because
    this slice depends on them (M21: a project brought in from another repository, whose rules had shipped there). A row
    naming one that has not shipped is a problem with "severity": "warning" (code effects-ships-first) instead of an error:
    the row is checked against what shipped when this slice is built. Every other problem is an error, as before.
    """
    problems: List[Dict[str, Any]] = []
    known = _index(shipped)
    waiting = _index(pending) if pending is not None else {}
    slices: Set[str] = {key.split("/", 1)[0] for key in known}
    mine = set(own_ids) if own_ids is not None else None
    for row in parsed.get("rows") or []:
        rule, line = row.get("shipped_rule"), row.get("line") or 0
        if slice_id and row.get("slice_id") == slice_id:
            problems.append(problem(line, "effects-own-slice", f"{rule} is a rule of this slice. The section names rules of slices that have already shipped."))
            continue
        info = known.get(rule)
        if info is None and rule in waiting:
            first = waiting[rule].get("slice_id") or row.get("slice_id")
            problems.append(dict(problem(line, "effects-ships-first",
                                         f"{rule} has not shipped yet. {first} ships before this slice, which depends on it, so this row is "
                                         "checked again when this slice is built."), severity="warning"))
        elif info is None:
            if row.get("slice_id") in slices:
                problems.append(problem(line, "effects-not-shipped", f"{row.get('slice_id')} has no {row.get('rule_id')} in its shipped spec."))
            else:
                problems.append(problem(line, "effects-not-shipped", f"{rule} is not in any shipped spec: no spec of {row.get('slice_id')} has shipped."))
        elif info.get("in_force") is False:
            later = [_superseded_words(item) for item in info.get("superseded_by") or []]
            now = "; ".join(item for item in later if item) or "a later slice replaced or retired it"
            problems.append(problem(line, "effects-not-in-force",
                                    f"{rule} is no longer in force: {now}. Name the rule in force instead."))
        here = row.get("in_slice")
        if mine is not None and here and here not in mine:
            problems.append(problem(line, "effects-not-in-this-slice", f"{here} is not in this slice's spec."))
    return problems
