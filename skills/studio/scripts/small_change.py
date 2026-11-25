"""MACH Product Studio: a small change (M18 parts A to C, the Product Studio half).

A slice started with `slice new --small` or `request pick --small` is of kind small: the short interview
(skills/intent/references/small-change.md) and the same spec, validator and gates as any slice. Whether it is still
small is the intent station's small.py, loaded, never copied: `slice check` and `slice ready` apply its rules, and a
slice a rule says is not small is widened by the check itself, with the rule's fixed sentence. It is never refused
for its size and never trimmed. `slice widen` does the same on the product manager's word (--why), or when an answer
in the short interview shows a rule does not hold (--by-rule). A widened slice is a full
slice from then on; nothing it holds is lost.

The work order carries, only for a slice of this kind, so every other slice is byte for byte what it was:

    "kind": "small"
    "small": {"change": "fix" | "adjustment", "shipped_rule": "SLICE-NNN/FR-NN" (a fix) | null (an adjustment)}
    "widened": {"at": <RFC 3339>, "reason": <the fixed sentence, or the person's words>, "rule": <small.py rule code> | null}

`host` is studio.py's module, passed in as the other Studio modules take it. Standard library only.
"""

import argparse
from typing import Any, Dict, Optional

KIND = "small"
METHOD = "small-change.md"


def helper(host: Any) -> Any:
    """The intent skill's small.py (M18 part A)."""
    host.intent_modules()
    import small  # noqa: E402
    return small


def is_small(data: Dict[str, Any]) -> bool:
    return data.get("kind") == KIND


def on_light_path(data: Dict[str, Any]) -> bool:
    return is_small(data) and not data.get("widened")


def limits(host: Any, studio: Any) -> Any:
    """The limits from intent.small_change, and any note about a value that could not be used."""
    try:
        config = studio.cell.load_config(studio.project)
    except Exception:  # noqa: BLE001  unreadable settings: the defaults
        config = {}
    return helper(host).settings(config)


def start_fields(host: Any, studio: Any, change: Optional[str], shipped_rule: Optional[str]) -> Dict[str, Any]:
    """The fields a slice starts with when the product manager asked for a small change. A fix names the shipped rule
    that is not holding, which must be in force on this computer's copy of the main branch; an adjustment names none."""
    small = helper(host)
    if change not in small.CHANGES:
        raise host.StudioError(host.say("Say which kind of small change this is: --change fix (a shipped rule is not holding) or --change adjustment "
                                        "(wording, presentation, a default or a limit).",
                                        "Say which kind of small change this is: a fix (a shipped rule is not holding) or an adjustment "
                                        "(wording, presentation, a default or a limit)."))
    if change == "adjustment":
        if shipped_rule:
            raise host.StudioError(host.say("An adjustment names no shipped rule (--rule is only for a fix).", "An adjustment names no shipped rule; only a fix does."))
        return {"kind": KIND, "small": {"change": change, "shipped_rule": None}}
    rule = (shipped_rule or "").strip()
    if not rule:
        raise host.StudioError(host.say("A fix names the shipped rule that is not holding: --rule SLICE-NNN/FR-NN. Look it up in shipped_rules (slice resume).",
                                        "A fix names the shipped rule that is not holding, such as SLICE-003/FR-02."))
    if not small.is_shipped_rule(rule):
        raise host.StudioError(f"'{rule[:60]}' is not a shipped rule. Write it as SLICE-NNN/ and an INV-NN, FR-NN or RN, such as SLICE-003/FR-02.")
    in_force = {item.get("rule") for item in studio.shipped().get("in_force") or [] if isinstance(item, dict)}
    if rule not in in_force:
        raise host.StudioError(host.say(f"{rule} is not a shipped rule in force on this computer's copy of the main branch, so there is nothing to fix there. "
                                        "Look the rule up in shipped_rules (slice resume), or start an adjustment.",
                                        f"{rule} is not a shipped rule in force, so there is nothing to fix there. Look the rule up, or start an adjustment."))
    return {"kind": KIND, "small": {"change": change, "shipped_rule": rule}}


def refuse_flags(host: Any, args: argparse.Namespace) -> None:
    if not getattr(args, "small", False) and (getattr(args, "change", None) or getattr(args, "rule", None)):
        raise host.StudioError(host.say("--change and --rule describe a small change; add --small.", "Only a small change has a kind and a shipped rule."))


def shipped_slices(studio: Any) -> set:
    found = set()
    for item in studio.shipped().get("rules") or []:
        name = item.get("rule") if isinstance(item, dict) else item
        if isinstance(name, str) and "/" in name:
            found.add(name.split("/")[0])
    return found


def judge(host: Any, studio: Any, data: Dict[str, Any], model: Dict[str, Any], text: str, risk: Optional[str]) -> Dict[str, Any]:
    """Part A's first seven rules for this slice: its spec, its one epic, its why's risk tier, its dependencies."""
    found, _ = limits(host, studio)
    depends_on = list(data.get("dependencies") or [])
    if depends_on and data.get("slice_id"):
        # M21: a small change brought in from another repository waits for the slices that came with it and had shipped there
        # (its fix's own rule's slice among them); they ship here first. It stays a small change; the engineers judge it again
        # against what has shipped when they take it, by which time those slices have shipped.
        import project_import
        waiting = project_import.waiting_on(studio, data["slice_id"])
        depends_on = [d for d in depends_on if d not in waiting]
    return helper(host).judge(model, text, epics=[data.get("epic_id")], risks=[risk], depends_on=depends_on,
                              shipped_slices=shipped_slices(studio), limits=found)


def view(host: Any, studio: Any, data: Dict[str, Any], verdict: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """What a report says about a slice of this kind: its kind, whether it is still on the light path, and when widened, why."""
    small = data.get("small") if isinstance(data.get("small"), dict) else {}
    widened = data.get("widened") if isinstance(data.get("widened"), dict) else None
    out: Dict[str, Any] = {"kind": KIND, "change": small.get("change"), "shipped_rule": small.get("shipped_rule"),
                           "light_path": widened is None, "widened": widened}
    if widened is None and verdict is not None:
        out["verdict"] = verdict
    if widened is not None:
        out["note"] = (f"This small change is a full slice now: {widened.get('reason')} The interview carries on in full, "
                       "with every answer kept.")
    return out


def check_field(host: Any, studio: Any, data: Dict[str, Any], model: Optional[Dict[str, Any]], text: Optional[str], risk: Optional[str]) -> Dict[str, Any]:
    """For `slice check` (and `slice show`, which records nothing): the verdict on a slice still on the light path."""
    if not is_small(data):
        return {}
    verdict = judge(host, studio, data, model, text or "", risk) if on_light_path(data) and model is not None else None
    return {"small_change": view(host, studio, data, verdict)}


def widen_if_needed(host: Any, studio: Any, slice_id: str, data: Dict[str, Any], result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """At `slice check` and `slice ready`: a slice on the light path that a rule says is not small is widened by the check,
    with the rule's fixed sentence as the reason. Never a refusal; nothing in the spec or the why changes. Returns the
    record when it widened now."""
    verdict = (result.get("small_change") or {}).get("verdict")
    if not on_light_path(data) or not verdict or verdict.get("small"):
        return None
    data["widened"] = helper(host).widening(verdict, host.now(None))
    studio.save("slice", data, bump=False)
    result["small_change"] = dict(view(host, studio, data), widened_now=True)
    return data["widened"]


def handoff_record(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """What travels with the slice when it is marked ready (M18 part D): the issue's marker and approval, or the ready
    folder's slice.json, carry it as identifiers, beside the approved text and never inside its SHA-256. None for a slice
    that is not small, so its handoff is exactly what it was. The product manager's own words for widening stay here."""
    if not is_small(data):
        return None
    small = data.get("small") if isinstance(data.get("small"), dict) else {}
    widened = data.get("widened") if isinstance(data.get("widened"), dict) else None
    return {"kind": KIND, "change": small.get("change"), "shipped_rule": small.get("shipped_rule"),
            "widened": None if widened is None else {"rule": widened.get("rule"), "at": widened.get("at")}}


def widened_by_question(host: Any, studio: Any, data: Dict[str, Any], question: Optional[str]) -> Optional[Dict[str, Any]]:
    """At `slice reopen`: a small change the Factory stopped because a rule says it is not small (its question on the
    slice's issue quotes the rule's fixed sentence) comes back widened, with that sentence as the reason. Only the rule's
    code is read from the question, which is the builders' text and data; widening only ever leads to the full interview."""
    if not on_light_path(data):
        return None
    found = helper(host).sentence_in(question)
    if found is None:
        return None
    data["widened"] = {"at": host.now(None), "reason": found[1], "rule": found[0]}  # the Factory's own sentence is the reason
    return data["widened"]


def status_field(data: Dict[str, Any]) -> Dict[str, Any]:
    """For a status row: the kind and, when it left the light path, why. Nothing for any other slice."""
    if not is_small(data):
        return {}
    small = data.get("small") if isinstance(data.get("small"), dict) else {}
    return {"kind": KIND, "small": {"change": small.get("change"), "shipped_rule": small.get("shipped_rule"),
                                    "light_path": not data.get("widened"), "widened": data.get("widened")}}


def resume_field(host: Any, studio: Any, slice_id: str, data: Dict[str, Any], check: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """For the interview: which method to follow, the limits, and the words for leaving the path. Nothing for any other slice."""
    if not is_small(data):
        return {}
    small = helper(host)
    found, notes = limits(host, studio)
    field = view(host, studio, data, ((check or {}).get("small_change") or {}).get("verdict"))
    field["limits"] = found
    if notes:
        field["settings_notes"] = notes
    if on_light_path(data):
        field["method"] = str(host.sibling("intent") / "references" / METHOD)
        field["questions_sentence"] = small.sentence("questions", found)
        field["rules"] = {rule: small.sentence(rule, found) for rule in small.SPEC_RULES + ("questions",)}
        field["note"] = (f"A small change: follow the short interview in {METHOD}. Ask at most {found['questions']} yes-or-no questions. "
                         "When an answer or a check shows it is not small, it becomes a full slice: never trim the change to keep it small.")
    else:
        field["method"] = str(host.sibling("intent") / "references" / "interview-method.md")
    return {"small_change": field}


def cmd_widen(host: Any, studio: Any, args: argparse.Namespace) -> int:
    """Leave the light path: on the product manager's word, with their reason (--why), or when an answer in the short
    interview shows a rule of a small change does not hold (--by-rule, whose fixed sentence is the reason). Never the
    other way: nothing here makes a slice small. The slice carries on as a full slice, with nothing in it changed."""
    studio.prepare()
    data = host.require_editable(studio, args.slice_id)
    if not is_small(data):
        raise host.StudioError(f"{args.slice_id} is not a small change, so it is already a full slice.")
    if data.get("widened"):
        raise host.StudioError(f"{args.slice_id} is already a full slice ({data['widened'].get('at')}): {data['widened'].get('reason')}")
    small = helper(host)
    if args.by_rule is not None:
        if args.by_rule not in small.RULES:
            raise host.StudioError(f"'{args.by_rule[:40]}' is not a rule for a small change. The rules are: {', '.join(small.RULES)}.")
        data["widened"] = small.widening(small.verdict([args.by_rule], limits(host, studio)[0]), host.now(None))
    else:
        why = " ".join((args.why or "").split())
        if not why:
            raise host.StudioError(host.say("Give the reason in the product manager's words (--why).", "Give the reason, in your words."))
        data["widened"] = small.asked(why, host.now(None))
    studio.commit_or_restore([("slice", data)], f"Widening {args.slice_id}")
    return host.emit({"widened": True, "slice": studio.load("slice", args.slice_id), **resume_field(host, studio, args.slice_id, data, None),
                      "factory_authorized": False,
                      "note": "It is a full slice now: the interview carries on in full, with every answer kept. Nothing in its spec or why was changed."})


def add_commands(slice_parsers: Any, host: Any) -> None:
    p = slice_parsers.add_parser("widen", help="make a small change a full slice, so its interview carries on in full")
    p.add_argument("slice_id")
    reason = p.add_mutually_exclusive_group(required=True)
    reason.add_argument("--why", help="the product manager's reason, in their words (only on their word)")
    reason.add_argument("--by-rule", metavar="RULE", help="the rule of a small change an answer showed does not hold, such as actor or questions")
    p.set_defaults(func=lambda studio, args: cmd_widen(host, studio, args))


def add_start_flags(p: argparse.ArgumentParser) -> None:
    """--small, --change and --rule, for `slice new` and `request pick`."""
    p.add_argument("--small", action="store_true", help="a small change: the short interview, the same spec and gates (M18)")
    p.add_argument("--change", choices=("fix", "adjustment"), help="with --small: a fix (a shipped rule is not holding) or an adjustment")
    p.add_argument("--rule", metavar="SLICE-NNN/FR-NN", help="with --small --change fix: the shipped rule that is not holding")


def start_from_args(host: Any, studio: Any, args: argparse.Namespace) -> Optional[Dict[str, Any]]:
    refuse_flags(host, args)
    return start_fields(host, studio, args.change, args.rule) if getattr(args, "small", False) else None

