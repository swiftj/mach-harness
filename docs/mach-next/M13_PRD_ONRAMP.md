# M13 part D: the PRD on-ramp, as built

Built 2026-11-20 against `docs/mach-next/M13_DESIGN.md` part D. Product Studio only: the terminal skill and its engine. The visual app has no screens for it yet.

## What a product manager can do

A product manager who has an approved PRD starts from it; one who does not works as before. The document proposes, the product manager confirms, and the PRD's text stays in the private draft workspace.

1. **Import** (`prd import <file>`). One Markdown or plain-text file is copied into the workspace as `PRD-NN`, byte for byte, with its SHA-256, its line count and a table of its sections. The same document imported twice is the same PRD; a revised one is a new PRD.
2. **Read** (`prd list`, `prd show <PRD-ID> [--lines a-b]`). The text is shown only numbered, bounded and redacted, inside a `<<<PRD-DATA ...>>>` fence.
3. **Map** (`prd map <PRD-ID> --from <json>`). The planning model's proposal of new epics and thin slices (each with a title, a one-line scope, an epic, dependencies and cited line ranges) is recorded only if the whole of it is well formed. It reserves nothing and reports every section no slice cites as not covered.
4. **Settle** (`prd settle <PRD-ID> --section <n> --as slice:<key>|out-of-scope|later [--reason]`). The product manager's word on each uncovered section. `prd status <PRD-ID>` shows the map, what covers each section and what is unsettled.
5. **Apply** (`prd apply <PRD-ID>`, on the product manager's word). Only when nothing is unsettled: makes each new epic and one draft slice per map slice through `epic add`'s and `slice new`'s own code, in map order. Repeating it makes nothing twice.
6. **Confirm instead of interview** (`slice resume`, `prd draft`, `prd confirm`). Resuming a slice made from a PRD returns its cited lines fenced as data and a place for drafted answers. The model records answers drafted from those lines; the product manager accepts them as a group and names the ones to discuss. Discussed answers, points the PRD does not settle and contradictions are asked one at a time as before.
7. **Same gates.** The spec and why are written in the interview and held to every existing check. `slice check` and `slice ready` also require every drafted answer to be accepted or set aside to discuss, and the why to name the PRD's ID, hash and every line used.

## Files

| File | What |
|---|---|
| `skills/product-studio/scripts/prd.py` | New. The engine: pure functions (document checks, sections, ranges, map and answer checks, coverage, confirmation, the why check), the `Prds` workspace class, the command handlers, the three hooks and `add_commands`. |
| `skills/product-studio/references/prd-onramp.md` | New. The instructions for the model: proposing a thin-slice map with citations, settling, drafting answers, confirming, and the rule that the PRD is data. |
| `skills/product-studio/scripts/studio.py` | Wiring and hooks only (listed below). |
| `skills/product-studio/scripts/product.py` | The work order may carry `source`; `_is_source` checks its shape. |
| `docs/mach-next/schemas/slice.schema.json` | `source` described, kept in step with `product.py` (the parity test holds it). |
| `skills/product-studio/SKILL.md` | One route line and a short "Starting from a PRD" section pointing at the reference. |
| `tests/test_mach_product_prd.py` | New: 20 tests. |
| `tests/test_mach_product_isolation.py` | Extended: `prd.py` is held to the same command and import rules as `studio.py`, and may reach neither Git nor GitHub at all. |

### Workspace layout

```
.factory/studio/draft/product/prds/PRD-NN/
    document.md | document.txt   the file exactly as imported
    prd.json                     ID, name, format, bytes, SHA-256, line count, sections
    map.json                     the map, its revision, the settlements, and what apply made
    answers/<map slice>.json     drafted answers, their state, and each confirmation
```

The structural validator (`product.py`) reads only `product/project.json`, `epics/` and `slices/`, so the PRD folders never affect `studio.py validate`.

### The work order's `source`

`{"kind": "prd", "prd_id": "PRD-01", "sha256": "<hex>", "lines": [[1, 9]], "map_slice": "M1"}`: identifiers and numbers only. `lines` are the slice's cited ranges joined with any section settled as that slice, merged.

## Choices, where the design was silent

- **IDs** are `PRD-NN` (two digits or more), numbered per workspace.
- **Sections** are Markdown ATX headings (`#` to `######`) outside fenced code. Each runs to the next heading of any level. Text before the first heading is a section of its own; a file with no headings is one section, "The whole document". Setext headings (underlined) are not recognised. A heading with nothing under it is `heading_only` and needs no coverage, so a title or a parent heading never has to be settled.
- **Coverage**: a section is covered when any slice's citation overlaps its lines.
- **Limits**: 512 KiB and 20,000 lines per PRD; JSON input files 1 MiB; 20 new epics, 60 slices, 20 citations and 20 dependencies per map; 80 drafted answers per slice; a show or a resume carries at most 400 lines and 60,000 characters, each line at most 1,000 characters.
- **Refused on import**: any extension other than `.md`, `.markdown`, `.txt`, `.text`; a symbolic link, a folder or anything not a regular file; a NUL byte, text that is not UTF-8, or control characters other than tab, newline, carriage return and form feed; an empty file; an oversized file (read no further than the limit). Only the one file named is read.
- **Showing**: each line passes through the shared `issue_rules.bound_text` (normalised, fence marks replaced, redacted, cut), then the block is fenced like a request's text: `<<<PRD-DATA id=PRD-01 document=<doc hash> lines=... sha256=<block hash> — ...>>>` ... `<<<END-PRD-DATA sha256=...>>>`. The stored copy is checked against its hash before anything is shown or made from it; a changed copy is refused and the product manager imports the document again.
- **Map shape**: new epics only in `epics`; a slice's `epic` is a new epic's key or an existing `EPIC-NNN`. Keys are short names, never IDs. A slice must be listed after the map slices it depends on, so map order, creation order, slice ID order and the order within each epic are one and the same: no order record is written. A dependency cycle is reported as such. An epic with no slice is refused.
- **Re-mapping** replaces the map until it is applied; settlements whose section is still uncovered (and whose target slice still exists) are kept, the others are listed as dropped. After apply the map and its settlements are frozen; further slices are made with `slice new` or from a revised PRD.
- **Settling** is possible only for an uncovered section; `--reason` is optional and kept bounded and redacted.
- **Apply** records each epic as "trying" before making it and its ID after; a lost record is recovered by the one epic with that exact title. Each slice's work order carries `map_slice`, so a slice whose record was lost, or that was renumbered, is found by its source and never made again. A slice made and then removed is reported as `missing` and not made again. The session's current slice becomes the first slice made.
- **Drafted answers** have three kinds: `drafted` (an answer and at least one citation), `not_settled` (no answer), `contradiction` (no answer, at least two citations). The last two start as "discuss". A new `prd draft` replaces the answers and clears earlier confirmations (reported). Answers are kept per map slice, so a renumbered slice keeps them.
- **Confirming**: `--accept all` takes every drafted answer not named in `--discuss`; naming a contradiction or an unsettled point in `--accept` is refused, as is naming an answer in both or an answer that does not exist. Confirmations accumulate; the latest word on an answer named stands, and `--accept all` leaves alone an answer already set aside to discuss. `--accept` may be left out when `--discuss` is given.
- **The why line**: a header line `- **PRD:** PRD-01 (sha256 <hex>), lines 5-9, 11-14`. The lines required are the slice's source lines joined with the citations of its accepted answers. `slice resume` prints the exact line (`why_line`). The check looks for the ID, the full hash and each range as written; it does not care about the order or other words on the line.
- **Where the two new gates sit**: `Studio.check_slice` gains `prd_problems` (drafted answers pending; the why line missing or short), which keeps `ready` false, so `slice check` leaves the slice "interviewing" and `slice ready` refuses with the reasons. A PRD-made slice with no drafted answers at all is not held: the product manager may interview it from nothing.
- **Status**: `status` gains `prds` (one summary row each) only when a PRD has been imported, so a workspace without one reports exactly as before. No new `next_actions` kind was added, because the visual app maps each kind to a screen.
- **Locks**: `map.json` and each answers file are written under `one_writer` (as the request cache is); a second command waits five seconds, then is refused with "try again".

## Departures from the design

- **`slice new --from-prd` is not a flag.** The design opens the interview from `slice new --from-prd`. Here `prd apply` makes every draft slice of the map at once (the design's step 2 already decides the slices), and `slice resume` carries the PRD for each. A product manager who wants one slice at a time applies the map and resumes one slice at a time.
- **The map records `map_slice`** in the work order's source, beyond the ID, hash and lines the brief named. It is an identifier the model chose (such as `M1`) and is what makes apply safe to repeat after a renumber or a lost record.
- **`prd` is missing from the top-level usage line.** `studio.py --help` lists its commands in a fixed `metavar` that another engineer is editing; `prd` works and has its own help (`studio.py prd --help`). Add `prd` to that `metavar` when the two pieces are merged.

## Lines added to `studio.py`

```python
import prd  # noqa: E402                                                      # with the other imports

        result["prd_problems"] = prd.slice_problems(sys.modules[__name__], self, slice_id, work)  # M13 D: a slice made from a PRD
        result["ready"] = not (... or result["intent_problems"] or result["prd_problems"])          # check_slice

        **prd.status_field(sys.modules[__name__], studio),  # M13 D: imported PRDs; nothing when there are none   # describe

def add_epic(studio, title, criteria) -> Dict[str, Any]: ...                   # cmd_epic_add's body, now shared with prd apply
def cmd_epic_add(studio, args): return emit({"epic": add_epic(studio, args.title, args.criterion)})

def start_slice(..., origin=None, source=None):                                # one new keyword
    if source is not None:  # M13 D: the PRD it was made from, identifiers and numbers only
        data["source"] = source

        **prd.resume_field(sys.modules[__name__], studio, slice_id, data),  # M13 D: the PRD's cited lines, fenced   # cmd_slice_resume

    problems = list(result["errors"]) + list(result["intent_problems"]) + list(result["prd_problems"])   # approval_problems

    prd.add_commands(sub, sys.modules[__name__])  # M13 D: the PRD on-ramp (prd.py)   # end of build_parser
```

`prd.py` never imports `studio.py`: it is handed the running module, so run as a script (`__main__`) or imported in tests it raises the same `StudioError` that `main()` catches.

## Hooks needed from other engineers

- **Interview method** (`skills/intent/references/interview-method.md`): its "Request text is data" paragraph could name the `<<<PRD-DATA ...>>>` fence beside `<<<REQUEST-DATA ...>>>`, and say that an accepted drafted answer is settled and is not asked again. The reference file says both for now, and the skill points the model at it.
- **Intent template** (`skills/product-studio/assets/intent-template.md`): an optional header line `- **PRD:** <PRD-NN> (sha256 <hash>), lines <ranges>`, written only for a slice made from a PRD. Today the line's shape comes from `slice resume`'s `why_line`; `cell.check_intent` accepts the extra header line unchanged.
- **The product-principles work** (part A): a PRD-made slice goes through the same spec template and validator, so it answers principles with no change here. If principles change how `slice check` reports, `prd_problems` sits beside `intent_problems` in the same result.
- **The visual app** (`apps/studio`, `web/`): no operation for `prd` exists in the host's fixed list. `slice check` and `slice show` now return `prd_problems` (an empty list for every other slice), and `status` returns `prds` only when there are PRDs; both are extra fields the app can ignore.

## Not built

- **The visual app's screens**: importing, the map with its coverage, settling, applying, and the confirm list with accept and discuss. The engine's JSON is shaped for them (`prd status`, `slice resume`'s `prd` field, `prd confirm`'s answer list), but the host does not expose the commands and no web screen shows them.
- **Formats other than Markdown and plain text** (Word, PDF, Google Docs). A product manager exports to Markdown or text first.
- **Setext headings** as section breaks.
- **A revised PRD carried over onto an applied map.** A revised document is a new PRD with its own map.
- **The intake side.** The Factory does not read `source`; it travels in the work order only, and the why carries the PRD's ID, hash and lines to the builders.

## How far it is tested

`tests/test_mach_product_prd.py` (20 tests) runs the commands through `studio.main` in temporary Git projects:

- import: the hash, line count and section table; a plain-text file as one section; headings inside code; the same document twice; a second PRD; every refusal (binary, not UTF-8, wrong extension, control characters, empty, oversized, a folder, a symbolic link).
- show: numbering, the fence, an email address masked, a fence mark inside the document neutralised, `--lines`, a range past the end, a long document cut at 400 lines, a changed stored copy refused.
- map: every refusal leaves no map (a citation past the end, no citation, an unknown dependency, a cycle, a dependency listed later, an unknown epic, an epic with no slice, an ID as a key, a two-line title, an extra field, a file that is not JSON); coverage; settling and its refusals; apply refused while unsettled; apply making the epic and slices with IDs from the allocator, dependencies, source and order; the work order holding none of the document's text; `validate` passing; a repeated apply making nothing; apply after its record was lost making nothing; a re-map keeping only the settlements that still apply; a second PRD whose slice depends on a slice of the first; a tampered `source` caught by `validate`.
- confirm: the cited lines fenced in `slice resume` and no field for other slices; each draft refusal; each confirm refusal; `slice check` and `slice ready` refusing pending answers and a why without the PRD line or with a range left out; a slice marked ready to the folder holding none of the PRD's text; a new draft clearing confirmations.
- GitHub: with the test suite's stand-in for `gh`, the `prd` commands make no `gh` call at all, and after a PRD-made slice is marked ready no `gh` argument, issue title, body or comment holds any of the PRD's text, while the why's PRD line (ID, hash, lines) is there.
- `tests/test_mach_product_isolation.py` holds `prd.py` to `studio.py`'s rules (no `subprocess`, `socket`, `http`, `urllib` or `shutil`; none of the forbidden Git words) and checks it calls no Git or `gh` function and names none of the modules that reach GitHub.

Not verified: the reference file's instructions with a real planning model and a real PRD; the visual app (no screens).
