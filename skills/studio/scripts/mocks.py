"""Product Studio's design mocks (M14 part C): an approved picture bound to an interface slice.

A product manager attaches up to four pictures to a slice (`slice mock add`), each tied to one of the spec's scenarios
(`--for AC-NN`) or to the slice as a whole, and marks a mock binding for its scenario (`--binding`). The picture is copied
into the draft workspace, product/mocks/SLICE-NNN/<sha256>.<ext>, and the work order records its SHA-256, format, size in
pixels and bytes, scenario, binding and note. Nothing is generated, fetched or sent here.

How the picture reaches the builders (`slice ready`):

- **The ready folder.** The pictures travel inside the folder, product/ready/SLICE-NNN/mocks/<sha256>.<ext>, and
  slice.json lists them.
- **A slice saved as a GitHub issue.** An issue cannot carry a picture MACH can check, so the issue names each picture by
  its SHA-256 (the marker carries the digest of the list and the approval approves it), and Studio writes the pictures to
  product/ready/SLICE-NNN/mocks/ in the workspace for the product manager (or an engineer) to commit to the main branch.
  The Factory holds the slice, "waiting for its design mocks", until every picture the approval names is there and
  matches.

A picture is always checked by its content (a whole PNG or JPEG, bounded in size and dimensions) and by its SHA-256, with
the ticket station's shared rules (issue_rules.image_facts, check_mock_file). The scenarios stay the authority: a mock is
never a requirement on its own.

Standard library only. Imported by studio.py; not a command of its own. Reaches neither Git nor GitHub.
"""

import argparse
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

READ_LIMIT_SLACK = 1  # read one byte past the limit, so an oversized file is refused without reading it all


def folder(studio: Any, slice_id: str) -> Path:
    return studio.draft / "product" / "mocks" / slice_id


def listed(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    items = data.get("mocks")
    return [dict(item) for item in items] if isinstance(items, list) else []


def scenario_ids(host: Any, studio: Any, slice_id: str) -> List[str]:
    """The scenario IDs the slice's spec has now, as the intent station's validator reads them."""
    spec = studio.spec_of(slice_id)
    if spec is None:
        return []
    _, model = studio.analyze(spec, ready=False)
    return [str(item.get("id")) for item in model.get("scenarios") or [] if isinstance(item, dict) and item.get("id")]


def read_picture(host: Any, rules: Any, path: Path) -> Tuple[bytes, Dict[str, Any]]:
    """A picture the product manager names on this computer: a plain file, checked by its content, never by its name."""
    if path.is_symlink() or not path.is_file():
        raise host.StudioError(f"{path} is not a file on this computer. Name the picture's file, such as ~/Desktop/invite-screen.png.")
    with path.open("rb") as handle:
        data = handle.read(rules.MOCK_MAX_BYTES + READ_LIMIT_SLACK)
    facts, problem = rules.image_facts(data)
    if facts is None:
        raise host.StudioError(f"{path.name} cannot be a design mock: {problem}. A design mock is a PNG or JPEG picture of at most "
                               f"{rules.MOCK_MAX_BYTES // (1024 * 1024)} MB and {rules.MOCK_MAX_SIDE} pixels a side.")
    return data, facts


def write_picture(host: Any, target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_bytes(data)
    os.replace(str(temporary), str(target))


def drop_unused(studio: Any, slice_id: str, keep: List[Dict[str, Any]], rules: Any) -> None:
    """Remove pictures in the workspace that the work order no longer lists."""
    names = {rules.mock_file_name(item) for item in keep}
    where = folder(studio, slice_id)
    if where.is_dir() and not where.is_symlink():
        for path in where.iterdir():
            if path.is_file() and path.name not in names:
                path.unlink()
        if not any(where.iterdir()):
            where.rmdir()


def cmd_add(host: Any, studio: Any, args: argparse.Namespace) -> Dict[str, Any]:
    rules = host.ticket_rules()
    data = host.require_editable(studio, args.slice_id)
    items = listed(data)
    if len(items) >= rules.MOCK_LIMIT:
        raise host.StudioError(f"{args.slice_id} already has {rules.MOCK_LIMIT} design mocks, the most a slice can have. Remove one first.")
    picture, facts = read_picture(host, rules, Path(args.image).expanduser())
    if any(item["sha256"] == facts["sha256"] for item in items):
        raise host.StudioError(f"That picture is already attached to {args.slice_id}.")
    scenario = args.scenario
    if scenario is not None:
        known = scenario_ids(host, studio, args.slice_id)
        if not rules.SCENARIO_ID_RE.fullmatch(scenario) or scenario not in known:
            raise host.StudioError(f"'{scenario[:20]}' is not a scenario in {args.slice_id}'s spec. "
                                   + (f"Its scenarios are {', '.join(known)}." if known else "Write the spec's scenarios first."))
    if args.binding and scenario is None:
        raise host.StudioError(host.say("A binding mock is binding for one scenario: name it with --for AC-NN.",
                                        "A binding mock is binding for one scenario: choose the scenario it shows."))
    note = " ".join(args.note.split()) if args.note else None
    if note is not None and not rules.is_mock_note(note):
        raise host.StudioError(f"The note must be one line of plain text, at most {rules.MOCK_NOTE_LIMIT} characters, without ` < or >.")
    item = {**facts, "for": scenario, "binding": bool(args.binding), "note": note}
    items = sorted(items + [item], key=lambda entry: entry["sha256"])
    write_picture(host, folder(studio, args.slice_id) / rules.mock_file_name(item), picture)
    data["mocks"] = items
    try:
        studio.commit_or_restore([("slice", data)], "Adding the design mock")
    finally:
        drop_unused(studio, args.slice_id, listed(studio.load("slice", args.slice_id)), rules)
    return {"slice": studio.load("slice", args.slice_id), "mock": item, "factory_authorized": False,
            "note": host.say(f"Attached to {args.slice_id}" + (f" for {scenario}" + (", binding" if args.binding else "") if scenario else " as a whole")
                             + ". It goes to the builders with the slice when you mark it ready; the scenarios stay the authority.",
                             f"Attached to {args.slice_id}. It goes to the builders with the slice when you mark it ready.")}


def find(host: Any, items: List[Dict[str, Any]], slice_id: str, given: str) -> Dict[str, Any]:
    wanted = given.strip().lower()
    for suffix in (".png", ".jpg"):
        wanted = wanted[:-len(suffix)] if wanted.endswith(suffix) else wanted
    matches = [item for item in items if len(wanted) >= 8 and item["sha256"].startswith(wanted)]
    if len(matches) != 1:
        raise host.StudioError(host.say(f"No single design mock of {slice_id} starts with '{given[:70]}'. Name it by the start of its SHA-256 "
                                        "(at least 8 characters), as `slice mock list` shows it.",
                                        f"No single design mock of {slice_id} starts with '{given[:70]}'. It may have been removed already; "
                                        "the slice's Design mocks page lists the ones it has."))
    return matches[0]


def cmd_remove(host: Any, studio: Any, args: argparse.Namespace) -> Dict[str, Any]:
    rules = host.ticket_rules()
    data = host.require_editable(studio, args.slice_id)
    items = listed(data)
    gone = find(host, items, args.slice_id, args.mock)
    items = [item for item in items if item["sha256"] != gone["sha256"]]
    if items:
        data["mocks"] = items
    else:
        data.pop("mocks", None)
    studio.commit_or_restore([("slice", data)], "Removing the design mock")
    drop_unused(studio, args.slice_id, items, rules)
    return {"slice": studio.load("slice", args.slice_id), "removed": gone, "factory_authorized": False,
            "note": f"Removed from {args.slice_id}. Nothing was sent anywhere."}


def cmd_list(host: Any, studio: Any, args: argparse.Namespace) -> Dict[str, Any]:
    """The slice's mocks, each with whether its picture is in the workspace unchanged and its scenario is still in the spec. Changes nothing."""
    rules = host.ticket_rules()
    data = studio.load("slice", args.slice_id)
    scenarios = scenario_ids(host, studio, args.slice_id)
    rows = []
    for item in listed(data):
        path = folder(studio, args.slice_id) / rules.mock_file_name(item)
        problem = None if path.is_file() and not path.is_symlink() else "its picture is missing from the workspace"
        problem = problem or rules.check_mock_file(item, path.read_bytes())
        if problem is None and item["for"] is not None and item["for"] not in scenarios:
            problem = f"the spec no longer has {item['for']}"
        rows.append({**item, "file": host.say(str(path), rules.mock_file_name(item)), "problem": problem})
    return {"slice_id": args.slice_id, "mocks": rows, "limit": rules.MOCK_LIMIT, "factory_authorized": False}


def for_ready(host: Any, studio: Any, slice_id: str, data: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, bytes]]:
    """The mocks a slice is marked ready with, and their bytes, each checked again; ([], {}) for a slice without mocks."""
    items = listed(data)
    if not items:
        return [], {}
    rules = host.ticket_rules()
    problems = [f"design mocks: {problem}" for problem in rules.mock_problems(items)]
    scenarios = scenario_ids(host, studio, slice_id)
    files: Dict[str, bytes] = {}
    for item in items if not problems else []:
        name = rules.mock_file_name(item)
        path = folder(studio, slice_id) / name
        problem = None if path.is_file() and not path.is_symlink() else "its picture is missing from the workspace"
        problem = problem or rules.check_mock_file(item, path.read_bytes())
        if problem is None and item["for"] is not None and item["for"] not in scenarios:
            problem = f"it is for {item['for']}, which the spec no longer has"
        if problem:
            problems.append(f"design mock {item['sha256'][:12]}: {problem}; remove it and attach it again")
        else:
            files[name] = path.read_bytes()
    if problems:
        raise host.StudioError(f"{slice_id} cannot be marked ready yet:\n  " + "\n  ".join(problems))
    return items, files


def deliver(host: Any, studio: Any, slice_id: str, items: List[Dict[str, Any]], files: Dict[str, bytes]) -> Optional[Dict[str, Any]]:
    """For a slice saved as an issue: the pictures written to product/ready/SLICE-NNN/mocks/ in the workspace, for the product
    manager to commit to the main branch. Earlier pictures there are replaced. None for a slice without mocks."""
    target = studio.draft / "product" / "ready" / slice_id / "mocks"
    if target.is_symlink() or target.parent.is_symlink():
        raise host.StudioError(f"{target} is a symbolic link. Product Studio only writes into real folders.")
    if target.is_dir():
        for path in target.iterdir():
            if path.is_file() and path.name not in files:
                path.unlink()
    if not items:
        if target.is_dir() and not any(target.iterdir()):
            target.rmdir()
        if target.parent.is_dir() and not any(target.parent.iterdir()):
            target.parent.rmdir()
        return None
    for name, data in files.items():
        write_picture(host, target / name, data)
    relative = f"product/ready/{slice_id}/mocks/"
    return {"folder": str(target), "commit_as": relative, "files": sorted(files), "factory_waits": True,
            "note": host.say(f"The builders hold {slice_id} until its design mocks are on the main branch. Commit the folder "
                             f"{target.relative_to(studio.draft)} to the repository at {relative}, with nothing else in it, or hand it to an engineer to commit.",
                             f"The builders hold {slice_id} until its design mocks are in the project's repository, at {relative}.")}


def for_take(host: Any, studio: Any, slice_id: str, number: int, items: List[Dict[str, Any]], into: Optional[str] = None) -> Tuple[bool, Optional[str]]:
    """`slice take` of an issue with design mocks: the pictures are files on the main branch, not in the issue. Each is read as project
    export reads it (this workspace's copy, else product/ready/SLICE-NNN/mocks/ on the main branch as this copy last fetched it) and
    checked against the approved SHA-256, then written into the draft's mocks folder. (True, None) when every one came; otherwise
    (False, the warning that says the slice opens without them and how they come)."""
    import project_export  # reads the main branch with Git, never touching the checkout
    rules = host.ticket_rules()
    ref = project_export._main_ref(studio)  # noqa: SLF001
    files: Dict[str, bytes] = {}
    for item in items:
        name = rules.mock_file_name(item)
        data = project_export._picture(host, studio, ref, slice_id, name)  # noqa: SLF001
        if data is None or rules.check_mock_file(item, data) is not None:
            return False, host.say(
                f"#{number} has design mocks, and their pictures are not on {ref} in this copy of the repository, or are not the approved ones. "
                f"So {slice_id} is open here without them, as a draft, not as approved. To bring them, fetch the main branch (git fetch) and open "
                f"#{number} again (slice take {number}); or add them again (slice mock add {slice_id} <picture>).",
                f"#{number} has design mocks, and their pictures are not in this copy of the project's repository yet. So {slice_id} is open here "
                f"without them, as a draft, not as approved. To bring them, get the latest from the repository and open #{number} again; or add "
                "the pictures again.")
        files[name] = data
    for name, data in files.items():
        write_picture(host, folder(studio, into or slice_id) / name, data)
    return True, None


def add_commands(slice_parsers: Any, host: Any) -> None:
    """`slice mock add|remove|list`, wired into studio.py's `slice` commands. `host` is studio.py's own module."""
    def run(handler: Any, prepare: bool) -> Any:
        def call(studio: Any, args: argparse.Namespace) -> int:
            if prepare:
                studio.prepare()
            return host.emit(handler(host, studio, args))
        return call

    group = slice_parsers.add_parser("mock", help="design mocks: approved pictures bound to the slice's scenarios").add_subparsers(
        dest="mock_action", required=True, metavar="{add,remove,list}")
    p = group.add_parser("add", help="attach a PNG or JPEG picture to a slice (only on the product manager's word)")
    p.add_argument("slice_id")
    p.add_argument("image", help="the picture's file on this computer")
    p.add_argument("--for", dest="scenario", metavar="AC-NN", help="the scenario it shows; without it, the slice as a whole")
    p.add_argument("--binding", action="store_true", help="the built screen must match it for that scenario; a difference fails verification")
    p.add_argument("--note", help="one line for the builders, such as what the picture shows")
    p.set_defaults(func=run(cmd_add, prepare=True))
    p = group.add_parser("remove", help="take a design mock off a slice (only on the product manager's word)")
    p.add_argument("slice_id")
    p.add_argument("mock", metavar="SHA256-START", help="the start of the picture's SHA-256, at least 8 characters")
    p.set_defaults(func=run(cmd_remove, prepare=True))
    p = group.add_parser("list", help="the slice's design mocks and whether each is still sound; changes nothing")
    p.add_argument("slice_id")
    p.set_defaults(func=run(cmd_list, prepare=False))
