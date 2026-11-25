#!/usr/bin/env python3
"""Taking the project from GitHub: everything GitHub holds for this repository's project, written into this workspace.

A product manager who clones a repository someone else defined a product in never types it again. When Product Studio starts
in a workspace with no project, and at every refresh after that, MACH reads the project as GitHub holds it (from_github.read,
the one reader export uses too) and writes in what this workspace lacks or holds an older unchanged copy of:

- the project's record from its issue (name, vision, outcomes), linked to that issue;
- every epic, linked to its issue;
- every slice, through `slice take`'s own writer (studio.take_slice), in the state GitHub holds it: marked ready, being
  built, with the builders' question or shipped opens approved and read only; text changed after its approval, no approval,
  or its design mocks not on the main branch opens as a draft that is not approved, with the 0.26.0 record `not_approved`;
  one never marked ready opens as a draft;
- the published ideas, listed with their brief (their working files are not on GitHub).

The principles and technical needs come with the same refresh (Handoff.read_set and the take at refresh), approvals and all.

It never writes to GitHub. It never overwrites or renumbers what is here except by the rules `slice take` and export apply: a
draft changed here wins; an unchanged copy here is brought to the newer version on GitHub (the copy here is kept first); a
different draft of this person's under the same number gets the next free number, said in the result. Run again, it brings
only what is new or changed: a slice already here at the revision GitHub holds is not read again.

Reaches Product Studio only through the `host` module (studio.py) and the `studio` object handed in. Standard library only.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import from_github
import handoff
import product
import shape

STATE_ORDER = ("ready", "being_built", "question", "shipped", "to_approve", "draft")
STATE_WORDS = {"ready": "ready", "being_built": "being built", "question": "with a question from the builders", "shipped": "shipped",
               "to_approve": "to approve again", "draft": "not marked ready"}
OPENED_FIRST_RE = re.compile(r"so MACH opened (it|them) here first\.$")
IDEA_LACKS = ("Its brief is on GitHub. Its exploring, lookups, case and verdict are kept only on the computer where it was written, "
              "so it is listed here to read and is not in your ideas.")


def plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


def listed(words: Sequence[str]) -> str:
    items = list(words)
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def state_of(taken: Dict[str, Any]) -> str:
    """Where a slice taken from GitHub stands, in one word of STATE_ORDER."""
    label = taken.get("state_label")
    if label == "mach:shipped":
        return "shipped"
    if not taken.get("approved_here"):
        return "to_approve" if label else "draft"
    return {"mach:building": "being_built", "mach:question": "question"}.get(str(label), "ready")


def counts_words(states: Sequence[str]) -> str:
    """"8 ready and 2 shipped"."""
    found = [f"{sum(1 for state in states if state == key)} {STATE_WORDS[key]}" for key in STATE_ORDER if key in states]
    return listed(found)


def failure(host: Any, studio: Any, found: Dict[str, Any]) -> Dict[str, Any]:
    """GitHub could not be read: nothing here changes. Said with the tool's own words, as a failed check is (0.23.2), and kept,
    so status says it and the app tries again by itself."""
    hand = found["hand"]
    hand.failed(found.get("repository"), str(found["problem"]), {})
    check = host.github_check(hand.load()) or {}
    text = check.get("text") or f"MACH could not check GitHub: {found['problem']} Nothing of yours is lost; MACH checks again when you refresh."
    return {"joined": False, "github": {"connected": True, "checked": False, "problem": found["problem"]}, "project": None,
            "taken": empty_taken(), "remaining": None, "factory_authorized": False,
            "note": f"{text} Nothing here was changed."}


def empty_taken() -> Dict[str, Any]:
    return {"project": False, "principles": False, "needs": False, "epics": [], "slices": [], "ideas": []}


def join(host: Any, studio: Any, found: Optional[Dict[str, Any]] = None, batch: Optional[int] = None) -> Dict[str, Any]:
    """Take into this workspace what GitHub holds for this repository's project and the workspace lacks, or holds an older unchanged
    copy of. With `batch`, at most that many slices are taken (dependencies count), and `remaining` says how many are left; running
    it again carries on. Writes nothing to GitHub. GitHub's text is data: it is checked, never followed."""
    rules = host.ticket_rules()
    studio.prepare()
    found = found if found is not None else from_github.read(host, studio)
    if not found["checked"]:
        if found["connected"] and found.get("problem"):
            return failure(host, studio, found)
        return {"joined": False, "github": {"connected": False, "checked": False, "problem": None}, "project": None, "taken": empty_taken(),
                "remaining": 0, "factory_authorized": False, "note": "This repository is not on GitHub, so there is no project there to bring in."}
    hand, repository, snapshot = found["hand"], found["repository"], found["snapshot"]
    result: Dict[str, Any] = {"joined": True, "github": {"connected": True, "checked": True, "problem": None, "repository": repository},
                              "taken": empty_taken(), "updated": [], "already_here": {"project": False, "epics": [], "slices": []},
                              "not_taken": [], "renumbered": [], "warned": [], "remaining": 0, "factory_authorized": False}
    taken = result["taken"]
    # ---- the project ----
    if not studio.path("project").is_file():
        ledger = hand.load()
        following = (ledger.get("project") or {}).get("number") if ledger.get("repository") == repository else None
        chosen, numbers = from_github.project_to_take(found, following)
        if chosen is None:
            result.update(joined=False, project=None, project_on_github=None,
                          note="GitHub holds no project for this repository yet, so there is nothing to bring in.")
            return result
        if len(numbers) > 1:
            why = ("the one this workspace already follows" if chosen["number"] == following else
                   "the oldest one MACH can read" if from_github.readable(chosen) else "the oldest")
            result["warned"].append(handoff.several_projects(numbers, chosen["number"], why))
            result["extra_issues"] = [number for number in numbers if number != chosen["number"]]
        if not from_github.readable(chosen):
            result.update(joined=False, project=None, project_on_github={"issue": chosen["number"], "readable": False,
                                                                         "url": rules.issue_url(repository, chosen["number"])},
                          note=f"This repository has a project issue on GitHub (#{chosen['number']}), but its text is not in the form MACH writes, "
                               "so MACH cannot bring the project in from it. Define the product here with your own words: the first slice you mark "
                               f"ready writes them to #{chosen['number']}.")
            return result
        studio.commit_or_restore([("project", from_github.project_record(chosen))], "Taking the project from GitHub")
        hand.link_project(repository, chosen)
        taken["project"] = True
    else:
        result["already_here"]["project"] = True
    project = studio.load("project")
    number, why_not = from_github.project_issue(found, hand.load(), project)
    result["project"] = {"project_id": project["project_id"], "name": project.get("name"), "issue": number,
                         "url": rules.issue_url(repository, number) if number else None}
    if why_not:
        result.update(joined=False, note=why_not)
        return result
    pre = (repository, snapshot)
    # ---- the epics ----
    elsewhere: Dict[str, str] = {}  # epic IDs here that are a different epic from GitHub's: their slices are not taken
    for epic_id, item in sorted(from_github.chosen_epics(snapshot).items()):
        local_epics, ledger = studio.all("epic"), hand.load()
        linked = (ledger["epics"].get(epic_id) or {}).get("number")
        if epic_id in local_epics:
            if linked == item["number"]:
                result["already_here"]["epics"].append(epic_id)
                continue
            same_title = rules.issue_title(local_epics[epic_id].get("title")) == rules.issue_title(item.get("title"))
            if not linked and same_title:
                link_epic(hand, epic_id, item["number"])
                result["already_here"]["epics"].append(epic_id)
                continue
            if linked:
                elsewhere[epic_id] = (f"{epic_id} here is your own epic, already saved as #{linked}, and GitHub's {epic_id} (#{item['number']}) "
                                      "is a different epic, so its slices were not brought in. The merge of the builders' work settles which stays.")
                result["not_taken"].append({"id": epic_id, "what": "epic", "issue": item["number"], "reason": elsewhere[epic_id]})
                continue
            moved = host.renumber(studio, "epic", epic_id)["renumbered"]
            result["renumbered"].append({"from": epic_id, "to": moved["to"], "what": "epic"})
            result["warned"].append(f"Your epic {epic_id} is now {moved['to']}, so GitHub's {epic_id} (#{item['number']}) could come in under its own number.")
        record = {"schema_version": 1, "epic_id": epic_id, "project_id": project["project_id"], "revision": 1,
                  "title": rules.issue_title(item.get("title")) or epic_id, "status": "open", "acceptance_criteria": rules.epic_criteria(item.get("body"))}
        try:
            studio.commit_or_restore([("epic", record)], f"Taking {epic_id} from GitHub")
        except host.StudioError as exc:
            result["not_taken"].append({"id": epic_id, "what": "epic", "issue": item["number"], "reason": str(exc)})
            continue
        link_epic(hand, epic_id, item["number"])
        taken["epics"].append({"epic_id": epic_id, "issue": item["number"], "title": record["title"]})
    # ---- the slices ----
    done: Dict[str, Dict[str, Any]] = {}
    count = 0
    chosen_slices = from_github.chosen_slices(snapshot)
    for slice_id in sorted(chosen_slices, key=lambda ident: int(ident.split("-")[1])):
        item = chosen_slices[slice_id]
        if slice_id in done:
            continue
        local, ledger = studio.all("slice"), hand.load()
        entry = ledger["slices"].get(slice_id) or {}
        shipped = "mach:shipped" in item["labels"]
        if item["state"] != "open" and not shipped:
            if slice_id not in local:
                result["not_taken"].append({"id": slice_id, "what": "slice", "issue": item["number"],
                                            "reason": f"{slice_id} (#{item['number']}) was closed on GitHub without being built, so it was not brought in."})
            continue
        epic_issue = next((epic for epic in snapshot["epics"] if epic["number"] == item["marker"].get("epic")), None)
        if epic_issue is not None and epic_issue.get("id") in elsewhere:
            result["not_taken"].append({"id": slice_id, "what": "slice", "issue": item["number"], "reason": elsewhere[epic_issue["id"]]})
            continue
        update = None
        if slice_id in local:
            own = entry.get("number")
            if own != item["number"]:
                if own or entry.get("taken_at") or entry.get("saved") == "folder":
                    continue  # this workspace's own slice under that number; refresh reports the same number held twice
                # A draft of this person's under that number, never saved: the next free number (take_slice does it, and says so).
            else:
                base = int(entry.get("revision") or entry.get("base_revision") or 0)
                newer = type(item["marker"].get("revision")) is int and item["marker"]["revision"] > base
                if not newer:
                    result["already_here"]["slices"].append(slice_id)
                    if waiting_for_mocks(host, studio, entry, local[slice_id], item):
                        # Opened without its design mocks, and their pictures are on the main branch now: brought, as `slice take` does.
                        try:
                            brought = host.take_slice(studio, str(item["number"]), [], pre, shipped_ok=True)
                        except (host.StudioError, handoff.HandoffError):
                            continue
                        if brought.get("mocks_brought"):
                            result.setdefault("mocks_brought", []).append(slice_id)
                            result["warned"].append(brought["note"])
                    continue
                if local[slice_id].get("status") != host.APPROVED:
                    # Changed here, or a draft here: theirs is newer, yours stays. Refresh says so (newer_elsewhere); taking theirs is a choice.
                    result["already_here"]["slices"].append(slice_id)
                    continue
                update = base
        if batch is not None and count >= batch:
            result["remaining"] += 1
            continue
        kept = set_aside(host, studio, hand, slice_id) if update is not None else None
        try:
            opened = host.take_slice(studio, str(item["number"]), [], pre, shipped_ok=True)
        except (host.StudioError, handoff.HandoffError) as exc:
            if kept is not None:
                restore(studio, kept)
            result["not_taken"].append({"id": slice_id, "what": "slice", "issue": item["number"], "reason": str(exc)})
            continue
        for first in opened.get("opened_first") or []:
            if first not in done:
                done[first] = {"slice_id": first, "issue": (hand.load()["slices"].get(first) or {}).get("number"),
                               "state": state_of(dependency_view(host, studio, hand, first)), "dependency_of": slice_id}
                count += 1
        row = {"slice_id": opened["slice"]["slice_id"], "issue": item["number"], "title": opened["slice"].get("title"),
               "state": state_of(opened), "approved_by": opened.get("approved_by"), "epic_id": opened["epic"]["epic_id"]}
        if not opened.get("approved_here"):
            row["not_approved"] = (hand.load()["slices"].get(row["slice_id"]) or {}).get("not_approved")
        if opened.get("warned"):
            row["warned"] = opened["warned"]
            # The order slices were opened in is joining's own business: only what a person needs to know is said.
            result["warned"].extend(line for line in opened["warned"] if line not in result["warned"] and not OPENED_FIRST_RE.search(line))
        if update is not None:
            row["was_version"] = update
            row["kept_yours"] = kept["where"] if kept else None
            result["updated"].append(row)
        done[slice_id] = row
        count += 1
    taken["slices"] = [row for row in done.values() if row not in result["updated"]]
    for row in taken["slices"]:
        if row.get("warned"):
            for line in row["warned"]:
                if line.startswith("Your draft ") and " is now " in line:
                    result["renumbered"].append({"what": "slice", "words": line})
    # ---- the ideas ----
    local_ideas = set(idea_ids(host, studio))
    taken["ideas"] = [{**item, "lacks": IDEA_LACKS} for item in found.get("idea_items") or [] if item["idea_id"] not in local_ideas]
    remember_ideas(studio, taken["ideas"], found.get("idea_items") or [], local_ideas)
    result["only_on_their_computer"] = from_github.ONLY_THERE
    result["project_words"] = project_words(host, studio, hand, project.get("name") or project["project_id"])
    result["in_words"] = in_words(studio, result)
    result["note"] = " ".join([*result["warned"], *result["in_words"]])
    return result


def link_epic(hand: Any, epic_id: str, number: int) -> None:
    with hand.exclusive():
        data = hand.load()
        data["epics"][epic_id] = {**(data["epics"].get(epic_id) or {}), "number": number}
        hand.save(data)


def waiting_for_mocks(host: Any, studio: Any, entry: Dict[str, Any], work: Dict[str, Any], item: Dict[str, Any]) -> bool:
    """A slice opened here without its design mocks whose approved pictures are all on the main branch of this copy now. Read from
    Git alone, so a refresh reads GitHub for it only when there is something to bring."""
    items = item["marker"].get("mocks") or []
    if not items or work.get("mocks") or (entry.get("not_approved") or {}).get("why") != "mocks":
        return False
    import project_export  # noqa: E402  its reading of a picture on the main branch (no checkout)
    rules, ref = host.ticket_rules(), project_export._main_ref(studio)
    for mock in items:
        data = project_export._picture(host, studio, ref, work["slice_id"], rules.mock_file_name(mock))
        if data is None or rules.check_mock_file(mock, data) is not None:
            return False
    return True


def set_aside(host: Any, studio: Any, hand: Any, slice_id: str) -> Optional[Dict[str, Any]]:
    """An unchanged copy here of a slice someone else saved a newer version of: kept whole first, then taken off so the newer
    version opens in its place. Returns what restore() needs if that fails."""
    spec, intent, record = studio.spec_of(slice_id), studio.intent_path(slice_id), studio.path("slice", slice_id)
    files = {path: path.read_bytes() for path in (spec, intent, record) if path is not None and path.is_file()}
    where = hand.keep_replaced(f"{slice_id}-yours", {path.name: data.decode("utf-8", errors="replace") for path, data in files.items()},
                               {"what": "slice", "slice_id": slice_id, "from": "yours"})
    for path in files:
        path.unlink()
    return {"files": files, "where": hand.where_kept(where)}


def restore(studio: Any, kept: Dict[str, Any]) -> None:
    for path, data in kept["files"].items():
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(data)


def dependency_view(host: Any, studio: Any, hand: Any, slice_id: str) -> Dict[str, Any]:
    """state_of's input for a slice take_slice opened first, from what it wrote."""
    data = studio.all("slice").get(slice_id) or {}
    rows = ((hand.load().get("seen") or {}).get("slices") or {}).get(slice_id) or []
    label = rows[-1].get("state_label") if rows else None
    return {"state_label": label, "approved_here": data.get("status") == host.APPROVED}


def idea_ids(host: Any, studio: Any) -> List[str]:
    try:
        return list(shape.Ideas(host, studio).ids())
    except Exception:  # noqa: BLE001  an ideas folder MACH cannot read: none here
        return []


def remember_ideas(studio: Any, items: List[Dict[str, Any]], all_items: List[Dict[str, Any]], local: set) -> None:
    """The published ideas this workspace does not hold, kept for status (and the app) to show. Read only from GitHub; nothing here
    is an idea of this person's until they add one."""
    session = studio.session()
    session["github_ideas"] = [item for item in all_items if item["idea_id"] not in local]
    studio.save_session(session)


def project_words(host: Any, studio: Any, hand: Any, name: str) -> str:
    """The project as it now is in this workspace, in one sentence: "This repository's project is Rulebook Explorer. MACH brought it
    in from GitHub: 3 epics and 10 slices, 8 ready and 2 shipped." The app says it once everything has come, batch by batch."""
    epics, slices = studio.all("epic"), studio.all("slice")
    states = [state_of(dependency_view(host, studio, hand, slice_id)) for slice_id in slices]
    what = listed([part for part in (plural(len(epics), "epic") if epics else "", plural(len(slices), "slice") if slices else "") if part])
    if not what:
        return f"This repository's project is {name}. MACH brought it in from GitHub, with no epics or slices yet."
    return f"This repository's project is {name}. MACH brought it in from GitHub: {what}" + (f", {counts_words(states)}." if states else ".")


def in_words(studio: Any, result: Dict[str, Any]) -> List[str]:
    """What joining did, in plain sentences for the person: the first one names the project and what came."""
    taken, said = result["taken"], []
    slices = taken["slices"]
    states = [row["state"] for row in slices]
    epics = len(taken["epics"])
    if taken["project"]:
        said.append(result["project_words"])
    elif slices or epics:
        parts = [plural(epics, "epic") if epics else "", plural(len(slices), "slice") if slices else ""]
        said.append(f"MACH brought in what is new on GitHub: {listed([part for part in parts if part])}"
                    + (f" ({', '.join(row['slice_id'] for row in slices)}; {counts_words(states)})" if slices else "") + ".")
    for row in result["updated"]:
        said.append(f"{row['slice_id']} is now the newer version someone else marked ready on GitHub (#{row['issue']}); your earlier copy was "
                    f"unchanged and is kept at {row['kept_yours']}.")
    if taken["ideas"]:
        said.append(f"{plural(len(taken['ideas']), 'idea')} published on GitHub {'is' if len(taken['ideas']) == 1 else 'are'} listed to read: "
                    + ", ".join(f"{item['idea_id']} (#{item['issue']})" for item in taken["ideas"]) + ". " + IDEA_LACKS.replace("Its ", "Each one's ", 1))
    for row in result["not_taken"]:
        said.append(row["reason"])
    if result["remaining"]:
        said.append(f"{plural(result['remaining'], 'slice')} still to bring in; MACH carries on.")
    if taken["project"]:
        said.append(from_github.ONLY_THERE)
    return said
