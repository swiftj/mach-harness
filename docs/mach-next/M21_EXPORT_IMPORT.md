# M21 design: moving a project by archive (`project export`, `project import`)

Status: built through `/mach-studio`, without the app's export button (piece F); see **As built** at the end. It is section B5 of `M20_TEAMS_AND_MOVING.md`, made concrete, and it follows the owner's decision of 2026-11-23 there (section 6, point 2): one repository holds one project, and a project that arrives where one already exists joins it as more epics, renumbered.

A product manager wants to bring a whole Product Studio project, its slices above all, from one repository into another, across organisations where GitHub's own issue transfer is not allowed. Two commands of the Product Studio engine (`skills/studio/scripts/studio.py`), reached through the `/mach-studio` skill, never a new command line:

- `project export` writes the whole project to one ZIP archive that names no repository.
- `project import <archive>` brings it into another repository's workspace.

Decided by the owner, not reopened here:

1. The destination may already hold a MACH project. Then import joins it: the incoming epics become more epics of that project; every incoming epic, slice, principle, technical need and idea takes the next free number in the destination, in order; every reference to them is rewritten. With no project in the destination, IDs are kept.
2. Every slice comes over as a draft, with its text. Approvals are never carried. The report says which slices were ready, being built or shipped in the source.
3. Nothing fabricated; import writes nothing to GitHub; a refusal changes nothing; an import that stops half-way can be run again and finishes without repeating or duplicating anything.

All line numbers are as of branch `feature/project-export-import` at `9f2c4dc`.

## 1. Inventory

### 1.1 Where a project lives today

Product Studio's drafts are in `.factory/studio/draft/` (`studio.py:172-173`), git-ignored (`Studio.ensure_ignored`, `studio.py:242-257`). Studio's own records sit beside it in `.factory/studio/`, outside the draft: `issues.json` (the hand-off ledger, `handoff.py:93`), `ideas.json` (`shape.py:257`), `requests.json` and `requests/` (`requests_in.py:86-87`), `shipped.json` (`studio.py:402-406`), `session.json` (`studio.py:174`), `outgoing/` (`handoff.py:94`), `jira/` (the Jira export's folder, `apps/studio/internal/server/downloads.go:35`).

Inside the draft (paths relative to `.factory/studio/draft/`):

| Path | Written by |
|---|---|
| `product/project.json` | `Studio.path("project")`, `studio.py:267-269` |
| `product/epics/EPIC-NNN.json`, `product/slices/SLICE-NNN.json` | `Studio.path`, `studio.py:270-273`, `KINDS` at `studio.py:143-146` |
| `product/intents/SLICE-NNN.md` (the "why") | `Studio.intent_path`, `studio.py:337-338` |
| `specs/slices/SLICE-NNN-<kebab>.md` | `Studio.spec_of`, `studio.py:330-335`; file name rule `product.SPEC_NAME_RE`, `product.py:39`, the same as `validate_slice.FILENAME_RE`, `validate_slice.py:44` |
| `product/principles.json` | `Studio.principles_path`, `studio.py:437-439` |
| `product/needs.json` | `needs.py` (module docstring, line 20) |
| `product/mocks/SLICE-NNN/<sha256>.<png|jpg>` | `mocks.folder`, `mocks.py:33-34` |
| `product/ideas/IDEA-NNN.json`, `.lookups.json`, `.map.json` | `shape.Ideas`, `shape.py:254, 270-284` |
| `product/briefs/IDEA-NNN.md`, `IDEA-NNN.case.md` | `shape.py:255, 273-277` |
| `product/prds/PRD-NN/{document.md|.txt, prd.json, map.json, answers/<key>.json}` | `prd.Imported`, `prd.py:502-629` |
| `product/designs/DES-NN/{design.md|.txt, import.json, map.json}` | `design.py` docstring, lines 19-21 |
| `product/ready/...` (ready folders: `SLICE-NNN/`, `PRINCIPLES/`, `NEEDS/`, `IDEAS/IDEA-NNN/`, `DESIGN/DES-NN/`) | `handoff.write_folder`, `handoff.py:1035-1075`; `shape.py:256`; `design.py:55`; `mocks.deliver`, `mocks.py:189-207` |

The order of slices within an epic is not in the draft. It is in the ledger: `issues.json` `order[EPIC-NNN].slices` (`handoff.clean_order`, `handoff.py:1862-1875`; read with `effective_order`, `handoff.py:1957-1958`).

### 1.2 Every kind of thing, and what happens to it

"Travels" means it goes into the archive and is written in the destination. "Stripped" names the fields taken out at export (they never reach the archive) or changed at import.

| Thing | ID form | Held in | Refers to | Exported |
|---|---|---|---|---|
| Project | `project_id` (`[a-z][a-z0-9-]{1,63}`, `product.py:22`) | `product/project.json` (`SHAPES`, `product.py:43`) | nothing | Travels. In a new project it is written as it is. When joining, it is not written: the destination's project stays; the incoming name, vision and outcomes are listed in the report and kept in the import record (4.7) for the PM to add by hand if they want. |
| Epic | `EPIC-NNN` (`product.py:35`) | `product/epics/EPIC-NNN.json` | `project_id`; `serves.idea` (IDEA); `tracking.jira` | Travels. `tracking` stripped (see Jira). `project_id` set to the destination's when joining. `status` (`open`/`deferred`) kept: an epic is never approved (`product.py:70`). |
| Slice work order | `SLICE-NNN` (`product.py:36`) | `product/slices/SLICE-NNN.json` | `project_id`, `epic_id` (EPIC), `dependencies` (SLICE list), `spec_path` (path holding the SLICE ID), `source.prd_id` (PRD), `serves.idea` (IDEA), `small.shipped_rule` (`SLICE-NNN/FR-NN`, `product.py:52`), `mocks[].for` (`AC-NN`, spec-local), `origin` (GitHub issue in a repository), `tracking.jira` | Travels. Stripped at export: `origin` (names a repository, `product.py:115-118`), `tracking`. Changed at import: `status` to `draft`, `spec_sha256` to null, `spec_path` to the renamed file. Kept: `open_questions`, `kind`, `small`, `widened`, `mocks`, `serves`, `source`, `title`. |
| Slice spec | the H1 `# SLICE-NNN: Title` (`validate_slice.py:45`) and the file name | `specs/slices/SLICE-NNN-<kebab>.md` | other slices (free text, `(Deferred to SLICE-NNN)` pointers `validate_slice.py:53-54`), shipped rules `SLICE-NNN/FR-NN` in `## Effects on shipped behaviour` (`effects.py:43`), principles `**PP-NN** (revision N)` (`validate_slice.py:145`), policy rows `**POL-<pack>-NN** (sha256 ...)` and accepted concerns (`policies.py:393-395`) | Travels; text rewritten (section 5); file renamed. |
| Slice why | `# Intent:` file | `product/intents/SLICE-NNN.md` | `- **Slice:** SLICE-NNN at specs/slices/SLICE-NNN-....md`, `- **Epic:** EPIC-NNN: ...`, `- **Serves:** IDEA-NNN O-1` (`shape_route.py:50`), `## Deferred work` (`SLICE-NNN`) (`skills/studio/assets/intent-template.md`) | Travels; text rewritten; file renamed. |
| Order within an epic | list of SLICE IDs | `issues.json` `order` (ledger) | slices | Travels as a fact (`facts.json`, 2.1), read with `handoff.effective_order` limited to the slices in the archive; written into the destination ledger's `order` for the new epics only. |
| Dependencies | SLICE list | slice work order | slices | Travel inside the work order. A dependency is always on a slice in the archive: `validate_workspace` refuses an unknown one (`product.py:410-417`), and export refuses an invalid workspace. |
| Product principles | `PP-NN` (`product.py:222`) | `product/principles.json` (`id, title, statement, reason, status, revision`) | nothing | Travel, with `status` and `revision` kept (a spec's principle row quotes the revision). Publication state (`issues.json` `principles`: `published`, `sha256`, `revision`, `run`, `saved`) stays behind: it describes the source's project issue. In the destination they are unpublished, and `slice ready` refuses until they are published (`studio.py:1434-1437`). |
| Technical needs | `TN-NN` (`product.py:267`) | `product/needs.json` (with `none`) | `said_by` of a `given` may be a `POL-` ID (not renumbered) | Travel; publication state stays behind as for principles. When joining, the incoming `none` list is not merged: it answered "nothing to say" about the other product. Needs are cited as `TN-NN@rev` only by ADRs (`adr.py:212`), which are engineering's files in Git and do not travel. |
| Designs | `DES-NN` (`design.py:43`) | `product/designs/DES-NN/` | `map.json` conflicts `against`: `PP-NN`, `TN-NN`, `POL-...` (`design.py:44`) | Travel. The document's bytes are never changed (they are checked against their SHA-256 on every use, `prd.py:553-566`). `map.json` `published` stripped (the ready folder stays behind). `against` rewritten for PP and TN. |
| Ideas | `IDEA-NNN` (`shape.py:50`) | `product/ideas/IDEA-NNN.json` (`RECORD_KEYS`, `shape.py:70`) | `source` (an issue `number` and `repository`, a fault ticket `AUTO-...`, or a shipped `rule`), `verdict.by` (login), `route.details`, `made.epics`/`made.slices`, `lookback.*.by` and `.comment.issue`, `issue` (number) | Travels. Stripped at export: `issue`; `verdict.by` and `lookback.*.by` set to null (allowed shapes, `shape.py:138, 194`); `lookback.*.comment` removed. `source` of kind `idea`, `request` or `fault` becomes the new kind `moved` (see 1.3). `made` IDs rewritten. |
| Lookups | | `product/ideas/IDEA-NNN.lookups.json` (`LOOKUP_LIMITS`, `shape.py:76`) | `shipped_rules[].rule`, `.epic_id`; `similar[].idea` or `.request` (issue number); `principles[].id`; `policies[].id` | Travel. `similar` entries naming a `request` are removed (an issue number in a repository the archive does not name); their count is reported. |
| Brief and case | | `product/briefs/IDEA-NNN.md`, `.case.md` | `- Capabilities: name (EPIC-NNN)`, `- Shipped rules: SLICE-NNN/FR-NN` (`validate_brief.py:88-91`), free text | Travel; text rewritten. |
| Idea map | keys are map-local | `product/ideas/IDEA-NNN.map.json` | `idea_id`; `slices[].epic` (key or EPIC-NNN); `slices[].depends_on` (keys or SLICE-NNN); `applied.epics`/`applied.slices` values (EPIC/SLICE or `"trying"`); `brief_sha256` | Travels; IDs rewritten (keys are not IDs and stay). |
| PRDs | `PRD-NN` (`prd.py:43`) | `product/prds/PRD-NN/` | `map.json` like the idea map; `answers/<key>.json` `slice_id`, `prd_id` | Travel. The document's bytes are never changed. |
| Design mocks | by SHA-256 | `product/mocks/SLICE-NNN/<sha>.<ext>`; listed in the work order's `mocks` | `for: AC-NN` (spec-local) | Travel byte for byte; the folder is renamed with the slice. |
| Small changes | | work order `kind`, `small`, `widened` (`product.py:48-53`) | `small.shipped_rule` | Travel; the rule's slice ID rewritten. See section 5.4 on what this means in the destination. |
| Jira keys | `KEY-123` (`product.py:61`) | `tracking.jira` on slices and epics | a Jira issue | Stripped from the work order. Kept in `facts.json` so the report can list them; the PM links again with `slice link`/`epic link` on their word. Reason: the destination organisation may use another Jira or none, and a key carried silently would be written into every issue marked ready (`studio.py:1517`). Open point 3. |
| Requests and origin | GitHub issue number | `origin` on the work order; `.factory/studio/requests.json`, `requests/` | an issue in the source repository | Stays behind. The archive keeps only "came from request #N" in `facts.json` (a number, never the repository). The request cache and its texts stay: they are someone else's words from a repository the archive must not name. |
| Policy-pack answers | `POL-<pack>-NN` | inside the spec text | the source organisation's packs (by a 12-character SHA-256) | Travel as text, unchanged. The destination's packs are another organisation's; the existing drift check (`studio.policies_changed`, `studio.py:1253-1262`) flags rows answered under other packs. Accepted concerns (`accepted by X on DATE: "..."`) are a person's decision inside the text: kept, and listed in the report. Open point 4. |
| Resume notes | | `session.json` `notes[SLICE-NNN]` (`studio.py:1329-1335`) | slice | Travel in `facts.json`, rewritten to the new IDs. The rest of the session (`current_slice`, `withdrawn`, `baseline`, `resolutions`) stays. |
| Hand-off ledger | issue numbers | `.factory/studio/issues.json` | GitHub issues, approvals, `seen`, `lost`, `shipped` | Stays behind, except the `order` above. It is wiped anyway when the repository changes (`handoff.for_repository`, `handoff.py:156-164`). |
| Approvals | comments on GitHub; `spec_sha256` on an approved work order | GitHub and the work order | | Never carried (owner's decision 2). The source state of each slice is a fact in `facts.json` (2.1). |
| Ready folders | | `product/ready/**` | | Stay behind: each is a hand-off to the source's builders, with an approval. |
| Ideas ledger | | `.factory/studio/ideas.json` | idea issues | Stays behind. |
| Shipped-check record | commit IDs | `.factory/studio/shipped.json` | the source's main branch | Stays behind. |
| Shipped specs, ADRs, change records, policy packs | | the source repository's main branch | | Stay behind. They are engineering's, in Git, and the archive is the product workspace only. |
| The Factory's ledger, cells, claims | | `.factory/intake/ledger.json` (`intake.py:35`), `.factory/worktrees/` | | Stay behind and are never read. |
| Fault tickets | `AUTO-...` | `.factory/inbox/` | | Stay behind; an idea started from one is `moved` (1.3). |

### 1.3 One schema change: an idea that came from elsewhere

An idea's `source` of kind `idea` or `request` needs an issue `number` (`shape.py:117-119`), and `source_view` reads that number from the destination's request cache when the record names no repository (`shape.py:600-604`). Keeping the number would show the destination's issue #N as the idea's source: wrong text, presented as the source. Dropping it makes the record invalid. Calling it `typed` would say the PM typed it, which they did not.

So `shape.SOURCE_KINDS` (`shape.py:64`) gains `moved`: `{"kind": "moved"}` and nothing else, shown as "Came from another repository; its source is not kept here." The import record (4.7) keeps what it was (`request #42`, `idea #17`, `fault AUTO-...`). Kind `change` keeps its `rule`, rewritten. Kind `typed` is unchanged.

## 2. The archive

### 2.1 Layout

One ZIP file, named by export `mach-project-<project_id>-<YYYYMMDDTHHMMSSZ>.zip`. Every member is a regular file; there are no folder entries.

```
mach-project.json                          the manifest (below)
facts.json                                 source facts that are not workspace files (below)
workspace/product/project.json
workspace/product/epics/EPIC-NNN.json
workspace/product/slices/SLICE-NNN.json
workspace/product/intents/SLICE-NNN.md
workspace/specs/slices/SLICE-NNN-<kebab>.md
workspace/product/principles.json          only if the project has principles
workspace/product/needs.json               only if it has needs
workspace/product/mocks/SLICE-NNN/<sha256>.png|.jpg
workspace/product/ideas/IDEA-NNN.json | .lookups.json | .map.json
workspace/product/briefs/IDEA-NNN.md | IDEA-NNN.case.md
workspace/product/prds/PRD-NN/prd.json | document.md|document.txt | map.json | answers/<key>.json
workspace/product/designs/DES-NN/import.json | design.md|design.txt | map.json
```

`workspace/` mirrors the draft with the same relative paths, so a member's path is checked against one fixed list of patterns (2.3) and never used as a destination path (4.5).

**`mach-project.json`**, canonical JSON (`studio.canonical`, `studio.py:156-158`):

```json
{
  "format": "mach-project-archive",
  "format_version": 1,
  "mach_version": "0.24.0",
  "exported_at": "2026-11-24T13:06:00Z",
  "project_id": "team-space",
  "counts": {"epics": 3, "slices": 14, "principles": 4, "needs": 6, "ideas": 2, "prds": 1, "designs": 0, "mocks": 3},
  "files": [{"path": "facts.json", "bytes": 1234, "sha256": "..."}, ...]
}
```

- `mach_version` from `faults.mach_version` (`skills/intent/scripts/faults.py:281-296`); null when it cannot be read (said, not guessed).
- `files` lists every other member, sorted by path. The manifest does not list itself.

**`facts.json`**: what the source knew that is not a workspace file, identifiers and words only.

```json
{
  "schema_version": 1,
  "last_read_github_at": "2026-11-24T12:50:00Z",
  "order": {"EPIC-001": ["SLICE-003", "SLICE-001", "SLICE-002"]},
  "slices": {
    "SLICE-001": {"was": "shipped", "revision": 3, "jira": "TEAM-12", "request": 42, "note": "Stopped at the second question."},
    "SLICE-002": {"was": "being_built", "revision": 1}
  },
  "epics": {"EPIC-001": {"jira": "TEAM-1"}},
  "ideas": {"IDEA-001": {"was_source": {"kind": "request", "number": 42}}},
  "lookups_removed": {"IDEA-001": 2}
}
```

`was` is `handoff.progress` (`handoff.py:1817-1829`): one of `draft, interviewing, ready_for_approval, approved, ready_to_build, being_built, question, shipped, superseded`, as of the last refresh, whose time is `last_read_github_at` (null if GitHub was never read). It is never refreshed by export.

### 2.2 Writing it

- Members are written in sorted path order, `ZIP_DEFLATED`, each with the fixed time 1980-01-01 00:00:00 and mode `0o100644` (regular file), no extra fields, no comment. With the manifest's `exported_at` the only clock, two exports of the same workspace differ only in that field.
- Written to `<target>.tmp` and then `os.replace`d, as `studio.write` does (`studio.py:161-165`).

### 2.3 Refusing an archive

Checked in this order; the first failure refuses and nothing is written. The reader never extracts to disk: each member is read into memory, bounded.

| Check | Limit |
|---|---|
| The file exists, is a regular file, not a symbolic link, and is at most 256 MiB | 256 MiB |
| It opens as a ZIP (`zipfile.is_zipfile` and `ZipFile`) | |
| At most 5,000 members | |
| Every member name: UTF-8, no NUL, no backslash, no leading `/`, no drive letter, no empty, `.` or `..` segment, only `[A-Za-z0-9._/-]`, and matches one pattern of 2.1 | |
| No two members with the same name, or names equal ignoring case (macOS file systems) | |
| No folder entries; `external_attr >> 16` is 0 or a regular file mode; a symbolic link (`S_IFLNK`) or any other type refuses | |
| Not encrypted (flag bit 0); compression is stored or deflated only | |
| Each member's declared size within its kind's limit: manifest, `facts.json` and any `.json` 1 MiB (`product.MAX_JSON_BYTES`, `product.py:75`); Markdown 1 MiB; PRD or design document 512 KiB (`prd.MAX_BYTES`, `prd.py:54`); mock 5 MiB (`issue_rules.MOCK_MAX_BYTES`, `issue_rules.py:720`) | per kind |
| Total declared uncompressed size at most 512 MiB; any member whose declared size is more than 200 times its compressed size and over 1 MiB refuses (a ZIP bomb) | |
| Each member is read with a cap of its limit plus one byte; more bytes than declared, or a CRC error, refuses | |
| `mach-project.json`: valid JSON object, `format == "mach-project-archive"`; `format_version` an integer; above 1 refuses with "made by a newer MACH"; below 1 refuses | |
| The manifest's `files` lists exactly the other members, no more, no fewer, and every SHA-256 and size matches | |
| Content (4.1, step 2): every record in the form Studio writes | |

### 2.4 No repository, account, token or absolute path inside

The fields that carry them are stripped by construction (1.2): `origin`, `issue`, `verdict.by`, `lookback.*.by` and `.comment`, `similar[].request`, design `published`, the whole ledger. What is left is text a person or a model wrote, and that can still name anything. So export scans every member's bytes, after stripping and before writing, for:

- the repository, as `owner/repo` and as `github.com/owner/repo`, case-insensitive, from `git remote get-url origin` (local, no network) and from `issues.json` `repository`;
- every GitHub login this workspace has recorded: `issues.json` (`seen` rows' `approved_by`, `lost.by`, the principles' and needs' `approved_by`), `ideas.json`, verdicts and look-backs before stripping, `requests.json`;
- the project's absolute path and the home folder (`Path.home()`), as written;
- secret-shaped text, with the scanner Shape already uses (`validate_brief.scan.secrets_in_text`, used at `shape_route.py:827`).

A match refuses the export, naming the file and line in the PM's words (7.1). Export does not redact: changing a spec silently would be fabricating a different spec. Open point 6.

The test (9, scenario 10) builds a source in `acme/team-space` with logins `ada-pm` and `ben-pm`, exports, reads every member, and asserts none contains `acme`, `team-space`, `ada-pm`, `ben-pm`, the temporary root's path or the home folder; and that a spec holding `https://github.com/acme/team-space/issues/3` is refused with nothing written.

## 3. Export

`studio.py project export [--out <folder>] [--only-mine]`

**Reads** the draft workspace and Studio's records, never GitHub and never Git beyond `git remote get-url origin`. It exports the drafts. For an approved slice the draft is the approved text: `validate_workspace` refuses an approved slice whose spec does not match its `spec_sha256` (`product.py:418-430`). For a slice reopened or changed since it was marked ready, the draft is exported and `facts.json` says what the source knew (`was`, `revision`); the report says "SLICE-004 changed since it was marked ready; the archive holds your draft". A slice someone else saved a newer version of on GitHub (`newer_elsewhere`, `handoff.py:1791-1792`) is exported as this workspace holds it, with a warning naming it.

**Refuses** (each sentence in 7.1), changing nothing:

- no project in the workspace;
- the workspace is not structurally valid (`Studio.structural`, `studio.py:343-344`);
- an idea, PRD or design record not in the form Studio writes (`shape.record_problems`, `prd.Imported.meta`), or a PRD or design document whose bytes no longer match its SHA-256 (`prd.Imported.intact`);
- a mock picture that fails `issue_rules.check_mock_file`;
- a file that cannot be read as UTF-8 text;
- a symbolic link anywhere under the draft;
- slices of this project that GitHub held at the last refresh but this workspace does not (`handoff.epic_members` counts them, `handoff.py:1947-1954`), unless `--only-mine`. Without the flag the refusal names them and says how to open each here (`slice take`, `studio.py:1732`). Open point 7;
- a member over its size limit (2.3), or the archive over 256 MiB;
- a repository name, a login, an absolute path or a secret in any text (2.4);
- an unfinished import in this workspace (4.6);
- a supervised Factory execution (`policies.unattended`, as `policy accept` refuses at `studio.py:1287-1288`).

**Writes** one file: `--out` if given (a folder that exists, not a symbolic link), else `.factory/studio/export/`, which is git-ignored with the rest of `.factory/studio/`. Nothing else changes: no draft, no record, no session.

**Prints**:

```json
{"exported": true, "file": "/abs/.factory/studio/export/mach-project-team-space-20261124T130600Z.zip", "bytes": 48213,
 "sha256": "...", "counts": {...}, "left_out": [], "warnings": ["SLICE-004 changed since it was marked ready; the archive holds your draft."],
 "stays_behind": ["approvals", "GitHub issues and their numbers", "Jira keys (listed in the archive for the report)", "requests", "ready folders"],
 "factory_authorized": false,
 "note": "The project is in one file. It names no repository and no account. Nothing was sent anywhere."}
```

## 4. Import

`studio.py project import <archive> [--plan]` and `studio.py project imports [<old-ID>]` (reads only).

### 4.1 Check everything; change nothing

1. **The archive** (2.3).
2. **The content**, in memory: every work order, epic and project through `product._shape` (`product.py:167-219`); principles and needs through `product._principles` and `_needs`; ideas through `shape.record_problems`; idea and PRD maps through `prd.check_map`'s rules as far as they apply without a document; mocks through `issue_rules.check_mock_file` and their file name equal to their SHA-256; PRD and design documents through `prd.check_document` and their recorded SHA-256. Then the whole `workspace/` tree written to a temporary folder outside the project (`tempfile.mkdtemp`), checked with `product.validate_workspace`, and removed. Every spec's H1 names the ID of its file name; every work order's `spec_path` names the spec that is there.
3. **The destination**, read only: `Studio(project)` (refuses symbolic links, `studio.py:177-179`); its own workspace structurally valid; no unfinished import of another archive (4.6); not inside a supervised execution.

### 4.2 New project or join

- **Join** when the draft has `product/project.json`.
- **Refused** when the draft has no project but GitHub holds a project issue (`Handoff.github_project`, `handoff.py:1362-1371`, read only): the PM first takes that project into the workspace with `project init` (which adopts it, `studio.py:920-942`), then imports to join it. Several project issues: refused as `project init` refuses (`handoff.several_projects`).
- **Refused** when the archive's `project_id` equals the destination's: the same project would arrive twice.
- **New project** otherwise. IDs are kept, unless an ID of a kind is already used in the destination (an engineer's own ticket on main can hold `SLICE-001` with no MACH project); then that kind is numbered as in a join and the plan says why. Open point 5.

### 4.3 The numbering plan

The map is complete: one entry for every ID of seven kinds the archive holds, and for every slice ID reserved by a `(Deferred to SLICE-NNN)` pointer in an incoming spec (those are in the slice ID space; `cell.scan_ids`, `cell.py:473-496`).

| Kind | Width | Next free number in the destination counts |
|---|---|---|
| `SLICE` | 3 | `cell.slice_ids` (main checkout, open cells, the draft, work orders, reserved pointers; `cell.py:499-514`); the slice IDs GitHub's issues hold, read now with `Handoff.refresh_numbers` (`handoff.py:1343-1360`, reads only, stores `seen.taken`); and `cell.shared_slice_ids` (specs on `origin/<main>` as last fetched, and every slice issue's ID through `ticket.py slice-ids`; `cell.py:529-559`). This is one more read than `Studio.next_id` (`studio.py:312-317`) makes today; a batch of dozens of IDs is worth it. |
| `EPIC` | 3 | as `Studio.next_id("epic")` (`studio.py:318-325`): epic IDs GitHub's epic issues hold (`epic_numbers`, `handoff.py:1328-1331`, fresh after `refresh_numbers`), `product/epics` on the main checkout and in the draft. |
| `PP` | 2 | as `next_principle_id` (`studio.py:1857-1862`): the draft, the ledger's published list, `seen.principles`; and, new, the principles section of the project issue read now, with the reader `refresh` already uses (`Handoff.read_set`, `handoff.py:919`, given the snapshot `Handoff.read` returns; read only, its result kept in memory and not saved). |
| `TN` | 2 | as `needs.next_id` (`needs.py:128-133`), plus the needs section read the same way (`read_set` with `NEEDS_KIND`). |
| `IDEA` | 3 | as `Ideas.next_id` (`shape.py:337-342`), plus the idea issues listed now (`issues.list_issues` with `issue_rules.SHAPE_IDEA_LABEL`, as `shape.py:903` lists them; read only). |
| `PRD` | 2 | `product/prds/` in the draft (`prd.py:610`). |
| `DES` | 2 | `product/designs/` in the draft (the same rule, `prd.Imported`). |

Also counted, for every kind: numbers an unfinished import reserved (4.6).

The rule: for each kind, `first = highest number counted + 1`; the incoming IDs of that kind, sorted by number, get `first, first + 1, ...`. The same destination and the same archive give the same map. In a new project with no clash, every entry maps to itself.

When GitHub cannot be read, numbering goes on from what this computer holds and the plan says so in the words `prd apply` uses (`prd.numbers_note`, `prd.py:844-849`); marking ready checks again (M20 A3).

### 4.4 The plan (`--plan`)

The same computation, then it stops. Writes nothing (the read of GitHub updates `seen` in `issues.json`, as `prd apply` already does; that is Studio's cache of GitHub, not the project). Prints:

```json
{"plan": true, "mode": "join", "into_project": "team-space", "from_project": "lending",
 "map": {"EPIC": [["EPIC-001", "EPIC-004"]], "SLICE": [["SLICE-001", "SLICE-031"], ["SLICE-007", "SLICE-032"]], "PP": [...], "TN": [...], "IDEA": [...], "PRD": [...], "DES": []},
 "numbers_counted": {"SLICE": {"highest_used": 30, "github_read": true, "origin_main_read": true}, ...},
 "slices": [{"from": "SLICE-001", "to": "SLICE-031", "title": "...", "was": "shipped", "was_words": "shipped in the old repository"}],
 "check_by_hand": [{"file": "specs/slices/SLICE-031-....md", "line": 40, "id": "SLICE-007", "why": "inside a code block; left as written"}],
 "not_in_archive": [{"file": "...", "line": 12, "id": "SLICE-200", "here": "SLICE-200 in this repository is \"Export invoices\""}],
 "after": ["Publish the principles before any slice can be marked ready: 4 came with the project.",
           "12 slices name shipped rules of the old repository under 'Effects on shipped behaviour'; each needs those rows answered again here."],
 "left_behind": {"jira": {"SLICE-001": "TEAM-12"}, "requests": {"SLICE-003": 42}, "accepted_concerns": [...]},
 "writes": "nothing", "factory_authorized": false}
```

The import that follows recomputes the map. If anything was numbered in between, its map differs and its report says "The numbers moved since the plan: ..." with both.

### 4.5 The write

Recorded first, then done in a fixed order, each step looking before it writes.

1. **The import record** `.factory/studio/imports/<id>.json`, `<id>` the first 16 hex characters of the archive's SHA-256, written with `studio.write` before anything else: `{schema_version, archive_sha256, mode, from_project, into_project, started_at, finished_at: null, map, targets: {relative path: sha256 of the bytes to be written}, merges: {principles: [ids], needs: [ids]}, order: {...}, notes: {...}, facts: {...}}`.
2. **Staging**: every file to be written, already rewritten (section 5), under `.factory/studio/imports/<id>/files/`, at its final draft-relative path. Target paths are made from the map and Studio's own path functions (`Studio.path`, `intent_path`, the kebab tail of the spec name, `mocks.folder`, `Ideas.path`, `Imported.folder`), never from a member's name.
3. **Placing**, in this order, each file with `os.replace` from staging:
   1. PRD and design folders;
   2. mock pictures;
   3. ideas, lookups, maps, briefs, cases;
   4. principles and needs, as merges: `principles.json` (and `needs.json`) read now, the incoming items added by ID, written whole with `Studio.save_product_file` (`studio.py:466-478`); an ID already present with the same content is skipped, with other content stops (below);
   5. in a new project, `project.json`;
   6. epics;
   7. specs and whys;
   8. slice work orders, dependencies first (a topological order; ties by new ID), so the workspace is structurally valid after every one;
   9. the order of each new epic into `issues.json` `order` under `Handoff.exclusive` (`handoff.py:101-107`), only where that epic has no order yet;
   10. resume notes into `session.json` `notes`, only where the new slice has none.
4. **Finished**: `finished_at` set, staging removed, `.factory/studio/imports/<id>.json` kept.

Before each file is placed: if the target exists with exactly the recorded bytes, it is already done and skipped; if it exists with other bytes, the import stops and says which file and that the number was taken by something else meanwhile (7.2). With the reservation in 4.6 that should not happen inside Studio; it can still happen if an engineer grooms a ticket on this computer in the same minutes (`cell.slice_ids` does not read Studio's import record; see 10, piece D).

After placing, `product.validate_workspace` runs once more. A problem it introduces (compared with before the import) is reported in the result, never silently fixed; the files stay, and the import record keeps the map.

### 4.6 Stopping half-way and running again

- An import record with `finished_at: null` is an unfinished import. `status` adds to `saved.not_saved` (`studio.saved_state`, `studio.py:735-774`) one row: "Bringing in the project from <file> stopped part way. Run it again with the same file to finish." Export refuses while it stands.
- Running `project import` with an archive whose SHA-256 is that record's: the record's map is used, never recomputed (the numbers now count the import's own placed files). Staging is rebuilt from the archive with that map if it is missing (the rewrite is deterministic), and placing goes on. Every step looks first, so nothing is written twice.
- Running it with another archive is refused until the first is finished.
- Running it with an archive already finished: "Already brought in on DATE. Nothing was changed.", with the map.
- While an import is unfinished, every Studio allocator also skips the numbers in its map: `Studio.next_id`, `next_principle_id`, `needs.next_id`, `Ideas.next_id` and the PRD and design numbering call `project_import.reserved_numbers(studio, kind)`.

### 4.7 What the person sees, and the map kept

The result of `project import` is the plan's fields (4.4) plus `placed` (counts), `already_there` (on a re-run), `structural_errors` introduced, and a `note`:

"Brought in 14 slices in 3 epics from the project 'Lending'. Every slice is a draft here: in the old repository 5 were shipped, 2 were being built and 3 were ready to build. Nothing was sent to GitHub. Publish the principles, then mark each slice ready when you have checked it."

The import record stays in `.factory/studio/imports/`. `project imports` lists them; `project imports SLICE-007` answers "SLICE-007 of 'Lending' is SLICE-032 here (brought in on 2026-11-24)". The record also keeps the incoming project's name, vision and outcomes (join), what each idea's source was (1.3), and the left-behind Jira keys and request numbers. It is machine-local, like `issues.json`. Open point 8.

## 5. Rewriting references

### 5.1 Where an ID appears

**JSON fields, rewritten by exact value** (one function per record kind):

| Record | Fields |
|---|---|
| project | `project_id` (new project only; join writes no project) |
| epic | `epic_id`, `project_id` (join), `serves.idea` |
| slice | `slice_id`, `project_id` (join), `epic_id`, `dependencies[]`, `spec_path` (the `SLICE-NNN` in the file name), `source.prd_id`, `serves.idea`, `small.shipped_rule` (the part before `/`) |
| principles.json | `project_id` (join), `principles[].id` |
| needs.json | `project_id` (join), `needs[].need_id` |
| idea | `idea_id`, `source.rule` (kind `change`), `made.epics[]`, `made.slices[]`, every `EPIC`/`SLICE`/`IDEA` value inside `route.details` |
| lookups | `shipped_rules[].rule`, `shipped_rules[].epic_id`, `similar[].idea`, `principles[].id` |
| idea map, PRD map | `idea_id` or the PRD's ID; `slices[].epic` and `slices[].depends_on[]` where the value is an ID (not a map key); `applied.epics` and `applied.slices` values |
| PRD meta, answers | `prd_id`; answers' `slice_id` |
| design meta, map | the DES ID field; `conflicts[].against` when `PP-` or `TN-` |

**Text, by the token rule (5.2)**: specs, whys, briefs, cases; and these JSON string fields that people or the model wrote: slice `title`, `open_questions[]`, `widened.reason`; epic `title`, `acceptance_criteria[]`; project `vision`, `outcomes[]`; principle `title`, `statement`, `reason`; need `statement`, `why`; idea `title`, `verdict.reason`, `route.why`, `lookback.*.note`; maps' `settled.*.reason`, map slice `title` and `scope`; lookups' `note`; resume notes.

**File and folder names**: `specs/slices/SLICE-NNN-<kebab>.md`, `product/intents/SLICE-NNN.md`, `product/slices/SLICE-NNN.json`, `product/epics/EPIC-NNN.json`, `product/mocks/SLICE-NNN/`, `product/ideas/IDEA-NNN.*`, `product/briefs/IDEA-NNN.*`, `product/prds/PRD-NN/`, `product/designs/DES-NN/`.

**Never rewritten**: PRD and design documents (their SHA-256 binds them, `prd.py:553-566`); mock pictures; spec-local IDs (`FR-`, `INV-`, `AC-`, `R1`), brief-local IDs (`O-`, `A-`, `Q-`), `POL-` IDs, map keys, Jira keys.

### 5.2 The token rule

One regular expression, one pass, a function for each match:

```
(?<![A-Za-z0-9_-])(SLICE|EPIC|IDEA)-([0-9]{3,})(?![0-9])
|(?<![A-Za-z0-9_-])(PP|TN|PRD|DES)-([0-9]{2,})(?![0-9])
```

- The whole token (prefix and all its digits) is looked up in the map. Found: replaced. Not found: left as written and reported (`not_in_archive`), with what that ID is in the destination, if anything.
- Not preceded by a letter, digit, `_` or `-`; not followed by a digit. So `SLICE-001` never matches inside `SLICE-0011` (the digits run on), `XSLICE-001` or `PRE-SLICE-001`. It matches in `SLICE-011/FR-02` (only `SLICE-011` is replaced), in `SLICE-011-invite.md` (a path), in `(Deferred to SLICE-011).` and in `**PP-03**`. This is the boundary `replace_id` uses today (`studio.py:2204-2205`), with `_` added.
- One simultaneous pass over the whole map: a replacement is never looked at again, so a swap (`SLICE-001 -> SLICE-002`, `SLICE-002 -> SLICE-003`) never chains. `cmd_renumber` (`studio.py:2208-2293`) renames one ID at a time and could chain if called in a loop; import does not call it.
- **Inside fenced code blocks** (`validate_slice.FENCE_RE`, `validate_slice.py:47`) **and inline code spans** (`INLINE_CODE_RE`, `validate_slice.py:71`) tokens are left as written and listed in `check_by_hand` with file and line. Code in a spec is quoted material: an example format, a log line. This is the ADR renumber's rule for an ID it cannot be sure of (listed for a person, never guessed; `M20_TEAMS_AND_MOVING.md` A3).
- Quoted text outside code (`"..."`) is rewritten: a principle row quotes the principle, a concern row quotes a policy statement, and both are the spec's own words.
- A spec whose rewrite would leave its H1 naming a different ID from its file name is impossible by construction (both come from the same map) and is asserted.

### 5.3 Hashes over rewritten text

| Hash | What happens |
|---|---|
| work order `spec_sha256` | null: every slice is a draft. No approval is invalidated, because none is carried. |
| the ledger's `spec_sha256`, `why_sha256`, approval comments | not exported. |
| idea `brief.sha256` (the last check) | kept as the source recorded it; the next `brief check` sees the rewritten text as a new revision. |
| `verdict.brief_sha256` | kept. If rewriting changed the brief, `shape.verdict_holds` (`shape.py:482-484`) is false and the idea says "The brief changed after this verdict was recorded ... Record a verdict on the brief as it is now." Nothing recomputed: recomputing would bind a person's decision to text they did not decide on. |
| `route.brief_sha256`, idea map `brief_sha256` | kept; Shape's existing checks report them stale. |
| PRD map `prd_sha256`, slice `source.sha256` | unchanged: the PRD document is never rewritten. |
| mock SHA-256s | unchanged: pictures are never rewritten. |
| policy rows' pack hashes | unchanged: they name the source organisation's packs; the drift check flags them. |

In a new project with no renumbering, nothing is rewritten and every hash still matches: an idea's verdict holds as it did.

### 5.4 What rewriting cannot fix

The references are right after import, but what they point to has changed:

- **Shipped rules.** `SLICE-011/FR-02` was shipped in the source. In the destination `SLICE-011` (or its new number) is a draft and no spec of it is on main. `effects.check` reports every such row as `effects-not-shipped` (`effects.py:328-333`), so every spec with a row under `## Effects on shipped behaviour` fails `slice check` until the PM answers that section again for this repository. The same holds for a small change's `small.shipped_rule` (it must be in force, BLUEPRINT "A small change (M18)"), a brief's `- Shipped rules:` line and lookups. The plan and the report list each such slice and idea.
- **Principles, when joining.** The incoming principles are new to the destination's slices, and the destination's to the incoming ones: `principle_flags` (`studio.py:590-613`) shows them unanswered on both sides. Same-worded principles are listed ("PP-07 says the same as PP-02; retire one if they are the same"), never merged.
- **Policy packs**: another organisation's packs; flagged, never reopened.

## 6. What import never does

- Writes to GitHub: no issue, label, comment, pin, close or sub-issue. Its only GitHub calls are reads (`refresh_numbers`, `github_project`, the idea list, `ticket.py slice-ids`). The test asserts the fake gh's call log holds no write (9, scenario 12).
- Approves anything, marks anything ready, records a verdict as given here, or publishes principles or needs.
- Writes outside `.factory/studio/draft/`, `.factory/studio/imports/`, and the two records it adds to (`issues.json` `order`, `session.json` `notes`). It never touches the main checkout, its branch, index or stash; `.factory/intake/`, cells, worktrees, claims, `.factory/inbox/`; the requests cache; `ideas.json`; `shipped.json`.
- Uses a path from the archive as a path on disk.
- Runs inside a supervised Factory execution.
- Starts a station, a cell or a ticket. Every result carries `factory_authorized: false`.

## 7. Refusals and their words

Each is printed as `refused: <sentence>` (`studio.refuse`, `studio.py:2483-2491`). Every one ends with "Nothing was changed." unless it already says so. Terminal words name the command in brackets only where the skill runs it; app words (`say`, `studio.py:67-68`) leave it out.

### 7.1 Export

- "There is no project here yet, so there is nothing to export."
- "The project's files are not consistent, so they were not exported: <errors>. Run status to see what needs fixing."
- "IDEA-003's record is not in the form Product Studio writes, so the project was not exported: <problem>."
- "The copy of PRD-02 in the workspace no longer matches what was imported, so the project was not exported. Import the document again."
- "SLICE-004's design mock <sha256 first 12> is not a picture Product Studio can check, so the project was not exported."
- "SLICE-004's spec cannot be read as text, so the project was not exported."
- "3 slices of this project are on GitHub but not in your workspace: SLICE-008 (#41), SLICE-009 (#44), SLICE-012 (#51). Open each here first (slice take 41), or export without them (project export --only-mine)."
- "SLICE-004's spec names this repository (acme/team-space) on line 12. The archive must not name the repository, so nothing was exported. Take it out of the spec, then export again."
- "IDEA-002's brief names the GitHub account ada-pm on line 8. ..." (same ending)
- "SLICE-004's why holds text shaped like a password or key on line 5. ..." (same ending)
- "The project is <n> MB, more than the 256 MB an archive may be. Remove design mocks that are no longer needed, then export again."
- "Bringing in another project stopped part way here. Finish it first (run the import again with the same file), then export."
- "Exporting a project is a product manager's act; a supervised execution does not do it."
- "<folder> is not a folder on this computer." / "<folder> is a symbolic link. Choose a real folder."

### 7.2 Import

- "There is no file at <path>."
- "<file> is not a project archive from MACH." (not a ZIP, or no manifest)
- "<file> was made by a newer MACH (archive format <n>). Update MACH here, then import it again."
- "<file> is not in a form MACH can read safely: <one reason>. Nothing was changed." with reasons such as "a file in it would be written outside the project (<name>)", "it holds a link to another file", "it holds a folder or file MACH does not know (<name>)", "a file in it is larger than <limit>", "it unpacks to far more than it holds", "it is encrypted", "two files in it have the same name".
- "<file> has been changed since it was exported: <member> does not match the archive's own list." (one sentence for any hash, size, missing or extra member)
- "<file> holds a slice that is not in the form Product Studio writes (<SLICE-ID>: <problem>)."
- "Your own workspace has problems that must be fixed first: <errors>."
- "This repository already has a project on GitHub (#12), and your workspace does not have it yet. Define the project first, which takes it from GitHub (project init), then bring the archive in; its epics join that project."
- "This repository has several project issues on GitHub (#12, #19). One repository holds one project. Close the one that should not be there, then try again."
- "The archive is of the project 'team-space', which is already here. Importing it would make a second copy of every epic and slice."
- "Bringing in <other file> stopped part way. Finish it first: run the import again with that file."
- "Already brought in on 2026-11-24. Nothing was changed." (a result, not a refusal: exit 0, with the map)
- "Bringing in a project is a product manager's act; a supervised execution does not do it."

During placing (the import record stays; status says it is unfinished):

- "Bringing in stopped: SLICE-032 is now used by another slice here (specs/slices/SLICE-032-....md), made after the numbers were given out. Give that slice a new number (slice renumber SLICE-032), then run the import again with the same file."
- "Bringing in stopped part way: <OS error in plain words>. Run it again with the same file; nothing already brought in is repeated."

## 8. The skill and the app

### 8.1 `/mach-studio`

A new section, "Moving the project to another repository", in `skills/studio/SKILL.md`, and `project import` added to guardrail 3's list (a PM's act, only on their word). Export writes only a file, but runs on the PM's word too.

**Leaving.** When the PM says they want to take the project to another repository:

1. Say what goes and what stays, in their words: the project, epics, slices with their specs and whys, principles, technical needs, ideas, PRDs, designs and design mocks go; approvals, GitHub issues, Jira links and requests stay; every slice arrives as a draft to be marked ready again there.
2. Run `STUDIO project export`. On the refusal about slices not in the workspace, offer to open each (`slice take`) or to leave them out (`--only-mine`), as the PM chooses. On a refusal naming the repository, an account or a secret in a text, show the line and offer to edit the draft with them.
3. Tell them where the file is and how big it is, and offer to show it in Finder. Never upload or send it.

**Arriving.** When the PM wants to bring a project in:

1. Ask for the file: "Drag the file MACH made into this conversation, or tell me where it is." Never ask them to type a flag.
2. Run `STUDIO project import <path> --plan`. Say whether it joins this project or becomes the project; how many epics and slices; the first few number changes ("SLICE-001 becomes SLICE-031"); which slices were ready, being built or shipped in the old repository; what will need doing after (publish the principles; slices whose effects name the old repository's shipped rules; Jira keys to link again). Show `check_by_hand` and `not_in_archive` lines if any.
3. On their yes, run `STUDIO project import <path>`, and report its note. Offer the next step: publish the principles (on their word), then resume the first slice.
4. "What was SLICE-007 before?": `STUDIO project imports SLICE-007`.

The interview's command filter denies both commands (`apps/studio/internal/interview/command.go:28`, `deniedOps`, and `deniedIdeaOps` at line 44).

### 8.2 The app

The host runs a fixed list of operations (`apps/studio/internal/engine/ops*.go`), each with typed arguments and no path from the request; uploads arrive as base64 inside the JSON body and are staged by the host (`engine/upload.go`). Downloads exist for one operation only: `jira.export` (`Download: true`, `ops_product.go:617`), whose files the host reads only from `.factory/studio/jira/<set>/`, with fixed names, a 16 MiB cap and no symbolic link on the way (`server/downloads.go:33-41, 102-141`).

**v1: export only, as a download.** A `project.export` operation (no arguments; the host never passes `--out`), `Download: true`. `downloads.go` learns a second export set: folder `.factory/studio/export/`, file name `^mach-project-[a-z][a-z0-9-]{1,63}-[0-9]{8}T[0-9]{6}Z\.zip$`, content type `application/zip`, its own cap (64 MiB; a larger project is exported from the skill). One button on the project home, "Download this project", with the export's note and refusals as they are. A half-finished import shows in the existing "not saved" rows with no web change (the row comes from `saved_state`; whether every kind is shown generically is to be checked in `web/apps/product-studio/src/features/home`).

**Import stays in the skill in v1.** Bringing a ZIP up to 256 MiB through the browser means a JSON body of a third more than that, held in the host's memory, and a second parser of an untrusted archive's names before the engine's own checks. The engine's checks would hold, but the host's body limits (`bodyFor`, `upload.go:43`) are built for files of 512 KiB to 8 MiB. Import is also rare and consequential, and the skill's plan-then-yes conversation fits it. Later: an `project.import` operation with a staged upload, a plan screen showing the map, and the import record's lookup on the slice page ("was SLICE-007 of 'Lending'").

## 9. Tests

New test modules, each with its own fixtures; the GitHub stand-in and two clones from `tests/test_mach_product_issues.py` (`Base`, `IssuesBase`, lines 301-430; `writes()` at 425-427 lists gh's write calls).

1. **Round trip into an empty destination.** A source project with 2 epics, 6 slices (one shipped, one being built, one ready, one reopened, two drafts), principles, needs, an idea with a route that made an epic and slices, a PRD with a map and answers, a design, mocks and a small change. Export, import into a fresh clone of another repository with no project. Every Markdown file, PRD and design document and mock is byte-identical; every JSON record equals the source record after the documented strips and changes (computed by the test from 1.2, not by the code under test); `validate_workspace` is valid; every slice is `draft` with `spec_sha256` null; the order of each epic is the same.
2. **Joining with overlapping numbers.** Destination holds EPIC-001..002, SLICE-001..010, PP-01..03, TN-01..02, IDEA-001; GitHub's stand-in holds SLICE-011 and EPIC-003 not in the destination's workspace; `origin/main` holds `specs/slices/SLICE-012-x.md`. The incoming EPIC-001..002 become EPIC-004..005, SLICE-001..006 become SLICE-013..018 in order, PP-01..02 become PP-04..05, and so on. Every incoming `project_id` is the destination's.
3. **References rewritten in records and text**: dependencies, `epic_id`, `spec_path`, the H1, the file names, the why's Slice, Epic, Serves and Deferred lines, `(Deferred to SLICE-NNN)` pointers (including one to a reserved ID with no slice, which gets a number too), principle rows, `SLICE-011/FR-02` (only the slice part), `small.shipped_rule`, idea `made`, maps' `applied`, design `against`.
4. **Prefix clash and boundaries** (pure tests of the rewriter): `SLICE-001` and `SLICE-0011` both present with different targets; `XSLICE-001`, `PRE-SLICE-001`, `SLICE-001_x` untouched; a swap map (`001->002`, `002->003`) never chains; `PP-1` (too short) untouched.
5. **Code blocks**: an ID inside a fenced block and inside backticks is left as written and listed in `check_by_hand` with its line; the same ID outside code on the next line is rewritten.
6. **A slice that depends on another**, placed after it: interrupt placing between the two (a patched `os.replace` raising once) and assert the workspace is structurally valid at that moment.
7. **An idea whose route made an epic and slices**: after a join, `made` names the new IDs, the map's `applied` too, the slices' and epic's `serves.idea` the new idea; the verdict, when the brief's text was rewritten, is reported stale by Shape's own view; in a new project without renumbering it still holds.
8. **Principles and needs cited from specs**: rows rewritten; `principle list` shows the incoming principles unpublished; `slice ready` refuses until they are published; same-worded principles are listed.
9. **A tampered archive**: a changed byte in a spec (hash mismatch), a member added, a member removed, the manifest's `format_version` 2, a member over its limit, a highly compressible 600 MB member (bomb), an encrypted member, a symbolic-link member (`external_attr`), a folder member, two names differing in case. Each refused with its sentence; the destination's draft and `.factory/studio/` are byte-identical before and after (a tree hash).
10. **Path escape**: members named `../x`, `/etc/x`, `workspace/../../x`, `workspace/product/slices/..\\x`, `C:/x`, and a valid-looking `workspace/product/slices/SLICE-001.json` whose `slice_id` is `SLICE-002`. All refused; nothing written anywhere (the parent of the project is checked too).
11. **Re-running a half-finished import**: stop after epics, after half the slices, and after the order step (patched failure); each time `status` shows the unfinished row and `slice new` takes a number outside the map; running again finishes; the final tree equals a clean import's; each file was placed once (counted through the patched `os.replace`). Running a third time says "Already brought in". A second archive is refused while the first is unfinished. A file placed by something else at a target path stops with its sentence.
12. **No repository or account name in the archive** (2.4); a spec naming the repository refuses the export with nothing written.
13. **Nothing written to GitHub**: in scenarios 1, 2 and 11, `writes()` is empty for every import and export call (reads are allowed and asserted to be only `issue list`, `issue view`, `repo view` and read-only `api` calls).
14. **The plan writes nothing** to the draft; its map equals the import's when nothing changed in between, and the import reports the difference when a slice was created in between.
15. **Export refusals**: invalid workspace, slices only on GitHub without `--only-mine`, an unfinished import, a supervised execution.
16. **Shipped rules**: a spec with an effects row naming a source-shipped rule is imported; the plan lists it; `slice check` in the destination reports `effects-not-shipped`.
17. **Same project twice**: an archive with the destination's `project_id` is refused.
18. **New project with a clashing number**: a destination with no project but `specs/slices/SLICE-001-x.md` on main; slices are numbered from 002 and the plan says why.

Go (piece F): `project.export` registered with no arguments and `Download: true`; a download outside the export folder, with another name, through a symbolic link or over the cap is refused (as `downloads_test` patterns do for Jira). Web: the button's model, with the fixture transport.

## 10. Build plan

Six pieces. A to C can start at once; D starts once A's and B's interfaces are written down (they are below) and can stub them; E and F at any time against the interfaces.

### A. The archive format

- New: `skills/studio/scripts/project_archive.py`; `tests/test_project_archive.py`.
- Touches: nothing.
- Interface:
  - `FORMAT = "mach-project-archive"`, `FORMAT_VERSION = 1`, `LIMITS: Dict[str, int]`, `MEMBER_PATTERNS: Sequence[Tuple[re.Pattern, str]]` (pattern, limit kind).
  - `class ArchiveError(Exception)`: its message is the sentence of 7.2, without the "Nothing was changed." ending (the caller adds it).
  - `write(target: Path, files: Mapping[str, bytes], meta: Mapping[str, Any]) -> Dict[str, Any]`: refuses a path that matches no pattern or a member over its limit; writes `target` atomically; returns the manifest.
  - `read(source: Path) -> Tuple[Dict[str, Any], Dict[str, bytes]]`: every check of 2.3 except content; returns the manifest and the members by path (without the manifest).
- Tests: scenarios 9 and 10 at this level (built with `zipfile` by hand), deterministic bytes for the same input.

### B. The reference rewriter (pure)

- New: `skills/studio/scripts/project_ids.py`; `tests/test_project_ids.py`.
- Touches: nothing. Imports only the standard library; the code-fence rule is its own copy of `validate_slice.FENCE_RE` and `INLINE_CODE_RE`, with a test asserting they are equal to the validator's (so a change there is caught).
- Interface:
  - `PREFIXES = {"SLICE": 3, "EPIC": 3, "IDEA": 3, "PP": 2, "TN": 2, "PRD": 2, "DES": 2}`.
  - `numbering(incoming: Mapping[str, Iterable[str]], first_free: Mapping[str, Optional[int]]) -> Dict[str, str]`: old to new for every ID; `None` for a kind keeps its IDs.
  - `ids_in_text(text: str) -> List[Tuple[int, str, bool]]`: (line, ID, inside code).
  - `rewrite_text(text: str, mapping: Mapping[str, str]) -> Tuple[str, List[Dict[str, Any]]]`: the rewritten text and notes `{line, id, why: "in_code" | "not_in_archive"}`.
  - `rewrite_record(kind: str, record: Dict[str, Any], mapping: Mapping[str, str], project_id: Optional[str]) -> Dict[str, Any]` for `kind` in `project, epic, slice, principles, needs, idea, lookups, idea_map, prd_meta, prd_map, prd_answers, design_meta, design_map` (5.1), applying `rewrite_text` to the text fields listed there. Returns a new dict.
  - `rename(relative: str, mapping: Mapping[str, str]) -> str`: a draft-relative path with its ID parts renamed.
- Tests: scenarios 3 (pure parts), 4, 5; every field of 5.1 has a case; a property test that `rewrite_text` with the identity map returns the input unchanged.

### C. Export

- New: `skills/studio/scripts/project_export.py`; `tests/test_project_export.py`.
- Touches: nothing. Reaches Studio through the `host` module and `studio` object, as `prd.py` and `shape.py` do (`studio.py:2470-2473`).
- Interface:
  - `collect(host: Any, studio: Any, only_mine: bool) -> Tuple[Dict[str, bytes], Dict[str, Any], List[str]]`: the members (with strips), `facts`, warnings; raises `host.StudioError` with the sentences of 7.1.
  - `forbidden(host: Any, studio: Any) -> List[str]`: the repository forms, logins and paths to scan for.
  - `export(host: Any, studio: Any, out: Optional[Path], only_mine: bool) -> Dict[str, Any]`: the result of 3; calls `project_archive.write`.
  - `STRIP: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]]`: the per-kind strips, exported so piece D's tests and scenario 1 use the same list.
- Tests: scenarios 12, 15, and the export half of 1.

### D. Import

- New: `skills/studio/scripts/project_import.py`; `tests/test_project_import.py`.
- Touches (only this piece touches them):
  - `skills/studio/scripts/shape.py`: `SOURCE_KINDS` gains `moved`; `source_problems` allows `{"kind": "moved"}`; `source_view` words; `Ideas.next_id` skips `project_import.reserved_numbers(studio, "IDEA")`.
  - `skills/studio/scripts/needs.py`: `next_id` skips reserved `TN`.
  - `skills/studio/scripts/prd.py`: `Imported.import_file`'s number (line 610) skips reserved `PRD`/`DES` (by `self.PREFIX`).
  - Each is one or two lines and an import of `project_import` inside the function (to avoid an import cycle).
- Interface:
  - `plan(host: Any, studio: Any, archive: Path) -> Dict[str, Any]` (4.4).
  - `run(host: Any, studio: Any, archive: Path) -> Dict[str, Any]` (4.5 to 4.7).
  - `lookup(studio: Any, ident: Optional[str]) -> Dict[str, Any]` (`project imports`).
  - `unfinished(studio: Any) -> Optional[Dict[str, Any]]`: `{file, archive_sha256, started_at}` or None.
  - `reserved_numbers(studio: Any, kind: str) -> List[int]`: numbers an unfinished import's map holds for that prefix.
  - Writes the ledger's `order` and the session's `notes` through public methods only (`Handoff.exclusive`, `load`, `save`; `Studio.session`, `save_session`): no change to `handoff.py`.
- Tests: scenarios 1 (import half), 2, 3, 6, 7, 8, 11, 13, 14, 16, 17, 18.
- Known gap to state in its as-built note: `cell.slice_ids` (the engineers' allocator, intent skill) does not read the reservation, so an engineer grooming on the same computer during a half-finished import can take a reserved number; placing then stops with its sentence. Changing `cell.py` is left out to keep the intent skill untouched.

### E. Commands, skill and documents

- Touches (only this piece touches them):
  - `skills/studio/scripts/studio.py`: `import project_export, project_import, project_archive`; under the existing `project` subparser (`studio.py:2312-2324`) `export` (`--out`, `--only-mine`), `import` (`archive`, `--plan`) and `imports` (`identifier`, optional); handlers `cmd_project_export`, `cmd_project_import`, `cmd_project_imports` that call C and D and turn `ArchiveError` into `StudioError`; `run_command`'s `except` also catches `ArchiveError` (`studio.py:2531`); `Studio.next_id` (`studio.py:312-325`) and `next_principle_id` (`studio.py:1857-1862`) skip `project_import.reserved_numbers`; `saved_state` (`studio.py:735-774`) adds the `import_unfinished` row.
  - `skills/studio/SKILL.md`: section 8.1; guardrail 3.
  - `docs/BLUEPRINT.md`: a bullet "Moving a project by archive (M21)" in the `/mach-studio` section, and the directory layout's `.factory/studio/imports/` and `export/`.
  - `docs/mach-next/NEXT.md`.
  - `apps/studio/internal/interview/command.go`: `project export`, `project import` in `deniedOps` and `deniedIdeaOps` (Go, but a one-line change of a list; if F prefers, F owns it, decided at the start).
- Tests: a parser test that the three commands exist and that `--app` wording has no flag names; the reservation and `saved_state` row (with D's fixtures).

### F. The app (export download)

- Touches: `apps/studio/internal/engine/ops_product.go` (register `project.export`), `apps/studio/internal/server/downloads.go` (a second export set), their tests; `web/packages/ui/src/api/` (the operation's type), `web/apps/product-studio/src/features/home/` (the button), the fixture transport and `web/fixtures/` (one fixture: `project.export`), their tests.
- Interface used: the engine's export result (3), whose `file` lies in `.factory/studio/export/`.
- Tests: the Go cases in 9; the web model test.

### Shared files

- `studio.py` is edited only by E. C and D never import `studio` (they take `host`), so they need nothing from E to be tested: their tests call `project_export.export(studio_module, Studio(root), ...)` directly.
- `shape.py`, `needs.py`, `prd.py` are edited only by D.
- `issue_rules.py`, `handoff.py`, `product.py`, `cell.py`, `validate_slice.py` are not edited by anyone.
- No test helper is edited: new modules subclass `IssuesBase` from `test_mach_product_issues.py` as `test_team_studio.py` does (`tests/test_team_studio.py:23, 33`).

## 11. Open points for the owner

1. **Superseded slices.** Decision 2 says every slice comes as a draft. A `superseded` slice (one replaced in the source) would come back as live work. Recommendation: keep `superseded` as it is; it carries no approval and is not work to do. The report lists them.
2. **An idea's verdict.** It is a person's decision, not an approval to build. Recommendation: carry decision, reason and time with `by` null (a shape Shape already allows); the import record says it was recorded in the old repository. When renumbering changed the brief, Shape already shows it no longer holds. Alternative: drop verdicts, putting every idea back to "brief written".
3. **Jira keys.** Recommendation: not carried into the work orders, listed in the report and the import record, linked again on the PM's word. Carrying them would write the old organisation's keys into every issue marked ready.
4. **Accepted policy concerns inside a spec** ("accepted by <owner> on <date>"). They are part of the text and cannot be removed without changing the spec. Recommendation: keep the text, list each in the report as "accepted in the old repository under its policy packs; check it against this organisation's", and rely on the existing drift flag. Alternative: refuse to import a slice with an accepted concern until it is reopened in the source.
5. **A new project whose numbers clash** with specs already in the destination (engineers' own tickets). Recommendation: number that kind as in a join and say so in the plan. Keeping IDs that clash would make two slices with one ID.
6. **A text that names the repository or an account.** Recommendation: refuse the export and show the line; never redact. Alternative: redact and list what was redacted, which changes the PM's text without their word.
7. **Slices only on GitHub** (another PM's, never opened here). Recommendation: refuse by default and name them; `--only-mine` exports without them on the PM's word.
8. **Where the old-to-new map is kept.** Recommendation: only in the importing PM's `.factory/studio/imports/` in v1, like the hand-off ledger. B2 proposed also writing it as one comment on the project issue; that is a GitHub write the owner ruled out for import itself, so it would be a separate act on the PM's word, later.
9. **PRD and design numbers** are not in the owner's list but are numbered per workspace and would collide when joining. This design renumbers them like the rest. Stated so it is not a surprise.

## 12. What makes this harder than it looks

- **Shipped rules do not travel.** Every spec with a filled `## Effects on shipped behaviour`, every small change that fixes a shipped rule and every brief that names shipped rules fails its check in the destination (5.4). The archive is right; the work to answer those sections again is the PM's, and for a team that shipped much of the project this is most of the slices.
- **Seven allocators.** Slice, epic, principle, need, idea, PRD and design numbers are each allocated by different code (`studio.py:312-325, 1857-1862`, `needs.py:128-133`, `shape.py:337-342`, `prd.py:610`), several of them from GitHub "as last read", and `refresh_numbers` reads only slices and epics. Import has to read more than any one of them does, and the reservation during a half-finished import has to reach all of them (and still misses `cell.slice_ids`).
- **The order within an epic lives in the ledger** (`issues.json`), the one file otherwise left behind and wiped on a repository change.
- **The idea's `source` has no honest form** for "came from an issue in another repository" (1.3): a schema change in `shape.py`.
- **Text is free.** Nothing structural stops a PM from typing the repository's address into a why; the guarantee in 2.4 rests on a scan and a refusal.
- **`downloads.go` serves only Jira's two file names** from one folder; the app's export needs it generalised, carefully.
- **Join changes the destination's own slices**: incoming principles make every existing slice "answered under older principles" until reviewed, and `slice ready` waits for the principles to be published.

## As built

Pieces A to E are built; piece F is not. Where the code differs from the sections above, the code is right.

- **No export button and no upload in the app.** Piece F is not built: there is no `project.export` operation, `downloads.go` still serves only the Jira export, and the app shows no "Download this project". Export and import are done through `/mach-studio` only (`skills/studio/SKILL.md`, "Moving the project to another repository"). A half-finished import still shows in the app's "not saved" rows, because that row comes from `saved_state`.
- **The interview's command filter (8.1) needed no change.** `apps/studio/internal/interview/command.go` already denies the whole `project` group in the slice, Shape and needs conversations (`deniedOps`, `deniedIdeaOps`, `deniedNeedsOps`, as `Bash(project *)`), so `project export`, `project import` and `project imports` are denied there with no new line.
- **The archive (A).** Besides the limits of 2.3, a member's name is at most 255 characters, and names are compared for the case clash after Unicode normalisation and case folding (NFD, casefold, NFC), not only by case. `ArchiveError` carries the sentence; `studio.py` adds "Nothing was changed." when it prints one.
- **The rewriter (B).** The token boundary is wider than 5.2's: a token is not preceded by any word character (a letter or digit of any script, or `_`) or `-`, and not followed by any word character, not only a digit. So `SLICE-001x` and `SLICE-001é` are not tokens. `rewrite_record_noted` is added beside `rewrite_record`, returning the notes of a record's text and ID fields.
- **Export (C).** The repository is read from `git config --get remote.origin.url` (local), not `git remote get-url origin`; any host's URL or scp form gives its `owner/repo`. A text naming a folder on this computer and a resume note are refused with sentences of their own ("SLICE-004's resume note names ... Save the note again without it"). The refusal about slices only on GitHub says, in the app, "Open each here first, or export without them." with no command. The default export folder is refused when it is a symbolic link, like `--out`.
- **The commands (E).** `studio.py project export [--out] [--only-mine]`, `project import <archive> [--plan]` and `project imports [<ID>]`. `Studio.next_id` (slices and epics) and `next_principle_id` skip `project_import.reserved_numbers`; `saved_state` adds `import_unfinished`: "Bringing in the project from <file> stopped part way. Run it again with the same file to finish." (in the app: "... Bring the same file in again to finish."). `project_import` is imported inside the functions that use it.
