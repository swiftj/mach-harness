"""The smallest honest ADR baseline for a test project, kept in one place.

No ticket is planned until every required topic has an accepted ADR on the main branch (adr.baseline_stop). The
shared test projects plan and build, so they carry one accepted decision that covers the six default topics and
says what these projects really are: Python with the standard library, unittest, no data kept, never deployed. It is
numbered 0000 so the ADR numbers a test expects for its own decisions are unchanged.
"""

from pathlib import Path
from typing import Dict

FILE = "docs/adr/0000-test-project-baseline.md"
TOPICS = ("language", "framework", "storage", "testing", "deployment", "coding-standards")
TEXT = "\n".join([
    "---", "status: accepted", "date: 2026-11-18", "applies-to:", *[f"  - topic:{topic}" for topic in TOPICS], "---", "",
    "# Test project: Python standard library, unittest, no storage, not deployed", "",
    "## Context and Problem Statement", "", "A throwaway project made by a test needs its basic technical decisions written down before it is planned.", "",
    "## Decision Outcome", "",
    "Python 3 with the standard library only and no framework; tests use unittest under tests/; the project keeps no data and is never "
    "deployed; the code follows PEP 8.", "",
])


def files() -> Dict[str, str]:
    """{path: text} to add to a test project's first commit."""
    return {FILE: TEXT}


def write(project: Path) -> None:
    """Write the baseline into a project's working tree; the caller commits it with the rest."""
    path = Path(project) / FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(TEXT, encoding="utf-8")
