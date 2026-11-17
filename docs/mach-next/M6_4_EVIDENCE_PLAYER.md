# M6.4: The evidence player

Status: design, 2026-11-16. Step 4 of `docs/mach-github-issues-integration-spec.md`. Earlier documents
call this the Evidence Theater; the product name is **evidence player**.

## 1. Purpose

A person looking at a ticket in the Factory Floor can see what the verifier captured for each scenario
and rule: screenshots, recordings and transcripts, beside the check they prove. Today the Floor lists
artifacts and says their content is not opened here.

It reads only. It adds no way to change, approve, start or delete anything.

## 2. What exists and is kept

The observer already does the guarded work (`apps/observer/internal/artifact`, `internal/server/artifacts.go`):

- A catalog of artifacts per ticket, live or archived, with integrity against the recorded hash.
- `GET /api/v1/cells/{ticket}/evidence`: checks, each with its evidence files, result, round and visit.
- `GET /api/v1/artifacts/{id}/content`: text scrubbed and capped; images and video only when
  `floor.evidence_media` is true; Range requests; a sandboxing policy on the response; refusals with
  a reason code.

None of that changes shape. The player is a reader of these routes.

## 3. The gap this fills

| Gap | Where |
|---|---|
| No client call for a cell's evidence; the artifact reader drops `targets`, `access_reason`, `origin` | `web/apps/factory-floor/src/live/observer.ts` |
| Content is fetched as text only, and nothing calls it | same |
| The Floor never reads whether media is enabled | same (`capabilities.evidence_media`, `settings`) |
| No image, video or text viewer; no stepping | new, `src/evidence/` |
| The page's policy has no `media-src`, so a same-origin video is blocked | `apps/observer/internal/security/headers.go` |
| A check from an earlier verification run is matched to the current file of the same name and shown as a mismatch | `internal/server/artifacts.go` / `internal/artifact` |
| `.http` request and response dumps, which the verify station accepts for APIs, are refused | `internal/artifact/sniff.go` |
| The simulation has evidence names but no content | `src/sim` |

## 4. The player

### 4.1 Opening it

From a cell's inspector ("Evidence"), from a check in a verification gate's "What it checked", and from
an evidence reference in the Timeline's inspector. It opens as a panel over the workspace, for one
ticket, with the address carrying only the ticket ID and the check ID (never a path or prose).

### 4.2 Layout

- **Checks**, grouped by verification run (the round and its visit), newest first: each check's ID, its
  kind (scenario, matrix rule, holdout), its result as a glyph and a word, and how many files it has.
  A filter for failed checks.
- **Files** of the selected check: name, type, size, and its state (ready, withheld and why, missing,
  changed since it was recorded).
- **The viewer**, by class:
  - Image: shown to fit, with actual size on request.
  - Video: the browser's own controls. Never autoplays.
  - Text (transcripts, logs, JSON and HTTP dumps, terminal casts): monospaced, as plain text, with the
    line count, and a notice when the observer cut it short.
- **Stepping**: previous and next file, previous and next check, by button and by key.
- **Facts beside the viewer**: what the file proves (the check IDs), the commit, the round, whether its
  hash matches what the verifier recorded, live or archived, and the label for free text.

### 4.3 Rules it follows

1. **Content loads only on a person's action.** Selecting a file is that action. Nothing is loaded ahead,
   in bulk, or cached; moving on releases what was shown.
2. **By catalog ID only**, through the content route. Images and video are elements whose source is that
   route; text is fetched and put into text nodes.
3. **Text is never rendered as markup.** No Markdown, no HTML, no links made from content.
4. **Nothing is offered that the catalog withholds.** Each reason has plain words: media is off in this
   project's settings (with the setting's name), the type is not served, the file is too large, it
   changed after it was recorded, its name looks like a credential, it is a link.
5. **Integrity is always visible.** A file that does not match its recorded hash says so above the
   viewer and is never shown as proof.
6. **Free text is labelled** "Free text, not checked for names", and file names and paths stay out of the
   address, the page title, storage and accessible names; accessible names use IDs and types.
7. **Read only.** No download-all, no search inside content, no annotation, no sharing.

### 4.4 When media is off

The checks and file facts are shown; text opens; images and video show what they are and that
`floor.evidence_media` is off, and are not requested.

### 4.5 Simulation, replay and history

- Simulation: built-in sample content, drawn or written by the app itself and labelled as the
  simulation's, so the player can be seen without a Factory. A simulated recording says there is no
  recording in a simulation.
- Historical replay: checks and files recorded after the playhead are not shown, as everywhere else,
  unless "Show what happened after this moment" is on.
- Archived cells work as live ones do, and say they are read from the archive.

## 5. Observer changes

- The page's policy gains `media-src 'self'`; nothing else in it changes.
- `.http` joins the text class.
- A check from an earlier verification run is matched to its own run's file (`evidence/previous-N/…`),
  not to the current file of the same name.
- No new route, no write, nothing but `127.0.0.1`.

Known and left: seeking in a long recording rereads the file, and a busy observer may answer "try again";
the player retries once and then says so. `.mov` files and trace archives are listed with their facts and
not served.

## 6. Accessibility

Keyboard reachable throughout; focus moves into the panel and returns on close; results are words as well
as glyphs and colours; no motion beyond the person's own playback; sans-serif and monospaced type only.

## 7. Not in this step

Playing terminal casts as animation, a trace viewer, comparing two runs side by side, and evidence in
Product Studio.

## 8. Testing

Observer: the policy header, `.http`, the earlier-run matching, and every existing artifact test
unchanged. Floor: the player's model (grouping, states, stepping, what is requested and when), the
free-text containment scan extended to `src/evidence`, and the browser suite opening the player on a
synthetic history. No screenshots or recordings are taken without the product owner's say.
