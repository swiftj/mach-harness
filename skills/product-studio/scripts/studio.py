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
import collab  # noqa: E402
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
TRACKED = collab.TRACKED
APPROVED = "approved_for_engineering"
IGNORE_LINE = ".factory/studio/"
EDITABLE_SLICE = ("draft", "interviewing", "ready_for_approval")


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
        for folder in (project / ".factory", self.home, self.draft, self.home / "base", self.home / "publish"):
            if folder.is_symlink():
                raise StudioError(f"{folder} is a symbolic link. Product Studio only works in a real folder inside the project.")
        self.shared = collab.Shared(project, self.cell.load_config(project))
        self._theirs: Optional[Dict[str, bytes]] = None

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
        data.setdefault("resolutions", {})
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

    def theirs(self) -> Dict[str, bytes]:
        """The shared project's product files: the remote's integration branch as last fetched, or,
        in a project with no shared remote, the main checkout."""
        if self._theirs is None:
            if self.shared.ref:
                self._theirs = self.shared.files()
            else:
                found: Dict[str, bytes] = {}
                for pattern in TRACKED:
                    for path in sorted(self.project.glob(pattern)):
                        if path.is_file() and not path.is_symlink():
                            found[path.relative_to(self.project).as_posix()] = path.read_bytes()
                self._theirs = found
        return self._theirs

    def base_file(self, relative: str) -> Path:
        return self.home / "base" / relative

    def set_base(self, relative: str, data: bytes) -> None:
        """Remember the shared version a draft was last brought level with."""
        path = self.base_file(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def is_published(self, relative: str) -> bool:
        """True when this draft file came from, or has been reconciled with, the shared project."""
        return self.base_file(relative).is_file()

    def ledger(self) -> Dict[str, Any]:
        try:
            data = json.loads((self.home / "publications.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict) or not isinstance(data.get("waves"), dict):
            data = {"schema_version": 1, "waves": {}}
        return data

    def save_ledger(self, data: Dict[str, Any]) -> None:
        write(self.home / "publications.json", canonical(data))

    def sync(self) -> Dict[str, Any]:
        """Bring the shared project into the workspace without losing anything the PM wrote.

        Each file is compared three ways: the shared version the draft started from, the shared
        version now, and the draft. A file only one side changed follows that side. A JSON artifact
        both changed is merged field by field. A spec or an intent both changed, a field both
        changed differently, and a different artifact holding a draft's number are reported for the
        PM to settle. Nothing is ever written outside the workspace.
        """
        for folder in (self.draft / "specs" / "slices", self.draft / "product" / "intents"):
            folder.mkdir(parents=True, exist_ok=True)
        self.ensure_ignored()
        session = self.session()
        legacy: Dict[str, str] = session.get("baseline") or {}
        resolutions: Dict[str, Dict[str, str]] = session["resolutions"]
        report: Dict[str, Any] = {"conflicts": [], "collisions": [], "details": {}, "arrived": [], "updated": [], "merged": [], "approvals_withdrawn": []}
        touched: List[str] = []
        for relative, data in sorted(self.theirs().items()):
            target = self.draft / relative
            mine = target.read_bytes() if target.is_file() else None
            base_path = self.base_file(relative)
            base = base_path.read_bytes() if base_path.is_file() else None
            if base is None and mine is not None and relative in legacy:  # a workspace from before bases were kept
                base = mine if sha(mine) == legacy[relative] else data if sha(data) == legacy[relative] else None
            if mine is None:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                self.set_base(relative, data)
                report["arrived"].append(relative)
                touched.append(relative)
            elif mine == data:
                if base != data:
                    self.set_base(relative, data)
            elif base is None and relative != "product/project.json":
                report["collisions"].append(relative)
            elif mine == base:
                target.write_bytes(data)
                self.set_base(relative, data)
                report["updated"].append(collab.describe_change(self.validate_slice, relative, base, data))
                touched.append(relative)
            elif data == base:
                continue  # only the PM changed it: an unpublished edit
            elif relative.endswith(".json"):
                b, m, t = collab.parse(base) if base is not None else {}, collab.parse(mine), collab.parse(data)
                if b is None or m is None or t is None:
                    report["conflicts"].append(relative)
                    report["details"][relative] = {"unreadable": True}
                    continue
                merged, conflicts = collab.merge_fields(b, m, t, resolutions.get(relative) or {})
                if conflicts:
                    report["conflicts"].append(relative)
                    report["details"][relative] = {"fields": conflicts}
                    continue
                took = [key for key in merged if key != "revision" and merged.get(key) != m.get(key)]
                if took and m.get("status") == APPROVED and "/slices/" in relative:
                    merged.update({"status": "interviewing", "spec_sha256": None})
                    report["approvals_withdrawn"].append(target.stem)
                if took and m.get("status") == APPROVED and "/delivery-waves/" in relative:
                    merged.update({"status": "draft", "approval": None})
                    report["approvals_withdrawn"].append(target.stem)
                write(target, canonical(merged))
                self.set_base(relative, data)
                resolutions.pop(relative, None)
                report["merged"].append({"path": relative, "taken_from_shared": took})
                touched.append(relative)
            else:
                report["conflicts"].append(relative)
                report["details"][relative] = {"mine": collab.describe_change(self.validate_slice, relative, base, mine),
                                               "theirs": collab.describe_change(self.validate_slice, relative, base, data)}
        if session != self.session():
            self.save_session(session)
        self.settle(touched, report)
        return report

    def settle(self, touched: Sequence[str], report: Dict[str, Any]) -> None:
        """Withdraw a local approval that a change from the shared project has made untrue.

        Only files this sync changed are considered: a spec the PM edited by hand after approving
        is left for validation to catch, as before.
        """
        if not touched:
            return
        theirs = self.theirs()

        def local(relative: str) -> bool:
            path = self.draft / relative
            return path.is_file() and theirs.get(relative) != path.read_bytes()

        ids = {match.group(0) for relative in touched for match in [re.search(r"SLICE-\d{3,}", relative)] if match}
        for slice_id, work in self.all("slice").items():
            if slice_id not in ids or work.get("status") != APPROVED or not local(f"product/slices/{slice_id}.json"):
                continue
            try:
                spec = self.spec_of(slice_id)
            except StudioError:
                spec = None
            if spec is None or sha(spec.read_bytes()) != work.get("spec_sha256"):
                work.update({"status": "interviewing", "spec_sha256": None})
                self.save("slice", work)
                report["approvals_withdrawn"].append(slice_id)
        slices = self.all("slice")
        for wave_id, wave in self.all("wave").items():
            if wave.get("status") == APPROVED and local(f"product/delivery-waves/{wave_id}.json") and any(
                    (slices.get(sid) or {}).get("status") != APPROVED for sid in wave.get("slices") or []):
                wave.update({"status": "draft", "approval": None})
                self.save("wave", wave)
                report["approvals_withdrawn"].append(wave_id)
        report["approvals_withdrawn"] = sorted(set(report["approvals_withdrawn"]))

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
        """The next free ID, counting the shared project, every draft, open cells, and other
        product managers' work still in review on the remote."""
        in_review = self.shared.numbers_in_review()
        if kind == "slice":
            used, reserved = self.cell.slice_ids(self.project)
            taken = [int(match.group(1)) for name in self.theirs() for match in [re.search(r"SLICE-(\d{3,})", name)] if match]
            return f"SLICE-{max([0, *used, *reserved, *taken, *in_review['SLICE']]) + 1:03d}"
        folder, prefix, rule, _ = KINDS[kind]
        numbers = [0, *in_review[prefix]]
        numbers += [int(match.group(1)) for name in self.theirs() for match in [re.search(prefix + r"-(\d{3,})\.json$", name)] if match]
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
            # A draft and a different shared slice can hold the same number until the draft is
            # renumbered. The spec that belongs to this work order is the one with the same origin.
            published = self.is_published(f"product/slices/{slice_id}.json")
            same_origin = [p for p in matches if self.is_published(self.relative(p)) == published]
            matches = same_origin if len(same_origin) == 1 else matches
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
    """Who approves: a name. Never an email address; an approval is published and read by many."""
    name = given if given and given.strip() else studio.cell.git(["config", "user.name"], studio.project).stdout
    name = " ".join(re.sub(r"<[^>]*>", " ", name).split())
    if not name or "@" in name:
        raise StudioError("Cannot tell who is approving: Git has no user.name configured here. Pass --actor \"Your Name\" (a name, not an address).")
    return name


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


def describe(studio: Studio, sync: Dict[str, Any]) -> Dict[str, Any]:
    session = studio.session()
    project_path = studio.path("project")
    project = studio.load("project") if project_path.is_file() else None
    epics, slices, waves = studio.all("epic"), studio.all("slice"), studio.all("wave")
    theirs = studio.theirs()
    ledger = studio.ledger()["waves"]

    def source(relative: str) -> str:
        target = studio.draft / relative
        if relative in sync["collisions"]:
            return "collision"
        if relative in sync["conflicts"]:
            return "conflict"
        if target.is_file() and theirs.get(relative) == target.read_bytes():
            return "published"
        return "draft"

    waved: Dict[str, List[str]] = {}
    for wave_id, data in waves.items():
        if data.get("status") != "superseded":
            for sid in data.get("slices") or []:
                waved.setdefault(sid, []).append(wave_id)
    slice_rows = []
    for slice_id, data in slices.items():
        spec = studio.spec_of(slice_id)
        slice_rows.append({
            "slice_id": slice_id, "title": data.get("title"), "epic_id": data.get("epic_id"), "status": data.get("status"),
            "revision": data.get("revision"), "open_questions": len(data.get("open_questions") or []),
            "spec": studio.relative(spec) if spec else None, "has_intent": studio.intent_path(slice_id).is_file(),
            "source": source(f"product/slices/{slice_id}.json"), "resume_note": (session["notes"].get(slice_id) or {}).get("note"),
            "dependencies": list(data.get("dependencies") or []), "editable": edit_refusal(slice_id, data) is None,
            "in_waves": waved.get(slice_id, []),
        })
    structural = studio.structural() if project else None
    actions = next_actions(project, epics, slices, waves, slice_rows, waved, sync, ledger, source)
    return {
        "project": project and {key: project.get(key) for key in ("project_id", "name", "status", "revision", "vision", "outcomes")},
        "epics": [{"epic_id": key, "title": data.get("title"), "status": data.get("status"), "revision": data.get("revision"),
                   "acceptance_criteria": list(data.get("acceptance_criteria") or []),
                   "source": source(f"product/epics/{key}.json")} for key, data in epics.items()],
        "slices": slice_rows,
        "waves": [{"wave_id": key, "status": data.get("status"), "revision": data.get("revision"), "slices": data.get("slices"),
                   "approval": data.get("approval"), "source": source(f"product/delivery-waves/{key}.json"),
                   "sent": bool((ledger.get(key) or {}).get("pushed")),
                   "pull_request": ((ledger.get(key) or {}).get("pull_request") or {}).get("url")} for key, data in waves.items()],
        "current_slice": session.get("current_slice"),
        "needs_reconciling": reconciling(sync),
        "shared_project": f"the {studio.shared.into} branch of the shared repository" if studio.shared.ref else "this folder (no shared repository)",
        "last_refreshed": session.get("refreshed_at"),
        "structurally_valid": structural["valid"] if structural else None,
        "structural_errors": structural["errors"] if structural else [],
        "factory_authorized": False,
        "suggested_next": [action["sentence"] for action in actions],
        "next_actions": [{key: action[key] for key in ("kind", "target", "title", "reason", "related")} for action in actions],
    }


# The vocabulary of next_actions[].kind. A client maps each to its own button or screen.
NEXT_ACTION_KINDS = ("define_project", "add_epic", "reconcile", "continue_interview", "approve_slice", "approve_epic",
                     "create_wave", "approve_wave", "send_wave", "start_slice")


def next_actions(project, epics, slices, waves, slice_rows, waved, sync, ledger, source) -> List[Dict[str, Any]]:
    """What to do next, in order. One decision produces both forms: `sentence` for the terminal
    (it ends with the command in brackets) and kind, target, title and reason for an app."""
    actions: List[Dict[str, Any]] = []

    def act(kind: str, target: Optional[str], title: str, reason: str, sentence: str,
            related: Sequence[str] = (), first: bool = False) -> None:
        item = {"kind": kind, "target": target, "title": title, "reason": reason, "related": list(related), "sentence": sentence}
        actions.insert(0, item) if first else actions.append(item)

    if not project:
        act("define_project", None, "Define the project", "Say what the product is for: its name, vision and outcomes.",
            "Define the project: its name, vision and outcomes (project init).")
        return actions
    if not epics:
        act("add_epic", None, "Add the first epic", "An epic is a larger capability that several slices deliver.",
            "Add the first epic (epic add).")
        return actions
    for row in slice_rows:
        if row["status"] in ("draft", "interviewing"):
            act("continue_interview", row["slice_id"], f"Continue the interview for {row['slice_id']}",
                f"{row['title']} is still being defined.",
                f"Continue the interview for {row['slice_id']}: {row['title']} (slice resume {row['slice_id']}).")
        elif row["status"] == "ready_for_approval":
            act("approve_slice", row["slice_id"], f"Approve {row['slice_id']}", f"{row['title']} is ready for your approval.",
                f"{row['slice_id']} is ready: approve it (slice approve {row['slice_id']}).")
    for epic_id, data in epics.items():
        if data.get("status") == "proposed":
            act("approve_epic", epic_id, f"Approve epic {epic_id}", f"{data.get('title')}: its slices can be approved only once it is.",
                f"Approve epic {epic_id}: {data.get('title')} (epic approve {epic_id}), so its slices can be approved.")
    loose = [row["slice_id"] for row in slice_rows if row["status"] == APPROVED and row["slice_id"] not in waved]
    if loose:
        act("create_wave", None, "Put approved slices into a delivery wave", f"Approved and not in a delivery wave yet: {', '.join(loose)}.",
            f"Put approved slices into a delivery wave: {', '.join(loose)} (wave new).", related=loose)
    for wave_id, data in waves.items():
        if data.get("status") == "draft" and data.get("slices") and all((slices.get(s) or {}).get("status") == APPROVED for s in data["slices"]):
            act("approve_wave", wave_id, f"Approve {wave_id}", "It holds only approved slices.",
                f"{wave_id} holds only approved slices: approve it (wave approve {wave_id}).", related=data["slices"])
        if data.get("status") == APPROVED and source(f"product/delivery-waves/{wave_id}.json") != "published" and not (ledger.get(wave_id) or {}).get("pushed"):
            act("send_wave", wave_id, f"Send {wave_id} to engineering", "It is approved and has not been sent yet.",
                f"{wave_id} is approved and has not been sent to engineering (send {wave_id}).", related=data.get("slices") or [])
    if sync["conflicts"] or sync["collisions"]:
        act("reconcile", None, "Settle what disagrees with the shared project",
            "Some of your drafts and the shared project disagree. Settle those first: choose a version, or renumber a draft whose number is taken.",
            "Some of your drafts and the shared project disagree: settle those first (reconcile, or renumber for a collision).",
            related=[*sync["conflicts"], *sync["collisions"]], first=True)
    if not any(row["status"] in EDITABLE_SLICE for row in slice_rows):
        act("start_slice", None, "Start a new slice", "No slice is being defined right now.",
            "Start a new slice (slice new --epic EPIC-NNN --title \"...\").")
    return actions


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


def edit_refusal(slice_id: str, data: Dict[str, Any]) -> Optional[str]:
    """Why a slice's draft cannot be changed, or None when it can."""
    if data.get("status") in EDITABLE_SLICE:
        return None
    return f"{slice_id} is {data.get('status')}. To change an approved slice, reopen it first: studio.py slice reopen {slice_id}"


def require_editable(studio: Studio, slice_id: str) -> Dict[str, Any]:
    data = studio.load("slice", slice_id)
    refusal = edit_refusal(slice_id, data)
    if refusal:
        raise StudioError(refusal)
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


INTENT_TITLE_RE = re.compile(r"^# Intent:[ \t]*(.*?)\s*$", re.MULTILINE)


def why_sections(text: Optional[str], cell: Any) -> Dict[str, Any]:
    """A slice's why split into its sections, with the bold `- **Name:** value` lines of each."""
    if text is None:
        return {"exists": False, "markdown": None, "title": None, "header": {}, "sections": []}
    sections = cell.markdown_sections(text)
    title = INTENT_TITLE_RE.search(text)
    preamble = [line for line in sections.get("", []) if not INTENT_TITLE_RE.fullmatch(line)]
    return {
        "exists": True, "markdown": text, "title": title.group(1) if title else None,
        "header": cell.fields(preamble),
        "sections": [{"heading": heading, "text": "\n".join(lines).strip("\n"), "fields": cell.fields(lines)}
                     for heading, lines in sections.items() if heading],
    }


def cmd_slice_show(studio: Studio, args: argparse.Namespace) -> int:
    """Everything the Specification Workspace shows for one slice, in one read. Changes nothing:
    no sync, no bookkeeping. `slice check` is the call that records a result."""
    slice_id = args.slice_id
    data = studio.load("slice", slice_id)
    spec = studio.spec_of(slice_id)
    intent = studio.intent_path(slice_id)
    intent_text = intent.read_bytes().decode("utf-8", errors="replace") if intent.is_file() and not intent.is_symlink() else None
    spec_view: Optional[Dict[str, Any]] = None
    if spec is not None:
        findings, model = studio.analyze(spec, ready=False)
        spec_view = {
            "path": studio.relative(spec), "name": spec.name,
            "markdown": spec.read_bytes().decode("utf-8", errors="replace"),
            "model": model,
            "findings": [{"severity": f.severity, "rule": f.rule, "line": f.line or None, "message": f.message} for f in findings],
        }
    check = studio.check_slice(slice_id, ready=False)
    if check.get("spec"):
        check["spec"] = studio.relative(Path(check["spec"]))
    refusal = edit_refusal(slice_id, data)
    return emit({
        "slice": data,
        "editable": refusal is None,
        "edit_refusal": refusal,
        "paths": {
            "work_order": studio.relative(studio.path("slice", slice_id)),
            "specs_dir": "specs/slices",
            "spec": spec_view["path"] if spec_view else None,
            "spec_name_pattern": f"{slice_id}-<lowercase-kebab-name>.md",
            "intent": studio.relative(intent),
        },
        "spec": spec_view,
        "why": why_sections(intent_text, studio.cell),
        "check": check,
        "resume_note": (studio.session()["notes"].get(slice_id) or {}).get("note"),
        "factory_authorized": False,
    })


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
    data.update({"status": APPROVED, "open_questions": [],
                 "spec_path": studio.relative(spec), "spec_sha256": sha(spec.read_bytes())})
    studio.commit_or_restore([("slice", data)], f"Approving {slice_id}")
    return emit({"approved": True, "slice": studio.load("slice", slice_id), "risk": result.get("risk"), "counts": result.get("counts"),
                 "warnings": result["warnings"], "factory_authorized": False,
                 "note": "Product approval only. Nothing has been sent to engineering and no work has started."})


def cmd_slice_reopen(studio: Studio, args: argparse.Namespace) -> int:
    studio.sync()
    data = studio.load("slice", args.slice_id)
    if data.get("status") != APPROVED:
        raise StudioError(f"{args.slice_id} is {data.get('status')}; only an approved slice can be reopened.")
    data.update({"status": "interviewing", "spec_sha256": None})
    changes: List[Tuple[str, Dict[str, Any]]] = [("slice", data)]
    withdrawn = []
    for wave_id, wave in studio.all("wave").items():
        if args.slice_id in (wave.get("slices") or []) and wave.get("status") == APPROVED:
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


def wave_problems(studio: Studio, sync: Dict[str, Any], data: Dict[str, Any]) -> List[str]:
    """Why a wave's slices are not all approved, valid and level with the shared project."""
    slices = studio.all("slice")
    problems = []
    for slice_id in data.get("slices") or []:
        work = slices.get(slice_id) or {}
        relative = f"product/slices/{slice_id}.json"
        if relative in sync["collisions"] or relative in sync["conflicts"]:
            problems.append(f"{slice_id} needs reconciling with the shared project first")
        elif work.get("status") != APPROVED:
            problems.append(f"{slice_id} is {work.get('status')}, not approved")
        else:
            # Judge the spec again with the authoritative validator: approval may be old.
            spec = studio.spec_of(slice_id)
            if spec is None or sha(spec.read_bytes()) != work.get("spec_sha256"):
                problems.append(f"{slice_id}: its spec changed after it was approved (studio.py slice reopen {slice_id})")
                continue
            if studio.relative(spec) in sync["conflicts"]:
                problems.append(f"{slice_id}: its spec needs reconciling with the shared project first")
                continue
            findings, model = studio.analyze(spec, ready=True)
            errors = [f for f in findings if f.severity == "error"]
            if errors:
                problems.append(f"{slice_id}: its spec no longer passes validation ({errors[0].message})")
    return problems


def cmd_wave_approve(studio: Studio, args: argparse.Namespace) -> int:
    sync = studio.sync()
    data = editable_wave(studio, args.wave_id)
    problems = wave_problems(studio, sync, data)
    if problems:
        raise StudioError(f"{args.wave_id} cannot be approved yet:\n  " + "\n  ".join(problems))
    data.update({"status": APPROVED, "approval": {"actor": actor(studio, args.actor), "approved_at": now(args.at)}})
    studio.commit_or_restore([("wave", data)], f"Approving {args.wave_id}")
    return emit({"approved": True, "wave": studio.load("wave", args.wave_id), "factory_authorized": False,
                 "note": "Product approval only. The wave stays in your workspace until you send it to engineering."})


# ---- collaboration ----


def reconciling(sync: Dict[str, Any]) -> Dict[str, Any]:
    return {"conflicts": sync["conflicts"], "collisions": sync["collisions"], "details": sync["details"]}


def cmd_refresh(studio: Studio, args: argparse.Namespace) -> int:
    fetched, problem = studio.shared.fetch()
    detail = studio.shared.fetch_detail
    studio.shared = collab.Shared(studio.project, studio.cell.load_config(studio.project))
    studio._theirs = None
    sync = studio.sync()
    session = studio.session()
    if fetched:
        session["refreshed_at"] = now(None)
        studio.save_session(session)
    return emit({
        "refreshed": fetched,
        "problem": None if fetched else problem,
        "problem_detail": None if fetched or not detail else detail,
        "shared_project": f"the {studio.shared.into} branch of the shared repository" if studio.shared.ref else "this folder (no shared repository)",
        "arrived": sync["arrived"], "updated": sync["updated"], "merged": sync["merged"],
        "approvals_withdrawn": sync["approvals_withdrawn"],
        "needs_reconciling": reconciling(sync),
    })


def resolve_artifact(given: str, candidates: Sequence[str]) -> str:
    if given in candidates:
        return given
    matches = [relative for relative in candidates if given in relative.rsplit("/", 1)[-1]]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise StudioError(f"Nothing called '{given}' needs reconciling. Waiting: " + (", ".join(candidates) or "nothing") + ".")
    raise StudioError(f"'{given}' matches more than one item. Name one of: " + ", ".join(matches) + ".")


def withdraw_slice(studio: Studio, slice_id: str) -> List[str]:
    """Return a locally approved slice to the interview, and any approved draft wave holding it to draft."""
    withdrawn = []
    work = studio.all("slice").get(slice_id)
    if work and work.get("status") == APPROVED:
        work.update({"status": "interviewing", "spec_sha256": None})
        studio.save("slice", work)
        withdrawn.append(slice_id)
        for wave_id, wave in studio.all("wave").items():
            if slice_id in (wave.get("slices") or []) and wave.get("status") == APPROVED:
                wave.update({"status": "draft", "approval": None})
                studio.save("wave", wave)
                withdrawn.append(wave_id)
    return withdrawn


def cmd_reconcile(studio: Studio, args: argparse.Namespace) -> int:
    sync = studio.sync()
    relative = resolve_artifact(args.artifact, [*sync["conflicts"], *sync["collisions"]])
    if relative in sync["collisions"]:
        kind = "slice" if "/slices/" in relative else "epic" if "/epics/" in relative else "wave"
        raise StudioError(f"{Path(relative).stem} is a different {kind} in the shared project, so there is nothing to merge. "
                          f"Give your draft a new number: studio.py {kind} renumber {Path(relative).stem}")
    theirs = studio.theirs()[relative]
    withdrawn: List[str] = []
    if relative.endswith(".json") and not sync["details"][relative].get("unreadable"):
        fields = sync["details"][relative]["fields"]
        if args.field and args.field not in fields:
            raise StudioError(f"'{args.field}' is not in conflict in {relative}. In conflict: {', '.join(fields)}.")
        session = studio.session()
        chosen = session["resolutions"].setdefault(relative, {})
        for field in ([args.field] if args.field else list(fields)):
            chosen[field] = args.take
        studio.save_session(session)
    else:
        if args.field:
            raise StudioError("--field applies to a project, epic, slice work order or wave; a spec or a why is taken whole.")
        target = studio.draft / relative
        match = re.search(r"SLICE-\d{3,}", relative)
        if args.take == "theirs":
            if match:
                withdrawn = withdraw_slice(studio, match.group(0))  # the approved text is being replaced
            target.write_bytes(theirs)
        studio.set_base(relative, theirs)
    after = studio.sync()
    return emit({"reconciled": relative, "took": args.take, "field": args.field,
                 "approvals_withdrawn": sorted(set(withdrawn + after["approvals_withdrawn"])),
                 "needs_reconciling": reconciling(after)})


def replace_id(text: str, old: str, new: str) -> str:
    return re.sub(r"(?<![A-Za-z0-9-])" + re.escape(old) + r"(?![0-9])", new, text)


def cmd_renumber(studio: Studio, args: argparse.Namespace) -> int:
    """Give an unpublished draft the next free number and move every reference to it."""
    studio.sync()
    kind, old = args.kind, args.identifier
    folder, prefix, rule, key = KINDS[kind]
    if not rule.fullmatch(old):
        raise StudioError(f"'{old}' is not a usable {kind} ID, such as {prefix}-001.")
    relative = f"product/{folder}/{old}.json"
    path = studio.draft / relative
    mine = path.is_file() and not studio.is_published(relative)
    if path.is_file() and not mine and kind != "slice":
        raise StudioError(f"{old} is already part of the shared project, so its number cannot change.")
    if kind == "wave" and old in studio.ledger()["waves"]:
        raise StudioError(f"{old} has already been sent to engineering under that number, so it cannot change.")
    drafts = [p for p in sorted((studio.draft / "specs" / "slices").glob("SLICE-*.md")) if not studio.is_published(studio.relative(p))]
    pointing = [p for p in drafts if kind == "slice" and replace_id(p.read_text(encoding="utf-8"), old, "") != p.read_text(encoding="utf-8")]
    if not mine and not pointing:
        if path.is_file():
            raise StudioError(f"{old} is already part of the shared project, so its number cannot change.")
        raise StudioError(f"No unpublished draft uses {old}.")
    new = studio.next_id(kind)
    changed: List[str] = []
    returned: List[str] = []

    def rewrite(target: Path) -> None:
        text = target.read_text(encoding="utf-8")
        updated = replace_id(text, old, new)
        if updated != text:
            write(target, updated)
            changed.append(studio.relative(target))

    if mine:
        data = studio.load(kind, old)
        data[key] = new
        if kind == "slice":
            spec = studio.spec_of(old)
            if data.get("status") == APPROVED:
                data["status"] = "ready_for_approval"  # the approved text is about to change
                returned.append(new)
            data["spec_sha256"] = None
            if spec is not None:
                renamed = spec.with_name(new + spec.name[len(old):])
                write(renamed, replace_id(spec.read_text(encoding="utf-8"), old, new))
                spec.unlink()
                data["spec_path"] = studio.relative(renamed)
                changed.append(studio.relative(renamed))
            intent = studio.intent_path(old)
            if intent.is_file():
                write(studio.intent_path(new), replace_id(intent.read_text(encoding="utf-8"), old, new))
                intent.unlink()
                changed.append(studio.relative(studio.intent_path(new)))
        write(studio.path(kind, new), canonical(data))
        path.unlink()
        changed.append(f"product/{folder}/{new}.json")
    if kind == "slice":
        for spec in [p for p in sorted((studio.draft / "specs" / "slices").glob("SLICE-*.md")) if not studio.is_published(studio.relative(p))]:
            rewrite(spec)  # pointers such as "(Deferred to SLICE-NNN)" in other unpublished specs
    for other_kind, field in (("slice", "dependencies" if kind == "slice" else "epic_id"), ("wave", "slices")):
        if (kind, other_kind) in (("wave", "slice"), ("wave", "wave"), ("epic", "wave")) or not mine:
            continue
        for identifier, data in studio.all(other_kind).items():
            other = f"product/{KINDS[other_kind][0]}/{identifier}.json"
            value = data.get(field)
            if studio.is_published(other) or (old not in value if isinstance(value, list) else value != old):
                continue
            data[field] = [new if item == old else item for item in value] if isinstance(value, list) else new
            if other_kind == "wave" and data.get("status") == APPROVED:
                data.update({"status": "draft", "approval": None})
                returned.append(identifier)
            studio.save(other_kind, data)
            changed.append(other)
            if kind == "epic":
                intent = studio.intent_path(identifier)
                if intent.is_file():
                    rewrite(intent)
    session = studio.session()
    if kind == "slice":
        if session.get("current_slice") == old:
            session["current_slice"] = new
        if old in session["notes"]:
            session["notes"][new] = session["notes"].pop(old)
    session["resolutions"].pop(relative, None)
    studio.save_session(session)
    after = studio.sync()  # the shared artifact that holds the old number can now arrive
    structural = studio.structural()
    return emit({"renumbered": {"from": old, "to": new}, "changed": sorted(set(changed)), "needs_approval_again": sorted(set(returned)),
                 "needs_reconciling": reconciling(after), "structurally_valid": structural["valid"], "structural_errors": structural["errors"]})


def closure(studio: Studio, wave: Dict[str, Any]) -> Tuple[Dict[str, bytes], List[str]]:
    """Every product file a wave needs: the wave, its slices' work orders, whys and specs, their
    epics and the project. Nothing else can be shared."""
    files: Dict[str, bytes] = {}
    problems: List[str] = []

    def add(relative: str) -> None:
        path = studio.draft / relative
        if path.is_file() and not path.is_symlink():
            files[relative] = path.read_bytes()
        else:
            problems.append(f"{relative} is missing")

    add(f"product/delivery-waves/{wave['wave_id']}.json")
    add("product/project.json")
    slices = studio.all("slice")
    theirs = studio.theirs()
    for slice_id in wave.get("slices") or []:
        work = slices.get(slice_id) or {}
        add(f"product/slices/{slice_id}.json")
        add(f"product/intents/{slice_id}.md")
        spec = studio.spec_of(slice_id)
        if spec is not None:
            add(studio.relative(spec))
        if isinstance(work.get("epic_id"), str):
            add(f"product/epics/{work['epic_id']}.json")
        for dependency in work.get("dependencies") or []:
            if dependency not in wave["slices"] and f"product/slices/{dependency}.json" not in theirs:
                problems.append(f"{slice_id} depends on {dependency}, which engineering does not have yet. Add {dependency} to this wave, or send it first.")
    return files, problems


def validate_tree(studio: Studio, tree: Path, wave: Dict[str, Any]) -> List[str]:
    """Judge the work as engineering will see it: the shared project plus this wave."""
    report = product.validate_workspace(tree)
    problems = list(report["errors"])
    for slice_id in wave.get("slices") or []:
        specs = sorted((tree / "specs" / "slices").glob(f"{slice_id}-*.md"))
        if len(specs) != 1:
            problems.append(f"{slice_id}: expected one spec in the shared project, found {len(specs)}")
            continue
        others = studio.validate_slice.sibling_specs(specs[0], [])
        findings, _ = studio.validate_slice.analyze(specs[0].read_text(encoding="utf-8-sig"), specs[0].name, others, ready=True)
        problems += [f"{specs[0].name}: {f.message} [{f.rule}]" for f in findings if f.severity == "error"]
    return problems


def request_text(studio: Studio, wave: Dict[str, Any]) -> Tuple[str, str]:
    slices = studio.all("slice")
    epics = studio.all("epic")
    count = len(wave.get("slices") or [])
    title = f"Product: {wave['wave_id']}, {count} slice{'s' if count != 1 else ''} approved for engineering"
    approval = wave.get("approval") or {}
    lines = [f"Delivery wave **{wave['wave_id']}** for *{studio.load('project').get('name')}*, approved by {approval.get('actor')} on {approval.get('approved_at')}.", "",
             "This request adds product definitions only (`product/` and `specs/slices/`). It contains no code and starts no work.", ""]
    for slice_id in wave.get("slices") or []:
        work = slices.get(slice_id) or {}
        spec = studio.spec_of(slice_id)
        lines.append(f"### {slice_id}: {work.get('title')}")
        lines.append(f"- Epic: {work.get('epic_id')} ({(epics.get(work.get('epic_id')) or {}).get('title')})")
        if spec is not None:
            _, model = studio.analyze(spec, ready=True)
            summary = model.get("summary")
            outcome = summary.get("outcome") if isinstance(summary, dict) else summary
            if isinstance(outcome, str) and outcome.strip():
                lines.append(f"- Outcome: {' '.join(outcome.split())}")
            lines.append(f"- {len(model.get('invariants') or [])} invariants, {len(model.get('functional_requirements') or [])} requirements, "
                         f"{len((model.get('decision_matrix') or {}).get('rules') or [])} decision rules, {len(model.get('scenarios') or [])} scenarios")
            lines.append(f"- Spec: `{studio.relative(spec)}`")
        _, intent = studio.cell.check_intent(studio.intent_path(slice_id), header_fields=("Slice", "Status"))
        if intent.get("risk"):
            lines.append(f"- Risk tier proposed by product: {intent['risk']}")
        if work.get("dependencies"):
            lines.append(f"- Depends on: {', '.join(work['dependencies'])}")
        lines.append("")
    lines.append("Sent from MACH Product Studio.")
    return title, "\n".join(lines)


def need_shared(studio: Studio) -> None:
    if not studio.shared.is_repository or not studio.shared.has_remote:
        raise StudioError("This project is not connected to a shared repository, so there is nowhere to send work. An engineer needs to set that up.")


def describe_file(relative: str, is_new: bool) -> str:
    stem = Path(relative).stem
    what = ("the project" if relative.endswith("project.json") else f"epic {stem}" if "/epics/" in relative
            else f"the work order for {stem}" if "/slices/" in relative and relative.startswith("product/")
            else f"the why for {stem}" if "/intents/" in relative else f"delivery wave {stem}" if "/delivery-waves/" in relative
            else f"the spec {Path(relative).name}")
    return f"{what} ({'new' if is_new else 'changed'})"


def cmd_send(studio: Studio, args: argparse.Namespace) -> int:
    need_shared(studio)
    fetched, _ = studio.shared.fetch()
    studio.shared = collab.Shared(studio.project, studio.cell.load_config(studio.project))
    studio._theirs = None
    if not fetched and not args.dry_run:
        raise StudioError("Could not reach the shared repository, so nothing was sent. Try again when you are connected.")
    if not studio.shared.ref:
        raise StudioError("The shared repository has no main branch yet, so there is nothing to send this to. An engineer needs to set that up.")
    sync = studio.sync()
    wave_id = args.wave_id
    wave = studio.load("wave", wave_id)
    if wave.get("status") != APPROVED:
        raise StudioError(f"{wave_id} is {wave.get('status')}. Only an approved wave can be sent (studio.py wave approve {wave_id}).")
    files, problems = closure(studio, wave)
    problems += [f"{relative} needs reconciling with the shared project first" for relative in files if relative in sync["conflicts"] or relative in sync["collisions"]]
    problems += wave_problems(studio, sync, wave)
    if problems:
        raise StudioError(f"{wave_id} cannot be sent yet:\n  " + "\n  ".join(dict.fromkeys(problems)))
    theirs = studio.theirs()
    changed = {relative: data for relative, data in files.items() if theirs.get(relative) != data}
    ledger = studio.ledger()
    entry = ledger["waves"].get(wave_id)
    branch = studio.shared.prefix + wave_id
    remote_branch = f"refs/remotes/{collab.REMOTE}/{branch}"
    on_remote = collab.git(studio.project, "rev-parse", "--verify", "-q", remote_branch).returncode == 0
    if not changed:
        if entry:
            return emit({"sent": False, "already_accepted": True, "wave_id": wave_id, "status": "Accepted",
                         "note": "The shared project already has all of this. Nothing was sent."})
        raise StudioError(f"Nothing to send: the shared project already has everything in {wave_id}.")
    if on_remote and not entry:
        raise StudioError(f"Another product manager already has a {wave_id} in review, so this wave needs a new number: studio.py wave renumber {wave_id}")
    digest = collab.digest_of(changed, sha)
    if args.dry_run:
        return emit({"dry_run": True, "wave_id": wave_id, "would_share": [describe_file(relative, relative not in theirs) for relative in sorted(changed)],
                     "to": f"a request for engineering to add this to the {studio.shared.into} branch",
                     "request": "updates the request already open" if entry and entry.get("pull_request") else "opens a new request",
                     "refreshed": fetched, "note": "Nothing has been sent."})
    if not entry or entry.get("digest") != digest or not entry.get("commit"):
        count = len(wave.get("slices") or [])
        message = f"product({wave_id}): {count} slice{'s' if count != 1 else ''} approved for engineering"
        try:
            commit = collab.build_commit(studio.project, studio.shared, studio.home / "publish" / wave_id,
                                         remote_branch if on_remote else str(studio.shared.ref), changed, message,
                                         lambda tree: validate_tree(studio, tree, wave))
        except collab.CollabError as exc:
            raise StudioError(str(exc))
        collab.git(studio.project, "update-ref", f"refs/mach/studio/{wave_id}", commit)  # keeps the commit until it is pushed
        entry = {"branch": branch, "digest": digest, "commit": commit, "pushed": False, "sent_at": None,
                 "pull_request": (entry or {}).get("pull_request"), "files": sorted(changed)}
        ledger["waves"][wave_id] = entry
        studio.save_ledger(ledger)
    if not entry.get("pushed"):
        pushed = collab.git(studio.project, "push", collab.REMOTE, f"{entry['commit']}:refs/heads/{branch}")
        if pushed.returncode != 0:
            raise StudioError(f"{wave_id} is prepared but could not be sent: {collab.last_line(pushed)}. Run send again; nothing will be sent twice.")
        entry.update({"pushed": True, "sent_at": now(None)})
        studio.save_ledger(ledger)
    request_problem = ""
    if not entry.get("pull_request"):
        title, body = request_text(studio, wave)
        request, request_problem = collab.open_pull_request(studio.project, studio.shared, branch, title, body)
        if request:
            entry["pull_request"] = request
            studio.save_ledger(ledger)
    request = entry.get("pull_request") or {}
    return emit({"sent": True, "wave_id": wave_id, "shared": [describe_file(relative, relative not in theirs) for relative in sorted(changed)],
                 "status": "Waiting for review" if request else "Sent, pull request not opened",
                 "pull_request": request.get("url"), "branch": branch,
                 "problem": request_problem or None, "factory_authorized": False,
                 "note": "Engineering has been asked to accept this. No engineering work has started."})


def cmd_feedback(studio: Studio, args: argparse.Namespace) -> int:
    fetched, _ = studio.shared.fetch() if studio.shared.has_remote else (False, "")
    studio.shared = collab.Shared(studio.project, studio.cell.load_config(studio.project))
    studio._theirs = None
    studio.sync()
    ledger = studio.ledger()
    waves = studio.all("wave")
    if args.wave_id:
        studio.load("wave", args.wave_id)
    rows = []
    for wave_id in ([args.wave_id] if args.wave_id else sorted(waves)):
        wave = waves.get(wave_id) or {}
        entry = ledger["waves"].get(wave_id)
        row: Dict[str, Any] = {"wave_id": wave_id, "slices": wave.get("slices")}
        if not entry:
            published = studio.theirs().get(f"product/delivery-waves/{wave_id}.json") == (studio.draft / f"product/delivery-waves/{wave_id}.json").read_bytes()
            row.update(status="Accepted" if published and wave.get("status") == APPROVED else "Approved, not sent" if wave.get("status") == APPROVED else "Not approved yet")
        elif not entry.get("pushed"):
            row.update(status="Prepared, not sent", meaning="Sending did not finish. Send it again; nothing will be sent twice.")
        elif not entry.get("pull_request"):
            row.update(status="Sent, pull request not opened", branch=entry.get("branch"),
                       meaning="The work reached the shared repository but the request for review could not be opened. Send it again, or give an engineer the branch name.")
        else:
            view, problem = collab.review_state(studio.project, str(entry.get("branch")))
            if view is None:
                row.update(status="Sent", pull_request=entry["pull_request"].get("url"), meaning=f"The review status could not be read just now ({problem}).")
            else:
                row.update(collab.in_words(view))
            if wave.get("status") != APPROVED and row.get("status") not in ("Accepted", "Declined"):
                row["changed_since_sent"] = "You have reopened this wave since sending it. Approve and send it again to update the request."
        rows.append(row)
    return emit({"refreshed": fetched, "waves": rows})


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MACH Product Studio operations (drafts only; never starts Factory work)")
    parser.add_argument("--project", type=Path, help="project root (default: nearest folder with .factory/ or .git)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("where", help="print the workspace and the files the interview needs").set_defaults(func=cmd_where)
    sub.add_parser("status", help="every artifact with its state, and what to do next").set_defaults(func=cmd_status)
    sub.add_parser("validate", help="structural check of the whole workspace").set_defaults(func=cmd_validate)
    sub.add_parser("refresh", help="bring in what others have published; drafts are never lost").set_defaults(func=cmd_refresh)
    p = sub.add_parser("reconcile", help="settle a draft that disagrees with the shared project")
    p.add_argument("artifact", help="the path or ID listed under needs_reconciling")
    p.add_argument("--take", required=True, choices=("mine", "theirs"))
    p.add_argument("--field", help="settle one field of a project, epic, work order or wave")
    p.set_defaults(func=cmd_reconcile)
    p = sub.add_parser("send", help="ask engineering to accept an approved delivery wave")
    p.add_argument("wave_id")
    p.add_argument("--dry-run", action="store_true", help="show what would be shared; send nothing")
    p.set_defaults(func=cmd_send)
    p = sub.add_parser("feedback", help="how review of sent waves is going")
    p.add_argument("wave_id", nargs="?")
    p.set_defaults(func=cmd_feedback)

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
    p = epic.add_parser("renumber", help="give an unpublished draft the next free number")
    p.add_argument("identifier")
    p.set_defaults(func=cmd_renumber, kind="epic")

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
    p = slice_.add_parser("show", help="the work order, spec, why and current check in one read; changes nothing")
    p.add_argument("slice_id")
    p.set_defaults(func=cmd_slice_show)
    p = slice_.add_parser("approve")
    p.add_argument("slice_id")
    p.set_defaults(func=cmd_slice_approve)
    p = slice_.add_parser("reopen")
    p.add_argument("slice_id")
    p.set_defaults(func=cmd_slice_reopen)
    p = slice_.add_parser("renumber", help="give an unpublished draft the next free number")
    p.add_argument("identifier")
    p.set_defaults(func=cmd_renumber, kind="slice")

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
    p = wave.add_parser("renumber", help="give an unpublished draft the next free number")
    p.add_argument("identifier")
    p.set_defaults(func=cmd_renumber, kind="wave")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        cell, _ = intent_modules()
        project = (args.project or cell.find_project(Path.cwd())).resolve()
        if not project.is_dir():
            raise StudioError(f"{project} is not a folder.")
        return args.func(Studio(project), args)
    except (StudioError, collab.CollabError) as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # CellError and friends from the intent skill
        if exc.__class__.__name__ == "CellError":
            print(f"refused: {exc}", file=sys.stderr)
            return 1
        raise


if __name__ == "__main__":
    sys.exit(main())
