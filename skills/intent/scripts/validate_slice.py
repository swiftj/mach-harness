#!/usr/bin/env python3
"""Validate a MACH slice specification against the mach-intent template and grammar rules.

Adapted from the prd-slice validator. Standard library only; reads files, writes nothing.
"""

import argparse
import itertools
import json
import re
import sys
from collections import abc
from pathlib import Path
from typing import Any, Dict, FrozenSet, List, Mapping, NamedTuple, Optional, Sequence, Set, Tuple, Union

REQUIRED_SECTIONS = (
    "Summary",
    "Scope",
    "Preconditions",
    "Invariants",
    "Functional requirements",
    "Acceptance criteria",
    "Dependencies and permissions",
    "Assumptions",
    "Accepted defaults",
    "Open questions",
)
REQUIRED_SUBSECTIONS = {
    "Scope": ("In scope", "Out of scope"),
    "Acceptance criteria": ("Decision matrix", "Scenarios"),
}
SUMMARY_FIELDS = ("Actor", "Trigger", "Outcome")
DEPENDENCY_FIELDS = ("External dependencies", "Required permissions")
MAX_COMBINATIONS = 4096
MAX_MISSING_SHOWN = 5

FILENAME_RE = re.compile(r"^(SLICE-\d{3,})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$")
TITLE_RE = re.compile(r"^(SLICE-\d{3,}): (\S.*)$")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
BULLET_RE = re.compile(r"^[-*+]\s+(.*)$")
INV_RE = re.compile(r"^[-*+]\s+\*\*(INV-\d{2,}):\*\*\s+(\S.*)$")
FR_RE = re.compile(r"^[-*+]\s+\*\*(FR-\d{2,}):\*\*\s+(\S.*)$")
FIELD_RE = re.compile(r"^[-*+]\s+\*\*([A-Za-z ]+):\*\*\s*(.*)$")
LABEL_RE = re.compile(r"^\[([^\]]+)\]\s+(\S.*)$")
DEFERRED_RE = re.compile(r"\(Deferred to (SLICE-\d{3,})\)\.?$")
POINTER_LINE_RE = re.compile(r"^\s*[-*+]\s+(.*?)\s*\(Deferred to (SLICE-\d{3,})\)\.?\s*$")
FAILURE_RE = re.compile(r"\(failure:\s*(FR-\d{2,}(?:\s*,\s*FR-\d{2,})*)\)\.?$", re.IGNORECASE)
DEFAULT_IDS_RE = re.compile(r"\(((?:FR|INV)-\d{2,}(?:\s*,\s*(?:FR|INV)-\d{2,})*)\)\.?$")
SCENARIO_TITLE_RE = re.compile(r"^(AC-\d{2,}): (\S.*)$")
COVERS_RE = re.compile(r"^[-*+]\s+\*\*Covers:\*\*\s*(.*)$")
STEP_RE = re.compile(r"^[-*+]\s+\*\*(Given|When|Then|And|But)\*\*\s+(\S.*)$")
REQ_ID_RE = re.compile(r"^(?:FR|INV)-\d{2,}$")
RULE_ID_RE = re.compile(r"^R\d+$")
SEPARATOR_CELL_RE = re.compile(r"^:?-+:?$")
DECLARED_VALUES_RE = re.compile(r"^(.*?)\s*\(([^()]*/[^()]*)\)$")
OR_RE = re.compile(r"\s+or\s+", re.IGNORECASE)
MULTI_ACTOR_RE = re.compile(r"\b(?:and|or)\b|[/,&]", re.IGNORECASE)
PARENTHETICAL_RE = re.compile(r"\([^)]*\)")
WORD_RE = re.compile(r"[a-z0-9]+")
WORD_STOPLIST = {"able", "each", "from", "have", "into", "only", "page", "slice", "that", "them", "their", "this", "user", "users", "when", "will", "with"}

QUOTED_RE = re.compile(r"\"[^\"]*\"|“[^”]*”")
INLINE_CODE_RE = re.compile(r"`[^`]*`")
PLACEHOLDER_RE = re.compile(r"<(?!https?://)[A-Za-z][^<>\n]*>")
MARKER_RE = re.compile(r"\b(TBD|TODO|FIXME)\b")
FOLLOW_UP_RE = re.compile(r"\bFollow up:\s*", re.IGNORECASE)
COMMENT_OPEN = "<!--"
COMMENT_CLOSE = "-->"

ABSOLUTE_KEYWORD_RE = re.compile(r"\b(MUST|SHALL|REQUIRED)\b")
SOFT_KEYWORD_RE = re.compile(r"\b(SHOULD|MAY|RECOMMENDED|OPTIONAL)\b")
NON_EARS_KEYWORD_RE = re.compile(r"\b(MUST|SHOULD|MAY|REQUIRED|RECOMMENDED|OPTIONAL)\b")
SHALL_RE = re.compile(r"\bSHALL\b")
NORMATIVE_WORD_RE = re.compile(r"\b(must|should|shall)\b", re.IGNORECASE)

VAGUE_TERMS = (
    "adequate", "and/or", "appropriate", "appropriately", "as needed", "as necessary",
    "as soon as possible", "easily", "easy", "efficient", "efficiently", "etc",
    "fast", "flexible", "if possible", "intuitive", "normally", "quickly",
    "reasonable", "robust", "seamless", "seamlessly", "sufficient", "typically",
    "user-friendly", "usually",
)
VAGUE_RE = re.compile(
    r"(?<![\w-])(" + "|".join(re.escape(t) for t in VAGUE_TERMS) + r")(?![\w-])",
    re.IGNORECASE,
)
IMPLEMENTATION_TERMS = (
    "api", "cache", "cron", "database", "db", "endpoint", "http", "https", "json", "kafka",
    "microservice", "payload", "redis", "schema", "sql", "status code", "ttl",
)
IMPLEMENTATION_RE = re.compile(
    r"(?<![\w-])(" + "|".join(re.escape(t) for t in IMPLEMENTATION_TERMS) + r")(?![\w-])",
    re.IGNORECASE,
)
ERROR_CODE_RE = re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")
STATUS_CODE_RE = re.compile(
    r"\b(?:return|returns|returning|respond|responds|responding)(?:\s+with)?\s+(?:an?\s+)?([1-5]\d\d)\b",
    re.IGNORECASE,
)

_EARS_TAIL = r"the [^,]+? SHALL(?: NOT)? \S.*\.[\"”]?$"
EARS_PATTERNS = (
    ("event-driven", re.compile(r"^When \S.*?, " + _EARS_TAIL)),
    ("state-driven", re.compile(r"^While \S.*?, " + _EARS_TAIL)),
    ("unwanted-behavior", re.compile(r"^If \S.*?, then " + _EARS_TAIL)),
    ("optional-feature", re.compile(r"^Where \S.*?, " + _EARS_TAIL)),
    ("ubiquitous", re.compile(r"^The [^,]+? SHALL(?: NOT)? \S.*\.[\"”]?$")),
)
PATTERN_NAMES = {
    "ubiquitous": "Ubiquitous",
    "event-driven": "Event-driven",
    "state-driven": "State-driven",
    "unwanted-behavior": "Unwanted behavior",
    "optional-feature": "Optional feature",
}
EARS_LABELS = {name.lower(): pattern for pattern, name in PATTERN_NAMES.items()}
EARS_HINTS = {
    "When": "Event-driven form: 'When <trigger>, the <system> SHALL <response>.'",
    "While": "State-driven form: 'While <state>, the <system> SHALL <response>.'",
    "If": "Unwanted-behavior form: 'If <condition>, then the <system> SHALL <response>.'",
    "Where": "Optional-feature form: 'Where <feature is included>, the <system> SHALL <response>.'",
    "The": "Ubiquitous form: 'The <system> SHALL <response>.'",
}
STEP_ORDER = {"Given": 0, "When": 1, "Then": 2}


class Finding(NamedTuple):
    severity: str
    line: int
    rule: str
    message: str


class Section:
    def __init__(self, title: str, level: int, line: int) -> None:
        self.title = title
        self.level = level
        self.line = line
        self.body: List[Tuple[int, str]] = []
        self.children: List["Section"] = []


class MatrixRow(NamedTuple):
    line: int
    rule: str
    sets: List[FrozenSet[str]]
    result: Tuple[str, str]
    outcome: str
    side_effects: str
    covers: List[str]


class Report:
    def __init__(self) -> None:
        self.findings: List[Finding] = []

    def error(self, line: int, rule: str, message: str) -> None:
        self.findings.append(Finding("error", line, rule, message))

    def warning(self, line: int, rule: str, message: str) -> None:
        self.findings.append(Finding("warning", line, rule, message))


def parse(lines: Sequence[str], report: Report) -> Tuple[Section, List[Tuple[int, str]]]:
    root = Section("", 0, 0)
    stack = [root]
    prose: List[Tuple[int, str]] = []
    in_fence = False
    in_comment = False
    for number, raw in enumerate(lines, start=1):
        line = raw.rstrip()
        if in_comment:
            in_comment = COMMENT_CLOSE not in line
            continue
        if not in_fence and COMMENT_OPEN in line:
            report.error(number, "template-residue", "Remove template comments ('<!-- ... -->') from the finished spec.")
            in_comment = COMMENT_CLOSE not in line.split(COMMENT_OPEN, 1)[1]
            continue
        if FENCE_RE.match(line):
            in_fence = not in_fence
            stack[-1].body.append((number, line))
            continue
        heading = None if in_fence else HEADING_RE.match(line)
        if heading:
            level = len(heading.group(1))
            while stack[-1].level >= level:
                stack.pop()
            section = Section(heading.group(2), level, number)
            stack[-1].children.append(section)
            stack.append(section)
            continue
        stack[-1].body.append((number, line))
        if not in_fence:
            prose.append((number, line))
    return root, prose


def flatten(section: Section) -> List[Section]:
    result = []
    for child in section.children:
        result.append(child)
        result.extend(flatten(child))
    return result


def content_lines(section: Section) -> List[Tuple[int, str]]:
    return [(number, line.strip()) for number, line in section.body if line.strip()]


def bullets(section: Section) -> List[Tuple[int, str]]:
    result = []
    for number, line in content_lines(section):
        match = BULLET_RE.match(line)
        if match:
            result.append((number, match.group(1).strip()))
    return result


def bullet_texts(section: Section) -> List[str]:
    return [text for _, text in bullets(section) if not is_none(text)]


def subsection(section: Section, title: str) -> Optional[Section]:
    for child in section.children:
        if child.level == section.level + 1 and child.title.lower() == title.lower():
            return child
    return None


def strip_quotes(text: str) -> str:
    return QUOTED_RE.sub('""', text)


def significant_words(text: str) -> Set[str]:
    return {word.rstrip("s") for word in WORD_RE.findall(text.lower()) if len(word) >= 4 and word not in WORD_STOPLIST}


def register_id(registry: Dict[str, int], identifier: str, line: int, report: Report) -> None:
    if identifier in registry:
        report.error(line, "duplicate-id", f"{identifier} is already defined on line {registry[identifier]}.")
    else:
        registry[identifier] = line


def check_vague(label: str, text: str, line: int, report: Report) -> None:
    found = sorted({match.group(1).lower() for match in VAGUE_RE.finditer(strip_quotes(text))})
    if found:
        report.warning(
            line, "vague-term",
            f"{label} uses vague wording ({', '.join(found)}). Replace it with a measurable condition or value.",
        )


def check_implementation(label: str, text: str, line: int, report: Report) -> None:
    bare = strip_quotes(text)
    found = {match.group(1).lower() for match in IMPLEMENTATION_RE.finditer(bare)}
    found.update(match.group(0) for match in ERROR_CODE_RE.finditer(bare))
    found.update(f"status {match.group(1)}" for match in STATUS_CODE_RE.finditer(bare))
    if found:
        report.warning(
            line, "implementation-detail",
            f"{label} mentions implementation detail ({', '.join(sorted(found))}). "
            "Describe the observable behavior; engineering chooses the technical design.",
        )


def is_none(text: str) -> bool:
    return text.rstrip(".").strip().lower() == "none"


def lowercase_normative(text: str) -> Set[str]:
    return {m.group(1).lower() for m in NORMATIVE_WORD_RE.finditer(text) if m.group(1) != m.group(1).upper()}


def check_title(file_name: str, sections: List[Section], report: Report) -> Tuple[Optional[str], str]:
    name_match = FILENAME_RE.match(file_name)
    name_id = name_match.group(1) if name_match else None
    if not name_match:
        report.error(
            0, "filename",
            f"File name '{file_name}' must look like 'SLICE-001-short-name.md': SLICE-, three or more digits, "
            "a lowercase kebab-case name, and .md.",
        )
    titles = [s for s in sections if s.level == 1]
    if len(titles) != 1:
        line = titles[1].line if len(titles) > 1 else 1
        report.error(line, "title", "The spec must have exactly one '# SLICE-NNN: Title' heading.")
        return name_id, ""
    title_match = TITLE_RE.match(titles[0].title)
    if not title_match:
        report.error(titles[0].line, "title", "The H1 must read '# SLICE-NNN: Title', for example '# SLICE-001: Invite a teammate'.")
        return name_id, ""
    if name_id and title_match.group(1) != name_id:
        report.error(
            titles[0].line, "title",
            f"The H1 ID {title_match.group(1)} does not match the file name ID {name_id}.",
        )
    return title_match.group(1), title_match.group(2).strip()


def check_structure(sections: List[Section], report: Report) -> Dict[str, Section]:
    canonical = {name.lower(): name for name in REQUIRED_SECTIONS}
    found: Dict[str, Section] = {}
    for section in (s for s in sections if s.level == 2):
        name = canonical.get(section.title.lower())
        if name is None:
            report.warning(section.line, "extra-section", f"'## {section.title}' is not part of the template; downstream agents may ignore it.")
        elif name in found:
            report.error(section.line, "duplicate-section", f"'## {name}' appears more than once.")
        else:
            found[name] = section
    for name in REQUIRED_SECTIONS:
        if name not in found:
            report.error(0, "missing-section", f"Missing required section '## {name}'.")
    expected = [name for name in REQUIRED_SECTIONS if name in found]
    actual = sorted(expected, key=lambda name: found[name].line)
    for want, got in zip(expected, actual):
        if want != got:
            report.error(found[got].line, "section-order", "Sections must appear in this order: " + ", ".join(REQUIRED_SECTIONS) + ".")
            break
    for parent, names in REQUIRED_SUBSECTIONS.items():
        if parent not in found:
            continue
        children = [subsection(found[parent], name) for name in names]
        for name, child in zip(names, children):
            if child is None:
                report.error(found[parent].line, "missing-section", f"'## {parent}' needs a '### {name}' subsection.")
        present = [child for child in children if child is not None]
        if [c.line for c in present] != sorted(c.line for c in present):
            report.error(found[parent].line, "section-order", f"Subsections of '## {parent}' must appear in this order: " + ", ".join(names) + ".")
    return found


def check_placeholders(prose: List[Tuple[int, str]], skip_markers: Set[int], report: Report) -> None:
    for number, line in prose:
        text = INLINE_CODE_RE.sub("", line)
        placeholder = PLACEHOLDER_RE.search(strip_quotes(text))
        if placeholder:
            report.error(number, "placeholder", f"Replace the template placeholder '{placeholder.group(0)}'.")
        marker = MARKER_RE.search(text)
        if marker and number not in skip_markers:
            report.error(number, "placeholder", f"Resolve '{marker.group(1)}', or move the open item to '## Open questions'.")


def require_bullets(section: Section, label: str, report: Report) -> None:
    if not bullets(section):
        report.error(section.line, "empty-section", f"'{label}' needs at least one bullet. Use '- None.' if it is intentionally empty.")


def check_fields(section: Section, fields: Sequence[str], rule: str, report: Report) -> Dict[str, Tuple[int, str]]:
    values: Dict[str, Tuple[int, str]] = {}
    expected = ", ".join(f"'- **{field}:** ...'" for field in fields)
    for number, line in content_lines(section):
        match = FIELD_RE.match(line)
        if not match or match.group(1) not in fields:
            report.error(number, rule, f"{section.title} lines must be one of: {expected}.")
        elif match.group(1) in values:
            report.error(number, rule, f"'{match.group(1)}' appears more than once in {section.title}.")
        else:
            values[match.group(1)] = (number, match.group(2).strip())
    for field in fields:
        if field not in values:
            report.error(section.line, rule, f"{section.title} is missing '- **{field}:** ...'.")
        elif not values[field][1]:
            report.error(values[field][0], rule, f"'{field}' has no value. Write 'None.' if nothing applies.")
    return values


def check_summary(section: Section, report: Report) -> Dict[str, str]:
    values = check_fields(section, SUMMARY_FIELDS, "summary-format", report)
    actor = values.get("Actor")
    if actor and MULTI_ACTOR_RE.search(PARENTHETICAL_RE.sub("", actor[1])):
        report.warning(
            actor[0], "single-actor",
            "Actor appears to name more than one persona. A slice has exactly one actor; move other roles to a later slice.",
        )
    return {field.lower(): values[field][1] for field in SUMMARY_FIELDS if field in values}


def collect_reservations(other_specs: Mapping[str, str]) -> Dict[str, List[Tuple[str, str]]]:
    reserved: Dict[str, List[Tuple[str, str]]] = {}
    for name in sorted(other_specs):
        for line in other_specs[name].splitlines():
            match = POINTER_LINE_RE.match(line)
            if match:
                reserved.setdefault(match.group(2), []).append((name, match.group(1).strip()))
    return reserved


def check_out_of_scope(
    section: Section, slice_id: Optional[str], other_ids: Dict[str, str],
    reserved: Dict[str, List[Tuple[str, str]]], report: Report,
) -> List[Dict[str, str]]:
    deferred: List[Dict[str, str]] = []
    for number, text in bullets(section):
        if is_none(text):
            continue
        match = DEFERRED_RE.search(text)
        feature = text[:match.start()].strip() if match else ""
        if not match or not feature:
            report.error(
                number, "deferred-pointer",
                "Each out-of-scope item must name the feature and end with '(Deferred to SLICE-NNN)', "
                "using the ID reserved for the future slice.",
            )
            continue
        target = match.group(1)
        deferred.append({"feature": feature, "deferred_to": target})
        if target == slice_id:
            report.error(number, "deferred-pointer", f"An out-of-scope item cannot be deferred to this slice ({slice_id}).")
        elif target in other_ids:
            report.warning(
                number, "deferred-pointer",
                f"{target} already has a spec ({other_ids[target]}). Deferred items normally reserve a new ID; "
                "keep this pointer only if that spec covers the feature.",
            )
        else:
            for spec, other_feature in reserved.get(target, []):
                if not significant_words(feature) & significant_words(other_feature):
                    report.warning(
                        number, "reserved-id",
                        f"{target} is already reserved by {spec} for '{other_feature}'. Point '{feature}' at a new ID "
                        "unless both belong in the same future slice.",
                    )
    return deferred


def check_invariants(section: Section, requirements: Dict[str, int], report: Report) -> List[Dict[str, str]]:
    found: List[Dict[str, str]] = []
    for number, line in content_lines(section):
        match = INV_RE.match(line)
        if not match:
            report.error(number, "unparsed-line", "Each invariant must be one line: '- **INV-01:** <subject> MUST <boundary>.'")
            continue
        identifier, statement = match.groups()
        register_id(requirements, identifier, number, report)
        found.append({"id": identifier, "text": statement})
        bare = strip_quotes(statement)
        soft = SOFT_KEYWORD_RE.search(bare)
        if soft:
            report.error(
                number, "inv-keyword",
                f"{identifier} uses '{soft.group(1)}'. Invariants are absolute: use MUST, MUST NOT, SHALL, SHALL NOT, or REQUIRED.",
            )
        elif not ABSOLUTE_KEYWORD_RE.search(bare):
            report.error(
                number, "inv-keyword",
                f"{identifier} has no uppercase RFC 2119 keyword. Use MUST, MUST NOT, SHALL, SHALL NOT, or REQUIRED.",
            )
        lowered = lowercase_normative(bare)
        if lowered:
            report.warning(
                number, "rfc2119-case",
                f"{identifier} uses lowercase '{', '.join(sorted(lowered))}', which has no RFC 2119 force. Use uppercase or rephrase.",
            )
        check_vague(identifier, statement, number, report)
        check_implementation(identifier, statement, number, report)
    if not found:
        report.error(section.line, "empty-section", "Invariants needs at least one '- **INV-01:** ...' line.")
    return found


def classify_ears(statement: str) -> Optional[str]:
    for name, pattern in EARS_PATTERNS:
        if pattern.match(statement):
            return name
    return None


def check_functional(section: Section, requirements: Dict[str, int], report: Report) -> List[Dict[str, Optional[str]]]:
    found: List[Dict[str, Optional[str]]] = []
    for number, line in content_lines(section):
        match = FR_RE.match(line)
        if not match:
            report.error(number, "unparsed-line", "Each functional requirement must be one line: '- **FR-01:** [Pattern] <EARS statement>'.")
            continue
        identifier, labeled = match.groups()
        register_id(requirements, identifier, number, report)
        declared: Optional[str] = None
        label_match = LABEL_RE.match(labeled)
        if label_match:
            statement = label_match.group(2)
            declared = EARS_LABELS.get(label_match.group(1).strip().lower())
            if declared is None:
                report.error(
                    number, "ears-label",
                    f"{identifier} has an unknown label '[{label_match.group(1)}]'. Use one of: "
                    + ", ".join(f"[{name}]" for name in PATTERN_NAMES.values()) + ".",
                )
        else:
            statement = labeled
            report.error(number, "ears-label", f"{identifier} needs a pattern label before the sentence, such as '[Event-driven]'.")
        entry: Dict[str, Optional[str]] = {"id": identifier, "pattern": None, "text": statement}
        found.append(entry)
        bare = strip_quotes(statement)
        lowered = lowercase_normative(bare)
        if "shall" in lowered:
            report.error(number, "rfc2119-case", f"{identifier}: write 'SHALL' in uppercase.")
            continue
        other = NON_EARS_KEYWORD_RE.search(bare)
        if other:
            report.error(
                number, "fr-keyword",
                f"{identifier} uses '{other.group(1)}'. Functional requirements use SHALL or SHALL NOT; put MUST rules "
                "in Invariants and optional behavior in the Where pattern.",
            )
        shall_count = len(SHALL_RE.findall(bare))
        if shall_count == 0:
            report.error(number, "ears-atomic", f"{identifier} has no SHALL. State exactly one response with SHALL or SHALL NOT.")
        elif shall_count > 1:
            report.error(number, "ears-atomic", f"{identifier} has {shall_count} SHALL clauses. Split it into one requirement per response.")
        else:
            pattern = classify_ears(statement)
            if pattern is None:
                first_word = statement.split(" ", 1)[0].rstrip(",")
                hint = EARS_HINTS.get(first_word, "Start with When, While, If, Where, or The.")
                report.error(
                    number, "ears-pattern",
                    f"{identifier} does not match any of the five EARS patterns. {hint} See references/ears-syntax.md.",
                )
            else:
                entry["pattern"] = pattern
                if declared and declared != pattern:
                    report.error(
                        number, "ears-label",
                        f"{identifier} is labeled [{PATTERN_NAMES[declared]}] but is written in the "
                        f"{PATTERN_NAMES[pattern]} form. Fix the label or the sentence.",
                    )
        if lowered:
            report.warning(
                number, "rfc2119-case",
                f"{identifier} uses lowercase '{', '.join(sorted(lowered))}', which has no RFC 2119 force. Use uppercase or rephrase.",
            )
        check_vague(identifier, statement, number, report)
        check_implementation(identifier, statement, number, report)
    if not found:
        report.error(section.line, "empty-section", "Functional requirements needs at least one '- **FR-01:** ...' line.")
    elif not any(entry["pattern"] == "unwanted-behavior" for entry in found):
        report.warning(
            section.line, "ears-coverage",
            "No 'If <condition>, then the <system> SHALL <response>.' requirement. Confirm the slice's rejection and failure paths.",
        )
    return found


def split_row(line: str) -> List[str]:
    text = line.strip()
    if text.startswith("|"):
        text = text[1:]
    if text.endswith("|") and not text.endswith("\\|"):
        text = text[:-1]
    return [cell.strip().replace("\\|", "|") for cell in re.split(r"(?<!\\)\|", text)]


def parse_covers(label: str, value: str, line: int, refs: List[Tuple[str, int]], report: Report) -> List[str]:
    identifiers = [item.strip() for item in value.split(",") if item.strip()]
    if not identifiers:
        report.error(line, "trace-format", f"{label}: Covers must list at least one FR-NN or INV-NN ID.")
    valid = []
    for identifier in identifiers:
        if REQ_ID_RE.match(identifier):
            refs.append((identifier, line))
            valid.append(identifier)
        else:
            report.error(line, "trace-format", f"{label}: '{identifier}' in Covers is not an FR-NN or INV-NN ID.")
    return valid


def parse_cell(text: str) -> Tuple[str, List[str]]:
    value = text.strip()
    if value == "-":
        return "any", []
    kind = "set"
    if value.lower().startswith("not "):
        kind, value = "not", value[4:]
    return kind, [part.strip() for part in OR_RE.split(value) if part.strip()]


def match_values(text: str, domain: Sequence[str]) -> Tuple[List[str], Optional[str]]:
    known = {" ".join(value.split()): value for value in domain}
    parts = [part.strip() for part in OR_RE.split(text) if part.strip()]
    matched: List[str] = []
    start = 0
    while start < len(parts):
        for end in range(len(parts), start, -1):
            candidate = " ".join(" or ".join(parts[start:end]).lower().split())
            if candidate in known:
                matched.append(known[candidate])
                start = end
                break
        else:
            return matched, parts[start]
    return matched, None


def check_matrix(section: Section, refs: List[Tuple[str, int]], report: Report) -> Optional[Dict[str, Any]]:
    rows: List[Tuple[int, str]] = []
    blocks = 0
    previous_was_table = False
    for number, line in section.body:
        is_table = line.strip().startswith("|")
        if is_table and not previous_was_table:
            blocks += 1
        if is_table and blocks == 1:
            rows.append((number, line))
        previous_was_table = is_table
    if blocks > 1:
        report.error(section.line, "matrix-format", "Use a single decision matrix table.")
    if len(rows) < 3:
        report.error(section.line, "matrix-missing", "The decision matrix needs a header row, a separator row, and at least one rule row.")
        return None

    header = split_row(rows[0][1])
    separator = split_row(rows[1][1])
    if len(separator) != len(header) or not all(SEPARATOR_CELL_RE.match(cell) for cell in separator):
        report.error(rows[1][0], "matrix-format", "The second table row must be a separator such as '|---|---|'.")
        return None
    lowered = [cell.lower() for cell in header]
    if len(header) < 5 or lowered[0] != "rule" or lowered[-3:] != ["expected outcome", "side effects", "covers"]:
        report.error(
            rows[0][0], "matrix-format",
            "Matrix columns must be: Rule, one or more condition columns, Expected outcome, Side effects, Covers.",
        )
        return None
    conditions: List[str] = []
    declared: List[Optional[List[str]]] = []
    for cell in header[1:-3]:
        declaration = DECLARED_VALUES_RE.match(cell)
        options = [v.strip() for v in declaration.group(2).split("/") if v.strip()] if declaration else []
        if declaration and len(options) >= 2:
            conditions.append(declaration.group(1).strip())
            declared.append(options)
        else:
            conditions.append(cell)
            declared.append(None)
    if any(not name for name in conditions) or len({name.lower() for name in conditions}) != len(conditions):
        report.error(rows[0][0], "matrix-format", "Each condition column needs a unique, non-empty name.")

    raw_rows: List[Tuple[int, str, List[Tuple[str, List[str]]], str, str, List[str]]] = []
    rule_lines: Dict[str, int] = {}
    for number, line in rows[2:]:
        cells = split_row(line)
        if len(cells) != len(header):
            report.error(number, "matrix-format", f"Row has {len(cells)} cells; the header has {len(header)}.")
            continue
        rule, values, outcome, side_effects, covers = cells[0], cells[1:-3], cells[-3], cells[-2], cells[-1]
        if not RULE_ID_RE.match(rule):
            report.error(number, "matrix-rule-id", f"Rule ID '{rule}' must look like R1, R2, R3.")
        else:
            register_id(rule_lines, rule, number, report)
        covered = parse_covers(rule or "Matrix row", covers, number, refs, report)
        if any(not value for value in values) or not outcome or not side_effects:
            report.error(
                number, "matrix-empty-cell",
                f"{rule}: every cell needs a value. Use '-' when a condition does not matter and 'None' when nothing changes.",
            )
            continue
        check_vague(rule, f"{outcome} {side_effects}", number, report)
        check_implementation(rule, f"{outcome} {side_effects}", number, report)
        if (
            is_none(side_effects) and not QUOTED_RE.search(outcome)
            and not outcome.lower().startswith("not possible") and "no message" not in outcome.lower()
        ):
            report.warning(
                number, "message-missing",
                f"{rule} changes nothing, so it turns the action away, but its Expected outcome does not quote what "
                "the user sees. Quote the exact message, or write 'No message shown' if the PM decided that.",
            )
        raw_rows.append((number, rule, [value.strip() for value in values], outcome, side_effects, covered))

    domains: List[List[str]] = []
    display: List[Dict[str, str]] = []
    for index, name in enumerate(conditions):
        names: Dict[str, str] = {}
        options = declared[index]
        if options:
            for option in options:
                names.setdefault(option.lower(), option)
            domains.append(list(names))
            display.append(names)
            continue
        operands = {
            value.lower() for _, _, cells, _, _, _ in raw_rows for value in parse_cell(cells[index])[1]
        }
        if operands and operands <= {"yes", "no"}:
            domains.append(["yes", "no"])
            display.append({"yes": "Yes", "no": "No"})
            continue
        for _, _, cells, _, _, _ in raw_rows:
            if cells[index] != "-":
                names.setdefault(cells[index].lower(), cells[index])
        if names:
            example = " / ".join(names.values())
            report.warning(
                rows[0][0], "matrix-partitions",
                f"Declare every value of '{name}' in its header, such as '{name} ({example})', "
                "so the validator can confirm each value is covered.",
            )
        else:
            report.error(rows[0][0], "matrix-format", f"Condition '{name}' is '-' in every rule. Remove the column.")
        domains.append(list(names))
        display.append(names)
    if not raw_rows or any(not domain for domain in domains):
        return None

    parsed: List[MatrixRow] = []
    for number, rule, cells, outcome, side_effects, covered in raw_rows:
        sets: List[FrozenSet[str]] = []
        for index, cell in enumerate(cells):
            domain = domains[index]
            if cell == "-":
                sets.append(frozenset(domain))
                continue
            if cell.lower() in domain:
                sets.append(frozenset({cell.lower()}))
                continue
            kind, rest = ("not", cell[4:]) if cell.lower().startswith("not ") else ("set", cell)
            values, unmatched = match_values(rest, domain)
            if unmatched is not None:
                report.error(
                    number, "matrix-value",
                    f"{rule}: '{unmatched}' is not one of the values declared for {conditions[index]}: "
                    + ", ".join(display[index].values()) + ".",
                )
                break
            chosen = set(values)
            selected = frozenset(domain) - chosen if kind == "not" else frozenset(chosen)
            if not selected:
                report.error(number, "matrix-value", f"{rule}: '{cell}' leaves no value for {conditions[index]}.")
                break
            sets.append(selected)
        else:
            parsed.append(MatrixRow(number, rule, sets, (outcome.lower(), side_effects.lower()), outcome, side_effects, covered))

    for first, second in itertools.combinations(parsed, 2):
        if all(a & b for a, b in zip(first.sets, second.sets)):
            if first.result == second.result:
                report.warning(
                    second.line, "matrix-redundant",
                    f"{second.rule} overlaps {first.rule} with the same outcome and side effects. "
                    "Merge them or make their conditions exclusive.",
                )
            else:
                report.error(
                    second.line, "matrix-conflict",
                    f"{first.rule} and {second.rule} can match the same case but give different outcomes or side effects. "
                    "Make their conditions mutually exclusive.",
                )

    def ordered(index: int, chosen: FrozenSet[str]) -> List[str]:
        return [value for value in domains[index] if value in chosen]

    model: Dict[str, Any] = {
        "conditions": [{"name": name, "values": list(display[i][v] for v in domains[i])} for i, name in enumerate(conditions)],
        "rules": [
            {
                "id": row.rule,
                "conditions": {name: [display[i][v] for v in ordered(i, row.sets[i])] for i, name in enumerate(conditions)},
                "expected_outcome": row.outcome,
                "side_effects": row.side_effects,
                "covers": row.covers,
            }
            for row in parsed
        ],
        "complete": None,
        "cases": [],
    }
    total = 1
    for domain in domains:
        total *= len(domain)
    if total > MAX_COMBINATIONS:
        report.warning(
            rows[0][0], "matrix-size",
            f"The conditions allow {total} combinations, so completeness was not checked. Split the slice or merge conditions.",
        )
        return model
    missing = [
        combo for combo in itertools.product(*domains)
        if not any(all(c in s for c, s in zip(combo, row.sets)) for row in parsed)
    ]
    model["complete"] = not missing
    if missing:
        cases = summarize_missing(missing, domains)

        def describe(case: Tuple[str, ...]) -> str:
            parts = [
                f"{name}={display[index].get(value, value.capitalize())}"
                for index, (name, value) in enumerate(zip(conditions, case)) if value != "-"
            ]
            return ", ".join(parts) or "every case"

        shown = "; ".join(describe(case) for case in cases[:MAX_MISSING_SHOWN])
        more = f" and {len(cases) - MAX_MISSING_SHOWN} more" if len(cases) > MAX_MISSING_SHOWN else ""
        report.error(
            rows[0][0], "matrix-incomplete",
            f"No rule covers: {shown}{more}. Add rules, using '-' for conditions that do not matter, or a "
            "'Not possible:' rule if the PM confirms a case cannot happen.",
        )
    for row in parsed:
        choices = [ordered(i, row.sets[i]) for i in range(len(conditions))]
        for count, combo in enumerate(itertools.product(*choices), start=1):
            model["cases"].append({
                "id": f"{row.rule}-{count}",
                "rule": row.rule,
                "conditions": {name: display[i][combo[i]] for i, name in enumerate(conditions)},
                "expected_outcome": row.outcome,
                "side_effects": row.side_effects,
                "covers": row.covers,
            })
    return model


def summarize_missing(missing: List[Tuple[str, ...]], domains: List[List[str]]) -> List[Tuple[str, ...]]:
    cases = set(missing)
    changed = True
    while changed:
        changed = False
        for index, domain in enumerate(domains):
            groups: Dict[Tuple[str, ...], Set[str]] = {}
            for case in cases:
                if case[index] != "-":
                    groups.setdefault(case[:index] + ("-",) + case[index + 1:], set()).add(case[index])
            for merged, values in groups.items():
                if values >= set(domain):
                    cases.difference_update(merged[:index] + (value,) + merged[index + 1:] for value in values)
                    cases.add(merged)
                    changed = True
    return sorted(cases)


def check_steps(label: str, line: int, steps: List[Tuple[int, str]], report: Report) -> None:
    if not steps:
        report.error(line, "scenario-steps", f"{label} has no Given, When, or Then steps.")
        return
    resolved: List[Tuple[int, str]] = []
    for number, keyword in steps:
        if keyword in ("And", "But"):
            if not resolved:
                report.error(number, "scenario-steps", f"{label} cannot start with {keyword}; start with Given.")
                return
            keyword = resolved[-1][1]
        resolved.append((number, keyword))
    if resolved[0][1] != "Given":
        report.error(resolved[0][0], "scenario-steps", f"{label} must start with a Given step.")
    whens = [number for number, keyword in resolved if keyword == "When"]
    if len(whens) != 1:
        report.error(
            line, "scenario-steps",
            f"{label} has {len(whens)} When steps. A scenario tests exactly one action; move setup into Given or split the scenario.",
        )
    if not any(keyword == "Then" for _, keyword in resolved):
        report.error(line, "scenario-steps", f"{label} needs at least one Then step.")
    for (_, before), (number, after) in zip(resolved, resolved[1:]):
        if STEP_ORDER[after] < STEP_ORDER[before]:
            report.error(number, "scenario-steps", f"{label}: {after} cannot follow {before}. Keep the order Given, When, Then.")
            break


def check_scenarios(section: Section, refs: List[Tuple[str, int]], report: Report) -> List[Dict[str, Any]]:
    for number, _ in bullets(section):
        report.error(number, "scenario-format", "Put each scenario under its own '#### AC-NN: Title' heading.")
    scenarios = [child for child in section.children if child.level == section.level + 1]
    if not scenarios:
        report.error(section.line, "scenario-missing", "Add at least one '#### AC-01: Title' scenario.")
        return []
    found: List[Dict[str, Any]] = []
    scenario_ids: Dict[str, int] = {}
    for scenario in scenarios:
        title_match = SCENARIO_TITLE_RE.match(scenario.title)
        if title_match:
            label = title_match.group(1)
            register_id(scenario_ids, label, scenario.line, report)
        else:
            label = f"'{scenario.title}'"
            report.error(scenario.line, "scenario-format", "Scenario headings must read '#### AC-NN: Title'.")
        entry: Dict[str, Any] = {
            "id": title_match.group(1) if title_match else None,
            "title": title_match.group(2) if title_match else scenario.title,
            "covers": [],
            "steps": [],
        }
        found.append(entry)
        covers_lines = 0
        steps: List[Tuple[int, str]] = []
        for number, line in content_lines(scenario):
            covers = COVERS_RE.match(line)
            if covers:
                covers_lines += 1
                entry["covers"] = parse_covers(label, covers.group(1), number, refs, report)
                continue
            step = STEP_RE.match(line)
            if step:
                steps.append((number, step.group(1)))
                entry["steps"].append({"keyword": step.group(1), "text": step.group(2)})
                check_implementation(label, step.group(2), number, report)
                continue
            report.error(
                number, "scenario-format",
                f"{label}: each line must be '- **Covers:** ...' or a step starting with **Given**, **When**, **Then**, **And**, or **But**.",
            )
        if covers_lines != 1:
            report.error(scenario.line, "trace-format", f"{label} needs exactly one '- **Covers:** FR-NN, INV-NN' line.")
        check_steps(label, scenario.line, steps, report)
    return found


def check_traceability(requirements: Dict[str, int], refs: List[Tuple[str, int]], report: Report) -> None:
    referenced = set()
    for identifier, line in refs:
        referenced.add(identifier)
        if identifier not in requirements:
            report.error(line, "trace-undefined", f"{identifier} is referenced but not defined in Invariants or Functional requirements.")
    for identifier, line in requirements.items():
        if identifier not in referenced:
            report.error(line, "trace-uncovered", f"{identifier} is not covered by any decision matrix rule or scenario.")


def check_dependencies(
    section: Section, patterns: Dict[str, Optional[str]], scenario_covers: Set[str], report: Report,
) -> Dict[str, Any]:
    values = check_fields(section, DEPENDENCY_FIELDS, "dependencies-format", report)
    model: Dict[str, Any] = {
        "external_dependencies": [],
        "required_permissions": values.get("Required permissions", (0, ""))[1],
    }
    entry = values.get("External dependencies")
    if not entry or not entry[1] or entry[1].lower().startswith("none"):
        return model
    line, text = entry
    for part in (piece.strip() for piece in text.split(";")):
        if not part:
            continue
        match = FAILURE_RE.search(part)
        name = part[:match.start()].strip().rstrip(",") if match else part
        if not match or not name:
            report.error(
                line, "dependency-failure",
                f"Name the requirement that covers '{part}' failing, such as '{part.rstrip('.')} (failure: FR-NN)'. "
                "Data the slice only reads belongs under Preconditions, not here.",
            )
            continue
        identifiers = [item.strip().upper() for item in match.group(1).split(",")]
        for identifier in identifiers:
            if identifier not in patterns:
                report.error(line, "dependency-failure", f"{identifier}, named for '{name}', is not a functional requirement in this spec.")
            elif patterns[identifier] not in (None, "unwanted-behavior"):
                report.error(
                    line, "dependency-failure",
                    f"{identifier} is not an [Unwanted behavior] requirement, so it cannot describe '{name}' failing.",
                )
            elif identifier not in scenario_covers:
                report.error(
                    line, "dependency-failure",
                    f"{identifier} describes '{name}' failing, but no scenario covers it. Add a scenario that shows the failure.",
                )
        model["external_dependencies"].append({"name": name, "failure_requirements": identifiers})
    return model


def check_accepted_defaults(section: Section, requirements: Dict[str, int], report: Report) -> List[Dict[str, Any]]:
    items = bullets(section)
    if not items:
        report.error(section.line, "empty-section", "Accepted defaults needs at least one bullet. Use '- None.' if the PM accepted none.")
        return []
    found: List[Dict[str, Any]] = []
    for number, text in items:
        if is_none(text):
            continue
        match = DEFAULT_IDS_RE.search(text)
        default = text[:match.start()].strip() if match else ""
        if not match or not default:
            report.error(
                number, "defaults-format",
                "Each accepted default must end with the requirement IDs it produced, such as "
                "'- Reset links expire 30 minutes after they are sent (INV-02).'",
            )
            continue
        identifiers = [item.strip() for item in match.group(1).split(",")]
        for identifier in identifiers:
            if identifier not in requirements:
                report.error(number, "defaults-format", f"{identifier} is not defined in Invariants or Functional requirements.")
        found.append({"default": default, "requirements": identifiers})
    return found


def check_open_questions(section: Section, ready: bool, report: Report) -> List[Dict[str, str]]:
    items = bullets(section)
    if not items:
        report.error(section.line, "empty-section", "Open questions needs at least one bullet. Use '- None.' when nothing is open.")
        return []
    open_items = [(number, text) for number, text in items if not is_none(text)]
    found: List[Dict[str, str]] = []
    for number, text in open_items:
        parts = FOLLOW_UP_RE.split(text, maxsplit=1)
        if len(parts) < 2 or not parts[1].strip():
            report.error(
                number, "open-question-format",
                "Each open question needs a follow-up note: '- <question> Follow up: <who or what can answer it>.'",
            )
            continue
        found.append({"question": parts[0].strip(), "follow_up": parts[1].strip().rstrip(".")})
    if open_items:
        message = (
            f"{len(open_items)} open question(s) remain, so the spec is not ready for engineering. "
            "Answer them with the PM, then update the spec."
        )
        if ready:
            report.error(open_items[0][0], "open-questions", message)
        else:
            report.warning(open_items[0][0], "open-questions", message)
    return found


def analyze(
    text: str, file_name: str, other_specs: Optional[Union[Mapping[str, str], Sequence[str]]] = None, ready: bool = False,
) -> Tuple[List[Finding], Dict[str, Any]]:
    report = Report()
    if isinstance(other_specs, abc.Mapping):
        others: Mapping[str, str] = other_specs
    else:
        others = {name: "" for name in (other_specs or ())}
    root, prose = parse(text.splitlines(), report)
    sections = flatten(root)
    slice_id, title = check_title(file_name, sections, report)
    found = check_structure(sections, report)
    model: Dict[str, Any] = {"slice_id": slice_id, "title": title}

    other_ids: Dict[str, str] = {}
    for name in sorted(others):
        name_match = FILENAME_RE.match(name)
        if name_match:
            other_ids.setdefault(name_match.group(1), name)
    if slice_id in other_ids:
        report.error(
            0, "duplicate-slice-id",
            f"{slice_id} is already used by {other_ids[slice_id]}. Choose a new ID with 'cell.py next-id'.",
        )
    reserved = collect_reservations(others)
    for spec, feature in reserved.get(slice_id or "", []):
        if title and not significant_words(feature) & significant_words(title):
            report.warning(
                0, "reserved-id",
                f"{spec} reserved {slice_id} for '{feature}', but this spec is titled '{title}'. "
                "Confirm this spec is that feature, or choose a new ID.",
            )

    open_questions = found.get("Open questions")
    skip_markers = {number for number, _ in open_questions.body} if open_questions else set()
    check_placeholders(prose, skip_markers, report)

    requirements: Dict[str, int] = {}
    refs: List[Tuple[str, int]] = []
    if "Summary" in found:
        model["summary"] = check_summary(found["Summary"], report)
    if "Scope" in found:
        for name in REQUIRED_SUBSECTIONS["Scope"]:
            child = subsection(found["Scope"], name)
            if child:
                require_bullets(child, name, report)
        in_scope = subsection(found["Scope"], "In scope")
        out_of_scope = subsection(found["Scope"], "Out of scope")
        model["in_scope"] = bullet_texts(in_scope) if in_scope else []
        model["out_of_scope"] = check_out_of_scope(out_of_scope, slice_id, other_ids, reserved, report) if out_of_scope else []
    if "Preconditions" in found:
        require_bullets(found["Preconditions"], "Preconditions", report)
        model["preconditions"] = bullet_texts(found["Preconditions"])
    if "Invariants" in found:
        model["invariants"] = check_invariants(found["Invariants"], requirements, report)
    functional: List[Dict[str, Optional[str]]] = []
    if "Functional requirements" in found:
        functional = check_functional(found["Functional requirements"], requirements, report)
        model["functional_requirements"] = functional
    scenarios: List[Dict[str, Any]] = []
    if "Acceptance criteria" in found:
        matrix = subsection(found["Acceptance criteria"], "Decision matrix")
        if matrix:
            model["decision_matrix"] = check_matrix(matrix, refs, report)
        scenario_section = subsection(found["Acceptance criteria"], "Scenarios")
        if scenario_section:
            scenarios = check_scenarios(scenario_section, refs, report)
            model["scenarios"] = scenarios
        check_traceability(requirements, refs, report)
    if "Dependencies and permissions" in found:
        patterns = {str(entry["id"]): entry["pattern"] for entry in functional}
        covered_by_scenarios = {identifier for scenario in scenarios for identifier in scenario["covers"]}
        model.update(check_dependencies(found["Dependencies and permissions"], patterns, covered_by_scenarios, report))
    if "Assumptions" in found:
        require_bullets(found["Assumptions"], "Assumptions", report)
        model["assumptions"] = bullet_texts(found["Assumptions"])
    if "Accepted defaults" in found:
        model["accepted_defaults"] = check_accepted_defaults(found["Accepted defaults"], requirements, report)
    if open_questions:
        model["open_questions"] = check_open_questions(open_questions, ready, report)

    findings = sorted(report.findings, key=lambda f: (f.line, f.severity != "error", f.rule))
    return findings, model


def validate_text(
    text: str, file_name: str, other_specs: Optional[Union[Mapping[str, str], Sequence[str]]] = None, ready: bool = False,
) -> List[Finding]:
    return analyze(text, file_name, other_specs, ready)[0]


def sibling_specs(spec: Path, registries: Sequence[Path] = ()) -> Dict[str, str]:
    """Read the other specs next to `spec`, plus those in any extra registry folders.

    Registries are other `specs/slices/` folders that share the same ID space, such as the
    main checkout and the other open cells. A file name seen earlier wins, because a cell's
    checkout repeats every spec already on the main branch.
    """
    others: Dict[str, str] = {}
    for folder in [spec.parent, *registries]:
        for path in sorted(folder.glob("SLICE-*.md")):
            if path.name == spec.name or path.name in others:
                continue
            try:
                others[path.name] = path.read_text(encoding="utf-8-sig")
            except (OSError, UnicodeDecodeError):
                others[path.name] = ""
    return others


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate a MACH slice specification.",
        epilog="Exit codes: 0 no errors (warnings may remain), 1 errors found, 2 file could not be read or bad arguments.",
    )
    parser.add_argument("spec", type=Path, help="path to a spec such as specs/slices/SLICE-001-short-name.md")
    parser.add_argument(
        "--ready", action="store_true",
        help="also fail while open questions remain, to confirm the spec is ready for engineering",
    )
    parser.add_argument(
        "--export", action="store_true",
        help="print the spec as JSON, with every decision matrix rule expanded into test cases; findings go to stderr",
    )
    parser.add_argument(
        "--registry", action="append", type=Path, default=[], metavar="DIR",
        help="another specs/slices folder sharing this ID space (repeatable), checked for duplicate and reserved IDs",
    )
    args = parser.parse_args(argv)
    try:
        text = args.spec.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        print(f"{args.spec}: cannot read file: {exc}", file=sys.stderr)
        return 2

    findings, model = analyze(text, args.spec.name, sibling_specs(args.spec, args.registry), ready=args.ready)
    errors = sum(1 for f in findings if f.severity == "error")
    stream = sys.stderr if args.export else sys.stdout
    for finding in findings:
        location = f"{args.spec}:{finding.line}" if finding.line else str(args.spec)
        print(f"{location}: {finding.severity}: {finding.message} [{finding.rule}]", file=stream)
    status = "FAILED" if errors else ("READY" if args.ready else "PASSED")
    print(f"{status}: {errors} error(s), {len(findings) - errors} warning(s)", file=stream)
    if args.export and not errors:
        print(json.dumps(model, indent=2, ensure_ascii=False))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
