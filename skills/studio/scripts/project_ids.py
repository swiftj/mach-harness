#!/usr/bin/env python3
"""MACH Product Studio, M21 piece B: the reference rewriter for moving a project by archive.

Pure functions, standard library only, no file or network access. Given a map from the archive's IDs to the
destination's (`numbering`), they rewrite every place an ID appears (docs/mach-next/M21_EXPORT_IMPORT.md, section 5):

    numbering(incoming, first_free)            old ID -> new ID for every incoming ID (4.3)
    ids_in_text(text)                          every ID-shaped token: (line, ID, inside code)
    rewrite_text(text, mapping)                the text with each token replaced, and notes for a person to check
    rewrite_record(kind, record, mapping, project_id)    a new record with its ID fields and text fields rewritten (5.1)
    rewrite_record_noted(...)                  the same, with the notes of its text and ID fields
    rename(relative, mapping)                  a draft-relative path with its ID part renamed

The token rule (5.2): a token is a prefix (SLICE, EPIC or IDEA with three or more digits; PP, TN, PRD or DES with two or
more), not preceded by a word character (a letter or digit of any script, or `_`) or `-`, and not followed by a word
character. The whole token is looked up in the map; one pass replaces every token at once, so no replacement is looked
at again. Tokens inside fenced code blocks and inline code spans are left as written and noted (`in_code`); a token the
map does not hold is left as written and noted (`not_in_archive`).

The fence and inline-code patterns are copies of skills/intent/scripts/validate_slice.py's FENCE_RE and INLINE_CODE_RE,
which stay authoritative (a test asserts they are equal).
"""

import copy
import re
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

# The seven kinds an archive numbers, each with its width (4.3). A number that outgrows the width is written in full.
PREFIXES = {"SLICE": 3, "EPIC": 3, "IDEA": 3, "PP": 2, "TN": 2, "PRD": 2, "DES": 2}

# Copies of validate_slice.FENCE_RE and INLINE_CODE_RE (the validator's own; test_project_ids asserts they are equal).
FENCE_RE = re.compile(r"^\s*(```|~~~)")
INLINE_CODE_RE = re.compile(r"`[^`]*`")

# The token rule, in one pattern. Group "kind" is the prefix, "number" its digits.
TOKEN_RE = re.compile(r"(?<![\w-])(?P<kind>SLICE|EPIC|IDEA|PP|TN|PRD|DES)-(?P<number>[0-9]+)(?!\w)")
ID_RE = re.compile(r"^(?P<kind>SLICE|EPIC|IDEA|PP|TN|PRD|DES)-(?P<number>[0-9]+)$")
PROJECT_RE = re.compile(r"^[a-z][a-z0-9-]{1,63}$")  # product.PROJECT_RE, which stays authoritative

RECORD_KINDS = ("project", "epic", "slice", "principles", "needs", "idea", "lookups", "idea_map", "prd_map", "prd_answers",
                "prd_meta", "design_meta", "design_map")

Note = Dict[str, Any]


def _split(ident: Any) -> Optional[Tuple[str, str]]:
    """(prefix, digits) of an ID of one of the seven kinds with at least its kind's width of digits, else None."""
    match = ID_RE.fullmatch(ident) if isinstance(ident, str) else None
    if not match or len(match.group("number")) < PREFIXES[match.group("kind")]:
        return None
    return match.group("kind"), match.group("number")


def _token_kind(match: "re.Match[str]") -> Optional[str]:
    kind = match.group("kind")
    return kind if len(match.group("number")) >= PREFIXES[kind] else None


def _check_mapping(mapping: Mapping[str, str]) -> None:
    """A map is old ID -> new ID of the same kind, one to one. Anything else is a caller's mistake, refused."""
    seen: Dict[str, str] = {}
    for old, new in mapping.items():
        old_parts, new_parts = _split(old), _split(new)
        if old_parts is None or new_parts is None or old_parts[0] != new_parts[0]:
            raise ValueError(f"the map takes an ID to an ID of the same kind: {old!r} -> {new!r}")
        if new in seen:
            raise ValueError(f"the map gives {new} to both {seen[new]} and {old}")
        seen[new] = old


# ---- numbering (4.3) ----


def _format(kind: str, number: int) -> str:
    return f"{kind}-{number:0{PREFIXES[kind]}d}"


def numbering(incoming: Mapping[str, Iterable[str]], first_free: Mapping[str, Optional[int]]) -> Dict[str, str]:
    """Old ID -> new ID for every incoming ID. For each kind, the incoming IDs sorted by number (not by text) get
    first_free[kind], first_free[kind] + 1, ... (gaps between them are closed); a kind whose first_free is None keeps its
    IDs. A kind with incoming IDs and no entry in first_free is refused, never guessed."""
    out: Dict[str, str] = {}
    for kind, idents in incoming.items():
        if kind not in PREFIXES:
            raise ValueError(f"{kind!r} is not a kind an archive numbers")
        found = sorted(set(idents), key=lambda ident: (_number_of(kind, ident), len(ident), ident))
        if not found:
            continue
        if kind not in first_free:
            raise ValueError(f"no first free number given for {kind}")
        first = first_free[kind]
        if first is None:
            out.update({ident: ident for ident in found})
            continue
        if type(first) is not int or first < 1:
            raise ValueError(f"the first free number for {kind} is a positive integer, not {first!r}")
        out.update({ident: _format(kind, first + index) for index, ident in enumerate(found)})
    return out


def _number_of(kind: str, ident: Any) -> int:
    parts = _split(ident)
    if parts is None or parts[0] != kind:
        raise ValueError(f"{ident!r} is not a {kind} ID")
    return int(parts[1])


# ---- text (5.2) ----


def _lines(text: str) -> List[Tuple[str, str]]:
    """The text as (content, line ending) pairs, split where validate_slice splits (str.splitlines); joined back they are
    the text, character for character."""
    out = []
    for piece in text.splitlines(keepends=True):
        content = (piece.splitlines() or [""])[0]
        out.append((content, piece[len(content):]))
    return out


def _backtick_spans(line: str) -> List[Tuple[int, int]]:
    """Code spans as CommonMark reads them on one line: a run of n backticks up to the next run of exactly n."""
    spans, i, n = [], 0, len(line)
    while i < n:
        if line[i] != "`":
            i += 1
            continue
        j = i
        while j < n and line[j] == "`":
            j += 1
        width, k, closed = j - i, j, None
        while k < n:
            if line[k] != "`":
                k += 1
                continue
            m = k
            while m < n and line[m] == "`":
                m += 1
            if m - k == width:
                closed = m
                break
            k = m
        if closed is None:
            i = j
        else:
            spans.append((i, closed))
            i = closed
    return spans


def _code_spans(line: str) -> List[Tuple[int, int]]:
    """Inline code on one line: the validator's spans and CommonMark's, together, so a token either reads as code is code."""
    return [m.span() for m in INLINE_CODE_RE.finditer(line)] + _backtick_spans(line)


def _scan(text: str) -> List[Tuple[int, int, int, "re.Match[str]", bool]]:
    """Every token: (line index, start in the whole text, end, match, inside code)."""
    found = []
    offset, in_fence = 0, False
    for index, (content, ending) in enumerate(_lines(text)):
        fence_line = bool(FENCE_RE.match(content.rstrip()))
        code_line = in_fence or fence_line
        if fence_line:
            in_fence = not in_fence
        spans = [] if code_line else _code_spans(content)
        for match in TOKEN_RE.finditer(content):
            if _token_kind(match) is None:
                continue
            start, end = match.span()
            inside = code_line or any(a < end and start < b for a, b in spans)
            found.append((index, offset + start, offset + end, match, inside))
        offset += len(content) + len(ending)
    return found


def ids_in_text(text: str) -> List[Tuple[int, str, bool]]:
    """Every ID-shaped token in the text, in order: (line, from 1; the ID; whether it is inside code)."""
    return [(index + 1, match.group(0), inside) for index, _, _, match, inside in _scan(text)]


def _rewrite(text: str, mapping: Mapping[str, str]) -> Tuple[str, List[Note]]:
    notes: List[Note] = []
    pieces: List[str] = []
    last = 0
    for index, start, end, match, inside in _scan(text):
        ident = match.group(0)
        if inside:
            if mapping.get(ident) != ident:  # left as written; a person checks it unless the map keeps it as it is
                notes.append({"line": index + 1, "id": ident, "why": "in_code"})
            continue
        if ident not in mapping:
            notes.append({"line": index + 1, "id": ident, "why": "not_in_archive"})
            continue
        if mapping[ident] != ident:
            pieces.append(text[last:start])
            pieces.append(mapping[ident])
            last = end
    if not pieces:
        return text, notes
    pieces.append(text[last:])
    return "".join(pieces), notes


def rewrite_text(text: str, mapping: Mapping[str, str]) -> Tuple[str, List[Dict[str, Any]]]:
    """The text with every token outside code replaced by the map's, all at once, and the notes:
    {line, id, why: "in_code" | "not_in_archive"}. Everything else, line endings included, is as it was."""
    if not isinstance(text, str):
        raise TypeError("rewrite_text takes text")
    _check_mapping(mapping)
    return _rewrite(text, mapping)


# ---- records (5.1) ----


class _Pass:
    """One record's rewrite: the map, the notes gathered, and the helpers each record kind uses."""

    def __init__(self, mapping: Mapping[str, str]):
        self.mapping = mapping
        self.notes: List[Note] = []

    def ident(self, value: Any, kinds: Sequence[str], field: str) -> Any:
        """An ID field, rewritten by exact value when it is an ID of one of `kinds`; anything else is left as it is."""
        parts = _split(value)
        if parts is None or parts[0] not in kinds:
            return value
        if value not in self.mapping:
            self.notes.append({"field": field, "line": None, "id": value, "why": "not_in_archive"})
            return value
        return self.mapping[value]

    def rule(self, value: Any, field: str) -> Any:
        """A shipped rule SLICE-NNN/FR-NN: the slice part rewritten, the rule part kept."""
        if not isinstance(value, str) or "/" not in value:
            return value
        head, tail = value.split("/", 1)
        new = self.ident(head, ("SLICE",), field)
        return value if new is head else f"{new}/{tail}"

    def text(self, value: Any, field: str) -> Any:
        if not isinstance(value, str):
            return value
        out, notes = _rewrite(value, self.mapping)
        self.notes.extend({"field": field, **note} for note in notes)
        return out

    def at(self, record: Dict[str, Any], key: str, rewrite: Callable[[Any, str], Any], field: Optional[str] = None) -> None:
        if isinstance(record, dict) and key in record:
            record[key] = rewrite(record[key], field or key)

    def each(self, record: Dict[str, Any], key: str, rewrite: Callable[[Any, str], Any], field: Optional[str] = None) -> None:
        items = record.get(key) if isinstance(record, dict) else None
        if isinstance(items, list):
            record[key] = [rewrite(item, f"{field or key}[{n}]") for n, item in enumerate(items)]

    def ids(self, kinds: Sequence[str]) -> Callable[[Any, str], Any]:
        return lambda value, field: self.ident(value, kinds, field)

    def anything(self, value: Any, field: str) -> Any:
        """Every ID or shipped rule held as a whole string anywhere inside a value (route.details)."""
        if isinstance(value, dict):
            return {key: self.anything(item, f"{field}.{key}") for key, item in value.items()}
        if isinstance(value, list):
            return [self.anything(item, f"{field}[{n}]") for n, item in enumerate(value)]
        if isinstance(value, str) and "/" in value and _split(value.split("/", 1)[0]):
            return self.rule(value, field)
        return self.ident(value, tuple(PREFIXES), field)


def _dicts(value: Any) -> List[Dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _project(p: _Pass, r: Dict[str, Any], project_id: Optional[str]) -> None:
    if project_id is not None and "project_id" in r:
        r["project_id"] = project_id
    p.at(r, "vision", p.text)
    p.each(r, "outcomes", p.text)


def _epic(p: _Pass, r: Dict[str, Any], project_id: Optional[str]) -> None:
    p.at(r, "epic_id", p.ids(("EPIC",)))
    if project_id is not None and "project_id" in r:
        r["project_id"] = project_id
    if isinstance(r.get("serves"), dict):
        p.at(r["serves"], "idea", p.ids(("IDEA",)), "serves.idea")
    p.at(r, "title", p.text)
    p.each(r, "acceptance_criteria", p.text)


def _slice(p: _Pass, r: Dict[str, Any], project_id: Optional[str]) -> None:
    p.at(r, "slice_id", p.ids(("SLICE",)))
    if project_id is not None and "project_id" in r:
        r["project_id"] = project_id
    p.at(r, "epic_id", p.ids(("EPIC",)))
    p.each(r, "dependencies", p.ids(("SLICE",)))
    spec = _PATHS[0].fullmatch(r["spec_path"]) if isinstance(r.get("spec_path"), str) else None
    if spec:  # the SLICE-NNN in the file name; the kebab tail stays
        new = p.ident(spec.group(2), ("SLICE",), "spec_path")
        r["spec_path"] = spec.group(1) + new + spec.group(3)
    if isinstance(r.get("source"), dict):
        p.at(r["source"], "prd_id", p.ids(("PRD",)), "source.prd_id")
    if isinstance(r.get("serves"), dict):
        p.at(r["serves"], "idea", p.ids(("IDEA",)), "serves.idea")
    if isinstance(r.get("small"), dict):
        p.at(r["small"], "shipped_rule", p.rule, "small.shipped_rule")
    p.at(r, "title", p.text)
    p.each(r, "open_questions", p.text)
    if isinstance(r.get("widened"), dict):
        p.at(r["widened"], "reason", p.text, "widened.reason")


def _principles(p: _Pass, r: Dict[str, Any], project_id: Optional[str]) -> None:
    if project_id is not None and "project_id" in r:
        r["project_id"] = project_id
    for n, item in enumerate(_dicts(r.get("principles"))):
        where = f"principles[{n}]"
        p.at(item, "id", p.ids(("PP",)), f"{where}.id")
        for key in ("title", "statement", "reason"):
            p.at(item, key, p.text, f"{where}.{key}")


def _needs(p: _Pass, r: Dict[str, Any], project_id: Optional[str]) -> None:
    if project_id is not None and "project_id" in r:
        r["project_id"] = project_id
    for n, item in enumerate(_dicts(r.get("needs"))):
        where = f"needs[{n}]"
        p.at(item, "need_id", p.ids(("TN",)), f"{where}.need_id")
        for key in ("statement", "why"):
            p.at(item, key, p.text, f"{where}.{key}")


def _idea(p: _Pass, r: Dict[str, Any], project_id: Optional[str]) -> None:
    p.at(r, "idea_id", p.ids(("IDEA",)))
    source = r.get("source")
    if isinstance(source, dict) and source.get("kind") == "change":
        p.at(source, "rule", p.rule, "source.rule")
    if isinstance(r.get("made"), dict):
        p.each(r["made"], "epics", p.ids(("EPIC",)), "made.epics")
        p.each(r["made"], "slices", p.ids(("SLICE",)), "made.slices")
    route = r.get("route")
    if isinstance(route, dict):
        p.at(route, "details", p.anything, "route.details")
        p.at(route, "why", p.text, "route.why")
    p.at(r, "title", p.text)
    if isinstance(r.get("verdict"), dict):
        p.at(r["verdict"], "reason", p.text, "verdict.reason")
    lookback = r.get("lookback")
    if isinstance(lookback, dict):
        for group in ("outcomes", "assumptions"):
            entries = lookback.get(group)
            if isinstance(entries, dict):
                for ident, entry in entries.items():
                    if isinstance(entry, dict):
                        p.at(entry, "note", p.text, f"lookback.{group}.{ident}.note")


def _lookups(p: _Pass, r: Dict[str, Any], project_id: Optional[str]) -> None:
    for n, item in enumerate(_dicts(r.get("shipped_rules"))):
        p.at(item, "rule", p.rule, f"shipped_rules[{n}].rule")
        p.at(item, "epic_id", p.ids(("EPIC",)), f"shipped_rules[{n}].epic_id")
    for n, item in enumerate(_dicts(r.get("similar"))):
        p.at(item, "idea", p.ids(("IDEA",)), f"similar[{n}].idea")
    for n, item in enumerate(_dicts(r.get("principles"))):
        p.at(item, "id", p.ids(("PP",)), f"principles[{n}].id")
    for group in ("shipped_rules", "similar", "principles", "policies"):
        for n, item in enumerate(_dicts(r.get(group))):
            p.at(item, "note", p.text, f"{group}[{n}].note")


def _map(id_key: str, id_kind: str) -> Callable[[_Pass, Dict[str, Any], Optional[str]], None]:
    """An idea's map or a PRD's map: the owner's ID, each map slice's epic and dependencies where they are IDs (a map key
    is not an ID and stays), what apply made, and the settlements' reasons and map slices' title and scope."""

    def rewrite(p: _Pass, r: Dict[str, Any], project_id: Optional[str]) -> None:
        p.at(r, id_key, p.ids((id_kind,)))
        for n, item in enumerate(_dicts(r.get("slices"))):
            where = f"slices[{n}]"
            p.at(item, "epic", p.ids(("EPIC",)), f"{where}.epic")
            p.each(item, "depends_on", p.ids(("SLICE",)), f"{where}.depends_on")
            p.at(item, "title", p.text, f"{where}.title")
            p.at(item, "scope", p.text, f"{where}.scope")
        applied = r.get("applied")
        if isinstance(applied, dict):
            for group, kind in (("epics", "EPIC"), ("slices", "SLICE")):
                made = applied.get(group)
                if isinstance(made, dict):
                    applied[group] = {key: p.ident(value, (kind,), f"applied.{group}.{key}") for key, value in made.items()}
        settled = r.get("settled")
        if isinstance(settled, dict):
            for key, entry in settled.items():
                if isinstance(entry, dict):
                    p.at(entry, "reason", p.text, f"settled.{key}.reason")

    return rewrite


def _owner(id_key: str, id_kind: str) -> Callable[[_Pass, Dict[str, Any], Optional[str]], None]:
    return lambda p, r, project_id: p.at(r, id_key, p.ids((id_kind,)))


def _prd_answers(p: _Pass, r: Dict[str, Any], project_id: Optional[str]) -> None:
    p.at(r, "slice_id", p.ids(("SLICE",)))
    p.at(r, "prd_id", p.ids(("PRD",)))


def _design_map(p: _Pass, r: Dict[str, Any], project_id: Optional[str]) -> None:
    p.at(r, "design_id", p.ids(("DES",)))
    for n, item in enumerate(_dicts(r.get("conflicts"))):
        p.at(item, "against", p.ids(("PP", "TN")), f"conflicts[{n}].against")


REWRITERS: Dict[str, Callable[[_Pass, Dict[str, Any], Optional[str]], None]] = {
    "project": _project, "epic": _epic, "slice": _slice, "principles": _principles, "needs": _needs, "idea": _idea,
    "lookups": _lookups, "idea_map": _map("idea_id", "IDEA"), "prd_map": _map("prd_id", "PRD"), "prd_meta": _owner("prd_id", "PRD"),
    "prd_answers": _prd_answers, "design_meta": _owner("design_id", "DES"), "design_map": _design_map,
}


def rewrite_record_noted(kind: str, record: Dict[str, Any], mapping: Mapping[str, str],
                         project_id: Optional[str]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """rewrite_record, with the notes of every field: {field, line, id, why}; line is None for an ID field."""
    if kind not in REWRITERS:
        raise ValueError(f"{kind!r} is not a record kind; one of: " + ", ".join(RECORD_KINDS))
    if not isinstance(record, dict):
        raise TypeError("a record is a JSON object")
    if project_id is not None and not (isinstance(project_id, str) and PROJECT_RE.fullmatch(project_id)):
        raise ValueError(f"{project_id!r} is not a project ID")
    _check_mapping(mapping)
    out = copy.deepcopy(record)
    work = _Pass(mapping)
    REWRITERS[kind](work, out, project_id)
    return out, work.notes


def rewrite_record(kind: str, record: Dict[str, Any], mapping: Mapping[str, str], project_id: Optional[str]) -> Dict[str, Any]:
    """A new record of `kind` with its ID fields rewritten by exact value and its people's text by the token rule (5.1).
    project_id, when given, replaces the record's project_id (joining); None keeps it. Every other field, and the input,
    is left exactly as it was."""
    return rewrite_record_noted(kind, record, mapping, project_id)[0]


# ---- file and folder names (5.1) ----

_KEBAB = r"-[a-z0-9]+(?:-[a-z0-9]+)*"
_MAP_KEY = r"[A-Za-z][A-Za-z0-9-]{0,31}"
_FIXED = ("product/project.json", "product/principles.json", "product/needs.json")
_PATHS = [re.compile(p) for p in (
    rf"(specs/slices/)(SLICE-[0-9]{{3,}})({_KEBAB}\.md)",
    r"(product/intents/)(SLICE-[0-9]{3,})(\.md)",
    r"(product/slices/)(SLICE-[0-9]{3,})(\.json)",
    r"(product/epics/)(EPIC-[0-9]{3,})(\.json)",
    r"(product/mocks/)(SLICE-[0-9]{3,})(/?|/[0-9a-f]{64}\.(?:png|jpg))",
    r"(product/ideas/)(IDEA-[0-9]{3,})(\.json|\.lookups\.json|\.map\.json)",
    r"(product/briefs/)(IDEA-[0-9]{3,})(\.md|\.case\.md)",
    rf"(product/prds/)(PRD-[0-9]{{2,}})(/?|/prd\.json|/document\.md|/document\.txt|/map\.json|/answers/?|/answers/{_MAP_KEY}\.json)",
    r"(product/designs/)(DES-[0-9]{2,})(/?|/import\.json|/design\.md|/design\.txt|/map\.json)",
)]


def rename(relative: str, mapping: Mapping[str, str]) -> str:
    """A draft-relative path (one of the forms of 5.1, a file or an ID's folder) with its ID part replaced by the map's.
    project.json, principles.json and needs.json come back as they are. Any other path, or an ID the map does not hold,
    is refused: a file is never placed under a name the map did not give."""
    if not isinstance(relative, str):
        raise TypeError("rename takes a draft-relative path")
    _check_mapping(mapping)
    if relative in _FIXED:
        return relative
    for pattern in _PATHS:
        match = pattern.fullmatch(relative)
        if match:
            ident = match.group(2)
            if ident not in mapping:
                raise ValueError(f"{ident} in {relative} is not in the map")
            return match.group(1) + mapping[ident] + match.group(3)
    raise ValueError(f"{relative!r} is not a path of a project's draft")
