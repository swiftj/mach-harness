#!/usr/bin/env python3
"""MACH small change (M18 part A): whether a change is small, decided by fixed rules, never by a model.

One module, loaded by Product Studio and by the intent station, never copied. It answers `small` or `not small`
with one fixed sentence naming the rule that decided. A change is small only when every rule holds; the first rule
that does not hold, in the order below, decides. A person cannot declare a change small past a rule that says it
is not: nothing here takes an override.

From the spec (whenever the spec is checked), reading the validator's model (`validate_slice.analyze`):

    actor                 the Summary's Actor names one persona (the validator's own single-actor test, decisive here)
    capability            the change belongs to at most one epic
    requirements          at most `requirements` functional requirements (default 3)
    scenarios             at most `scenarios` scenarios (default 4)
    matrix                one decision matrix table (counted from the spec text)
    changed-rules         at most `changed_shipped_rules` shipped rules `changed` or `replaced` (default 1)
    retired-rule          no shipped rule `retired`; any number `kept`
    principle-exception   no principle answered `Exception`
    policy-concern        no pack answered `Concerns`, whatever each concern's resolution
    permission            `Required permissions` begins with the word None
    unshipped-dependency  every slice it depends on, and every SLICE-NNN named under `External dependencies`, has shipped
    risk                  no risk tier given is High (intent.md, and the risk floor a cell holds)

From the interview: `questions` (at most `questions` yes-or-no questions, default 5) has a sentence here, so the one
who leaves the path for it says the same words; the interview counts its own questions.

From the plan, once there is one (`judge_plan`): no existing contract changed, no file in a high-risk area (the ticket
station's `scans.py` `risk_for`, as Shape's routing uses it), no ADR proposed.

The limits are `intent.small_change` in .factory/config.json; a value that cannot be used reads as its default, with a
note, so a typo never loosens a rule. Missing data is never evidence: a spec with no Summary yet is not "not small".

    settings(config)                              -> (limits, notes)
    judge(model, text=None, ...)                  -> verdict     pure
    judge_plan(project, files, ...)               -> verdict
    sentence(rule, limits=None)                   -> str
    widening(verdict, at) / asked(why, at)        -> the `widened` record a slice or a cell keeps

A verdict is {"verdict": "small" | "not small", "small": bool, "rule": code or None, "sentence": str, "failed": [codes]}.

Standard library only.
"""

import importlib.util
import re
import sys
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import validate_slice  # noqa: E402

KIND = "small"
CHANGES = ("fix", "adjustment")
SMALL, NOT_SMALL = "small", "not small"

DEFAULTS = {"requirements": 3, "scenarios": 4, "questions": 5, "changed_shipped_rules": 1}
# Decision 3 of the design: a small change changes at most one shipped rule, so that limit can be lowered, never raised.
BOUNDS = {"requirements": (1, 10), "scenarios": (1, 10), "questions": (1, 10), "changed_shipped_rules": (0, 1)}

# The rules in the order they are checked. The first that does not hold decides.
SPEC_RULES = ("actor", "capability", "requirements", "scenarios", "matrix", "changed-rules", "retired-rule",
              "principle-exception", "policy-concern", "permission", "unshipped-dependency", "risk")
PLAN_RULES = ("contract", "high-risk-file", "adr")
RULES = SPEC_RULES + ("questions",) + PLAN_RULES

LEAD = "This is not a small change: "
SENTENCES = {
    "actor": LEAD + "a small change has one actor, and this one names more than one.",
    "capability": LEAD + "a small change belongs to one epic, and this one spans more than one.",
    "requirements": LEAD + "a small change has at most {requirements} functional requirements, and this one has more.",
    "scenarios": LEAD + "a small change has at most {scenarios} scenarios, and this one has more.",
    "matrix": LEAD + "a small change has one decision matrix, and this one has more.",
    "changed-rules": LEAD + "a small change changes or replaces at most {changed_shipped_rules} shipped rule{s}, and this one changes more.",
    "retired-rule": LEAD + "a small change retires no shipped rule, and this one retires one.",
    "principle-exception": LEAD + "a small change makes no exception to a product principle, and this one makes one.",
    "policy-concern": LEAD + "a small change raises no policy concern, open or accepted, and this one raises one.",
    "permission": LEAD + "a small change needs no new permission, and this one names one.",
    "unshipped-dependency": LEAD + "a small change depends on no slice that has not shipped, and this one does.",
    "risk": LEAD + "a small change is Low or Medium risk, and this one is High.",
    "questions": LEAD + "a small change needs at most {questions} questions, and this one needs more.",
    "contract": LEAD + "a small change changes no existing contract, and the plan changes one.",
    "high-risk-file": LEAD + "a small change touches no file in a high-risk area, and the plan touches one.",
    "adr": LEAD + "a small change proposes no architecture decision, and the plan proposes one.",
}
SMALL_SENTENCE = "This is a small change: every rule for a small change holds."

SLICE_ID_RE = re.compile(r"\bSLICE-\d{3,}\b")
SHIPPED_RULE_RE = re.compile(r"^(SLICE-\d{3,})/((?:INV|FR)-\d{2,}|R\d+)$")
NONE_WORD_RE = re.compile(r"^\s*none\b", re.IGNORECASE)


# ---- settings ----

def settings(config: Any) -> Tuple[Dict[str, int], List[str]]:
    """intent.small_change in .factory/config.json: each limit a whole number within BOUNDS. Missing reads as the default;
    anything else unusable reads as the default too, with a note, so a typo never loosens a rule."""
    intent = config.get("intent") if isinstance(config, dict) and isinstance(config.get("intent"), dict) else {}
    section = intent.get("small_change") if isinstance(intent.get("small_change"), dict) else {}
    limits, notes = dict(DEFAULTS), []
    if "small_change" in intent and not isinstance(intent.get("small_change"), dict):
        notes.append("intent.small_change in .factory/config.json must be an object of limits; it was not, so the defaults are used.")
    for key, (low, high) in BOUNDS.items():
        if key not in section:
            continue
        value = section[key]
        if type(value) is int and low <= value <= high:
            limits[key] = value
        else:
            notes.append(f"intent.small_change.{key} in .factory/config.json must be a whole number from {low} to {high}; "
                         f"it was not, so {DEFAULTS[key]} is used.")
    return limits, notes


def sentence(rule: Optional[str], limits: Optional[Mapping[str, int]] = None) -> str:
    """The one fixed sentence for a rule (None: the change is small)."""
    if rule is None:
        return SMALL_SENTENCE
    given = dict(DEFAULTS, **(limits or {}))
    return SENTENCES[rule].format(s="" if given["changed_shipped_rules"] == 1 else "s", **given)


def verdict(failed: Sequence[str], limits: Optional[Mapping[str, int]] = None) -> Dict[str, Any]:
    rule = failed[0] if failed else None
    return {"verdict": SMALL if rule is None else NOT_SMALL, "small": rule is None, "rule": rule,
            "sentence": sentence(rule, limits), "failed": list(failed)}


# ---- the spec's rules ----

def matrix_tables(text: Optional[str]) -> int:
    """How many tables '### Decision matrix' holds, read as the validator reads the spec. 0 when there is no text."""
    if not text:
        return 0
    root, _ = validate_slice.parse(text.splitlines(), validate_slice.Report())
    count = 0
    for section in validate_slice.flatten(root):
        if section.level == 3 and section.title.lower() == "decision matrix":
            previous = False
            for _, line in section.body:
                table = line.strip().startswith("|")
                count += 1 if table and not previous else 0
                previous = table
    return count


def several_actors(actor: Optional[str]) -> bool:
    """The validator's single-actor test: and, or, '/', '&' or a comma outside parentheses names more than one persona."""
    return bool(actor) and bool(validate_slice.MULTI_ACTOR_RE.search(validate_slice.PARENTHETICAL_RE.sub("", actor)))


def judge(model: Mapping[str, Any], text: Optional[str] = None, *, epics: Iterable[Optional[str]] = (),
          risks: Iterable[Optional[str]] = (), depends_on: Iterable[str] = (), shipped_slices: Optional[Iterable[str]] = None,
          limits: Optional[Mapping[str, int]] = None) -> Dict[str, Any]:
    """Part A's first seven rules against a spec. Pure.

    `model` is validate_slice.analyze's model (the --export form); `text` the spec itself, for the matrix count.
    `epics`: the epics the change belongs to (Studio: the slice's one epic; a cell: its epic, if any).
    `risks`: every tier that applies (intent.md's, and the risk floor a cell holds); any High decides.
    `depends_on`: the slices the work order depends on. `shipped_slices`: the slice IDs that have shipped
    (None reads as none, so an unknown never counts as shipped)."""
    given = dict(DEFAULTS, **(limits or {}))
    shipped = set(shipped_slices or ())
    own = model.get("slice_id")
    failed: List[str] = []
    summary = model.get("summary") or {}
    if several_actors(summary.get("actor")):
        failed.append("actor")
    if len({epic for epic in epics if epic}) > 1:
        failed.append("capability")
    if len(model.get("functional_requirements") or []) > given["requirements"]:
        failed.append("requirements")
    if len(model.get("scenarios") or []) > given["scenarios"]:
        failed.append("scenarios")
    if matrix_tables(text) > 1:
        failed.append("matrix")
    effects = [row.get("effect") for row in model.get("effects") or [] if isinstance(row, dict)]
    if sum(1 for effect in effects if effect in ("changed", "replaced")) > given["changed_shipped_rules"]:
        failed.append("changed-rules")
    if "retired" in effects:
        failed.append("retired-rule")
    if any(isinstance(row, dict) and row.get("answer") == "exception" for row in model.get("principles") or []):
        failed.append("principle-exception")
    if any(isinstance(row, dict) and (row.get("answer") == "concerns" or row.get("concerns")) for row in model.get("policies") or []):
        failed.append("policy-concern")
    permissions = model.get("required_permissions")
    if isinstance(permissions, str) and permissions.strip() and not NONE_WORD_RE.match(permissions):
        failed.append("permission")
    named = {match for item in model.get("external_dependencies") or [] if isinstance(item, dict)
             for match in SLICE_ID_RE.findall(str(item.get("name") or ""))}
    if any(slice_id not in shipped for slice_id in (set(depends_on) | named) - {own}):
        failed.append("unshipped-dependency")
    if any(str(risk or "").strip() == "High" for risk in risks):
        failed.append("risk")
    return verdict(failed, given)


# ---- the plan's rule (check-plan) ----

_LOADED: Dict[str, Any] = {}


def scan_rules() -> Any:
    """The ticket station's scans.py, loaded by path whichever way MACH is installed, never copied: its risk_for decides High."""
    if "scans" not in _LOADED:
        folder = next((HERE.parent.parent / name / "scripts" for name in ("mach-ticket", "ticket")
                       if (HERE.parent.parent / name / "scripts" / "scans.py").is_file()), None)
        if folder is None:
            raise RuntimeError(f"The MACH ticket station's scans.py is not installed next to the intent station ({HERE.parent.parent}).")
        if str(folder) not in sys.path:
            sys.path.insert(0, str(folder))  # scans.py imports issue_rules from beside it
        found = importlib.util.spec_from_file_location("mach_scans_for_small", folder / "scans.py")
        module = importlib.util.module_from_spec(found)
        found.loader.exec_module(module)
        _LOADED["scans"] = module
    return _LOADED["scans"]


def judge_plan(project: Path, files: Iterable[str], changed_contracts: Iterable[str] = (), proposed_adrs: Iterable[str] = (),
               risk_for: Optional[Callable[[Path, str], Tuple[str, str]]] = None,
               limits: Optional[Mapping[str, int]] = None) -> Dict[str, Any]:
    """Part A's eighth rule, once there is a plan. `files`: every file the plan's tasks touch (cell.py plan_files);
    `changed_contracts`: the plan's contracts that already exist on the main checkout; `proposed_adrs`: the ADRs this
    ticket proposes. `risk_for` is scans.py's (loaded when not given). The verdict adds `high_risk`: each file judged
    High with the reason risk_for gave."""
    rate = risk_for or scan_rules().risk_for
    contracts = [item for item in changed_contracts if item]
    high = []
    for name in dict.fromkeys(list(files) + contracts):
        tier, why = rate(Path(project), name)
        if tier == "High":
            high.append({"file": name, "why": why})
    failed = [rule for rule, holds in (("contract", not contracts), ("high-risk-file", not high),
                                       ("adr", not [item for item in proposed_adrs if item])) if not holds]
    return {**verdict(failed, limits), "high_risk": high}


# ---- the record a slice or a cell keeps when it leaves the light path ----

def widening(found: Mapping[str, Any], at: str) -> Dict[str, Any]:
    """`widened`, when a check found the change is not small: the rule, its fixed sentence as the reason, and when."""
    return {"at": at, "reason": found["sentence"], "rule": found["rule"]}


def asked(why: str, at: str) -> Dict[str, Any]:
    """`widened`, on a person's word: their reason and when; no rule decided it."""
    return {"at": at, "reason": " ".join(str(why).split()), "rule": None}


def is_shipped_rule(value: Any) -> bool:
    """A fix names the shipped rule that is not holding: SLICE-NNN/ and an INV-NN, FR-NN or RN."""
    return isinstance(value, str) and bool(SHIPPED_RULE_RE.fullmatch(value))
