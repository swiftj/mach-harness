# M14 part A, as built: policy packs

This note covers part A of `M14_DESIGN.md`. It says what was built, each choice where the design was silent, the exact blocks added to shared files, what is not built, and how far it is tested. Parts B to E are not part of this step.

It follows two existing patterns and copies neither: architecture decisions (`adr.py`, `M11_ADRS.md`: files in the repository read from committed state, the `applies-to` grammar, digests recorded in the cell, timing, a person's act on their word, review citing by ID) and product principles (`M13_PRINCIPLES.md`: an optional spec section, the validator given outside facts as an input so it stays pure, `cell.py` fetching them, Studio passing them, the interview reading them first, the review packet and citation rule).

## The pack

A pack is a folder, `policies/<pack>/policy.md` (`policies.dir` in `.factory/config.json` moves it; the scaffolded settings say `policies`). Engineers change it by pull request, like an ADR.

```markdown
---
id: POL-privacy
title: Privacy
owner: Data protection officer (@acme/privacy)
status: active
applies-to:
  - topic:privacy
  - topic:email
---

# Privacy

- **POL-privacy-01:** An invitation email MUST name the workspace that sent it.
- **POL-privacy-02:** Personal data MUST NOT be sent to a service outside the EU region.
```

- The header is read by `adr.front_matter`, and `applies-to` by `adr.check_applies` (`path:`, `app:`, `topic:`, `all`; missing means `all`). Required: `id` (exactly `POL-<folder name>`), `title`, `owner`, `status` (`active` or `retired`).
- `owner` is a role or team, optionally followed by a GitHub login or team in brackets.
- A pack name is lowercase words joined by `-`, each word starting with a letter, so `POL-<pack>-NN` is never ambiguous.
- Statements are lines `- **POL-<pack>-NN:** <sentence>`: one sentence ending in `.`, with an uppercase RFC 2119 keyword (any of them: MUST, SHALL, SHOULD, MAY, REQUIRED, RECOMMENDED, OPTIONAL), at most 400 characters, and no double quotation marks, `**` or comment markers (every spec quotes it). Other text in the file is free.
- Strict: a header it cannot read, a wrong `id`, a missing field, an unknown status, a bad `applies-to` item, a malformed statement line, a statement numbered for another pack, a repeated number, no statements, a bad folder name, or a folder in `policies/` without a `policy.md` is a problem with its reason. A pack with a problem never binds and is never given to the validator as a pack; its problem is given instead, and every spec check then fails with `policy-problem` until an engineer fixes it (as a malformed ADR stops planning).

## What was built

| Where | What |
|---|---|
| `skills/intent/scripts/policies.py` | New. The one reader (`listing`: the main checkout's HEAD, or its working tree with no commit yet), the selection rule (`applies`, `spec_words`, `seats`), the validator's input (`for_validator`, `shape`, `load`), the one parser and check of `## Policies` (`parse_section`, `check_section`, `export`, `open_concerns`), the owner's act (`accept`), the interview's view (`for_interview`), timing (`drift`, `drift_text`) and review's citation helper (`statement_ids`). |
| `skills/intent/scripts/validate_slice.py` | `## Policies` in the section order; `analyze(..., policies=...)`; `--policies FILE`; `spec.json` `policies`. |
| `skills/intent/scripts/cell.py` | `validate` and `finalize` pass the packs; `finalize` holds an open concern at `spec-open` and records `cell.json` `policies` with kept copies; new `policies` and `policy-accept`; `check-plan` refuses a task that changes a pack; `status <ticket>` adds `policies_changed`. |
| `skills/product-studio/scripts/studio.py` | Every spec check passes the packs; `slice resume` prints `policies`; new `policy list` and `policy accept`. |
| `skills/review/scripts/review.py` | The packet's `policies`; `submit` refuses a citation outside the rule (`policy-citation`); `start` refuses a `factory-tuning` change that touches the packs' folder. |
| `skills/run/scripts/run.py` | New `policy list` (reads only). |
| `templates/policies/security/policy.md` | A starter pack, not installed. |
| `templates/config.json` | `"policies": {"dir": "policies"}`. |
| Instructions | The slice template, `spec-structure.md`, `interview-method.md`, `headless.md`, `contracts-and-plan.md`, the intent, Product Studio and run skills, the contract engineer, builder and reviewer agents, the three review checklists, the reviewer brief, the shipped `REVIEW.md`, `CLAUDE.md`. |
| `tests/test_mach_policy_packs.py` | New, 28 tests. |

## The spec's section

`## Policies` is optional and sits after `## Principles` (so after `## Acceptance criteria` and `## Effects on shipped behaviour`, before `## Dependencies and permissions`): `OPTIONAL_SECTIONS` gained it, which fixes its place in the order. One line per pack that applies:

```
## Policies

- **POL-security** (sha256 1a2b3c4d5e6f): Followed.
- **POL-privacy** (sha256 9f8e7d6c5b4a): Concerns.
  - **POL-privacy-02**: "Personal data MUST NOT be sent to a service outside the EU region." **Cannot be met:** The email service sits outside the EU. **Owner:** Data protection officer (@acme/privacy). **Resolution:** open.
```

A resolution is `open`, `spec changed` (the spec was changed so the statement is met; the line stays as the record), or `accepted by <who> on <YYYY-MM-DD>: "<their words>"`, which only `policy accept` writes. `- None.` is allowed when nothing applies.

### The checks (`policies.check_section`, through `validate_slice.check_policies`)

- Always, row by row: `policy-format` (a line in any other form, a concern not under its own pack's line, a concern under `Followed`, `Concerns` with none listed, `None.` beside rows), `policy-reason`, `policy-resolution`, `policy-owner` (missing), `duplicate-id`, `empty-section`, and `policy-concern-open`: a warning while drafting, an error with `--ready`.
- With the packs: `policy-problem` (a pack cannot be read), `policy-unanswered` (an active pack that applies has no line, or there is no section), `policy-unknown` (a pack or statement that does not exist), `policy-quote`, `policy-owner` (not exactly the pack's owner), `policy-digest` (answered under an older version), and `policy-retired` (a warning).
- Without the packs (`policies=None`): the rows are checked on their own. A project with no packs, or none that applies, needs no section, and every existing spec stays valid.
- `spec.json` gains `policies` (`pack`, `sha256`, `answer` of `followed` or `concerns`, `concerns` with `statement_id`, `statement`, `why`, `owner`, `resolution` of `open`, `accepted` or `spec_changed`, and `by`, `on`, `words` for an acceptance) only when the spec has the section.
- `--policies FILE` takes `cell.py policies --json` or `run.py policy list` output (`{"packs": [...], "problems": [...]}`); an unreadable file exits 2, as `--principles` does.

## The gate

- **`slice ready`** (Studio) runs the check with `--ready`, so a pack left unanswered or an open concern refuses it. No new Studio code was needed for the gate beyond passing the packs.
- **`cell.py finalize`** treats `policy-concern-open` as it treats open questions: the spec is saved at `spec-open`, `spec.json` is not written, the exit is 1 (0 with `--allow-open`), and the message says the concern waits for its owner. Every other policy error is a hard refusal. In headless mode `run.py next` already stops a `spec-open` cell for a person.
- **`policy accept`**: Studio `policy accept <SLICE-ID> <POL-id> --by "<owner>" --reason "<their words>"` on an editable slice; `cell.py policy-accept <ticket> --policy <POL-id> --by --reason` for a ticket groomed in a cell, at `interview` or `spec-open`. Both refuse inside a supervised execution (`MACH_EXECUTION_ID`), a statement with no open concern, a name or words with quotation marks, and words under 10 characters. `cell.py` also refuses a slice from Product Studio (its product manager records it there, in a new revision) and records `cell.json` `policy_acceptances`. The run skill routes `/mach policy accept <ticket or SLICE-ID> <POL-id> "<their words>"` to one or the other, as `/mach adr except` is routed: only on the person's explicit word, never recommended.

## Fetching and passing the packs

- `cell.py validate` and `finalize` read the packs from the main checkout's committed state each time (`policy_input`). For a cell whose `cell.json` has `product` (a Product Studio slice), they pass none: the slice was checked when the product manager marked it ready, and a pack changed since binds slices marked ready afterwards. Its rows are still checked on their own, so an open concern still holds it.
- `cell.py policies` (reads only) prints the active packs, bounded and fenced between `<<<POLICY-PACKS-DATA ...>>>` and `<<<END-POLICY-PACKS-DATA>>>`; `--json` prints the validator's input.
- Studio reads the packs once per command from the product manager's checkout (`Studio.policy_listing`), through `policies.py` loaded from the intent scripts folder as `shipped.py` is. `studio.py` still imports no `subprocess` and runs no Git itself.
- `finalize` records `cell.json` `policies`: the commit, the folder, whether the spec was checked against the packs, and per pack its digest, answer and, when the spec answered the version on main, a copy of its text in the cell's `policies/POL-<pack>.md`.

## The interview, headless mode and the plan

- `interview-method.md` gains "Policy packs": read them before the first question; follow them in recommendations, naming the statement; a conflict, or two statements that contradict each other for this slice, is the next question, with meeting the statement as the recommendation; on the PM's no it becomes a concern naming the owner exactly, resolution `open` (a contradiction is a concern on each statement, each naming the other); only the owner settles one, never recommended; the Sanity check names each concern and its owner.
- `headless.md`: packs are settled rules; a statement the slice cannot meet is a concern `open` and also an open question naming the owner; never an acceptance headless.
- The intent skill's step 5 runs `CELL policies`; Product Studio's `slice resume` prints `policies` only when the project has packs, so other resumes are exactly as before.
- The contract engineer (`contracts-and-plan.md`, `agents/contract-engineer.md`) follows every statement of each pack listed and the owner's accepted decisions; the builder (`agents/builder.md`) does too and never changes a pack's file. `cell.py check-plan` refuses a plan task that changes a file in the packs' folder.

## Review

- `review.py start` adds `policies` to the packet only when `spec.json` has them: per pack its ID, digest, answer, title and owner, `seats`, `read` (the kept copy), its statement IDs, `accepted_by_owner` (each marked as the owner's decision, not the panel's to reopen) and `met_by_changing_the_spec`; and `changed_since_ready` (the timing flag, advice only).
- Seats: the security seat checks packs whose `applies-to` names `topic:security` or `topic:privacy`, the product seat `topic:brand`, `topic:ux` or `topic:accessibility`; a pack naming none of these is marked `all`, checked by every seat (the architecture checklist says so for its seat). The security, product and architecture checklists, the reviewer brief, `agents/reviewer.md` and the shipped `REVIEW.md` each gained a line.
- `review.py submit` refuses a blocker whose rule cites a pack or statement (`POL-privacy` or `POL-privacy-02`) whose pack the spec does not list, a statement the kept copy does not have, or a concern its owner accepted (`policy-citation`).
- `start` refuses a `factory-tuning` change that touches the packs' folder (`tuning-touches-policies`). The observe station's `allowed_target` already refuses any proposal aimed outside `REVIEW.md`, `CLAUDE.md`, `AGENTS.md` and skill instructions, so a pack cannot be proposed there; nothing was changed in observe.

## Timing

A pack changed later binds slices marked ready afterwards; earlier work is flagged, never restarted (`policies.drift`: a pack changed, retired or gone since the spec answered it, or an active pack that now applies but is not answered).

- `cell.py status <ticket>`: `policies_changed`, one sentence, for a cell with `cell.json` `policies`.
- Studio `policy list`: `slices_answered_under_older`, per slice.
- The review packet: `changed_since_ready`.

## The starter pack

`templates/policies/security/policy.md` (owner `Security team (@your-org/security)`, five statements, `topic:security`, `topic:sign-in`, `topic:password`, `topic:permission`). `bin/mach` installs only its listed seeds and managed files, so this file is never installed; the test pins that `bin/mach` names no `policies/` path. A team adds a pack by copying that folder (from a MACH checkout or the plugin's cache) to `policies/security/` in its repository, setting the owner to the real team, keeping only the statements it means, and merging it by pull request.

## Decisions where the design was silent

1. **The digest** is the first 12 hex characters of the SHA-256 of `policy.md`'s text (the design says "commit digest"). It identifies the pack's content, as an ADR's digest does, and stays the same when unrelated files change; 12 characters keep the line readable.
2. **Applicability is decided from the written spec**, by `policies.applies`: `all`, or a `topic:` word (and hyphen-joined pair) found anywhere in the spec except its own Policies section. `app:` matches only once an app type is known (the plan), and `path:` never selects a pack while the spec is written (no file is known yet); the spec may still list such a pack, and its rows are checked. The validator loads `policies.py` by path, as it loads `effects.py`, so there is one rule and the validator stays pure.
3. **Two answers only**: `Followed` or `Concerns`. There is no "does not apply": a pack that does not apply needs no line.
4. **The owner in a concern** must equal the pack's `owner` exactly. The person recorded by `policy accept --by` is free text (a role or a name), not checked against the owner: MACH cannot verify who someone is, and the words are the owner's decision on a person's word, like an ADR exception.
5. **An open concern at `finalize`** saves the spec at `spec-open` like an open question rather than refusing to save it, so headless grooming can record it and stop for a person.
6. **A Product Studio slice is not re-checked at dispatch** against the packs, as principles are not; its rows are. A dispatch therefore never fails because a pack changed after the product manager marked the slice ready.
7. **A malformed pack stops every spec check** (`policy-problem`), as a malformed ADR stops planning: its `applies-to` cannot be trusted, so whether it applies cannot be known.
8. **No `run.py` command for accept.** As with `/mach adr except`, the run skill routes to the station that owns it (`cell.py policy-accept`, or Studio).
9. **Seats for packs on no seat's topic**: every seat, rather than none.
10. **`check-plan` refuses a task that changes a pack** (the design's "Never" for the Factory); review's tuning refusal covers the observe loop.

## Exact shared-file blocks

- `skills/intent/scripts/validate_slice.py`: the `OPTIONAL_SECTIONS` line (one entry added, one comment line); a new block `_POLICIES`, `policies_module()`, `check_policies()` before `analyze`; `analyze`'s signature gains `policies=None`; three lines after the effects export (`packs = check_policies(...)`, `model["policies"]`); the `--policies` argument and its loading block in `main`, and `policies=packs` in the `analyze` call.
- `skills/intent/scripts/cell.py`: `import policies` beside `import shipped`; `analyze_spec` gains `packs` and passes `policies=packs`; `cmd_validate` passes `policy_input(...)`; `cmd_finalize`: `packs = policy_input(...)`, the `hard`/`open_items` lines include `policy-concern-open`, `record_policies(...)` after `cell["shipped"]`, one sentence added to the `SAVED` message; a new block "policy packs (M14 part A)" before `print_findings` (`policy_input`, `record_policies`, `cmd_policies`, `cmd_policy_accept`, `policies_changed`); four lines in `plan_adrs` after the ADR-folder check; three lines in `cmd_status`; two parsers (`policies`, `policy-accept`) before `finalize`'s; `policy-accept` in `main`'s telemetry map.
- `skills/product-studio/scripts/studio.py`: `policies_helper()` before `ticket_rules()`; `self._policies` in `__init__`; `analyze` passes `policies=`; `policy_listing()` after `analyze`; `**policies_field(studio)` in `cmd_slice_resume`; a block `policies_field`, `cmd_policy_list`, `cmd_policy_accept` before `question_field`; the `policy` subparser before `request`; `policy` in the command metavar.
- `skills/review/scripts/review.py`: one docstring paragraph; `import policies` (guarded) before the scan import; `policy_refusal(...)` after `adr_refusals(...)` in `start`; three lines adding `cell.packet["policies"]`; a block `POLICIES_NOTE`, `spec_policies`, `packet_policies`, `check_policy_citation`, `policy_refusal` before `is_security_veto`; `check_policy_citation(...)` after `check_principle_citation(...)`.
- `skills/run/scripts/run.py`: two usage lines in the docstring; `cmd_policy` before `required_topics_view`; the `policy` subparser before `adr`'s.
- `skills/intent/assets/slice-template.md`: the `## Policies` block after `## Principles`.
- `skills/intent/references/spec-structure.md`: one sentence in the section list; a `## Policies` section before `## Effects on shipped behaviour`.
- `skills/intent/references/interview-method.md`: a `### Policy packs` subsection before `### Effects on shipped behaviour`; one sentence in the Sanity check.
- `skills/intent/references/headless.md`: one paragraph after the principles paragraph.
- `skills/intent/references/contracts-and-plan.md`: one bullet before "File touch map".
- `skills/intent/SKILL.md`: sentences appended to step 5 (no renumbering).
- `skills/product-studio/SKILL.md`: a `## Policy packs` section after the principles section.
- `skills/run/SKILL.md`: one sentence at the end of `description`; two rows (`policy accept`, `policy list`) before `new "<idea>"` in the routing table.
- `skills/review/references/security.md`, `product.md`, `architecture.md`, `reviewer-brief.md`: one bullet or paragraph each. `agents/reviewer.md`, `agents/contract-engineer.md`, `agents/builder.md`: one paragraph or sentence each. `templates/REVIEW.md`: one bullet.
- `templates/config.json`: the `policies` object after `adr`.
- `CLAUDE.md`: one line in the installed-project layout, one bullet under intent, one under Product Studio, one under review.

## Not built

- **The visual app**: no screen or host operation shows packs, concerns or acceptances; the host passes `slice resume` and `slice check` through, so `policies` and the findings reach it as data, but nothing is drawn. `apps/` and `web/` were not touched.
- **The Factory's `next`, `status`, `explain` and `decide`** do not show `policies_changed` or offer `policy accept`; only `cell.py status <ticket>`, Studio's `policy list` and the review packet carry the timing flag. A cell held at `spec-open` by a concern is shown by `next` as "open questions", which is how headless mode stops it.
- **Studio `status` and `refresh`** do not flag slices answered under an older pack (a Git read on every call); `policy list` does.
- **Intake** does not re-check a slice against the packs (Studio checked it at `slice ready`).
- **No JSON schema** file for the packs input.
- **Statement wording checks** beyond the keyword, one sentence and quotability (no vague-word or technology check: a policy may name technology, and the owner writes it).

## Tests

`tests/test_mach_policy_packs.py` (28 tests): the reader (a good pack, every problem named, a folder without `policy.md` and a malformed pack reported and never given as a pack, selection by `all`, `topic:`, a hyphen-joined pair, `app:` and never `path:`, the section not selecting itself, seats, the starter template parsing clean and not named by the installer, the config template); the validator (no packs changes nothing, an applicable pack required, a topic pack that does not apply, `Followed` exported, an open concern a warning then an error with `--ready` with and without the packs, accepted and `spec changed`, a bad resolution and date, quote, owner, unknown statement and pack, digest, retired, the grammar on its own, `None.`, the section order, the command line with `--export` and a bad file); `accept` (only an open concern, the owner's words, refusals); `cell.py` on a real Git repository (`policies` fenced and `--json` in the validator's shape, only committed packs count, `finalize` refusing an unanswered pack, holding an open concern at `spec-open`, `policy-accept` refused inside a supervised execution then recorded, `finalize` passing, the kept copy and `spec.json`, `policy-accept` refused after grooming, a pack changed on main flagged by `status` with the stage unchanged; a Product Studio cell not re-checked and refused; a project without packs exactly as before; `run.py policy list` reading only, in the validator's shape; `check-plan` refusing a task that changes a pack); Product Studio against the stand-in for gh (`slice resume` with fenced packs, `slice check --ready` refusing an unanswered pack, `slice ready` refusing an open concern, `policy accept` refusing the wrong statement and recording the right one, `policy list`, then `slice ready` passing; a project without packs resumes as before); review (the packet's seats, statements and the owner's decision, no block without the section, citations allowed and refused three ways, the tuning refusal); and the instruction files say what to do.

The whole suite passes with `make test`: 1,548 tests in 343 classes, one skipped. Not tried: a real organisation's packs, a project with many packs (each is one `git show` after one `ls-tree`), Product Studio's visual app, and a live interview.
