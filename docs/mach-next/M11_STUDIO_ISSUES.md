# M11 step 2, as built: Product Studio saves a ready slice as a GitHub issue

This note covers sections 2 and 3 of `M11_DESIGN.md` and the decisions in its section 10. It lists
what was built, what was decided where the design left a choice, and what is left for later steps.

## Commands

| Command | What it does |
|---|---|
| `slice ready <SLICE-ID>` | Runs the approval gates, approves the slice, and hands it over: a GitHub issue under its epic's issue, or the ready folder. This replaces `slice approve`, `wave approve` and `send`. |
| `slice reopen <SLICE-ID>` | Takes `mach:ready` off the issue (or removes the folder) first, then makes the draft editable. If GitHub cannot be reached, it refuses and changes nothing. |
| `refresh` | Reads the project, epic and slice issues (and the requests). `refreshed` and `problem` are the GitHub read's; the `github` block has each slice, the project's and epics' issues and their addresses. A read that fails is kept until one succeeds (`status.saved`). |
| `reconcile <SLICE-ID> --take mine\|theirs` | For a slice someone else saved a newer version of on GitHub. |
| `slice renumber <SLICE-ID>` | Unchanged. It now refuses a slice that has been marked ready, and skips the slice IDs GitHub holds. |

`slice ready` and `slice reopen` run only on the product manager's word.

## Code

- `skills/product-studio/scripts/issues.py` holds every gh call for the product model. Each is a fixed argument list, and all text goes through `--body-file`.
- `skills/product-studio/scripts/handoff.py` decides where a slice goes and keeps the record in `.factory/studio/issues.json`. That record holds:
  - the repository and the sub-issue form;
  - the project and epic issue numbers;
  - per slice: its issue number and id, revision, base revision, both hashes, where it was saved, shipped issues, and the run in progress, step by step.

  It also runs the steps, writes the folder, takes a slice back, and reads GitHub for `refresh`.
- `skills/ticket/scripts/issue_rules.py` gains the pure product-issue rules the Factory will reuse in step 3:
  - `PRODUCT_LABELS`, `SLICE_STATE_LABELS`, `epic_task_label` and `ISSUE_BODY_LIMIT`;
  - `slice_marker`, `slice_issue_body` and `parse_slice_body` (the marker, plus the why and spec checked against it);
  - `approval_comment` and `approvals`;
  - `project_issue_body`, `epic_issue_body` and `product_marker`;
  - the request comment moment `ready`.

## The steps of `slice ready` on GitHub

Each step is recorded as `trying` before it runs. Each one looks before it writes:

1. **labels**: create the missing ones (`mach:project`, `mach:epic`, `mach:slice`, `mach:ready`).
2. **project**: find the issue by its marker or create it, pin it on creation, and bring its title and body up to date.
3. **epic**: find the issue by marker and title or create it, and bring it up to date. The sub-issue form is chosen here, once per repository.
4. **slice**: create the issue, or replace its title and body whole. After an interruption it adopts the issue it made, matched by revision and both hashes.
5. **approval**: post the comment unless one by the same account, for the same revision and hashes, is already there.
6. **link**: add the sub-issue (`replace_parent`) and place it in order. In the task-list form, add the `mach:epic-<n>` label and rewrite the epic's task list.
7. **ready**: add `mach:ready`, the last write.

The tests interrupt each step two ways, by failing before the write and by losing the answer after it, then run again and show exactly one of everything.

## Decisions where the design left a choice

1. **Order within an epic.** The "product manager's order" is slice ID order. A new sub-issue goes right after the nearest earlier slice the workspace knows, or right before the first later one, and other sub-issues keep their place. There is no separate reorder command.
2. **Revision.** A slice's revision counts its approved versions, starting at 1. It is not the work order's own `revision` field. Marking ready again with the same text keeps the revision; changed text gets the base revision plus 1.
3. **Base revision.** This is the revision the draft last saved or took. It lives in the record, not the work order (the work-order schema is unchanged). A slice issue whose marker revision is higher is `newer_elsewhere`, unless it is this workspace's own unfinished run.
4. **Shipped, then changed.** The new issue's body has one fixed line after the marker: `Changes #N, which has shipped.` `parse_slice_body` reads it as `follows`. The marker itself is exactly the design's.
5. **No dependencies** are written as `depends=none`.
6. **Approval comment.** Fixed text naming the slice, the revision and the approver's login (no `@`, so nobody is notified), the two hashes, and a hidden marker `<!-- mach:approval id=… revision=… by=… spec-sha256=… why-sha256=… -->`.
7. **Project and epic issues.** Their bodies come from fixed templates filled with the product manager's own vision, outcomes and acceptance criteria, each with a hidden `mach:project`/`mach:epic` marker. An existing epic issue is adopted only when its ID and title match. A different epic under the same ID is refused, with renumbering as the way on. A repository whose project issue names a different project is refused. Linked project and epic issues are rewritten from the local draft on every `slice ready` (last writer wins).
8. **Pinning** happens once, when the project issue is created. A failed pin is recorded and stops nothing, since a repository holds only a few pinned issues.
9. **GitHub or folder.** The folder is used when gh is not installed, when the PM is not signed in (auth failure from `gh repo view` or `gh api user`), or when `origin` is not on GitHub. A passing failure such as no network refuses and writes nothing. A slice already saved on GitHub never goes to the folder.
10. **The folder** is `product/ready/SLICE-NNN/` in the draft workspace. `slice.json` holds `schema_version`, `slice_id`, `title`, `revision`, `epic` (`epic_id`, `title`), `dependencies` (slice IDs) and both hashes. The folder is written to a temporary folder first and then renamed. Reopening removes it.
11. **Size.** The limit is 65,536 characters, counted in characters, for the whole body including the marker. It applies to the folder too. In folder mode the limit is checked with the largest possible numbers, before anything is written.
12. **Taking theirs.** Only a version whose body is intact and carries an approval for that revision and those hashes can be taken. The text is written verbatim (it is hash-checked, not redacted), and the slice returns to `ready_for_approval`, or `interviewing` if it no longer passes.
13. **Requests.** When a slice made from a request is marked ready, the request gets one comment from the new `ready` template: `SLICE-NNN, made from this request, is ready to be built: #n.` It goes through the existing outbox, and repeats are skipped by marker. `request met` now needs a slice that is marked ready (approved), as before.
14. **Taking another product manager's slice into a workspace** without a local draft is not built. `refresh` lists every slice issue, and `reconcile` works for slices already linked.
15. **Acceptance.** `acceptance record <EPIC-ID>` posts the decision on the epic's issue (`M11_FACTORY_INTAKE.md`). It stays a terminal command; the visual app's host does not offer it.

## Removed in step 3

The wave, send, feedback and `slice approve` commands, the three-way sync of product files and the request status labels were removed with the Factory's step 3; `M11_FACTORY_INTAKE.md` lists them.

## Step 5: what the screens show, and what the engine reports for them

The engine decides every figure and word; the app shows them.

| Report | Where | What |
|---|---|---|
| The builders' question | `slices[].github.question`, `question_note`, `times.question` (status, `slice show`, refresh rows) | The Factory's question comment on the slice's issue, redacted and bounded there. `slice resume` adds `builders_question` (`issue`, `url`, `fenced`, `sha256`, `note`): the question fenced as `<<<QUESTION-DATA …>>>` (`issue_rules.question_fence`), for the interviewer to settle first. |
| Where a slice is | `slices[].github.progress` | `draft`, `interviewing`, `ready_for_approval`, `approved` (saving not finished), `ready_to_build` (saved on GitHub or to the folder), `being_built`, `question`, `shipped`, `superseded`. |
| Counts per epic | `epics[].counts` | `total` (not superseded), `by_progress`, `ready_or_further` and `ready_or_further_means` ("marked ready to build, being built, or shipped"). |
| When | `slices[].github.times` | `marked_ready` (the approval comment for this version and these hashes), `building`, `question`, `shipped` (the latest MACH status comment of that moment), as GitHub dated the comments at the last refresh; set to now for `marked_ready` right after `slice ready`. Unknown stays `null`. |
| Everything saved | `status.saved` | `everything_saved`, `note`, and `not_saved[]` (`kind`, `target`, `text`): `unfinished` (a save to GitHub that stopped part way), `changed_since_ready` (a reopened slice whose spec or why no longer matches what was saved for the builders), `refresh_failed` (the last read of GitHub did not finish; cleared by one that does), `request_updates` (updates to requests not yet made). |

The visual app's host opens an interview with a fixed sentence when `slice show` reports a builders' question (`interview.AnswerQuestionNote`), once per question (`settled_question` in the interview record); the question's text reaches the interviewer only through `slice resume`. "Answer it" in the app reopens an approved slice, confirmed in a dialog, then starts that interview.

## GitHub shapes relied on

| Shape | Confirmed? |
|---|---|
| `POST /repos/{o}/{r}/issues/{n}/sub_issues` with `sub_issue_id` (the issue's numeric `id`, not its number) and `replace_parent`; `GET …/sub_issues` paginated; `PATCH …/sub_issues/priority` with `sub_issue_id` and `after_id` or `before_id` | Confirmed against docs.github.com (REST, sub-issues) |
| `gh issue pin <n> --repo` | Confirmed (cli.github.com) |
| `gh issue create --title --body-file --label`, `gh issue edit --body-file --add-label --remove-label` | Confirmed. That `create` prints the new issue's URL is shown in the manual's examples but not stated as a rule. |
| Get-an-issue includes `id`, `number`, `body`, `labels`, `state`, `user.login`; comments include `user.login` and `author_association` | Confirmed |
| Issue body limit of 65,536 characters | **Not confirmed** in GitHub's documentation; widely observed |
| The error a repository without sub-issues returns | **Not confirmed**. `issues.unavailable` treats 404, 410 and refusals naming sub-issues as "not available", and anything else as passing. |
| An existing parent without `replace_parent` | Not documented; `replace_parent=true` is always sent |
| Maximum sub-issues per parent; maximum pinned issues | **Not confirmed** |
| `gh api user` returns the signed-in account's `login` | Not stated on the `gh api` page; it is the REST "get the authenticated user" endpoint |
| `gh issue view --json comments` gives `author.login` and `body` | Not checked against the manual; the M8 request code already relies on `body` |
| `gh issue view --json comments` gives each comment's `createdAt` (ISO 8601, UTC) | **Not confirmed** against the manual; the times in `slices[].github.times` rely on it, and a comment without it gives no time |
