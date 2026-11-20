#!/usr/bin/env python3
"""MACH current behaviour: how each epic works today, compiled from the slice specs that have shipped.

Reached as `run.py current [--epic <EPIC-ID or issue number>] [--all] [--json] [--at <commit>]` (M13 part C).
It reads the slice specs under specs/slices/ from Git objects at one commit of the integration branch (a spec
is merged with its code, so a spec there has shipped), and lists per epic every invariant, requirement and
decision rule in force: every shipped rule, minus those a later shipped slice replaced or retired, with a changed
or replaced rule shown as the later slice's rule and a note of what it took the place of, and a kept rule shown
with the scenario that confirmed it. Each line names the slice it came from. No model writes any of it.

Where the pieces come from, all reused by loading, never copied:
    intake.py          the spec header (`> Epic: <name> (EPIC-NNN, issue #N). Slice issue: #N.`) and taking it off
    validate_slice.py  a spec's invariants, requirements, decision matrix rules and scenarios (its `analyze`)
    effects.py         the one parser of `## Effects on shipped behaviour`, and its check against shipped rules
    explain.py         bounding text for the terminal; issue_rules.py (ticket station) for text meant for GitHub

Rules of a slice with no effects section (shipped before M13) are listed under "Not yet reconciled" until a
later slice names them. A slice whose section has problems is listed with its problems and its effects are not
applied. Slices with no epic header are grouped under "No epic". Spec text is quoted bounded and as data.

"Later" is slice ID order (see `order`). Effects cross epics: both epics' views show them.

It reads only: no file is written, nothing is fetched, nothing under .factory/ is read, and it works with no cells.
Deterministic for a given commit: no clock, sorted output.

Functions other scripts call (pure unless noted):
    read_specs(root, commit)                 -> (specs, notes)     reads Git objects at the commit; nothing else
    compile_view(specs)                      -> {"epics", "rules", "conflicts", "notes"}
    report(root, commit, branch=..., epic=..., everything=..., on_branch=...) -> the command's whole answer
    epic_markdown(epic_view, commit, limit)  -> Markdown of one epic, at most `limit` characters
    human(report)                            -> the command's plain text

Standard library only. Imported by run.py; not a command of its own.
"""

import importlib.util
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

SCHEMA = "mach.current-behaviour"
SCHEMA_VERSION = 1
SPECS_DIR = "specs/slices/"
TEXT_LIMIT = 400  # one rule's text, as shown
NOTE_LIMIT = 300  # a row's note, as shown
NO_EPIC = "No epic"
KINDS = ("invariant", "requirement", "decision rule")
SLICE_ID_RE = re.compile(r"^SLICE-([0-9]{3,})$")
EPIC_ID_RE = re.compile(r"^EPIC-[0-9]{3,}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
AUTHORITY = ("Compiled from the slice specs on the integration branch at this commit. The specs are the authority; "
             "each line names the slice it came from. Spec text is quoted as data.")
UNRECONCILED_NOTE = "shipped before slices declared their effects; listed here until a later slice names them"

_LOADED: Dict[str, Any] = {}


class CurrentError(Exception):
    """A problem the caller can fix; run.py prints it as a refusal."""


# ---- the shared helpers, loaded by path whichever way MACH is installed ----

def _station_script(station: str, name: str) -> Path:
    skills = Path(__file__).resolve().parent.parent.parent
    for folder in (skills / f"mach-{station}", skills / station):
        if (folder / "scripts" / name).is_file():
            return folder / "scripts" / name
    raise CurrentError(f"The MACH {station} station's {name} is not installed beside this skill ({skills}).")


def _load(key: str, path: Path) -> Any:
    if key not in _LOADED:
        folder = str(path.parent)
        if folder not in sys.path:
            sys.path.insert(0, folder)  # validate_slice and issue_rules import nothing of their own, but keep siblings reachable
        spec = importlib.util.spec_from_file_location(key, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _LOADED[key] = module
    return _LOADED[key]


def effects_module() -> Any:
    return _load("mach_effects", _station_script("intent", "effects.py"))


def validator() -> Any:
    return _load("mach_validate_slice_for_current", _station_script("intent", "validate_slice.py"))


def intake_module() -> Any:
    return _load("mach_intake_for_current", Path(__file__).resolve().parent / "intake.py")


def explain_module() -> Any:
    return _load("mach_explain_for_current", Path(__file__).resolve().parent / "explain.py")


def issue_rules() -> Any:
    return _load("mach_issue_rules_for_current", _station_script("ticket", "issue_rules.py"))


def number(identifier: Any) -> int:
    match = re.search(r"(\d+)$", str(identifier or ""))
    return int(match.group(1)) if match else 0


def shown(text: Any, limit: int = TEXT_LIMIT) -> str:
    """Spec text for the terminal and JSON: control characters removed, one line, bounded."""
    return explain_module().clean(text, limit) or ""


# ---- reading the specs at one commit (Git objects only) ----

def _git(root: Path, *args: str, data: Optional[bytes] = None) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(root), capture_output=True, input=data)


def resolve_commit(root: Path, given: str) -> str:
    done = _git(root, "rev-parse", "--verify", "-q", f"{given}^{{commit}}")
    found = done.stdout.decode("utf-8", "replace").strip()
    if done.returncode != 0 or not COMMIT_RE.match(found):
        raise CurrentError(f"'{given[:80]}' is not a commit in this repository.")
    return found


def contains(root: Path, commit: str, tip: Optional[str]) -> bool:
    return bool(tip) and _git(root, "merge-base", "--is-ancestor", commit, str(tip)).returncode == 0


def read_specs(root: Path, commit: str) -> Tuple[Dict[str, Dict[str, Any]], List[str]]:
    """Every slice spec under specs/slices/ at the commit, read from Git objects, with the header taken off.

    Returns ({slice_id: {"path", "text", "epic_id", "epic_title", "epic_issue", "issue"}}, notes). A file whose name is
    not SLICE-NNN-name.md, a second file for one slice ID, and a file too large to read are left out with a note."""
    intake = intake_module()
    names = validator().FILENAME_RE
    listing = _git(root, "ls-tree", "-l", commit, "--", SPECS_DIR)
    specs: Dict[str, Dict[str, Any]] = {}
    notes: List[str] = []
    wanted: List[Tuple[str, str, str]] = []
    for raw in sorted(listing.stdout.decode("utf-8", "replace").splitlines()):
        meta, _, path = raw.partition("\t")
        parts = meta.split()
        if len(parts) != 4 or parts[1] != "blob":
            continue
        base = path.rsplit("/", 1)[-1]
        match = names.match(base)
        if not match:
            if base.endswith(".md"):
                notes.append(f"{path} is not named SLICE-NNN-name.md, so it is not read as a slice spec.")
            continue
        if parts[3].isdigit() and int(parts[3]) > intake.MAX_TEXT_BYTES:
            notes.append(f"{path} is larger than {intake.MAX_TEXT_BYTES} bytes and was not read.")
            continue
        if any(item[0] == match.group(1) for item in wanted):
            notes.append(f"{path} is a second spec for {match.group(1)}; only the first by name is read.")
            continue
        wanted.append((match.group(1), path, parts[2]))
    if not wanted:
        return specs, notes
    batch = _git(root, "cat-file", "--batch", data="".join(f"{blob}\n" for _, _, blob in wanted).encode())
    stream, offset = batch.stdout, 0
    for slice_id, path, blob in wanted:
        end = stream.find(b"\n", offset)
        head = stream[offset:end].decode("ascii", "replace").split() if end >= 0 else []
        if len(head) != 3 or head[1] != "blob" or not head[2].isdigit():
            notes.append(f"{path} could not be read from Git.")
            break
        size = int(head[2])
        data = stream[end + 1:end + 1 + size]
        offset = end + 1 + size + 1
        text, header = intake.without_header(data.decode("utf-8-sig", errors="replace").replace("\r\n", "\n"))
        specs[slice_id] = {
            "path": path, "text": text,
            "epic_id": header.group(2) if header else None,
            "epic_title": header.group(1) if header else None,
            "epic_issue": int(header.group(3)) if header and header.group(3) else None,
            "issue": int(header.group(4)) if header and header.group(4) else None,
        }
    return specs, notes


# ---- one spec's rules ----

def _matrix_text(rule: Dict[str, Any], conditions: List[Dict[str, Any]]) -> str:
    every = {item.get("name"): list(item.get("values") or []) for item in conditions}
    parts = []
    for name, values in (rule.get("conditions") or {}).items():
        if list(values) != every.get(name):
            parts.append(f"{name} {' or '.join(str(v) for v in values)}")
    text = (", ".join(parts) or "In every case") + f": {rule.get('expected_outcome') or ''}"
    side = str(rule.get("side_effects") or "").strip()
    if side and side.lower().rstrip(".") != "none":
        text += f" (side effects: {side})"
    return text


def spec_rules(slice_id: str, path: str, text: str) -> Dict[str, Any]:
    """A spec's title, rules and scenario IDs, through the validator's own reading of a spec."""
    try:
        _, model = validator().analyze(text, path.rsplit("/", 1)[-1])
    except Exception:  # the validator is total in practice; a spec it cannot read still shows as a slice
        model = {}
    rules: List[Dict[str, Any]] = []
    for item in model.get("invariants") or []:
        rules.append({"id": item.get("id"), "kind": "invariant", "text": item.get("text")})
    for item in model.get("functional_requirements") or []:
        rules.append({"id": item.get("id"), "kind": "requirement", "text": item.get("text")})
    matrix = model.get("decision_matrix")
    notes = []
    if isinstance(matrix, dict):
        for item in matrix.get("rules") or []:
            rules.append({"id": item.get("id"), "kind": "decision rule", "text": _matrix_text(item, matrix.get("conditions") or [])})
    elif "Decision matrix" in text:
        notes.append("Its decision matrix could not be read, so its decision rules are not listed.")
    rules = [rule for rule in rules if isinstance(rule.get("id"), str)]
    scenarios = [item.get("id") for item in model.get("scenarios") or [] if isinstance(item.get("id"), str)]
    return {"title": model.get("title") or None, "rules": rules, "scenarios": scenarios, "notes": notes}


# ---- compiling ----

def order(slice_ids: Sequence[str]) -> List[str]:
    """Which shipped slice is later: slice ID order.

    Chosen over the order the specs landed on the integration branch: landing order would need a walk of history,
    and it is not reliable (squash and rebase merges, specs added in bulk, a spec rewritten after it landed). The
    effect rows already carry the direction that matters, since a slice can only name a rule that shipped before it
    was written; ID order decides only when two slices act on the same rule, and every such case is listed as a
    conflict for a person to read."""
    return sorted(slice_ids, key=lambda sid: (number(sid), sid))


def _rule_key(slice_id: str, rule_id: str) -> str:
    return f"{slice_id}/{rule_id}"


def _sort_rules(keys: Sequence[str], records: Dict[str, Dict[str, Any]]) -> List[str]:
    def key(item: str) -> Tuple[int, str, int, int, str]:
        record = records[item]
        kind = KINDS.index(record["kind"]) if record["kind"] in KINDS else len(KINDS)
        return (number(record["slice_id"]), record["slice_id"], kind, number(record["id"]), record["id"])
    return sorted(keys, key=key)


def compile_view(specs: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Pure over the specs given (as `read_specs` returns them): every epic's rules in force, and every shipped rule.

    Returns {"epics": [epic view, ...], "rules": [rule, ...], "conflicts": [...], "notes": []}. The epics are in
    EPIC ID order with "No epic" last; see `epic view` in docs/mach-next/M13_CURRENT_VIEW.md for the fields."""
    E = effects_module()
    slices: Dict[str, Dict[str, Any]] = {}
    records: Dict[str, Dict[str, Any]] = {}
    for slice_id in order(list(specs)):
        spec = specs[slice_id]
        read = spec_rules(slice_id, str(spec.get("path") or f"{slice_id}.md"), str(spec.get("text") or ""))
        slices[slice_id] = {"slice_id": slice_id, "title": shown(read["title"], 200) if read["title"] else None,
                            "issue": spec.get("issue"), "path": spec.get("path"), "epic_id": spec.get("epic_id"),
                            "epic_title": spec.get("epic_title"), "epic_issue": spec.get("epic_issue"),
                            "effects": None, "problems": [], "notes": list(read["notes"]),
                            "_own": {rule["id"] for rule in read["rules"]} | set(read["scenarios"]),
                            "_parsed": E.parse(spec.get("text") or "")}
        for rule in read["rules"]:
            key = _rule_key(slice_id, rule["id"])
            if key in records:
                continue  # the validator reports a duplicate ID; the first is read
            records[key] = {"rule": key, "slice_id": slice_id, "id": rule["id"], "kind": rule["kind"], "text": shown(rule["text"]),
                            "epic_id": spec.get("epic_id"), "confirmed_by": [], "takes_the_place_of": [], "superseded_by": [], "named": False}

    known = set(records)
    for slice_id, item in slices.items():
        parsed = item["_parsed"]
        problems = list(parsed["problems"]) + E.check(parsed, known, slice_id=slice_id, own_ids=item["_own"])
        item["problems"] = [{"line": p["line"], "code": p["code"], "message": shown(p["message"])} for p in sorted(problems, key=lambda p: (p["line"], p["code"]))]
        item["effects"] = ("problems" if problems else "missing" if not parsed["present"] else "none" if parsed["none"] else "declared")

    conflicts: List[Dict[str, Any]] = []
    for slice_id in order(list(slices)):
        item = slices[slice_id]
        if item["effects"] != "declared":
            continue
        for row in item["_parsed"]["rows"]:
            target = records[row["shipped_rule"]]
            note = shown(row.get("note"), NOTE_LIMIT) or None
            if target["superseded_by"]:
                earlier = ", ".join(sorted({entry["slice_id"] for entry in target["superseded_by"]}, key=number))
                conflicts.append({"rule": target["rule"], "slices": sorted({slice_id, *(e["slice_id"] for e in target["superseded_by"])}, key=number),
                                  "epics": sorted({str(target["epic_id"] or ""), str(item["epic_id"] or ""), *(str(e["epic_id"] or "") for e in target["superseded_by"])}),
                                  "text": f"{slice_id} says {target['rule']} is {row['effect']}, but {earlier} already replaced or retired it."})
                if row["effect"] == "kept":
                    continue
            target["named"] = True
            if row["effect"] == "kept":
                target["confirmed_by"].append({"slice_id": slice_id, "scenario": row["in_slice"], "note": note})
            elif row["effect"] == "retired":
                target["superseded_by"].append({"effect": "retired", "by": None, "slice_id": slice_id, "epic_id": item["epic_id"], "note": note})
            else:
                replacement = records[_rule_key(slice_id, row["in_slice"])]
                target["superseded_by"].append({"effect": row["effect"], "by": replacement["rule"], "slice_id": slice_id, "epic_id": item["epic_id"], "note": note})
                replacement["takes_the_place_of"].append({"effect": row["effect"], "rule": target["rule"], "epic_id": target["epic_id"], "note": note})

    def in_force(key: str) -> bool:
        return not records[key]["superseded_by"]

    def now(key: str) -> List[str]:
        """The rules in force that a superseded rule's place passed to, following the chain; empty when it ends retired."""
        found: List[str] = []
        seen = {key}
        queue = [entry["by"] for entry in records[key]["superseded_by"] if entry.get("by")]
        while queue:
            step = queue.pop(0)
            if step in seen:
                continue
            seen.add(step)
            if in_force(step):
                found.append(step)
            else:
                queue.extend(entry["by"] for entry in records[step]["superseded_by"] if entry.get("by"))
        return _sort_rules(found, records)

    def lineage(key: str) -> List[str]:
        """Every older rule this rule's place came down from, nearest first."""
        found: List[str] = []
        seen = {key}
        queue = [entry["rule"] for entry in records[key]["takes_the_place_of"]]
        while queue:
            step = queue.pop(0)
            if step in seen:
                continue
            seen.add(step)
            found.append(step)
            queue.extend(entry["rule"] for entry in records[step]["takes_the_place_of"])
        return found

    def entry(key: str) -> Dict[str, Any]:
        record = records[key]
        out = {name: record[name] for name in ("rule", "slice_id", "id", "kind", "text", "epic_id")}
        out["confirmed_by"] = list(record["confirmed_by"])
        out["takes_the_place_of"] = list(record["takes_the_place_of"])
        older = lineage(key)
        out["lineage"] = older if len(older) > len(record["takes_the_place_of"]) else []
        return out

    def gone(key: str) -> Dict[str, Any]:
        record = records[key]
        out = {name: record[name] for name in ("rule", "slice_id", "id", "kind", "text", "epic_id")}
        out["superseded_by"] = list(record["superseded_by"])
        out["now"] = [{"rule": rule, "slice_id": records[rule]["slice_id"], "epic_id": records[rule]["epic_id"], "text": records[rule]["text"]} for rule in now(key)]
        return out

    groups: Dict[Optional[str], List[str]] = {}
    for slice_id in order(list(slices)):
        groups.setdefault(slices[slice_id]["epic_id"], []).append(slice_id)
    epic_keys = sorted((key for key in groups if key), key=lambda key: (number(key), key)) + ([None] if None in groups else [])
    epics: List[Dict[str, Any]] = []
    for epic_id in epic_keys:
        members = groups[epic_id]
        titled = [sid for sid in members if slices[sid]["epic_title"]]
        latest = titled[-1] if titled else None
        keys = _sort_rules([key for key, record in records.items() if record["slice_id"] in members], records)
        unreconciled = [key for key in keys if in_force(key) and slices[records[key]["slice_id"]]["effects"] == "missing" and not records[key]["named"]]
        epics.append({
            "epic_id": epic_id,
            "title": shown(slices[latest]["epic_title"], 200) if latest else (None if epic_id else NO_EPIC),
            "issue": next((slices[sid]["epic_issue"] for sid in reversed(members) if slices[sid]["epic_issue"]), None),
            "slices": [{name: slices[sid][name] for name in ("slice_id", "title", "issue", "path", "effects", "notes")} for sid in members],
            "in_force": [entry(key) for key in keys if in_force(key) and key not in unreconciled],
            "not_yet_reconciled": [entry(key) for key in unreconciled],
            "no_longer_in_force": [gone(key) for key in keys if not in_force(key)],
            "not_applied": [{"slice_id": sid, "problems": slices[sid]["problems"]} for sid in members if slices[sid]["effects"] == "problems"],
            "conflicts": [item["text"] for item in conflicts if (epic_id or "") in item["epics"]],
        })

    rules = []
    for key in _sort_rules(list(records), records):
        record = records[key]
        rules.append({"rule": key, "slice_id": record["slice_id"], "id": record["id"], "kind": record["kind"], "epic_id": record["epic_id"],
                      "in_force": in_force(key),
                      "reconciled": not (slices[record["slice_id"]]["effects"] == "missing" and not record["named"]),
                      "superseded_by": [{"effect": e["effect"], "by": e["by"], "slice_id": e["slice_id"]} for e in record["superseded_by"]]})
    return {"epics": epics, "rules": rules, "conflicts": [item["text"] for item in conflicts], "notes": []}


def summary(epic: Dict[str, Any]) -> Dict[str, Any]:
    return {"epic_id": epic["epic_id"], "title": epic["title"], "issue": epic["issue"], "slices": len(epic["slices"]),
            "in_force": len(epic["in_force"]), "not_yet_reconciled": len(epic["not_yet_reconciled"]),
            "no_longer_in_force": len(epic["no_longer_in_force"]), "not_applied": len(epic["not_applied"]), "conflicts": len(epic["conflicts"])}


def matches(epic: Dict[str, Any], wanted: str) -> bool:
    given = wanted.strip().lstrip("#")
    if given.upper() == NO_EPIC.upper().replace(" ", "-") or given.lower() == NO_EPIC.lower():
        return epic["epic_id"] is None
    if EPIC_ID_RE.match(given.upper()):
        return epic["epic_id"] == given.upper()
    return given.isdigit() and epic["issue"] == int(given)


def report(root: Path, commit: str, *, branch: Optional[str] = None, epic: Optional[str] = None, everything: bool = False,
           on_branch: bool = True) -> Dict[str, Any]:
    """The command's whole answer for one commit. Reads Git objects; writes nothing.

    With `epic` (an EPIC-ID, an epic issue number, or "No epic"), that epic's full view; with `everything`, every epic's;
    otherwise one summary line per epic. `rules` is always every shipped rule, whatever is selected."""
    specs, notes = read_specs(root, commit)
    view = compile_view(specs)
    selected = view["epics"]
    if epic:
        selected = [item for item in selected if matches(item, epic)]
        if not selected:
            notes.append(f"No shipped slice spec at this commit names the epic '{shown(epic, 40)}'.")
    out: Dict[str, Any] = {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "commit": commit, "branch": branch, "on_integration_branch": on_branch,
        "authority": AUTHORITY, "order": "slice ID order decides which shipped slice is later",
        "slices": len(specs), "selection": "epic" if epic else "all" if everything else "index",
        "epics": selected if (epic or everything) else [summary(item) for item in selected],
        "rules": view["rules"], "notes": notes + view["notes"],
    }
    if not on_branch:
        out["notes"].append(f"This commit is not on the integration branch{' ' + repr(branch) if branch else ''}; the view describes it as asked.")
    if not specs:
        out["notes"].append(f"There are no slice specs under {SPECS_DIR} at this commit.")
    return out


# ---- plain text, in the terse style of `run.py explain` ----

def _epic_name(epic: Dict[str, Any]) -> str:
    if not epic["epic_id"]:
        return NO_EPIC
    name = f"{epic['epic_id']}"
    if epic.get("title"):
        name += f" {epic['title']}"
    if epic.get("issue"):
        name += f" (issue #{epic['issue']})"
    return name


def _where(epic_id: Optional[str], home: Optional[str]) -> str:
    return "" if epic_id == home else f" ({epic_id or NO_EPIC})"


def _rule_lines(item: Dict[str, Any], home: Optional[str]) -> List[str]:
    lines = [f"- {item['rule']} [{item['kind']}] \"{item['text']}\""]
    for place in item.get("takes_the_place_of") or []:
        verb = "changes" if place["effect"] == "changed" else "replaces"
        lines.append(f"    {verb} {place['rule']}{_where(place.get('epic_id'), home)}")
    if item.get("lineage"):
        lines.append(f"    earlier forms: {', '.join(item['lineage'])}")
    for confirmed in item.get("confirmed_by") or []:
        lines.append(f"    confirmed by {confirmed['slice_id']} {confirmed['scenario']}")
    return lines


def _gone_line(item: Dict[str, Any], home: Optional[str]) -> List[str]:
    parts = []
    for by in item["superseded_by"]:
        if by["effect"] == "retired":
            parts.append(f"retired by {by['slice_id']}{_where(by.get('epic_id'), home)}" + (f": \"{by['note']}\"" if by.get("note") else ""))
        else:
            parts.append(f"{by['effect']} by {by['by']}{_where(by.get('epic_id'), home)}")
    line = f"- {item['rule']} [{item['kind']}]: " + "; ".join(parts)
    later = [rule["rule"] for rule in item["now"] if not any(rule["rule"] == by.get("by") for by in item["superseded_by"])]
    if later:
        line += f"; in force now: {', '.join(later)}"
    return [line]


def epic_text(epic: Dict[str, Any]) -> List[str]:
    home = epic["epic_id"]
    lines = [f"{_epic_name(epic)}: {len(epic['slices'])} slice(s): " + ", ".join(item["slice_id"] for item in epic["slices"])]
    sections = (("In force", epic["in_force"], _rule_lines),
                (f"Not yet reconciled ({UNRECONCILED_NOTE})", epic["not_yet_reconciled"], _rule_lines),
                ("No longer in force", epic["no_longer_in_force"], _gone_line))
    for title, items, render in sections:
        if items:
            lines.append(f"{title}:")
            for item in items:
                lines.extend(render(item, home))
    if epic["not_applied"]:
        lines.append("Effects not applied (the section has problems):")
        for item in epic["not_applied"]:
            for found in item["problems"]:
                lines.append(f"- {item['slice_id']} line {found['line']}: {found['message']}")
    if epic["conflicts"]:
        lines.append("Conflicts (a later slice acted on a rule already replaced or retired):")
        lines.extend(f"- {text}" for text in epic["conflicts"])
    for item in epic["slices"]:
        for note in item.get("notes") or []:
            lines.append(f"- {item['slice_id']}: {note}")
    if not (epic["in_force"] or epic["not_yet_reconciled"] or epic["no_longer_in_force"]):
        lines.append("No rules.")
    return lines


def human(result: Dict[str, Any]) -> str:
    lines = [f"Current behaviour at {result.get('branch') or 'commit'} {result['commit'][:12]}. {AUTHORITY}"]
    for note in result.get("notes") or []:
        lines.append(f"Note: {note}")
    if result["selection"] == "index":
        if result["epics"]:
            lines.append("")
        for item in result["epics"]:
            counts = f"{item['slices']} slice(s), {item['in_force']} rule(s) in force"
            if item["not_yet_reconciled"]:
                counts += f", {item['not_yet_reconciled']} not yet reconciled"
            if item["not_applied"]:
                counts += f", {item['not_applied']} slice(s) whose effects were not applied"
            if item["conflicts"]:
                counts += f", {item['conflicts']} conflict(s)"
            lines.append(f"- {_epic_name(item)}: {counts}")
        if result["epics"]:
            lines.append("One epic: --epic <EPIC-ID or issue number>. Every epic in full: --all.")
    else:
        for epic in result["epics"]:
            lines.append("")
            lines.extend(epic_text(epic))
    return "\n".join(lines)


# ---- Markdown of one epic, bounded, for a GitHub comment someone else writes ----

def _md(text: Any, limit: int = TEXT_LIMIT) -> str:
    """Spec text made inert for GitHub: cleaned, redacted and bounded, no mention or issue reference that notifies or
    links (issue_rules.quiet), and no Markdown or HTML it could start."""
    quiet = issue_rules().quiet(text, limit)
    quiet = quiet.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return re.sub(r"([\\`*_\[\]|#~])", r"\\\1", " ".join(quiet.split()))


def epic_markdown(epic: Dict[str, Any], commit: str, limit: int = 65536) -> str:
    """One epic's full view (an entry of `report(..., epic=...)["epics"]`) as Markdown of at most `limit` characters.

    It carries the commit it describes. When the view does not fit, whole lines are dropped from the end and a plain
    note says it was cut and how to see all of it; the note always fits. No hidden marker is added: a caller that adds
    one passes a `limit` that leaves room for it."""
    home = epic["epic_id"]
    name = _md(_epic_name(epic), 300)
    head = [f"### How {name} works today", "",
            f"Compiled from the shipped slice specs at commit `{commit[:40]}`. The specs are the authority; each line names the slice it came from.", ""]
    body: List[str] = []

    def section(title: str, items: List[str]) -> None:
        if items:
            body.extend([f"**{title}**", "", *items, ""])

    def rule_md(item: Dict[str, Any]) -> str:
        line = f"- `{item['rule']}` ({item['kind']}): {_md(item['text'])}"
        for place in item.get("takes_the_place_of") or []:
            line += f" ({'changes' if place['effect'] == 'changed' else 'replaces'} `{place['rule']}`{_where(place.get('epic_id'), home)})"
        for confirmed in item.get("confirmed_by") or []:
            line += f" (confirmed by {confirmed['slice_id']} {confirmed['scenario']})"
        return line

    def gone_md(item: Dict[str, Any]) -> str:
        parts = []
        for by in item["superseded_by"]:
            parts.append(f"retired by {by['slice_id']}{_where(by.get('epic_id'), home)}" if by["effect"] == "retired"
                         else f"{by['effect']} by `{by['by']}`{_where(by.get('epic_id'), home)}")
        return f"- `{item['rule']}` ({item['kind']}): " + "; ".join(parts)

    section("In force", [rule_md(item) for item in epic["in_force"]])
    section(f"Not yet reconciled ({UNRECONCILED_NOTE})", [rule_md(item) for item in epic["not_yet_reconciled"]])
    section("No longer in force", [gone_md(item) for item in epic["no_longer_in_force"]])
    section("Effects not applied (the section has problems)",
            [f"- {item['slice_id']} line {found['line']}: {_md(found['message'], 300)}" for item in epic["not_applied"] for found in item["problems"]])
    section("Conflicts", [f"- {_md(text, 300)}" for text in epic["conflicts"]])
    if not body:
        body = ["No rules.", ""]

    whole = "\n".join(head + body).rstrip() + "\n"
    if len(whole) <= limit:
        return whole
    target = epic["epic_id"] or "No epic"
    note = f"\n_This view was cut to fit. Run `/mach current {target}` for all of it._\n"
    kept = list(head)
    for line in body:
        if len("\n".join(kept + [line]).rstrip()) + 1 + len(note) > limit:
            break
        kept.append(line)
    text = "\n".join(kept).rstrip() + "\n" + note
    return text[:limit] if len(text) > limit else text
