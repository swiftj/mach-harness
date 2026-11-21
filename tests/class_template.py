"""Run a test class's expensive preparatory steps once, and give each later test the same result.

Many classes start every test the same way: Git repositories with fixture commits, a stand-in for gh,
a project built through the stations. Each test paid for all of it again, in dozens of subprocesses.

    self.tmp = class_template.folder(self)           # in place of tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    class_template.step(self, "repositories", root, self.repositories)

`folder` gives the n-th temporary folder of every test of a class the same path: a fresh, empty folder,
removed by its cleanup, so what one test's step wrote (absolute paths in Git's config, worktree links,
JSON records, stand-in scripts, test logs whose digests are recorded elsewhere) is just as true for the
next test.

`step` runs a preparatory step that changes only files under `root`, and returns its value (plain data).
Before it runs, everything under root is fingerprinted: every folder, path, file mode, symbolic link
and byte. The first time a class runs a step from a given folder, what the step changed (files written,
files and folders removed) and the value it returned are kept. A later test of the same class that
reaches the same step, with the same key, from a folder with the same fingerprint at the same path,
gets exactly those changes applied and the same value, instead of running the step again. Anything
else (another starting folder, another path, another key, another class) runs the step for real. A step
that raises keeps nothing.

The fingerprint leaves out what differs between two identical folders made a moment apart, and nothing
else: compiled Python caches, the stat fields of a Git index (times, device, inode, size; the staged
object ids stay in), and the clock time on each reflog line. After applying changes, the index of each
Git checkout the changes touched is refreshed, because a written file has a new inode and change time
and plumbing such as `git diff-index` would otherwise report it changed.

What is kept belongs to the test's own class, so a subclass that builds differently keeps its own, and
it is removed when the class finishes. Each test still starts from an identical, isolated folder and may
change it freely. Standard library only.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple

KEEP_PER_STEP = 3  # a step reached from more distinct folders than this in one class is not kept: it just runs
_REFLOG_TIME = re.compile(rb"> \d+ [+-]\d{4}\t")
_AREAS: Dict[type, Path] = {}
_COUNTS: Dict[int, int] = {}
Manifest = Dict[str, Tuple[bytes, str]]  # relative path -> (kind and permission bits, such as b"F644" or b"D700"; digest)


class Kept:
    """What one step changed, and what it returned."""

    def __init__(self, store: Path, written: List[str], removed: List[str], folders: List[str], checkouts: List[str], value: str):
        self.store, self.written, self.removed, self.folders, self.checkouts, self.value = store, written, removed, folders, checkouts, value


_STEPS: Dict[Tuple[type, str, str, str], Kept] = {}  # (class, key, root, fingerprint before)


class Folder:
    """A fresh, empty folder at a path every test of the class shares, used like tempfile.TemporaryDirectory()."""

    def __init__(self, path: Path):
        self.name = str(path)

    def cleanup(self) -> None:
        shutil.rmtree(self.name, ignore_errors=True)


def _area(test) -> Path:
    kind = type(test)
    if kind not in _AREAS:
        _AREAS[kind] = Path(tempfile.mkdtemp(prefix="mach-class-"))
        kind.addClassCleanup(shutil.rmtree, str(_AREAS[kind]), True)
    return _AREAS[kind]


def folder(test) -> Folder:
    """The n-th temporary folder this test asks for, at the same path the n-th folder of every test of its class has."""
    number = _COUNTS.get(id(test), 0)
    _COUNTS[id(test)] = number + 1
    test.addCleanup(_COUNTS.pop, id(test), None)
    path = _area(test) / f"t{number}"
    shutil.rmtree(path, ignore_errors=True)  # never another test's leftovers
    path.mkdir()
    return Folder(path)


def _index_entries(data: bytes) -> bytes:
    """A Git index with each entry's change time, modification time, device, inode and size zeroed: a copy's index
    differs from its original in nothing else (each entry's object id still says what is staged). An index it cannot
    read is returned whole, so it never matches another."""
    if data[:4] != b"DIRC" or int.from_bytes(data[4:8], "big") not in (2, 3):
        return data
    out = bytearray(data)
    offset, count = 12, int.from_bytes(data[8:12], "big")
    try:
        for _ in range(count):
            out[offset:offset + 24] = bytes(24)
            out[offset + 36:offset + 40] = bytes(4)  # the size, which Git zeroes to mark a racily clean entry
            flags = int.from_bytes(data[offset + 60:offset + 62], "big")
            end = data.index(b"\0", offset + 62 + (2 if flags & 0x4000 else 0))
            offset += (end - offset + 1 + 7) // 8 * 8
    except (ValueError, IndexError):
        return data
    return bytes(out[:offset]) + data[offset:-20]  # the trailing checksum covers the zeroed fields


def manifest(root: Path) -> Manifest:
    """Every folder, symbolic link and file under root, with a digest of what a step could read from it."""
    found: Manifest = {}
    for here, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        relative = os.path.relpath(here, root)
        if relative != ".":
            found[relative] = (b"D%o" % (os.lstat(here).st_mode & 0o7777), "")
        for name in files + [d for d in dirs if os.path.islink(os.path.join(here, d))]:
            path = os.path.join(here, name)
            key = os.path.relpath(path, root)
            if os.path.islink(path):
                found[key] = (b"L", hashlib.sha256(os.readlink(path).encode()).hexdigest())
                continue
            with open(path, "rb") as handle:
                data = handle.read()
            parts = key.split(os.sep)
            if name == "index" and len(parts) > 1 and (parts[-2] == ".git" or (len(parts) > 2 and parts[-3] == "worktrees")):
                data = _index_entries(data)
            elif "logs" in parts[:-1]:
                data = _REFLOG_TIME.sub(b"> <time>\t", data)  # a reflog line's clock time; everything else in it stays
            found[key] = (b"F%o" % (os.lstat(path).st_mode & 0o7777), hashlib.sha256(data).hexdigest())
    return found


def fingerprint(entries: Manifest) -> str:
    digest = hashlib.sha256()
    for key in sorted(entries):
        kind, value = entries[key]
        digest.update(kind + key.encode() + b"\0" + value.encode() + b"\0")
    return digest.hexdigest()


def _checkouts(entries: Manifest, paths: List[str]) -> List[str]:
    """The Git checkouts (folders holding .git) whose working files or index any of these paths are; all of them when a
    linked worktree's index (under .git/worktrees/) is among the paths."""
    homes = sorted({key[: -len(".git")].rstrip(os.sep) for key in entries if key == ".git" or key.endswith(os.sep + ".git")}, key=len, reverse=True)
    if any(re.search(r"(^|/)\.git/worktrees/[^/]+/index$", path.replace(os.sep, "/")) for path in paths):
        return sorted(homes)
    touched = set()
    for path in paths:
        for home in homes:
            inside = path.startswith(home + os.sep) if home else True
            if inside:
                rest = path[len(home) + 1:] if home else path
                if not rest.startswith(".git" + os.sep) or rest == os.path.join(".git", "index"):
                    touched.add(home)
                break
    return sorted(touched)


def step(test, key: str, root: Path, run: Callable[[], Any]) -> Any:
    """Run `run()`, a preparatory step that changes only files under root, or apply what it did for an earlier test of
    this class that ran it from an identical folder at the same path. The value it returns must be plain data."""
    root = Path(root)
    before_entries = manifest(root)
    where = (type(test), key, str(root), fingerprint(before_entries))
    kept = _STEPS.get(where)
    if kept is not None:
        for name in kept.removed:
            target = root / name
            if target.is_symlink() or target.is_file():
                target.unlink()
            elif target.is_dir():
                shutil.rmtree(target)
        for name, mode in kept.folders:
            (root / name).mkdir(parents=True, exist_ok=True)
            os.chmod(root / name, mode)
        for name in kept.written:
            source, target = kept.store / name, root / name
            if target.is_symlink() or target.is_file():
                target.unlink()
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_symlink():
                os.symlink(os.readlink(source), target)
            else:
                shutil.copy2(source, target)
        for home in kept.checkouts:
            subprocess.run(["git", "update-index", "-q", "--refresh"], cwd=str(root / home), capture_output=True)
        return json.loads(kept.value)
    result = run()
    value = json.dumps(result)
    if json.loads(value) != result:
        raise AssertionError(f"class_template: step {key!r} returned something JSON does not carry unchanged")
    if sum(1 for item in _STEPS if item[:3] == where[:3]) < KEEP_PER_STEP:
        after = manifest(root)
        folder_kind = lambda entry: entry is not None and entry[0][:1] == b"D"  # noqa: E731
        written = sorted(name for name, entry in after.items() if not folder_kind(entry) and before_entries.get(name) != entry)
        removed = sorted((name for name, entry in before_entries.items() if name not in after or folder_kind(entry) != folder_kind(after[name])),
                         key=len, reverse=True)
        folders = sorted((name, os.lstat(root / name).st_mode & 0o7777) for name, entry in after.items()
                         if folder_kind(entry) and before_entries.get(name) != entry)
        store = Path(tempfile.mkdtemp(prefix="mach-step-", dir=_area(test)))
        for name in written:
            source, target = root / name, store / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_symlink():
                os.symlink(os.readlink(source), target)
            else:
                shutil.copy2(source, target)
        _STEPS[where] = Kept(store, written, removed, folders, _checkouts({**before_entries, **after}, written + removed), value)
    return result
