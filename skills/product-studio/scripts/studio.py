#!/usr/bin/env python3
"""MACH Product Studio: every deterministic operation a product manager's session needs.

A PM defines a project and its epics, interviews one slice at a time, and approves slices and
delivery waves. All of it happens in a draft workspace, .factory/studio/draft/, which mirrors
the repository layout:

    product/project.json            product/epics/EPIC-NNN.json
    product/slices/SLICE-NNN.json   product/intents/SLICE-NNN.md
    product/delivery-waves/WAVE-NNN.json
    specs/slices/SLICE-NNN-name.md

The workspace is git-ignored and machine-local. Nothing here creates a ticket, a cell or a
branch, commits, pushes, or starts any Factory work: publishing is a later milestone, and
approval here is product approval only.

The slice spec is judged by the intent skill's validate_slice.py, and slice IDs come from the
intent skill's allocator (cell.py slice_ids). This script never reimplements either.

Standard library only. Prints JSON; refuses with "refused: ..." on stderr and exit code 1.
"""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

SKILL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import product  # noqa: E402


class StudioError(Exception):
    """A problem the caller can fix; printed without a traceback."""


def sibling(name: str) -> Path:
    """Another MACH skill's folder, whichever way MACH is installed."""
    for candidate in (SKILL_DIR.parent / f"mach-{name}", SKILL_DIR.parent / name):
        if candidate.is_dir():
            return candidate
    raise StudioError(f"The MACH {name} skill is not installed next to this one ({SKILL_DIR.parent}). Product Studio needs its validator.")


def intent_modules():
    """The intent skill's cell.py and validate_slice.py: the allocator and the spec validator."""
    scripts = str(sibling("intent") / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import cell  # noqa: E402
    import validate_slice  # noqa: E402
    return cell, validate_slice


KINDS = {
    "epic": ("epics", "EPIC", product.EPIC_RE, "epic_id"),
    "slice": ("slices", "SLICE", product.SLICE_RE, "slice_id"),
    "wave": ("delivery-waves", "WAVE", product.WAVE_RE, "wave_id"),
}
TRACKED = ("product/project.json", "product/epics/EPIC-*.json", "product/slices/SLICE-*.json",
           "product/intents/SLICE-*.md", "product/delivery-waves/WAVE-*.json", "specs/slices/SLICE-*.md")
IGNORE_LINE = ".factory/studio/"
EDITABLE_SLICE = ("draft", "interviewing", "ready_for_approval")
NOT_YET = "is not available yet: publishing and synchronising product work arrive with the next milestone. Nothing was sent."


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(data: Dict[str, Any]) -> str:
    """One byte form for every artifact, so the terminal and any other client write identical files."""
    return json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(str(temporary), str(path))


class Studio:
    def __init__(self, project: Path):
        self.cell, self.validate_slice = intent_modules()
        self.project = project
        self.home = project / ".factory" / "studio"
        self.draft = self.home / "draft"
        self.session_path = self.home / "session.json"
        for folder in (project / ".factory", self.home, self.draft):
            if folder.is_symlink():
                raise StudioError(f"{folder} is a symbolic link. Product Studio only works in a real folder inside the project.")

    # ---- workspace ----

    def session(self) -> Dict[str, Any]:
        try:
            data = json.loads(self.session_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        data.setdefault("schema_version", 1)
        data.setdefault("baseline", {})
        data.setdefault("notes", {})
        data.setdefault("current_slice", None)
        return data

    def save_session(self, data: Dict[str, Any]) -> None:
        write(self.session_path, canonical(data))

    def ensure_ignored(self) -> None:
        """Keep the workspace out of `git status` so drafts never dirty the main checkout."""
        git = self.cell.git
        if git(["rev-parse", "--is-inside-work-tree"], self.project).returncode != 0:
            return
        if git(["check-ignore", "-q", ".factory/studio/probe"], self.project).returncode == 0:
            return
        common = git(["rev-parse", "--git-common-dir"], self.project).stdout.strip()
        if not common:
            return
        exclude = (self.project / common).resolve() / "info" / "exclude"
        exclude.parent.mkdir(parents=True, exist_ok=True)
        existing = exclude.read_text(encoding="utf-8") if exclude.is_file() else ""
        if IGNORE_LINE not in existing.splitlines():
            with exclude.open("a", encoding="utf-8") as handle:
                handle.write(("" if existing.endswith("\n") or not existing else "\n") + IGNORE_LINE + "\n")

    def baseline_files(self) -> Dict[str, Path]:
        found: Dict[str, Path] = {}
        for pattern in TRACKED:
            for path in sorted(self.project.glob(pattern)):
                if path.is_file() and not path.is_symlink():
                    found[path.relative_to(self.project).as_posix()] = path
        return found

    def sync(self) -> Dict[str, List[str]]:
        """Bring the approved baseline (the main checkout) into the workspace without touching drafts.

        A file the PM has not edited follows the baseline. A file the PM has edited is left alone;
        if the baseline changed underneath it, or a different artifact now holds its name, it is
        reported so the PM can reconcile it. Nothing is ever written outside the workspace.
        """
        for folder in (self.draft / "specs" / "slices", self.draft / "product" / "intents"):
            folder.mkdir(parents=True, exist_ok=True)
        self.ensure_ignored()
        session = self.session()
        known: Dict[str, str] = session["baseline"]
        report: Dict[str, List[str]] = {"conflicts": [], "collisions": []}
        current = self.baseline_files()
        for relative, source in current.items():
            data = source.read_bytes()
            target = self.draft / relative
            if not target.exists():
                if relative in known and known[relative] == sha(data):
                    continue  # the PM removed their copy on purpose; nothing new upstream
                write(target, data.decode("utf-8", errors="replace"))
                known[relative] = sha(data)
            elif relative not in known:
                if sha(target.read_bytes()) == sha(data):
                    known[relative] = sha(data)
                else:
                    report["collisions"].append(relative)
            elif sha(target.read_bytes()) == known[relative]:
                if known[relative] != sha(data):
                    write(target, data.decode("utf-8", errors="replace"))
                    known[relative] = sha(data)
            elif known[relative] != sha(data):
                report["conflicts"].append(relative)
        if session != self.session():
            self.save_session(session)
        return report

    # ---- artifacts ----

    def path(self, kind: str, identifier: Optional[str] = None) -> Path:
        if kind == "project":
            return self.draft / "product" / "project.json"
        folder, _, rule, _ = KINDS[kind]
        if not isinstance(identifier, str) or not rule.fullmatch(identifier):
            raise StudioError(f"'{identifier}' is not a usable {kind} ID, such as {KINDS[kind][1]}-001.")
        return self.draft / "product" / folder / f"{identifier}.json"

    def load(self, kind: str, identifier: Optional[str] = None) -> Dict[str, Any]:
        path = self.path(kind, identifier)
        if not path.is_file():
            what = "No project yet. Run: studio.py project init" if kind == "project" else f"No {kind} {identifier}."
            raise StudioError(what)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise StudioError(f"{path}: cannot read: {exc}")
        if not isinstance(data, dict):
            raise StudioError(f"{path}: expected a JSON object.")
        return data

    def save(self, kind: str, data: Dict[str, Any], bump: bool = True) -> bool:
        """Write an artifact if it changed. A changed artifact gets the next revision."""
        path = self.path(kind, None if kind == "project" else data[KINDS[kind][3]])
        before = path.read_text(encoding="utf-8") if path.is_file() else None
        if before is not None and canonical(data) == before:
            return False
        if bump and before is not None:
            data["revision"] = int(data.get("revision") or 0) + 1
        write(path, canonical(data))
        return True

    def all(self, kind: str) -> Dict[str, Dict[str, Any]]:
        folder, prefix, rule, key = KINDS[kind]
        found: Dict[str, Dict[str, Any]] = {}
        for path in sorted((self.draft / "product" / folder).glob(f"{prefix}-*.json")):
            if rule.fullmatch(path.stem):
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    data = {}
                found[path.stem] = data if isinstance(data, dict) else {}
        return found

    def next_id(self, kind: str) -> str:
        if kind == "slice":
            used, reserved = self.cell.slice_ids(self.project)
            return f"SLICE-{max([0, *used, *reserved]) + 1:03d}"
        folder, prefix, rule, _ = KINDS[kind]
        numbers = [0]
        for root in (self.project, self.draft):
            for path in (root / "product" / folder).glob(f"{prefix}-*.json"):
                if rule.fullmatch(path.stem):
                    numbers.append(int(path.stem.split("-")[1]))
        return f"{prefix}-{max(numbers) + 1:03d}"

    def project_id(self) -> str:
        return self.load("project")["project_id"]

    def spec_of(self, slice_id: str) -> Optional[Path]:
        matches = sorted((self.draft / "specs" / "slices").glob(f"{slice_id}-*.md"))
        matches = [p for p in matches if product.SPEC_NAME_RE.fullmatch(p.name) and not p.is_symlink()]
        if len(matches) > 1:
            raise StudioError(f"{slice_id} has more than one spec file: {', '.join(p.name for p in matches)}. Keep one.")
        return matches[0] if matches else None

    def intent_path(self, slice_id: str) -> Path:
        return self.draft / "product" / "intents" / f"{slice_id}.md"

    def relative(self, path: Path) -> str:
        return path.relative_to(self.draft).as_posix()

    def structural(self) -> Dict[str, Any]:
        return product.validate_workspace(self.draft)

    def commit_or_restore(self, changes: Sequence[Tuple[str, Dict[str, Any]]], what: str) -> None:
        """Apply several artifact changes, then check the whole workspace. If the result is not
        structurally valid, put every file back and refuse."""
        saved = []
        for kind, data in changes:
            path = self.path(kind, None if kind == "project" else data[KINDS[kind][3]])
            saved.append((path, path.read_text(encoding="utf-8") if path.is_file() else None))
            self.save(kind, data)
        report = self.structural()
        if not report["valid"]:
            for path, text in saved:
                if text is None:
                    path.unlink()
                else:
                    write(path, text)
            raise StudioError(f"{what} would leave the product artifacts inconsistent, so nothing was changed:\n  " + "\n  ".join(report["errors"]))

    # ---- slice checks ----

    def analyze(self, spec: Path, ready: bool) -> Tuple[List[Any], Dict[str, Any]]:
        """The intent skill's validator, with every folder that shares the slice ID space."""
        others = self.validate_slice.sibling_specs(spec, self.cell.registries(self.project, own=spec.parent))
        return self.validate_slice.analyze(spec.read_text(encoding="utf-8-sig"), spec.name, others, ready=ready)

    def check_slice(self, slice_id: str, ready: bool) -> Dict[str, Any]:
        work = self.load("slice", slice_id)
        spec = self.spec_of(slice_id)
        result: Dict[str, Any] = {"slice_id": slice_id, "spec": None, "errors": [], "warnings": [], "open_questions": [], "intent_problems": []}
        if spec is None:
            result["errors"].append(f"No spec yet. Write it to {self.draft / 'specs' / 'slices'}/{slice_id}-<short-name>.md")
        else:
            result["spec"] = str(spec)
            findings, model = self.analyze(spec, ready)
            for finding in findings:
                line = f"{spec.name}:{finding.line}: " if finding.line else f"{spec.name}: "
                text = f"{line}{finding.message} [{finding.rule}]"
                if finding.rule == "open-questions":
                    continue
                (result["errors"] if finding.severity == "error" else result["warnings"]).append(text)
            if model.get("slice_id") and model.get("slice_id") != slice_id:
                result["errors"].append(f"{spec.name}: the spec's title names {model.get('slice_id')}, not {slice_id}.")
            result["open_questions"] = [self.question_text(q) for q in (model.get("open_questions") or [])]
            result["counts"] = {
                "invariants": len(model.get("invariants") or []),
                "functional_requirements": len(model.get("functional_requirements") or []),
                "matrix_rules": len((model.get("decision_matrix") or {}).get("rules") or []),
                "scenarios": len(model.get("scenarios") or []),
            }
            result["title"] = model.get("title")
        problems, intent = self.cell.check_intent(self.intent_path(slice_id), header_fields=("Slice", "Status"))
        result["intent_problems"] = [p.replace("assets/intent-template.md before finalizing", "the intent template before approving") for p in problems]
        result["risk"] = intent.get("risk")
        result["ready"] = not (result["errors"] or result["open_questions"] or result["intent_problems"])
        return result

    @staticmethod
    def question_text(item: Any) -> str:
        if isinstance(item, dict):
            for key in ("text", "question", "title"):
                if isinstance(item.get(key), str) and item[key].strip():
                    return item[key].strip()
            return json.dumps(item, sort_keys=True, ensure_ascii=False)
        return str(item).strip() or "(unnamed open question)"


# ---- commands ----


def emit(data: Dict[str, Any]) -> int:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def now(at: Optional[str]) -> str:
    if at:
        if not product._is_timestamp(at):
            raise StudioError(f"'{at}' is not a date-time such as 2026-11-10T14:00:00Z.")
        return at
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def actor(studio: Studio, given: Optional[str]) -> str:
    if given and given.strip():
        return given.strip()
    git = studio.cell.git
    name = git(["config", "user.name"], studio.project).stdout.strip()
    email = git(["config", "user.email"], studio.project).stdout.strip()
    if not name:
        raise StudioError("Cannot tell who is approving: Git has no user.name configured here. Pass --actor \"Your Name\".")
    return f"{name} <{email}>" if email else name


def cmd_where(studio: Studio, args: argparse.Namespace) -> int:
    intent = sibling("intent")
    return emit({
        "project": str(studio.project),
        "workspace": str(studio.draft),
        "specs_dir": str(studio.draft / "specs" / "slices"),
        "interview_method": str(intent / "references" / "interview-method.md"),
        "slice_template": str(intent / "assets" / "slice-template.md"),
        "spec_rules": [str(intent / "references" / name) for name in ("spec-structure.md", "ears-syntax.md", "acceptance-matrices.md")],
        "intent_template": str(SKILL_DIR / "assets" / "intent-template.md"),
        "is_git_repository": studio.cell.git(["rev-parse", "--is-inside-work-tree"], studio.project).returncode == 0,
    })


def describe(studio: Studio, sync: Dict[str, List[str]]) -> Dict[str, Any]:
    session = studio.session()
    project_path = studio.path("project")
    project = studio.load("project") if project_path.is_file() else None
    epics, slices, waves = studio.all("epic"), studio.all("slice"), studio.all("wave")
    baseline = studio.baseline_files()
    known = session["baseline"]

    def source(relative: str) -> str:
        target = studio.draft / relative
        if relative in sync["collisions"]:
            return "collision"
        if relative in sync["conflicts"]:
            return "conflict"
        if relative in baseline and relative in known and target.is_file() and sha(target.read_bytes()) == known[relative]:
            return "published"
        return "draft"

    slice_rows = []
    for slice_id, data in slices.items():
        spec = studio.spec_of(slice_id)
        slice_rows.append({
            "slice_id": slice_id, "title": data.get("title"), "epic_id": data.get("epic_id"), "status": data.get("status"),
            "revision": data.get("revision"), "open_questions": len(data.get("open_questions") or []),
            "spec": studio.relative(spec) if spec else None, "has_intent": studio.intent_path(slice_id).is_file(),
            "source": source(f"product/slices/{slice_id}.json"), "resume_note": (session["notes"].get(slice_id) or {}).get("note"),
        })
    structural = studio.structural() if project else None
    suggestions: List[str] = []
    if not project:
        suggestions.append("Define the project: its name, vision and outcomes (project init).")
    elif not epics:
        suggestions.append("Add the first epic (epic add).")
    else:
        for row in slice_rows:
            if row["status"] in ("draft", "interviewing"):
                suggestions.append(f"Continue the interview for {row['slice_id']}: {row['title']} (slice resume {row['slice_id']}).")
            elif row["status"] == "ready_for_approval":
                suggestions.append(f"{row['slice_id']} is ready: approve it (slice approve {row['slice_id']}).")
        for epic_id, data in epics.items():
            if data.get("status") == "proposed":
                suggestions.append(f"Approve epic {epic_id}: {data.get('title')} (epic approve {epic_id}), so its slices can be approved.")
        waved = {sid for data in waves.values() for sid in (data.get("slices") or []) if data.get("status") != "superseded"}
        loose = [row["slice_id"] for row in slice_rows if row["status"] == "approved_for_engineering" and row["slice_id"] not in waved]
        if loose:
            suggestions.append(f"Put approved slices into a delivery wave: {', '.join(loose)} (wave new).")
        for wave_id, data in waves.items():
            if data.get("status") == "draft" and data.get("slices") and all((slices.get(s) or {}).get("status") == "approved_for_engineering" for s in data["slices"]):
                suggestions.append(f"{wave_id} holds only approved slices: approve it (wave approve {wave_id}).")
        if not any(row["status"] in EDITABLE_SLICE for row in slice_rows):
            suggestions.append("Start a new slice (slice new --epic EPIC-NNN --title \"...\").")
    return {
        "project": project and {key: project.get(key) for key in ("project_id", "name", "status", "revision", "vision", "outcomes")},
        "epics": [{"epic_id": key, "title": data.get("title"), "status": data.get("status"), "revision": data.get("revision"),
                   "source": source(f"product/epics/{key}.json")} for key, data in epics.items()],
        "slices": slice_rows,
        "waves": [{"wave_id": key, "status": data.get("status"), "revision": data.get("revision"), "slices": data.get("slices"),
                   "approval": data.get("approval"), "source": source(f"product/delivery-waves/{key}.json")} for key, data in waves.items()],
        "current_slice": session.get("current_slice"),
        "needs_reconciling": sync,
        "structurally_valid": structural["valid"] if structural else None,
        "structural_errors": structural["errors"] if structural else [],
        "factory_authorized": False,
        "suggested_next": suggestions,
    }


def cmd_status(studio: Studio, args: argparse.Namespace) -> int:
    return emit(describe(studio, studio.sync()))


def cmd_validate(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    report = studio.structural()
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["valid"] else 1


def clean_list(values: Optional[Sequence[str]], what: str) -> List[str]:
    items = [value.strip() for value in (values or [])]
    if any(not item for item in items):
        raise StudioError(f"An empty {what} was given.")
    return items


def cmd_project_init(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    if studio.path("project").is_file():
        raise StudioError("This project is already defined. Change it with: studio.py project set")
    if not product.PROJECT_RE.fullmatch(args.id):
        raise StudioError(f"'{args.id}' is not a usable project ID. Use lowercase letters, digits and hyphens, starting with a letter, such as campaign-platform.")
    data = {"schema_version": 1, "project_id": args.id, "name": args.name.strip(), "revision": 1, "status": "draft",
            "vision": args.vision.strip(), "outcomes": clean_list(args.outcome, "outcome")}
    if not data["outcomes"]:
        raise StudioError("A project needs at least one outcome (--outcome, repeatable).")
    studio.commit_or_restore([("project", data)], "Defining the project")
    return emit({"project": data, "path": str(studio.path("project"))})


def cmd_project_set(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    data = studio.load("project")
    if args.name is not None:
        data["name"] = args.name.strip()
    if args.vision is not None:
        data["vision"] = args.vision.strip()
    if args.outcome:
        data["outcomes"] = clean_list(args.outcome, "outcome")
    if args.status is not None:
        data["status"] = args.status
    studio.commit_or_restore([("project", data)], "Changing the project")
    return emit({"project": studio.load("project")})


def cmd_epic_add(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    data = {"schema_version": 1, "epic_id": studio.next_id("epic"), "project_id": studio.project_id(), "revision": 1,
            "title": args.title.strip(), "status": "proposed", "acceptance_criteria": clean_list(args.criterion, "acceptance criterion")}
    studio.commit_or_restore([("epic", data)], "Adding the epic")
    return emit({"epic": data})


def cmd_epic_set(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    data = studio.load("epic", args.epic_id)
    if args.title is not None:
        data["title"] = args.title.strip()
    if args.criterion:
        data["acceptance_criteria"] = clean_list(args.criterion, "acceptance criterion")
    if args.status is not None:
        data["status"] = args.status
    studio.commit_or_restore([("epic", data)], "Changing the epic")
    return emit({"epic": studio.load("epic", args.epic_id)})


def cmd_epic_approve(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    data = studio.load("epic", args.epic_id)
    if data.get("status") not in ("proposed", "deferred", "approved"):
        raise StudioError(f"{args.epic_id} is {data.get('status')}; only a proposed or deferred epic can be approved.")
    if not data.get("acceptance_criteria"):
        raise StudioError(f"{args.epic_id} has no acceptance criteria. Add at least one before approving (epic set {args.epic_id} --criterion \"...\").")
    data["status"] = "approved"
    studio.commit_or_restore([("epic", data)], "Approving the epic")
    return emit({"epic": studio.load("epic", args.epic_id)})


def slice_paths(studio: Studio, slice_id: str) -> Dict[str, Any]:
    spec = studio.spec_of(slice_id)
    return {
        "work_order": str(studio.path("slice", slice_id)),
        "specs_dir": str(studio.draft / "specs" / "slices"),
        "spec": str(spec) if spec else None,
        "spec_name_pattern": f"{slice_id}-<lowercase-kebab-name>.md",
        "intent_path": str(studio.intent_path(slice_id)),
    }


def reserved_ids(studio: Studio) -> Dict[str, Any]:
    used, reserved = studio.cell.slice_ids(studio.project)
    highest = max([0, *used, *reserved])
    return {
        "next": [f"SLICE-{highest + offset:03d}" for offset in range(1, 7)],
        "reserved_without_spec": [{"id": f"SLICE-{number:03d}", **entry} for number in sorted(reserved) if number not in used for entry in reserved[number]],
    }


def cmd_slice_new(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    epic = studio.load("epic", args.epic)
    if epic.get("status") in ("completed", "superseded"):
        raise StudioError(f"{args.epic} is {epic.get('status')}; a new slice needs an open epic.")
    if args.id:
        if not product.SLICE_RE.fullmatch(args.id):
            raise StudioError(f"'{args.id}' is not a usable slice ID, such as SLICE-004.")
        number = int(args.id.split("-")[1])
        used, reserved = studio.cell.slice_ids(studio.project)
        if number in used:
            raise StudioError(f"{args.id} is already taken by {used[number]}.")
        if number not in reserved:
            raise StudioError(f"{args.id} is not a reserved ID. Leave --id out to take the next free one; pass it only to pick up an ID an earlier spec deferred this feature to.")
        slice_id = args.id
    else:
        slice_id = studio.next_id("slice")
    data = {"schema_version": 1, "slice_id": slice_id, "project_id": studio.project_id(), "epic_id": args.epic, "revision": 1,
            "title": args.title.strip(), "status": "draft", "dependencies": clean_list(args.depends_on, "dependency"),
            "open_questions": [], "spec_path": None, "spec_sha256": None}
    studio.commit_or_restore([("slice", data)], "Starting the slice")
    session = studio.session()
    session["current_slice"] = slice_id
    studio.save_session(session)
    return emit({"slice": data, **slice_paths(studio, slice_id), "ids": reserved_ids(studio)})


def require_editable(studio: Studio, slice_id: str) -> Dict[str, Any]:
    data = studio.load("slice", slice_id)
    if data.get("status") not in EDITABLE_SLICE:
        raise StudioError(f"{slice_id} is {data.get('status')}. To change an approved slice, reopen it first: studio.py slice reopen {slice_id}")
    return data


def cmd_slice_set(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    data = require_editable(studio, args.slice_id)
    if args.title is not None:
        data["title"] = args.title.strip()
    if args.epic is not None:
        studio.load("epic", args.epic)
        data["epic_id"] = args.epic
    if args.depends_on is not None:
        data["dependencies"] = [] if args.depends_on == ["none"] else clean_list(args.depends_on, "dependency")
    studio.commit_or_restore([("slice", data)], "Changing the slice")
    return emit({"slice": studio.load("slice", args.slice_id)})


def cmd_slice_resume(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    session = studio.session()
    slice_id = args.slice_id or session.get("current_slice")
    if not slice_id:
        open_ones = [key for key, data in studio.all("slice").items() if data.get("status") in EDITABLE_SLICE]
        if len(open_ones) != 1:
            raise StudioError("Say which slice to continue. Unfinished slices: " + (", ".join(open_ones) or "none") + ".")
        slice_id = open_ones[0]
    data = require_editable(studio, slice_id)
    if data.get("status") == "draft":
        data["status"] = "interviewing"
        studio.save("slice", data, bump=False)
    session["current_slice"] = slice_id
    studio.save_session(session)
    check = studio.check_slice(slice_id, ready=False) if studio.spec_of(slice_id) else None
    return emit({
        "slice": studio.load("slice", slice_id), **slice_paths(studio, slice_id),
        "resume_note": (session["notes"].get(slice_id) or {}).get("note"),
        "open_questions": data.get("open_questions") or [],
        "check": check, "ids": reserved_ids(studio),
    })


def cmd_slice_pause(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    require_editable(studio, args.slice_id)
    session = studio.session()
    session["notes"][args.slice_id] = {"note": args.note.strip(), "saved_at": now(None)}
    studio.save_session(session)
    return emit({"slice_id": args.slice_id, "saved": True, "resume_with": f"studio.py slice resume {args.slice_id}"})


def cmd_slice_check(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    data = require_editable(studio, args.slice_id)
    result = studio.check_slice(args.slice_id, ready=args.ready)
    # Bookkeeping the validator decides: the open questions, where the spec is, and whether it is ready.
    spec = studio.spec_of(args.slice_id)
    data["open_questions"] = result["open_questions"]
    data["spec_path"] = studio.relative(spec) if spec else None
    data["spec_sha256"] = None
    data["status"] = "ready_for_approval" if result["ready"] else "interviewing"
    studio.save("slice", data, bump=False)
    result["status"] = data["status"]
    print(json.dumps(result, indent=2, ensure_ascii=False))
    blocking = result["errors"] or result["intent_problems"] or (args.ready and result["open_questions"])
    return 1 if blocking else 0


def cmd_slice_approve(studio: Studio, args: argparse.Namespace) -> int:
    sync = studio.sync()
    data = require_editable(studio, args.slice_id)
    slice_id = args.slice_id
    work_order = f"product/slices/{slice_id}.json"
    if work_order in sync["collisions"]:
        raise StudioError(f"{slice_id} now exists in the shared project as a different slice, so this draft cannot keep that number. "
                          "It has to be renumbered before it can be approved; renumbering arrives with the publishing milestone.")
    if work_order in sync["conflicts"]:
        raise StudioError(f"{slice_id} changed in the shared project while you were editing it. Reconcile the two versions before approving.")
    result = studio.check_slice(slice_id, ready=True)
    problems = list(result["errors"]) + list(result["intent_problems"])
    problems += [f"open question: {question}" for question in result["open_questions"]]
    epic = studio.all("epic").get(data.get("epic_id"))
    if not epic:
        problems.append(f"epic {data.get('epic_id')} does not exist")
    elif epic.get("status") != "approved":
        problems.append(f"epic {data.get('epic_id')} is {epic.get('status')}, not approved (studio.py epic approve {data.get('epic_id')})")
    slices = studio.all("slice")
    for dependency in data.get("dependencies") or []:
        if dependency not in slices:
            problems.append(f"dependency {dependency} does not exist")
    if problems:
        raise StudioError(f"{slice_id} cannot be approved yet:\n  " + "\n  ".join(problems))
    spec = studio.spec_of(slice_id)
    data.update({"status": "approved_for_engineering", "open_questions": [],
                 "spec_path": studio.relative(spec), "spec_sha256": sha(spec.read_bytes())})
    studio.commit_or_restore([("slice", data)], f"Approving {slice_id}")
    return emit({"approved": True, "slice": studio.load("slice", slice_id), "risk": result.get("risk"), "counts": result.get("counts"),
                 "warnings": result["warnings"], "factory_authorized": False,
                 "note": "Product approval only. Nothing has been sent to engineering and no work has started."})


def cmd_slice_reopen(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    data = studio.load("slice", args.slice_id)
    if data.get("status") != "approved_for_engineering":
        raise StudioError(f"{args.slice_id} is {data.get('status')}; only an approved slice can be reopened.")
    data.update({"status": "interviewing", "spec_sha256": None})
    changes: List[Tuple[str, Dict[str, Any]]] = [("slice", data)]
    withdrawn = []
    for wave_id, wave in studio.all("wave").items():
        if args.slice_id in (wave.get("slices") or []) and wave.get("status") == "approved_for_engineering":
            wave.update({"status": "draft", "approval": None})
            changes.append(("wave", wave))
            withdrawn.append(wave_id)
    studio.commit_or_restore(changes, f"Reopening {args.slice_id}")
    return emit({"reopened": True, "slice": studio.load("slice", args.slice_id), "waves_returned_to_draft": withdrawn})


def editable_wave(studio: Studio, wave_id: str) -> Dict[str, Any]:
    data = studio.load("wave", wave_id)
    if data.get("status") != "draft":
        raise StudioError(f"{wave_id} is {data.get('status')}. Only a draft wave can be changed; start a new wave instead.")
    return data


def check_wave_slices(studio: Studio, slice_ids: Sequence[str]) -> None:
    slices = studio.all("slice")
    missing = [sid for sid in slice_ids if sid not in slices]
    if missing:
        raise StudioError("No such slice: " + ", ".join(missing) + ".")


def cmd_wave_new(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    slice_ids = list(dict.fromkeys(clean_list(args.slice, "slice")))
    if not slice_ids:
        raise StudioError("A delivery wave needs at least one slice (--slice SLICE-NNN, repeatable).")
    check_wave_slices(studio, slice_ids)
    project = studio.load("project")
    data = {"schema_version": 1, "wave_id": studio.next_id("wave"), "project_id": project["project_id"], "revision": 1,
            "base_project_revision": project["revision"], "status": "draft", "slices": slice_ids, "approval": None}
    studio.commit_or_restore([("wave", data)], "Creating the delivery wave")
    return emit({"wave": data})


def cmd_wave_add(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    data = editable_wave(studio, args.wave_id)
    check_wave_slices(studio, args.slice_ids)
    data["slices"] = list(dict.fromkeys([*data.get("slices", []), *args.slice_ids]))
    studio.commit_or_restore([("wave", data)], "Changing the delivery wave")
    return emit({"wave": studio.load("wave", args.wave_id)})


def cmd_wave_remove(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    data = editable_wave(studio, args.wave_id)
    remaining = [sid for sid in data.get("slices", []) if sid not in args.slice_ids]
    if not remaining:
        raise StudioError(f"That would leave {args.wave_id} empty. A delivery wave needs at least one slice.")
    data["slices"] = remaining
    studio.commit_or_restore([("wave", data)], "Changing the delivery wave")
    return emit({"wave": studio.load("wave", args.wave_id)})


def cmd_wave_approve(studio: Studio, args: argparse.Namespace) -> int:
    sync = studio.sync()
    data = editable_wave(studio, args.wave_id)
    slices = studio.all("slice")
    problems = []
    for slice_id in data.get("slices") or []:
        work = slices.get(slice_id) or {}
        relative = f"product/slices/{slice_id}.json"
        if relative in sync["collisions"] or relative in sync["conflicts"]:
            problems.append(f"{slice_id} needs reconciling with the shared project first")
        elif work.get("status") != "approved_for_engineering":
            problems.append(f"{slice_id} is {work.get('status')}, not approved")
        else:
            # Judge the spec again with the authoritative validator: approval may be old.
            spec = studio.spec_of(slice_id)
            if spec is None or sha(spec.read_bytes()) != work.get("spec_sha256"):
                problems.append(f"{slice_id}: its spec changed after it was approved (studio.py slice reopen {slice_id})")
                continue
            findings, model = studio.analyze(spec, ready=True)
            errors = [f for f in findings if f.severity == "error"]
            if errors:
                problems.append(f"{slice_id}: its spec no longer passes validation ({errors[0].message})")
    if problems:
        raise StudioError(f"{args.wave_id} cannot be approved yet:\n  " + "\n  ".join(problems))
    data.update({"status": "approved_for_engineering", "approval": {"actor": actor(studio, args.actor), "approved_at": now(args.at)}})
    studio.commit_or_restore([("wave", data)], f"Approving {args.wave_id}")
    return emit({"approved": True, "wave": studio.load("wave", args.wave_id), "factory_authorized": False,
                 "note": "Product approval only. The wave stays in your workspace until it is sent to engineering, which is not available yet."})


def cmd_not_yet(studio: Studio, args: argparse.Namespace) -> int:
    raise StudioError(f"'{args.command}' {NOT_YET}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MACH Product Studio operations (drafts only; never starts Factory work)")
    parser.add_argument("--project", type=Path, help="project root (default: nearest folder with .factory/ or .git)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("where", help="print the workspace and the files the interview needs").set_defaults(func=cmd_where)
    sub.add_parser("status", help="every artifact with its state, and what to do next").set_defaults(func=cmd_status)
    sub.add_parser("validate", help="structural check of the whole workspace").set_defaults(func=cmd_validate)
    for name in ("refresh", "send", "feedback"):
        sub.add_parser(name, help="reserved for the publishing milestone").set_defaults(func=cmd_not_yet)

    project = sub.add_parser("project", help="the project's name, vision and outcomes").add_subparsers(dest="action", required=True)
    p = project.add_parser("init")
    p.add_argument("--id", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--vision", required=True)
    p.add_argument("--outcome", action="append", default=[])
    p.set_defaults(func=cmd_project_init)
    p = project.add_parser("set")
    p.add_argument("--name")
    p.add_argument("--vision")
    p.add_argument("--outcome", action="append", help="repeat for each outcome; replaces the list")
    p.add_argument("--status", choices=product.ENUMS["project"]["status"])
    p.set_defaults(func=cmd_project_set)

    epic = sub.add_parser("epic", help="epics").add_subparsers(dest="action", required=True)
    p = epic.add_parser("add")
    p.add_argument("--title", required=True)
    p.add_argument("--criterion", action="append", default=[], help="an acceptance criterion; repeatable")
    p.set_defaults(func=cmd_epic_add)
    p = epic.add_parser("set")
    p.add_argument("epic_id")
    p.add_argument("--title")
    p.add_argument("--criterion", action="append", help="repeat for each criterion; replaces the list")
    p.add_argument("--status", choices=("proposed", "deferred", "completed", "superseded"))
    p.set_defaults(func=cmd_epic_set)
    p = epic.add_parser("approve")
    p.add_argument("epic_id")
    p.set_defaults(func=cmd_epic_approve)

    slice_ = sub.add_parser("slice", help="slice work orders and their interview").add_subparsers(dest="action", required=True)
    p = slice_.add_parser("new")
    p.add_argument("--epic", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--depends-on", action="append", default=[])
    p.add_argument("--id", help="only to pick up an ID that an earlier spec reserved for this feature")
    p.set_defaults(func=cmd_slice_new)
    p = slice_.add_parser("set")
    p.add_argument("slice_id")
    p.add_argument("--title")
    p.add_argument("--epic")
    p.add_argument("--depends-on", action="append", help="repeat for each; replaces the list ('none' clears it)")
    p.set_defaults(func=cmd_slice_set)
    p = slice_.add_parser("resume")
    p.add_argument("slice_id", nargs="?")
    p.set_defaults(func=cmd_slice_resume)
    p = slice_.add_parser("pause")
    p.add_argument("slice_id")
    p.add_argument("--note", required=True, help="where the interview stopped and what to ask next")
    p.set_defaults(func=cmd_slice_pause)
    p = slice_.add_parser("check")
    p.add_argument("slice_id")
    p.add_argument("--ready", action="store_true", help="also fail while open questions remain")
    p.set_defaults(func=cmd_slice_check)
    p = slice_.add_parser("approve")
    p.add_argument("slice_id")
    p.set_defaults(func=cmd_slice_approve)
    p = slice_.add_parser("reopen")
    p.add_argument("slice_id")
    p.set_defaults(func=cmd_slice_reopen)

    wave = sub.add_parser("wave", help="delivery waves").add_subparsers(dest="action", required=True)
    p = wave.add_parser("new")
    p.add_argument("--slice", action="append", default=[])
    p.set_defaults(func=cmd_wave_new)
    for name, func in (("add", cmd_wave_add), ("remove", cmd_wave_remove)):
        p = wave.add_parser(name)
        p.add_argument("wave_id")
        p.add_argument("slice_ids", nargs="+")
        p.set_defaults(func=func)
    p = wave.add_parser("approve")
    p.add_argument("wave_id")
    p.add_argument("--actor", help="who approves (default: the Git identity configured here)")
    p.add_argument("--at", help="approval time as a date-time (default: now)")
    p.set_defaults(func=cmd_wave_approve)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        cell, _ = intent_modules()
        project = (args.project or cell.find_project(Path.cwd())).resolve()
        if not project.is_dir():
            raise StudioError(f"{project} is not a folder.")
        return args.func(Studio(project), args)
    except StudioError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # CellError and friends from the intent skill
        if exc.__class__.__name__ == "CellError":
            print(f"refused: {exc}", file=sys.stderr)
            return 1
        raise


if __name__ == "__main__":
    sys.exit(main())
