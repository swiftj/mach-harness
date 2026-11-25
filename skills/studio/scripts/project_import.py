#!/usr/bin/env python3
"""MACH Product Studio, M21 piece D: bringing a project in from an archive another repository's Product Studio made.

    plan(host, studio, archive)        every check and the numbering, then stop: what would happen (4.4)
    run(host, studio, archive)         the same, then write it: recorded first, staged, placed in a fixed order (4.5 to 4.7)
    lookup(studio, ident)              what was brought in, and what an ID was or became (`project imports`)
    unfinished(studio)                 the import that stopped part way here, or None (4.6)
    reserved_numbers(studio, kind)     the numbers an unfinished import holds, so no allocator gives them out (4.6)

`host` is the studio module (its StudioError, write, canonical, now, say, ticket_rules, policies_helper and Studio's
helpers); `studio` its Studio. This module never imports studio.

Order of work (docs/mach-next/M21_EXPORT_IMPORT.md, section 4): the archive is checked by project_archive.read, then its
content here, in memory; then the destination, read only; then the mode (a new project, or joining the one here); then
the numbers, counted from everything today's allocators count plus GitHub read now; then every file is rewritten in
memory (project_ids). A refusal at any of these steps changes nothing. Only then is anything written: the import record
first (.factory/studio/imports/<id>.json), then every file staged under .factory/studio/imports/<id>/files/, then each
placed with os.replace, each step looking before it writes, so a second run with the same archive finishes from the
recorded map and never numbers again.

Never: a GitHub write, an approval, a slice marked ready, a principle or need published, the Factory's ledger, cells,
claims, the inbox, the requests cache, ideas.json or shipped.json. Every destination path is built here from IDs that
matched their patterns, never from a name in the archive.

Standard library only.
"""

import copy
import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import design
import handoff
import issues
import prd
import product
import project_archive
import project_ids
import shape

SCHEMA_VERSION = 1
IMPORTS = "imports"  # .factory/studio/imports/
# <id>.json, and <id>.set-aside-<UTC time>.json once a person set an unfinished import aside (kept, so `project imports` still
# answers what an ID was, and so the same archive can be brought in afresh later).
RECORD_RE = re.compile(r"^[0-9a-f]{16}(?:\.set-aside-[0-9]{8}T[0-9]{6}Z)?\.json$")
PLACED_LOG = ".placed"  # <id>.placed: one JSON line per file or item this import has placed, written as each is placed
NOTHING = "Nothing was changed."
KINDS = tuple(project_ids.PREFIXES)  # SLICE, EPIC, IDEA, PP, TN, PRD, DES
KIND_ORDER = ("EPIC", "SLICE", "PP", "TN", "IDEA", "PRD", "DES")
NOUNS = {"SLICE": "slice", "EPIC": "epic", "IDEA": "idea", "PP": "principle", "TN": "technical need", "PRD": "PRD", "DES": "design"}
RENUMBER = {"SLICE": "slice renumber", "EPIC": "epic renumber", "IDEA": "idea renumber"}
WAS_WORDS = {"draft": "a draft", "interviewing": "being defined", "ready_for_approval": "ready for approval", "approved": "approved",
             "ready_to_build": "ready to build", "being_built": "being built", "question": "being built, with a question from the builders",
             "shipped": "shipped", "superseded": "replaced"}
WAS_COUNTED = ("shipped", "being_built", "question", "ready_to_build", "approved", "ready_for_approval", "interviewing")
FAULT_RE = re.compile(r"^AUTO-[0-9]{8}T[0-9]{6}Z(?:-[0-9]{1,4})?$")
NOTE_CHARS = 2000

# Member names, with the parts this module reads. Each is one of project_archive.MEMBER_PATTERNS, which the reader has
# already matched; anything here that does not match is refused, never guessed.
_ID3, _ID2, _KEBAB = r"[0-9]{3,}", r"[0-9]{2,}", r"[a-z0-9]+(?:-[a-z0-9]+)*"
MEMBER = [(name, re.compile(pattern)) for name, pattern in (
    ("project", r"workspace/product/project\.json"),
    ("epic", rf"workspace/product/epics/(EPIC-{_ID3})\.json"),
    ("slice", rf"workspace/product/slices/(SLICE-{_ID3})\.json"),
    ("intent", rf"workspace/product/intents/(SLICE-{_ID3})\.md"),
    ("spec", rf"workspace/specs/slices/(SLICE-{_ID3})-({_KEBAB})\.md"),
    ("principles", r"workspace/product/principles\.json"),
    ("needs", r"workspace/product/needs\.json"),
    ("mock", rf"workspace/product/mocks/(SLICE-{_ID3})/([0-9a-f]{{64}})\.(png|jpg)"),
    ("idea", rf"workspace/product/ideas/(IDEA-{_ID3})\.json"),
    ("lookups", rf"workspace/product/ideas/(IDEA-{_ID3})\.lookups\.json"),
    ("idea_map", rf"workspace/product/ideas/(IDEA-{_ID3})\.map\.json"),
    ("brief", rf"workspace/product/briefs/(IDEA-{_ID3})\.md"),
    ("case", rf"workspace/product/briefs/(IDEA-{_ID3})\.case\.md"),
    ("prd_meta", rf"workspace/product/prds/(PRD-{_ID2})/prd\.json"),
    ("prd_map", rf"workspace/product/prds/(PRD-{_ID2})/map\.json"),
    ("prd_doc", rf"workspace/product/prds/(PRD-{_ID2})/(document\.(?:md|txt))"),
    ("prd_answers", rf"workspace/product/prds/(PRD-{_ID2})/answers/([A-Za-z][A-Za-z0-9-]{{0,31}})\.json"),
    ("design_meta", rf"workspace/product/designs/(DES-{_ID2})/import\.json"),
    ("design_map", rf"workspace/product/designs/(DES-{_ID2})/map\.json"),
    ("design_doc", rf"workspace/product/designs/(DES-{_ID2})/(design\.(?:md|txt))"),
)]


# ---- relative paths in the draft, built from IDs only (the same as Studio's own path functions; a test holds them equal) ----


def rel_epic(ident: str) -> str:
    return f"product/epics/{ident}.json"


def rel_slice(ident: str) -> str:
    return f"product/slices/{ident}.json"


def rel_intent(ident: str) -> str:
    return f"product/intents/{ident}.md"


def rel_spec(ident: str, kebab: str) -> str:
    return f"specs/slices/{ident}-{kebab}.md"


def rel_mock(ident: str, sha: str, ext: str) -> str:
    return f"product/mocks/{ident}/{sha}{ext}"


def rel_idea(ident: str, part: str) -> str:
    return {"idea": f"product/ideas/{ident}.json", "lookups": f"product/ideas/{ident}.lookups.json", "idea_map": f"product/ideas/{ident}.map.json",
            "brief": f"product/briefs/{ident}.md", "case": f"product/briefs/{ident}.case.md"}[part]


def rel_document(kind: str, ident: str, name: str) -> str:
    return f"product/{'prds' if kind == 'PRD' else 'designs'}/{ident}/{name}"


PROJECT_REL, PRINCIPLES_REL, NEEDS_REL = "product/project.json", "product/principles.json", "product/needs.json"


# ---- small helpers ----


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def number(ident: str) -> int:
    return int(ident.rsplit("-", 1)[1])


def prefix(ident: str) -> str:
    return ident.rsplit("-", 1)[0]


def plural(n: int, one: str, many: Optional[str] = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def listing(items: Sequence[str]) -> str:
    items = list(items)
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def refusal(host: Any, sentence: str) -> Exception:
    """A refusal of 7.2: every one ends with "Nothing was changed." unless it already says so."""
    return host.StudioError(sentence if sentence.rstrip().endswith(NOTHING) else f"{sentence.rstrip()} {NOTHING}")


def imports_folder(studio: Any) -> Path:
    return studio.home / IMPORTS


def _place(source: Path, target: Path) -> None:
    """Put one staged file in its place. One function, so a test can make a write fail part way."""
    os.replace(str(source), str(target))


# ---- the records of imports (4.6, 4.7) ----


def _records(studio: Any) -> List[Tuple[Path, Dict[str, Any]]]:
    """Every import record here, oldest first; one that cannot be read is skipped. Never raises."""
    folder = imports_folder(studio)
    found: List[Tuple[Path, Dict[str, Any]]] = []
    try:
        if folder.is_symlink() or not folder.is_dir():
            return []
        paths = sorted(p for p in folder.iterdir() if RECORD_RE.fullmatch(p.name) and p.is_file() and not p.is_symlink())
    except OSError:
        return []
    for path in paths:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, RecursionError):
            continue
        if isinstance(data, dict) and isinstance(data.get("archive_sha256"), str) and "finished_at" in data:
            if not isinstance(data.get("map"), dict):  # a record this MACH cannot read still counts as unfinished, reserving nothing
                data = {**data, "map": {}}
            found.append((path, data))
    found.sort(key=lambda item: (str(item[1].get("started_at") or ""), item[0].name))
    return found


def open_record(data: Dict[str, Any]) -> bool:
    """An import that stopped part way and was not set aside: it holds its numbers and blocks export and another import."""
    return not data.get("finished_at") and not data.get("set_aside_at")


def _unfinished_record(studio: Any) -> Optional[Dict[str, Any]]:
    return next((data for _, data in _records(studio) if open_record(data)), None)


def unfinished(studio: Any) -> Optional[Dict[str, Any]]:
    """The import that stopped part way here: {file, archive_sha256, started_at, text}, or None."""
    data = _unfinished_record(studio)
    if data is None:
        return None
    name = str((data.get("archive") or {}).get("file") or "the archive")
    return {"file": name, "archive_sha256": data["archive_sha256"], "started_at": data.get("started_at"),
            "text": f"Bringing in the project from {name} stopped part way. Run it again with the same file to finish, or set it aside."}


# ---- what this import has placed (4.6): a log written as each file is placed, folded into the record when it ends ----


def placed_log_path(studio: Any, archive_sha256: str) -> Path:
    return imports_folder(studio) / f"{archive_sha256[:16]}{PLACED_LOG}"


def placed_so_far(studio: Any, record: Dict[str, Any]) -> Dict[str, str]:
    """Every file (draft-relative path) and merged item (`<path>#<ID>`) this import has placed, with the SHA-256 it placed."""
    found = {str(k): str(v) for k, v in (record.get("placed") or {}).items()} if isinstance(record.get("placed"), dict) else {}
    path = placed_log_path(studio, str(record.get("archive_sha256") or ""))
    try:
        if path.is_symlink() or not path.is_file():
            return found
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return found
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue  # a line cut short by a stop: the file it names is checked by its bytes
        if isinstance(entry, dict) and isinstance(entry.get("placed"), str) and isinstance(entry.get("sha256"), str):
            found[entry["placed"]] = entry["sha256"]
    return found


def note_placed(studio: Any, archive_sha256: str, key: str, digest: str) -> None:
    """One line in the log, written and flushed to disk before the next file is placed."""
    with open(str(placed_log_path(studio, archive_sha256)), "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"placed": key, "sha256": digest}, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def reserved_numbers(studio: Any, kind: str) -> List[int]:
    """The numbers of `kind` (SLICE, EPIC, IDEA, PP, TN, PRD or DES) an unfinished import's map gives out, so every allocator
    skips them until it finishes. Never raises: a record that cannot be read reserves nothing."""
    if kind not in project_ids.PREFIXES:
        return []
    found: Set[int] = set()
    try:
        for _, data in _records(studio):
            if not open_record(data):  # finished, or set aside: its numbers are free again
                continue
            for new in data["map"].values():
                if isinstance(new, str) and prefix(new) == kind and re.fullmatch(r"[0-9]+", new.rsplit("-", 1)[1]):
                    found.add(number(new))
    except Exception:  # noqa: BLE001  an allocator must never fail for this
        return []
    return sorted(found)


def lookup(studio: Any, ident: Optional[str]) -> Dict[str, Any]:
    """`project imports [<ID>]`: every import here, or what one ID was or became. Reads only."""
    records = [data for _, data in _records(studio)]
    if ident is None:
        rows = [{"file": (data.get("archive") or {}).get("file"), "archive_sha256": data["archive_sha256"], "mode": data.get("mode"),
                 "from_project": data.get("from_project"), "from_project_name": data.get("from_project_name"),
                 "into_project": data.get("into_project"), "started_at": data.get("started_at"), "finished_at": data.get("finished_at"),
                 "set_aside_at": data.get("set_aside_at"),
                 "counts": {kind: sum(1 for new in data["map"].values() if isinstance(new, str) and prefix(new) == kind) for kind in KIND_ORDER}}
                for data in records]
        return {"imports": rows, "reads_only": True, "factory_authorized": False,
                "note": (f"{plural(len(rows), 'project was', 'projects were')} brought in here." if rows else "No project has been brought in here.")}
    parts = project_ids._split(ident)  # noqa: SLF001  the rewriter's own ID rule
    if parts is None:
        raise studio_error(studio, f"'{ident}' is not an ID such as SLICE-007, EPIC-002, PP-03, TN-01, IDEA-004, PRD-01 or DES-01.")
    found = []
    for data in records:
        name = data.get("from_project_name") or data.get("from_project")
        day = str(data.get("finished_at") or data.get("set_aside_at") or data.get("started_at") or "")[:10]
        when = f"brought in on {day}" if data.get("finished_at") else \
            f"set aside on {day} before it was finished" if data.get("set_aside_at") else f"being brought in since {day}; not finished"
        for old, new in sorted(data["map"].items()):
            if old == ident or new == ident:
                if old in (data.get("principles_matched") or {}):
                    words = (f"{old} of '{name}' said the same as {new} here, so it was taken as {new} ({when})." if old == ident else
                             f"{new} here is also what {old} of '{name}' said, so that one was taken as {new} ({when}).")
                elif old == new:
                    words = f"{old} of '{name}' kept its number here ({when})."
                elif old == ident:
                    words = f"{old} of '{name}' is {new} here ({when})."
                else:
                    words = f"{new} here was {old} of '{name}' ({when})."
                found.append({"from": old, "to": new, "from_project": data.get("from_project"), "from_project_name": name,
                              "finished": bool(data.get("finished_at")), "words": words})
    return {"identifier": ident, "found": found, "reads_only": True, "factory_authorized": False,
            "note": " ".join(item["words"] for item in found) or f"{ident} did not come from a project brought in here."}


def studio_error(studio: Any, message: str) -> Exception:
    """A StudioError when only the Studio object is at hand (lookup takes no host): its class's own module's."""
    import sys
    module = sys.modules.get(type(studio).__module__)
    error = getattr(module, "StudioError", None)
    return error(message) if isinstance(error, type) else ValueError(message)


# ---- reading the archive (4.1, steps 1 and 2) ----


class Incoming:
    """The archive's content, checked and parsed, in memory."""

    def __init__(self) -> None:
        self.label = ""
        self.path: Optional[Path] = None
        self.sha256 = ""
        self.manifest: Dict[str, Any] = {}
        self.project: Dict[str, Any] = {}
        self.epics: Dict[str, Dict[str, Any]] = {}
        self.slices: Dict[str, Dict[str, Any]] = {}
        self.specs: Dict[str, Tuple[str, str]] = {}      # slice ID -> (kebab, text)
        self.intents: Dict[str, str] = {}
        self.principles: Optional[Dict[str, Any]] = None
        self.needs: Optional[Dict[str, Any]] = None
        self.mocks: Dict[str, Dict[str, Tuple[str, bytes]]] = {}   # slice ID -> sha -> (extension, bytes)
        self.ideas: Dict[str, Dict[str, Any]] = {}
        self.lookups: Dict[str, Dict[str, Any]] = {}
        self.idea_maps: Dict[str, Dict[str, Any]] = {}
        self.briefs: Dict[str, str] = {}
        self.cases: Dict[str, str] = {}
        self.documents: Dict[str, Dict[str, Any]] = {}   # PRD-NN / DES-NN -> {meta, name, raw, map, answers}
        self.facts: Dict[str, Any] = empty_facts()
        self.idea_sources: Dict[str, Dict[str, Any]] = {}   # what each moved idea's source was (identifiers, never a repository)
        self.lookups_removed: Dict[str, int] = {}
        self.stripped_jira: Dict[str, str] = {}

    @property
    def project_id(self) -> str:
        return self.project["project_id"]

    @property
    def name(self) -> str:
        return str(self.project.get("name") or self.project_id)


def empty_facts() -> Dict[str, Any]:
    return {"last_read_github_at": None, "order": {}, "slices": {}, "epics": {}, "ideas": {}, "lookups_removed": {}}


def read_archive(host: Any, studio: Any, archive: Path) -> Incoming:
    """The archive, every check of 2.3 (project_archive.read) and of its content (4.1 step 2), or a refusal of 7.2."""
    archive = Path(archive).expanduser()
    try:
        manifest, members, digest = project_archive.read_with_sha256(archive)  # read once: the hash is of the bytes checked
    except project_archive.ArchiveError as exc:
        raise refusal(host, str(exc))
    found = Incoming()
    found.path = archive.resolve() if archive.exists() else archive
    found.label = project_archive.shown(archive.name) or "The file"
    found.sha256 = digest
    found.manifest = manifest
    Content(host, studio, found).read(members)
    return found


class Content:
    """Every record in the form Studio writes, and the whole tree consistent (4.1 step 2)."""

    def __init__(self, host: Any, studio: Any, found: Incoming):
        self.host, self.studio, self.found = host, studio, found
        self.rules = host.ticket_rules()

    def bad(self, what: str, where: str, problem: str) -> Exception:
        label = self.found.label
        if what == "a slice":
            return refusal(self.host, f"{label} holds a slice that is not in the form Product Studio writes ({where}: {problem}).")
        return refusal(self.host, f"{label} holds {what} that is not in the form Product Studio writes ({where}: {problem}).")

    def json(self, data: bytes, what: str, where: str) -> Dict[str, Any]:
        try:
            value = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise self.bad(what, where, "it is not JSON")
        if not isinstance(value, dict):
            raise self.bad(what, where, "it is not a JSON object")
        problem = json_bounds(value)
        if problem:
            raise self.bad(what, where, problem)
        return value

    def text(self, data: bytes, what: str, where: str) -> str:
        try:
            value = data.decode("utf-8")
        except UnicodeDecodeError:
            raise self.bad(what, where, "it cannot be read as text")
        if "\x00" in value:
            raise self.bad(what, where, "it holds binary data")
        return value

    def shape(self, kind: str, data: Dict[str, Any], what: str, where: str) -> None:
        errors: List[str] = []
        product._shape(kind, data, where, errors)  # noqa: SLF001  the structural validator's own shape rules
        if errors:
            raise self.bad(what, where, errors[0].split(": ", 1)[-1])

    def read(self, members: Dict[str, bytes]) -> None:
        found = self.found
        parsed: Dict[str, List[Tuple[Tuple[str, ...], bytes]]] = {name: [] for name, _ in MEMBER}
        for member, data in sorted(members.items()):
            if member == project_archive.FACTS:
                continue
            for name, pattern in MEMBER:
                match = pattern.fullmatch(member)
                if match:
                    parsed[name].append((match.groups(), data))
                    break
            else:
                raise refusal(self.host, f"{found.label} is not in a form MACH can read safely: it holds a folder or file MACH does not know "
                                         f"({project_archive.shown(member)}).")
        if not parsed["project"]:
            raise self.bad("a project", "product/project.json", "the archive holds no project")
        project = self.json(parsed["project"][0][1], "the project", "product/project.json")
        self.shape("project", project, "the project", "product/project.json")
        if project["project_id"] != found.manifest.get("project_id"):
            raise self.bad("the project", "product/project.json", "its project_id is not the one the archive's list names")
        found.project = project
        pid = project["project_id"]

        for (ident,), data in parsed["epic"]:
            record = self.json(data, "an epic", ident)
            self.shape("epic", record, "an epic", ident)
            if record["epic_id"] != ident:
                raise self.bad("an epic", ident, "its epic_id differs from its file name")
            if record["project_id"] != pid:
                raise self.bad("an epic", ident, "it belongs to another project")
            if isinstance(record.get("tracking"), dict) and product.JIRA_RE.fullmatch(str(record["tracking"].get("jira") or "")):
                found.stripped_jira[ident] = record["tracking"]["jira"]
            found.epics[ident] = record

        for (ident,), data in parsed["slice"]:
            record = self.json(data, "a slice", ident)
            self.shape("slice", record, "a slice", ident)
            if record["slice_id"] != ident:
                raise self.bad("a slice", ident, "its slice_id differs from its file name")
            if record["project_id"] != pid:
                raise self.bad("a slice", ident, "it belongs to another project")
            if record["epic_id"] not in [key for (key,), _ in parsed["epic"]]:
                raise self.bad("a slice", ident, f"its epic {record['epic_id']} is not in the archive")
            if isinstance(record.get("tracking"), dict) and product.JIRA_RE.fullmatch(str(record["tracking"].get("jira") or "")):
                found.stripped_jira[ident] = record["tracking"]["jira"]
            found.slices[ident] = record

        for (ident, kebab), data in parsed["spec"]:
            if ident not in found.slices:
                raise self.bad("a slice", ident, "its spec is in the archive but its work order is not")
            if ident in found.specs:
                raise self.bad("a slice", ident, "it has more than one spec")
            text = self.text(data, "a slice", ident)
            heading = spec_heading(text)
            if heading != ident:
                raise self.bad("a slice", ident, f"its spec's title names {heading or 'no slice'}, not {ident}")
            found.specs[ident] = (kebab, text)
        for ident, record in found.slices.items():
            spec = found.specs.get(ident)
            if record.get("spec_path") is not None and (spec is None or record["spec_path"] != rel_spec(ident, spec[0])):
                raise self.bad("a slice", ident, "its spec_path does not name the spec the archive holds")
        for (ident,), data in parsed["intent"]:
            if ident not in found.slices:
                raise self.bad("a slice", ident, "its why is in the archive but its work order is not")
            found.intents[ident] = self.text(data, "a slice", ident)

        for (ident, digest, ext), data in parsed["mock"]:
            record = found.slices.get(ident)
            if record is None:
                raise self.bad("a slice", ident, "its design mock is in the archive but its work order is not")
            item = next((m for m in record.get("mocks") or [] if isinstance(m, dict) and m.get("sha256") == digest), None)
            if item is None:
                raise self.bad("a slice", ident, f"design mock {digest[:12]} is not one its work order lists")
            if self.rules.MOCK_FORMATS.get(item.get("format")) != "." + ext:
                raise self.bad("a slice", ident, f"design mock {digest[:12]} is not the kind of picture its work order lists")
            problem = self.rules.check_mock_file(item, data)
            if problem:
                raise self.bad("a slice", ident, f"design mock {digest[:12]} is not a picture Product Studio can check: {problem}")
            found.mocks.setdefault(ident, {})[digest] = ("." + ext, data)
        for ident, record in found.slices.items():
            for item in record.get("mocks") or []:
                if item["sha256"] not in found.mocks.get(ident, {}):
                    raise self.bad("a slice", ident, f"design mock {item['sha256'][:12]} is listed but not in the archive")

        if parsed["principles"]:
            record = self.json(parsed["principles"][0][1], "the principles", "product/principles.json")
            errors: List[str] = []
            product._principles(record, pid, errors)  # noqa: SLF001
            problems = errors or self.rules.principle_problems(record.get("principles"))
            if problems:
                raise self.bad("the principles", "product/principles.json", str(problems[0]).split(": ", 1)[-1])
            found.principles = record
        if parsed["needs"]:
            record = self.json(parsed["needs"][0][1], "the technical needs", "product/needs.json")
            errors = []
            product._needs(record, pid, errors)  # noqa: SLF001
            problems = errors or self.rules.need_problems(record.get("needs")) or self.rules.needs_none_problems(record.get("needs"), record.get("none"))
            if problems:
                raise self.bad("the technical needs", "product/needs.json", str(problems[0]).split(": ", 1)[-1])
            found.needs = record

        self.ideas(parsed)
        self.documents(parsed, "PRD")
        self.documents(parsed, "DES")
        found.facts = self.facts(members.get(project_archive.FACTS))
        self.consistent()

    # -- ideas --

    def ideas(self, parsed: Dict[str, List[Tuple[Tuple[str, ...], bytes]]]) -> None:
        found = self.found
        for (ident,), data in parsed["idea"]:
            record = self.json(data, "an idea", ident)
            record = self.moved(ident, record)
            problems = shape.record_problems(record, self.rules)
            if problems:
                raise self.bad("an idea", ident, problems[0])
            if record["idea_id"] != ident:
                raise self.bad("an idea", ident, "its idea_id differs from its file name")
            found.ideas[ident] = record
        for part, store in (("lookups", found.lookups), ("idea_map", found.idea_maps)):
            for (ident,), data in parsed[part]:
                if ident not in found.ideas:
                    raise self.bad("an idea", ident, f"its {'lookups' if part == 'lookups' else 'map'} are in the archive but its record is not")
                record = self.json(data, "an idea", ident)
                if part == "lookups":
                    record = self.lookups(ident, record)
                else:
                    problem = map_problem(record, "idea_id", ident, None)
                    if problem:
                        raise self.bad("an idea", ident, problem)
                store[ident] = record
        for part, store in (("brief", found.briefs), ("case", found.cases)):
            for (ident,), data in parsed[part]:
                if ident not in found.ideas:
                    raise self.bad("an idea", ident, f"its {part} is in the archive but its record is not")
                store[ident] = self.text(data, "an idea", ident)

    def moved(self, ident: str, record: Dict[str, Any]) -> Dict[str, Any]:
        """The idea as it arrives: a source from an issue or a fault is `moved` (1.3), what it was kept for the import record
        (identifiers only, never a repository); its issue, who decided and who looked back are not carried. Export does the
        same; doing it again here keeps an archive made otherwise from bringing a repository or an account in."""
        record = copy.deepcopy(record)
        source = record.get("source")
        if isinstance(source, dict) and source.get("kind") in ("idea", "request", "fault"):
            kept = {"kind": source["kind"]}
            if source["kind"] == "fault" and FAULT_RE.fullmatch(str(source.get("ticket") or "")):
                kept["ticket"] = source["ticket"]
            elif type(source.get("number")) is int and source["number"] >= 1:
                kept["number"] = source["number"]
            self.found.idea_sources[ident] = kept
            record["source"] = {"kind": "moved"}
        if "issue" in record:
            record["issue"] = None
        if isinstance(record.get("verdict"), dict):
            record["verdict"]["by"] = None
        lookback = record.get("lookback")
        if isinstance(lookback, dict):
            for group in ("outcomes", "assumptions"):
                for entry in (lookback.get(group) or {}).values() if isinstance(lookback.get(group), dict) else []:
                    if isinstance(entry, dict):
                        entry["by"] = None
                        entry.pop("comment", None)
        return record

    def lookups(self, ident: str, record: Dict[str, Any]) -> Dict[str, Any]:
        problem = lookups_problem(record, ident)
        if problem:
            raise self.bad("an idea", ident, f"its lookups are not in the form Shape writes: {problem}")
        record = copy.deepcopy(record)
        record.pop("shipped_commit", None)  # a commit of the old repository can be searched for on GitHub (export strips it too)
        if "similar" in record:
            kept = [item for item in record["similar"] if "request" not in item]
            if len(kept) != len(record["similar"]):
                self.found.lookups_removed[ident] = len(record["similar"]) - len(kept)
            record["similar"] = kept
        return record

    # -- PRDs and designs --

    def documents(self, parsed: Dict[str, List[Tuple[Tuple[str, ...], bytes]]], kind: str) -> None:
        found = self.found
        part = "prd" if kind == "PRD" else "design"
        what = "a PRD" if kind == "PRD" else "a design"
        key = "prd_id" if kind == "PRD" else "design_id"
        base = "document" if kind == "PRD" else "design"
        metas = {ident: data for (ident,), data in parsed[f"{part}_meta"]}
        docs: Dict[str, List[Tuple[str, bytes]]] = {}
        for (ident, name), data in parsed[f"{part}_doc"]:
            docs.setdefault(ident, []).append((name, data))
        maps = {ident: data for (ident,), data in parsed[f"{part}_map"]}
        answers: Dict[str, Dict[str, bytes]] = {}
        if kind == "PRD":
            for (ident, answer_key), data in parsed["prd_answers"]:
                answers.setdefault(ident, {})[answer_key] = data
        for ident in sorted(set(metas) | set(docs) | set(maps) | set(answers)):
            if ident not in metas:
                raise self.bad(what, ident, "its record is not in the archive")
            meta = self.json(metas[ident], what, ident)
            if meta.get(key) != ident:
                raise self.bad(what, ident, f"its {key} differs from its folder")
            if meta.get("file") not in (f"{base}.md", f"{base}.txt") or not isinstance(meta.get("sha256"), str) \
                    or not prd.HEX_RE.fullmatch(meta["sha256"]) or type(meta.get("line_count")) is not int \
                    or not isinstance(meta.get("sections"), list) or set(meta) - DOCUMENT_META_KEYS - {key} \
                    or not isinstance(meta.get("name"), str) or meta.get("format") != prd.FORMATS[Path(meta["file"]).suffix]:
                raise self.bad(what, ident, "its record is not in the form Product Studio writes")
            held = docs.get(ident, [])
            if len(held) != 1 or held[0][0] != meta["file"]:
                raise self.bad(what, ident, "its document is not the one its record names")
            raw = held[0][1]
            if sha(raw) != meta["sha256"]:
                raise self.bad(what, ident, "its document no longer matches what was imported")
            try:
                prd.check_document(raw, Path(meta["file"]).suffix, what)
            except prd.PrdError as exc:
                raise self.bad(what, ident, str(exc).rstrip("."))
            lines = prd.document_lines(raw)
            if meta["line_count"] != len(lines) or meta.get("bytes", len(raw)) != len(raw):
                raise self.bad(what, ident, "its record does not describe its document")
            # Its sections are made from the document by prd.sections_of, as when it was imported; made again here, so what
            # status and show read is never a section an archive made up.
            meta = {**meta, "sections": prd.sections_of(lines, lambda text, limit: self.rules.bound_text(text, limit, one_line=True)[0])}
            entry: Dict[str, Any] = {"meta": meta, "name": meta["file"], "raw": raw, "map": None, "answers": {}}
            if ident in maps:
                record = self.json(maps[ident], what, ident)
                if kind == "PRD":
                    problem = map_problem(record, "prd_id", ident, meta["line_count"])
                else:
                    record = copy.deepcopy(record)
                    record.pop("published", None)  # the ready folder stays behind (1.2)
                    problem = design_map_problem(record, ident, meta["line_count"])
                if problem:
                    raise self.bad(what, ident, problem)
                entry["map"] = record
            for answer_key, data in sorted(answers.get(ident, {}).items()):
                record = self.json(data, what, ident)
                problem = answers_problem(record, ident, answer_key, meta["line_count"])
                if problem:
                    raise self.bad(what, ident, f"its answers for {answer_key} are not in the form Product Studio writes: {problem}")
                entry["answers"][answer_key] = record
            found.documents[ident] = entry

    # -- facts.json --

    def facts(self, data: Optional[bytes]) -> Dict[str, Any]:
        """What the source knew that is not a workspace file (2.1), each part checked; IDs the archive does not hold are dropped."""
        facts = empty_facts()
        if data is None:
            return facts
        raw = self.json(data, "the archive's facts", project_archive.FACTS)
        where = project_archive.FACTS

        def mapping(key: str) -> Dict[str, Any]:
            value = raw.get(key, {})
            if value is None:
                return {}
            if not isinstance(value, dict):
                raise self.bad("the archive's facts", where, f"{key} is not an object")
            return value

        read_at = raw.get("last_read_github_at")
        if read_at is not None and not (isinstance(read_at, str) and product._is_timestamp(read_at)):  # noqa: SLF001
            raise self.bad("the archive's facts", where, "last_read_github_at is not a date-time")
        facts["last_read_github_at"] = read_at
        for epic_id, slices in mapping("order").items():
            if not isinstance(slices, list) or any(not isinstance(s, str) for s in slices):
                raise self.bad("the archive's facts", where, f"the order of {epic_id} is not a list of slices")
            if epic_id in self.found.epics:
                listed = [s for s in dict.fromkeys(slices) if s in self.found.slices and self.found.slices[s]["epic_id"] == epic_id]
                facts["order"][epic_id] = listed
        for slice_id, entry in mapping("slices").items():
            if not isinstance(entry, dict):
                raise self.bad("the archive's facts", where, f"{slice_id} is not an object")
            was, revision = entry.get("was"), entry.get("revision")
            if was is not None and was not in handoff.PROGRESS:
                raise self.bad("the archive's facts", where, f"what {slice_id} was is not a state MACH knows")
            if revision is not None and (type(revision) is not int or revision < 0):
                raise self.bad("the archive's facts", where, f"{slice_id}'s revision is not a number")
            jira, request, note = entry.get("jira"), entry.get("request"), entry.get("note")
            if jira is not None and not (isinstance(jira, str) and product.JIRA_RE.fullmatch(jira)):
                raise self.bad("the archive's facts", where, f"{slice_id}'s Jira key is not a Jira key")
            if request is not None and (type(request) is not int or request < 1):
                raise self.bad("the archive's facts", where, f"{slice_id}'s request is not an issue number")
            if note is not None and (not isinstance(note, str) or len(note) > NOTE_CHARS):
                raise self.bad("the archive's facts", where, f"{slice_id}'s resume note is not a short text")
            ready = entry.get("was_ready") if type(entry.get("was_ready")) is bool else None  # the exporter's own word, when it gives one
            if slice_id in self.found.slices:
                facts["slices"][slice_id] = {key: value for key, value in (("was", was), ("revision", revision), ("jira", jira),
                                                                           ("request", request), ("note", note), ("was_ready", ready))
                                             if value is not None}
        for epic_id, entry in mapping("epics").items():
            jira = entry.get("jira") if isinstance(entry, dict) else None
            if not isinstance(entry, dict) or (jira is not None and not (isinstance(jira, str) and product.JIRA_RE.fullmatch(jira))):
                raise self.bad("the archive's facts", where, f"{epic_id} is not in the form MACH writes")
            if epic_id in self.found.epics and jira:
                facts["epics"][epic_id] = {"jira": jira}
        for idea_id, entry in mapping("ideas").items():
            if not isinstance(entry, dict):
                raise self.bad("the archive's facts", where, f"{idea_id} is not in the form MACH writes")
            was = entry.get("was_source")
            if was is None:  # typed here, or a change to a shipped rule: nothing elsewhere to remember
                continue
            if not isinstance(was, dict) or was.get("kind") not in ("idea", "request", "fault"):
                raise self.bad("the archive's facts", where, f"what {idea_id}'s source was is not in the form MACH writes")
            kept = {"kind": was["kind"]}
            if was["kind"] == "fault":
                if not FAULT_RE.fullmatch(str(was.get("ticket") or "")):
                    raise self.bad("the archive's facts", where, f"what {idea_id}'s source was is not in the form MACH writes")
                kept["ticket"] = was["ticket"]
            else:
                if type(was.get("number")) is not int or was["number"] < 1:
                    raise self.bad("the archive's facts", where, f"what {idea_id}'s source was is not in the form MACH writes")
                kept["number"] = was["number"]
            if idea_id in self.found.ideas:
                self.found.idea_sources.setdefault(idea_id, kept)
                facts["ideas"][idea_id] = {"was_source": kept}
        for idea_id, count in mapping("lookups_removed").items():
            if type(count) is not int or count < 0:
                raise self.bad("the archive's facts", where, f"{idea_id}'s count of lookups left behind is not a number")
            if idea_id in self.found.ideas:
                self.found.lookups_removed[idea_id] = self.found.lookups_removed.get(idea_id, 0) + count
        return facts

    # -- the whole tree --

    def consistent(self) -> None:
        """The workspace the archive describes, written to a temporary folder outside the project from the records as
        parsed (paths built here from IDs), checked with product.validate_workspace, and removed."""
        found = self.found
        folder = Path(tempfile.mkdtemp(prefix="mach-import-check-"))
        try:
            files: Dict[str, bytes] = {PROJECT_REL: canonical_bytes(self.host, found.project)}
            files.update({rel_epic(i): canonical_bytes(self.host, r) for i, r in found.epics.items()})
            files.update({rel_slice(i): canonical_bytes(self.host, r) for i, r in found.slices.items()})
            files.update({rel_spec(i, kebab): text.encode("utf-8") for i, (kebab, text) in found.specs.items()})
            if found.principles is not None:
                files[PRINCIPLES_REL] = canonical_bytes(self.host, found.principles)
            if found.needs is not None:
                files[NEEDS_REL] = canonical_bytes(self.host, found.needs)
            for rel, data in files.items():
                target = folder / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            report = product.validate_workspace(folder)
        finally:
            shutil.rmtree(str(folder), ignore_errors=True)
        if not report["valid"]:
            error = report["errors"][0]
            location, _, problem = error.partition(": ")
            ident = Path(location).stem if location.startswith("product/slices/") else location
            raise self.bad("a slice" if location.startswith("product/slices") else "a project", ident, problem or error)


READY_WAS = ("approved", "ready_to_build", "being_built", "question", "shipped")  # what a slice was when it had been marked ready


def ready_in_source(found: Incoming) -> List[str]:
    """The archive's slices (old IDs) that were ready in the old repository: as the exporter says it per slice (facts.json
    `slices[ID].was_ready`), else, in an archive made before it said so, from what facts.json records each slice was (marked
    ready to build, being built, with a question from the builders, shipped, or approved). A slice replaced there is never
    counted. (The manifest holds no such field: its reader refuses keys it does not know.)"""
    told = {ident: entry["was_ready"] for ident, entry in found.facts["slices"].items() if type(entry.get("was_ready")) is bool}
    out = []
    for ident, work in found.slices.items():
        if work.get("status") == "superseded":
            continue
        said = told.get(ident)
        if said is None:
            said = found.facts["slices"].get(ident, {}).get("was") in READY_WAS
        if said:
            out.append(ident)
    return sorted(out, key=number)


def spec_heading(text: str) -> Optional[str]:
    """The slice ID the spec's first top-level heading names (`# SLICE-NNN: Title`), outside code; None when there is none."""
    fence = False
    for line in text.lstrip("﻿").splitlines():
        if project_ids.FENCE_RE.match(line):
            fence = not fence
            continue
        if fence:
            continue
        match = re.match(r"^#\s+(.+?)\s*$", line)
        if match:
            title = re.match(r"^(SLICE-[0-9]{3,}): \S", match.group(1))
            return title.group(1) if title else None
    return None


# ---- every record against what its readers need (status, show, map-status, chain, resume read these fields directly) ----

MAX_DEPTH = 24          # no record Studio writes nests deeper than about eight; an archive's may not go past this
MAX_VALUES = 200000     # values in one record (a 1 MB member holds far fewer real ones)
DOCUMENT_META_KEYS = {"schema_version", "name", "format", "file", "bytes", "sha256", "line_count", "sections", "imported_at"}
LOOKUP_TOP_KEYS = set(shape.LOOKUP_LIMITS) | {"schema_version", "idea_id", "recorded_at", "shipped_commit"}
LOOKUP_ITEM_KEYS = {"shipped_rules": {"rule", "in_force", "epic_id", "note"}, "similar": {"idea", "request", "note"},
                    "principles": {"id", "status", "note"}, "policies": {"id", "owner", "note"}}
MAP_KEYS = {"prd_id": {"schema_version", "prd_id", "prd_sha256", "revision", "epics", "slices", "settled", "applied", "mapped_at"},
            "idea_id": {"schema_version", "idea_id", "brief_sha256", "route", "revision", "epics", "slices", "settled", "applied", "mapped_at"}}
SETTLED_KEYS = {"at", "as", "slice", "reason"}
DESIGN_MAP_KEYS = {"schema_version", "design_id", "design_sha256", "required_topics", "revision", "topics", "other", "conflicts", "mapped_at"}
CONFLICT_KEYS = {"n", "lines", "against", "note", "settled", "reason", "by", "at"}
ANSWERS_KEYS = {"schema_version", "slice_id", "prd_id", "prd_sha256", "map_slice", "revision", "answers", "drafted_at", "confirmations"}
ANSWER_KEYS = {"n", "kind", "question", "answer", "cites", "state"}
ANSWER_STATES = ("pending", "accepted", "discuss")
TEXT_CHARS = 4000       # a note, reason or summary: Studio bounds each to a few hundred characters
TRYING = "trying"       # what apply records for a map slice while it is being made


def json_bounds(value: Any) -> Optional[str]:
    """None when a JSON value is no deeper and no larger than any record Studio writes; else the problem. Iterative, so a
    value nested hundreds deep is refused with a sentence rather than ending the import with an internal error."""
    stack: List[Tuple[Any, int]] = [(value, 1)]
    count = 0
    while stack:
        item, depth = stack.pop()
        count += 1
        if depth > MAX_DEPTH:
            return "it is nested more deeply than any record Product Studio writes"
        if count > MAX_VALUES:
            return "it holds far more values than any record Product Studio writes"
        if isinstance(item, dict):
            stack.extend((inner, depth + 1) for inner in item.values())
        elif isinstance(item, list):
            stack.extend((inner, depth + 1) for inner in item)
    return None


def _text_or_none(value: Any) -> bool:
    return value is None or (isinstance(value, str) and len(value) <= TEXT_CHARS)


def _int(value: Any, low: int = 0) -> bool:
    return type(value) is int and value >= low


def _ranges(value: Any, line_count: Optional[int], at_least: int = 1) -> bool:
    """Line ranges as Studio stores them: [[first, last], ...], each forward from line 1 and, when the count is known, inside it."""
    return (isinstance(value, list) and at_least <= len(value) <= 200
            and all(isinstance(r, list) and len(r) == 2 and all(type(n) is int for n in r) and 1 <= r[0] <= r[1]
                    and (line_count is None or r[1] <= line_count) for r in value))


def lookups_problem(record: Dict[str, Any], ident: str) -> Optional[str]:
    """Lookups as Shape saves them (shape.cmd_idea_lookups, shape_route.cmd_idea_change): the four groups of checked items,
    each with only the fields check_lookups writes, and schema_version, idea_id, recorded_at and shipped_commit."""
    extra = sorted(set(record) - LOOKUP_TOP_KEYS)
    if extra:
        return f"it holds {extra[0][:40]}, which Shape never writes"
    if "schema_version" in record and not _int(record["schema_version"], 1):
        return "its schema_version is not a number"
    if "idea_id" in record and record["idea_id"] != ident:
        return "its idea_id differs from its file"
    if record.get("recorded_at") is not None and not product._is_timestamp(record["recorded_at"]):  # noqa: SLF001
        return "recorded_at is not a date-time"
    if record.get("shipped_commit") is not None and not (isinstance(record["shipped_commit"], str) and re.fullmatch(r"[0-9a-f]{4,64}", record["shipped_commit"])):
        return "shipped_commit is not a commit"
    for group, limit in shape.LOOKUP_LIMITS.items():
        items = record.get(group, [])
        if not isinstance(items, list) or len(items) > limit or any(not isinstance(item, dict) for item in items):
            return f"{group} is not a list of at most {limit} entries"
        for item in items:
            unknown = sorted(set(item) - LOOKUP_ITEM_KEYS[group])
            if unknown:
                return f"an entry of {group} holds {unknown[0][:40]}, which Shape never writes"
            if not _text_or_none(item.get("note")):
                return f"an entry of {group} has a note that is not a short text"
            if group == "shipped_rules":
                ok = (isinstance(item.get("rule"), str) and product.SHIPPED_RULE_RE.fullmatch(item["rule"])
                      and type(item.get("in_force", False)) is bool and (item.get("epic_id") is None or product.EPIC_RE.fullmatch(str(item["epic_id"]))))
            elif group == "similar":
                ok = ("idea" in item) != ("request" in item) and (
                    shape.IDEA_RE.fullmatch(str(item.get("idea"))) if "idea" in item else _int(item.get("request"), 1))
            elif group == "principles":
                ok = shape.PRINCIPLE_RE.fullmatch(str(item.get("id"))) and _text_or_none(item.get("status"))
            else:
                ok = shape.POLICY_RE.fullmatch(str(item.get("id"))) and _text_or_none(item.get("owner"))
            if not ok:
                return f"an entry of {group} is not one Shape writes"
    return None


def _settled_problem(settled: Any, key_rule: "re.Pattern[str]", slice_keys: Set[str]) -> Optional[str]:
    if settled is None:
        return None
    if not isinstance(settled, dict):
        return "its settlements are not an object"
    for name, entry in settled.items():
        if not key_rule.fullmatch(str(name)):
            return f"it settles '{str(name)[:20]}', which is not one of its document's parts"
        if not isinstance(entry, dict) or set(entry) - SETTLED_KEYS:
            return f"the settlement of {str(name)[:20]} holds fields Product Studio never writes"
        if entry.get("as") not in ("slice",) + prd.SETTLE_AS:
            return f"the settlement of {str(name)[:20]} is not a slice, out of scope or later"
        if entry.get("as") == "slice" and entry.get("slice") not in slice_keys:
            return f"the settlement of {str(name)[:20]} names a slice its map does not have"
        if not _text_or_none(entry.get("reason")) or not _text_or_none(entry.get("at")):
            return f"the settlement of {str(name)[:20]} is not in the form Product Studio writes"
    return None


def map_problem(record: Dict[str, Any], key: str, ident: str, line_count: Optional[int]) -> Optional[str]:
    """An idea's map (key idea_id) or a PRD's (prd_id), checked with prd.check_map's own rules (and, for an idea, the outcomes
    each slice carries) as it would check the map when recorded, so status, map-status, chain and resume can read every field
    they read. References to epics and slices outside the map are checked against the archive later, not here."""
    if record.get(key) != ident:
        return f"its map's {key} differs from its file"
    extra = sorted(set(record) - MAP_KEYS[key])
    if extra:
        return f"its map holds {extra[0][:40]}, which Product Studio never writes"
    if not _int(record.get("revision"), 1):
        return "its map's revision is not a number"
    slices = record.get("slices")
    if not isinstance(slices, list) or not isinstance(record.get("epics", []), list):
        return "its map is not in the form Product Studio writes"
    raw_slices = []
    for item in slices:
        if not isinstance(item, dict) or not _ranges(item.get("cites"), line_count):
            return "a slice of its map does not cite the lines it rests on"
        raw_slices.append({**item, "cites": [f"{a}-{b}" for a, b in item["cites"]]})
    epics_here = [i.get("epic") for i in slices if isinstance(i.get("epic"), str) and prd.EPIC_ID_RE.fullmatch(i["epic"])]
    slices_here = [d for i in slices for d in (i.get("depends_on") if isinstance(i.get("depends_on"), list) else [])
                   if isinstance(d, str) and prd.SLICE_ID_RE.fullmatch(d)]
    if key == "idea_id":
        def outcomes(item: Dict[str, Any], name: str, problems: List[str]) -> Dict[str, Any]:
            given = item.get("outcomes")
            if not isinstance(given, list) or not given or len(given) > 50 or len(set(map(str, given))) != len(given) \
                    or any(not isinstance(o, str) or not product.OUTCOME_RE.fullmatch(o) for o in given):
                problems.append(f"slice {name}: its outcomes are not the brief's outcomes")
            return {}
        _, problems = prd.check_map({"epics": record.get("epics", []), "slices": raw_slices}, line_count or 10 ** 6, epics_here, slices_here,
                                    "the brief", extra=("outcomes",), check_extra=outcomes)
    else:
        _, problems = prd.check_map({"epics": record.get("epics", []), "slices": raw_slices}, line_count or 10 ** 6, epics_here, slices_here)
    if problems:
        return "its map is not in the form Product Studio writes: " + str(problems[0]).rstrip(".")
    keys = {item["key"] for item in slices}
    problem = _settled_problem(record.get("settled"), re.compile(r"[1-9][0-9]{0,5}") if key == "prd_id" else product.OUTCOME_RE, keys)
    if problem:
        return f"its map is not in the form Product Studio writes: {problem}"
    applied = record.get("applied", {})
    if applied is not None and (not isinstance(applied, dict) or set(applied) - {"epics", "slices"}
                                or any(not isinstance(applied.get(g, {}), dict) for g in ("epics", "slices"))
                                or any(not isinstance(v, str) or not (v == TRYING or project_ids._split(v)) or not isinstance(k, str)  # noqa: SLF001
                                       for g in ("epics", "slices") for k, v in (applied.get(g) or {}).items())):
        return "what its map made is not in the form Product Studio writes"
    return None


def design_map_problem(record: Dict[str, Any], ident: str, line_count: int) -> Optional[str]:
    """A design's map as design.cmd_map and cmd_settle write it: what summary, show and publish read."""
    if record.get("design_id") != ident:
        return "its map's design_id differs from its folder"
    extra = sorted(set(record) - DESIGN_MAP_KEYS)
    if extra:
        return f"its map holds {extra[0][:40]}, which Product Studio never writes"
    if not _int(record.get("revision"), 1) or not isinstance(record.get("topics"), dict) or not isinstance(record.get("other"), list) \
            or not isinstance(record.get("conflicts"), list):
        return "its map is not in the form Product Studio writes"
    if "required_topics" in record and not (isinstance(record["required_topics"], list) and all(isinstance(t, str) for t in record["required_topics"])):
        return "its map's required topics are not a list of topics"
    for topic, entry in record["topics"].items():
        state = entry.get("state") if isinstance(entry, dict) else None
        if state not in design.STATES:
            return f"its map's topic {str(topic)[:30]} has no state Product Studio knows"
        fields = {"silent": {"state"}, "decided": {"state", "lines", "summary"}, "partly": {"state", "lines", "summary", "missing"}}[state]
        if set(entry) != fields or (state != "silent" and (not _ranges(entry["lines"], line_count) or not isinstance(entry["summary"], str)
                                                           or not _text_or_none(entry["summary"]))) \
                or (state == "partly" and (not isinstance(entry["missing"], str) or not _text_or_none(entry["missing"]))):
            return f"its map's topic {str(topic)[:30]} is not in the form Product Studio writes"
    for entry in record["other"]:
        if not isinstance(entry, dict) or set(entry) != {"lines", "summary", "applies_to"} or not _ranges(entry["lines"], line_count) \
                or not isinstance(entry["summary"], str) or not _text_or_none(entry["summary"]) \
                or not isinstance(entry["applies_to"], list) or any(not isinstance(a, str) for a in entry["applies_to"]):
            return "a decision under 'other' in its map is not in the form Product Studio writes"
    for entry in record["conflicts"]:
        if not isinstance(entry, dict) or set(entry) - CONFLICT_KEYS or not {"n", "lines", "against", "note"} <= set(entry) \
                or not _int(entry["n"], 1) or not _ranges(entry["lines"], line_count) \
                or not (isinstance(entry["against"], str) and design.AGAINST_RE.fullmatch(entry["against"])) \
                or not isinstance(entry["note"], str) or not _text_or_none(entry["note"]) \
                or (entry.get("settled") is not None and entry["settled"] not in design.SETTLE_WORDS) \
                or not all(_text_or_none(entry.get(k)) for k in ("reason", "by", "at")):
            return "a conflict in its map is not in the form Product Studio writes"
    return None


def answers_problem(record: Dict[str, Any], ident: str, key: str, line_count: int) -> Optional[str]:
    """A PRD's drafted answers for one map slice as prd.cmd_draft and cmd_confirm write them."""
    if record.get("prd_id") != ident or record.get("map_slice") != key or not product.SLICE_RE.fullmatch(str(record.get("slice_id") or "")):
        return "they do not name this PRD, map slice and a slice"
    extra = sorted(set(record) - ANSWERS_KEYS)
    if extra:
        return f"they hold {extra[0][:40]}, which Product Studio never writes"
    answers = record.get("answers")
    if not isinstance(answers, list) or len(answers) > prd.MAX_ANSWERS:
        return "the answers are not a list"
    for item in answers:
        if not isinstance(item, dict) or set(item) - ANSWER_KEYS or not _int(item.get("n"), 1) or item.get("kind") not in prd.KINDS \
                or not isinstance(item.get("question"), str) or not _text_or_none(item.get("question")) or not _text_or_none(item.get("answer")) \
                or not _ranges(item.get("cites", []), line_count, at_least=0) or item.get("state") not in ANSWER_STATES:
            return "an answer is not in the form Product Studio writes"
    confirmations = record.get("confirmations", [])
    if not isinstance(confirmations, list) or any(
            not isinstance(c, dict) or set(c) - {"at", "accepted", "discuss"}
            or any(not isinstance(c.get(k, []), list) or any(not _int(n, 1) for n in c.get(k, [])) for k in ("accepted", "discuss"))
            for c in confirmations):
        return "the confirmations are not in the form Product Studio writes"
    return None


def canonical_bytes(host: Any, data: Dict[str, Any]) -> bytes:
    return host.canonical(data).encode("utf-8")


# ---- the destination (4.1 step 3, 4.2) ----


def destination_errors(studio: Any) -> List[str]:
    """The destination's own structural problems. A workspace with no project yet is not a problem here: it is the new-project case."""
    report = studio.structural()
    errors = list(report["errors"])
    if not studio.path("project").is_file() and not studio.path("project").is_symlink():
        errors = [error for error in errors if not error.startswith(f"{PROJECT_REL}:")]
    return errors


def check_destination(host: Any, studio: Any, found: Incoming) -> None:
    if host.policies_helper().unattended():
        raise refusal(host, "Bringing in a project is a product manager's act; a supervised execution does not do it.")
    folder = imports_folder(studio)
    if folder.is_symlink():
        raise refusal(host, f"{folder} is a symbolic link. Product Studio only works in a real folder inside the project.")
    other = _unfinished_record(studio)
    if other is not None and other["archive_sha256"] != found.sha256:
        name = (other.get("archive") or {}).get("file") or "another archive"
        raise refusal(host, f"Bringing in {name} stopped part way. Finish it first: run the import again with that file, or set it aside.")
    errors = destination_errors(studio)
    if errors:
        raise refusal(host, "Your own workspace has problems that must be fixed first: " + "; ".join(errors[:5]) + ".")


def choose_mode(host: Any, studio: Any, found: Incoming) -> Tuple[str, str, List[str]]:
    """("join" or "new", the project ID the result belongs to, notes)."""
    notes: List[str] = []
    if studio.path("project").is_file():
        into = studio.project_id()
        if into == found.project_id:
            raise refusal(host, f"The archive is of the project '{found.project_id}', which is already here. "
                                "Importing it would make a second copy of every epic and slice.")
        return "join", into, notes
    seen = studio.handoff().github_project()
    if seen.get("reachable"):
        projects = seen.get("projects") or []
        if len(projects) > 1:
            numbers = ", ".join(f"#{item['number']}" for item in projects)
            raise refusal(host, f"This repository has several project issues on GitHub ({numbers}). One repository holds one project. "
                                "Close the one that should not be there, then try again.")
        if projects:
            raise refusal(host, host.say(
                f"This repository already has a project on GitHub (#{projects[0]['number']}), and your workspace does not have it yet. "
                "Define the project first, which takes it from GitHub (project init), then bring the archive in; its epics join that project.",
                f"This repository already has a project on GitHub (#{projects[0]['number']}), and your workspace does not have it yet. "
                "Define the project first, which takes it from GitHub, then bring the archive in; its epics join that project."))
    elif seen.get("problem"):
        notes.append(f"MACH could not read GitHub to see whether this repository already has a project there ({str(seen['problem']).rstrip('.')}); "
                     "marking a slice ready checks again.")
    return "new", found.project_id, notes


# ---- the numbers (4.3) ----


def incoming_ids(studio: Any, found: Incoming) -> Dict[str, List[str]]:
    """Every ID of the seven kinds the archive holds, and every slice ID a spec reserves with a (Deferred to SLICE-NNN) pointer."""
    pointer = studio.validate_slice.POINTER_LINE_RE
    reserved = set()
    for _, text in found.specs.values():
        for line in text.splitlines():
            match = pointer.match(line)
            if match:
                reserved.add(match.group(2))
    ids = {
        "SLICE": sorted(set(found.slices) | reserved),
        "EPIC": sorted(found.epics),
        "IDEA": sorted(found.ideas),
        "PP": sorted(item["id"] for item in (found.principles or {}).get("principles") or []),
        "TN": sorted(item["need_id"] for item in (found.needs or {}).get("needs") or []),
        "PRD": sorted(i for i in found.documents if prefix(i) == "PRD"),
        "DES": sorted(i for i in found.documents if prefix(i) == "DES"),
    }
    return ids


def counted(host: Any, studio: Any) -> Tuple[Dict[str, Set[int]], Dict[str, Dict[str, Any]], Dict[str, Any]]:
    """Every number in use here, by kind, from everything today's allocators count and from GitHub read now (reads only;
    refresh_numbers keeps what it read in Studio's cache of GitHub, as prd apply does). Returns (used, how each was counted,
    what GitHub's read said)."""
    used: Dict[str, Set[int]] = {kind: set() for kind in KINDS}
    how: Dict[str, Dict[str, Any]] = {kind: {} for kind in KINDS}
    hand = studio.handoff()
    numbers = hand.refresh_numbers()
    github = bool(numbers.get("checked"))

    # SLICE: the shared allocator (main checkout, open cells, the draft, work orders, reserved pointers), GitHub's slice
    # issues read now, and the specs on origin/<main> as last fetched with every slice issue's ID through the ticket station.
    in_use, pointers = studio.cell.slice_ids(studio.project)
    used["SLICE"] |= set(in_use) | set(pointers)
    used["SLICE"] |= set(hand.taken_ids())
    shared, shared_notes = studio.cell.shared_slice_ids(studio.project)
    used["SLICE"] |= set(shared)
    how["SLICE"] = {"github_read": github, "origin_main_read": studio.cell.shared_main_ref(studio.project) is not None,
                    "notes": list(shared_notes)}

    # EPIC: as Studio.next_id("epic"): the epic IDs GitHub's epic issues hold (fresh after refresh_numbers), the main checkout's
    # product/epics and the draft's.
    used["EPIC"] |= set(hand.epic_numbers())
    for root in (studio.project, studio.draft):
        for path in (root / "product" / "epics").glob("EPIC-*.json"):
            if product.EPIC_RE.fullmatch(path.stem):
                used["EPIC"].add(number(path.stem))
    how["EPIC"] = {"github_read": github}

    # PP and TN: as next_principle_id and needs.next_id (the draft, what was published, what GitHub held at the last
    # refresh), and the project issue's sections read now, kept in memory only.
    ledger = hand.load()
    sections = read_sections(hand, ledger)
    for kind, key, ledger_key in (("PP", "id", "principles"), ("TN", "need_id", "needs")):
        rel = PRINCIPLES_REL if kind == "PP" else NEEDS_REL
        items = list(_items_of(studio.draft / rel, ledger_key))
        items += list((ledger.get(ledger_key) or {}).get("published") or [])
        items += list(((ledger.get("seen") or {}).get(ledger_key) or {}).get(ledger_key) or [])
        items += list((sections.get(ledger_key) or {}).get(ledger_key) or [])
        for item in items:
            ident = item.get(key) if isinstance(item, dict) else None
            if isinstance(ident, str) and re.fullmatch(rf"{kind}-[0-9]+", ident):
                used[kind].add(number(ident))
        how[kind] = {"github_read": sections.get("read", False)}

    # IDEA: as Ideas.next_id (the drafts, the idea issues at the last read), and the idea issues listed now.
    ideas = shape.Ideas(host, studio)
    used["IDEA"] |= {number(i) for i in ideas.ids()}
    used["IDEA"] |= {number(row["idea_id"]) for row in (ideas.load_ledger()["seen"].get("issues") or {}).values()
                     if isinstance(row, dict) and shape.IDEA_RE.fullmatch(str(row.get("idea_id") or ""))}
    listed_ok = False
    repository, _ = hand.reachable()
    if repository:
        listed, failure = issues.list_issues(studio.project, repository, host.ticket_rules().SHAPE_IDEA_LABEL)
        if failure is None and listed is not None:
            listed_ok = True
            for item in listed:
                marker = host.ticket_rules().parse_shape_body(item.get("body"))
                if marker and shape.IDEA_RE.fullmatch(str(marker.get("idea_id") or "")):
                    used["IDEA"].add(number(marker["idea_id"]))
    how["IDEA"] = {"github_read": listed_ok}

    # PRD and DES: every folder under product/prds and product/designs whose name is an ID (prd.Imported numbers from these).
    for kind, folder, rule in (("PRD", "prds", prd.PRD_RE), ("DES", "designs", design.DES_RE)):
        root = studio.draft / "product" / folder
        if root.is_dir():
            used[kind] |= {number(p.name) for p in root.iterdir() if rule.fullmatch(p.name)}
        how[kind] = {"github_read": None}

    for kind in KINDS:
        reserved = reserved_numbers(studio, kind)
        used[kind] |= set(reserved)
        how[kind]["reserved_by_unfinished_import"] = reserved
        how[kind]["highest_used"] = max(used[kind] or {0})
    return used, how, numbers


def _items_of(path: Path, key: str) -> List[Dict[str, Any]]:
    if path.is_symlink() or not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):
        return []
    items = data.get(key) if isinstance(data, dict) else None
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def read_sections(hand: Any, ledger: Dict[str, Any]) -> Dict[str, Any]:
    """The principles and needs sections of the project issue, read now with the reader refresh uses (Handoff.read_set), on a
    copy of the ledger that is never saved. {"read": False} when GitHub cannot be read."""
    repository, _ = hand.reachable()
    if not repository:
        return {"read": False}
    snapshot, failure = hand.read(repository)
    if failure or snapshot is None:
        return {"read": False}
    data = hand.for_repository(copy.deepcopy(ledger), repository)
    data.setdefault("seen", {})
    out: Dict[str, Any] = {"read": True}
    for kind in handoff.SETS:
        data["seen"].pop(kind.name, None)
        try:
            hand.read_set(kind, data, repository, snapshot)
        except Exception:  # noqa: BLE001  a section that cannot be read counts nothing, and says GitHub was not read
            out["read"] = False
            continue
        out[kind.name] = data["seen"].get(kind.name) or {}
    return out


def numbering(mode: str, incoming: Dict[str, List[str]], used: Dict[str, Set[int]],
              fixed: Optional[Dict[str, str]] = None) -> Tuple[Dict[str, str], List[str]]:
    """The map (4.3) and, for a new project, why a kind was numbered after all (open point 5). `fixed`: incoming IDs that
    take an ID already here (a principle that says the same as one of this project's), given no number of their own."""
    fixed = dict(fixed or {})
    incoming = {kind: [i for i in idents if i not in fixed] for kind, idents in incoming.items()}
    first: Dict[str, Optional[int]] = {}
    why: List[str] = []
    for kind in KINDS:
        if not incoming[kind]:
            continue
        free = max(used[kind] or {0}) + 1
        if mode == "join":
            first[kind] = free
            continue
        clash = sorted(i for i in incoming[kind] if number(i) in used[kind])
        if clash:
            first[kind] = free
            why.append(f"{listing(clash[:5])}{' and others' if len(clash) > 5 else ''} {'is' if len(clash) == 1 else 'are'} already used in this "
                       f"repository, so every {NOUNS[kind]} that comes in takes the next free number, from {project_ids._format(kind, free)}.")  # noqa: SLF001
        else:
            first[kind] = None
    mapping = project_ids.numbering(incoming, first)
    mapping.update(fixed)
    return mapping, why


def by_kind(mapping: Dict[str, str]) -> Dict[str, List[List[str]]]:
    out: Dict[str, List[List[str]]] = {kind: [] for kind in KIND_ORDER}
    for old, new in sorted(mapping.items(), key=lambda pair: (prefix(pair[0]), number(pair[0]), pair[0])):
        out[prefix(old)].append([old, new])
    return out


# ---- the rewrite (section 5) ----


class Built:
    """Everything the import writes, rewritten, with the notes for a person, all in memory."""

    def __init__(self) -> None:
        self.steps: List[Tuple[str, List[str]]] = []       # (step, [draft-relative path]) in placing order
        self.files: Dict[str, bytes] = {}
        self.owners: Dict[str, str] = {}                     # draft-relative path -> the new ID it belongs to
        self.principles: List[Dict[str, Any]] = []
        self.needs: List[Dict[str, Any]] = []
        self.needs_none: Optional[List[str]] = None
        self.order: Dict[str, List[str]] = {}
        self.notes: Dict[str, str] = {}
        self.check_by_hand: List[Dict[str, Any]] = []
        self.not_in_archive: List[Dict[str, Any]] = []
        self.shipped_rules: List[Dict[str, Any]] = []
        self.accepted_concerns: List[Dict[str, Any]] = []
        self.policy_rows: List[str] = []
        self.verdicts_stale: List[str] = []
        self.slice_order: List[str] = []
        self.links_dropped: List[Dict[str, Any]] = []        # links to things not in the archive, taken out (section 5, as built)
        self.none_left_behind: List[str] = []                # the archive's "nothing to say" answers on needs, not merged when joining
        self.not_assessed: List[Dict[str, Any]] = []         # Not assessed rows written into the specs that came (a principle here they predate)
        self.aligned: List[Dict[str, Any]] = []              # rows of a principle that says the same as one here, now naming it as it is here
        self.dependencies_added: List[Dict[str, Any]] = []   # a slice that names a rule of one that came with it now depends on that one


class Links:
    """Links to IDs the archive does not hold. When numbers are given out again (joining, or a kind numbered on in a new
    project), such an ID names another item here, or will, so a link that records what was made (made.*, applied.*, a map
    slice's dependencies, lookups' entries) loses the entry, a single link field (serves, a slice's PRD source, a lookup's
    epic) is cleared where the record's shape allows it, and a link the shape cannot do without refuses the import before
    anything is placed. Each is listed. When IDs are kept, nothing here has those numbers: they stay, and the rewriter
    lists them under not_in_archive."""

    def __init__(self, host: Any, found: Incoming, mapping: Dict[str, str], mode: str, out: Built):
        self.host, self.found, self.out = host, found, out
        self.known = set(mapping)
        self.renumbered = set(KINDS) if mode == "join" else {prefix(old) for old, new in mapping.items() if old != new}

    def gone(self, ident: Any) -> bool:
        parts = project_ids._split(ident)  # noqa: SLF001
        return parts is not None and ident not in self.known and parts[0] in self.renumbered

    def rule_gone(self, rule: Any) -> bool:
        return isinstance(rule, str) and "/" in rule and self.gone(rule.split("/", 1)[0])

    def note(self, file: str, field: str, ident: str, how: str) -> None:
        words = {"dropped": f"{ident} did not come with the project; here that number is, or will be, another item, so it was taken out of {field}.",
                 "cleared": f"{ident} did not come with the project; here that number is, or will be, another item, so {field} was cleared."}[how]
        self.out.links_dropped.append({"file": file, "field": field, "id": ident, "how": how, "words": words})

    def cut(self, kind: str, owner: str, record: Dict[str, Any], file: str) -> Optional[Dict[str, Any]]:
        """The record with links to IDs not in the archive taken out; None when the whole record goes (drafted answers for a
        slice that did not come)."""
        if not self.renumbered:
            return record
        data = copy.deepcopy(record)
        if kind in ("epic", "slice"):
            serves = data.get("serves")
            if isinstance(serves, dict) and self.gone(serves.get("idea")):
                del data["serves"]
                self.note(file, "serves", serves["idea"], "cleared")
        if kind == "slice":
            source = data.get("source")
            if isinstance(source, dict) and self.gone(source.get("prd_id")):
                del data["source"]
                self.note(file, "source", source["prd_id"], "cleared")
        if kind == "idea":
            made = data.get("made")
            for group in ("epics", "slices"):
                if isinstance(made, dict) and isinstance(made.get(group), list):
                    kept = [i for i in made[group] if not self.gone(i)]
                    for ident in made[group]:
                        if ident not in kept:
                            self.note(file, f"made.{group}", ident, "dropped")
                    made[group] = kept
            source = data.get("source")
            if isinstance(source, dict) and source.get("kind") == "change" and self.rule_gone(source.get("rule")):
                self.found.idea_sources[owner] = {"kind": "change", "rule": source["rule"]}
                data["source"] = {"kind": "moved"}
                self.note(file, "source", source["rule"].split("/", 1)[0], "cleared")
        if kind == "lookups":
            for group, field in (("shipped_rules", "rule"), ("similar", "idea"), ("principles", "id")):
                items = data.get(group)
                if not isinstance(items, list):
                    continue
                kept = []
                for item in items:
                    value = item.get(field) if isinstance(item, dict) else None
                    if (field == "rule" and self.rule_gone(value)) or (field != "rule" and self.gone(value)):
                        self.note(file, group, value.split("/", 1)[0], "dropped")
                        continue
                    if group == "shipped_rules" and self.gone(item.get("epic_id")):
                        self.note(file, "shipped_rules epic_id", item["epic_id"], "cleared")
                        item = {**item, "epic_id": None}
                    kept.append(item)
                data[group] = kept
        if kind in ("idea_map", "prd_map"):
            applied = data.get("applied")
            for group in ("epics", "slices"):
                made = applied.get(group) if isinstance(applied, dict) else None
                if isinstance(made, dict):
                    for key in sorted(made):
                        if self.gone(made[key]):
                            self.note(file, f"applied.{group}", made[key], "dropped")
                            del made[key]
            for item in data.get("slices") or []:
                depends = item.get("depends_on")
                if isinstance(depends, list):
                    for ident in [d for d in depends if self.gone(d)]:
                        self.note(file, f"slice {item.get('key')}'s depends_on", ident, "dropped")
                    item["depends_on"] = [d for d in depends if not self.gone(d)]
        if kind == "prd_answers" and self.gone(data.get("slice_id")):
            self.note(file, "the drafted answers", data["slice_id"], "dropped")
            return None
        return data


def links_that_cannot_go(host: Any, found: Incoming, incoming: Dict[str, List[str]]) -> None:
    """A link to an ID the archive does not hold, in a field the record cannot do without, refuses the import, in either mode and
    before GitHub is read: joining, the number is another item here; in a new project, Studio would give that number to the next
    item made here. A small change's shipped rule, a map slice's epic and a design conflict's principle or need."""
    known = {ident for idents in incoming.values() for ident in idents}

    def stop(what: str) -> Exception:
        return refusal(host, f"{found.label} cannot be brought in as it is: {what} Export it again from the old repository with that item "
                             "in the project.")

    for ident, work in sorted(found.slices.items()):
        small = work.get("small")
        rule = small.get("shipped_rule") if isinstance(small, dict) else None
        if isinstance(rule, str) and rule.split("/", 1)[0] not in known:
            raise stop(f"{ident} is a small change to {rule}, and {rule.split('/', 1)[0]} did not come with the project, so that rule "
                       "would be another slice's here.")
    for ident, record in sorted([*found.idea_maps.items(), *((i, e["map"]) for i, e in found.documents.items() if prefix(i) == "PRD" and e["map"])]):
        for item in record.get("slices") or []:
            epic = item.get("epic")
            if isinstance(epic, str) and prd.EPIC_ID_RE.fullmatch(epic) and epic not in known:
                raise stop(f"the map of {ident} puts its slice {item.get('key')} under {epic}, which did not come with the project.")
    for ident, entry in sorted(found.documents.items()):
        for item in ((entry["map"] or {}).get("conflicts") or []) if prefix(ident) == "DES" else []:
            against = item.get("against")
            if isinstance(against, str) and prefix(against) in ("PP", "TN") and against not in known:
                raise stop(f"conflict {item.get('n')} of {ident} is against {against}, which did not come with the project.")


def build(host: Any, studio: Any, found: Incoming, mapping: Dict[str, str], mode: str, into: str,
          joined: Optional[Dict[str, Any]] = None) -> Built:
    """Every file the import writes, rewritten in memory. `joined` (joining only): {"matched": incoming principle ID -> the ID
    here that says the same, "here": this project's principles as they stood when the import started, "day": that day}; from
    the record when resuming, so the same import always writes the same bytes."""
    out = Built()
    pid = into if mode == "join" else None
    joined = joined or {"matched": {}, "here": [], "day": None}
    rules = host.ticket_rules()
    links = Links(host, found, mapping, mode, out)

    def noted(file: str, notes: Iterable[Dict[str, Any]]) -> None:
        for note in notes:
            row = {"file": file, "line": note.get("line"), "id": note["id"]}
            if note.get("field"):
                row["field"] = note["field"]
            if note["why"] == "in_code":
                out.check_by_hand.append({**row, "why": "inside code in the text; left as written"})
            elif note["why"] == "near_miss":
                out.check_by_hand.append({**row, "why": f"{note['id']} with more letters or digits after it; left as written, though "
                                                        f"{note['id']} is now {mapping[note['id']]}"})
            else:
                out.not_in_archive.append({**row, "why": "not in the archive; left as written"})

    def record(kind: str, data: Dict[str, Any], file: str, owner: Optional[str] = None) -> Any:
        """The record with links to what did not come taken out (Links), then its IDs and text rewritten; None when it goes."""
        data = links.cut(kind, owner or "", data, file)
        if data is None:
            return None
        new, notes = project_ids.rewrite_record_noted(kind, data, mapping, pid)
        noted(file, notes)
        return new

    def text(value: str, file: str) -> str:
        new, notes = project_ids.rewrite_text(value, mapping)
        noted(file, notes)
        return new

    def add(step: str, rel: str, data: bytes, owner: str) -> None:
        if rel in out.files:
            raise AssertionError(f"{rel} would be written twice")
        out.files[rel] = data
        out.owners[rel] = owner
        for name, rels in out.steps:
            if name == step:
                rels.append(rel)
                break
        else:
            out.steps.append((step, [rel]))

    # 1. PRD and design folders: the documents byte for byte, their records with IDs rewritten.
    for ident, entry in sorted(found.documents.items(), key=lambda pair: (prefix(pair[0]), number(pair[0]))):
        kind, new = prefix(ident), mapping[ident]
        meta_kind, map_kind = ("prd_meta", "prd_map") if kind == "PRD" else ("design_meta", "design_map")
        meta_name = "prd.json" if kind == "PRD" else "import.json"
        add("documents", rel_document(kind, new, entry["name"]), entry["raw"], new)
        meta_rel = rel_document(kind, new, meta_name)
        add("documents", meta_rel, canonical_bytes(host, record(meta_kind, entry["meta"], meta_rel)), new)
        if entry["map"] is not None:
            map_rel = rel_document(kind, new, "map.json")
            add("documents", map_rel, canonical_bytes(host, record(map_kind, entry["map"], map_rel, ident)), new)
        for key, answers in sorted(entry["answers"].items()):
            answers_rel = rel_document(kind, new, f"answers/{key}.json")
            kept = record("prd_answers", answers, answers_rel, ident)
            if kept is not None:
                add("documents", answers_rel, canonical_bytes(host, kept), new)

    # 2. Design mocks, byte for byte, in the renamed slice's folder.
    for ident, pictures in sorted(found.mocks.items()):
        for digest, (ext, data) in sorted(pictures.items()):
            add("mocks", rel_mock(mapping[ident], digest, ext), data, mapping[ident])

    # 3. Ideas: records, lookups, maps, briefs and cases.
    for ident in sorted(found.ideas, key=number):
        new = mapping[ident]
        idea_rel = rel_idea(new, "idea")
        idea = record("idea", found.ideas[ident], idea_rel, ident)
        problems = shape.record_problems(idea, rules)
        if problems:
            raise AssertionError(f"{ident}: {problems[0]}")
        add("ideas", idea_rel, canonical_bytes(host, idea), new)
        lookups: Dict[str, Any] = {}
        if ident in found.lookups:
            rel = rel_idea(new, "lookups")
            lookups = record("lookups", found.lookups[ident], rel, ident)
            add("ideas", rel, canonical_bytes(host, lookups), new)
        if ident in found.idea_maps:
            rel = rel_idea(new, "idea_map")
            add("ideas", rel, canonical_bytes(host, record("idea_map", found.idea_maps[ident], rel, ident)), new)
        if ident in found.briefs:
            rel = rel_idea(new, "brief")
            brief = text(found.briefs[ident], rel)
            add("ideas", rel, brief.encode("utf-8"), new)
            if brief != found.briefs[ident] and isinstance(idea.get("verdict"), dict) and idea["verdict"].get("brief_sha256") == shape.sha(found.briefs[ident]):
                out.verdicts_stale.append(new)
            for line_number, line in enumerate(brief.splitlines(), start=1):
                if re.match(r"^\s*[-*+]\s+Shipped rules:", line):
                    for rule in re.findall(r"SLICE-[0-9]{3,}/(?:INV-[0-9]{2,}|FR-[0-9]{2,}|R[0-9]+)", line):
                        out.shipped_rules.append({"file": rel, "line": line_number, "of": new, "rule": rule, "where": "brief"})
        if ident in found.cases:
            rel = rel_idea(new, "case")
            add("ideas", rel, text(found.cases[ident], rel).encode("utf-8"), new)
        source = idea.get("source") or {}
        if source.get("kind") == "change":
            out.shipped_rules.append({"file": idea_rel, "line": None, "of": new, "rule": source["rule"], "where": "idea_source"})
        for item in lookups.get("shipped_rules", []):
            if isinstance(item.get("rule"), str):
                out.shipped_rules.append({"file": rel_idea(new, "lookups"), "line": None, "of": new, "rule": item["rule"], "where": "lookups"})

    # 4. The project, for a new project only (placed before the principles and needs, which name it).
    if mode == "new":
        add("project", PROJECT_REL, canonical_bytes(host, record("project", found.project, PROJECT_REL)), found.project_id)

    # 5. Principles and needs, merged by ID when placed.
    if found.principles is not None:
        # A principle that says the same as one here is that one: it is not added, and its slices' rows name the one here.
        matched_here = {mapping[old] for old in joined["matched"]}
        out.principles = [item for item in record("principles", found.principles, PRINCIPLES_REL)["principles"] if item["id"] not in matched_here]
    if found.needs is not None:
        rewritten = record("needs", found.needs, NEEDS_REL)
        out.needs = rewritten["needs"]
        # A new project keeps its "nothing to say" answers; when joining, this project's own answers stand (said in the result).
        out.needs_none = list(rewritten.get("none") or []) if mode == "new" else None
        out.none_left_behind = list(rewritten.get("none") or []) if mode == "join" else []

    # 6. Epics.
    for ident in sorted(found.epics, key=number):
        new = mapping[ident]
        rel = rel_epic(new)
        epic = record("epic", found.epics[ident], rel, ident)
        epic.pop("tracking", None)
        add("epics", rel, canonical_bytes(host, epic), new)

    # 7. Specs and whys.
    for ident in sorted(found.slices, key=number):
        new = mapping[ident]
        if ident in found.specs:
            kebab, spec = found.specs[ident]
            rel = rel_spec(new, kebab)
            rewritten = text(spec, rel)
            if spec_heading(rewritten) != new:
                raise AssertionError(f"{rel}: its title no longer names {new}")
            if mode == "join" and found.slices[ident]["status"] != "superseded":
                rewritten = principle_rows_brought_in(studio, out, rel, new, rewritten, mapping, joined, found.name)
            add("specs", rel, rewritten.encode("utf-8"), new)
            spec_notes(studio, out, rel, new, rewritten)
        if ident in found.intents:
            rel = rel_intent(new)
            add("specs", rel, text(found.intents[ident], rel).encode("utf-8"), new)

    # 8. Work orders: every one a draft (a superseded one stays superseded), no approval's hash, nothing naming a repository
    # or a Jira issue; dependencies first, ties by new ID, so the workspace is consistent after each.
    works: Dict[str, Dict[str, Any]] = {}
    for ident in sorted(found.slices, key=number):
        new = mapping[ident]
        work = record("slice", found.slices[ident], rel_slice(new), ident)
        work["status"] = "superseded" if work["status"] == "superseded" else "draft"
        work["spec_sha256"] = None
        for key in ("origin", "tracking"):
            work.pop(key, None)
        works[new] = work
        small = work.get("small")
        if isinstance(small, dict) and isinstance(small.get("shipped_rule"), str):
            out.shipped_rules.append({"file": rel_slice(new), "line": None, "of": new, "rule": small["shipped_rule"], "where": "small"})
    ships_first(studio, out, found, mapping, works)
    for new in topological(works):
        add("slices", rel_slice(new), canonical_bytes(host, works[new]), new)
        out.slice_order.append(new)

    # 9 and 10: the order within each epic and the resume notes.
    for epic_id, slices in sorted(found.facts["order"].items()):
        out.order[mapping[epic_id]] = [mapping[s] for s in slices]
    for slice_id, entry in sorted(found.facts["slices"].items()):
        if entry.get("note"):
            out.notes[mapping[slice_id]] = text(entry["note"], f"the resume note of {mapping[slice_id]}")
    return out


def spec_notes(studio: Any, out: Built, rel: str, new: str, spec: str) -> None:
    """What rewriting cannot fix in one spec (5.4): rows naming shipped rules, policy rows and accepted concerns."""
    try:
        parsed = studio_effects(studio).parse(spec)
        for row in parsed["rows"]:
            out.shipped_rules.append({"file": rel, "line": row.get("line"), "of": new, "rule": row.get("shipped_rule"), "where": "effects"})
    except Exception:  # noqa: BLE001  an effects section that cannot be read is the spec check's to report
        pass
    try:
        policies = studio_policies(studio)
    except Exception:  # noqa: BLE001
        policies = None
    for line_number, line in enumerate(spec.splitlines(), start=1):
        if policies is not None and policies.PACK_ROW_RE.match(line.strip()):
            if new not in out.policy_rows:
                out.policy_rows.append(new)
        concern = policies.CONCERN_RE.match(line.strip()) if policies is not None else None
        if concern and concern.group(5).startswith("accepted by"):
            out.accepted_concerns.append({"slice": new, "file": rel, "line": line_number, "policy": concern.group(1),
                                          "resolution": concern.group(5)[:300],
                                          "words": "accepted in the old repository under its policy packs; check it against this organisation's"})


def studio_effects(studio: Any) -> Any:
    import sys
    module = sys.modules.get(type(studio).__module__)
    return module.shipped_helper().current_module().effects_module()


def studio_policies(studio: Any) -> Any:
    import sys
    return sys.modules.get(type(studio).__module__).policies_helper()


def topological(works: Dict[str, Dict[str, Any]]) -> List[str]:
    done: List[str] = []
    placed: Set[str] = set()
    waiting = sorted(works, key=number)
    while waiting:
        ready = [s for s in waiting if all(d in placed or d not in works for d in works[s].get("dependencies") or [])]
        if not ready:  # a cycle, which the content check refused already
            raise AssertionError("the slices' dependencies go round in a circle")
        first = ready[0]
        done.append(first)
        placed.add(first)
        waiting.remove(first)
    return done


# ---- principles when joining: the same principle is one principle; one a slice predates is "Not assessed" (M21) ----


def plain(value: Any) -> str:
    """A statement compared as a person reads it: spacing and capitals do not count."""
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def active_here(studio: Any) -> List[Dict[str, Any]]:
    """This project's active principles as they stand: {id, revision, statement}."""
    return [{"id": item["id"], "revision": item.get("revision"), "statement": item.get("statement")}
            for item in _items_of(studio.draft / PRINCIPLES_REL, "principles")
            if item.get("status") == "active" and isinstance(item.get("id"), str) and isinstance(item.get("statement"), str)]


def matched_principles(found: Incoming, here: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Joining: each incoming active principle whose statement is the statement of one of this project's active principles,
    word for word or but for spacing and capitals: incoming ID -> {here, how}. Each one here is matched once, in ID order."""
    out: Dict[str, Dict[str, Any]] = {}
    taken: Set[str] = set()
    incoming = [item for item in (found.principles or {}).get("principles") or [] if item.get("status") == "active"]
    for item in sorted(incoming, key=lambda i: number(i["id"])):
        for other in sorted(here, key=lambda i: number(i["id"])):
            if other["id"] in taken:
                continue
            if item["statement"] == other["statement"]:
                how = "word for word"
            elif plain(item["statement"]) and plain(item["statement"]) == plain(other["statement"]):
                how = "but for spacing and capitals"
            else:
                continue
            out[item["id"]] = {"here": other["id"], "how": how}
            taken.add(other["id"])
            break
    return out


def principle_section(lines: List[str]) -> Tuple[Optional[int], int, List[Tuple[int, int, str]]]:
    """(the index of the '## Principles' heading or None, the index where its section ends, every heading outside code as
    (index, level, title in lower case))."""
    heads: List[Tuple[int, int, str]] = []
    fence = False
    for index, line in enumerate(lines):
        if project_ids.FENCE_RE.match(line):
            fence = not fence
            continue
        if fence:
            continue
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if match:
            heads.append((index, len(match.group(1)), match.group(2).strip().lower()))
    start = next((i for i, level, title in heads if level == 2 and title == "principles"), None)
    end = next((i for i, level, _ in heads if start is not None and i > start and level <= 2), len(lines))
    return start, end, heads


def principle_rows(studio: Any, text: str) -> Dict[str, Dict[str, Any]]:
    """The rows of '## Principles' by principle, both forms of row: ID -> {index (of the line), revision, statement, answer
    (the answer's word, or "Not assessed"), reason (a Not assessed row's)}."""
    lines = text.splitlines()
    start, end, _ = principle_section(lines)
    found: Dict[str, Dict[str, Any]] = {}
    if start is None:
        return found
    vs = studio.validate_slice
    for index in range(start + 1, end):
        line = lines[index].strip()
        match = vs.PRINCIPLE_ROW_RE.match(line)
        if match:
            found.setdefault(match.group(1), {"index": index, "revision": match.group(2), "statement": match.group(3), "answer": match.group(4),
                                              "reason": None})
            continue
        match = vs.NOT_ASSESSED_ROW_RE.match(line)
        if match:
            found.setdefault(match.group(1), {"index": index, "revision": match.group(2), "statement": match.group(3), "answer": "Not assessed",
                                              "reason": match.group(4).strip()})
    return found


AFTER_PRINCIPLES = ("policies", "dependencies and permissions", "assumptions", "accepted defaults", "open questions")


def with_rows(studio: Any, text: str, rows: List[str]) -> str:
    """The spec with these rows added to '## Principles': in place of its '- None.', after its last line, or in a new section
    where the template puts it (before '## Policies', else before '## Dependencies and permissions' and what follows)."""
    if not rows:
        return text
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.split(newline)
    start, end, heads = principle_section(lines)
    vs = studio.validate_slice
    if start is not None:
        body = list(range(start + 1, end))
        nothing = [i for i in body if vs.BULLET_RE.match(lines[i].strip()) and vs.is_none(vs.BULLET_RE.match(lines[i].strip()).group(1))]
        if nothing:
            lines[nothing[0]:nothing[0] + 1] = rows
        else:
            last = max((i for i in body if lines[i].strip()), default=start)
            lines[last + 1:last + 1] = ([""] if last == start else []) + rows
        return newline.join(lines)
    before = next((i for i, level, title in heads if level == 2 and title in AFTER_PRINCIPLES), None)
    block = ["## Principles", "", *rows, ""]
    if before is None:
        return text.rstrip("\r\n") + newline + newline + newline.join(block)
    lines[before:before] = block
    return newline.join(lines)


def not_assessed_row(item: Dict[str, Any], reason: str) -> str:
    return f'- **{item["id"]}** (revision {item["revision"]}): "{item["statement"]}" **Not assessed:** {reason}'


def slice_came_reason(project: str, day: str, ident: str) -> str:
    return f"This slice came with the project {project}, brought in here on {day}, which did not have {ident}."


def principle_came_reason(ident: str, project: str, day: str) -> str:
    return f"{ident} came with the project {project}, brought in here on {day}, after this slice was written."


def principle_rows_brought_in(studio: Any, out: Built, rel: str, new: str, spec: str, mapping: Dict[str, str], joined: Dict[str, Any],
                              project: str) -> str:
    """One spec that came, joining: a row of a principle that says the same as one here names it as it is here (its revision
    and exact statement), when the row quoted that same statement; and each active principle here the spec does not answer gets
    a Not assessed row, saying the slice came from a project that did not have it. Nothing is answered for the PM."""
    here = {item["id"]: item for item in joined["here"]}
    same = {mapping[old] for old in joined["matched"] if old in mapping}
    newline = "\r\n" if "\r\n" in spec else "\n"
    lines = spec.split(newline)
    rows = principle_rows(studio, newline.join(lines))
    for ident, row in sorted(rows.items()):
        index, revision, statement, answer = row["index"], row["revision"], row["statement"], row["answer"]
        mine = here.get(ident)
        if ident not in same or mine is None or answer == "Not assessed":
            continue
        if plain(statement) != plain(mine["statement"]) or (revision == str(mine["revision"]) and statement == mine["statement"]):
            continue
        match = studio.validate_slice.PRINCIPLE_ROW_RE.match(lines[index].strip())
        indent = lines[index][:len(lines[index]) - len(lines[index].lstrip())]
        lines[index] = (f'{indent}- **{ident}** (revision {mine["revision"]}): "{mine["statement"]}" **{match.group(4)}:**'
                        + (f" {match.group(5).strip()}" if match.group(5).strip() else ""))
        out.aligned.append({"slice": new, "file": rel, "principle": ident, "line": index + 1,
                            "words": f"{new}'s row for {ident} now quotes {ident} as it is here (revision {mine['revision']}); the statement is the same."})
    spec = newline.join(lines)
    # A principle here that one of the project's own says the same as was the project's too: a row it lacks is the draft's own
    # gap, not something the slice predates, so it is left for the interview as it was.
    missing = [item for item in sorted(joined["here"], key=lambda i: number(i["id"])) if item["id"] not in rows and item["id"] not in same]
    added = []
    for item in missing:
        reason = slice_came_reason(project, joined["day"], item["id"])
        added.append(not_assessed_row(item, reason))
        out.not_assessed.append({"slice": new, "principle": item["id"], "file": rel, "how": "slice_came",
                                 "words": f"{new}: {item['id']} is not assessed. {reason}"})
    return with_rows(studio, spec, added)


def rows_for_slices_here(host: Any, studio: Any, incoming: List[Dict[str, Any]], brought: Set[str], project: str, day: str,
                         write: bool, only: Optional[Sequence[str]] = None, editable: bool = True) -> List[Dict[str, Any]]:
    """The other way: each principle that came with the project and is active, against this project's own slices still being
    written (draft, being defined, ready for approval) that do not answer it: a Not assessed row saying the principle came
    after the slice was written. `write` False only says which; True adds them (each spec once; a row already there, of
    either form, is never added again). `only`: these slices; `editable` False: whatever their status (a slice reopened)."""
    if not incoming:
        return []
    editable_states = getattr(host, "EDITABLE_SLICE", ("draft", "interviewing", "ready_for_approval"))
    found: List[Dict[str, Any]] = []
    for slice_id, data in sorted(studio.all("slice").items()):
        if slice_id in brought or (only is not None and slice_id not in only):
            continue
        if editable and data.get("status") not in editable_states:
            continue
        spec = studio.spec_of(slice_id)
        if spec is None or spec.is_symlink():
            continue
        try:
            text = spec.read_bytes().decode("utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        answered = principle_rows(studio, text)
        rows, words = [], []
        for item in sorted(incoming, key=lambda i: number(i["id"])):
            reason = principle_came_reason(item["id"], project, day)
            if item["id"] in answered and answered[item["id"]]["reason"] != reason:
                continue
            if item["id"] not in answered:  # a row this import wrote on an earlier run is listed, never written twice
                rows.append(not_assessed_row(item, reason))
            words.append({"slice": slice_id, "principle": item["id"], "file": studio.relative(spec), "how": "principle_came",
                          "words": f"{slice_id}: {item['id']} is not assessed. {reason}"})
        if rows and write:
            host.write(spec, with_rows(studio, text, rows))
        found += words
    return found


# ---- effects on shipped behaviour that name a rule of a slice that came with the project (M21) ----


def ships_first(studio: Any, out: Built, found: Incoming, mapping: Dict[str, str], works: Dict[str, Dict[str, Any]]) -> None:
    """A slice whose effects, or whose small change, name a rule of a slice that came with it named a rule that had shipped in
    the old repository; here that slice ships first. When the work order does not already reach it through its dependencies,
    the dependency is added (unless that would go round in a circle), so marking ready and the Factory take them in order."""
    came = {mapping[i] for i, w in found.slices.items() if w["status"] != "superseded"}
    effects = studio_effects(studio)
    back = {new: old for old, new in mapping.items()}
    for new in sorted(works, key=number):
        if works[new].get("status") == "superseded":
            continue
        named: List[Tuple[str, str]] = []
        old = back.get(new)
        if old in found.specs:
            spec = project_ids.rewrite_text(found.specs[old][1], mapping)[0]
            named += [(row["slice_id"], row["shipped_rule"]) for row in effects.parse(spec)["rows"]]
        small = works[new].get("small")
        if isinstance(small, dict) and isinstance(small.get("shipped_rule"), str) and "/" in small["shipped_rule"]:
            named.append((small["shipped_rule"].split("/", 1)[0], small["shipped_rule"]))
        for target, rule in named:
            if target == new or target not in came or target not in works:
                continue
            if target in reach(works, new):
                continue
            if new in reach(works, target):
                out.dependencies_added.append({"slice": new, "on": target, "rule": rule, "added": False,
                                               "words": f"{new} names {rule}, but {target} depends on {new}, so {new} cannot wait for it; "
                                                        "answer that row again here."})
                continue
            works[new]["dependencies"] = list(works[new].get("dependencies") or []) + [target]
            out.dependencies_added.append({"slice": new, "on": target, "rule": rule, "added": True,
                                           "words": f"{new} now depends on {target}: it names {rule}, which shipped in the old repository "
                                                    f"(as {back.get(target, target)}{'/' + rule.split('/', 1)[1]}) and ships here first."})


def reach(works: Dict[str, Dict[str, Any]], start: str) -> Set[str]:
    """Every slice `start` depends on, directly or through others."""
    seen: Set[str] = set()
    stack = list(works.get(start, {}).get("dependencies") or [])
    while stack:
        item = stack.pop()
        if item in seen:
            continue
        seen.add(item)
        stack.extend((works.get(item) or {}).get("dependencies") or [])
    return seen


# ---- what the person reads (4.4, 4.7) ----


def here_words(host: Any, studio: Any, ident: str, renumbered: bool = False) -> str:
    """What an ID names in the destination, in a person's words. When numbers are given out again here (`renumbered`), an ID
    the archive did not hold names, or will name, a different item from the one the text meant, and the words say so."""
    found = _here_words(host, studio, ident)
    if not renumbered:
        return found
    if found.endswith("is not used in this repository"):
        return f"{ident} is not used in this repository yet; whatever is given that number here will be a different item from the one the text meant"
    return f"{found}, a different item from the one the text meant"


def _here_words(host: Any, studio: Any, ident: str) -> str:
    try:
        kind = prefix(ident)
        title = None
        if kind in ("SLICE", "EPIC"):
            path = studio.path(kind.lower(), ident)
            if path.is_file():
                title = studio.load(kind.lower(), ident).get("title")
        elif kind == "IDEA":
            ideas = shape.Ideas(host, studio)
            if ideas.exists(ident):
                title = ideas.load(ident).get("title")
        elif kind in ("PP", "TN"):
            key = "id" if kind == "PP" else "need_id"
            items = _items_of(studio.draft / (PRINCIPLES_REL if kind == "PP" else NEEDS_REL), "principles" if kind == "PP" else "needs")
            item = next((i for i in items if i.get(key) == ident), None)
            title = item and (item.get("title") or item.get("statement"))
        else:
            meta = studio.draft / "product" / ("prds" if kind == "PRD" else "designs") / ident / ("prd.json" if kind == "PRD" else "import.json")
            if meta.is_file() and not meta.is_symlink():
                title = (json.loads(meta.read_text(encoding="utf-8")) or {}).get("name")
        if title:
            return f"{ident} in this repository is \"{str(title)[:120]}\""
    except Exception:  # noqa: BLE001  words only
        pass
    return f"{ident} is not used in this repository"


def summary(host: Any, studio: Any, found: Incoming, mapping: Dict[str, str], mode: str, into: str, built: Built,
            how: Optional[Dict[str, Dict[str, Any]]], why: List[str], notes: List[str], numbers: Optional[Dict[str, Any]],
            joined: Optional[Dict[str, Any]] = None, rows_here: Optional[List[Dict[str, Any]]] = None,
            renumbered_now: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """The fields the plan and the result share (4.4). Every sentence that names something by its new number here and says what it
    was in the old repository names both: "SLICE-013 (was SLICE-001)"."""
    facts = found.facts
    joined = joined or {"matched": {}, "here": [], "day": None}
    rows_here = rows_here or []
    back = {new: old for old, new in mapping.items()}

    def both(new: str) -> str:
        """A new ID with what it was in the old repository, when that differs."""
        old = back.get(new, new)
        return new if old == new else f"{new} (was {old})"

    def rule_both(rule: str) -> str:
        head, _, tail = rule.partition("/")
        old = back.get(head, head)
        return rule if old == head else f"{rule} (was {old}/{tail})"

    slices = []
    for ident in sorted(found.slices, key=number):
        was = facts["slices"].get(ident, {}).get("was")
        status = "superseded" if found.slices[ident]["status"] == "superseded" else "draft"
        slices.append({"from": ident, "to": mapping[ident], "title": found.slices[ident]["title"], "epic": mapping[found.slices[ident]["epic_id"]],
                       "was": was, "was_words": (f"{WAS_WORDS[was]} in the old repository" if was else "not recorded in the archive"),
                       "status_here": status, "revision_there": facts["slices"].get(ident, {}).get("revision")})
    renumbered = set(KINDS) if mode == "join" else {prefix(old) for old, new in mapping.items() if old != new}
    for row in built.not_in_archive:
        row["here"] = here_words(host, studio, row["id"], prefix(row["id"]) in renumbered)
    jira = {mapping[i]: key for i, key in found.stripped_jira.items() if prefix(i) == "SLICE"}
    jira.update({mapping[i]: entry["jira"] for i, entry in facts["slices"].items() if entry.get("jira")})
    epic_jira = {mapping[i]: key for i, key in found.stripped_jira.items() if prefix(i) == "EPIC"}
    epic_jira.update({mapping[i]: entry["jira"] for i, entry in facts["epics"].items()})
    requests = {mapping[i]: entry["request"] for i, entry in facts["slices"].items() if entry.get("request")}
    in_force = shipped_here(studio)
    came = {mapping[i] for i, work in found.slices.items() if work["status"] != "superseded"}
    for row in built.shipped_rules:
        row["in_force_here"] = row["rule"] in in_force if in_force is not None else None
        row["came_with_the_project"] = row["rule"].split("/", 1)[0] in came
    same = [{"incoming": old, "here": item["here"], "how": item["how"],
             "words": f"{old} of the project says the same as {item['here']} here ({item['how']}), so the two are one principle here and it "
                      "was not added again" + ("." if old == item["here"] else f": the rows that answered {old} now answer {item['here']}.")}
            for old, item in sorted(joined["matched"].items(), key=lambda pair: number(pair[0]))]
    principles_in = [item["id"] for item in built.principles]
    needs_in = [item["need_id"] for item in built.needs]
    added = {(row["slice"], row["on"]): row for row in built.dependencies_added}
    after: List[str] = []
    if principles_in:
        after.append(f"Publish the principles before any slice can be marked ready: {len(principles_in)} came with the project "
                     f"({listing([both(i) for i in principles_in])}).")
    if needs_in:
        after.append(f"Publish the technical needs: {len(needs_in)} came with the project.")
    after.extend(item["words"] for item in same)
    not_assessed = built.not_assessed + rows_here
    if not_assessed:
        came_rows = [row for row in not_assessed if row["how"] == "slice_came"]
        here_rows = [row for row in not_assessed if row["how"] == "principle_came"]
        if came_rows:
            after.append(f"{plural(len({r['slice'] for r in came_rows}), 'slice')} that came "
                         f"({listing(sorted({both(r['slice']) for r in came_rows}))}) did not answer this project's "
                         f"{listing(sorted({r['principle'] for r in came_rows}))}, which the old project did not have: each such row says "
                         "'Not assessed', which does not hold up marking ready. Answer them in the interview when you next change those slices "
                         "(listed under principles_not_assessed).")
        if here_rows:
            after.append(f"{plural(len({r['slice'] for r in here_rows}), 'slice')} of this project still being written "
                         f"({listing(sorted({r['slice'] for r in here_rows}))}) did not answer "
                         f"{listing(sorted({both(r['principle']) for r in here_rows}))}, which came with the project: each such row says "
                         "'Not assessed', which does not hold up marking ready. Answer them in the interview when you next change those slices "
                         "(listed under principles_not_assessed).")
    if built.aligned:
        after.append(f"{plural(len(built.aligned), 'row')} answering a principle that says the same as one here now quote it as it is here "
                     "(listed under principles_aligned).")
    waiting = sorted({row["of"] for row in built.shipped_rules if row["where"] == "effects" and row["came_with_the_project"]}, key=number)
    for new in waiting:
        named = sorted({row["rule"] for row in built.shipped_rules if row["of"] == new and row["where"] == "effects" and row["came_with_the_project"]})
        targets = sorted({rule.split("/", 1)[0] for rule in named}, key=number)
        stuck = [t for t in targets if (new, t) in added and not added[(new, t)]["added"]]
        ok = [t for t in targets if t not in stuck]
        if ok:
            after.append(f"{both(new)} names {listing([rule_both(r) for r in named if r.split('/', 1)[0] in ok])} under 'Effects on shipped "
                         f"behaviour'. {listing(ok)} came with the project and {'has' if len(ok) == 1 else 'have'} not shipped here, so "
                         f"{'it ships' if len(ok) == 1 else 'they ship'} first: {new} depends on {listing(ok)}, and those rows are checked "
                         f"again when {new} is built. Nothing needs answering again.")
        for target in stuck:
            after.append(added[(new, target)]["words"])
    effects_gone = sorted({row["of"] for row in built.shipped_rules if row["where"] == "effects" and not row["came_with_the_project"]}, key=number)
    if effects_gone:
        after.append(f"{plural(len(effects_gone), 'slice names', 'slices name')} rules under 'Effects on shipped behaviour' of slices that did "
                     f"not come with the project ({listing([both(i) for i in effects_gone])}); each needs those rows answered again here.")
    for row in built.shipped_rules:
        if row["where"] == "small":
            target = row["rule"].split("/", 1)[0]
            depends = " It now depends on " + target + "." if (row["of"], target) in added and added[(row["of"], target)]["added"] else ""
            after.append(f"{both(row['of'])} is a small change to {rule_both(row['rule'])}. {target} came with the project and has not shipped "
                         f"here yet, so {row['of']} stays a small change that waits for {target} to ship.{depends}")
    others = sorted({row["of"] for row in built.shipped_rules if row["where"] in ("brief", "lookups", "idea_source")}, key=number)
    if others:
        after.append(f"{listing([both(i) for i in others])} {'names' if len(others) == 1 else 'name'} rules that had shipped in the old repository; "
                     "look them up again here.")
    if built.verdicts_stale:
        after.append(f"The verdict on {listing([both(i) for i in built.verdicts_stale])} no longer holds, because renumbering changed the "
                     "brief's text. Record a verdict on the brief as it is now.")
    if built.policy_rows:
        after.append(f"{listing([both(i) for i in built.policy_rows])} answered the old organisation's policy packs; they show as answered under "
                     "other packs until answered again here.")
    if jira or epic_jira:
        named = [f"{both(k)} had {v}" for k, v in sorted({**epic_jira, **jira}.items())]
        after.append(f"Jira keys were left behind; link each again if this organisation uses the same Jira ({listing(named[:6])}"
                     f"{' and others' if len(named) > 6 else ''}).")
    if built.links_dropped:
        named = sorted({row["id"] for row in built.links_dropped}, key=lambda i: (prefix(i), number(i)))
        after.append(f"{plural(len(built.links_dropped), 'link')} to things that did not come with the project "
                     f"({listing(named[:6])}{' and others' if len(named) > 6 else ''}) {'was' if len(built.links_dropped) == 1 else 'were'} "
                     "taken out, because here those numbers are, or will be, other items (listed under links_dropped).")
    moved_text = sorted({row["id"] for row in built.not_in_archive if prefix(row["id"]) in renumbered}, key=lambda i: (prefix(i), number(i)))
    if moved_text:
        after.append(f"The text names {listing(moved_text[:6])}{' and others' if len(moved_text) > 6 else ''}, which did not come with the "
                     "project. Text cannot be changed without changing what was written, so each is left as written and now names "
                     "whatever has that number here, a different item (listed under not_in_archive).")
    if built.none_left_behind:
        after.append(f"The project's 'nothing to say' answers on technical needs ({listing(built.none_left_behind)}) were not brought in: "
                     "they answered for the other project, and this project's own answers stay as they are.")
    after.extend(row["words"] for row in renumbered_now or [])
    superseded = [row["to"] for row in slices if row["status_here"] == "superseded"]
    numbers_note = prd.numbers_note(numbers, {"slices": list(mapping.values())}).strip() if numbers else ""
    ready = [mapping[i] for i in ready_in_source(found)]
    # Ready there, but the archive says its text is not the approved version (the exporter's word): for example a slice read
    # from GitHub whose design mock pictures were not on the main branch, which came without them. Never marked ready in one step.
    held_back = [mapping[i] for i in sorted(found.slices, key=number)
                 if found.facts["slices"].get(i, {}).get("was") in READY_WAS and found.facts["slices"].get(i, {}).get("was_ready") is False
                 and found.slices[i]["status"] != "superseded"]
    if held_back:
        after.append(f"{listing([both(i) for i in held_back])} {'was' if len(held_back) == 1 else 'were'} ready in the old repository, but the file "
                     f"does not hold {'its' if len(held_back) == 1 else 'their'} approved version whole (for example design mocks that were not "
                     "on the main branch there, so they did not come). Check each, add any mock again, and mark it ready yourself; marking "
                     "ready in one step leaves it out.")
    return {
        "archive": {"file": found.label, "sha256": found.sha256, "exported_at": found.manifest.get("exported_at"),
                    "mach_version": found.manifest.get("mach_version")},
        "mode": mode, "into_project": into, "from_project": found.project_id, "from_project_name": found.name,
        "map": by_kind(mapping), "renumbered": any(old != new for old, new in mapping.items()), "why_numbered": why,
        "numbers_counted": how, "numbers_note": numbers_note or None, "notes": notes,
        "counts": {"epics": len(found.epics), "slices": len(found.slices), "principles": len(principles_in), "needs": len(needs_in),
                   "ideas": len(found.ideas), "prds": sum(1 for i in found.documents if prefix(i) == "PRD"),
                   "designs": sum(1 for i in found.documents if prefix(i) == "DES"),
                   "mocks": sum(len(p) for p in found.mocks.values()), "files": len(built.files)},
        "slices": slices, "superseded": superseded,
        "check_by_hand": built.check_by_hand, "not_in_archive": built.not_in_archive, "links_dropped": built.links_dropped,
        "needs_none_left_behind": built.none_left_behind,
        "shipped_rules": built.shipped_rules, "same_principles": same,
        "principles_not_assessed": not_assessed, "principles_aligned": built.aligned, "dependencies_added": built.dependencies_added,
        "renumbered_on_resume": list(renumbered_now or []),
        "ready_in_source": {"slices": ready, "count": len(ready), "held_back": held_back,
                            "words": (f"{plural(len(ready), 'slice was', 'slices were')} ready in the old repository "
                                      f"({listing([both(i) for i in ready[:6]])}{' and others' if len(ready) > 6 else ''}). On your word, MACH can mark "
                                      f"{'it' if len(ready) == 1 else 'them'} ready here in one step, dependencies first, each checked as "
                                      "marking ready checks it; it stops at the first that is not ready yet. That step first publishes "
                                      "the product principles and technical needs that came with the project, as they then stand here."
                                      if ready else "No slice was ready in the old repository.")},
        "after": after,
        "left_behind": {"jira": jira, "epic_jira": epic_jira, "requests": requests, "accepted_concerns": built.accepted_concerns,
                        "idea_sources": {mapping[i]: s for i, s in sorted(found.idea_sources.items())},
                        "lookups_removed": {mapping[i]: n for i, n in sorted(found.lookups_removed.items()) if n},
                        "project": ({"name": found.project.get("name"), "vision": found.project.get("vision"),
                                     "outcomes": list(found.project.get("outcomes") or [])} if mode == "join" else None),
                        "approvals": "never carried", "github_issues": "stay in the old repository"},
        "factory_authorized": False,
    }


def shipped_here(studio: Any) -> Optional[Set[str]]:
    try:
        return {str(item.get("rule")) for item in studio.shipped().get("in_force") or [] if isinstance(item, dict)}
    except Exception:  # noqa: BLE001
        return None


def note_words(found: Incoming, mapping: Dict[str, str], shared: Dict[str, Any], placed: bool, app: bool = False) -> str:
    slices = shared["slices"]
    epics = len(found.epics)
    verb = "Brought in" if placed else "Would bring in"
    text = f"{verb} {plural(len(slices), 'slice')} in {plural(epics, 'epic')} from the project '{found.name}'."
    replaced = [row for row in slices if row["status_here"] == "superseded"]
    counts = {}
    for row in slices:
        if row["was"] in WAS_COUNTED and row["status_here"] != "superseded":
            counts[row["was"]] = counts.get(row["was"], 0) + 1
    parts = [f"{counts[w]} {'was' if counts[w] == 1 else 'were'} {WAS_WORDS[w]}" for w in WAS_COUNTED if counts.get(w)]
    lead = " Every slice is a draft here" if not replaced else \
        f" Every slice is a draft here, except {plural(len(replaced), 'slice')} replaced in the old repository, which {'stays' if len(replaced) == 1 else 'stay'} replaced"
    text += lead + (f": in the old repository {listing(parts)}." if parts else ".")
    text += " Nothing was sent to GitHub."
    ready = shared["ready_in_source"]["count"]
    if ready:
        # One instruction: what was ready there can be marked ready in one step, which publishes what came with it first.
        how = "" if app else " (project imports ready)"
        text += (f" {ready} of them {'was' if ready == 1 else 'were'} ready in the old repository and can be marked ready here in one step"
                 f"{how}, on your word, which first publishes the principles and technical needs that came with them.")
    elif shared["counts"]["principles"]:
        text += " Publish the principles, then mark each slice ready when you have checked it."
    else:
        text += " Mark each slice ready when you have checked it."
    return text


# ---- plan (4.4) ----


def prepare(host: Any, studio: Any, archive: Path) -> Dict[str, Any]:
    """Every check, then the mode, numbers and rewrite: the shared start of plan and run. Changes nothing but Studio's cache of
    GitHub (refresh_numbers)."""
    found = read_archive(host, studio, archive)
    check_destination(host, studio, found)
    path = imports_folder(studio) / f"{found.sha256[:16]}.json"
    existing = next((data for p, data in _records(studio) if p == path), None)
    if existing is not None and existing.get("finished_at"):
        return {"found": found, "finished": existing}
    if existing is not None:
        if not existing["map"] or not isinstance(existing.get("targets"), dict):
            raise host.StudioError(f"Bringing in stopped part way, and its record ({path.name}) is not one this MACH can read. "
                                   "Run it again with the MACH that started it.")
        mapping = {str(k): str(v) for k, v in existing["map"].items()}
        mode, into = existing["mode"], existing["into_project"]
        joined = joined_of(existing)
        first = build(host, studio, found, mapping, mode, into, joined)
        # Numbers given out before the stop may since have been taken where the engineers number their own slices: one this
        # import has placed nothing of takes the next free number; one it has placed part of stops, with what to do.
        ours = ours_of(first, placed_so_far(studio, existing))
        mapping, renumbered = settle_clashes(host, studio, found, mapping, ours)
        built = build(host, studio, found, mapping, mode, into, joined) if renumbered else first
        return {"found": found, "record": existing, "mapping": mapping, "mode": mode, "into": into, "built": built, "first": first,
                "renumbered_now": renumbered, "joined": joined, "how": None, "why": list(existing.get("why_numbered") or []), "notes": [],
                "numbers": None}
    mode, into, notes = choose_mode(host, studio, found)
    incoming = incoming_ids(studio, found)
    links_that_cannot_go(host, found, incoming)  # before GitHub is read, so this refusal changes nothing either
    used, how, numbers = counted(host, studio)
    here = active_here(studio) if mode == "join" else []
    matched = matched_principles(found, here) if mode == "join" else {}
    joined = {"matched": matched, "here": here, "day": host.now(None)[:10]}
    mapping, why = numbering(mode, incoming, used, {old: item["here"] for old, item in matched.items()})
    mapping, renumbered = settle_clashes(host, studio, found, mapping, set())
    built = build(host, studio, found, mapping, mode, into, joined)
    return {"found": found, "record": None, "mapping": mapping, "mode": mode, "into": into, "built": built, "first": built,
            "renumbered_now": renumbered, "joined": joined, "how": how, "why": why, "notes": notes, "numbers": numbers}


def joined_of(record: Dict[str, Any]) -> Dict[str, Any]:
    """What a record kept of this project's principles when the import started (none in a record from before they were kept)."""
    matched = record.get("principles_matched") if isinstance(record.get("principles_matched"), dict) else {}
    here = record.get("here_principles") if isinstance(record.get("here_principles"), list) else []
    return {"matched": {str(k): dict(v) for k, v in matched.items() if isinstance(v, dict) and isinstance(v.get("here"), str)},
            "here": [dict(item) for item in here if isinstance(item, dict) and isinstance(item.get("id"), str)],
            "day": str(record.get("day") or record.get("started_at") or "")[:10] or None}


# ---- slice numbers taken where the engineers number their own slices, after the import gave them out (M21) ----


def elsewhere(studio: Any) -> Dict[str, List[Path]]:
    """Every slice ID a file outside the Product Studio draft holds, as the engineers' allocator (cell.slice_ids) reads them:
    the specs on this checkout and in every ticket's workspace, and the work orders committed on this checkout."""
    found: Dict[str, List[Path]] = {}
    draft = (studio.draft / "specs" / "slices").resolve()
    for folder in studio.cell.registries(studio.project):
        if folder.resolve() == draft:
            continue
        for path in sorted(folder.glob("SLICE-*.md")):
            match = studio.validate_slice.FILENAME_RE.match(path.name)
            if match:
                found.setdefault(match.group(1), []).append(path)
    folder = studio.project / "product" / "slices"
    if folder.is_dir():
        for path in sorted(folder.glob("SLICE-*.json")):
            if product.SLICE_RE.fullmatch(path.stem):
                found.setdefault(path.stem, []).append(path)
    return found


def where_words(studio: Any, path: Path) -> str:
    """Where another slice's file is, in a product manager's words."""
    worktrees = studio.project / ".factory" / "worktrees"
    try:
        parts = path.relative_to(worktrees).parts
        return f"the engineers' ticket {parts[0]} (its spec {path.name})"
    except ValueError:
        pass
    try:
        return f"{path.relative_to(studio.project).as_posix()} in this repository"
    except ValueError:
        return path.name


def settle_clashes(host: Any, studio: Any, found: Incoming, mapping: Dict[str, str], ours: Set[str]) -> Tuple[Dict[str, str], List[Dict[str, Any]]]:
    """The slice numbers of the map against every slice ID in use outside the draft. One this import has placed nothing of takes
    the next free number (listed); one it has placed part of stops the import with a sentence a product manager can act on. A
    slice of this project already marked ready is the same slice in the engineers' hands, never a clash."""
    other = elsewhere(studio)
    handed = set(studio.handoff().handed_over())
    clashes = sorted((old, new) for old, new in mapping.items() if prefix(new) == "SLICE" and new in other and new not in handed)
    if not clashes:
        return mapping, []
    for old, new in clashes:
        if new in ours:
            where = where_words(studio, other[new][0])
            raise host.StudioError(
                f"Bringing in stopped: {new} is the number this import gave {old} of the project {found.name}, and part of it is already here, "
                f"but {where} now uses {new} for another slice. Ask the engineer working on it to give their slice another number, then bring "
                "the same file in again. Or set this import aside: what it already brought in stays where it is.")
    used, reserved = studio.cell.slice_ids(studio.project)
    taken = {number(v) for v in mapping.values() if prefix(v) == "SLICE"} | set(used) | set(reserved) | {number(i) for i in other}
    taken |= {int(n) for n in studio.handoff().taken_ids()} | set(reserved_numbers(studio, "SLICE"))
    free = max(taken | {0}) + 1
    mapping = dict(mapping)
    moved = []
    for old, new in clashes:
        mapping[old] = project_ids._format("SLICE", free)  # noqa: SLF001
        moved.append({"id": old, "was_to_be": new, "now": mapping[old], "taken_by": where_words(studio, other[new][0]),
                      "words": f"{old} of the project was to be {new} here, but {where_words(studio, other[new][0])} now uses {new}, "
                               f"so it is {mapping[old]}."})
        free += 1
    return mapping, moved


def already(found: Incoming, record: Dict[str, Any], plan_only: bool) -> Dict[str, Any]:
    day = str(record.get("finished_at"))[:10]
    mapping = {str(k): str(v) for k, v in record["map"].items()}
    return {"plan": plan_only, "already": True, "imported": False, "archive": {"file": found.label, "sha256": found.sha256},
            "mode": record.get("mode"), "into_project": record.get("into_project"), "from_project": record.get("from_project"),
            "map": by_kind(mapping), "finished_at": record.get("finished_at"), "writes": "nothing", "factory_authorized": False,
            "note": f"Already brought in on {day}. Nothing was changed."}


def plan(host: Any, studio: Any, archive: Path) -> Dict[str, Any]:
    """`project import <archive> --plan`: the same computation as run, then it stops. Writes nothing to the project; the read of
    GitHub updates Studio's cache of it (issues.json `seen`), as prd apply does, and the map is kept beside the import records
    (`<id>.plan.json`) so the import that follows can say if the numbers moved in between."""
    work = prepare(host, studio, archive)
    found = work["found"]
    if "finished" in work:
        return already(found, work["finished"], True)
    rows_here = rows_for_slices_here(host, studio, [item for item in work["built"].principles if item.get("status") == "active"],
                                     set(work["mapping"].values()), found.name, work["joined"]["day"] or host.now(None)[:10], write=False)
    shared = summary(host, studio, found, work["mapping"], work["mode"], work["into"], work["built"], work["how"], work["why"],
                     work["notes"], work["numbers"], work["joined"], rows_here, work["renumbered_now"])
    if work["record"] is None:
        keep_plan(host, studio, found, work["mapping"])
    return {"plan": True, "resuming": work["record"] is not None, **shared, "writes": "nothing",
            "note": note_words(found, work["mapping"], shared, placed=False, app=bool(getattr(host, "APP", False)))}


def plan_path(studio: Any, archive_sha256: str) -> Path:
    return imports_folder(studio) / f"{archive_sha256[:16]}.plan.json"


def keep_plan(host: Any, studio: Any, found: Incoming, mapping: Dict[str, str]) -> None:
    host.write(plan_path(studio, found.sha256), host.canonical({"schema_version": SCHEMA_VERSION, "archive_sha256": found.sha256,
                                                                "planned_at": host.now(None), "map": mapping}))


def planned_map(studio: Any, archive_sha256: str) -> Optional[Dict[str, str]]:
    path = plan_path(studio, archive_sha256)
    try:
        if path.is_symlink() or not path.is_file():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):
        return None
    if not isinstance(data, dict) or data.get("archive_sha256") != archive_sha256 or not isinstance(data.get("map"), dict):
        return None
    return {str(k): str(v) for k, v in data["map"].items()}


# ---- run (4.5 to 4.7) ----


def run(host: Any, studio: Any, archive: Path) -> Dict[str, Any]:
    """`project import <archive>`: every check, the numbers, the rewrite; then the record, the staging and the placing."""
    work = prepare(host, studio, archive)
    found = work["found"]
    if "finished" in work:
        return already(found, work["finished"], False)
    mapping, mode, into, built = work["mapping"], work["mode"], work["into"], work["built"]
    record_path = imports_folder(studio) / f"{found.sha256[:16]}.json"
    staging = imports_folder(studio) / found.sha256[:16] / "files"
    targets = {rel: sha(data) for rel, data in built.files.items()}
    before = set(destination_errors(studio))
    resuming = work["record"] is not None
    if resuming:
        record = work["record"]
        if record.get("targets") != {rel: sha(data) for rel, data in work["first"].files.items()}:
            raise host.StudioError("Bringing in stopped part way: this MACH rewrites the archive's files differently from the one that started "
                                   "the import. Run it again with the MACH that started it.")
        if work["renumbered_now"]:  # numbers taken meanwhile by the engineers: the map and every file it changes, recorded first
            record = {**record, "map": mapping, "targets": targets,
                      "renumbered_on_resume": list(record.get("renumbered_on_resume") or []) + work["renumbered_now"]}
            host.write(record_path, host.canonical(record))
    else:
        foreign = foreign_file(studio, built, targets, {})
        if foreign:
            raise refusal(host, stopped_words(host, *foreign))
        studio.ensure_ignored()
        record = new_record(host, found, mapping, mode, into, built, targets, work["why"], work["joined"])
        host.write(record_path, host.canonical(record))  # 1. recorded before anything is placed
    moved = numbers_moved(studio, found.sha256, mapping) if not resuming else []
    # What an earlier run placed. A file placed then and changed since is the person's edit: kept, never a reason to stop.
    earlier = placed_so_far(studio, record)
    if resuming and work["renumbered_now"]:
        earlier = replace_unchanged(studio, found.sha256, staging, built, targets, earlier)

    # 2. Staging: every file, already rewritten, rebuilt from the archive when it is missing (the rewrite is deterministic).
    try:
        for rel, data in built.files.items():
            target = staging / rel
            if target.is_file() and not target.is_symlink() and sha(target.read_bytes()) == targets[rel]:
                continue
            if rel in earlier or ((studio.draft / rel).is_file() and not (studio.draft / rel).is_symlink()):
                continue  # already placed by an earlier run; placing checks its bytes
            target.parent.mkdir(parents=True, exist_ok=True)
            write_bytes(target, data)
    except OSError as exc:
        raise host.StudioError(stopped_os(exc))

    # 3. Placing, in order, each step looking before it writes.
    placed: Dict[str, int] = {}
    yours: List[Dict[str, Any]] = []
    there = 0
    foreign = foreign_file(studio, built, targets, earlier)
    if foreign:
        raise host.StudioError(stopped_words(host, *foreign))
    ours = ours_of(built, earlier)
    try:
        for step, rels in built.steps:
            if step == "epics":
                there += merge_sets(host, studio, found, built, mode, into, placed, earlier, yours)
            for rel in rels:
                done = place_one(host, studio, found.sha256, staging, rel, targets[rel], built.owners[rel], earlier, ours)
                if done == "placed":
                    placed[step] = placed.get(step, 0) + 1
                elif done == "there":
                    there += 1
                else:
                    yours.append(kept_row(rel, built.owners[rel], done))
        if not any(step == "epics" for step, _ in built.steps):
            there += merge_sets(host, studio, found, built, mode, into, placed, earlier, yours)
        there += place_order(studio, built, placed)
        there += place_notes(host, studio, built, placed)
        # 3b. This project's own slices still being written, against each principle that came: a Not assessed row where they do
        # not answer it. Last, after the principles are in; a second run finds the rows there and adds none.
        rows_here = rows_for_slices_here(host, studio, [item for item in built.principles if item.get("status") == "active"],
                                         set(mapping.values()), found.name, work["joined"]["day"] or host.now(None)[:10], write=True)
    except OSError as exc:
        raise host.StudioError(stopped_os(exc))

    # 4. Finished: the check once more, the record kept (with everything it placed), staging and the log removed.
    after = product.validate_workspace(studio.draft)
    introduced = [error for error in after["errors"] if error not in before]
    record = dict(record)
    record["finished_at"] = host.now(None)
    record["structural_errors"] = introduced
    record["placed"] = placed_so_far(studio, record)
    record["kept_yours"] = [row["file"] for row in yours]
    record["principles_not_assessed"] = [{k: row[k] for k in ("slice", "principle", "file", "how")} for row in built.not_assessed + rows_here]
    record["dependencies_added"] = [{k: row[k] for k in ("slice", "on", "rule", "added")} for row in built.dependencies_added]
    host.write(record_path, host.canonical(record))
    tidy(studio, found.sha256)

    shared = summary(host, studio, found, mapping, mode, into, built, work["how"], work["why"], work["notes"], work["numbers"],
                     work["joined"], rows_here, work["renumbered_now"])
    note = note_words(found, mapping, shared, placed=True, app=bool(getattr(host, "APP", False)))
    if yours:
        note += " " + " ".join(row["words"] for row in yours[:5])
        if len(yours) > 5:
            note += f" And {plural(len(yours) - 5, 'more file')}: listed under kept_yours."
    if moved:
        note += " The numbers moved since the plan: " + "; ".join(f"{row['id']} was to be {row['planned']} and is {row['now']}" for row in moved) + "."
    if introduced:
        note += f" The workspace has {plural(len(introduced), 'problem')} it did not have before; the files stay as they are: " + "; ".join(introduced[:3]) + "."
    return {"imported": True, "resumed": resuming, **shared, "placed": placed, "already_there": there, "kept_yours": yours,
            "structural_errors": introduced, "numbers_moved": moved, "record": str(record_path.relative_to(studio.project)), "note": note}


def tidy(studio: Any, archive_sha256: str) -> None:
    """Staging, the log of what was placed and the plan's map, removed once the record holds what it needs."""
    shutil.rmtree(str(imports_folder(studio) / archive_sha256[:16]), ignore_errors=True)
    for path in (plan_path(studio, archive_sha256), placed_log_path(studio, archive_sha256)):
        if path.is_file() and not path.is_symlink():
            path.unlink()


def what_file(rel: str, owner: str) -> str:
    """A draft file in a person's words: "SLICE-011's work order", "the product principles"."""
    import project_export  # noqa: E402  the export's own words for each member
    what, _ = project_export.described("workspace/" + rel)
    return what[0].lower() + what[1:] if what.startswith("The ") else what


def kept_row(rel: str, owner: str, how: str) -> Dict[str, Any]:
    what = what_file(rel, owner)
    if how == "yours":
        words = f"You changed {what} after it was brought in; your version was kept."
    else:
        words = f"{what[0].upper() + what[1:]} was brought in, then moved or removed here; MACH did not bring it in again."
    return {"file": rel, "id": owner, "how": how, "words": words}


def set_aside(host: Any, studio: Any, which: Optional[str]) -> Dict[str, Any]:
    """`project import --abandon [<record>]`, on the product manager's word: the import that stopped part way is set aside. Its
    record is kept (renamed, marked set_aside_at, with everything it placed), so its numbers are no longer held, export and
    another import are no longer blocked, and `project imports` still answers what an ID was. Staging, the log and the plan's
    map are removed. Every file already placed stays exactly where it is; the result lists them so the person can keep or
    remove them. Nothing else is changed: no file of the workspace is moved, rewritten or deleted."""
    if host.policies_helper().unattended():
        raise refusal(host, "Setting aside a project being brought in is a product manager's act; a supervised execution does not do it.")
    waiting = [(path, data) for path, data in _records(studio) if open_record(data)]
    if which:
        chosen = [(path, data) for path, data in waiting
                  if which in (path.stem, data["archive_sha256"], str((data.get("archive") or {}).get("file") or ""))]
    else:
        chosen = waiting
    if not waiting:
        raise refusal(host, "No project is part way through being brought in here, so there is nothing to set aside.")
    if not chosen:
        raise refusal(host, f"No project being brought in here matches '{project_archive.shown(which or '')}'. "
                            + "The one waiting is " + listing([str((d.get("archive") or {}).get("file") or p.stem) for p, d in waiting]) + ".")
    if len(chosen) > 1:
        raise refusal(host, "More than one project is part way through being brought in here: "
                            + listing([f"{(d.get('archive') or {}).get('file') or 'an archive'} (record {p.stem})" for p, d in chosen])
                            + ". Say which one to set aside.")
    path, record = chosen[0]
    placed = placed_so_far(studio, record)
    mapping = {str(k): str(v) for k, v in (record.get("map") or {}).items()}
    back = {new: old for old, new in mapping.items()}
    owners: Dict[str, List[str]] = {}
    for key in sorted(placed):
        rel, _, item = key.partition("#")
        ident = ("the technical needs" if item == "file" else item) if item else owner_of(rel)
        here = studio.draft / rel
        if "#" in key or here.is_file():
            owners.setdefault(ident, []).append(rel)
    brought = [{"id": ident, "was": back.get(ident), "files": sorted(set(files))}
               for ident, files in sorted(owners.items(), key=lambda pair: (prefix(pair[0]) if project_ids._split(pair[0]) else "~", pair[0]))]  # noqa: SLF001
    now = host.now(None)
    record = {**record, "set_aside_at": now, "placed": placed}
    target = path.with_name(f"{record['archive_sha256'][:16]}.set-aside-{now.replace('-', '').replace(':', '')}.json")
    host.write(target, host.canonical(record))
    path.unlink()
    tidy(studio, record["archive_sha256"])
    name = str((record.get("archive") or {}).get("file") or "the archive")
    ids = [row["id"] for row in brought]
    if ids:
        them = "it" if len(ids) == 1 else "them"
        kept = (f"What it had already brought in stays where it is: {listing(ids[:8])}{' and others' if len(ids) > 8 else ''} "
                f"(listed under brought_in). Keep {them}, or remove {them} if you do not want {them}.")
    else:
        kept = "Nothing from it had been brought in yet."
    return {"set_aside": True, "archive": {"file": name, "sha256": record["archive_sha256"]}, "from_project": record.get("from_project"),
            "brought_in": brought, "numbers_released": {kind: sorted(number(new) for new in mapping.values() if prefix(new) == kind)
                                                       for kind in KIND_ORDER if any(prefix(new) == kind for new in mapping.values())},
            "record": str(target.relative_to(studio.project)), "factory_authorized": False,
            "note": f"MACH stopped bringing in the project from {name} and set it aside. {kept} The numbers it was holding are free again, "
                    "and nothing else was changed."}


def owner_of(rel: str) -> str:
    """The ID a draft file belongs to, from its path; "the project" for project.json."""
    if rel == PROJECT_REL:
        return "the project"
    match = project_ids.TOKEN_RE.search(rel.replace("/", " ").replace(".", " "))
    return match.group(0) if match else rel


def write_bytes(path: Path, data: bytes) -> None:
    temporary = path.with_name(path.name + ".tmp")
    with open(str(temporary), "wb") as handle:
        handle.write(data)
    os.replace(str(temporary), str(path))


def new_record(host: Any, found: Incoming, mapping: Dict[str, str], mode: str, into: str, built: Built, targets: Dict[str, str],
               why: List[str], joined: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    facts = found.facts
    joined = joined or {"matched": {}, "here": [], "day": None}
    return {
        "schema_version": SCHEMA_VERSION, "archive_sha256": found.sha256,
        "archive": {"file": found.label, "path": str(found.path), "exported_at": found.manifest.get("exported_at"),
                    "mach_version": found.manifest.get("mach_version")},
        "mode": mode, "from_project": found.project_id, "from_project_name": found.name, "into_project": into,
        "started_at": host.now(None), "day": joined["day"] or host.now(None)[:10], "finished_at": None, "map": mapping, "why_numbered": why,
        "targets": targets,
        # Joining: the principles that say the same as one here (taken as that one), and this project's principles as they stood,
        # so a second run writes the same rows whatever changed here meanwhile.
        "principles_matched": joined["matched"], "here_principles": joined["here"],
        "was_ready": {mapping[i]: True for i in sorted(ready_in_source(found), key=number)},
        "merges": {"principles": [item["id"] for item in built.principles], "needs": [item["need_id"] for item in built.needs]},
        "order": built.order, "notes": built.notes,
        "facts": {"last_read_github_at": facts["last_read_github_at"],
                  "slices": {mapping[i]: {k: v for k, v in e.items() if k in ("was", "revision")} for i, e in sorted(facts["slices"].items())},
                  "jira": {mapping[i]: e["jira"] for i, e in sorted(facts["slices"].items()) if e.get("jira")},
                  "epic_jira": {mapping[i]: e["jira"] for i, e in sorted(facts["epics"].items())},
                  "requests": {mapping[i]: e["request"] for i, e in sorted(facts["slices"].items()) if e.get("request")},
                  "idea_sources": {mapping[i]: s for i, s in sorted(found.idea_sources.items())},
                  "verdicts_from": "the old repository" if any(isinstance(r.get("verdict"), dict) for r in found.ideas.values()) else None,
                  "lookups_removed": {mapping[i]: n for i, n in sorted(found.lookups_removed.items()) if n},
                  "project": ({"name": found.project.get("name"), "vision": found.project.get("vision"),
                               "outcomes": list(found.project.get("outcomes") or [])} if mode == "join" else None)},
    }


def numbers_moved(studio: Any, archive_sha256: str, mapping: Dict[str, str]) -> List[Dict[str, str]]:
    planned = planned_map(studio, archive_sha256)
    if planned is None:
        return []
    return [{"id": old, "planned": planned.get(old), "now": new} for old, new in sorted(mapping.items()) if planned.get(old) != new]


def stopped_words(host: Any, ident: str, rel: str, ours: bool = False) -> str:
    """Placing stopped because something here holds a place this import gives out. `ours`: this import has already brought in
    part of `ident`, so the ID is the import's own and is never to be renumbered; only the stray file is in the way."""
    kind = prefix(ident)
    noun = NOUNS.get(kind, "file")
    if ours:
        return (f"Bringing in stopped: {rel} is in the workspace but is not the file this import brings in for {ident}, which came with "
                "the project. Move that file out of the workspace, then run the import again with the same file.")
    if kind in RENUMBER:
        fix = host.say(f"Give that {noun} a new number ({RENUMBER[kind]} {ident}), then run the import again with the same file.",
                       f"Give that {noun} a new number, then run the import again with the same file.")
    else:
        fix = "Move it out of the workspace, then run the import again with the same file."
    return (f"Bringing in stopped: {ident} is now used by another {noun} here ({rel}), made after the numbers were given out. {fix}")


def stopped_os(exc: OSError) -> str:
    words = exc.strerror or str(exc) or type(exc).__name__
    return (f"Bringing in stopped part way: {words[0].lower() + words[1:] if words else words}. Run it again with the same file; "
            "nothing already brought in is repeated.")


def _within_draft(studio: Any, target: Path) -> bool:
    """True when no folder between the draft and the target is a symbolic link."""
    current = target.parent
    draft = studio.draft
    while current != draft and draft in current.parents:
        if current.is_symlink():
            return False
        current = current.parent
    return current == draft


def foreign_file(studio: Any, built: Built, targets: Dict[str, str], earlier: Dict[str, str]) -> Optional[Tuple[str, str, bool]]:
    """The first file here that holds one of the new IDs, is not exactly what this import writes and was not placed by this
    import (`earlier`: what an earlier run of it placed; a change to one of those is the person's, never another item's):
    (ID, file, whether this import has already placed part of that ID)."""
    ours = ours_of(built, earlier)
    for rel, digest in targets.items():
        target = studio.draft / rel
        if not _within_draft(studio, target) or target.is_symlink():
            return built.owners[rel], rel, built.owners[rel] in ours
        if rel in earlier:
            continue
        if target.exists() and (not target.is_file() or sha(target.read_bytes()) != digest):
            return built.owners[rel], rel, built.owners[rel] in ours
    specs = {rel for rel in targets if rel.startswith("specs/slices/")}
    for rel in sorted(specs):
        owner = built.owners[rel]
        if owner in ours:
            continue  # the person renamed or replaced the spec this import brought in
        for other in sorted((studio.draft / "specs" / "slices").glob(f"{owner}-*.md")):
            relative = studio.relative(other)
            if relative not in targets and product.SPEC_NAME_RE.fullmatch(other.name):
                return owner, relative, False
    folders = {}
    for rel, owner in built.owners.items():
        if rel.startswith(("product/mocks/", "product/prds/", "product/designs/")) and owner not in ours:
            folders["/".join(rel.split("/")[:3])] = owner
    for folder, owner in sorted(folders.items()):
        path = studio.draft / folder
        if path.is_symlink():
            return owner, folder, False
        if path.is_dir():
            for item in sorted(path.rglob("*")):
                relative = studio.relative(item)
                if item.is_file() and relative not in targets:
                    return owner, relative, False
    return None


def ours_of(built: Built, earlier: Dict[str, str]) -> Set[str]:
    """The new IDs this import has already placed something of."""
    return {built.owners[rel] for rel in earlier if rel in built.owners}


def place_one(host: Any, studio: Any, archive_sha256: str, staging: Path, rel: str, digest: str, owner: str, earlier: Dict[str, str],
              ours: Set[str]) -> str:
    """Place one file: "placed"; "there" when it is already there with exactly these bytes; "yours" when an earlier run placed it
    and the person has changed it since (their version is kept); "gone" when an earlier run placed it and it has since been
    moved or removed here (it is not placed again). Stops when something else holds its place."""
    target = studio.draft / rel
    if not _within_draft(studio, target) or target.is_symlink():
        raise host.StudioError(stopped_words(host, owner, rel, owner in ours))
    if target.exists():
        if target.is_file() and sha(target.read_bytes()) == digest:
            return "there"
        if rel in earlier and target.is_file():
            return "yours"
        raise host.StudioError(stopped_words(host, owner, rel, owner in ours))
    if rel in earlier:
        return "gone"
    source = staging / rel
    if source.is_symlink() or not source.is_file() or sha(source.read_bytes()) != digest:
        raise host.StudioError("Bringing in stopped part way: a staged file is missing or changed. Run it again with the same file; "
                               "nothing already brought in is repeated.")
    target.parent.mkdir(parents=True, exist_ok=True)
    _place(source, target)
    note_placed(studio, archive_sha256, rel, digest)
    return "placed"


def replace_unchanged(studio: Any, archive_sha256: str, staging: Path, built: Built, targets: Dict[str, str],
                      earlier: Dict[str, str]) -> Dict[str, str]:
    """After a slice was given another number on resuming: a file an earlier run placed that names it, and that nobody has changed
    since, is this import's own and is put right (placed again with the new number). One the person changed is theirs and kept."""
    earlier = dict(earlier)
    for rel, digest in sorted(targets.items()):
        old = earlier.get(rel)
        target = studio.draft / rel
        if old is None or old == digest or not target.is_file() or target.is_symlink() or sha(target.read_bytes()) != old:
            continue
        source = staging / rel
        source.parent.mkdir(parents=True, exist_ok=True)
        write_bytes(source, built.files[rel])
        _place(source, target)
        note_placed(studio, archive_sha256, rel, digest)
        earlier[rel] = digest
    return earlier


def item_sha(item: Dict[str, Any]) -> str:
    return sha(json.dumps(item, sort_keys=True, ensure_ascii=False).encode("utf-8"))


def merge_sets(host: Any, studio: Any, found: Incoming, built: Built, mode: str, into: str, placed: Dict[str, int],
               earlier: Dict[str, str], yours: List[Dict[str, Any]]) -> int:
    """The principles and needs, added by ID to what is here and written whole (Studio.save_product_file). An item already here
    with the same content is skipped; one this import added earlier and the person has changed or removed since is theirs and is
    left as it is; any other with that ID stops. A new project's needs.json is written whenever the archive's carries anything,
    its "nothing to say" answers too; when joining, this project's own answers stand. Returns how many were already there."""
    rules = host.ticket_rules()
    there = 0
    for kind, rel, key, list_key, items in (("PP", PRINCIPLES_REL, "id", "principles", built.principles),
                                            ("TN", NEEDS_REL, "need_id", "needs", built.needs)):
        whole = f"{rel}#file"   # a new project's needs.json written for its "nothing to say" answers alone
        carries_none = kind == "TN" and mode == "new" and found.needs is not None and bool(built.needs_none)
        if not items and not carries_none:
            continue
        path = studio.draft / rel
        current: Dict[str, Any] = {}
        if path.is_file() and not path.is_symlink():
            current = json.loads(path.read_text(encoding="utf-8"))
        mine = {item[key]: item for item in current.get(list_key) or []}
        added: List[Dict[str, Any]] = []
        for item in items:
            have = mine.get(item[key])
            mark = f"{rel}#{item[key]}"
            if have is None and mark in earlier:
                yours.append({"file": rel, "id": item[key], "how": "gone",
                              "words": f"{item[key]} was brought in, then retired or removed here; MACH did not bring it in again."})
            elif have is None:
                mine[item[key]] = item
                added.append(item)
            elif have == item:
                there += 1
            elif mark in earlier:
                yours.append({"file": rel, "id": item[key], "how": "yours", "words": f"You changed {item[key]} after it was brought in; your version was kept."})
            else:
                raise host.StudioError(stopped_words(host, item[key], rel))
        write_whole = carries_none and not current and whole not in earlier
        if not added and not write_whole:
            continue
        merged = sorted(mine.values(), key=lambda item: number(item[key]))
        if kind == "PP":
            data = {"schema_version": 1, "project_id": into, "principles": json.loads(rules.principles_canonical(merged))}
        else:
            none = current.get("none") if isinstance(current.get("none"), list) else (built.needs_none or [])
            if mode == "new" and not current:
                none = built.needs_none or []
            data = {"schema_version": 1, "project_id": into, "needs": json.loads(rules.needs_canonical(merged)),
                    "none": [k for k in rules.NEED_KINDS if k in none]}
        studio.save_product_file(path, data, "Bringing in the project's " + ("principles" if kind == "PP" else "technical needs"))
        for item in added:
            note_placed(studio, found.sha256, f"{rel}#{item[key]}", item_sha(item))
        if write_whole:
            note_placed(studio, found.sha256, whole, sha(path.read_bytes()))
        counted_as = "principles" if kind == "PP" else "needs"
        if added or write_whole:
            placed[counted_as] = placed.get(counted_as, 0) + len(added)
    return there


def place_order(studio: Any, built: Built, placed: Dict[str, int]) -> int:
    """The order of each new epic into the ledger (issues.json `order`), only where that epic has none yet."""
    if not built.order:
        return 0
    hand = studio.handoff()
    there = 0
    with hand.exclusive():
        data = hand.load()
        changed = False
        for epic_id, slices in sorted(built.order.items()):
            have = (data["order"].get(epic_id) or {}).get("slices")
            if have:
                there += 1
                continue
            data["order"][epic_id] = {**handoff.empty_order(), "slices": list(slices)}
            placed["order"] = placed.get("order", 0) + 1
            changed = True
        if changed:
            hand.save(data)
    return there


def place_notes(host: Any, studio: Any, built: Built, placed: Dict[str, int]) -> int:
    """The resume notes into session.json `notes`, only where the new slice has none."""
    if not built.notes:
        return 0
    session = studio.session()
    there = 0
    changed = False
    for slice_id, note in sorted(built.notes.items()):
        if slice_id in session["notes"]:
            there += 1
            continue
        session["notes"][slice_id] = {"note": note, "saved_at": host.now(None)}
        placed["notes"] = placed.get("notes", 0) + 1
        changed = True
    if changed:
        studio.save_session(session)
    return there


# ---- what the rest of Product Studio asks of the imports here (M21): every one reads the records, never the archive ----


def slices_of(record: Dict[str, Any]) -> Set[str]:
    return {new for new in (record.get("map") or {}).values() if isinstance(new, str) and prefix(new) == "SLICE"}


def waiting_on(studio: Any, slice_id: str) -> Set[str]:
    """The slices that came into this project with `slice_id` (one import), that it depends on directly or through others, that
    are not replaced and have not shipped here: it named their rules as shipped in the old repository, and here they ship first."""
    mates: Set[str] = set()
    for _, record in _records(studio):
        came = slices_of(record)
        if slice_id in came:
            mates |= came - {slice_id}
    if not mates:
        return set()
    works = studio.all("slice")
    shipped = {str(item.get("rule") if isinstance(item, dict) else item).split("/", 1)[0] for item in studio.shipped().get("rules") or []}
    return {s for s in mates & reach(works, slice_id) if s in works and works[s].get("status") != "superseded" and s not in shipped}


def pending_rules(studio: Any, slice_id: str) -> Dict[str, Dict[str, Any]]:
    """For the spec check (effects.check's `pending`): every rule (INV, FR, R) of each slice `slice_id` waits on, from that slice's
    draft spec. Empty for every slice that did not come with a project brought in here. Never raises."""
    try:
        found: Dict[str, Dict[str, Any]] = {}
        for other in sorted(waiting_on(studio, slice_id)):
            spec = studio.spec_of(other)
            if spec is None or spec.is_symlink():
                continue
            _, model = studio.validate_slice.analyze(spec.read_text(encoding="utf-8-sig"), spec.name)
            ids = [item.get("id") for item in (model.get("invariants") or []) + (model.get("functional_requirements") or [])]
            ids += [rule.get("id") for rule in (model.get("decision_matrix") or {}).get("rules") or []]
            for ident in ids:
                if isinstance(ident, str):
                    found[f"{other}/{ident}"] = {"slice_id": other}
        return found
    except Exception:  # noqa: BLE001  the check then reads the row as any other, an error until it has shipped
        return {}


def principles_brought_in(studio: Any) -> Set[str]:
    """The principles that came into this project with a project brought in here (added, not matched to one already here)."""
    found: Set[str] = set()
    for _, record in _records(studio):
        merges = record.get("merges") if isinstance(record.get("merges"), dict) else {}
        found |= {i for i in merges.get("principles") or [] if isinstance(i, str)}
    return found


def not_assessed_problems(studio: Any, slice_id: str, rows: Sequence[Dict[str, Any]]) -> List[str]:
    """Each Not assessed row of a spec, against the imports here: it stands only when one wrote it. "This slice came ... which
    did not have PP-01": the slice came with that import (on that day, from that project) and the principle did not. "PP-03 came
    ...": the principle came with that import and the slice did not. Anything else is written by someone else, and is refused."""
    problems = []
    records = [record for _, record in _records(studio) if record.get("mode") == "join"]
    for row in rows:
        ident, how = row.get("id"), row.get("how")
        fine = False
        for record in records:
            day = str(record.get("day") or record.get("started_at") or "")[:10]
            if day != row.get("day") or str(record.get("from_project_name") or "") != row.get("project"):
                continue
            came = slices_of(record)
            added = set((record.get("merges") or {}).get("principles") or [])
            if how == "slice_came" and slice_id in came and ident not in added and ident not in (record.get("map") or {}).values():
                fine = True
            elif how == "principle_came" and ident in added and slice_id not in came:
                fine = True
        if not fine:
            problems.append(f"{ident}'s row says 'Not assessed', which only bringing in a project writes, and no project brought in here wrote "
                            f"it for {slice_id}. Answer {ident}: does it apply, not apply, or is this slice an exception?")
    return problems


def rows_on_reopen(host: Any, studio: Any, slice_id: str) -> List[Dict[str, Any]]:
    """A slice of this project marked ready before a project was brought in, reopened now: each principle that came with that
    import and that its spec does not answer gets the same Not assessed row a slice still being written got then. Nothing else."""
    found: List[Dict[str, Any]] = []
    current = {item["id"]: item for item in active_here(studio)}
    for _, record in _records(studio):
        if record.get("mode") != "join" or not record.get("finished_at") or slice_id in slices_of(record):
            continue
        came = [current[i] for i in (record.get("merges") or {}).get("principles") or [] if i in current]
        day = str(record.get("day") or record.get("started_at") or "")[:10]
        found += rows_for_slices_here(host, studio, came, slices_of(record), str(record.get("from_project_name") or record.get("from_project")),
                                      day, write=True, only=[slice_id], editable=False)
    return found


# ---- marking ready, in one step, the slices that were ready in the old repository (M21) ----


def ready_record(host: Any, studio: Any, which: Optional[str]) -> Tuple[Path, Dict[str, Any]]:
    """The import whose slices are to be marked ready: the one named (its record, the archive's SHA-256 or file name), else the
    last one finished here."""
    records = _records(studio)
    if not records:
        raise refusal(host, "No project has been brought in here, so there is nothing to mark ready.")
    if which:
        chosen = [(p, d) for p, d in records if which in (p.stem, d["archive_sha256"], str((d.get("archive") or {}).get("file") or ""))]
    else:
        chosen = [(p, d) for p, d in records if d.get("finished_at")][-1:] or [(p, d) for p, d in records if open_record(d)][-1:]
    if not chosen:
        raise refusal(host, f"No project brought in here matches '{project_archive.shown(which or '')}'." if which else
                      "No project brought in here has finished being brought in.")
    path, record = chosen[-1]
    if not record.get("finished_at"):
        name = (record.get("archive") or {}).get("file") or "the archive"
        raise refusal(host, f"Bringing in {name} has not finished. Finish it first (bring the same file in again), then mark its slices ready.")
    return path, record


def publish_first(host: Any, studio: Any, record: Dict[str, Any], order: Sequence[str], rules: Any) -> Tuple[List[str], Dict[str, Any]]:
    """Before marking ready: marking a slice ready needs the principles and technical needs published, so the ones the import
    brought in are published first, as they stand in this workspace now, through `principle publish`'s and `need publish`'s own
    acts and checks; only when they have changes that are not published, and only when there is a slice left to mark ready.
    Returns (what was published: "principles", "needs"; {"text": the sentence} or {"stopped": {"what", "reason"}})."""
    if not order:
        return [], {}
    ledger = studio.handoff().load()
    merges = record.get("merges") if isinstance(record.get("merges"), dict) else {}
    done: List[str] = []
    steps = (("principles", "product principles", bool(merges.get("principles")) and studio.unpublished(ledger), lambda: host.publish_principles(studio)),
             ("needs", "technical needs", bool(merges.get("needs")) and host.needs.unpublished(host, studio, ledger),
              lambda: host.needs.cmd_publish(host, studio, None)))
    for key, words, wanted, act in steps:
        if not wanted:
            continue
        try:
            act()
        except host.StudioError as exc:
            return done, {"stopped": {"slice": None, "what": words, "reason": str(exc)}}
        done.append(key)
    if not done:
        return [], {}
    named = listing(["the product principles" if key == "principles" else "the technical needs" for key in done])
    return done, {"text": f"Published {named} first, as they stand in this workspace, so the builders have what these slices answer."}


def ready_all(host: Any, studio: Any, which: Optional[str]) -> Dict[str, Any]:
    """`project imports ready [<record>]` and `project import <archive> --ready`, on the product manager's word: every slice of the
    import that was ready in the old repository, still here and not replaced, marked ready as `slice ready` marks it (its checks, its
    issue on GitHub or its folder), dependencies first. Stops at the first that is refused or cannot be marked ready in this act, and
    says what was done and what is left. A slice already marked ready here is left as it is."""
    if host.policies_helper().unattended():
        raise refusal(host, "Marking slices ready is a product manager's act; a supervised execution does not do it.")
    path, record = ready_record(host, studio, which)
    told = record.get("was_ready") if isinstance(record.get("was_ready"), dict) else None
    if told is None:  # a record from before was_ready was kept: what each slice was, as the archive's facts said
        told = {new: True for new, entry in ((record.get("facts") or {}).get("slices") or {}).items()
                if isinstance(entry, dict) and entry.get("was") in READY_WAS}
    works = studio.all("slice")
    chosen = {s: works[s] for s in told if told.get(s) and s in works and works[s].get("status") != "superseded"}
    order = topological({s: {"dependencies": [d for d in (w.get("dependencies") or []) if d in chosen]} for s, w in chosen.items()})
    rules = host.ticket_rules()
    done: List[Dict[str, Any]] = []
    already: List[str] = []
    stopped: Optional[Dict[str, Any]] = None
    published, publish_words = publish_first(host, studio, record, order, rules)
    if publish_words.get("stopped"):
        stopped = publish_words["stopped"]
    for slice_id in ([] if stopped else order):
        data = studio.load("slice", slice_id)
        view = handoff.slice_view(studio.handoff().load(), slice_id, data, rules)
        if data.get("status") == host.APPROVED and view.get("saved"):
            already.append(slice_id)
            continue
        try:
            result = host.mark_ready(studio, slice_id)
        except host.StudioError as exc:
            stopped = {"slice": slice_id, "reason": str(exc)}
            break
        if not result.get("ready"):
            stopped = {"slice": slice_id, "reason": result.get("note") or f"{slice_id} was not marked ready."}
            break
        done.append({"slice": slice_id, "saved_to": result.get("saved_to"), "issue": result.get("issue"), "folder": result.get("folder"),
                     "warnings": result.get("warnings") or []})
    left = [s for s in order if s not in already and s not in {row["slice"] for row in done}]
    name = str((record.get("archive") or {}).get("file") or "the archive")
    parts = [publish_words["text"]] if publish_words.get("text") else []
    parts.append(f"Marked {plural(len(done), 'slice')} ready" + (f" ({listing([row['slice'] for row in done])})" if done else "")
                 + f", dependencies first, of the {plural(len(order), 'slice')} from {name} that {'was' if len(order) == 1 else 'were'} ready in "
                   "the old repository.")
    if already:
        parts.append(f"{listing(already)} {'was' if len(already) == 1 else 'were'} already marked ready here.")
    if stopped:
        reason = " ".join(stopped["reason"].split())
        reason += "" if reason.endswith(".") else "."
        if stopped.get("slice"):
            parts.append(f"Stopped at {stopped['slice']}: {reason}")
            parts.append(f"Still to mark ready: {listing(left)}. Once that is settled, ask again and MACH carries on from {stopped['slice']}.")
        else:  # publishing what came with the project was refused: nothing was marked ready
            parts = [f"Stopped before marking anything ready: publishing the {stopped['what']} was refused. {reason}",
                     f"Still to mark ready: {listing(left)}. Once that is settled, ask again and MACH publishes them and carries on."]
    others = sorted((s for s in slices_of(record) if s in works and s not in chosen), key=number)
    if others:
        parts.append("The other slice that came was not ready in the old repository: mark it ready when you have checked it." if len(others) == 1
                     else f"The other {len(others)} slices that came were not ready in the old repository: mark each ready when you have checked it.")
    return {"published_first": published, "marked_ready": done, "already_ready": already, "stopped_at": stopped, "left": left,
            "not_ready_in_source": others,
            "record": str(path.relative_to(studio.project)), "complete": stopped is None, "factory_authorized": False, "note": " ".join(parts)}
