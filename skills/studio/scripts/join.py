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
    advice = WHAT_TO_DO.get(str(found.get("kind")))
    advice = host.say(*advice) if advice else None
    return {"joined": False, "github": {"connected": True, "checked": False, "problem": found["problem"], "kind": found.get("kind"),
                                        "advice": advice}, "project": None,
            "taken": empty_taken(), "remaining": None, "factory_authorized": False,
            "note": " ".join(part for part in (text, "Nothing here was changed.", advice) if part)}


# What makes GitHub readable from here, for a failure that only the person can mend; then MACH brings the project in by itself.
# Starting a product of their own instead stays open, on their word (project init --anyway).
WHAT_TO_DO = {
    "no_gh": ("Install the GitHub tool (gh, from cli.github.com) and sign in with gh auth login; MACH then brings in this repository's project "
              "by itself. To start a product of your own here instead, say so (project init --anyway).",
              "Install the GitHub tool (gh, from cli.github.com) on this computer and sign in to it; MACH then brings in this repository's "
              "project by itself. You can also start a product of your own here instead."),
    "auth": ("Sign in to GitHub with gh auth login; MACH then brings in this repository's project by itself. To start a product of your own "
             "here instead, say so (project init --anyway).",
             "Sign in to GitHub with the GitHub tool on this computer; MACH then brings in this repository's project by itself. You can also "
             "start a product of your own here instead."),
}


def empty_taken() -> Dict[str, Any]:
    return {"project": False, "principles": False, "needs": False, "epics": [], "slices": [], "ideas": []}


def join(host: Any, studio: Any, found: Optional[Dict[str, Any]] = None, batch: Optional[int] = None) -> Dict[str, Any]:
    """Take into this workspace what GitHub holds for this repository's project and the workspace lacks, or holds an unchanged copy
    of that GitHub has changed since. With `batch`, at most that many slices are taken (dependencies count), and `remaining` says how
    many are left; running it again carries on. Writes nothing to GitHub. GitHub's text is data: it is checked, never followed."""
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
                              "not_taken": [], "renumbered": [], "warned": [], "kept_changed": [], "waiting_for_import": [], "undecided": [],
                              "remaining": 0, "factory_authorized": False}
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
        several(result, numbers, chosen, following)
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
        note_joined(studio, chosen["number"], rules.issue_url(repository, chosen["number"]))
    else:
        result["already_here"]["project"] = True
    project = studio.load("project")
    number, why_not = from_github.project_issue(found, hand.load(), project)
    if why_not and never_saved(hand) and not import_waiting(studio):  # never over a project an unfinished import placed
        # This workspace's own project was never saved to GitHub, and the repository holds another: one project per repository, so
        # GitHub's is taken; this one's record is kept whole, and its epics and drafts stay here as drafts beside GitHub's.
        replaced = take_over_project(host, studio, found, hand, project)
        if replaced:
            note_joined(studio, replaced["issue"], rules.issue_url(repository, replaced["issue"]))
            result["warned"].append(replaced["words"])
            result["replaced_project"] = replaced
            taken["project"] = True
            result["already_here"]["project"] = False
            project = studio.load("project")
            number, why_not = from_github.project_issue(found, hand.load(), project)
    result["project"] = {"project_id": project["project_id"], "name": host_clean(rules, project.get("name")), "issue": number,
                         "url": rules.issue_url(repository, number) if number else None}
    if why_not:
        result.update(joined=False, note=why_not)
        return result
    pre = (repository, snapshot)
    adopt_bases(host, studio, hand, snapshot)  # a workspace from before the base gets one, never guessed
    waiting = import_waiting(studio)  # numbers an unfinished import holds: nothing from GitHub is written under them
    # ---- the epics ----
    elsewhere: Dict[str, str] = {}  # epic IDs here that are a different epic from GitHub's: their slices are not taken
    for epic_id, item in sorted(from_github.chosen_epics(snapshot).items()):
        local_epics, ledger = studio.all("epic"), hand.load()
        linked = (ledger["epics"].get(epic_id) or {}).get("number")
        if epic_id in local_epics and linked == item["number"]:
            result["already_here"]["epics"].append(epic_id)
            continue
        if waiting and int(epic_id.split("-")[1]) in waiting["EPIC"]:
            result["waiting_for_import"].append(epic_id)
            elsewhere[epic_id] = ""
            continue
        if epic_id in local_epics:
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
    # ---- issues labelled as slices that Product Studio did not write ----
    for number_ in found.get("unmarked") or []:
        result["not_taken"].append({"id": f"#{number_}", "what": "issue", "issue": number_,
                                    "reason": f"#{number_} is labelled as a slice, but Product Studio did not write it, so it was not brought in."})
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
            if elsewhere[epic_issue["id"]]:
                result["not_taken"].append({"id": slice_id, "what": "slice", "issue": item["number"], "reason": elsewhere[epic_issue["id"]]})
            elif slice_id not in local:
                result["waiting_for_import"].append(slice_id)
            continue
        if waiting and slice_id not in local and (int(slice_id.split("-")[1]) in waiting["SLICE"]
                                                  or any(dep in waiting["SLICE"] for dep in dependency_numbers(snapshot, item))):
            result["waiting_for_import"].append(slice_id)
            continue
        update = None
        if slice_id in local:
            own = entry.get("number")
            if own != item["number"]:
                if own or entry.get("taken_at") or entry.get("saved") == "folder":
                    continue  # this workspace's own slice under that number; refresh reports the same number held twice
                if waiting and int(slice_id.split("-")[1]) in waiting["SLICE"]:
                    result["waiting_for_import"].append(slice_id)  # a file an unfinished import placed: never written over
                    continue
                # A draft of this person's under that number, never saved: the next free number (take_slice does it, and says so).
            else:
                base = int(entry.get("revision") or entry.get("base_revision") or 0)
                newer = type(item["marker"].get("revision")) is int and item["marker"]["revision"] > base
                if waiting_for_mocks(host, studio, entry, local[slice_id], item):
                    # The issue carries design pictures this workspace lacks, and this copy's main branch has them as approved: brought,
                    # whatever the copy's state (the pictures are not the person's text), as `slice take` brings them.
                    try:
                        brought = host.take_slice(studio, str(item["number"]), [], pre, shipped_ok=True)
                    except (host.StudioError, handoff.HandoffError):
                        brought = {}
                    if brought.get("mocks_brought"):
                        result.setdefault("mocks_brought", []).append(slice_id)
                        result["warned"].append(brought["note"])
                        local, entry = studio.all("slice"), hand.load()["slices"].get(slice_id) or {}
                agreed = entry.get("base") if isinstance(entry.get("base"), dict) else {}
                changed_on_github = bool(agreed.get("github")) and handoff.github_sig(item["marker"], item.get("body_sha256")) != agreed["github"]
                if entry.get("undecided"):
                    result["already_here"]["slices"].append(slice_id)
                    result["undecided"].append({"slice_id": slice_id, "issue": item["number"], "words": undecided_words(host, slice_id, item["number"])})
                    continue
                if entry.get("run"):
                    result["already_here"]["slices"].append(slice_id)  # marking it ready stopped part way here: its retry finishes it
                    continue
                if not unchanged_here(host, studio, rules, slice_id, entry, local[slice_id]):
                    result["already_here"]["slices"].append(slice_id)
                    if local[slice_id].get("status") == host.APPROVED:
                        result["kept_changed"].append({"slice_id": slice_id, "issue": item["number"],
                                                       "words": f"{slice_id} was changed here without being reopened, so it is not the version approved "
                                                                f"on GitHub (#{item['number']}). Your copy is kept as it is and nothing was taken over it. "
                                                                + host.say(f"Reopen it to make your change a new version (slice reopen {slice_id}).",
                                                                           "Reopen it to make your change a new version.")})
                    continue  # changed here: yours stays; a newer version on GitHub is said by refresh (newer_elsewhere)
                if not newer and changed_on_github and local[slice_id].get("status") == host.APPROVED and not item["marker"].get("intact"):
                    # Text changed on GitHub after its approval never replaces an approved copy here: refresh says changed_on_github,
                    # and marking it ready again puts the approved version back.
                    result["already_here"]["slices"].append(slice_id)
                    continue
                if not (newer or changed_on_github):
                    result["already_here"]["slices"].append(slice_id)
                    continue
                update = {"was_version": base, "why": "newer" if newer else "changed"}
        if batch is not None and count >= batch:
            result["remaining"] += 1
            continue
        kept = set_aside(host, studio, hand, slice_id) if update is not None else None
        try:
            opened = host.take_slice(studio, str(item["number"]), [], pre, shipped_ok=True, ours_only=True)
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
        row = {"slice_id": opened["slice"]["slice_id"], "issue": item["number"], "title": host_clean(rules, opened["slice"].get("title")),
               "state": state_of(opened), "approved_by": opened.get("approved_by"), "epic_id": opened["epic"]["epic_id"]}
        if not opened.get("approved_here"):
            row["not_approved"] = (hand.load()["slices"].get(row["slice_id"]) or {}).get("not_approved")
        if opened.get("warned"):
            row["warned"] = opened["warned"]
            result["warned"].extend(line for line in opened["warned"] if line not in result["warned"] and not OPENED_FIRST_RE.search(line)
                                    and not (line.startswith(SEVERAL) and any(w.startswith(SEVERAL) for w in result["warned"])))
        if update is not None:
            row.update(was_version=update["was_version"], why=update["why"], kept_yours=kept["where"] if kept else None)
            result["updated"].append(row)
        done[slice_id] = row
        count += 1
    taken["slices"] = [row for row in done.values() if row not in result["updated"]]
    result["warned"] = renumbered_once(result["warned"], result["renumbered"])
    # ---- the ideas ----
    local_ideas = linked_ideas(host, studio)
    taken["ideas"] = [{**item, "lacks": IDEA_LACKS} for item in found.get("idea_items") or [] if (item["idea_id"], item["issue"]) not in local_ideas]
    remember_ideas(studio, taken["ideas"])
    result["only_on_their_computer"] = from_github.ONLY_THERE
    name = host_clean(rules, project.get("name")) or project["project_id"]
    result["project_words"] = project_words(host, studio, hand, name, so_far=bool(result["remaining"]))
    result["in_words"] = in_words(studio, result)
    result["note"] = " ".join([*result["warned"], *result["in_words"]])
    return result


SEVERAL = "This repository has more than one project issue on GitHub"
RENUMBERED_RE = re.compile(r"^Your draft (SLICE-\d+) is now (SLICE-\d+), so #\d+ could open as \1\.$")


def several(result: Dict[str, Any], numbers: List[int], chosen: Dict[str, Any], following: Optional[int]) -> None:
    if len(numbers) > 1:
        why = ("the one this workspace already follows" if chosen["number"] == following else
               "the oldest one MACH can read" if from_github.readable(chosen) else "the oldest")
        result["warned"].append(handoff.several_projects(numbers, chosen["number"], why))
        result["extra_issues"] = [number for number in numbers if number != chosen["number"]]


EPIC_RENUMBERED_RE = re.compile(r"^Your epic (EPIC-\d+) is now (EPIC-\d+), so GitHub's \1 \(#\d+\) could come in under its own number\.$")


def renumbered_once(warned: List[str], renumbered: List[Dict[str, Any]]) -> List[str]:
    """Each draft or epic of the person's that moved, said once with where it ended: "Your draft SLICE-001 is now SLICE-005",
    however many steps it took."""
    kept = [line for line in warned if not RENUMBERED_RE.match(line) and not EPIC_RENUMBERED_RE.match(line)]
    for pattern, what, words in ((EPIC_RENUMBERED_RE, "epic", "Your epic {0} is now {1}, so the epics on GitHub could come in under their own numbers."),
                                 (RENUMBERED_RE, "slice", "Your draft {0} is now {1}, so the slices on GitHub could come in under their own numbers.")):
        steps = [(match.group(1), match.group(2)) for line in warned for match in [pattern.match(line)] if match]
        ends: Dict[str, str] = {}
        for old, new in steps:
            origin = next((start for start, end in ends.items() if end == old), old)
            ends[origin] = new
        if not ends:
            continue
        renumbered[:] = [row for row in renumbered if row.get("what") != what]
        for origin, end in ends.items():
            renumbered.append({"what": what, "from": origin, "to": end})
            kept.append(words.format(origin, end))
    return kept


def host_clean(rules: Any, text: Any) -> Optional[str]:
    """Text from GitHub shown to a person: one line, bounded, control characters gone (issue_rules.list_title)."""
    return rules.list_title(text) if text else None


def never_saved(hand: Any) -> bool:
    """This workspace never saved anything to GitHub: no project issue, and no epic or slice with an issue number."""
    data = hand.load()
    return (not (data.get("project") or {}).get("number") and not any((entry or {}).get("number") for entry in data["epics"].values())
            and not any((entry or {}).get("number") or (entry or {}).get("saved") for entry in data["slices"].values()))


def take_over_project(host: Any, studio: Any, found: Dict[str, Any], hand: Any, project: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The repository's project on GitHub replaces this workspace's own, which was never saved there: its record is kept whole under
    .factory/studio/replaced/ first; the epics and drafts here stay, moved to GitHub's project. None when GitHub holds none MACH can read."""
    rules = host.ticket_rules()
    chosen, numbers = from_github.project_to_take(found, None)
    if chosen is None or not from_github.readable(chosen):
        return None
    path = studio.path("project")
    kept = hand.keep_replaced("project-yours", {"project.json": path.read_text(encoding="utf-8")},
                              {"what": "project", "project_id": project["project_id"], "from": "yours"})
    record = from_github.project_record(chosen)
    changes: List[Tuple[str, Dict[str, Any]]] = [("project", record)]
    for kind in ("epic", "slice"):
        for data in studio.all(kind).values():
            if data.get("project_id") != record["project_id"]:
                changes.append((kind, {**data, "project_id": record["project_id"]}))
    for set_path in (studio.principles_path, studio.draft / "product" / "needs.json"):
        if set_path.is_file() and not set_path.is_symlink():
            try:
                data = __import__("json").loads(set_path.read_text(encoding="utf-8"))
            except ValueError:
                continue
            if isinstance(data, dict) and data.get("project_id") not in (None, record["project_id"]):
                data["project_id"] = record["project_id"]
                set_path.write_text(host.canonical(data), encoding="utf-8")
    path.unlink()
    try:
        studio.commit_or_restore(changes, "Taking the project from GitHub")
    except host.StudioError:
        path.write_text(host.canonical(project), encoding="utf-8")
        raise
    hand.link_project(found["repository"], chosen)
    sets_words = take_published_sets(host, studio, hand, found, chosen["number"])
    old = host_clean(rules, project.get("name")) or project["project_id"]
    new = host_clean(rules, record.get("name")) or record["project_id"]
    where = hand.where_kept(kept)
    return {"from": project["project_id"], "to": record["project_id"], "issue": chosen["number"], "kept": where,
            "words": f"This workspace had its own project, {old}, which was never saved to GitHub, and this repository's project on GitHub is {new} "
                     f"(#{chosen['number']}). A repository holds one project, so MACH brought {new} in. Your project's own words are kept at {where}; "
                     "your epics and drafts stay here as drafts." + "".join(f" {line}" for line in sets_words)}


def take_published_sets(host: Any, studio: Any, hand: Any, found: Dict[str, Any], number: int) -> List[str]:
    """With GitHub's project taken over this workspace's own (never published), the principles and technical needs published on its
    issue come in under their own IDs and versions. The person's own, never published, are drafts: one that says the same as a
    published one (after normalising) becomes it; the others are renumbered after GitHub's and stay drafts, not yet published.
    Returns what to say."""
    import needs as needs_module  # noqa: E402  here, not above: it reaches back into studio.py's helpers
    rules = host.ticket_rules()
    published, _, problem = hand.published_sets(found["repository"], found["snapshot"], number)
    if problem:
        return []
    said: List[str] = []
    same = lambda text: " ".join(str(text or "").lower().split())  # noqa: E731
    for kind, key, prefix, words in (("principles", "id", "PP", "principles"), ("needs", "need_id", "TN", "technical needs")):
        theirs = published.get(kind)
        if not theirs or not theirs.get("approved"):
            continue
        mine = studio.principles() if kind == "principles" else needs_module.load(host, studio)[0]
        none = [] if kind == "principles" else list(needs_module.load(host, studio)[1])
        items = [dict(item) for item in theirs["items"]]
        statements = {same(item.get("statement")): item[key] for item in items}
        top = max([0, *(int(str(item[key]).split("-")[1]) for item in items)])
        moved: List[str] = []
        renamed: Dict[str, str] = {}
        for item in mine:
            if same(item.get("statement")) in statements:
                renamed[item[key]] = statements[same(item.get("statement"))]
                moved.append(f"{item[key]} is now {renamed[item[key]]}, which says the same")
                continue
            top += 1
            new_id = f"{prefix}-{top:02d}"
            renamed[item[key]] = new_id
            moved.append(f"{item[key]} is now {new_id}")
            items.append({**item, key: new_id, "revision": 1})
        if rewrite_own_drafts(studio, hand, prefix, renamed):
            moved.append("your drafts' answers name them by their new numbers")
        if kind == "principles":
            studio.save_principles(items, "Taking the principles from GitHub")
            hand.take_set(handoff.PRINCIPLES_KIND, theirs["revision"], rules.principles_sha256(theirs["items"]), theirs["items"], None, theirs.get("approved_by"))
        else:
            extra = list(theirs.get("extra") or [])
            needs_module.save(host, studio, items, sorted(set(none) | set(extra)), "Taking the technical needs from GitHub")
            hand.take_set(handoff.NEEDS_KIND, theirs["revision"], rules.needs_sha256(theirs["items"]), theirs["items"], extra, theirs.get("approved_by"))
        if mine:
            said.append(f"The {words} published on GitHub came in under their own numbers. Yours were never published, so they stay drafts: "
                        + "; ".join(moved) + ".")
    return said


def rewrite_own_drafts(studio: Any, hand: Any, prefix: str, renamed: Dict[str, str]) -> bool:
    """The person's own drafts (never saved to GitHub) answer their principles or needs by ID: each ID that moved is rewritten in
    their specs and whys, all at once, as slice and epic references are when a draft is renumbered. True when any text changed."""
    moving = {old: new for old, new in renamed.items() if old != new}
    if not moving:
        return False
    pattern = re.compile(rf"\b{prefix}-\d+\b")
    ledger = hand.load()
    changed = False
    for slice_id in studio.all("slice"):
        if (ledger["slices"].get(slice_id) or {}).get("number"):
            continue  # saved to GitHub: answered under the published set already
        for path in (studio.spec_of(slice_id), studio.intent_path(slice_id)):
            if path is None or not path.is_file():
                continue
            text = path.read_text(encoding="utf-8")
            new_text = pattern.sub(lambda found: moving.get(found.group(0), found.group(0)), text)
            if new_text != text:
                path.write_text(new_text, encoding="utf-8")
                changed = True
    return changed


def import_waiting(studio: Any) -> Optional[Dict[str, Any]]:
    """While bringing in a project stands unfinished, the numbers it holds: {SLICE: {...}, EPIC: {...}, file}. None otherwise."""
    import project_import  # noqa: E402  here, not above: it imports Product Studio's modules in turn
    unfinished = project_import.unfinished(studio)
    if not unfinished:
        return None
    return {"SLICE": set(project_import.reserved_numbers(studio, "SLICE")), "EPIC": set(project_import.reserved_numbers(studio, "EPIC")),
            "file": unfinished["file"]}


def dependency_numbers(snapshot: Dict[str, Any], item: Dict[str, Any]) -> List[int]:
    """The slice numbers (SLICE-NNN's NNN) a slice issue depends on, by its marker's issue numbers."""
    by_issue = {other["number"]: other["marker"]["slice_id"] for other in snapshot["slices"]}
    return [int(by_issue[dep].split("-")[1]) for dep in item["marker"].get("depends") or [] if dep in by_issue]


def local_digests(rules: Any, studio: Any, slice_id: str, work: Dict[str, Any]) -> Optional[Tuple[Optional[str], Optional[str], Optional[str]]]:
    """The SHA-256 of the spec and why as they are here now, and the digest of the design mocks the work order lists."""
    spec, intent = studio.spec_of(slice_id), studio.intent_path(slice_id)
    try:
        return (rules.text_sha256_of(spec.read_text(encoding="utf-8")) if spec else None,
                rules.text_sha256_of(intent.read_text(encoding="utf-8")) if intent.is_file() else None,
                rules.mocks_sha256(work["mocks"]) if work.get("mocks") else None)
    except (OSError, UnicodeDecodeError):
        return None


def unchanged_here(host: Any, studio: Any, rules: Any, slice_id: str, entry: Dict[str, Any], work: Dict[str, Any]) -> bool:
    """Whether this workspace still holds exactly the version it last agreed on with GitHub (its base, handoff.record_version): taken,
    marked ready here, or settled. Its approval state does not decide it."""
    agreed = entry.get("base")
    now = local_digests(rules, studio, slice_id, work)
    return isinstance(agreed, dict) and now is not None and now == (agreed.get("spec"), agreed.get("why"), agreed.get("mocks"))


def github_text(host: Any, rules: Any, item: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    """The SHA-256 of the spec and why a slice issue holds now, approved or not (from the listing; nothing is read)."""
    marker = item["marker"]
    if marker.get("intact"):
        return marker.get("spec_sha256"), marker.get("why_sha256")
    spec, why, _ = host.held_text(rules, {"body": item.get("body"), "check": {"marker": marker}, "comments": []})
    return (rules.text_sha256_of(spec), rules.text_sha256_of(why)) if spec is not None and why is not None else None


def approved_mocks(entry: Dict[str, Any], work: Dict[str, Any], item: Optional[Dict[str, Any]], here: Optional[str]) -> Optional[str]:
    """The design mocks' digest an approved slice's base records, for a ledger written before the base: older ledgers kept
    `mocks_sha256` empty even for a slice with pictures. The work order's own mocks are what was approved when the approval (the
    ledger's, else the issue's marker) names them or names none; otherwise the marker's. Never None for a slice that has mocks."""
    marker = (item or {}).get("marker") or {}
    named = [digest for digest in (entry.get("mocks_sha256"), marker.get("mocks_sha256")) if digest]
    if here and (here in named or not named):
        return here
    return named[0] if named else here


def adopt_bases(host: Any, studio: Any, hand: Any, snapshot: Dict[str, Any]) -> List[str]:
    """A workspace from before the base (0.26.0 to 0.27.x) gets one for every slice linked to an issue, without guessing: an approved
    slice whose files match its approval has that as its base; one whose files match what GitHub holds now has GitHub's version; one
    that matches neither and is not approved cannot be told apart (the person's own change, or text GitHub held that was changed
    after its approval), so it is marked undecided and the person chooses. Returns the undecided slice IDs."""
    rules = host.ticket_rules()
    by_number = {item["number"]: item for item in snapshot["slices"]}
    local = studio.all("slice")
    undecided: List[str] = []
    with hand.exclusive():
        data = hand.load()
        changed = False
        for slice_id, entry in data["slices"].items():
            if not isinstance(entry, dict) or isinstance(entry.get("base"), dict) or not entry.get("number") or slice_id not in local:
                continue
            work, item = local[slice_id], by_number.get(entry["number"])
            now = local_digests(rules, studio, slice_id, work)
            if now is None:
                continue
            if work.get("status") == host.APPROVED and entry.get("spec_sha256"):
                agreed = handoff.agreed_base(entry.get("revision"), entry["spec_sha256"], entry.get("why_sha256"),
                                             approved_mocks(entry, work, item, now[2]))
            elif item is not None and github_text(host, rules, item) == now[:2]:
                marker = item["marker"]
                agreed = handoff.agreed_base(marker["revision"], now[0], now[1], now[2], handoff.github_sig(marker, item.get("body_sha256")))
            else:
                if not entry.get("undecided"):
                    entry["undecided"] = {"issue": entry["number"], "since": handoff.utc_now()}
                    changed = True
                undecided.append(slice_id)
                continue
            hand.record_version(entry, agreed)
            changed = True
        if changed:
            hand.save(data)
    return undecided


def undecided_words(host: Any, slice_id: str, issue: int) -> str:
    return (f"{slice_id} here differs from GitHub (#{issue}), and MACH cannot tell whether you changed it. Keep yours, or take GitHub's"
            + host.say(f" (reconcile {slice_id} --take mine, or --take theirs; yours is kept first).", " (yours is kept first)."))


def before_ready(host: Any, studio: Any, slice_id: str, without_mocks: bool) -> Optional[str]:
    """`slice ready` on a slice brought in from GitHub without an approval for its text: what the person is approving, said first.
    One brought in without the design mock pictures its issue carries is not marked ready without them unless the person says so."""
    entry = (studio.handoff().load()["slices"].get(slice_id) or {})
    record = entry.get("not_approved") if isinstance(entry.get("not_approved"), dict) else None
    if not record:
        return None
    if record.get("why") == "mocks" and not (studio.all("slice").get(slice_id) or {}).get("mocks") and not without_mocks:
        count = int(record.get("mocks") or 0) or 1
        raise host.StudioError(
            host.say(f"{slice_id}'s issue on GitHub carries {plural(count, 'design mock picture')} that {'is' if count == 1 else 'are'} not on the "
                     f"main branch here yet. Marking it ready now would save it without {'it' if count == 1 else 'them'}, so nothing was changed. "
                     "They come at the first refresh after this computer has the main branch with them (after a pull or fetch). To mark it ready "
                     "without them, say so "
                     f"(slice ready {slice_id} --without-mocks).",
                     f"{slice_id}'s issue on GitHub carries {plural(count, 'design mock picture')} that {'is' if count == 1 else 'are'} not on the "
                     f"main branch here yet. Marking it ready now would save it without {'it' if count == 1 else 'them'}, so nothing was changed. "
                     "They come at the first refresh after this computer has the main branch with them (after a pull or fetch). You can also mark "
                     "it ready without them."),
            {"kind": "ready_without_mocks", "target": slice_id})
    if record.get("why") == "mocks":
        return f"{slice_id} is marked ready without the design mock pictures its issue carried on GitHub, as you asked."
    if record.get("why") == "edited":
        who = f"@{record['approved_by']}" if record.get("approved_by") else "someone"
        return (f"{who} approved a different text of {slice_id} (version {record.get('revision')}); the text on GitHub was changed after that. "
                "You marked this text ready, so it is approved as yours.")
    return None


def note_joined(studio: Any, issue: int, url: Optional[str]) -> None:
    """The project came from GitHub: status carries one note about it (`joined_note`), written whole once everything has come, which
    the app shows once per browser until it is closed, whichever window did the joining."""
    session = studio.session()
    session["joined_note"] = {"at": handoff.utc_now(), "issue": issue, "url": url, "text": None}
    studio.save_session(session)


def link_epic(hand: Any, epic_id: str, number: int) -> None:
    with hand.exclusive():
        data = hand.load()
        data["epics"][epic_id] = {**(data["epics"].get(epic_id) or {}), "number": number}
        hand.save(data)


def waiting_for_mocks(host: Any, studio: Any, entry: Dict[str, Any], work: Dict[str, Any], item: Dict[str, Any]) -> bool:
    """A slice opened here without its design mocks whose approved pictures are all on the main branch of this copy now. Read from
    Git alone, so a refresh reads GitHub for it only when there is something to bring."""
    items = item["marker"].get("mocks") or []
    if not items or work.get("mocks"):
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


def linked_ideas(host: Any, studio: Any) -> set:
    """(idea ID, issue) of every idea here saved as an issue: a published idea is in the workspace only when one of them is its issue.
    An idea of this person's that only shares the ID never hides the published one."""
    try:
        ideas = shape.Ideas(host, studio)
        return {(idea_id, entry.get("number")) for idea_id, entry in ideas.load_ledger()["ideas"].items() if entry.get("number")}
    except Exception:  # noqa: BLE001  an ideas folder MACH cannot read: none here
        return set()


def remember_ideas(studio: Any, items: List[Dict[str, Any]]) -> None:
    """The published ideas this workspace does not hold, kept for status (and the app) to show. Read only from GitHub; nothing here
    is an idea of this person's until they add one."""
    session = studio.session()
    session["github_ideas"] = items
    studio.save_session(session)


def remember_lasting(studio: Any, result: Dict[str, Any]) -> None:
    """What could not be taken, what waits for an import, and copies changed here, as the last join found them: status shows them."""
    session = studio.session()
    session["github_not_taken"] = [{key: row.get(key) for key in ("id", "what", "issue", "reason")} for row in result["not_taken"]]
    session["github_waiting"] = list(result.get("waiting_for_import") or [])
    session["github_kept_changed"] = [{key: row.get(key) for key in ("slice_id", "issue", "words")} for row in result.get("kept_changed") or []]
    session["github_undecided"] = [{key: row.get(key) for key in ("slice_id", "issue", "words")} for row in result.get("undecided") or []]
    studio.save_session(session)


def said_once(studio: Any, lines: List[str]) -> List[str]:
    """Sentences about lasting facts (what was not taken, ideas listed, a copy changed here, what waits for an import) are said the
    first time only; status keeps them (`from_github`)."""
    session = studio.session()
    said = list(session.get("join_said") or [])
    fresh = [line for line in lines if line not in said]
    if fresh:
        session["join_said"] = (said + fresh)[-500:]
        studio.save_session(session)
    return fresh


def project_words(host: Any, studio: Any, hand: Any, name: str, so_far: bool = False) -> str:
    """The project as it now is in this workspace, in one sentence: "This repository's project is Rulebook Explorer. MACH brought it
    in from GitHub: 3 epics and 10 slices, 8 ready and 2 shipped." While a batched join is under way it says what came so far."""
    # The project as GitHub holds it here: epics and slices linked to their issues (drafts of this person's are theirs, not counted).
    ledger = hand.load()
    epics = [epic_id for epic_id in studio.all("epic") if (ledger["epics"].get(epic_id) or {}).get("number")]
    slices = [slice_id for slice_id in studio.all("slice") if (ledger["slices"].get(slice_id) or {}).get("number")]
    states = [state_of(dependency_view(host, studio, hand, slice_id)) for slice_id in slices]
    what = listed([part for part in (plural(len(epics), "epic") if epics else "", plural(len(slices), "slice") if slices else "") if part])
    if so_far:
        return f"This repository's project is {name}. MACH is bringing it in from GitHub: {what or 'nothing'} so far."
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
        if row.get("why") == "changed":
            said.append(f"{row['slice_id']} changed on GitHub since it came here (#{row['issue']}), and your copy was unchanged, so it now holds what "
                        f"GitHub holds. Your earlier copy is kept at {row['kept_yours']}.")
        else:
            said.append(f"{row['slice_id']} is now the newer version someone else marked ready on GitHub (#{row['issue']}); your earlier copy was "
                        f"unchanged and is kept at {row['kept_yours']}.")
    lasting = [row["words"] for row in (result.get("kept_changed") or []) + (result.get("undecided") or [])]
    if taken["ideas"]:
        lasting.append(f"{plural(len(taken['ideas']), 'idea')} published on GitHub {'is' if len(taken['ideas']) == 1 else 'are'} listed to read: "
                       + ", ".join(f"{item['idea_id']} (#{item['issue']})" for item in taken["ideas"]) + ". "
                       + IDEA_LACKS.replace("Its ", "Each one's ", 1))
    lasting += [row["reason"] for row in result["not_taken"]]
    if result.get("waiting_for_import"):
        waiting = result["waiting_for_import"]
        lasting.append(f"{listed(waiting)} on GitHub {'waits' if len(waiting) == 1 else 'wait'} while bringing in a project file is unfinished here: "
                       f"finish bringing it in, or set it aside, and {'it comes' if len(waiting) == 1 else 'they come'} in.")
    said += said_once(studio, lasting)
    remember_lasting(studio, result)
    if result["remaining"]:
        said.append(f"{plural(result['remaining'], 'slice')} still to bring in; MACH carries on.")
    if taken["project"]:
        said.append(from_github.ONLY_THERE)
    return said
