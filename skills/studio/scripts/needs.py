#!/usr/bin/env python3
"""MACH Product Studio, M17 part A: technical needs.

A technical need is what the product requires of whatever is built, said without technology. It is
product-level, beside the vision and the principles, and is evidence for the engineer who accepts the
architecture decisions (ADRs); a need never decides a technology and never covers a required topic.

    need add --kind K --statement S --why W [--said-by --said-on]   a new TN-NN (IDs are never reused)
    need set TN-NN [--statement] [--why] [--said-by] [--said-on]    a changed statement is the need's next revision
    need retire TN-NN                                               retired, never brought back
    need none --kind K                                              "nothing to say" about a kind, so it is not asked again
    need list                                                       reads only: the needs, unanswered kinds, ADRs behind
    need publish                                                    the project's issue, or product/ready/NEEDS/
    reconcile needs --take mine|theirs                              (studio.py's reconcile) another product manager's newer version

Kinds: people, data, connections, never, priority, given. Every statement except a given's is held to the
principles' technology check (validate_slice.need_findings, built from statement_findings' own check). A
given may name a technology, and says who said it (a name or role, or a policy pack ID that exists) and when.

The draft is product/needs.json in the workspace: {schema_version, project_id, needs, none}. Publishing is
the principles' mechanism (handoff.publish_set with handoff.NEEDS_KIND; issue_rules.NEEDS). All but `list`
run only on the product manager's word. Not a gate: `slice ready` does not wait for needs.

studio.py registers the commands with add_commands() and passes its own module as `host`.
Standard library only.
"""

import argparse
import json
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import handoff

QUESTIONS = {
    "people": "Who uses it, how many, from where, and at what busiest moment?",
    "data": "What does it keep, how sensitive is that, and how long must it be kept?",
    "connections": "What must it work with that already exists?",
    "never": "What must never happen, and what does it cost if it does?",
    "priority": "When two qualities conflict (speed, cost, safety, ease of change), which wins?",
    "given": "What is already decided outside this product?",
}
NOTE = ("A technical need says what the product requires of whatever is built, without technology. The engineer reads the "
        "published needs when recording their decisions; only an accepted decision chooses a technology.")
SERVES_RE = re.compile(r"^(TN-[0-9]{2,})@([0-9]{1,6})$")
ADR_NOT_SERVING = ("rejected", "superseded")


# ---- the draft ----

def path(studio: Any) -> Path:
    return studio.draft / "product" / "needs.json"


def load(host: Any, studio: Any) -> Tuple[List[Dict[str, Any]], List[str]]:
    """The draft needs in ID order, and the kinds answered "nothing to say"; ([], []) when the project has none."""
    rules = host.ticket_rules()
    where = path(studio)
    if not where.is_file() or where.is_symlink():
        return [], []
    try:
        data = json.loads(where.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise host.StudioError(f"{where}: cannot read the technical needs: {exc}")
    items = data.get("needs") if isinstance(data, dict) else None
    none = data.get("none") if isinstance(data, dict) else None
    problems = rules.need_problems(items) or rules.needs_none_problems(items, none)
    if problems:
        raise host.StudioError(f"{where} is not in the form Product Studio writes: " + "; ".join(problems[:3]))
    return json.loads(rules.needs_canonical(items)), list(none)


def save(host: Any, studio: Any, items: List[Dict[str, Any]], none: List[str], what: str) -> None:
    rules = host.ticket_rules()
    none = [kind for kind in rules.NEED_KINDS if kind in none]
    studio.save_product_file(path(studio), {"schema_version": 1, "project_id": studio.project_id(),
                                            "needs": json.loads(rules.needs_canonical(items)), "none": none}, what)


def checked(host: Any, items: List[Dict[str, Any]], none: List[str], ident: str) -> None:
    rules = host.ticket_rules()
    problems = [p for p in rules.need_problems(items) if p.startswith(ident) or not p.startswith("TN-")]
    problems += rules.needs_none_problems(items, [kind for kind in rules.NEED_KINDS if kind in none])
    if problems:
        raise host.StudioError(f"{ident} cannot be saved: " + "; ".join(problems[:3]) + ".")


def findings(host: Any, studio: Any, ident: str, kind: str, statement: str) -> List[str]:
    """The validator's own technology check (validate_slice.need_findings). A given is exempt: it records a technology someone
    outside the product already decided. Errors refuse; warnings are returned."""
    if kind == "given":
        return []
    found = studio.validate_slice.need_findings(ident, statement)
    errors = [f"{finding.message} [{finding.rule}]" for finding in found if finding.severity == "error"]
    if errors:
        raise host.StudioError(f"{ident} cannot be saved:\n  " + "\n  ".join(errors))
    return [f"{finding.message} [{finding.rule}]" for finding in found]


def said_by(host: Any, studio: Any, value: str, ident: str) -> str:
    """Who said a given: a person's name or role in their words, or the ID of a policy pack that exists."""
    text = host.one_line(value, "said-by (who decided it: a name or role, or a policy pack ID)", ident)
    if text.upper().startswith("POL-"):
        packs = {record.get("id") for record in studio.policy_listing().get("packs") or []}
        if text not in packs:
            raise host.StudioError(f"{ident}: {text} is not a policy pack this project has"
                                   + (f" (it has {', '.join(sorted(p for p in packs if p))})." if any(packs) else " (it has none).")
                                   + " Name the pack's ID exactly, or the person or role who decided it.")
    return text


def said_on(host: Any, value: str, ident: str) -> str:
    """When a given was said: a date, not in the future."""
    text = " ".join(str(value).split())
    try:
        day = date.fromisoformat(text) if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", text) else None
    except ValueError:
        day = None
    if day is None:
        raise host.StudioError(f"{ident}: '{text}' is not a date such as 2026-11-21.")
    if day > datetime.now(timezone.utc).date():
        raise host.StudioError(f"{ident}: {text} is in the future. Give the date it was said.")
    return text


def next_id(studio: Any, items: Sequence[Dict[str, Any]]) -> str:
    """The next free TN-NN: never one used before, here, in what was published, or on GitHub at the last refresh."""
    ledger = studio.handoff().load()
    used = [item["need_id"] for item in items] + [item["need_id"] for item in (ledger.get("needs") or {}).get("published") or []]
    used += [item["need_id"] for item in ((ledger.get("seen") or {}).get("needs") or {}).get("needs") or []]
    import project_import  # noqa: E402  M21: numbers an unfinished import holds; imported here to keep the modules apart
    return f"TN-{max([0, *(int(ident.split('-')[1]) for ident in used), *project_import.reserved_numbers(studio, 'TN')]) + 1:02d}"


def find(host: Any, items: List[Dict[str, Any]], ident: str) -> Dict[str, Any]:
    found = next((item for item in items if item["need_id"] == ident), None)
    if found is None:
        raise host.StudioError(f"No technical need {ident}. The needs are: " + (", ".join(item["need_id"] for item in items) or "none yet") + ".")
    return found


# ---- where they stand ----

def unpublished(host: Any, studio: Any, ledger: Dict[str, Any]) -> bool:
    """True when the draft needs (or the kinds with nothing to say) differ from what was last published or taken."""
    items, none = load(host, studio)
    record = ledger.get("needs") or {}
    return bool(items) and (record.get("run") is not None
                            or not handoff.NEEDS_KIND.same(record.get("sha256"), record.get("none"), host.ticket_rules().needs_sha256(items), none))


def unanswered(items: Sequence[Dict[str, Any]], none: Sequence[str], kinds: Sequence[str]) -> List[str]:
    """The kinds with no active need and not answered "nothing to say": the interview asks about these."""
    answered = {item["kind"] for item in items if item["status"] == "active"} | set(none)
    return [kind for kind in kinds if kind not in answered]


def adrs_behind(host: Any, studio: Any, ledger: Dict[str, Any]) -> List[Dict[str, Any]]:
    """ADRs whose `serves:` header names a need at an older revision than the one published. Read from the main checkout's
    committed ADRs (adr.py's own listing and header parser); nothing is reopened or changed. [] when nothing is published."""
    published = (ledger.get("needs") or {}).get("published") or []
    if not published:
        return []
    current = {item["need_id"]: item["revision"] for item in published}
    try:
        host.intent_modules()
        import adr  # noqa: E402  the intent skill's ADR reader
        listing = adr.main_listing(studio.project, studio.cell.load_config(studio.project))
    except Exception:  # noqa: BLE001  no Git, no ADRs, unreadable settings: nothing to flag
        return []
    behind = []
    for record in listing.get("adrs") or []:
        if record.get("status") in ADR_NOT_SERVING:
            continue
        fields, _, _ = adr.front_matter(record.get("text") or "")
        value = fields.get("serves")
        named = value if isinstance(value, list) else str(value or "").split(",")
        for item in named:
            found = SERVES_RE.fullmatch(str(item).strip())
            if found and found.group(1) in current and int(found.group(2)) < current[found.group(1)]:
                behind.append({"adr": record.get("id"), "file": record.get("file"), "need_id": found.group(1),
                               "served_revision": int(found.group(2)), "revision_now": current[found.group(1)]})
    return behind


def block(host: Any, studio: Any, ledger: Dict[str, Any]) -> Dict[str, Any]:
    """The needs block of status, refresh and need list."""
    rules = host.ticket_rules()
    items, none = load(host, studio)
    view = handoff.published_view(handoff.NEEDS_KIND, ledger, rules)
    changed = unpublished(host, studio, ledger)
    open_kinds = unanswered(items, none, rules.NEED_KINDS)
    behind = adrs_behind(host, studio, ledger)
    if view["newer_elsewhere"]:
        nxt = host.say("Someone else published a newer version of the technical needs on GitHub. Publishing yours replaces it, and theirs is kept; "
                       "to use theirs instead, take it (reconcile needs --take theirs).",
                       "Someone else published a newer version of the technical needs on GitHub. Publishing yours replaces it, and theirs is kept; "
                       "you can take theirs instead.")
    elif view["unfinished"]:
        nxt = host.say("Publishing the technical needs to GitHub stopped part way: publish them again to finish (need publish).",
                       "Publishing the technical needs to GitHub stopped part way: publish them again to finish.")
    elif changed:
        nxt = host.say("The technical needs have changes that are not published: publish them so the engineer gets them (need publish).",
                       "The technical needs have changes that are not published: publish them so the engineer gets them.")
    elif open_kinds:
        nxt = f"Not answered yet: {', '.join(open_kinds)}. Each can be a need or 'nothing to say'."
    elif behind:
        nxt = (f"Decisions written for an older version of a need: {', '.join(sorted({row['adr'] or row['file'] for row in behind}))}. "
               "An engineer decides whether the change matters.")
    else:
        nxt = None
    return {"active": [item["need_id"] for item in items if item["status"] == "active"],
            "retired": [item["need_id"] for item in items if item["status"] == "retired"],
            "nothing_to_say": none, "unanswered": open_kinds, "unpublished_changes": changed, "published": view,
            "adrs_behind": behind, "next": nxt}


def status_field(host: Any, studio: Any) -> Dict[str, Any]:
    """The needs for status. Nothing at all for a project that never opened them, so status reads as before."""
    ledger = studio.handoff().load()
    if not path(studio).is_file() and not (ledger.get("needs") or {}).get("saved"):
        return {}
    return {"needs": block(host, studio, ledger)}


def not_saved(host: Any, studio: Any, ledger: Dict[str, Any]) -> List[Dict[str, Any]]:
    """For status' `saved`: technical needs whose publish stopped part way, or with changes not published."""
    if not path(studio).is_file() or not unpublished(host, studio, ledger):
        return []
    if (ledger.get("needs") or {}).get("run"):
        return [{"kind": "needs_unfinished", "target": None, "text": "Publishing the technical needs stopped part way. Publish them again to finish."}]
    return [{"kind": "needs_unpublished", "target": None, "text": "The technical needs have changes that are not published. Publish them so the engineer gets them."}]


def take_at_refresh(host: Any, studio: Any, github: Dict[str, Any]) -> Dict[str, Any]:
    """After refresh: another product manager's newer, approved needs are taken when nothing here is unpublished (as the
    principles are); otherwise status says to choose. Nothing at all for a project without needs."""
    hand = studio.handoff()
    ledger = hand.load()
    seen = (ledger.get("seen") or {}).get("needs") or {}
    view = handoff.published_view(handoff.NEEDS_KIND, ledger, host.ticket_rules())
    if not (view["newer_elsewhere"] and seen.get("needs") and studio.path("project").is_file() and not unpublished(host, studio, ledger)):
        return {}
    take(host, studio, seen)
    if "needs" in github:
        github["needs"] = handoff.published_view(handoff.NEEDS_KIND, hand.load(), host.ticket_rules())
    return {"needs_taken": {"revision": seen["revision"], "note": f"Another product manager published version {seen['revision']} of the technical needs; "
                                                                  "it was taken, since you had no unpublished changes."}}


def take(host: Any, studio: Any, seen: Dict[str, Any]) -> None:
    theirs, none = seen["needs"], list(seen.get("none") or [])
    save(host, studio, theirs, none, "Taking the technical needs from GitHub")
    studio.handoff().take_set(handoff.NEEDS_KIND, seen["revision"], host.ticket_rules().needs_sha256(theirs), theirs, none, seen.get("approved_by"))


def reconcile(host: Any, studio: Any, choice: str) -> Dict[str, Any]:
    """Someone else published a newer version of the needs: keep mine (my next publish replaces theirs) or take theirs."""
    hand = studio.handoff()
    ledger = hand.load()
    view = handoff.published_view(handoff.NEEDS_KIND, ledger, host.ticket_rules())
    seen = (ledger.get("seen") or {}).get("needs") or {}
    if not view["newer_elsewhere"] or not seen.get("needs"):
        raise host.StudioError("There is no newer version of the technical needs on GitHub to choose from. Refresh first if someone has just published one.")
    if choice == "theirs":
        take(host, studio, seen)
        note = "Your technical needs now are the version from GitHub."
    else:
        hand.keep_mine(handoff.NEEDS_KIND, seen["revision"])
        note = "Your technical needs stay as they are. Publishing them replaces the version on GitHub."
    return {"reconciled": "needs", "took": choice, "github_version": seen["revision"], "note": note, "factory_authorized": False}


# ---- the commands ----

def publish_note(host: Any, ident: str, done: str) -> str:
    return host.say(f"{ident} is {done} here. Publish the technical needs to give them to the engineer (need publish).",
                    f"{ident} is {done} here. Publish the technical needs to give them to the engineer.")


def cmd_add(host: Any, studio: Any, args: argparse.Namespace) -> Dict[str, Any]:
    studio.prepare()
    studio.load("project")
    items, none = load(host, studio)
    ident = next_id(studio, items)
    item = {"need_id": ident, "kind": args.kind, "statement": host.one_line(args.statement, "statement", ident),
            "why": host.one_line(args.why, "why", ident), "status": "active", "revision": 1}
    if args.kind == "given":
        if args.said_by is None or args.said_on is None:
            raise host.StudioError(host.say(f"{ident}: a given says who decided it and when (--said-by and --said-on).",
                                            f"{ident}: a given says who decided it and when."))
        item.update(said_by=said_by(host, studio, args.said_by, ident), said_on=said_on(host, args.said_on, ident))
    elif args.said_by is not None or args.said_on is not None:
        raise host.StudioError(f"{ident}: only a given says who decided it and when.")
    warnings = findings(host, studio, ident, item["kind"], item["statement"])
    none = [kind for kind in none if kind != item["kind"]]  # a need of a kind answers it
    checked(host, items + [item], none, ident)
    save(host, studio, items + [item], none, f"Adding {ident}")
    return {"need": item, "warnings": warnings, "published": False, "factory_authorized": False,
            "note": publish_note(host, ident, "saved")}


def cmd_set(host: Any, studio: Any, args: argparse.Namespace) -> Dict[str, Any]:
    studio.prepare()
    items, none = load(host, studio)
    item = find(host, items, args.need_id)
    ident = item["need_id"]
    if item["status"] == "retired":
        raise host.StudioError(f"{ident} is retired, so it is not changed. Add a new need instead.")
    if item["kind"] != "given" and (args.said_by is not None or args.said_on is not None):
        raise host.StudioError(f"{ident}: only a given says who decided it and when.")
    if args.why is not None:
        item["why"] = host.one_line(args.why, "why", ident)
    if args.said_by is not None:
        item["said_by"] = said_by(host, studio, args.said_by, ident)
    if args.said_on is not None:
        item["said_on"] = said_on(host, args.said_on, ident)
    warnings: List[str] = []
    if args.statement is not None:
        statement = host.one_line(args.statement, "statement", ident)
        warnings = findings(host, studio, ident, item["kind"], statement)
        if statement != item["statement"]:
            # Its revision counts changes to what it says: an ADR that serves it names the revision it was written for.
            item.update(statement=statement, revision=item["revision"] + 1)
    checked(host, items, none, ident)
    save(host, studio, items, none, f"Changing {ident}")
    return {"need": item, "warnings": warnings, "published": False, "factory_authorized": False,
            "note": publish_note(host, ident, "changed")}


def cmd_retire(host: Any, studio: Any, args: argparse.Namespace) -> Dict[str, Any]:
    studio.prepare()
    items, none = load(host, studio)
    item = find(host, items, args.need_id)
    if item["status"] == "retired":
        raise host.StudioError(f"{item['need_id']} is already retired.")
    item["status"] = "retired"
    save(host, studio, items, none, f"Retiring {item['need_id']}")
    return {"need": item, "published": False, "factory_authorized": False, "note": publish_note(host, item["need_id"], "retired")}


def cmd_none(host: Any, studio: Any, args: argparse.Namespace) -> Dict[str, Any]:
    """Record "nothing to say" about a kind, so the interview does not ask about it again."""
    studio.prepare()
    studio.load("project")
    items, none = load(host, studio)
    active = [item["need_id"] for item in items if item["kind"] == args.kind and item["status"] == "active"]
    if active:
        raise host.StudioError(f"{args.kind} already has {', '.join(active)}, so it is not 'nothing to say'. Retire them first if they no longer hold.")
    changed = args.kind not in none
    if changed:
        save(host, studio, items, none + [args.kind], f"Recording nothing to say about {args.kind}")
    return {"kind": args.kind, "nothing_to_say": True, "changed": changed, "published": False, "factory_authorized": False,
            "note": f"Nothing to say about {args.kind}: it is not asked again. Adding a need of this kind answers it instead."}


def cmd_list(host: Any, studio: Any, args: argparse.Namespace) -> Dict[str, Any]:
    studio.prepare()
    ledger = studio.handoff().load()
    items, none = load(host, studio)
    kinds = [{"kind": kind, "question": QUESTIONS[kind], "needs": [item["need_id"] for item in items if item["kind"] == kind and item["status"] == "active"],
              "nothing_to_say": kind in none} for kind in host.ticket_rules().NEED_KINDS]
    return {"needs": items, "kinds": kinds, **block(host, studio, ledger), "note": NOTE, "factory_authorized": False}


def cmd_publish(host: Any, studio: Any, args: argparse.Namespace) -> Dict[str, Any]:
    """Save the needs where the engineer reads them: the project's GitHub issue, or the ready folder. On the product manager's word."""
    studio.prepare()
    project = studio.load("project")
    items, none = load(host, studio)
    if not items:
        raise host.StudioError(host.say("There are no technical needs to publish. Add one first (need add).", "There are no technical needs to publish. Add one first."))
    for item in items:
        if item["status"] == "active":
            findings(host, studio, item["need_id"], item["kind"], item["statement"])
    saved = studio.handoff().publish_set(handoff.NEEDS_KIND, project, items, none)
    active = sum(1 for item in items if item["status"] == "active")
    open_kinds = unanswered(items, none, host.ticket_rules().NEED_KINDS)
    if saved["saved_to"] == "folder":
        folder = Path(saved["folder"])
        return {"published": True, **saved, "files": [str(folder / "needs.json")], "active": active, "unanswered": open_kinds, "factory_authorized": False,
                "ways_on": [host.say(f"Commit the folder {folder.relative_to(studio.draft)} to the repository; the engineer reads it from the main branch.",
                                     "Add this folder to the project's repository; the engineer reads it from there.")],
                "note": "Published to the folder. Nothing was sent to GitHub, no decision was taken and no work has started."}
    # The architecture baseline reads the needs only from files committed on the main branch, so the folder is written too.
    folder = Path(saved["folder"])
    return {"published": True, **saved, "files": [str(folder / "needs.json")], "active": active, "unanswered": open_kinds, "factory_authorized": False,
            "ways_on": [host.say(f"Commit the folder {folder.relative_to(studio.draft)} to the repository's main branch; the engineers read the needs "
                                 "from there when they record their decisions.",
                                 "Add this folder to the project's repository; the engineers read the needs from there when they record their decisions.")],
            "note": host.first_warned(saved, f"Published on the project's issue (#{saved['issue']}) as version {saved['revision']}, and to the folder "
                                             "with the same version. No decision was taken and no work has started.")}


def add_commands(sub: Any, host: Any) -> None:
    """The `need` commands, wired into studio.py's parser. `host` is studio.py's own module."""
    def run(handler: Callable[[Any, Any, argparse.Namespace], Dict[str, Any]]) -> Callable[[Any, argparse.Namespace], int]:
        def call(studio: Any, args: argparse.Namespace) -> int:
            return host.emit(handler(host, studio, args))
        return call

    kinds = host.ticket_rules().NEED_KINDS
    group = sub.add_parser("need", help="technical needs: what the product requires of whatever is built, without technology").add_subparsers(
        dest="action", required=True, metavar="{add,set,retire,none,list,publish}")
    p = group.add_parser("add", help="add a technical need (only on the product manager's word)")
    p.add_argument("--kind", required=True, choices=kinds)
    p.add_argument("--statement", required=True, help="one or two sentences, no technology (a given may name one)")
    p.add_argument("--why", required=True, help="why it matters, in one sentence")
    p.add_argument("--said-by", help="a given only: who decided it (a name or role, or a policy pack ID)")
    p.add_argument("--said-on", help="a given only: the date it was said, such as 2026-11-21")
    p.set_defaults(func=run(cmd_add))
    p = group.add_parser("set", help="change a need; a changed statement is a new revision (only on the product manager's word)")
    p.add_argument("need_id", metavar="TN-NN")
    p.add_argument("--statement")
    p.add_argument("--why")
    p.add_argument("--said-by")
    p.add_argument("--said-on")
    p.set_defaults(func=run(cmd_set))
    p = group.add_parser("retire", help="retire a need; it is never brought back (only on the product manager's word)")
    p.add_argument("need_id", metavar="TN-NN")
    p.set_defaults(func=run(cmd_retire))
    p = group.add_parser("none", help="record 'nothing to say' about a kind, so it is not asked again (only on the product manager's word)")
    p.add_argument("--kind", required=True, choices=kinds)
    p.set_defaults(func=run(cmd_none))
    group.add_parser("list", help="the needs, unanswered kinds, where they are published, and ADRs behind; changes nothing").set_defaults(func=run(cmd_list))
    group.add_parser("publish", help="publish the needs on the project's GitHub issue, or to the ready folder (only on the product manager's word)"
                     ).set_defaults(func=run(cmd_publish))
