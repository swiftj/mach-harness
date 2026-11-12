# Execution-stream fixtures (M6.1)

Small JSONL files derived from **real** `claude -p --output-format stream-json --verbose` runs, made for the
M6.1 stream compatibility gate (`docs/mach-next/M6_1_STREAM_COMPATIBILITY.md`). They let a normalizer be
tested against the shape Claude Code actually writes, without keeping anything private.

| File | Run | What it shows |
|---|---|---|
| `probe-workflow.jsonl` | a three-agent probe workflow (`mach:probe`), launched with the Factory's exact flags and wrapper | Workflow tool call, `task_started`, `task_progress` with and without `workflow_progress`, a sub-agent's `permission_denied`, `task_updated`, `task_notification`, a second `init`, **two `result` records** |
| `belt-build-verify-review.jsonl` | the real `mach:belt` on one ticket from `planned`, `until: "merge"` (454 s, $1.82; the ticket went build, verify, review, revise, verify, review and stopped at `awaiting-human`) | **an excerpt**: records 1–42 (lifecycle, preflight clerks, the first builder, the first refusals), 146–201 (three reviewer seats in parallel, then the tally) and 320–327 (the end: `task_updated`, `task_notification`, second `init`, both `result` records). Each gap is one `{"_omitted_records": n}` line. The full sanitized run is 327 records and about 580 KB, too large to keep |
| `agent-tool-contrast.jsonl` | the same flags, a plain prompt that uses the **Agent** tool (not a workflow), model haiku | for contrast: Agent sub-agents *are* streamed, with `parent_tool_use_id` and `agent_id` |
| `workflow-tool-refused.jsonl` | the probe with `Workflow` removed from the tool list | the Workflow tool does not exist: no refusal, `success`, no workflow records at all |
| `budget-exceeded.jsonl` | the probe with a $0.03 budget, less than the first turn | `error_max_budget_usd`, the workflow `killed` right after launch, exit code 1 |
| `budget-stops-workflow.jsonl` | the probe with Opus agents and a $0.15 budget the agents cross mid-workflow | the workflow and its agents stopped (`killed`, `stopped`, agent `state: "error"`), yet the result is `success` and the exit code 0 |

See the compatibility document for the runtime version, the exact command lines and the date.

## How they were made

1. The run's raw `stream.jsonl` was written by MACH's own wrapper (`run.py factory exec`) into
   `.factory/local/executions/<id>/` of a throwaway scratch project, outside this repository.
2. An observer (`tail.py`, kept with the raw files, not here) read the file by byte offset every 50 ms and
   recorded when each complete line arrived.
3. `sanitize.py` (here, standard library only) turned the raw file into the fixture:

   ```
   python3 tests/fixtures/execution-streams/sanitize.py <raw stream.jsonl> <fixture.jsonl> --arrivals <arrivals.jsonl>
   ```

   - kept: every record in order, every key, record types and subtypes, short enumerations (states, statuses, stop
     reasons, model and tool names, the Claude Code version), numbers (tokens, costs, durations), and agent labels
     and phase titles that are plain MACH vocabulary (ticket IDs become `TICKET-n`);
   - re-mapped: every identifier to a stable fake of the same family (`toolu_FAKE000001`, `00000000-0000-4000-8000-…`,
     `a000…01`, `task0001`), the same real ID always to the same fake, so every relationship survives;
   - shifted: absolute times (ISO strings and Unix milliseconds) so the first one becomes 2023-11-14T22:13:20Z, keeping
     every delta;
   - replaced: every other string (prompts, model text, thinking, tool inputs and results, commands, paths, file
     contents, environment values, anything secret-like) by `<text>`, `<path>` or `<redacted>`;
   - added: `_observed_ms`, milliseconds since the first line was read by the observer. It is **not** a Claude Code
     field. With `--keep <ranges>` only those records are written (after sanitizing the whole file, so the fake IDs
     are the same) and each gap becomes one `{"_omitted_records": n}` line, also not a Claude Code record.

**The raw streams are not kept in Git**, and must never be: they hold source code, paths, commands, account and
organisation identifiers, and could hold credentials. `tests/test_stream_fixtures.py` checks every fixture for absolute
paths, home folders, token-like strings, e-mail addresses, real IDs and long text.
