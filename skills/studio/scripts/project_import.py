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
RECORD_RE = re.compile(r"^[0-9a-f]{16}\.json$")
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
CHUNK = 1024 * 1024

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


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(str(path), flags), "rb") as handle:
        for block in iter(lambda: handle.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


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


def _unfinished_record(studio: Any) -> Optional[Dict[str, Any]]:
    return next((data for _, data in _records(studio) if not data.get("finished_at")), None)


def unfinished(studio: Any) -> Optional[Dict[str, Any]]:
    """The import that stopped part way here: {file, archive_sha256, started_at, text}, or None."""
    data = _unfinished_record(studio)
    if data is None:
        return None
    name = str((data.get("archive") or {}).get("file") or "the archive")
    return {"file": name, "archive_sha256": data["archive_sha256"], "started_at": data.get("started_at"),
            "text": f"Bringing in the project from {name} stopped part way. Run it again with the same file to finish."}


def reserved_numbers(studio: Any, kind: str) -> List[int]:
    """The numbers of `kind` (SLICE, EPIC, IDEA, PP, TN, PRD or DES) an unfinished import's map gives out, so every allocator
    skips them until it finishes. Never raises: a record that cannot be read reserves nothing."""
    if kind not in project_ids.PREFIXES:
        return []
    found: Set[int] = set()
    try:
        for _, data in _records(studio):
            if data.get("finished_at"):
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
        day = str(data.get("finished_at") or data.get("started_at") or "")[:10]
        when = f"brought in on {day}" if data.get("finished_at") else f"being brought in since {day}; not finished"
        for old, new in sorted(data["map"].items()):
            if old == ident or new == ident:
                if old == new:
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
        manifest, members = project_archive.read(archive)
    except project_archive.ArchiveError as exc:
        raise refusal(host, str(exc))
    found = Incoming()
    found.path = archive.resolve() if archive.exists() else archive
    found.label = project_archive.shown(archive.name) or "The file"
    try:
        found.sha256 = file_sha256(archive)
    except OSError:
        raise refusal(host, f"There is no file at {project_archive.shown(str(archive))}.")
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
                    problem = map_problem(record, "idea_id", ident)
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
        if set(record) - set(shape.LOOKUP_LIMITS) or any(not isinstance(record.get(key, []), list) for key in shape.LOOKUP_LIMITS):
            raise self.bad("an idea", ident, "its lookups are not in the form Shape writes")
        for key, limit in shape.LOOKUP_LIMITS.items():
            items = record.get(key, [])
            if len(items) > limit or any(not isinstance(item, dict) for item in items):
                raise self.bad("an idea", ident, "its lookups are not in the form Shape writes")
        record = copy.deepcopy(record)
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
                    or not isinstance(meta.get("sections"), list):
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
            entry: Dict[str, Any] = {"meta": meta, "name": meta["file"], "raw": raw, "map": None, "answers": {}}
            if ident in maps:
                record = self.json(maps[ident], what, ident)
                if kind == "PRD":
                    problem = map_problem(record, "prd_id", ident)
                else:
                    record = copy.deepcopy(record)
                    record.pop("published", None)  # the ready folder stays behind (1.2)
                    problem = None if record.get("design_id") == ident and isinstance(record.get("conflicts", []), list) else \
                        "its map is not in the form Product Studio writes"
                if problem:
                    raise self.bad(what, ident, problem)
                entry["map"] = record
            for answer_key, data in sorted(answers.get(ident, {}).items()):
                record = self.json(data, what, ident)
                if record.get("prd_id") != ident or record.get("map_slice") != answer_key or not product.SLICE_RE.fullmatch(str(record.get("slice_id") or "")) \
                        or not isinstance(record.get("answers"), list):
                    raise self.bad(what, ident, f"its answers for {answer_key} are not in the form Product Studio writes")
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
            if slice_id in self.found.slices:
                facts["slices"][slice_id] = {key: value for key, value in (("was", was), ("revision", revision), ("jira", jira),
                                                                           ("request", request), ("note", note)) if value is not None}
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


def map_problem(record: Dict[str, Any], key: str, ident: str) -> Optional[str]:
    """An idea's or a PRD's map, by prd.check_map's rules as far as they apply without the document."""
    if record.get(key) != ident:
        return f"its map's {key} differs from its file"
    slices, epics = record.get("slices"), record.get("epics", [])
    if not isinstance(slices, list) or not slices or not isinstance(epics, list):
        return "its map is not in the form Product Studio writes"
    keys: Set[str] = set()
    for item in list(epics) + list(slices):
        name = item.get("key") if isinstance(item, dict) else None
        if not isinstance(name, str) or not prd.MAP_KEY_RE.fullmatch(name) or prd.ID_LIKE_RE.fullmatch(name) or name in keys:
            return "its map's keys are not in the form Product Studio writes"
        keys.add(name)
    for item in slices:
        if not isinstance(item.get("epic"), str) or not isinstance(item.get("depends_on", []), list) \
                or any(not isinstance(d, str) for d in item.get("depends_on", [])) or not isinstance(item.get("title"), str):
            return "its map's slices are not in the form Product Studio writes"
    applied = record.get("applied", {})
    if applied is not None and (not isinstance(applied, dict) or any(not isinstance(applied.get(g, {}), dict) for g in ("epics", "slices"))
                                or any(not isinstance(v, str) for g in ("epics", "slices") for v in (applied.get(g) or {}).values())):
        return "what its map made is not in the form Product Studio writes"
    if record.get("settled") is not None and not isinstance(record["settled"], dict):
        return "its map's settlements are not in the form Product Studio writes"
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
        raise refusal(host, f"Bringing in {name} stopped part way. Finish it first: run the import again with that file.")
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


def numbering(mode: str, incoming: Dict[str, List[str]], used: Dict[str, Set[int]]) -> Tuple[Dict[str, str], List[str]]:
    """The map (4.3) and, for a new project, why a kind was numbered after all (open point 5)."""
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
    return project_ids.numbering(incoming, first), why


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


def build(host: Any, studio: Any, found: Incoming, mapping: Dict[str, str], mode: str, into: str) -> Built:
    out = Built()
    pid = into if mode == "join" else None
    rules = host.ticket_rules()

    def noted(file: str, notes: Iterable[Dict[str, Any]]) -> None:
        for note in notes:
            row = {"file": file, "line": note.get("line"), "id": note["id"]}
            if note.get("field"):
                row["field"] = note["field"]
            if note["why"] == "in_code":
                out.check_by_hand.append({**row, "why": "inside code in the text; left as written"})
            else:
                out.not_in_archive.append({**row, "why": "not in the archive; left as written"})

    def record(kind: str, data: Dict[str, Any], file: str) -> Dict[str, Any]:
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
            add("documents", map_rel, canonical_bytes(host, record(map_kind, entry["map"], map_rel)), new)
        for key, answers in sorted(entry["answers"].items()):
            answers_rel = rel_document(kind, new, f"answers/{key}.json")
            add("documents", answers_rel, canonical_bytes(host, record("prd_answers", answers, answers_rel)), new)

    # 2. Design mocks, byte for byte, in the renamed slice's folder.
    for ident, pictures in sorted(found.mocks.items()):
        for digest, (ext, data) in sorted(pictures.items()):
            add("mocks", rel_mock(mapping[ident], digest, ext), data, mapping[ident])

    # 3. Ideas: records, lookups, maps, briefs and cases.
    for ident in sorted(found.ideas, key=number):
        new = mapping[ident]
        idea_rel = rel_idea(new, "idea")
        idea = record("idea", found.ideas[ident], idea_rel)
        problems = shape.record_problems(idea, rules)
        if problems:
            raise AssertionError(f"{ident}: {problems[0]}")
        add("ideas", idea_rel, canonical_bytes(host, idea), new)
        if ident in found.lookups:
            rel = rel_idea(new, "lookups")
            add("ideas", rel, canonical_bytes(host, record("lookups", found.lookups[ident], rel)), new)
        if ident in found.idea_maps:
            rel = rel_idea(new, "idea_map")
            add("ideas", rel, canonical_bytes(host, record("idea_map", found.idea_maps[ident], rel)), new)
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
        for item in (record("lookups", found.lookups[ident], rel_idea(new, "lookups")) if ident in found.lookups else {}).get("shipped_rules", []):
            if isinstance(item.get("rule"), str):
                out.shipped_rules.append({"file": rel_idea(new, "lookups"), "line": None, "of": new, "rule": item["rule"], "where": "lookups"})
    # The lookups were rewritten twice above (once to write, once to list rules): keep the notes of one.
    seen_notes: Set[str] = set()
    for group in (out.check_by_hand, out.not_in_archive):
        unique = []
        for row in group:
            key = json.dumps(row, sort_keys=True)
            if key not in seen_notes:
                seen_notes.add(key)
                unique.append(row)
        group[:] = unique

    # 4. The project, for a new project only (placed before the principles and needs, which name it).
    if mode == "new":
        add("project", PROJECT_REL, canonical_bytes(host, record("project", found.project, PROJECT_REL)), found.project_id)

    # 5. Principles and needs, merged by ID when placed.
    if found.principles is not None:
        out.principles = record("principles", found.principles, PRINCIPLES_REL)["principles"]
    if found.needs is not None:
        rewritten = record("needs", found.needs, NEEDS_REL)
        out.needs = rewritten["needs"]
        out.needs_none = list(rewritten["none"]) if mode == "new" else None

    # 6. Epics.
    for ident in sorted(found.epics, key=number):
        new = mapping[ident]
        rel = rel_epic(new)
        epic = record("epic", found.epics[ident], rel)
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
        work = record("slice", found.slices[ident], rel_slice(new))
        work["status"] = "superseded" if work["status"] == "superseded" else "draft"
        work["spec_sha256"] = None
        for key in ("origin", "tracking"):
            work.pop(key, None)
        works[new] = work
        small = work.get("small")
        if isinstance(small, dict) and isinstance(small.get("shipped_rule"), str):
            out.shipped_rules.append({"file": rel_slice(new), "line": None, "of": new, "rule": small["shipped_rule"], "where": "small"})
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


# ---- what the person reads (4.4, 4.7) ----


def here_words(host: Any, studio: Any, ident: str) -> str:
    """What an ID names in the destination as it is before the import, in a person's words."""
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
            how: Optional[Dict[str, Dict[str, Any]]], why: List[str], notes: List[str], numbers: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The fields the plan and the result share (4.4)."""
    facts = found.facts
    slices = []
    for ident in sorted(found.slices, key=number):
        was = facts["slices"].get(ident, {}).get("was")
        status = "superseded" if found.slices[ident]["status"] == "superseded" else "draft"
        slices.append({"from": ident, "to": mapping[ident], "title": found.slices[ident]["title"], "epic": mapping[found.slices[ident]["epic_id"]],
                       "was": was, "was_words": (f"{WAS_WORDS[was]} in the old repository" if was else "not recorded in the archive"),
                       "status_here": status, "revision_there": facts["slices"].get(ident, {}).get("revision")})
    for row in built.not_in_archive:
        row["here"] = here_words(host, studio, row["id"])
    jira = {mapping[i]: key for i, key in found.stripped_jira.items() if prefix(i) == "SLICE"}
    jira.update({mapping[i]: entry["jira"] for i, entry in facts["slices"].items() if entry.get("jira")})
    epic_jira = {mapping[i]: key for i, key in found.stripped_jira.items() if prefix(i) == "EPIC"}
    epic_jira.update({mapping[i]: entry["jira"] for i, entry in facts["epics"].items()})
    requests = {mapping[i]: entry["request"] for i, entry in facts["slices"].items() if entry.get("request")}
    in_force = shipped_here(studio)
    for row in built.shipped_rules:
        row["in_force_here"] = row["rule"] in in_force if in_force is not None else None
    same = same_principles(studio, built.principles) if mode == "join" else []
    principles_in = [item["id"] for item in built.principles]
    needs_in = [item["need_id"] for item in built.needs]
    after: List[str] = []
    if principles_in:
        after.append(f"Publish the principles before any slice can be marked ready: {len(principles_in)} came with the project.")
    if needs_in:
        after.append(f"Publish the technical needs: {len(needs_in)} came with the project.")
    effects = sorted({row["of"] for row in built.shipped_rules if row["where"] == "effects"}, key=number)
    if effects:
        after.append(f"{plural(len(effects), 'slice names', 'slices name')} shipped rules of the old repository under 'Effects on shipped behaviour' "
                     f"({listing(effects)}); each needs those rows answered again here.")
    for row in built.shipped_rules:
        if row["where"] == "small":
            after.append(f"{row['of']} is a small change to {row['rule']}, a rule shipped in the old repository; it is not in force here, "
                         "so the small change needs a rule shipped here, or to become a full slice.")
    others = sorted({row["of"] for row in built.shipped_rules if row["where"] in ("brief", "lookups", "idea_source")}, key=number)
    if others:
        after.append(f"{listing(others)} {'names' if len(others) == 1 else 'name'} shipped rules of the old repository; look them up again here.")
    if built.verdicts_stale:
        after.append(f"The verdict on {listing(built.verdicts_stale)} no longer holds, because renumbering changed the brief's text. "
                     "Record a verdict on the brief as it is now.")
    if built.policy_rows:
        after.append(f"{listing(built.policy_rows)} answered the old organisation's policy packs; they show as answered under other packs "
                     "until answered again here.")
    if jira or epic_jira:
        named = [f"{k} was {v}" for k, v in sorted({**epic_jira, **jira}.items())]
        after.append(f"Jira keys were left behind; link each again if this organisation uses the same Jira ({listing(named[:6])}"
                     f"{' and others' if len(named) > 6 else ''}).")
    if same:
        after.extend(item["words"] for item in same)
    superseded = [row["to"] for row in slices if row["status_here"] == "superseded"]
    numbers_note = prd.numbers_note(numbers, {"slices": list(mapping.values())}).strip() if numbers else ""
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
        "check_by_hand": built.check_by_hand, "not_in_archive": built.not_in_archive,
        "shipped_rules": built.shipped_rules, "same_principles": same, "after": after,
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


def same_principles(studio: Any, incoming: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Incoming principles that say the same as one here (5.4): listed, never merged."""
    coming = {item.get("id") for item in incoming}
    mine = [item for item in _items_of(studio.draft / PRINCIPLES_REL, "principles") if item.get("id") not in coming]
    found = []
    clean = lambda value: re.sub(r"\s+", " ", str(value or "")).strip().lower()  # noqa: E731
    for item in incoming:
        for other in mine:
            if clean(item.get("statement")) and clean(item.get("statement")) == clean(other.get("statement")):
                found.append({"incoming": item["id"], "here": other["id"],
                              "words": f"{item['id']} says the same as {other['id']}; retire one if they are the same."})
    return found


def note_words(found: Incoming, mapping: Dict[str, str], shared: Dict[str, Any], placed: bool) -> str:
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
    if shared["counts"]["principles"]:
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
        built = build(host, studio, found, mapping, mode, into)
        return {"found": found, "record": existing, "mapping": mapping, "mode": mode, "into": into, "built": built, "how": None,
                "why": list(existing.get("why_numbered") or []), "notes": [], "numbers": None}
    mode, into, notes = choose_mode(host, studio, found)
    incoming = incoming_ids(studio, found)
    used, how, numbers = counted(host, studio)
    mapping, why = numbering(mode, incoming, used)
    built = build(host, studio, found, mapping, mode, into)
    return {"found": found, "record": None, "mapping": mapping, "mode": mode, "into": into, "built": built, "how": how,
            "why": why, "notes": notes, "numbers": numbers}


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
    shared = summary(host, studio, found, work["mapping"], work["mode"], work["into"], work["built"], work["how"], work["why"],
                     work["notes"], work["numbers"])
    if work["record"] is None:
        keep_plan(host, studio, found, work["mapping"])
    return {"plan": True, "resuming": work["record"] is not None, **shared, "writes": "nothing",
            "note": note_words(found, work["mapping"], shared, placed=False)}


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
        if record.get("targets") != targets:
            raise host.StudioError("Bringing in stopped part way: this MACH rewrites the archive's files differently from the one that started "
                                   "the import. Run it again with the MACH that started it.")
    else:
        foreign = foreign_file(studio, built, targets)
        if foreign:
            raise refusal(host, stopped_words(host, *foreign))
        studio.ensure_ignored()
        record = new_record(host, found, mapping, mode, into, built, targets, work["why"])
        host.write(record_path, host.canonical(record))  # 1. recorded before anything is placed
    moved = numbers_moved(studio, found.sha256, mapping) if not resuming else []

    # 2. Staging: every file, already rewritten, rebuilt from the archive when it is missing (the rewrite is deterministic).
    try:
        for rel, data in built.files.items():
            target = staging / rel
            if target.is_file() and not target.is_symlink() and sha(target.read_bytes()) == targets[rel]:
                continue
            if (studio.draft / rel).is_file() and not (studio.draft / rel).is_symlink():
                continue  # already placed by an earlier run; placing checks its bytes
            target.parent.mkdir(parents=True, exist_ok=True)
            write_bytes(target, data)
    except OSError as exc:
        raise host.StudioError(stopped_os(exc))

    # 3. Placing, in order, each step looking before it writes.
    placed: Dict[str, int] = {}
    there = 0
    foreign = foreign_file(studio, built, targets)
    if foreign:
        raise host.StudioError(stopped_words(host, *foreign))
    try:
        for step, rels in built.steps:
            if step == "epics":
                there += merge_sets(host, studio, built, mode, into, placed)
            for rel in rels:
                done = place_one(host, studio, staging, rel, targets[rel], built.owners[rel])
                if done:
                    placed[step] = placed.get(step, 0) + 1
                else:
                    there += 1
        if not any(step == "epics" for step, _ in built.steps):
            there += merge_sets(host, studio, built, mode, into, placed)
        there += place_order(studio, built, placed)
        there += place_notes(host, studio, built, placed)
    except OSError as exc:
        raise host.StudioError(stopped_os(exc))

    # 4. Finished: the check once more, the record kept, staging removed.
    after = product.validate_workspace(studio.draft)
    introduced = [error for error in after["errors"] if error not in before]
    record = dict(record)
    record["finished_at"] = host.now(None)
    record["structural_errors"] = introduced
    host.write(record_path, host.canonical(record))
    shutil.rmtree(str(staging.parent), ignore_errors=True)
    with_plan = plan_path(studio, found.sha256)
    if with_plan.is_file() and not with_plan.is_symlink():
        with_plan.unlink()

    shared = summary(host, studio, found, mapping, mode, into, built, work["how"], work["why"], work["notes"], work["numbers"])
    note = note_words(found, mapping, shared, placed=True)
    if moved:
        note += " The numbers moved since the plan: " + "; ".join(f"{row['id']} was to be {row['planned']} and is {row['now']}" for row in moved) + "."
    if introduced:
        note += f" The workspace has {plural(len(introduced), 'problem')} it did not have before; the files stay as they are: " + "; ".join(introduced[:3]) + "."
    return {"imported": True, "resumed": resuming, **shared, "placed": placed, "already_there": there, "structural_errors": introduced,
            "numbers_moved": moved, "record": str(record_path.relative_to(studio.project)), "note": note}


def write_bytes(path: Path, data: bytes) -> None:
    temporary = path.with_name(path.name + ".tmp")
    with open(str(temporary), "wb") as handle:
        handle.write(data)
    os.replace(str(temporary), str(path))


def new_record(host: Any, found: Incoming, mapping: Dict[str, str], mode: str, into: str, built: Built, targets: Dict[str, str],
               why: List[str]) -> Dict[str, Any]:
    facts = found.facts
    return {
        "schema_version": SCHEMA_VERSION, "archive_sha256": found.sha256,
        "archive": {"file": found.label, "path": str(found.path), "exported_at": found.manifest.get("exported_at"),
                    "mach_version": found.manifest.get("mach_version")},
        "mode": mode, "from_project": found.project_id, "from_project_name": found.name, "into_project": into,
        "started_at": host.now(None), "finished_at": None, "map": mapping, "why_numbered": why, "targets": targets,
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


def stopped_words(host: Any, ident: str, rel: str) -> str:
    kind = prefix(ident)
    noun = NOUNS.get(kind, "file")
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


def foreign_file(studio: Any, built: Built, targets: Dict[str, str]) -> Optional[Tuple[str, str]]:
    """The first file here that holds one of the new IDs and is not exactly what this import writes: (ID, file)."""
    for rel, digest in targets.items():
        target = studio.draft / rel
        if not _within_draft(studio, target) or target.is_symlink():
            return built.owners[rel], rel
        if target.exists() and (not target.is_file() or sha(target.read_bytes()) != digest):
            return built.owners[rel], rel
    specs = {rel for rel in targets if rel.startswith("specs/slices/")}
    for rel in sorted(specs):
        owner = built.owners[rel]
        for other in sorted((studio.draft / "specs" / "slices").glob(f"{owner}-*.md")):
            relative = studio.relative(other)
            if relative not in targets and product.SPEC_NAME_RE.fullmatch(other.name):
                return owner, relative
    folders = {}
    for rel, owner in built.owners.items():
        if rel.startswith(("product/mocks/", "product/prds/", "product/designs/")):
            folders["/".join(rel.split("/")[:3])] = owner
    for folder, owner in sorted(folders.items()):
        path = studio.draft / folder
        if path.is_symlink():
            return owner, folder
        if path.is_dir():
            for item in sorted(path.rglob("*")):
                relative = studio.relative(item)
                if item.is_file() and relative not in targets:
                    return owner, relative
    return None


def place_one(host: Any, studio: Any, staging: Path, rel: str, digest: str, owner: str) -> bool:
    """Place one file; False when it is already there with exactly these bytes. Stops when something else holds its place."""
    target = studio.draft / rel
    if not _within_draft(studio, target) or target.is_symlink():
        raise host.StudioError(stopped_words(host, owner, rel))
    if target.exists():
        if target.is_file() and sha(target.read_bytes()) == digest:
            return False
        raise host.StudioError(stopped_words(host, owner, rel))
    source = staging / rel
    if source.is_symlink() or not source.is_file() or sha(source.read_bytes()) != digest:
        raise host.StudioError("Bringing in stopped part way: a staged file is missing or changed. Run it again with the same file; "
                               "nothing already brought in is repeated.")
    target.parent.mkdir(parents=True, exist_ok=True)
    _place(source, target)
    return True


def merge_sets(host: Any, studio: Any, built: Built, mode: str, into: str, placed: Dict[str, int]) -> int:
    """The principles and needs, added by ID to what is here and written whole (Studio.save_product_file). An item already here
    with the same content is skipped; one with other content stops. Returns how many were already there."""
    rules = host.ticket_rules()
    there = 0
    for kind, rel, key, list_key, items in (("PP", PRINCIPLES_REL, "id", "principles", built.principles),
                                            ("TN", NEEDS_REL, "need_id", "needs", built.needs)):
        if not items:
            continue
        path = studio.draft / rel
        current: Dict[str, Any] = {}
        if path.is_file() and not path.is_symlink():
            current = json.loads(path.read_text(encoding="utf-8"))
        mine = {item[key]: item for item in current.get(list_key) or []}
        added = 0
        for item in items:
            have = mine.get(item[key])
            if have is None:
                mine[item[key]] = item
                added += 1
            elif have == item:
                there += 1
            else:
                raise host.StudioError(stopped_words(host, item[key], rel))
        if not added:
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
        placed["principles" if kind == "PP" else "needs"] = placed.get("principles" if kind == "PP" else "needs", 0) + added
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
