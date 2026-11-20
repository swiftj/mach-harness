# M13 part A, as built: product principles

This note covers part A of `M13_DESIGN.md`. It says what was built, where the build departs from the design and why, what is not built, and how far it is tested. Parts B to F are not built.

## What a principle is

`PP-NN`, a title, one statement, a short reason, a status (`active` or `retired`) and a revision. The statement is held to the same checks as an invariant: an uppercase MUST, MUST NOT, SHALL, SHALL NOT or REQUIRED; no lowercase "must" or "shall" (a warning); vague words (a warning); and no technology (an error here, though only a warning in a spec, because a technical rule is an ADR). The check is the validator's own (`validate_slice.statement_findings`, built from the helpers `check_invariants` now shares), not a copy. A statement also may not hold double quotation marks or MACH's markers, because every spec quotes it.

## Commands (Product Studio)

| Command | What it does |
|---|---|
| `principle add --title --statement --reason` | Adds the next free `PP-NN`, `active`, revision 1. IDs are never reused: the next is counted over the draft, what was published, and what GitHub held at the last refresh. |
| `principle set <PP-NN> [--title] [--statement] [--reason]` | Changes it. A changed statement is the next revision of that principle; a new title or reason is not. A retired principle is refused. |
| `principle retire <PP-NN>` | Sets it `retired`. Slices stop answering it. It is never brought back: add a new one. |
| `principle list` | The principles, where they are published, unpublished changes, and the slices answered under older ones. Changes nothing. |
| `principle publish` | Saves them where the builders read them (below). |
| `reconcile principles --take mine\|theirs` | Another product manager published newer principles and this workspace has unpublished changes. |

All but `list` run only on the product manager's word. They are terminal only: the visual app's Go host (`apps/studio/internal/engine/ops.go`) has a fixed list of operations, which was not changed, so the app shows nothing new.

## Where they live

- **Draft**: `.factory/studio/draft/product/principles.json`: `{schema_version: 1, project_id, principles: [...]}`. `product.py` checks its shape with the other product artifacts, and a change that would break the workspace is put back.
- **The record**: `.factory/studio/issues.json` gains `principles` (`saved`, `revision`, `base_revision`, `sha256`, `published`, `approved_by`, `published_at`, `issue`, and `run` with its steps while a publish is under way) and `seen.principles` (what the last refresh read).
- **On GitHub**: a fixed section of the project's issue body, after the outcomes, from `issue_rules.principles_section`:

  ```
  ## Product principles

  <!-- mach:principles revision=2 sha256=<64 hex> -->

  - **PP-01: Versions stay as published** (revision 1, active)
    - Statement: A published version MUST NOT be edited in place.
    - Why: Readers rely on what they saw.
  ```

  and one approval comment per published version, from `issue_rules.principles_approval_comment`, naming the revision, the product manager's login (no `@`) and the SHA-256, ending in `<!-- mach:principles-approval revision=N by=LOGIN sha256=HEX -->`.
- **Without GitHub**: `product/ready/PRINCIPLES/principles.json` in the draft workspace (`{schema_version: 1, revision, sha256, principles}`), written to a temporary folder and renamed. The product manager commits it.

The SHA-256 is taken over the principles as canonical JSON (sorted by ID, sorted keys, no spaces), not over the section's text, so the folder form and the issue are checked the same way. The section counts only when it re-renders to exactly the text on the issue and its hash matches the marker; anything else is "changed after it was approved".

## Publishing

`principle publish` uses the same steps as `slice ready`: gh installed, signed in and a GitHub `origin` means GitHub, else the folder, decided before anything is written; a passing failure refuses. On GitHub the run is recorded in the record before each step and each step looks before it writes:

1. **labels**: create `mach:project` if missing.
2. **project**: find the project's issue by its marker or create it (pinned once), and bring its body up to date with the section.
3. **approval**: post the approval comment unless the same account already left one for this revision and hash.

A publish with the same principles keeps the revision and writes nothing. A changed set gets the base revision plus 1. An interrupted publish (a failure, or a lost answer after the write) is finished by publishing again, and nothing is made twice. If GitHub holds an intact, newer version that this workspace did not make, publishing refuses and points to `reconcile principles`.

`slice ready` rewrites the project's issue as before, and now keeps the principles section: the one on GitHub when it is intact and not older than what this workspace published, else this workspace's own published section, else none. Marking a slice ready never changes the principles. A project without principles gets exactly the body it got before.

## The spec

The template gains `## Principles`, optional, between `## Acceptance criteria` and `## Dependencies and permissions` (`validate_slice.OPTIONAL_SECTIONS`, which also fixes its place in the section order). One line per principle:

```
- **PP-01** (revision 1): "A published version MUST NOT be edited in place." **Applies:** INV-02, AC-01.
- **PP-02** (revision 1): "An invitation MUST name the person who sent it." **Does not apply:** This slice sends no invitation text.
- **PP-03** (revision 2): "<statement>" **Exception:** <the product manager's reason>.
```

`validate_slice.analyze(..., principles=...)` and `validate_slice.py --principles <file>` take the principles as an input, so the validator stays a pure check. Rules: `principle-unanswered` (an active principle with no row, or no section at all), `principle-quote`, `principle-revision`, `principle-unknown`, `principle-applies` (each ID must be an INV, FR or AC this spec defines; R rules are not accepted), `principle-reason`, `principle-format`, and `principle-retired` (a warning). Without the principles, each row is still checked on its own. A project with no principles, or only retired ones, needs no section, and every existing spec stays valid. The rows reach `spec.json` as `principles` (`id`, `revision`, `statement`, `answer` of `applies`, `does_not_apply` or `exception`, `upheld_by`, `reason`), only when the spec has the section, so other specs export exactly as before.

Product Studio gives the validator the draft principles. `slice ready` also refuses while the principles have changes that are not published, so a slice is always answered against what the builders can read.

## The interview

`interview-method.md` gains "Product principles": read them before the first question; where one plainly applies the recommendation keeps it and names it; a conflict is the next question, with keeping the principle as the recommendation; an exception only on the product manager's word, with their reason in their words, never recommended; every active principle is settled before the summary, which names any exception. `headless.md`: principles are settled rules, a conflict is an open question (blocking), and no exception is ever recorded headless. Studio's `slice resume` prints `principles.active` for the interviewer; the intent skill runs `CELL principles` first.

## The engineer's path

- `ticket.py principles-check [N]` reads only. Without N the project's issue is the one open issue carrying `mach:project` and a project marker (none: `none`; several: not accepted). The principles count when the section is intact and an unedited approval for exactly that revision and SHA-256 was written, as a person, by the account it names, whose role is triage or above (`issue_rules.principles_acceptance`). The principles are printed only then.
- `cell.py principles <ticket>` (intent skill, before the interview, either mode) asks the ticket station, then reads `product/ready/PRINCIPLES/principles.json` at the main checkout's HEAD and checks its hash (`issue_rules.principles_folder_check`). What it finds goes to `<cell>/principles.json` and `cell.json`'s `principles`; `cell.py validate` and `finalize` then pass it to the validator. None readable: no file, `"principles": null`, and a note to say so once.

## Review

The product checklist gains a line: check the diff against each principle the spec says applies. `review.py start` adds `principles` to the packet (only when the spec has the section): `applies`, `does_not_apply`, and `exceptions`, each marked as the product manager's decision. `review.py submit` refuses a blocker whose rule cites a `PP-NN` the spec does not list (`principle-citation`), and one that cites a principle the product manager excepted. The reviewer brief, `agents/reviewer.md` and the shipped `REVIEW.md` say the same.

## Timing

A principle added or changed binds slices marked ready afterwards. Studio's `status` (per slice `principles`, and `principles.slices_answered_under_older`), `refresh` and `principle list` flag a draft or ready slice that answers an older revision of a principle or leaves an active one unanswered. Nothing is reopened or restarted.

## Decisions where the design was silent, and departures

1. **Revisions.** Each principle's revision counts changes to its statement, which every spec quotes; a new title or reason does not make specs stale. The published set has its own revision (published versions, from 1), like a slice's.
2. **Absolute keywords only.** The design's example sentence ("A published version is never edited in place.") would be refused: the brief asks for RFC 2119 wording, and a rule that holds in every slice is absolute, so the invariants' keywords are used. Technology is an error, not a warning.
3. **Retired principles are published too**, so their IDs are never reused and a spec row for one is a warning rather than "unknown".
4. **Unpublished principles stop `slice ready`.** The design does not say what a slice answers while the draft differs from what is published; refusing keeps one truth.
5. **Another product manager's principles.** `refresh` takes a newer, approved version when nothing here is unpublished (as it takes another product manager's order); otherwise `reconcile principles --take mine|theirs`, an extension of the existing `reconcile` command.
6. **The folder for engineers** is read at the main checkout's HEAD, as ADRs are, not at the shared commit intake uses for ready slices. Intake now skips `product/ready/PRINCIPLES/` (it is not a slice).
7. **Next steps.** No new `next_actions` kind was added, because the app maps those kinds to screens. `status.principles.next` carries the sentence instead.
8. **Citing a principle.** A row that does not apply may be cited (the spec lists it, and a reviewer may find it plainly applies); an exception may not.
9. **Approval checks in Studio** (refresh, reconcile) check the hash and that the named account wrote the approval, not whether it was edited, as `slice take` does. The Factory's check is the full one.
10. **`cell.py principles` refuses** a slice from Product Studio (it was checked there) and a cell past grooming.

## Not built

- The visual app: no screen or host operation for principles.
- The Factory's `status` and `explain` do not flag work in the line answered under older principles: they would need a read of GitHub on every call. The cell keeps what it was answered under (`cell.json` `principles`), which a later step can compare.
- Intake does not re-check a Product Studio slice against the published principles; Studio checked it before it was marked ready.
- No JSON schema file for `principles.json` under `docs/mach-next/schemas/`.

## Tests

`tests/test_mach_product_principles.py` (34 tests): the shared rules (round trip, edits caught, hash, what counts, the folder form, text that could forge a marker); the validator (no principles changes nothing, every rule above, the section's place, `--principles` and `--export`, the statement checks); Studio against the stand-in for gh (add, set, retire, list; publishing once, again, changed, interrupted two ways; the slice gate and the kept section on `slice ready`; a project without principles exactly as before; the older-revision flag; another product manager's principles taken or chosen; mine kept; the folder without gh; only the gh calls the hand-off already makes); `ticket.py principles-check` (counts, edited, a reader's approval, none); `cell.py principles` (GitHub, the committed folder, a tampered folder, none); the review citation rule and packet; intake skipping the folder. `tests/test_mach_product_isolation.py` now pins the exact `issues.*` calls `handoff.py` makes and those publishing makes, and that `principles-check` only reads.

## What this means for parts B to D

- **B** adds `Effects on shipped behaviour`: add it to `OPTIONAL_SECTIONS` (or make it required) with the section it follows; the order check already handles optional sections. Its shipped rules should reach the validator as an input, as the principles do, so it stays pure.
- **C** reads shipped specs: they may now hold `## Principles`; `spec.json` has `principles` only when the spec has the section.
- **D**'s confirmed answers still pass the principles check; a PRD line that contradicts a principle is a conflict question like any other.
- The project's issue body now has an optional section between the outcomes and the footer; anything else that rewrites the project's issue must keep it (`Handoff.principles_kept`).
