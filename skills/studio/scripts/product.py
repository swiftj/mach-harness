#!/usr/bin/env python3
"""MACH Product structural validator (Python 3.8+; standard library only).

Checks the shape of the product artifacts (project, epics, slice work orders) and
how they refer to each other. It is NOT a replacement for the intent, plan, audit or review gates:
the slice spec itself is judged by the intent skill's validate_slice.py, which studio.py calls.
A successful structural report MUST NOT authorize Factory execution.

Usage: product.py --project <folder holding product/> [--policy]
"""

import argparse
import datetime
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional, Sequence, Tuple

PROJECT_RE = re.compile(r"^[a-z][a-z0-9-]{1,63}$")


def project_id_from(name: Any) -> str:
    """The project's ID, made from the product's name and always one PROJECT_RE accepts: the name's letters and digits in
    lower case, joined by hyphens. A name that starts with a digit, is one character long or has no letters or digits at all
    gets "project" in front, and a long one is cut. It names files and marks the project's issue; a person never types it."""
    text = unicodedata.normalize("NFKD", str(name or "")).encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    if len(text) < 2 or not text[0].isalpha():
        text = f"project-{text}".rstrip("-")
    text = text[:64].rstrip("-")
    return text if PROJECT_RE.fullmatch(text) else "project"
EPIC_RE = re.compile(r"^EPIC-[0-9]{3,}$")
SLICE_RE = re.compile(r"^SLICE-[0-9]{3,}$")
HEX_RE = re.compile(r"^[a-f0-9]{64}$")
# The same file-name rule as skills/intent/scripts/validate_slice.py (FILENAME_RE), which stays authoritative.
SPEC_NAME_RE = re.compile(r"^(SLICE-[0-9]{3,})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$")
TIMESTAMP_RE = re.compile(r"^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$")

SHAPES = {
    "project": ("schema_version", "project_id", "name", "revision", "status", "vision", "outcomes"),
    "epic": ("schema_version", "epic_id", "project_id", "revision", "title", "status", "acceptance_criteria"),
    "slice": ("schema_version", "slice_id", "project_id", "epic_id", "revision", "title", "status", "dependencies", "open_questions", "spec_path", "spec_sha256"),
}
# Fields an artifact may carry or leave out. A slice without them is byte-for-byte what it was before.
OPTIONAL = {"slice": ("origin", "source", "tracking", "mocks", "serves", "kind", "small", "widened"), "epic": ("tracking", "serves")}
# A small change (M18): kind "small", what it changes, and when it left the light path. The same rule forms as the intent
# skill's small.py (SHIPPED_RULE_RE, RULES), which stays authoritative.
SMALL_CHANGES = ("fix", "adjustment")
SHIPPED_RULE_RE = re.compile(r"^SLICE-[0-9]{3,}/(?:(?:INV|FR)-[0-9]{2,}|R[0-9]+)$")
SMALL_RULE_RE = re.compile(r"^[a-z]+(?:-[a-z]+)*$")
# The idea and its outcomes an epic or a slice made by Shape's `idea apply` serves (M16 B): identifiers only, never the brief.
IDEA_RE = re.compile(r"^IDEA-[0-9]{3,}$")
OUTCOME_RE = re.compile(r"^O-[1-9][0-9]{0,3}$")
# A slice's design mocks (M14 C): up to four pictures by SHA-256, the same form as issue_rules.mock_problems, which stays authoritative.
MOCK_KEYS = {"sha256", "format", "width", "height", "bytes", "for", "binding", "note"}
SCENARIO_RE = re.compile(r"^AC-[0-9]{2,}$")
# The Jira issue a slice or epic belongs to (M13 E): {"jira": KEY}, the same form as issue_rules.JIRA_KEY_RE, which stays authoritative.
JIRA_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,31}-[1-9][0-9]{0,8}$")
# Where a slice came from (M8): identifiers only, never an issue's text, link or author.
ORIGIN_KINDS = ("github_issue",)
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$")
# The PRD a slice was made from (M13 D): identifiers and numbers only, never the document's text.
PRD_RE = re.compile(r"^PRD-[0-9]{2,}$")
MAP_SLICE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9-]{0,31}$")
ENUMS = {
    "project": {"status": ("draft", "active", "archived")},
    "epic": {"status": ("open", "deferred")},  # an epic is a container for slices: in the project, or set aside
    "slice": {"status": ("draft", "interviewing", "ready_for_approval", "approved_for_engineering", "superseded")},
}


MAX_JSON_BYTES = 1024 * 1024  # a product JSON file larger than this is refused as invalid, never parsed


def _error(errors: List[str], location: str, message: str) -> None:
    errors.append("{}: {}".format(location, message))


def _read_json(path: Path, errors: List[str], root: Path) -> Optional[Dict[str, Any]]:
    location = str(path.relative_to(root))
    try:
        if path.is_symlink():
            raise ValueError("symlink not permitted")
        if path.stat().st_size > MAX_JSON_BYTES:
            raise ValueError("larger than {} bytes; not read".format(MAX_JSON_BYTES))
        raw = path.read_text(encoding="utf-8")
        try:
            data = json.loads(raw)
        except RecursionError:
            raise ValueError("nested too deeply to be a product file") from None
        if not isinstance(data, dict):
            raise ValueError("expected JSON object")
        return data
    except (OSError, UnicodeError, ValueError) as exc:
        _error(errors, location, str(exc))
        return None


def _is_timestamp(value: Any) -> bool:
    """True for an RFC 3339 date-time with a zone."""
    match = TIMESTAMP_RE.fullmatch(value) if isinstance(value, str) else None
    if not match:
        return False
    try:
        datetime.datetime.strptime(match.group(1) + " " + match.group(2), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return False
    zone = match.group(3)
    return zone == "Z" or (int(zone[1:3]) < 24 and int(zone[4:6]) < 60)


def _is_origin(value: Any) -> bool:
    return (isinstance(value, dict) and set(value) == {"kind", "repository", "number"} and value.get("kind") in ORIGIN_KINDS
            and isinstance(value.get("repository"), str) and bool(REPOSITORY_RE.fullmatch(value["repository"]))
            and type(value.get("number")) is int and value["number"] >= 1)


def _is_source(value: Any) -> bool:
    if not (isinstance(value, dict) and set(value) == {"kind", "prd_id", "sha256", "lines", "map_slice"} and value.get("kind") == "prd"):
        return False
    lines = value.get("lines")
    return (isinstance(value.get("prd_id"), str) and bool(PRD_RE.fullmatch(value["prd_id"]))
            and isinstance(value.get("sha256"), str) and bool(HEX_RE.fullmatch(value["sha256"]))
            and isinstance(value.get("map_slice"), str) and bool(MAP_SLICE_RE.fullmatch(value["map_slice"]))
            and isinstance(lines, list) and 1 <= len(lines) <= 200
            and all(isinstance(r, list) and len(r) == 2 and all(type(n) is int for n in r) and 1 <= r[0] <= r[1] for r in lines))


def _is_serves(value: Any) -> bool:
    if not (isinstance(value, dict) and set(value) == {"idea", "outcomes"} and isinstance(value["idea"], str) and IDEA_RE.fullmatch(value["idea"])):
        return False
    outcomes = value["outcomes"]
    return (isinstance(outcomes, list) and 1 <= len(outcomes) <= 50 and all(isinstance(o, str) and OUTCOME_RE.fullmatch(o) for o in outcomes)
            and outcomes == sorted(set(outcomes), key=lambda o: int(o[2:])))


def _is_small(value: Any) -> bool:
    if not (isinstance(value, dict) and set(value) == {"change", "shipped_rule"} and value["change"] in SMALL_CHANGES):
        return False
    rule = value["shipped_rule"]
    return rule is None if value["change"] == "adjustment" else isinstance(rule, str) and bool(SHIPPED_RULE_RE.fullmatch(rule))


def _is_widened(value: Any) -> bool:
    return (isinstance(value, dict) and set(value) == {"at", "reason", "rule"} and _is_timestamp(value["at"])
            and isinstance(value["reason"], str) and 0 < len(value["reason"].strip()) <= 1000
            and (value["rule"] is None or (isinstance(value["rule"], str) and bool(SMALL_RULE_RE.fullmatch(value["rule"])))))


def _is_mocks(value: Any) -> bool:
    if not isinstance(value, list) or not 1 <= len(value) <= 4:
        return False
    for item in value:
        if not (isinstance(item, dict) and set(item) == MOCK_KEYS and isinstance(item["sha256"], str) and HEX_RE.fullmatch(item["sha256"])
                and item["format"] in ("png", "jpeg") and all(type(item[key]) is int and item[key] >= 1 for key in ("width", "height", "bytes"))
                and (item["for"] is None or (isinstance(item["for"], str) and SCENARIO_RE.fullmatch(item["for"])))
                and type(item["binding"]) is bool and not (item["binding"] and item["for"] is None)
                and (item["note"] is None or (isinstance(item["note"], str) and 0 < len(item["note"]) <= 200))):
            return False
    names = [item["sha256"] for item in value]
    return names == sorted(set(names))


def _shape(kind: str, data: Dict[str, Any], location: str, errors: List[str]) -> None:
    required = set(SHAPES[kind])
    for key in sorted(required - set(data)):
        _error(errors, location, "missing field '{}'".format(key))
    for key in sorted(set(data) - required - set(OPTIONAL.get(kind, ()))):
        _error(errors, location, "unexpected field '{}'".format(key))
    if type(data.get("schema_version")) is not int or data["schema_version"] != 1:
        _error(errors, location, "schema_version must be integer 1")
    if type(data.get("revision")) is not int or data["revision"] < 1:
        _error(errors, location, "revision must be a positive integer")
    for key in ("project_id", "epic_id", "slice_id"):
        if key in required:
            rule = {"project_id": PROJECT_RE, "epic_id": EPIC_RE, "slice_id": SLICE_RE}[key]
            if not isinstance(data.get(key), str) or not rule.fullmatch(data[key]):
                _error(errors, location, "invalid {}".format(key))
    for key in ("name", "title", "vision"):
        if key in required and (not isinstance(data.get(key), str) or not data[key].strip()):
            _error(errors, location, "{} must be nonempty text".format(key))
    for key, allowed in ENUMS[kind].items():
        if data.get(key) not in allowed:
            _error(errors, location, "invalid {}".format(key))
    for key in ("outcomes", "acceptance_criteria", "dependencies", "open_questions"):
        if key in required:
            items = data.get(key)
            if not isinstance(items, list) or any(not isinstance(x, str) or not x.strip() for x in items):
                _error(errors, location, "{} must be a list of nonempty strings".format(key))
            elif key == "dependencies" and len(items) != len(set(items)):
                _error(errors, location, "{} contains duplicate IDs".format(key))
            elif key == "outcomes" and not items:
                _error(errors, location, "outcomes must not be empty")
    if kind == "slice":
        path, digest = data.get("spec_path"), data.get("spec_sha256")
        if path is not None and not isinstance(path, str):
            _error(errors, location, "spec_path must be text or null")
        if digest is not None and (not isinstance(digest, str) or not HEX_RE.fullmatch(digest)):
            _error(errors, location, "spec_sha256 must be lowercase 64-character SHA-256 or null")
        if "origin" in data and not _is_origin(data["origin"]):
            _error(errors, location, "origin must be {kind: github_issue, repository: OWNER/REPO, number: a positive integer}")
        if "source" in data and not _is_source(data["source"]):
            _error(errors, location, "source must be {kind: prd, prd_id: PRD-NN, sha256, lines: [[first, last], ...], map_slice}")
        if "mocks" in data and not _is_mocks(data["mocks"]):
            _error(errors, location, "mocks must be 1 to 4 pictures in SHA-256 order, each {sha256, format: png or jpeg, width, height, bytes, for, binding, note}")
        if ("kind" in data or "small" in data or "widened" in data) and (data.get("kind") != "small" or "small" not in data):
            _error(errors, location, "a small change has kind 'small' and its small record; widened only with them")
        if "small" in data and not _is_small(data["small"]):
            _error(errors, location, "small must be {change: fix with shipped_rule SLICE-NNN/FR-NN, or adjustment with shipped_rule null}")
        if "widened" in data and not _is_widened(data["widened"]):
            _error(errors, location, "widened must be {at: a date-time, reason: nonempty text, rule: a rule code or null}")
    if "serves" in data and not _is_serves(data["serves"]):
        _error(errors, location, "serves must be {idea: IDEA-NNN, outcomes: [O-N, ...] in order, each once}")
    if "tracking" in data and not (isinstance(data["tracking"], dict) and set(data["tracking"]) == {"jira"}
                                    and isinstance(data["tracking"]["jira"], str) and JIRA_RE.fullmatch(data["tracking"]["jira"])):
        _error(errors, location, "tracking must be {jira: a Jira issue key such as ABC-123}")


PRINCIPLE_RE = re.compile(r"^PP-[0-9]{2,}$")
PRINCIPLE_FIELDS = ("id", "title", "statement", "reason", "status", "revision")
PRINCIPLE_STATUSES = ("active", "retired")


def _project_list(data: Optional[Dict[str, Any]], project_id: Any, errors: List[str], key: str, also: Sequence[str] = ()) -> Optional[List[Any]]:
    """The frame product/principles.json (M13) and product/needs.json (M17) share: exactly schema_version 1, the project's
    ID, the list under `key` and the lists named in `also`. The list, or None when the frame is wrong."""
    location = "product/{}.json".format(key)
    if data is None:
        return None
    if set(data) != {"schema_version", "project_id", key, *also} or data.get("schema_version") != 1:
        _error(errors, location, "must hold exactly schema_version 1, project_id and " + " and ".join((key,) + tuple(also)))
        return None
    if data.get("project_id") != project_id:
        _error(errors, location, "project_id does not match project.json")
    for name in (key,) + tuple(also):
        if not isinstance(data.get(name), list):
            _error(errors, location, "{} must be a list".format(name))
            return None
    return data[key]


def _principles(data: Optional[Dict[str, Any]], project_id: Any, errors: List[str]) -> None:
    """product/principles.json (M13): the project's product principles, PP-NN, each active or retired."""
    location = "product/principles.json"
    items = _project_list(data, project_id, errors, "principles")
    if items is None:
        return
    seen = set()
    for item in items:
        ident = item.get("id") if isinstance(item, dict) else None
        if not isinstance(item, dict) or set(item) != set(PRINCIPLE_FIELDS) or not isinstance(ident, str) or not PRINCIPLE_RE.fullmatch(ident):
            _error(errors, location, "each principle needs exactly: " + ", ".join(PRINCIPLE_FIELDS))
            continue
        if ident in seen:
            _error(errors, location, "duplicate principle {}".format(ident))
        seen.add(ident)
        if item["status"] not in PRINCIPLE_STATUSES or type(item["revision"]) is not int or item["revision"] < 1:
            _error(errors, location, "{} needs status active or retired and a positive revision".format(ident))
        for key in ("title", "statement", "reason"):
            if not isinstance(item[key], str) or not item[key].strip():
                _error(errors, location, "{} {} must be nonempty text".format(ident, key))


NEED_RE = re.compile(r"^TN-[0-9]{2,}$")
NEED_FIELDS = ("need_id", "kind", "statement", "why", "status", "revision")
NEED_GIVEN_FIELDS = ("said_by", "said_on")
NEED_KINDS = ("people", "data", "connections", "never", "priority", "given")


def _needs(data: Optional[Dict[str, Any]], project_id: Any, errors: List[str]) -> None:
    """product/needs.json (M17): the project's technical needs, TN-NN, each of a fixed kind and active or retired; a given
    also says who said it and when. `none` lists the kinds answered "nothing to say"."""
    location = "product/needs.json"
    items = _project_list(data, project_id, errors, "needs", ("none",))
    if items is None:
        return
    seen = set()
    for item in items:
        ident = item.get("need_id") if isinstance(item, dict) else None
        fields = NEED_FIELDS + (NEED_GIVEN_FIELDS if isinstance(item, dict) and item.get("kind") == "given" else ())
        if not isinstance(item, dict) or set(item) != set(fields) or not isinstance(ident, str) or not NEED_RE.fullmatch(ident):
            _error(errors, location, "each need needs exactly: " + ", ".join(fields))
            continue
        if ident in seen:
            _error(errors, location, "duplicate need {}".format(ident))
        seen.add(ident)
        if item["kind"] not in NEED_KINDS:
            _error(errors, location, "{} kind must be one of {}".format(ident, ", ".join(NEED_KINDS)))
        if item["status"] not in PRINCIPLE_STATUSES or type(item["revision"]) is not int or item["revision"] < 1:
            _error(errors, location, "{} needs status active or retired and a positive revision".format(ident))
        for key in ("statement", "why") + (NEED_GIVEN_FIELDS if item["kind"] == "given" else ()):
            if not isinstance(item[key], str) or not item[key].strip():
                _error(errors, location, "{} {} must be nonempty text".format(ident, key))
    none = data["none"] if isinstance(data, dict) else []
    if any(kind not in NEED_KINDS for kind in none) or len(set(none)) != len(none):
        _error(errors, location, "none must list distinct kinds: " + ", ".join(NEED_KINDS))


def _safe_spec(root: Path, value: str, slice_id: str) -> Tuple[Optional[Path], Optional[str]]:
    if "\\" in value or "\x00" in value or "//" in value:
        return None, "unsafe spec_path"
    parts = value.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return None, "unsafe spec_path"
    path = PurePosixPath(value)
    if path.is_absolute() or len(path.parts) != 3 or path.parts[:2] != ("specs", "slices"):
        return None, "spec_path must point into specs/slices/"
    name = SPEC_NAME_RE.fullmatch(path.name)
    if not name or name.group(1) != slice_id:
        return None, "spec_path must match the slice ID and MACH spec naming convention"
    resolved = (root / value).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        return None, "spec_path escapes project root"
    if (root / value).is_symlink() or not resolved.is_file():
        return None, "spec_path must be a real existing file (not a symlink)"
    return resolved, None


def _files(directory: Path, prefix: str) -> List[Path]:
    if not directory.exists():
        return []
    return sorted(directory.glob(prefix))


def _cycle_nodes(graph: Dict[str, List[str]]) -> List[str]:
    visiting = set()
    visited = set()
    cycle = []

    def visit(node: str, stack: List[str]) -> None:
        if cycle or node in visited:
            return
        if node in visiting:
            cycle.extend(stack[stack.index(node):] + [node])
            return
        visiting.add(node)
        for dep in graph.get(node, []):
            if dep in graph:
                visit(dep, stack + [dep])
        visiting.remove(node)
        visited.add(node)

    for node in sorted(graph):
        visit(node, [node])
        if cycle:
            break
    return cycle


def validate_workspace(root: Path) -> Dict[str, Any]:
    """Only structural validation. Never returns Factory authorization."""
    root = Path(root).resolve()
    errors = []  # type: List[str]
    project_path = root / "product" / "project.json"
    if (root / "product").is_symlink():
        # A linked product folder could point outside the repository, where nothing is versioned.
        return {
            "valid": False,
            "validation_scope": "structural_only",
            "factory_authorized": False,
            "project_id": None,
            "counts": {"epics": 0, "slices": 0},
            "errors": ["product: symlinked artifact directory is not permitted"],
        }
    project = _read_json(project_path, errors, root)
    if project is not None:
        _shape("project", project, "product/project.json", errors)
    project_id = project.get("project_id") if project else None
    revision = project.get("revision") if project else None
    docs = {}
    for kind, directory, pattern, key, identifier_rule in (
        ("epic", "epics", "EPIC-*.json", "epic_id", EPIC_RE),
        ("slice", "slices", "SLICE-*.json", "slice_id", SLICE_RE),
    ):
        entries = {}  # type: Dict[str, Dict[str, Any]]
        folder = root / "product" / directory
        if folder.is_symlink():
            _error(errors, str(folder.relative_to(root)), "symlinked artifact directory is not permitted")
            continue
        for path in _files(folder, pattern):
            location = str(path.relative_to(root))
            data = _read_json(path, errors, root)
            if data is None:
                continue
            _shape(kind, data, location, errors)
            identifier = data.get(key)
            if not isinstance(identifier, str) or not identifier_rule.fullmatch(identifier):
                continue
            if path.stem != identifier:
                _error(errors, location, "filename must match {}".format(key))
            if identifier in entries:
                _error(errors, location, "duplicate {}".format(key))
            entries[identifier] = data
            if data.get("project_id") != project_id:
                _error(errors, location, "project_id does not match project.json")
        docs[kind] = entries
    epics = docs.get("epic", {})
    slices = docs.get("slice", {})
    graph = {}
    for slice_id, entry in sorted(slices.items()):
        loc = "product/slices/{}.json".format(slice_id)
        epic_id = entry.get("epic_id")
        if not isinstance(epic_id, str) or epic_id not in epics:
            _error(errors, loc, "epic_id is unknown")
        deps = entry.get("dependencies")
        deps = deps if isinstance(deps, list) else []
        graph[slice_id] = [dep for dep in deps if isinstance(dep, str)]
        for dep in deps:
            if not isinstance(dep, str) or dep not in slices:
                _error(errors, loc, "unknown dependency '{}'".format(dep))
            if dep == slice_id:
                _error(errors, loc, "self-dependency")
        if entry.get("status") == "approved_for_engineering":
            if entry.get("open_questions") != []:
                _error(errors, loc, "approved slice must have no open questions")
            spec_path = entry.get("spec_path")
            spec_sha = entry.get("spec_sha256")
            if not isinstance(spec_path, str) or not isinstance(spec_sha, str) or not HEX_RE.fullmatch(spec_sha):
                _error(errors, loc, "approved slice needs spec_path and spec_sha256")
            else:
                target, issue = _safe_spec(root, spec_path, slice_id)
                if issue:
                    _error(errors, loc, issue)
                elif hashlib.sha256(target.read_bytes()).hexdigest() != spec_sha:
                    _error(errors, loc, "spec_sha256 does not match spec content")
    cycle = _cycle_nodes(graph)
    if cycle:
        _error(errors, "product/slices", "dependency cycle: {}".format(" -> ".join(cycle)))
    principles_path = root / "product" / "principles.json"
    if principles_path.exists() or principles_path.is_symlink():
        _principles(_read_json(principles_path, errors, root), project_id, errors)
    needs_path = root / "product" / "needs.json"
    if needs_path.exists() or needs_path.is_symlink():
        _needs(_read_json(needs_path, errors, root), project_id, errors)
    return {
        "valid": not errors,
        "validation_scope": "structural_only",
        "factory_authorized": False,
        "project_id": project_id,
        "counts": {"epics": len(epics), "slices": len(slices)},
        "errors": sorted(set(errors)),
    }


def read_local_policy(root: Path) -> Dict[str, Any]:
    """Fail closed. Reads only; enabling is intentionally NOT shipped in M0."""
    default = {"enabled": False, "paused": False, "auto_sync": False, "autonomy": "observe", "source": "default-disabled"}
    path = Path(root).resolve() / ".factory" / "local" / "runner.json"
    try:
        if path.is_symlink() or not path.is_file():
            return default
        obj = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(obj, dict) and type(obj.get("schema_version")) is int and obj["schema_version"] == 2:
            # Written by the Factory's activation (run skill). Shown here; whether it is in force is the supervisor's check, not this reader's.
            if any(type(obj.get(field)) is not bool for field in ("enabled", "paused", "auto_sync")) or obj.get("autonomy") not in ("observe", "supervised") \
                    or any(not isinstance(obj.get(field), str) or not obj[field] for field in ("runner_id", "machine", "project_root")):
                return default
            return {**{k: obj[k] for k in ("enabled", "paused", "auto_sync", "autonomy")}, "source": "local-file"}
        if not isinstance(obj, dict) or set(obj) != {"schema_version", "enabled", "paused", "auto_sync", "autonomy"}:
            return default
        if type(obj["schema_version"]) is not int or obj["schema_version"] != 1:
            return default
        if any(type(obj[field]) is not bool for field in ("enabled", "paused", "auto_sync")):
            return default
        if obj["autonomy"] not in ("observe", "supervised", "extended"):
            return default
        return {**{k: obj[k] for k in ("enabled", "paused", "auto_sync", "autonomy")}, "source": "local-file"}
    except (OSError, UnicodeError, ValueError):
        return default


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="MACH Product structural checks (never grants Factory execution)")
    p.add_argument("--project", type=Path, default=Path.cwd())
    p.add_argument("--policy", action="store_true", help="also show local Factory policy (defaults to disabled)")
    args = p.parse_args(argv)
    result = validate_workspace(args.project)
    if args.policy:
        result["local_policy"] = read_local_policy(args.project)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    import contextlib as _c, os as _o, runpy as _r  # MACH records an internal error for /mach report (skills/intent/scripts/faults.py)
    with _c.suppress(Exception): _r.run_path(next(p for p in (_o.path.join(_o.path.abspath(__file__).rsplit(_o.sep, 3)[0], d, "scripts", "faults.py") for d in ("intent", "mach-intent")) if _o.path.isfile(p)))["install"](__file__)
    sys.exit(main())
