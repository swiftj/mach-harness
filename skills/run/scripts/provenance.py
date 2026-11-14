#!/usr/bin/env python3
"""What an unattended execution was started with: a small, immutable snapshot taken once, at start.

The Factory Supervisor calls `capture()` once per execution, after the decision to start it has been made
(authorization passed, MACH prepared as the run's plugin) and before the process is launched. It records the
files and settings as they were on disk at that moment. The snapshot is stored on the execution's ledger
record and on its `execution.started` event, and never recomputed: an execution is never attributed, after
the fact, to a newer skill, agent, workflow or configuration. An execution started before this existed has
no snapshot and is reported as "not recorded".

`mach.commit` is the HEAD of MACH's checkout when MACH is loaded from one; that tree may have uncommitted
changes. The line digest, not the commit, is the record of which files ran.

It records digests, versions, identifiers, numbers and booleans only. Never a prompt, a command line, a
path, a tool input, an environment value or a credential. The allowed-tool list is recorded as a digest and
a count, never as the list, and the Python interpreter's path in it is replaced by a placeholder before it is
hashed, so the digest is the same on every machine. The configuration file is recorded as a digest of all of
it (`config.digest`) plus the few values a person reads (tiers, thresholds); a model name that is not a plain
identifier (a cloud ARN, say) is recorded as `sha256:<digest>`, never dropped and never shown.

It decides nothing. `capture()` cannot change what the supervisor does: any failure, of any kind, yields
`{"provenance": None, "provenance_reason": "capture-failed"}` and the execution starts exactly as it would
have without it.

    {"schema": 1,
     "mach":   {"version", "install": "plugin" | "project", "commit"},
     "line":   {"digest", "count", "files": {"skill:<name>" | "agent:<name>" | "workflow:<name>" | "plugin:manifest": sha256}},
     "config": {"recorded", "digest", "models", "review": {"max_loops", "security_veto", "tiers"}, "max_parallel"},
     "policy": {"autonomy", "max_risk", "allow_merge", "max_parallel", "allowed_tools_digest", "allowed_tools_count"},
     "ticket": {"risk", "app_type"},
     "source": {"commit", "slice_revision", "slice_digest", "spec_sha256"},
     "config_id"}

`config_id` is the SHA-256 of the canonical JSON of {line digest, config, policy}, where config includes the
digest of the whole configuration file: two executions with the same `config_id` ran the same MACH files under
the same configuration and policy. Numbers are canonical (2 and 2.0 are the same). Compare it; do not
interpret it.

Bounded: at most MAX_ENTRIES directory entries listed (skipped ones count), MAX_FILES files and MAX_BYTES read,
and DEADLINE_SECONDS in all; past any of them, or on any unreadable folder, the capture fails as a whole.

Standard library only. Imported by supervisor.py; not a command of its own.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

SCHEMA = 1
REASON = "capture-failed"
RISKS = ("Low", "Medium", "High")
HEX_RE = re.compile(r"^[0-9a-f]{7,64}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
VERSION_RE = re.compile(r"^[0-9A-Za-z.+-]{1,40}$")
PART_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")  # a skill, agent or workflow name: also an observer token
TIER_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,63}$")
# Bounds: what one capture may read. MACH's own plugin is a few hundred small files.
MAX_FILES = 5000
MAX_ENTRIES = 20000  # every directory entry listed, kept or skipped
MAX_BYTES = 64 * 1024 * 1024
DEADLINE_SECONDS = 1.5
PYTHON = "<python>"  # stands in for the interpreter's path in the allowed-tool list
MAX_SMALL_FILE = 1024 * 1024  # config.json, cell.json, plugin.json
GIT_SECONDS = 2
RACY_SECONDS = 2  # a file changed this recently is hashed again, whatever its size and time say
_CACHE: Dict[str, Tuple[Tuple[int, int, int, int], float, str]] = {}
_CACHE_LIMIT = 8192


class TooLarge(Exception):
    """More to read than a capture may: recorded as a failed capture, never truncated into a wrong digest."""


def numbers(value: Any) -> Any:
    """2.0 and 2 are the same setting: a whole float is written as an integer."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {key: numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [numbers(item) for item in value]
    return value


def canonical(value: Any) -> bytes:
    return json.dumps(numbers(value), sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")


class Budget:
    """What one capture may still do: entries listed, files and bytes read, and time."""

    def __init__(self) -> None:
        self.files = self.bytes = self.entries = 0
        self.deadline = time.monotonic() + DEADLINE_SECONDS

    def spend(self, entries: int = 0, files: int = 0, size: int = 0) -> None:
        self.entries += entries
        self.files += files
        self.bytes += size
        if self.entries > MAX_ENTRIES or self.files > MAX_FILES or self.bytes > MAX_BYTES:
            raise TooLarge("budget")
        if time.monotonic() > self.deadline:
            raise TooLarge("time")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_digest(path: Path, budget: Budget) -> str:
    """SHA-256 of a file's bytes, cached by its size, times and inode. A file changed (mtime or ctime, the later)
    within the last few seconds is always read again, so a rewrite that keeps its size and time is never missed."""
    info = path.stat()
    budget.spend(files=1)
    key = str(path)
    signature = (info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino)
    cached = _CACHE.get(key)
    if cached and cached[0] == signature and cached[1] - max(info.st_mtime_ns, info.st_ctime_ns) / 1e9 > RACY_SECONDS:
        return cached[2]
    budget.spend(size=info.st_size)
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    value = digest.hexdigest()
    if len(_CACHE) >= _CACHE_LIMIT:
        _CACHE.clear()
    _CACHE[key] = (signature, time.time(), value)
    return value


def fail(error: OSError) -> None:
    raise error  # an unreadable folder fails the capture: a digest that skipped it would look complete


def folder_digest(folder: Path, budget: Budget) -> str:
    """One digest over a folder's files: each file's relative name and SHA-256, in name order.
    Symbolic links, compiled Python and caches are not part of what a run loads, and are skipped, but every
    entry listed counts against the budget."""
    found = []
    for top, dirs, names in os.walk(str(folder), onerror=fail, followlinks=False):
        budget.spend(entries=len(dirs) + len(names))
        dirs[:] = sorted(name for name in dirs if name != "__pycache__" and not os.path.islink(os.path.join(top, name)))
        for name in names:
            path = Path(top) / name
            if name.endswith(".pyc") or path.is_symlink() or not path.is_file():
                continue
            found.append(path)
    digest = hashlib.sha256()
    for path in sorted(found, key=lambda item: item.relative_to(folder).as_posix()):
        digest.update(path.relative_to(folder).as_posix().encode("utf-8") + b"\0" + bytes.fromhex(file_digest(path, budget)))
    return digest.hexdigest()


def line(plugin_dir: Path) -> Dict[str, Any]:
    """A digest per skill, agent and workflow file of the plugin the run loads, and one over them all.
    Named by role and name only ("skill:build"), never by path."""
    budget = Budget()
    files: Dict[str, str] = {}
    skills = plugin_dir / "skills"
    listed = sorted(skills.iterdir()) if skills.is_dir() else []
    budget.spend(entries=len(listed))
    for folder in listed:
        if not folder.is_symlink() and folder.is_dir() and PART_RE.match(folder.name):
            files[f"skill:{folder.name}"] = folder_digest(folder, budget)
    for kind, sub, suffix in (("agent", "agents", ".md"), ("workflow", "workflows", ".js")):
        where = plugin_dir / sub
        listed = sorted(where.iterdir()) if where.is_dir() else []
        budget.spend(entries=len(listed))
        for path in (item for item in listed if item.suffix == suffix):
            if not path.is_symlink() and path.is_file() and PART_RE.match(path.stem):
                files[f"{kind}:{path.stem}"] = file_digest(path, budget)
    manifest = plugin_dir / ".claude-plugin" / "plugin.json"
    if manifest.is_file() and not manifest.is_symlink():
        files["plugin:manifest"] = file_digest(manifest, budget)
    return {"digest": sha(canonical(files)), "count": len(files), "files": files}


def small_json(path: Path) -> Optional[Dict[str, Any]]:
    """A small JSON object, or None when it is missing, unreadable, too large or not an object."""
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_SMALL_FILE:
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def whole(value: Any) -> Optional[int]:
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value if type(value) is int else None


def harness_commit(plugin_dir: Path, kind: str) -> Optional[str]:
    """The commit of MACH's own checkout, when MACH is loaded from a Git checkout as a plugin. Neither install
    records one (a script install's manifest has a version only), so it is read, read-only and with a time
    limit; otherwise it is not recorded. The line digest, not this, says which files ran."""
    if kind != "plugin" or not (plugin_dir / ".git").exists():
        return None
    try:
        done = subprocess.run(["git", "-C", str(plugin_dir), "rev-parse", "--verify", "--quiet", "HEAD"], capture_output=True, text=True,
                              timeout=GIT_SECONDS, env={**{k: v for k, v in os.environ.items() if not k.startswith("GIT_")}, "GIT_OPTIONAL_LOCKS": "0"})
    except (OSError, subprocess.SubprocessError):
        return None
    value = done.stdout.strip()
    return value if done.returncode == 0 and HEX_RE.match(value) else None


def mach(plugin_dir: Path, kind: str) -> Dict[str, Any]:
    version = (small_json(plugin_dir / ".claude-plugin" / "plugin.json") or {}).get("version")
    return {"version": version if isinstance(version, str) and VERSION_RE.match(version) else None,
            "install": kind if kind in ("plugin", "project") else None, "commit": harness_commit(plugin_dir, kind)}


def model(name: str) -> str:
    """A model name as configured, or its digest when it is not a plain identifier (a cloud ARN, a path)."""
    return name if MODEL_RE.match(name) else "sha256:" + sha(name.encode("utf-8"))


def config(root: Path) -> Dict[str, Any]:
    """.factory/config.json at this moment: a digest of all of it (never its content), and the values a person
    reads, as configured. A key the file does not set is null; no default is filled in."""
    data = small_json(root / ".factory" / "config.json")
    if data is None:
        return {"recorded": False, "digest": None, "models": None, "review": None, "max_parallel": None}
    models = data.get("models") if isinstance(data.get("models"), dict) else None
    if models is not None:
        models = {tier: model(name) for tier, name in sorted(models.items())[:16]
                  if isinstance(tier, str) and TIER_RE.match(tier) and isinstance(name, str)}
    section = data.get("review") if isinstance(data.get("review"), dict) else None
    review = None
    if section is not None:
        tiers = {}
        for tier, rules in sorted(section.items())[:16]:
            if isinstance(tier, str) and TIER_RE.match(tier) and isinstance(rules, dict):
                tiers[tier] = {"approvals": whole(rules.get("approvals")), "reviewers": whole(rules.get("reviewers")),
                               "human_approval": rules.get("human_approval") if isinstance(rules.get("human_approval"), bool) else None}
        veto = section.get("security_veto")
        review = {"max_loops": whole(section.get("max_loops")), "security_veto": veto if isinstance(veto, bool) else None, "tiers": tiers}
    factory = data.get("factory") if isinstance(data.get("factory"), dict) else {}
    return {"recorded": True, "digest": sha(canonical(data)), "models": models, "review": review, "max_parallel": whole(factory.get("max_parallel"))}


def policy(pol: Dict[str, Any]) -> Dict[str, Any]:
    """The effective policy's mode and the allowed-tool list's digest. The list itself is never recorded."""
    tools = pol.get("allowed_tools")
    tools = [tool.replace(sys.executable, PYTHON) for tool in tools if isinstance(tool, str)] if isinstance(tools, list) else None
    limits = pol.get("limits") if isinstance(pol.get("limits"), dict) else {}
    parallel = limits.get("max_parallel")
    return {"autonomy": pol.get("autonomy") if pol.get("autonomy") in ("observe", "supervised") else None,
            "max_risk": pol.get("max_risk") if pol.get("max_risk") in RISKS else None,
            "allow_merge": pol.get("allow_merge") if isinstance(pol.get("allow_merge"), bool) else None,
            "max_parallel": numbers(parallel) if type(parallel) in (int, float) and not isinstance(parallel, bool) else None,
            "allowed_tools_digest": sha(canonical(tools)) if tools is not None else None,
            "allowed_tools_count": len(tools) if tools is not None else None}


def ticket(root: Path, ticket_id: str) -> Dict[str, Any]:
    cell = small_json(root / ".factory" / "worktrees" / ticket_id / "cell.json") or {}
    app_type = cell.get("app_type")
    return {"risk": cell.get("risk") if cell.get("risk") in RISKS else None,
            "app_type": app_type if isinstance(app_type, str) and TIER_RE.match(app_type) else None}


def source(ledger: Dict[str, Any], slice_id: str) -> Dict[str, Any]:
    commit = (ledger.get("source") or {}).get("commit") if isinstance(ledger.get("source"), dict) else None
    entry = (ledger.get("slices") or {}).get(slice_id) if isinstance(ledger.get("slices"), dict) else None
    entry = entry if isinstance(entry, dict) else {}

    def digest(value: Any) -> Optional[str]:
        return value if isinstance(value, str) and DIGEST_RE.match(value) else None

    return {"commit": commit if isinstance(commit, str) and HEX_RE.match(commit) else None, "slice_revision": whole(entry.get("revision")),
            "slice_digest": digest(entry.get("digest")), "spec_sha256": digest(entry.get("spec_sha256"))}


def snapshot(root: Path, boundary: Dict[str, Any], pol: Dict[str, Any], ticket_id: str, slice_id: str, ledger: Dict[str, Any]) -> Dict[str, Any]:
    plugin_dir, kind = Path(boundary["plugin_dir"]), boundary.get("kind")
    files, settings, rules = line(plugin_dir), config(root), policy(pol)
    return {"schema": SCHEMA, "mach": mach(plugin_dir, kind), "line": files, "config": settings, "policy": rules,
            "ticket": ticket(root, ticket_id), "source": source(ledger, slice_id),
            "config_id": sha(canonical({"line": files["digest"], "config": settings, "policy": rules}))}


def capture(root: Path, boundary: Dict[str, Any], pol: Dict[str, Any], ticket_id: str, slice_id: str, ledger: Dict[str, Any]) -> Dict[str, Any]:
    """The fields to add to the execution's record and its execution.started event. Never raises: a failure
    is recorded as such, and the caller goes on exactly as it would have."""
    try:
        return {"provenance": snapshot(root, boundary, pol, ticket_id, slice_id, ledger)}
    except Exception:  # noqa: BLE001 - provenance must never change whether or how an execution starts
        return {"provenance": None, "provenance_reason": REASON}
