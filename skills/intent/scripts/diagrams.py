#!/usr/bin/env python3
"""Mermaid diagrams in the Markdown an agent writes for engineers: a plan, and an ADR a ticket proposes.

A diagram is allowed only where a picture carries the decision: component boundaries, a data flow, a sequence, a
state machine, a data model. Slice specs carry none (the decision table and the requirements are the authority, and
Product Studio does not draw Markdown). GitHub draws a ```mermaid block in a Markdown file and a pull request, so an
ADR's diagram is seen where ADRs are read.

Standard-library Python cannot parse Mermaid. `problems` checks what a script can: each block is closed, opens with a
kind MACH allows, is small enough to read, carries no link, script hook or renderer directive, and the document has
few of them. A diagram that passes can still be drawn wrongly; the reviewers read it as they read the prose.

ADRs people write are theirs: these checks apply to what an agent wrote, never to an ADR on the main branch."""
from __future__ import annotations

import re
from typing import List, Sequence, Tuple

KINDS = ("flowchart", "graph", "sequenceDiagram", "stateDiagram-v2", "stateDiagram", "erDiagram", "classDiagram")
MAX_DIAGRAMS = 2
MAX_LINES = 40
MAX_LINE_CHARS = 200
OPEN_RE = re.compile(r"^\s*(```+|~~~+)\s*mermaid\s*$", re.IGNORECASE)
FENCE_RE = re.compile(r"^\s*(```+|~~~+)")
# A link, a script hook, or a directive that reconfigures the renderer: none belongs in a decision's picture.
FORBIDDEN = (
    (re.compile(r"^\s*click\s", re.IGNORECASE), "a click action"),
    (re.compile(r"%%\s*\{"), "a renderer directive (%%{ ... }%%)"),
    (re.compile(r"https?://|javascript:", re.IGNORECASE), "a link"),
    (re.compile(r"<\s*(script|img|iframe|a)\b", re.IGNORECASE), "HTML other than a line break"),
)
WHEN = ("A diagram belongs only where the structure or the sequence is the decision (component boundaries, a data flow, a sequence between "
        "parts, a state machine, a data model); everything else is prose.")


def blocks(text: str) -> Tuple[List[Tuple[int, List[str]]], List[int]]:
    """Every ```mermaid block as (line number of its opening fence, its lines), and the opening lines of blocks never closed."""
    found: List[Tuple[int, List[str]]] = []
    unclosed: List[int] = []
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        opened = OPEN_RE.match(lines[index])
        other = None if opened else FENCE_RE.match(lines[index])
        if not opened and not other:
            index += 1
            continue
        marker = (opened or other).group(1)
        close = re.compile(r"^\s*" + re.escape(marker[0]) + "{" + str(len(marker)) + r",}\s*$")
        body: List[str] = []
        cursor = index + 1
        while cursor < len(lines) and not close.match(lines[cursor]):
            body.append(lines[cursor])
            cursor += 1
        if opened:
            if cursor >= len(lines):
                unclosed.append(index + 1)
            else:
                found.append((index + 1, body))
        index = cursor + 1
    return found, unclosed


def kind_of(body: Sequence[str]) -> str:
    """The diagram's kind: the first word of its first line that is not blank or a comment."""
    for line in body:
        bare = line.strip()
        if bare and not bare.startswith("%%"):
            return bare.split()[0].rstrip(";")
    return ""


def problems(text: str, where: str = "") -> List[str]:
    """What is wrong with the Mermaid diagrams in `text`, in plain words; empty when there is none or all are in order."""
    prefix = f"{where}: " if where else ""
    found, unclosed = blocks(text)
    out = [f"{prefix}line {line}: the mermaid block is never closed; end it with a line of ```" for line in unclosed]
    if len(found) + len(unclosed) > MAX_DIAGRAMS:
        out.append(f"{prefix}{len(found) + len(unclosed)} diagrams, and at most {MAX_DIAGRAMS} are allowed in one document. {WHEN}")
    for line, body in found:
        kind = kind_of(body)
        at = f"{prefix}the diagram at line {line}"
        if not kind:
            out.append(f"{at} is empty")
            continue
        if kind not in KINDS:
            out.append(f"{at} opens with '{kind[:40]}', which is not a kind MACH allows ({', '.join(KINDS)})")
        meaningful = [item for item in body if item.strip()]
        if len(meaningful) > MAX_LINES:
            out.append(f"{at} has {len(meaningful)} lines, and at most {MAX_LINES} are allowed: draw the part that carries the decision, and say the rest in prose")
        if any(len(item) > MAX_LINE_CHARS for item in body):
            out.append(f"{at} has a line over {MAX_LINE_CHARS} characters")
        for pattern, what in FORBIDDEN:
            if any(pattern.search(item) for item in body):
                out.append(f"{at} carries {what}, which a diagram in a plan or an ADR never does")
    return out
