#!/usr/bin/env python3
"""M21 A: the project archive, one ZIP file that carries a Product Studio project to another repository.

`write` makes the archive from the members export collected; `read` takes an archive someone handed over and
returns its manifest and members, or refuses it. The reader treats the file as hostile: it never extracts to disk
and never uses a member's name as a path; it checks every name, kind, size and the manifest's own list before it
hands anything back, and reads each member into memory with a cap. Content (whether a slice is in the form Studio
writes) is the importer's check, not this module's.

Layout, writing rules and refusals: docs/mach-next/M21_EXPORT_IMPORT.md, sections 2.1 to 2.3 and 7.2.
Standard library only.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import stat
import unicodedata
import zipfile
import zlib
from pathlib import Path
from typing import Any, Dict, Mapping, Sequence, Tuple

FORMAT = "mach-project-archive"
FORMAT_VERSION = 1
MANIFEST = "mach-project.json"
FACTS = "facts.json"

KIB = 1024
MIB = 1024 * 1024

LIMITS: Dict[str, int] = {
    # Per kind of member: the most bytes one member of that kind may unpack to.
    "json": 1 * MIB,         # the manifest, facts.json and every record (product.MAX_JSON_BYTES)
    "markdown": 1 * MIB,     # specs, whys, briefs and cases
    "document": 512 * KIB,   # a PRD or design document (prd.MAX_BYTES)
    "mock": 5 * MIB,         # a design mock picture (issue_rules.MOCK_MAX_BYTES)
    # For the archive as a whole.
    "archive": 256 * MIB,    # the ZIP file itself
    "total": 512 * MIB,      # every member's declared size, added up
    "members": 5000,         # members, the manifest included
    "ratio": 200,            # a member over `ratio_floor` that unpacks to more than this many times its packed size is a bomb
    "ratio_floor": 1 * MIB,
    "name": 255,             # characters in one member's name
}

_ID3 = r"[0-9]{3,}"
_ID2 = r"[0-9]{2,}"
_KEBAB = r"[a-z0-9]+(?:-[a-z0-9]+)*"
_MAP_KEY = r"[A-Za-z][A-Za-z0-9-]{0,31}"  # prd.MAP_KEY_RE

MEMBER_PATTERNS: Sequence[Tuple[re.Pattern[str], str]] = tuple((re.compile(pattern), kind) for pattern, kind in (
    (r"mach-project\.json", "json"),
    (r"facts\.json", "json"),
    (r"workspace/product/project\.json", "json"),
    (rf"workspace/product/epics/EPIC-{_ID3}\.json", "json"),
    (rf"workspace/product/slices/SLICE-{_ID3}\.json", "json"),
    (rf"workspace/product/intents/SLICE-{_ID3}\.md", "markdown"),
    (rf"workspace/specs/slices/SLICE-{_ID3}-{_KEBAB}\.md", "markdown"),
    (r"workspace/product/principles\.json", "json"),
    (r"workspace/product/needs\.json", "json"),
    (rf"workspace/product/mocks/SLICE-{_ID3}/[0-9a-f]{{64}}\.(?:png|jpg)", "mock"),
    (rf"workspace/product/ideas/IDEA-{_ID3}(?:\.lookups|\.map)?\.json", "json"),
    (rf"workspace/product/briefs/IDEA-{_ID3}(?:\.case)?\.md", "markdown"),
    (rf"workspace/product/prds/PRD-{_ID2}/(?:prd|map)\.json", "json"),
    (rf"workspace/product/prds/PRD-{_ID2}/document\.(?:md|txt)", "document"),
    (rf"workspace/product/prds/PRD-{_ID2}/answers/{_MAP_KEY}\.json", "json"),
    (rf"workspace/product/designs/DES-{_ID2}/(?:import|map)\.json", "json"),
    (rf"workspace/product/designs/DES-{_ID2}/design\.(?:md|txt)", "document"),
))

META_KEYS = ("mach_version", "exported_at", "project_id", "counts")
PROJECT_RE = re.compile(r"^[a-z][a-z0-9-]{1,63}$")                      # product.PROJECT_RE
EXPORTED_AT_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
HEX_RE = re.compile(r"^[0-9a-f]{64}$")
NAME_CHARS_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
DRIVE_RE = re.compile(r"^[A-Za-z]:")

FIXED_TIME = (1980, 1, 1, 0, 0, 0)
FILE_MODE = 0o100644
COMPRESS_LEVEL = 6
UNIX = 3  # ZipInfo.create_system


class ArchiveError(Exception):
    """A refusal; its message is the sentence the person reads, without the "Nothing was changed." ending."""


# ---- shared ----

def kind_of(name: str) -> str:
    """The limit kind of a member name, or "" when the name matches no pattern."""
    for pattern, kind in MEMBER_PATTERNS:
        if pattern.fullmatch(name):
            return kind
    return ""


def canonical(data: Mapping[str, Any]) -> bytes:
    """The one byte form of the manifest; the same as studio.canonical."""
    return (json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def words(size: int) -> str:
    """A limit as a person reads it: 1 MB, 512 KB, 5 MB."""
    if size >= MIB and size % MIB == 0:
        return f"{size // MIB} MB"
    if size >= KIB and size % KIB == 0:
        return f"{size // KIB} KB"
    return f"{size} bytes"


def shown(name: str) -> str:
    """A member name safe to put in a sentence: printable, one line, not too long."""
    clean = "".join(ch if ch.isprintable() and ch not in "\r\n\t" else "?" for ch in name)
    return clean if len(clean) <= 120 else clean[:117] + "..."


def _fold(name: str) -> str:
    """The key under which two names count as the same on a case-insensitive, normalising file system."""
    return unicodedata.normalize("NFC", unicodedata.normalize("NFD", name).casefold())


# ---- writing ----

def write(target: Path, files: Mapping[str, bytes], meta: Mapping[str, Any]) -> Dict[str, Any]:
    """Write the archive of `files` (member name to bytes, the manifest not among them) to `target`, atomically.

    `meta` holds exactly mach_version (a string or None), exported_at (YYYY-MM-DDTHH:MM:SSZ), project_id and counts.
    Refuses (ArchiveError) a name that matches no pattern or a member over its limit, and an archive the reader would
    refuse for its size. Returns the manifest. The same files and meta give the same bytes."""
    _check_meta(meta)
    names = sorted(files)
    if MANIFEST in files:
        raise ValueError(f"{MANIFEST} is written by project_archive.write, not passed in.")
    if len(names) + 1 > LIMITS["members"]:
        raise ArchiveError(f"The project has more than {LIMITS['members']:,} files, more than an archive may hold.")
    folded: Dict[str, str] = {}
    total = 0
    for name in names:
        data = files[name]
        if not isinstance(data, bytes):
            raise ValueError(f"{name}: a member's content must be bytes.")
        kind = kind_of(name) if len(name) <= LIMITS["name"] else ""
        if not kind or name == MANIFEST:
            raise ArchiveError(f"{shown(name)} is not a file a project archive holds.")
        if len(data) > LIMITS[kind]:
            raise ArchiveError(f"{shown(name)} is larger than {words(LIMITS[kind])}, the most a file in an archive may be.")
        if _fold(name) in folded:
            raise ArchiveError(f"{shown(name)} and {shown(folded[_fold(name)])} have the same name but for case.")
        folded[_fold(name)] = name
        total += len(data)
    manifest: Dict[str, Any] = {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "mach_version": meta["mach_version"],
        "exported_at": meta["exported_at"],
        "project_id": meta["project_id"],
        "counts": {key: meta["counts"][key] for key in sorted(meta["counts"])},
        "files": [{"path": name, "bytes": len(files[name]), "sha256": sha256(files[name])} for name in names],
    }
    manifest_bytes = canonical(manifest)
    if len(manifest_bytes) > LIMITS["json"]:
        raise ArchiveError(f"The archive's list of files is larger than {words(LIMITS['json'])}, more than an archive may hold.")
    total += len(manifest_bytes)
    if total > LIMITS["total"]:
        raise ArchiveError(f"The project is {_mb(total)} MB unpacked, more than the {words(LIMITS['total'])} an archive may hold. "
                           "Remove design mocks that are no longer needed, then export again.")
    members = dict(files)
    members[MANIFEST] = manifest_bytes

    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    if temporary.is_symlink() or temporary.exists():
        temporary.unlink()
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        with os.fdopen(os.open(str(temporary), flags, 0o644), "wb") as handle:
            with zipfile.ZipFile(handle, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=False) as archive:
                for name in sorted(members):
                    info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.create_system = UNIX
                    info.external_attr = FILE_MODE << 16
                    archive.writestr(info, members[name], compresslevel=COMPRESS_LEVEL)
                for info in archive.infolist():
                    if _bomb(info):
                        raise ArchiveError(f"{shown(info.filename)} packs so tightly that an archive holding it would be "
                                           "refused as unsafe where it is brought in.")
        size = temporary.stat().st_size
        if size > LIMITS["archive"]:
            raise ArchiveError(f"The project is {_mb(size)} MB, more than the {words(LIMITS['archive'])} an archive may be. "
                               "Remove design mocks that are no longer needed, then export again.")
        os.replace(str(temporary), str(target))
    except BaseException:
        if temporary.is_symlink() or temporary.exists():
            temporary.unlink()
        raise
    return manifest


def _mb(size: int) -> int:
    return -(-size // MIB)


def _check_meta(meta: Mapping[str, Any]) -> None:
    """The caller's metadata, checked as strictly as the reader checks a manifest: a mistake here is a bug, not a refusal."""
    if set(meta) != set(META_KEYS):
        raise ValueError(f"meta must hold exactly {', '.join(META_KEYS)}.")
    problem = _meta_problem(meta)
    if problem:
        raise ValueError(f"meta: {problem}")


def _meta_problem(meta: Mapping[str, Any]) -> str:
    version = meta.get("mach_version")
    if version is not None and (not isinstance(version, str) or not version or len(version) > 64):
        return "mach_version must be a short string or null."
    if not isinstance(meta.get("exported_at"), str) or not EXPORTED_AT_RE.fullmatch(meta["exported_at"]):
        return "exported_at must be YYYY-MM-DDTHH:MM:SSZ."
    if not isinstance(meta.get("project_id"), str) or not PROJECT_RE.fullmatch(meta["project_id"]):
        return "project_id is not a project's ID."
    counts = meta.get("counts")
    if not isinstance(counts, dict) or len(counts) > 32 or not all(
            isinstance(key, str) and re.fullmatch(r"[a-z_]{1,32}", key) and _count(value) for key, value in counts.items()):
        return "counts must map short names to whole numbers."
    return ""


def _count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 10 ** 9


def _bomb(info: zipfile.ZipInfo) -> bool:
    return info.file_size > LIMITS["ratio_floor"] and info.file_size > LIMITS["ratio"] * max(info.compress_size, 1)


# ---- reading ----

def read(source: Path) -> Tuple[Dict[str, Any], Dict[str, bytes]]:
    """Check an archive someone handed over (every check of section 2.3 but content) and return its manifest and its
    members by name, the manifest not among them. Raises ArchiveError with the sentence of section 7.2."""
    manifest, members, _ = read_with_sha256(source)
    return manifest, members


def read_with_sha256(source: Path) -> Tuple[Dict[str, Any], Dict[str, bytes], str]:
    """read, and the SHA-256 of the very bytes it read: the file is read once, into memory, and every check and the hash
    are of those bytes, so a file changed while it is being brought in can never be keyed to bytes that were not read."""
    source = Path(source)
    label = shown(source.name) or "The file"
    try:
        status = os.lstat(str(source))
    except (OSError, ValueError):
        raise ArchiveError(f"There is no file at {shown(str(source))}.") from None
    if stat.S_ISLNK(status.st_mode):
        raise _unsafe(label, "it is a link to another file")
    if not stat.S_ISREG(status.st_mode):
        raise ArchiveError(f"There is no file at {shown(str(source))}.")
    if status.st_size > LIMITS["archive"]:
        raise _unsafe(label, f"it is larger than {words(LIMITS['archive'])}")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        with os.fdopen(os.open(str(source), flags), "rb") as handle:
            if os.fstat(handle.fileno()).st_size > LIMITS["archive"]:
                raise _unsafe(label, f"it is larger than {words(LIMITS['archive'])}")
            raw = handle.read(LIMITS["archive"] + 1)
    except OSError:
        raise ArchiveError(f"There is no file at {shown(str(source))}.") from None
    if len(raw) > LIMITS["archive"]:
        raise _unsafe(label, f"it is larger than {words(LIMITS['archive'])}")
    digest = sha256(raw)
    data = io.BytesIO(raw)
    if not zipfile.is_zipfile(data):
        raise ArchiveError(f"{label} is not a project archive from MACH.")
    data.seek(0)
    try:
        with zipfile.ZipFile(data, "r") as archive:
            manifest, members = _read_open(archive, label)
    except ArchiveError:
        raise
    except (zipfile.BadZipFile, zipfile.LargeZipFile, EOFError, NotImplementedError, RuntimeError, ValueError, OSError):
        raise ArchiveError(f"{label} is not a project archive from MACH.") from None
    return manifest, members, digest


def _unsafe(label: str, reason: str) -> ArchiveError:
    return ArchiveError(f"{label} is not in a form MACH can read safely: {reason}.")


def _changed(label: str, member: str) -> ArchiveError:
    return ArchiveError(f"{label} has been changed since it was exported: {shown(member)} does not match the archive's own list.")


def _read_open(archive: zipfile.ZipFile, label: str) -> Tuple[Dict[str, Any], Dict[str, bytes]]:
    infos = archive.infolist()
    if len(infos) > LIMITS["members"]:
        raise _unsafe(label, f"it holds more than {LIMITS['members']:,} files")

    # The manifest first, under every check the other members get, so an archive from a newer MACH is named as such
    # rather than refused for a member this version does not know.
    manifests = [info for info in infos if _fold(info.orig_filename) == _fold(MANIFEST)]
    if not manifests:
        raise ArchiveError(f"{label} is not a project archive from MACH.")
    if len(manifests) > 1:
        raise _unsafe(label, "two files in it have the same name")
    if manifests[0].orig_filename != MANIFEST:
        raise ArchiveError(f"{label} is not a project archive from MACH.")
    _check_entry(manifests[0], label)
    manifest = _manifest(_read_member(archive, manifests[0], label), label)

    for info in infos:
        _check_name(info, label)
    seen: Dict[str, str] = {}
    for info in infos:
        key = _fold(info.filename)
        if key in seen:
            raise _unsafe(label, "two files in it have the same name")
        seen[key] = info.filename
    for info in infos:
        _check_kind(info, label)
    for info in infos:
        _check_packing(info, label)
    for info in infos:
        _check_declared(info, label)
    if sum(info.file_size for info in infos) > LIMITS["total"]:
        raise _unsafe(label, f"it unpacks to more than {words(LIMITS['total'])}")
    for info in infos:
        if _bomb(info):
            raise _unsafe(label, "it unpacks to far more than it holds")

    members: Dict[str, bytes] = {}
    for info in sorted(infos, key=lambda item: item.filename):
        if info.filename != MANIFEST:
            members[info.filename] = _read_member(archive, info, label)

    listed = {entry["path"]: entry for entry in manifest["files"]}
    for name in sorted(set(listed) | set(members)):
        entry, data = listed.get(name), members.get(name)
        if entry is None or data is None or entry["bytes"] != len(data) or entry["sha256"] != sha256(data):
            raise _changed(label, name)
    return manifest, members


def _check_entry(info: zipfile.ZipInfo, label: str) -> None:
    """Every check of one entry before its bytes are read."""
    _check_name(info, label)
    _check_kind(info, label)
    _check_packing(info, label)
    _check_declared(info, label)
    if _bomb(info):
        raise _unsafe(label, "it unpacks to far more than it holds")


def _check_name(info: zipfile.ZipInfo, label: str) -> None:
    raw = info.orig_filename  # zipfile cuts a name at its first NUL; the original keeps it
    name = info.filename
    if "\x00" in raw or not raw:
        raise _unsafe(label, f"a file in it would be written outside the project ({shown(raw)})")
    if info.is_dir() or raw.endswith("/") or info.external_attr & 0x10:
        raise _unsafe(label, f"it holds a folder or file MACH does not know ({shown(raw)})")
    if ("\\" in raw or raw.startswith("/") or DRIVE_RE.match(raw)
            or any(part in ("", ".", "..") for part in raw.split("/"))):
        raise _unsafe(label, f"a file in it would be written outside the project ({shown(raw)})")
    if raw != name or len(raw) > LIMITS["name"] or not NAME_CHARS_RE.fullmatch(raw) or not kind_of(raw):
        raise _unsafe(label, f"it holds a folder or file MACH does not know ({shown(raw)})")


def _check_kind(info: zipfile.ZipInfo, label: str) -> None:
    """Only a regular file: no file type recorded (a mode of 0, or permission bits only, as Python's own zipfile
    writes) or S_IFREG; a link or any other type refuses."""
    mode = info.external_attr >> 16
    if stat.S_IFMT(mode) in (0, stat.S_IFREG):
        return
    if stat.S_IFMT(mode) == stat.S_IFLNK:
        raise _unsafe(label, "it holds a link to another file")
    raise _unsafe(label, f"it holds a folder or file MACH does not know ({shown(info.filename)})")


def _check_packing(info: zipfile.ZipInfo, label: str) -> None:
    if info.flag_bits & 0x1:
        raise _unsafe(label, "it is encrypted")
    if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        raise _unsafe(label, f"a file in it is packed in a way MACH does not read ({shown(info.filename)})")


def _check_declared(info: zipfile.ZipInfo, label: str) -> None:
    limit = LIMITS[kind_of(info.filename)]
    if info.file_size > limit:
        raise _unsafe(label, f"a file in it is larger than {words(limit)} ({shown(info.filename)})")


def _read_member(archive: zipfile.ZipFile, info: zipfile.ZipInfo, label: str) -> bytes:
    """One member into memory, never more than its limit plus one byte; a size or CRC that disagrees refuses."""
    limit = LIMITS[kind_of(info.filename)]
    try:
        with archive.open(info, "r") as stream:
            data = stream.read(limit + 1)
            extra = stream.read(1) if len(data) <= limit else b""
    except (zipfile.BadZipFile, EOFError, zlib.error, ValueError, OSError, RuntimeError, NotImplementedError):
        raise _unsafe(label, f"a file in it is damaged ({shown(info.filename)})") from None
    if len(data) > limit:
        raise _unsafe(label, f"a file in it is larger than {words(limit)} ({shown(info.filename)})")
    if extra or len(data) != info.file_size:
        raise _unsafe(label, f"a file in it is damaged ({shown(info.filename)})")
    return data


def _manifest(data: bytes, label: str) -> Dict[str, Any]:
    """The manifest's own shape. A newer format is named; anything else that is not this format is not an archive."""
    not_ours = ArchiveError(f"{label} is not a project archive from MACH.")
    try:
        manifest = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise not_ours from None
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise not_ours
    version = manifest.get("format_version")
    if not isinstance(version, int) or isinstance(version, bool):
        raise not_ours
    if version > FORMAT_VERSION:
        raise ArchiveError(f"{label} was made by a newer MACH (archive format {version}). Update MACH here, then import it again.")
    if version < 1:
        raise not_ours
    if set(manifest) != {"format", "format_version", "files", *META_KEYS} or _meta_problem(manifest):
        raise not_ours
    files = manifest["files"]
    if not isinstance(files, list):
        raise not_ours
    paths = set()
    for entry in files:
        if (not isinstance(entry, dict) or set(entry) != {"path", "bytes", "sha256"} or not isinstance(entry["path"], str)
                or not _count(entry["bytes"]) or not isinstance(entry["sha256"], str) or not HEX_RE.fullmatch(entry["sha256"])):
            raise not_ours
        if entry["path"] in paths or entry["path"] == MANIFEST:
            raise _changed(label, entry["path"])
        paths.add(entry["path"])
    return manifest
