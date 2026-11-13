#!/usr/bin/env python3
"""Turn a raw Claude Code `stream-json --verbose` file into a fixture that is safe to keep in Git.

    python3 sanitize.py <raw stream.jsonl> <fixture.jsonl> [--arrivals <arrivals.jsonl>] [--label-prefix NAME]

What is kept, so a normalizer can be tested against the real shape:
- every record, in its original order, with its keys (the schema) unchanged;
- record types and subtypes, and every other value from a short list of enumerations (states, statuses,
  stop reasons, model names, tool names, the Claude Code version);
- every identifier, re-mapped to a stable fake of the same family (a `toolu_` id stays a `toolu_` id, a UUID a
  UUID), so the same real id always becomes the same fake id and every relationship between records survives;
- numbers (token counts, costs, durations); absolute times are shifted so the first time seen becomes a fixed
  base, which keeps every delta;
- agent labels and phase titles only when they are short, lower-case MACH vocabulary (after ticket IDs are
  re-mapped); anything else becomes a placeholder.

What is replaced: every other string. Prompts, model text, thinking, tool inputs and results, commands, paths,
file contents, environment values and anything secret-like become `<text>`, `<path>` or `<redacted>`.
When `--arrivals` is given (the observer's own log of when each line was read, written by the M6.1 tail tool),
each record gets one extra top-level key `_observed_ms`: milliseconds since the first line was read.

Standard library only. Deterministic: the same input gives the same output.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PREFIXED_ID_RE = re.compile(r"^(toolu|msg|req|srvtoolu)_[A-Za-z0-9]+$")
AGENT_ID_RE = re.compile(r"^a[0-9a-f]{16}$")
WORKFLOW_RUN_RE = re.compile(r"^wf_[0-9a-f-]+$")
ISO_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$")
TICKET_RE = re.compile(r"\b(LOCAL|AUTO|PROBE|SLICE|POC)-\d+\b")
# Keys whose string value is an identifier even when it has no recognisable shape (task ids, run ids).
ID_KEYS = {"task_id", "taskId", "run_id", "runId", "agent_id", "agentId", "tool_use_id", "parent_tool_use_id", "uuid",
           "session_id", "sessionId", "request_id", "requestId", "id", "parentUuid", "leafUuid", "promptId", "key"}
# Keys whose value is a closed vocabulary and safe to keep, when it is short and plain.
ENUM_KEYS = {"type", "subtype", "role", "state", "status", "stop_reason", "terminal_reason", "permissionMode",
             "apiKeySource", "claude_code_version", "model", "canonicalModel", "provider", "costBasis", "service_tier",
             "inference_geo", "speed", "task_type", "workflow_name", "workflowName", "decision_reason_type", "rateLimitType",
             "overageStatus", "fast_mode_state", "fast_mode_disabled_reason", "output_style", "tool_name", "lastToolName",
             "agentType", "kind", "producer", "requestShape", "pickedEffortModel", "effort", "view_mode", "caller_type",
             "defaultModel", "costUSD_basis", "toolDenialKind"}
# Keys whose value is a MACH-authored label or phase title: kept only if it looks like MACH vocabulary.
LABEL_KEYS = {"label", "title", "phaseTitle", "phase", "last_tool_name", "description"}
LABEL_RE = re.compile(r"^(TICKET-\d+: |probe: )?[A-Za-z][a-z ?-]{0,40}(: (TICKET-\d+: |probe: )?[a-z][a-z ?-]{0,40})?$")
# Subtrees that hold a tool's input or output, or model-written content: every string in them is replaced.
INERT_KEYS = {"input", "tool_input", "wire_tool_inputs", "wireToolInputs", "tool_use_result", "toolUseResult", "content",
              "text", "thinking", "result", "prompt", "promptPreview", "resultPreview", "lastToolSummary", "summary",
              "patch", "logs", "args", "params"}
# Closed vocabularies that are kept even inside such a subtree (a tool result's status, a permission decision).
INERT_ENUM_KEYS = {"type", "status", "taskType", "workflowName", "decision", "source", "reason_type", "stop_reason"}
TOOL_NAME_RE = re.compile(r"^[A-Z][A-Za-z]{1,30}$")
NAME_LIST_KEYS = {"tools", "agents", "skills", "slash_commands", "terminal_slash_commands", "toolsUsed"}
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9:_-]{0,40}$")
SECRETISH_RE = re.compile(r"((?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{10,}|(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{12,}|[A-Za-z0-9+/=_-]{40,})")
MS_LOW, MS_HIGH = 1_000_000_000_000, 10_000_000_000_000  # plausible Unix milliseconds
S_LOW, S_HIGH = 1_000_000_000, 10_000_000_000             # plausible Unix seconds
BASE_MS = 1_700_000_000_000                                # where the first time seen is moved to
TIME_KEYS_S = {"resetsAt", "overageResetsAt", "credential_expires_at"}


class Sanitizer:
    def __init__(self) -> None:
        self.ids: Dict[str, str] = {}
        self.counters: Dict[str, int] = {}
        self.tickets: Dict[str, str] = {}
        self.origin_ms: Optional[int] = None

    # ---- identifiers ----
    def fake(self, family: str, real: str) -> str:
        key = family + "\0" + real
        if key not in self.ids:
            n = self.counters.get(family, 0) + 1
            self.counters[family] = n
            if family == "uuid":
                self.ids[key] = f"00000000-0000-4000-8000-{n:012x}"
            elif family == "agent":
                self.ids[key] = f"a{n:016x}"
            elif family == "wf":
                self.ids[key] = f"wf_{n:08x}"
            elif family in ("toolu", "msg", "req", "srvtoolu"):
                self.ids[key] = f"{family}_FAKE{n:06d}"
            else:
                self.ids[key] = f"{family}{n:04d}"
        return self.ids[key]

    def identifier(self, value: str, key: str) -> str:
        if UUID_RE.match(value):
            return self.fake("uuid", value)
        m = PREFIXED_ID_RE.match(value)
        if m:
            return self.fake(m.group(1), value)
        if AGENT_ID_RE.match(value):
            return self.fake("agent", value)
        if WORKFLOW_RUN_RE.match(value):
            return self.fake("wf", value)
        if key in ID_KEYS and len(value) <= 80 and re.match(r"^[A-Za-z0-9:_.-]+$", value):
            family = {"task_id": "task", "taskId": "task", "run_id": "run", "runId": "run", "key": "key"}.get(key, "id")
            return self.fake(family, value)
        return None  # type: ignore[return-value]

    def ticket(self, text: str) -> str:
        def sub(m: "re.Match[str]") -> str:
            if m.group(0) not in self.tickets:
                self.tickets[m.group(0)] = f"TICKET-{len(self.tickets) + 1}"
            return self.tickets[m.group(0)]
        return TICKET_RE.sub(sub, text)

    # ---- time ----
    def shift_ms(self, ms: int) -> int:
        if self.origin_ms is None:
            self.origin_ms = ms
        return BASE_MS + (ms - self.origin_ms)

    def iso(self, value: str) -> str:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
        ms = int(moment.timestamp() * 1000)
        shifted = datetime.fromtimestamp(self.shift_ms(ms) / 1000, tz=timezone.utc)
        return shifted.strftime("%Y-%m-%dT%H:%M:%S.") + f"{shifted.microsecond // 1000:03d}Z"

    # ---- values ----
    def string(self, value: str, key: str, parent: str, inert: bool = False) -> str:
        fake = self.identifier(value, key)
        if fake is not None:
            return fake
        if ISO_RE.match(value):
            return self.iso(value)
        structural = (key in INERT_ENUM_KEYS or (key == "name" and parent in ("tool_use", "server_tool_use"))) and NAME_RE.match(value)
        if structural and len(value) <= 40:
            return value
        if inert:  # inside a tool's input or output, or model text: nothing is vocabulary there
            return "<path>" if value.startswith(("/", "~")) else ("" if value == "" else "<text>")
        if key in ("claude_code_version", "version") and re.match(r"^\d+\.\d+\.\d+$", value):
            return value
        if key in ENUM_KEYS and NAME_RE.match(value.replace(".", "").replace(" ", "_")) and len(value) <= 40 and not SECRETISH_RE.search(value):
            return value
        if key == "name" and parent in ("tool_use", "server_tool_use") and TOOL_NAME_RE.match(value):
            return value
        if key in LABEL_KEYS:
            mapped = self.ticket(value)
            # A description is kept only in the workflow's "<phase>: <label>" form; an Agent task's is model-written.
            if LABEL_RE.match(mapped) and len(mapped) <= 80 and (key != "description" or ": " in mapped):
                return mapped
        if parent in NAME_LIST_KEYS and NAME_RE.match(value):
            return value
        if value.startswith(("/", "~")) or re.match(r"^[A-Za-z]:\\", value):
            return "<path>"
        if SECRETISH_RE.search(value):
            return "<redacted>"
        if value == "":
            return ""
        return "<text>"

    def number(self, value: Any, key: str) -> Any:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return value
        if isinstance(value, int) and MS_LOW <= value < MS_HIGH:
            return self.shift_ms(value)
        if isinstance(value, int) and key in TIME_KEYS_S and S_LOW <= value < S_HIGH:
            return (self.shift_ms(value * 1000)) // 1000
        return value

    def walk(self, value: Any, key: str = "", parent: str = "", inert: bool = False) -> Any:
        if isinstance(value, dict):
            kind = value.get("type") if isinstance(value.get("type"), str) else ""  # what this dict is, for its own keys
            out = {}
            for k, v in value.items():
                new_key = k
                fake = self.identifier(k, "") if isinstance(k, str) else None
                if fake is not None:
                    new_key = fake
                elif k.startswith(("/", "~")):
                    new_key = "<path>"
                out[new_key] = self.walk(v, k, kind, inert or k in INERT_KEYS)
            return out
        if isinstance(value, list):
            return [self.walk(item, key, key if key in NAME_LIST_KEYS else parent, inert) for item in value]
        if isinstance(value, str):
            return self.string(value, key, parent, inert)
        return self.number(value, key)


def sanitize(lines: List[str], arrivals: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    s = Sanitizer()
    out = []
    times = []
    if arrivals:
        times = [a["t_ms"] for a in arrivals if "n" in a]
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            out.append({"_unparsable_line": True})
            continue
        clean = s.walk(record)
        if times and index < len(times):
            clean["_observed_ms"] = times[index] - times[0]
        out.append(clean)
    return out


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("raw")
    p.add_argument("fixture")
    p.add_argument("--arrivals")
    p.add_argument("--keep", help="1-based record ranges to keep, e.g. 1-12,180-202,320-327; each gap becomes one "
                                   '{"_omitted_records": n} line. Sanitizing always runs over the whole file first, so fake IDs are the same.')
    a = p.parse_args(argv)
    with open(a.raw, encoding="utf-8", errors="replace") as f:
        lines = f.read().split("\n")
    arrivals = None
    if a.arrivals:
        with open(a.arrivals, encoding="utf-8") as f:
            arrivals = [json.loads(l) for l in f if l.strip()]
    records = sanitize(lines, arrivals)
    if a.keep:
        wanted = set()
        for part in a.keep.split(","):
            low, _, high = part.partition("-")
            wanted.update(range(int(low), int(high or low) + 1))
        kept, gap = [], 0
        for number, record in enumerate(records, 1):
            if number in wanted:
                if gap:
                    kept.append({"_omitted_records": gap})
                    gap = 0
                kept.append(record)
            else:
                gap += 1
        if gap:
            kept.append({"_omitted_records": gap})
        records = kept
    with open(a.fixture, "w", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record, separators=(",", ":"), sort_keys=False) + "\n")
    print(f"{len(records)} records written to {a.fixture}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
