#!/usr/bin/env python3
"""MACH Product Studio, M16 part A: the brief's grammar and the case's, checked. Pure.

A brief is one page the product manager owns, in a fixed grammar (docs/mach-next/M16_DESIGN.md):

    # Brief: <title>
    ## Problem
    ## Who has it
    ## Outcomes
    - **O-1:** <what will be true>
      - How we would know: <a measure or an observable change>
    ## Not doing
    ## Assumptions
    - **A-1:** <statement> (assumed, not confirmed)
    - **A-2:** <statement> (confirmed by <who> on <YYYY-MM-DD>)
    ## Open questions
    ## Risks
    ## What it touches
    - Capabilities: <name> (EPIC-NNN), <name>
    - Shipped rules: SLICE-NNN/FR-NN, SLICE-NNN/INV-NN | None.

The case is the argument for it, as the customer would hear it, and the hardest questions with their answers:

    # Case: <title>
    ## As the customer would hear it
    <one to six sentences>
    ## Hard questions
    - **Q-1:** <question>
      - Answer: <the product manager's answer>
    - **Q-2:** <question>
      - Not answered: <why, on purpose>   (or "  - Not answered.")

Everything from outside is an input: the shipped rules (as the current-behaviour view lists them), the IDs a brief removed in
an earlier revision, and the brief's model for the case. This file reads nothing, runs nothing and writes nothing; it
checks structure and completeness, never scores an idea, and never recommends a verdict.

    analyze(text, shipped=None, removed_ids=())   -> (findings, model)
    analyze_case(text, brief=None)                -> (findings, model)

As a script: validate_brief.py brief <file> [--shipped <json>] [--removed O-2,A-1]; validate_brief.py case <file> [--brief <file>].
Standard library only, plus the intent skill's validate_slice.py (technology words, findings) and scan.py (secret shapes).
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple


def _intent_scripts() -> None:
    """The intent skill's scripts folder, whichever way MACH is installed; on the path so its pure checks load."""
    skills = Path(__file__).resolve().parent.parent.parent
    for name in ("mach-intent", "intent"):
        folder = skills / name / "scripts"
        if folder.is_dir():
            if str(folder) not in sys.path:
                sys.path.insert(0, str(folder))
            return
    raise ImportError(f"The MACH intent skill is not installed beside Product Studio ({skills}); checking a brief needs its validator.")


_intent_scripts()
import scan  # noqa: E402
import validate_slice  # noqa: E402

Finding = validate_slice.Finding
Report = validate_slice.Report

SECTIONS = ("Problem", "Who has it", "Outcomes", "Not doing", "Assumptions", "Open questions", "Risks", "What it touches")
REQUIRED = ("Problem", "Who has it", "Outcomes", "Assumptions", "What it touches")
NONE_ALLOWED = ("Not doing", "Assumptions", "Open questions", "Risks")
CASE_SECTIONS = ("As the customer would hear it", "Hard questions")

TITLE_RE = re.compile(r"^# Brief:[ \t]*(\S.*?)\s*$")
CASE_TITLE_RE = re.compile(r"^# Case:[ \t]*(\S.*?)\s*$")
HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.*?)\s*$")
OUTCOME_RE = re.compile(r"^- \*\*(O-[1-9][0-9]{0,3}):\*\*[ \t]+(\S.*?)\s*$")
HOW_RE = re.compile(r"^  - How we would know:[ \t]*(.*?)\s*$")
ASSUMPTION_RE = re.compile(r"^- \*\*(A-[1-9][0-9]{0,3}):\*\*[ \t]+(\S.*?)\s*$")
ASSUMED = "(assumed, not confirmed)"
CONFIRMED_RE = re.compile(r"\(confirmed by ([^()]{1,80}?) on ([0-9]{4}-[0-9]{2}-[0-9]{2})\)$")
QUESTION_RE = re.compile(r"^- \*\*(Q-[1-9][0-9]{0,2}):\*\*[ \t]+(\S.*?)\s*$")
ANSWER_RE = re.compile(r"^  - (Answer|Not answered)(?::[ \t]*(.*?)|\.)\s*$")
ID_LIKE_RE = re.compile(r"^- \*\*[A-Za-z]{1,3}[- ]?[0-9]")
ITEM_RE = re.compile(r"^- (\S.*?)\s*$")
CAPABILITIES_RE = re.compile(r"^- Capabilities:[ \t]*(.*?)\s*$")
RULES_RE = re.compile(r"^- Shipped rules:[ \t]*(.*?)\s*$")
CAPABILITY_RE = re.compile(r"^([^(),]{1,80}?)(?:[ \t]*\((EPIC-[0-9]{3,})\))?$")
SHIPPED_RULE_RE = re.compile(r"^SLICE-[0-9]{3,}/(?:INV-[0-9]{2,}|FR-[0-9]{2,}|R[0-9]+)$")
PLACEHOLDER_RE = re.compile(r"<[a-z][^<>]{0,80}>")
NONE_RE = re.compile(r"^\**\s*none\s*\.?\s*\**$", re.IGNORECASE)
REF_RE = re.compile(r"\b([OA]-[1-9][0-9]{0,3})\b")
SENTENCE_END_RE = re.compile(r"[.!?](?:[\"”’)]*)(?=\s|$)")
# Words that make a statement a guess. In the prose outside Assumptions they read as an assumption stated as a fact.
GUESS_RE = re.compile(r"(?<![\w-])(we assume|assum(?:e|es|ed|ing)|presumably|probably|we believe|we think|surely|obviously|everyone knows)(?![\w-])",
                      re.IGNORECASE)
# What a "how we would know" names when it names a measure or an observable change: a number, or one of these.
MEASURE_RE = re.compile(r"[0-9%]|(?<![\w-])(fall|falls|fell|rise|rises|drop|drops|grow|grows|fewer|more|less|under|over|at least|at most|none|"
                        r"no longer|every|each|all|percent|rate|count|counted|number of|share of|within|per|a week|a month|a day|a quarter|"
                        r"see|seen|observe|observed|report|reports|survey|complaints?|calls?|tickets?|time to|minutes?|hours?|days?)(?![\w-])",
                        re.IGNORECASE)
NOT_WRITTEN_RE = re.compile(r"(?:not written(?: yet)?|tbd|todo|to do|to be decided|unknown|none|n/a|\?+|-+|…|\.\.\.)\.?", re.IGNORECASE)
MAX_CUSTOMER_SENTENCES = 6
LINE_LIMIT = 2000


class Section:
    def __init__(self, title: str, line: int) -> None:
        self.title, self.line = title, line
        self.lines: List[Tuple[int, str]] = []

    def content(self) -> List[Tuple[int, str]]:
        return [(number, line) for number, line in self.lines if line.strip()]

    def text(self) -> str:
        return "\n".join(line for _, line in self.content())

    def is_none(self) -> bool:
        content = self.content()
        return len(content) == 1 and bool(NONE_RE.fullmatch(content[0][1].strip()))


def split(text: str, title_re: "re.Pattern[str]", known: Sequence[str], kind: str, report: Report) -> Tuple[Optional[str], Dict[str, Section]]:
    """The title and the `## ` sections, in the grammar's order. Anything else at heading level is refused."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    title: Optional[str] = None
    sections: Dict[str, Section] = {}
    current: Optional[Section] = None
    order: List[str] = []
    for number, line in enumerate(lines, start=1):
        if len(line) > LINE_LIMIT:
            report.error(number, f"{kind}-line-length", f"Line {number} is longer than {LINE_LIMIT} characters. Break it up.")
            line = line[:LINE_LIMIT]
        heading = HEADING_RE.match(line)
        if title is None and current is None:
            if not line.strip():
                continue
            found = title_re.match(line)
            if not found:
                report.error(number, f"{kind}-title", f"The {kind} must open with '# {kind.capitalize()}: <title>' on its first line.")
                title = ""
                if not heading:
                    continue
            else:
                title = found.group(1)
                continue
        if heading:
            name = heading.group(2).strip()
            if heading.group(1) != "##" or name not in known:
                report.error(number, f"{kind}-heading", f"'{line.strip()[:80]}' is not a section of the {kind}. Its sections are: "
                                                         + ", ".join(f"## {s}" for s in known) + ".")
                current = None
                continue
            if name in sections:
                report.error(number, f"{kind}-duplicate-section", f"## {name} appears twice. Keep one.")
                current = None
                continue
            if order and known.index(name) < known.index(order[-1]):
                report.error(number, f"{kind}-section-order", f"## {name} comes before ## {order[-1]} in the {kind}'s order.")
            current = Section(name, number)
            sections[name] = current
            order.append(name)
            continue
        if current is not None:
            current.lines.append((number, line))
        elif line.strip():
            report.error(number, f"{kind}-stray-text", f"Line {number} sits outside any section. Put it under one of the {kind}'s headings.")
    if title is None:
        report.error(0, f"{kind}-title", f"The {kind} is empty. It opens with '# {kind.capitalize()}: <title>'.")
    return title, sections


def check_ids(found: Sequence[Tuple[str, int]], removed: Set[str], report: Report) -> None:
    """IDs are unique and, once written in an earlier revision and taken out, never come back for something else."""
    seen: Dict[str, int] = {}
    last = {"O": 0, "A": 0, "Q": 0}
    for identifier, line in found:
        prefix, number = identifier.split("-")
        if identifier in seen:
            report.error(line, "brief-duplicate-id" if prefix != "Q" else "case-duplicate-id", f"{identifier} is already used on line {seen[identifier]}.")
            continue
        seen[identifier] = line
        if identifier in removed:
            report.error(line, "brief-id-reused", f"{identifier} was taken out of an earlier revision of this brief, so it may not name something "
                                                  f"new. Give this one the next free number.")
        if int(number) < last[prefix]:
            report.warning(line, "brief-id-order" if prefix != "Q" else "case-id-order", f"{identifier} comes after {prefix}-{last[prefix]}. Keep them in order.")
        last[prefix] = max(last[prefix], int(number))


def guesses(text: str) -> List[str]:
    return sorted({match.group(1).lower() for match in GUESS_RE.finditer(text)})


def secrets(text: str, kind: str, report: Report) -> None:
    for number, line in enumerate(text.replace("\r\n", "\n").split("\n"), start=1):
        kinds = scan.secrets_in_text(line[:LINE_LIMIT])
        if kinds:  # the kinds only, never the value
            report.error(number, f"{kind}-secret", f"Line {number} holds text shaped like a secret ({', '.join(kinds)}). Take it out; the {kind} is shared.")


def placeholders(section: Section, kind: str, report: Report) -> None:
    for number, line in section.content():
        if PLACEHOLDER_RE.search(line):
            report.error(number, f"{kind}-placeholder", f"Line {number} still holds a template placeholder ({PLACEHOLDER_RE.search(line).group(0)}). "
                                                        "Write it in your own words.")


def technology(label: str, text: str, line: int, report: Report, error: bool) -> None:
    words = validate_slice.implementation_words(text)
    if not words:
        return
    message = (f"{label} names technology ({', '.join(sorted(words))}). A brief says what will be true for people; "
               "how it is built is a decision for engineering (an ADR).")
    (report.error if error else report.warning)(line, "brief-technology", message)


def parse_outcomes(section: Section, report: Report) -> List[Dict[str, Any]]:
    outcomes: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    for number, line in section.content():
        found = OUTCOME_RE.match(line)
        how = HOW_RE.match(line)
        if found:
            current = {"id": found.group(1), "text": found.group(2), "how": None, "line": number, "how_line": None}
            outcomes.append(current)
        elif how and current is not None:
            if current["how_line"] is not None:
                report.error(number, "brief-outcome-line", f"{current['id']} has two 'How we would know' lines. Keep one.")
                continue
            current["how"], current["how_line"] = how.group(1), number
        elif ID_LIKE_RE.match(line):
            report.error(number, "brief-malformed-id", f"Line {number} does not name an outcome as '- **O-1:** <what will be true>'.")
            current = None
        else:
            report.error(number, "brief-outcome-line", "Each outcome is one line, '- **O-1:** <what will be true>', followed by "
                                                       "'  - How we would know: <a measure or an observable change>'.")
    if not outcomes:
        report.error(section.line, "brief-empty-section", "## Outcomes needs at least one '- **O-1:** ...' line.")
    for item in outcomes:
        if item["how"] and NOT_WRITTEN_RE.fullmatch(item["how"].strip()):
            item["how"] = None
        if not item["how"]:
            report.error(item["how_line"] or item["line"], "brief-outcome-how", f"{item['id']} has no way to know it happened. Say what you would see or count.")
        elif not MEASURE_RE.search(item["how"]):
            report.warning(item["how_line"], "brief-how-vague", f"{item['id']}'s 'how we would know' names no measure or observable change. "
                                                               "Say what you would count or see.")
        technology(item["id"], item["text"], item["line"], report, error=True)
        if item["how"]:
            technology(f"{item['id']}'s 'how we would know'", item["how"], item["how_line"], report, error=False)
    return outcomes


def parse_assumptions(section: Section, report: Report) -> List[Dict[str, Any]]:
    if section.is_none():
        return []
    found: List[Dict[str, Any]] = []
    for number, line in section.content():
        match = ASSUMPTION_RE.match(line)
        if not match:
            if ID_LIKE_RE.match(line):
                report.error(number, "brief-malformed-id", f"Line {number} does not name an assumption as '- **A-1:** <statement> (assumed, not confirmed)'.")
            else:
                report.error(number, "brief-assumption-line", "Each assumption is one line, '- **A-1:** <statement> (assumed, not confirmed)' or "
                                                              "'(confirmed by <who> on <YYYY-MM-DD>)'.")
            continue
        identifier, rest = match.groups()
        item: Dict[str, Any] = {"id": identifier, "line": number, "state": None, "by": None, "on": None}
        confirmed = CONFIRMED_RE.search(rest)
        if rest.endswith(ASSUMED):
            item.update(text=rest[:-len(ASSUMED)].strip(), state="assumed")
        elif confirmed:
            item.update(text=rest[:confirmed.start()].strip(), state="confirmed", by=confirmed.group(1).strip(), on=confirmed.group(2))
        else:
            item["text"] = rest
            report.error(number, "brief-assumption-state", f"{identifier} has no state. End it with '(assumed, not confirmed)', or "
                                                            "'(confirmed by <who> on <YYYY-MM-DD>)' once someone has confirmed it.")
        if not item["text"]:
            report.error(number, "brief-assumption-line", f"{identifier} states nothing.")
        found.append(item)
    if not found:
        report.error(section.line, "brief-empty-section", "## Assumptions lists each assumption as '- **A-1:** ...', or says 'None.'.")
    return found


def parse_touches(section: Section, shipped: Optional[Sequence[Dict[str, Any]]], report: Report) -> Dict[str, Any]:
    touches: Dict[str, Any] = {"capabilities": [], "shipped_rules": []}
    seen = {"capabilities": None, "rules": None}
    for number, line in section.content():
        caps, rules = CAPABILITIES_RE.match(line), RULES_RE.match(line)
        if caps:
            if seen["capabilities"] is not None:
                report.error(number, "brief-touches-line", "'- Capabilities:' appears twice. Keep one line.")
                continue
            seen["capabilities"] = number
            for part in [p.strip() for p in caps.group(1).split(",") if p.strip()]:
                found = CAPABILITY_RE.fullmatch(part)
                if not found or NONE_RE.fullmatch(part):
                    report.error(number, "brief-capability", f"'{part[:60]}' is not a capability's name, optionally followed by its epic, as 'Lending (EPIC-001)'.")
                    continue
                touches["capabilities"].append({"name": found.group(1).strip(), "epic_id": found.group(2)})
        elif rules:
            if seen["rules"] is not None:
                report.error(number, "brief-touches-line", "'- Shipped rules:' appears twice. Keep one line.")
                continue
            seen["rules"] = number
            value = rules.group(1).strip()
            if NONE_RE.fullmatch(value):
                continue
            for rule in [p.strip() for p in value.split(",")]:
                if not SHIPPED_RULE_RE.fullmatch(rule):
                    report.error(number, "brief-malformed-id", f"'{rule[:60]}' is not a shipped rule's ID, such as SLICE-004/FR-02.")
                elif rule in touches["shipped_rules"]:
                    report.warning(number, "brief-duplicate-rule", f"{rule} is listed twice.")
                else:
                    touches["shipped_rules"].append(rule)
                    if shipped is not None:
                        known = next((item for item in shipped if item.get("rule") == rule), None)
                        if known is None:
                            report.error(number, "brief-rule-not-shipped", f"{rule} is not in any shipped spec on the integration branch.")
                        elif not known.get("in_force"):
                            report.error(number, "brief-rule-not-in-force", f"{rule} has shipped but is no longer in force: a later slice changed it.")
        else:
            report.error(number, "brief-touches-line", "## What it touches holds two lines: '- Capabilities: <names>' and "
                                                       "'- Shipped rules: <SLICE-NNN/FR-NN, ...>' (or 'None.').")
    if seen["capabilities"] is None or not touches["capabilities"]:
        report.error(seen["capabilities"] or section.line, "brief-capability", "Name at least one capability the idea touches: '- Capabilities: <names>'.")
    if seen["rules"] is None:
        report.error(section.line, "brief-touches-line", "Say which shipped rules it touches: '- Shipped rules: SLICE-NNN/FR-NN, ...', or 'None.'.")
    return touches


def list_items(section: Optional[Section], kind: str, report: Report) -> List[str]:
    """A list section's items (open questions); [] for an absent section or 'None.'."""
    if section is None or section.is_none():
        return []
    items: List[str] = []
    for number, line in section.content():
        found = ITEM_RE.match(line)
        if found:
            items.append(found.group(1))
        elif line.startswith("  ") and items:
            items[-1] += " " + line.strip()
        else:
            report.error(number, f"{kind}-list-line", f"## {section.title} is a list: one '- ' line each, or 'None.'.")
    return items


def analyze(text: str, shipped: Optional[Sequence[Dict[str, Any]]] = None, removed_ids: Iterable[str] = ()) -> Tuple[List[Finding], Dict[str, Any]]:
    """Check a brief. `shipped` is the shipped rules as the current-behaviour view lists them ({rule, in_force, ...}); None skips the
    shipped-rule check (the engine always gives it). `removed_ids` are O-N and A-N IDs an earlier revision held and this one
    must not reuse. Returns the findings and the brief's model."""
    report = Report()
    title, sections = split(text, TITLE_RE, SECTIONS, "brief", report)
    for name in REQUIRED:
        if name not in sections:
            report.error(0, "brief-missing-section", f"## {name} is missing. Every brief has it.")
    for name, section in sections.items():
        if not section.content():
            report.error(section.line, "brief-empty-section", f"## {name} is empty." + (" Write 'None.' if there is nothing to say." if name in NONE_ALLOWED else ""))
        elif section.is_none() and name not in NONE_ALLOWED:
            report.error(section.line, "brief-empty-section", f"## {name} cannot be 'None.'. Every brief says it.")
        placeholders(section, "brief", report)
    outcomes = parse_outcomes(sections["Outcomes"], report) if sections.get("Outcomes") and sections["Outcomes"].content() else []
    assumptions = parse_assumptions(sections["Assumptions"], report) if sections.get("Assumptions") and sections["Assumptions"].content() else []
    touches = parse_touches(sections["What it touches"], shipped, report) if sections.get("What it touches") and sections["What it touches"].content() \
        else {"capabilities": [], "shipped_rules": []}
    questions = list_items(sections.get("Open questions"), "brief", report)
    for question in questions:
        report.warning(sections["Open questions"].line, "brief-open-question", f"An open question is still open: {question[:120]}")
    check_ids([(item["id"], item["line"]) for item in outcomes] + [(item["id"], item["line"]) for item in assumptions], set(removed_ids), report)
    prose = {name: sections[name] for name in ("Problem", "Who has it", "Not doing", "Risks") if name in sections and not sections[name].is_none()}
    for name, section in prose.items():
        technology(f"## {name}", section.text(), section.line, report, error=False)
    stated = dict(prose)
    if "Outcomes" in sections:
        stated["Outcomes"] = sections["Outcomes"]
    for name, section in stated.items():
        for number, line in section.content():
            words = guesses(line)
            if words:
                report.warning(number, "brief-hidden-assumption", f"Line {number} in ## {name} reads as an assumption ({', '.join(words)}). "
                                                                  "List it under ## Assumptions with its state.")
    for item in assumptions:
        text_of = (item.get("text") or "").strip().rstrip(".").lower()
        if len(text_of) >= 12:
            for name, section in stated.items():
                if text_of in section.text().lower():
                    report.warning(section.line, "brief-hidden-assumption", f"{item['id']} is stated as a fact in ## {name}. Keep it an assumption there.")
    secrets(text, "brief", report)
    model = {
        "title": title or None,
        "problem": sections["Problem"].text() if "Problem" in sections else None,
        "who_has_it": sections["Who has it"].text() if "Who has it" in sections else None,
        "outcomes": [{"id": o["id"], "text": o["text"], "how_we_would_know": o["how"], "line": o["line"]} for o in outcomes],
        "not_doing": None if "Not doing" not in sections or sections["Not doing"].is_none() else sections["Not doing"].text(),
        "assumptions": [{"id": a["id"], "text": a.get("text"), "state": a["state"], "confirmed_by": a["by"], "confirmed_on": a["on"], "line": a["line"]}
                        for a in assumptions],
        "open_questions": questions,
        "risks": None if "Risks" not in sections or sections["Risks"].is_none() else sections["Risks"].text(),
        "touches": touches,
        "sections": [name for name in SECTIONS if name in sections],
    }
    return report.findings, model


def analyze_case(text: str, brief: Optional[Dict[str, Any]] = None) -> Tuple[List[Finding], Dict[str, Any]]:
    """Check a case. `brief` is the brief's model (from analyze), so a question that names an outcome or assumption the brief
    does not hold is caught. The case has its sentences, and every hard question is answered or marked not answered on purpose."""
    report = Report()
    title, sections = split(text, CASE_TITLE_RE, CASE_SECTIONS, "case", report)
    for name in CASE_SECTIONS:
        if name not in sections:
            report.error(0, "case-missing-section", f"## {name} is missing. Every case has it.")
    customer = sections.get("As the customer would hear it")
    sentences = 0
    if customer is not None:
        placeholders(customer, "case", report)
        said = " ".join(line.strip() for _, line in customer.content())
        sentences = len(SENTENCE_END_RE.findall(said))
        if not said or NONE_RE.fullmatch(said):
            report.error(customer.line, "case-sentences", "Say the case in a few sentences, as the customer would hear it.")
        elif sentences == 0:
            report.error(customer.line, "case-sentences", "The case as the customer would hear it is not written as sentences. End each with a full stop.")
        elif sentences > MAX_CUSTOMER_SENTENCES:
            report.error(customer.line, "case-sentences", f"The case as the customer would hear it runs to {sentences} sentences. "
                                                          f"Say it in at most {MAX_CUSTOMER_SENTENCES}.")
        if said:
            words = validate_slice.implementation_words(said)
            if words:
                report.warning(customer.line, "case-technology", f"The case names technology ({', '.join(sorted(words))}). Say it as the customer would hear it.")
    questions: List[Dict[str, Any]] = []
    hard = sections.get("Hard questions")
    if hard is not None:
        placeholders(hard, "case", report)
        current: Optional[Dict[str, Any]] = None
        for number, line in hard.content():
            asked, answer = QUESTION_RE.match(line), ANSWER_RE.match(line)
            if asked:
                current = {"id": asked.group(1), "question": asked.group(2), "answer": None, "state": None, "line": number}
                questions.append(current)
            elif answer and current is not None:
                if current["state"] is not None:
                    report.error(number, "case-answer-line", f"{current['id']} has two answers. Keep one.")
                    continue
                state = "answered" if answer.group(1) == "Answer" else "not_answered"
                value = (answer.group(2) or "").strip()
                if state == "answered" and not value:
                    report.error(number, "case-unanswered", f"{current['id']}'s answer is empty. Answer it, or mark it '  - Not answered: <why>'.")
                current.update(state=state, answer=value or None)
            elif ID_LIKE_RE.match(line):
                report.error(number, "case-malformed-id", f"Line {number} does not name a question as '- **Q-1:** <question>'.")
                current = None
            else:
                report.error(number, "case-question-line", "Each hard question is '- **Q-1:** <question>', followed by '  - Answer: <answer>' or "
                                                           "'  - Not answered: <why>'.")
        if not questions:
            report.error(hard.line, "case-empty-section", "## Hard questions needs at least one '- **Q-1:** ...' with its answer.")
        for item in questions:
            if item["state"] is None:
                report.error(item["line"], "case-unanswered", f"{item['id']} is not answered yet. Answer it, or mark it '  - Not answered: <why>' on purpose.")
        check_ids([(item["id"], item["line"]) for item in questions], set(), report)
        if brief is not None:
            known = {o["id"] for o in brief.get("outcomes") or []} | {a["id"] for a in brief.get("assumptions") or []}
            for item in questions:
                for ref in sorted(set(REF_RE.findall(f"{item['question']} {item['answer'] or ''}")) - known):
                    report.warning(item["line"], "case-unknown-id", f"{item['id']} names {ref}, which the brief does not hold.")
    secrets(text, "case", report)
    model = {"title": title or None, "customer_sentences": sentences,
             "questions": [{k: item[k] for k in ("id", "question", "state", "answer", "line")} for item in questions],
             "answered": sum(1 for item in questions if item["state"] == "answered"),
             "not_answered": sum(1 for item in questions if item["state"] == "not_answered"),
             "open": sum(1 for item in questions if item["state"] is None)}
    return report.findings, model


def as_rows(findings: Sequence[Finding]) -> List[Dict[str, Any]]:
    return [{"severity": f.severity, "rule": f.rule, "line": f.line or None, "message": f.message} for f in findings]


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Check a Shape brief or case against its grammar (reads only)")
    sub = parser.add_subparsers(dest="kind", required=True)
    p = sub.add_parser("brief")
    p.add_argument("file", type=Path)
    p.add_argument("--shipped", type=Path, help="a JSON file: the shipped rules as the current-behaviour view lists them ({rules: [...]})")
    p.add_argument("--removed", default="", help="IDs an earlier revision held and this one may not reuse, such as O-2,A-1")
    p = sub.add_parser("case")
    p.add_argument("file", type=Path)
    p.add_argument("--brief", type=Path, help="the brief, so the case's references to O-N and A-N are checked")
    args = parser.parse_args(argv)
    text = args.file.read_text(encoding="utf-8")
    if args.kind == "brief":
        shipped = None
        if args.shipped:
            data = json.loads(args.shipped.read_text(encoding="utf-8"))
            shipped = data.get("rules") if isinstance(data, dict) else data
        findings, model = analyze(text, shipped, [part.strip() for part in args.removed.split(",") if part.strip()])
    else:
        brief = analyze(args.brief.read_text(encoding="utf-8"))[1] if args.brief else None
        findings, model = analyze_case(text, brief)
    print(json.dumps({"valid": not any(f.severity == "error" for f in findings), "findings": as_rows(findings), "model": model}, indent=2, ensure_ascii=False))
    return 0 if not any(f.severity == "error" for f in findings) else 1


if __name__ == "__main__":
    import contextlib as _c, os as _o, runpy as _r  # MACH records an internal error for /mach report (skills/intent/scripts/faults.py)
    with _c.suppress(Exception): _r.run_path(next(p for p in (_o.path.join(_o.path.abspath(__file__).rsplit(_o.sep, 3)[0], d, "scripts", "faults.py") for d in ("intent", "mach-intent")) if _o.path.isfile(p)))["install"](__file__)
    sys.exit(main())
