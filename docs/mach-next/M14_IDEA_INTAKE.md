# M14 part D as built: intent from anyone

Built 2026-11-20 from `M14_DESIGN.md`, part D. Status: built in Claude Code with tests; not tried on claude.ai, in Cowork or with a GitHub connector.

## What was built

1. **The skill `skills/idea/`** (`/mach-idea` in a project, `/mach:idea` as a plugin). `SKILL.md` interviews one person who is not an engineer, in their words, one plain open question at a time, about five parts: problem, proposed outcome, affected users and systems, constraints (including what is not part of the idea), open questions. It stops when each part is concrete, shows the result, lets the person correct it, then sends it one of three ways. It never adds a fact the person did not give (an unknown becomes an open question), never promises the idea will be built, and always ends by saying, in plain words, that someone with the right must add the `mach:request` label for a product manager to see it.
2. **The template**, defined once in `skills/ticket/scripts/issue_rules.py`: a hidden marker and five headed sections, with a builder, a strict parser, the open-question reader and a per-part fence.
3. **The filing script `skills/idea/scripts/idea.py`** with two commands, `check` (reads only) and `file`.
4. **Product Studio**: `request list` marks a templated request, `request show` presents its five parts apart, and `request pick` / `slice resume` carry its open questions as questions to ask first.
5. **Tests**: `tests/test_idea.py` (14 tests) and two additions to `tests/test_installer.py`.

## The three ways out

| Where | How it is sent |
|---|---|
| Claude Code, in a project, `gh` signed in, `origin` on GitHub | `idea.py check --title ... --body-file ...` prints the exact title and body that would be filed, its `sha256`, whether it was changed by cleaning or redaction (`changed`), and whether it can be filed here (`can_file`, `why_not`). The skill shows exactly that text and asks. On a clear yes, `idea.py file --title ... --body-file ... --sha256 <from check>` creates the issue with no label and prints its address. |
| claude.ai or Cowork with a GitHub connector | The skill's instructions: show the same text, and on a clear yes create the issue through the connector, in the repository the person names, with no label. |
| Anywhere else | The title and text in two code blocks, to paste into a new issue (or send any other way). |

## Choices and departures

- **`file` needs `--sha256` from `check`.** Departure from the brief's `file --title ... --body-file ...`: the script cleans and redacts, so the text filed can differ from what the person wrote. Binding `file` to the hash `check` printed means only the text the person saw and agreed to can be filed; anything else is refused and nothing is sent. `check` is the read-only preview; it was added for the same reason.
- **Redaction is shown, not silent.** The parts are cleaned, redacted and bounded with the shared `bound_text` (an email address becomes `<email>`). When that, or the template's own spacing, changes anything, `check` says `changed: true` and the skill points out what was masked before asking.
- **Secrets are refused, not masked.** `scan.secrets_in_text` (the build and review stations' shapes) runs on the title and the raw body before anything else. A hit refuses with the kinds found, never a value or a preview.
- **Repository.** The issue goes only to the repository the `origin` remote names, resolved the way Product Studio's requests resolve it (the origin's OWNER/REPO, confirmed by `gh repo view`), so it lands where Studio reads requests. `idea.py` repeats that small rule (one pattern, one call) instead of loading Product Studio's `collab.py`: `tests/test_mach_product_isolation.py` holds that no script outside Product Studio uses its scripts, and that rule stays. `gh` signed out, no GitHub origin, or GitHub unreachable each give `can_file: false` with a plain reason; `file` then refuses and nothing is sent.
- **Shared code is loaded, never copied.** `idea.py` loads `issue_rules.py` (ticket) and `scan.py` (intent) from the sibling skill folders under either install's names. Without them (a skill uploaded alone to claude.ai) no script runs, and the skill's instructions use ways B and C.
- **Questions to ask first are not written into the work order.** The rule since M8 is that a work order's `origin` holds identifiers only and issue text never enters a product file (`product._shape` refuses any other key in `origin`). Open questions are issue text, so they are kept out. `requests_in.Requests.fenced_for`, which both `request pick` and `slice resume` already call, reads them fresh from the request text kept at pickup (`.factory/studio/requests/<n>.md`, the same text the interview is seeded with) and returns them as `request.questions_to_ask_first`: a count, one fenced block listing them, and a note. A later edit on GitHub does not change them, as with the rest of the kept text.
- **A not-accepted request shows nothing of the template.** `idea_template` is false and `request show` gives no parts, exactly as it gives no text today.
- **List flag name.** The list marks a templated request with `idea_template: true`; `show` puts the parts under `idea`, so the two never share a key with different types.
- **Kept out of unattended runs.** `idea` joins `product-studio` in `executor.NOT_FOR_THE_FACTORY`: an execution's plugin copy carries neither.
- **No duplicate guard.** Filing twice files twice. The skill says never to file again after a failure that gave no address before the person has looked on GitHub; `file` says the same when GitHub gives no address.
- **The parser's strictness.** Exactly the marker as the first non-blank line, then exactly the five `## ` headings in order, each with non-blank text, and nothing before the marker. Any other `## ` line or `<!-- mach:` line, a respelt or smaller heading, a repeat, a missing part or a body over 65,536 characters is not the template. CRLF line ends are accepted. It never raises.

## The exact shared-file blocks

- `skills/ticket/scripts/issue_rules.py`: one block, `# ---- an idea filed by anyone (M14 part D) ----`, between `fence()` and `# ---- status comments ----`: `IDEA_MARKER`, `IDEA_SECTIONS`, `IDEA_PART_LIMIT` (4000), `IDEA_QUESTIONS_LIMIT` (10), `IDEA_QUESTION_LIMIT` (300), `IDEA_NONE`, `idea_body`, `parse_idea_body`, `idea_questions`, `idea_fence`.
- `skills/product-studio/scripts/requests_in.py`: one line in `item_view` (`"idea_template": ...`), one line in `show` (`item.update(idea_view(...))`), one line in `fenced_for` (`result.update(questions_first(...))`), and one block `# ---- a request filed in the idea template (M14 part D) ----` before `give_up`: `IDEA_NOTE`, `QUESTIONS_NOTE`, `idea_view`, `questions_first`.
- `skills/product-studio/SKILL.md`: one bullet in **Requests**, before "Another slice for the same request".
- `skills/run/scripts/executor.py`: the `NOT_FOR_THE_FACTORY` line gained `"idea"`.
- `CLAUDE.md`: one line in the directory layout, one phrase in section 4's opening, and a `/mach-idea` subsection after Product Studio's.
- `README.md`: one row in the command table.
- `tests/test_installer.py`: two paths in the install list and one test, `test_installed_idea_skill_finds_the_shared_rules`.
- Not changed: `studio.py` (its `request pick` and `slice resume` already return `fenced_for`), `bin/mach` (it installs every skill folder), `.claude-plugin/*.json` (a plugin finds its skills by folder).

## The template

```markdown
<!-- mach:idea v1 -->

## Problem

...

## Proposed outcome

...

## Affected users and systems

...

## Constraints

...

## Open questions

- ...
```

`tests/test_idea.py` reads the block between `<!-- idea-template:begin -->` and `<!-- idea-template:end -->` in `skills/idea/SKILL.md`, parses it and rebuilds it with `idea_body`; the two must be identical.

## Not built

- Nothing in the visual Product Studio app shows the five parts or the questions to ask first; the host passes the new fields through, and `web/` was not touched.
- No check that an issue filed through a connector is in the template; Product Studio's parser recognises it or not when it is read.
- No way to edit an idea after filing, other than on GitHub.

## How far tested

- `tests/test_idea.py`: the round trip; eleven nearly-template bodies and five non-bodies refused by the parser; the builder's refusals; cleaning, redaction and bounds; the skill's template identical to the shared one; `check` changing nothing; `file` creating one issue with no `--label` through the request tests' stand-in `gh` (taught `issue create`); a secret in the body or title refused and never printed; a body not in the template and a wrong `--sha256` refused; redaction shown before filing; no GitHub origin refused; an unlabelled idea not listed as a request; `request list`, `show` and `pick` and `slice resume` with a templated request labelled by a writer, the work order holding identifiers only and no label added; the acceptance rule unchanged for a Triage labeller; no open questions carrying none; the skill's name and its exclusion from unattended runs.
- `tests/test_installer.py`: the installed `mach-idea` skill is present, renamed, and its script finds the installed shared rules.
- The whole suite (`make test`): 1535 tests, OK, 1 skipped.
- **Not tried**: the skill has not been run as a conversation, has not been uploaded to claude.ai or Cowork, and has not been used with a GitHub connector. Ways B and C are instructions only. `idea.py` has not been run against real GitHub.
