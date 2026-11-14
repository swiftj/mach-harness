#!/usr/bin/env python3
"""MACH Product structural validator (Python 3.8+; standard library only).

Checks the shape of the product artifacts (project, epics, slice work orders, delivery waves) and
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
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional, Tuple

PROJECT_RE = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
EPIC_RE = re.compile(r"^EPIC-[0-9]{3,}$")
SLICE_RE = re.compile(r"^SLICE-[0-9]{3,}$")
WAVE_RE = re.compile(r"^WAVE-[0-9]{3,}$")
HEX_RE = re.compile(r"^[a-f0-9]{64}$")
# The same file-name rule as skills/intent/scripts/validate_slice.py (FILENAME_RE), which stays authoritative.
SPEC_NAME_RE = re.compile(r"^(SLICE-[0-9]{3,})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
ROLE_RE = re.compile(r"^[a-z][a-z0-9-]{1,39}$")
RELEASE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
# A product acceptance decision for one delivery wave at one release (M7). Recorded by a person in
# Product Studio, published like any product file, and only ever read: nothing executes from it.
ACCEPTANCE = ("schema_version", "wave_id", "project_id", "wave_revision", "wave_sha256", "release_id", "release_commit",
              "readiness_sha256", "readiness_outcome", "decision", "by", "note", "recorded_at")
TIMESTAMP_RE = re.compile(r"^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$")

SHAPES = {
    "project": ("schema_version", "project_id", "name", "revision", "status", "vision", "outcomes"),
    "epic": ("schema_version", "epic_id", "project_id", "revision", "title", "status", "acceptance_criteria"),
    "slice": ("schema_version", "slice_id", "project_id", "epic_id", "revision", "title", "status", "dependencies", "open_questions", "spec_path", "spec_sha256"),
    "wave": ("schema_version", "wave_id", "project_id", "revision", "base_project_revision", "status", "slices", "approval"),
}
ENUMS = {
    "project": {"status": ("draft", "active", "archived")},
    "epic": {"status": ("proposed", "approved", "deferred", "completed", "superseded")},
    "slice": {"status": ("draft", "interviewing", "ready_for_approval", "approved_for_engineering", "superseded")},
    "wave": {"status": ("draft", "approved_for_engineering", "superseded")},
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
    """True for an RFC 3339 date-time with a zone, which is what the wave schema's format asks for."""
    match = TIMESTAMP_RE.fullmatch(value) if isinstance(value, str) else None
    if not match:
        return False
    try:
        datetime.datetime.strptime(match.group(1) + " " + match.group(2), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return False
    zone = match.group(3)
    return zone == "Z" or (int(zone[1:3]) < 24 and int(zone[4:6]) < 60)


def _shape(kind: str, data: Dict[str, Any], location: str, errors: List[str]) -> None:
    required = set(SHAPES[kind])
    for key in sorted(required - set(data)):
        _error(errors, location, "missing field '{}'".format(key))
    for key in sorted(set(data) - required):
        _error(errors, location, "unexpected field '{}'".format(key))
    if type(data.get("schema_version")) is not int or data["schema_version"] != 1:
        _error(errors, location, "schema_version must be integer 1")
    if type(data.get("revision")) is not int or data["revision"] < 1:
        _error(errors, location, "revision must be a positive integer")
    for key in ("base_project_revision",):
        if kind == "wave" and (type(data.get(key)) is not int or data[key] < 1):
            _error(errors, location, "{} must be a positive integer".format(key))
    for key in ("project_id", "epic_id", "slice_id", "wave_id"):
        if key in required:
            rule = {"project_id": PROJECT_RE, "epic_id": EPIC_RE, "slice_id": SLICE_RE, "wave_id": WAVE_RE}[key]
            if not isinstance(data.get(key), str) or not rule.fullmatch(data[key]):
                _error(errors, location, "invalid {}".format(key))
    for key in ("name", "title", "vision"):
        if key in required and (not isinstance(data.get(key), str) or not data[key].strip()):
            _error(errors, location, "{} must be nonempty text".format(key))
    for key, allowed in ENUMS[kind].items():
        if data.get(key) not in allowed:
            _error(errors, location, "invalid {}".format(key))
    for key in ("outcomes", "acceptance_criteria", "dependencies", "open_questions", "slices"):
        if key in required:
            items = data.get(key)
            if not isinstance(items, list) or any(not isinstance(x, str) or not x.strip() for x in items):
                _error(errors, location, "{} must be a list of nonempty strings".format(key))
            elif key in ("dependencies", "slices") and len(items) != len(set(items)):
                _error(errors, location, "{} contains duplicate IDs".format(key))
            elif key == "outcomes" and not items:
                _error(errors, location, "outcomes must not be empty")
            elif key == "slices" and not items:
                _error(errors, location, "slices must not be empty")
    if kind == "slice":
        path, digest = data.get("spec_path"), data.get("spec_sha256")
        if path is not None and not isinstance(path, str):
            _error(errors, location, "spec_path must be text or null")
        if digest is not None and (not isinstance(digest, str) or not HEX_RE.fullmatch(digest)):
            _error(errors, location, "spec_sha256 must be lowercase 64-character SHA-256 or null")
    if kind == "wave":
        approval = data.get("approval")
        if approval is not None and (
            not isinstance(approval, dict)
            or set(approval) != {"actor", "approved_at"}
            or not all(isinstance(approval.get(k), str) and approval[k].strip() for k in ("actor", "approved_at"))
        ):
            _error(errors, location, "approval must be null or contain actor and approved_at strings")
        elif approval is not None and not _is_timestamp(approval["approved_at"]):
            _error(errors, location, "approval approved_at must be a date-time such as 2026-11-10T14:00:00Z")


def _acceptance(data: Dict[str, Any], location: str, errors: List[str], waves: Dict[str, Dict[str, Any]], project_id: Any, stem: str) -> None:
    """Shape and references only. It is bound to the wave as merged at the release (wave_sha256), so a draft of
    the wave may have moved on. Whether it applies to a release is the release check's decision."""
    for key in sorted(set(ACCEPTANCE) - set(data)):
        _error(errors, location, "missing field '{}'".format(key))
    for key in sorted(set(data) - set(ACCEPTANCE)):
        _error(errors, location, "unexpected field '{}'".format(key))
    if type(data.get("schema_version")) is not int or data["schema_version"] != 1:
        _error(errors, location, "schema_version must be integer 1")
    wave_id = data.get("wave_id")
    if not isinstance(wave_id, str) or not WAVE_RE.fullmatch(wave_id) or wave_id != stem:
        _error(errors, location, "wave_id must be a wave ID matching the filename")
    elif wave_id not in waves:
        _error(errors, location, "unknown wave '{}'".format(wave_id))
    if data.get("project_id") != project_id:
        _error(errors, location, "project_id does not match project.json")
    if type(data.get("wave_revision")) is not int or data["wave_revision"] < 1:
        _error(errors, location, "wave_revision must be a positive integer")
    for key in ("wave_sha256", "readiness_sha256"):
        value = data.get(key)
        if not (value is None and key == "readiness_sha256") and (not isinstance(value, str) or not HEX_RE.fullmatch(value)):
            _error(errors, location, "{} must be lowercase 64-character SHA-256".format(key))
    if not isinstance(data.get("release_commit"), str) or not COMMIT_RE.fullmatch(data["release_commit"]):
        _error(errors, location, "release_commit must be a full commit ID")
    if not isinstance(data.get("release_id"), str) or not RELEASE_RE.fullmatch(data["release_id"]):
        _error(errors, location, "invalid release_id")
    if data.get("decision") not in ("accepted", "rejected"):
        _error(errors, location, "decision must be accepted or rejected")
    if data.get("readiness_outcome") not in (None, "qualified", "qualified_with_exceptions", "blocked", "incomplete"):
        _error(errors, location, "invalid readiness_outcome")
    if data.get("decision") == "accepted" and data.get("readiness_outcome") not in ("qualified", "qualified_with_exceptions"):
        _error(errors, location, "accepted requires a qualified readiness snapshot")
    if not isinstance(data.get("by"), str) or not ROLE_RE.fullmatch(data["by"]):
        _error(errors, location, "by must be a role, such as product-owner")
    if data.get("note") is not None and not isinstance(data.get("note"), str):
        _error(errors, location, "note must be text or null")
    if not _is_timestamp(data.get("recorded_at")):
        _error(errors, location, "recorded_at must be a date-time such as 2026-11-10T14:00:00Z")


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
            "counts": {"epics": 0, "slices": 0, "waves": 0},
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
        ("wave", "delivery-waves", "WAVE-*.json", "wave_id", WAVE_RE),
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
    waves = docs.get("wave", {})
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
    for wave_id, entry in sorted(waves.items()):
        loc = "product/delivery-waves/{}.json".format(wave_id)
        items = entry.get("slices")
        if not isinstance(items, list):
            continue
        for sid in items:
            if not isinstance(sid, str) or sid not in slices:
                _error(errors, loc, "unknown slice '{}'".format(sid))
            elif entry.get("status") == "approved_for_engineering" and slices[sid].get("status") != "approved_for_engineering":
                _error(errors, loc, "wave includes unapproved slice '{}'".format(sid))
        if type(revision) is int and type(entry.get("base_project_revision")) is int and entry["base_project_revision"] > revision:
            _error(errors, loc, "wave baseline is newer than project revision")
        if entry.get("status") == "approved_for_engineering" and entry.get("approval") is None:
            _error(errors, loc, "approved wave requires recorded author approval")
    folder = root / "product" / "acceptance"
    if folder.is_symlink():
        _error(errors, "product/acceptance", "symlinked artifact directory is not permitted")
    for path in [] if folder.is_symlink() else _files(folder, "WAVE-*.json"):
        location = str(path.relative_to(root))
        data = _read_json(path, errors, root)
        if data is not None:
            _acceptance(data, location, errors, waves, project_id, path.stem)
    return {
        "valid": not errors,
        "validation_scope": "structural_only",
        "factory_authorized": False,
        "project_id": project_id,
        "counts": {"epics": len(epics), "slices": len(slices), "waves": len(waves)},
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
    sys.exit(main())
