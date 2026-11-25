"""Versions a product manager's act replaced, kept so a person can get them back (never blocked).

When a product manager marks their text ready over a newer version someone else saved, publishes their principles or
technical needs over a newer set, opens a slice over other text in the workspace, or brings in a project over a file they
changed, the other version is written here first, whole, and never overwritten:

    .factory/studio/replaced/<what>-<UTC time>[-n]/   the files as they were, and kept.json saying what they are

`replaced list` lists them, newest first. `replaced restore <name>` puts one back in one act: the current text is kept here
first in the same way, so nothing is lost either way, and a slice or set that comes back is a draft, never approved or
published by it. Standard library only. Imported by handoff.py and studio.py.
"""

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

FOLDER = "replaced"
NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,150}")


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def keep(home: Path, write: Callable[[Path, str], None], name: str, files: Dict[str, str], meta: Dict[str, Any]) -> Path:
    """Write `files` into a new folder under .factory/studio/replaced/, named for what they are and when, with a counter if that
    name is taken. An existing folder is never written to. kept.json records `meta` (what, and how it comes back), the file
    names and the time."""
    base = home / FOLDER
    target = base / f"{name}-{stamp()}"
    count = 2
    while target.exists():
        target = base / f"{name}-{stamp()}-{count}"
        count += 1
    for file_name, text in files.items():
        write(target / file_name, text)
    record = {"schema_version": 1, "name": target.name, **meta, "files": sorted(files), "kept_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    write(target / "kept.json", json.dumps(record, indent=2, sort_keys=True, ensure_ascii=False) + "\n")
    return target


def listing(home: Path, project: Path) -> List[Dict[str, Any]]:
    """Every kept version, newest first, with where it is."""
    base = home / FOLDER
    rows = []
    for folder in sorted(base.iterdir()) if base.is_dir() and not base.is_symlink() else []:
        if not folder.is_dir() or folder.is_symlink():
            continue
        try:
            record = json.loads((folder / "kept.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            record = {"what": "unknown"}
        if not isinstance(record, dict):
            record = {"what": "unknown"}
        rows.append({**record, "name": folder.name, "where": str(folder.relative_to(project)) + "/",
                     "restorable": record.get("what") in RESTORABLE})
    return sorted(rows, key=lambda row: str(row.get("kept_at") or ""), reverse=True)


RESTORABLE = ("slice", "principles", "needs", "files")


def find(home: Path, project: Path, name: str) -> Dict[str, Any]:
    rows = listing(home, project)
    row = next((row for row in rows if row["name"] == name), None)
    if row is None:
        row = next((row for row in rows if row["name"].startswith(name)), None) if NAME_RE.fullmatch(name or "") else None
    if row is None:
        raise LookupError(name)
    return row


def words(row: Dict[str, Any]) -> str:
    """One line a person reads about a kept version."""
    what = row.get("what")
    who = f"@{row['by']}'s " if row.get("by") else ""
    version = f"version {row['revision']} of " if row.get("revision") else ""
    issue = f" (#{row['issue']})" if row.get("issue") else ""
    if what == "slice":
        subject = f"{who}{version}{row.get('slice_id')}{issue}" if row.get("from") != "yours" else f"your draft of {row.get('slice_id')}"
    elif what in ("principles", "needs"):
        subject = f"{who}{version}the {'principles' if what == 'principles' else 'technical needs'}{issue}"
    elif what == "project_issue":
        subject = f"the project's issue text{issue}, not in the form MACH writes"
    elif what == "files":
        subject = row.get("about") or "files from your workspace"
    else:
        subject = "a kept version"
    return f"{subject[0].upper() + subject[1:]}, kept {str(row.get('kept_at') or '')[:16].replace('T', ' ')} UTC at {row['where']}"


def read_files(folder: Path, names: List[str]) -> Dict[str, str]:
    found = {}
    for name in names:
        path = folder / name
        if path.is_file() and not path.is_symlink():
            found[name] = path.read_text(encoding="utf-8", errors="replace")
    return found


def restore(host: Any, studio: Any, name: str) -> Dict[str, Any]:
    """Put a kept version back in one act. What is there now is kept first, in the same way."""
    home, project = studio.home, studio.project
    try:
        row = find(home, project, name)
    except LookupError:
        raise host.StudioError(f"No kept version is called '{name}'. " + host.say("See them with: replaced list.", "The list shows every kept version."))
    folder = project / row["where"]
    files = read_files(folder, [n for n in row.get("files") or []])
    what = row.get("what")
    if what == "slice":
        slice_id = str(row.get("slice_id") or "")
        if not studio.path("slice", slice_id).is_file():
            raise host.StudioError(f"{slice_id} is not in your workspace now, so its kept text has nowhere to go. Nothing was changed. "
                                   f"Open it here first{host.say(f' (slice take {slice_id})', '')}, then put this version back.")
        if "spec.md" not in files or "why.md" not in files:
            raise host.StudioError(f"This kept version of {slice_id} holds only the issue as GitHub had it, not a why and a specification MACH can "
                                   f"put back. Nothing was changed. Read it at {row['where']}issue.md.")
        spec, intent = studio.spec_of(slice_id), studio.intent_path(slice_id)
        now = {n: p.read_text(encoding="utf-8") for n, p in (("spec.md", spec), ("why.md", intent)) if p is not None and p.is_file()}
        mine = keep(home, host.write, f"{slice_id}-yours", now, {"what": "slice", "slice_id": slice_id, "from": "yours"}) if now else None
        data = studio.load("slice", slice_id)
        target = spec or studio.draft / "specs" / "slices" / f"{slice_id}-{host.kebab(data.get('title') or 'slice')}.md"
        host.write(target, files["spec.md"])
        host.write(intent, files["why.md"])
        data = studio.load("slice", slice_id)
        withdrawn = data.get("status") == host.APPROVED
        result = studio.check_slice(slice_id, ready=True)
        data.update(status="ready_for_approval" if result["ready"] else "interviewing", open_questions=result["open_questions"],
                    spec_path=studio.relative(studio.spec_of(slice_id)), spec_sha256=None)
        studio.save("slice", data)
        if withdrawn:
            studio.note_withdrawn({slice_id: "You put a kept version back, which replaces the text you approved."})
        note = (f"{slice_id}'s draft now holds the kept version from {row['where']}. It is a draft, not approved: read it, then mark it ready "
                "to approve it.")
    elif what in ("principles", "needs"):
        try:
            record = json.loads(files[f"{what}.json"])
            items = record[what]
        except (KeyError, ValueError, TypeError):
            raise host.StudioError(f"The kept {what} at {row['where']} cannot be read. Nothing was changed.")
        if what == "principles":
            current = studio.principles()
            mine = keep(home, host.write, "principles-yours", {"principles.json": host.canonical({"principles": current})}, {"what": "principles", "from": "yours"})
            studio.save_principles(items, "Putting kept principles back")
            note = f"Your principles now are the kept version from {row['where']}. They are not published: publish them to give them to the builders."
        else:
            import needs
            current, none = needs.load(host, studio)
            mine = keep(home, host.write, "needs-yours", {"needs.json": host.canonical({"needs": current, "none": none})}, {"what": "needs", "from": "yours"})
            needs.save(host, studio, items, list(record.get("none") or []), "Putting kept technical needs back")
            note = f"Your technical needs now are the kept version from {row['where']}. They are not published: publish them to give them to the engineer."
    elif what == "files":
        places = row.get("to") or {}
        now = {}
        for file_name, rel in places.items():
            path = studio.draft / str(rel)
            if path.is_file() and not path.is_symlink() and path.read_text(encoding="utf-8", errors="replace") != files.get(file_name):
                now[file_name] = path.read_text(encoding="utf-8", errors="replace")
        mine = keep(home, host.write, "workspace-yours", now, {"what": "files", "about": "files your workspace held", "to": {n: places[n] for n in now}}) if now else None
        for file_name, rel in places.items():
            if file_name in files:
                host.write(studio.draft / str(rel), files[file_name])
        note = f"The kept files from {row['where']} are back in your workspace: " + ", ".join(str(rel) for rel in places.values()) + "."
    else:
        raise host.StudioError(f"The version kept at {row['where']} is text MACH cannot put back by itself (the project's issue as GitHub had it). "
                               "Nothing was changed. Read it there, and change your project to match if you want it.")
    kept = {"kept_yours": str(mine.relative_to(project)) + "/"} if mine else {}
    if mine:
        note += f" What you had is kept at {kept['kept_yours']}."
    return {"restored": row["name"], "what": what, **kept, "factory_authorized": False, "note": note}
