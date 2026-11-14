# M6.5 security: observer privacy and artifact redaction

Status: review done on `feature/mach-next-m6-5-factory-analytics` (baseline `b37c036`), fixes in the observer with
tests. Scope: the observer's HTTP surface as it stands (`apps/observer/internal/security`, `server`, `artifact`,
`redact`), the open privacy items of the M6.2 acceptance (`M6_2_ACCEPTANCE.md`, `M6_2_COMPLETION.md` section 9), and
what an analytics drill-down may show. Nothing here changes the Factory, a station, a gate or the observer's
read-only rules.

## 1. Method

- Read the security model (`M6_1_OBSERVER_DESIGN.md` sections 13 to 15), the README's API, artifact and People
  sections, and the code of the four packages above.
- Built the observer (`go build ./cmd/mach-observer`, placeholder UI, into a scratch folder; `build.sh` was not used
  because it swaps the shared `internal/webui/dist`) and ran it on a synthetic project from `mach-synth` (12 cells),
  into which invented adversarial data was planted: a vote whose finding title names an invented person and carries
  markup, a `findings.md` with that name and an e-mail, a `decision.json` approval naming a second invented person,
  a `results.json` with a verifier note naming the first person and evidence files named `sk-ant-api03-….txt`,
  `zelda-quinnfarrow-login.txt` and `credentials.txt`. Every route was requested with the session cookie, and the
  request checks were probed without it.
- Each fix has a Go test that fails on the baseline and passes after (section 4).

## 2. M6.2 items

| Item | Status | Evidence |
|---|---|---|
| D2 (approver's name in served `decision.json`) | Fixed in M6.2, still fixed | Planted approval: served `"by": "a person", "recorded_by": "a person"`; the same name in `findings.md` became "a person" (`X-MACH-Redacted: 2`) |
| R2 (agent's act credited to a person) | Fixed in M6.2, still fixed | `server.TestFreeTextArtifactsAreLabelled` keeps "an agent, on the person's instruction in conversation" |
| D25 (relative names over-scrubbed) | Fixed in M6.2, still fixed | Served `decision.json` keeps `"findings": "review/round-1/findings.md"` |
| **R1** (a name only in prose is served) | **Open by the product owner's decision ("label, do not withhold"), and wider than recorded.** Artifact content is labelled as before. M6.2 found it in artifact content only; it is also in event fields (S3 below). Those are now declared and documented; they are still served as written | Section 3, S3 |

## 3. Findings

| # | Severity | Finding | Evidence | Fix | Status |
|---|---|---|---|---|---|
| S1 | Medium | An evidence file whose **name** is a credential was catalogued. Its name was served in `path_rel`, `logical`, `ref`, `Content-Disposition`; and because the catalog's names are protected from the scrubber (D25's safe names), the same token was served **unredacted inside `results.json`**, which scrubs it otherwise. The design (section 13) says catalog paths pass `redact.RelPath`; the code used only `plainRel` | `GET /api/v1/artifacts?ticket=SYN-003` → `"path_rel": "evidence/sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV.txt"`; `GET …/a7e47c9c4e6ff38c65f947e61/content` → `"file": "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV.txt"`, `X-MACH-Redacted: 0` | `redact.SecretName` (credential patterns and e-mail, not the long-run rule, which ordinary long paths trip); `artifact.plan` never catalogues such a name, so it is not a safe name either. After: catalog 0 hits, `results.json` serves `"file": "[redacted].txt"` | Fixed |
| S2 | Low–Medium | A file whose name says it holds credentials (`credentials.txt`, `id_rsa`, `secrets.json`) was served as text. The scrubber only catches credentials of a known shape (`password=x`, not `password x`). The design says such names are shown by class only | `credentials.txt` served `user=admin` (200) | Catalogued as metadata only: `content_access: "none"`, `access_reason` says why; `Read` refuses it (`ErrCredentialName`) whatever the entry says; the route answers 403 `credential-name` | Fixed. Trade-off: a harmless name with such a word (`AC-03-token-refresh.txt`) is refused too (lead decision 2) |
| S3 | High (R1) | **Prose in event fields is served as written and was not labelled.** A finding's title (model-written, 200 characters), agents' labels and phases, phase titles, intake problems, blocked reasons, human-required and pause reasons, scheduler holds, authorization and supersede notes, `waiting_for`. A name only in that prose reaches `/events`, `/history`, `/stream`, `/snapshot`, `/cells/{t}`, `/cells/{t}/visits/{v}`, and, for `phase`, analytics group keys. M6.2's re-check planted names in documents only, so it reported 0 in events | Planted vote title: `"title":"Zelda Quinnfarrow asked for this shortcut; it s…"` in 5 replies (`events`, `history`, `snapshot`, `cells/SYN-003`, `cells/SYN-003/visits/review#1`); the planted file name in `cells/SYN-003/evidence` and `artifacts` | Not withheld (the product owner's decision stands). Declared: `redact.FreeTextFields` (15 fields), served as `session.display_policy.free_text.event_fields` with `checked_for_names: false`; tests hold the list to the allowlist and to every prose call site in the normalisers, so a new prose field cannot be added silently. README corrected | Open by decision; contained by declaration. The Control Tower must use it (lead decision 3) |
| S4 | Medium (claim) | The README said the observer never forwards "a person's name" and that "people's names are never sent to the browser" | `README.md` "What it never does" and "People" | Rewritten: guaranteed for names a record or git identity gives; not for names only in free text; a list of what redaction does not cover | Fixed |
| S5 | Low | Served text was cut at 256 KiB by byte, which could split a UTF-8 character | Test body with `é` across the cut: `valid=false` | Cut on a character boundary | Fixed |
| S6 | Info | Prose can hold markup (`<img src=x onerror=…>` in a finding title). The observer serves it as a JSON string, which is correct; it is safe only because the app renders text. `grep` of `web/apps` and `web/packages` source: no `dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`, `document.write` or `new Function` | Planted title served verbatim in JSON | None needed in the observer; containment rule C2 below | Holds today |
| S7 | Info | A known name written another way is not replaced (hyphenated in a file name, initials, a nickname, split across lines) | `zelda-quinnfarrow-login.txt` stays in `path_rel` when "Zelda Quinnfarrow" is known | Documented (README "Also not covered") | Accepted limit |
| S8 | Info | HTTP surface checks hold | No cookie 401; forged cookie 401; reused link 401; `POST`/`HEAD` 405; `Host: evil.test` 403; `Origin: http://evil.test` 403; `Origin: null` 403; `Sec-Fetch-Site: same-site` and `cross-site` 403; `..%2f`, a path as id, `//`, `/../`, `%2e%2e` 400; unknown id 404; every reply carries the CSP, `nosniff`, `X-Frame-Options: DENY`, `no-store` on the API; content adds `sandbox` CSP and `text/plain`; the listener refuses everything but `127.0.0.1` (existing tests). Link exchange drops the token by redirect; the access log never prints the query | None | Holds |
| S9 | Info | Residual risks already accepted in M6.1/M6.2: a loopback cookie is reachable by other processes of the same user; a port re-taken by another local process receives a page's cookie; screenshots and recordings are never examined (off by default) | Design section 15 | None | Accepted, unchanged |

Not reviewed: the Python Factory (not changed), the web app's rendering beyond the sink search in S6, and the
analytics, spans, history, series, concurrency and metrics handlers' logic (another agent's files; only their output
was searched for free text).

## 4. Tests added (each fails on the baseline, passes after)

| Test | Holds |
|---|---|
| `artifact.TestCredentialShapedNamesAreNeverCatalogued` | S1: no credential-shaped name in the catalog, the safe names or the served `results.json` |
| `artifact.TestCredentialNamedFilesAreMetadataOnly` | S2: listed, `content_access: "none"`, `Read` refuses |
| `artifact.TestTruncationKeepsWholeCharacters` | S5 |
| `server.TestCredentialNamesThroughTheAPI` | S1 and S2 over HTTP: catalog, evidence route and content; 403 `credential-name` |
| `server.TestSessionDeclaresFreeTextFields` | S3: the session declares the fields, a finding's title among them (fails to build on the baseline) |
| `redact.TestFreeTextFieldsExistInTheAllowlist`, `redact.TestEveryProseCallSiteIsDeclared` | S3: the list names real allowlist fields; the 13 prose call sites in `internal/normalize` match the 15 declared fields (a new one fails the test) |
| `redact.TestSecretName` | S1's filter, including that long ordinary names pass |

`redact.Version` is unchanged: stored events are not affected.

## 5. What redaction does not cover

Stated in `apps/observer/README.md` ("People"). In short: names, handles and descriptions of people that appear only
in prose and in no MACH record or git identity; known names written another way; secrets that do not have a known
shape; anything in images or video; what was served before a record named the person. No claim is made that free
text is free of personal names or sensitive prose. Free text is labelled, not withheld.

## 6. Analytics drill-downs: what may be shown

The observer's routes are the only data source; every field below is already served to an authenticated session.
The question is how a drill-down may present it.

**A. Show without further review** (validated identifiers, enumerations, numbers, times, hashes):

- Identifiers: wave, slice, ticket, execution, runner, visit, cell instance, seat, station, agent and tool-call ids
  (`redact.ID`); rule ids (`FR-`, `INV-`, `AC-`, `R` patterns).
- Enumerations and short labels: stage, outcome, verdict, vote, decision, risk, app type, severity, gate, reason code,
  how, status, stop and terminal reason, `by_role`, tool name, model, writer, authority, basis, integrity,
  `content_access`, `nature`, `kind`.
- Numbers and times: counts, durations, rounds, attempts, recorded cost (with its completeness), token totals,
  timestamps and their bounds; metric values with their sample, coverage, window and source.
- Hashes and commits.
- The observer's own catalog strings: metric `name`, `numerator`, `denominator`, `limitations`, `null_reason`,
  `coverage.reason`, `rules`, `access_reason`, `free_text_note`.

**B. Contain** (show as data, never as markup; truncated; labelled; never in a URL, the document title, a
notification or an export without the label):

- Every field in `session.display_policy.free_text.event_fields` and its copies in the projection: a cell's and a
  visit's finding `title`; an agent's `label` and `phase`; an execution's phase `title`s; `waiting_for`; the
  factory's `paused_reason`; a scheduler hold's and a capacity wait's `why`; blocked `reasons`; intake `problems`;
  `authorization`; `effect`; a human-required `reason`.
- Analytics group keys from `group_by=phase` (phase titles).
- Artifact catalog `path_rel`, `logical` and `ref` (a file name can hold a name in another form, S7).

Rules: C1 render through text nodes only (React children, `textContent`), never `dangerouslySetInnerHTML`, markdown
rendering or `title`/`aria-label` built from untruncated prose; C2 truncate to the field's `max` or less, with the full
text only on explicit expansion; C3 say "free text, not checked for names" (`free_text.note`) next to it, once per
panel is enough; C4 never put it in a deep link, query string, `document.title`, `localStorage` or a copied link; C5
an aggregate never uses prose as a series name or axis label except `phase`, which is truncated and labelled; C6
where a surface cannot carry the label (a CSV export, a chart tooltip that cannot hold it, a screenshot for sharing),
show the count of findings or reasons, not their text. If a drill-down cannot meet C1 to C6, it shows counts only
(fail closed).

**C. Stay behind the guarded endpoints** (open only on a person's explicit action, by catalog id, through
`/api/v1/artifacts/{id}/content`, with its headers):

- Every artifact's content: `findings.md`, `results.json`, `summary.json`, `decision.json`, evidence text, images
  and video (media only with the project's `tower.evidence_media` opt-in).
- A drill-down may list artifacts (metadata, group B rules for names) and link to their content. It must not fetch
  content in bulk, search, aggregate or summarise it, cache it, or show it inline in an analytics view; it shows
  `free_text` and `content_access` as given and never offers content the catalog marks `none` or `media-disabled`.

**D. Not available, and must not be added for analytics:** tool inputs and outputs, prompts, transcripts, stream
text, environment values, `repo/`, `.factory/local/`. Any new observer field that keeps prose must be added to
`redact.FreeTextFields` (the test fails otherwise) and to group B here.

**M6.6 (I-05): the inspectors apply B.** The containment is shared: `src/text/` holds the one `UncheckedText`
component and its module, `src/text/fields.ts` the observer's field list (`KNOWN_FREE_TEXT_FIELDS`, held equal to
`redact.FreeTextFields` by a test), and `src/shell/displayPolicy.ts` reads `/session`'s policy for the floor and the
Timeline (a declared policy may add fields or lower a limit, never lift containment; undeclared fails closed). The
floor and Timeline inspectors print every B field through `shell/inspector/FreeText.tsx`: finding titles, agent
labels (including the header naming an agent) and phases, declared phase titles, blocked reasons, a person-needed
reason, a hold's `why`, `waiting_for`, a wait's reasons in "In time", and event sentences that quote any of these
(evidence list, "Why it looks like this", the run at the playhead); the evidence list's raw key fields skip them.
The same holds on the floor and the Timeline: Blueprint and Atlas draw those copies (finding titles, agent labels
and phases, `waiting_for`, blocked reasons) as bounded plain text through `containedWords` (`text/fields.ts`, the
same `uncheckedView`, limited by the session's policy, which the shell hands to drawing code once `/session`
answers), with one "free text, not checked for names" label on the floor; the Theater caption is contained and
labelled. Accessible names, `title`s, hover cards, Timeline track names and the announcer say codes and counts only
(an event that carries prose is named by its kind, `codesOnlyWords`; a wait says how many reasons it recorded).
`test/free-text-containment.test.mjs` scans `src/blueprint`, `src/atlas`, `src/shell` and `src/timeline` and fails
if such a field is printed another way or used in a name. Left open at the time of writing: the Timeline canvas's
own span labels and the track label column's `title` (`timeline/render`, owned by another agent). The UI decides
which scene value copies which declared field (a table in `text/fields.ts`); the limits are the session's. The
artifact section says it shows recorded facts and that opening content waits for the Evidence Theater (I-45); no
content is read.

## 7. Decisions for the lead

1. **R1 stays "label, do not withhold"?** S3 shows the prose is in events too, not only in documents. The
   alternatives are to withhold event prose (finding titles would become counts and rule ids only) or to keep it and
   rely on containment. This review kept the product owner's decision and made the label complete.
2. **Credential-named files' content refused** (S2) also refuses an ordinary file whose name contains `token`,
   `secret`, `passw`, `apikey`, `private_key` or `credential`. Keep (fail closed), or narrow the pattern for content
   only.
3. **The Control Tower should read `display_policy.free_text`** and apply section 6 B. Done in M6.6 for Analytics
   the floor and the Timeline (section 6, "M6.6 (I-05)"); the Timeline canvas's span labels remain open.

## 8. M6.6 review

Scope: the whole local boundary of the observer and the Control Tower, by reading the code and by attacking a running
observer (built with the app embedded) on synthetic projects with planted canaries and adversarial inputs: a 655-request
probe of Host, Origin, fetch-site, methods, override headers and path tricks; every route's body and the event stream
searched for canaries; 34,191 fuzzed query requests; a headless browser over 64 views; file listings before and after.
Raw data stayed in scratch.

**Attacked and held.** One-time link (reuse, guessed and missing cookies: 401 on every API route, the stream and
content; cookie `HttpOnly`, `SameSite=Strict`); Host and DNS rebinding (403 on every route); cross-site `Origin` and
`Sec-Fetch-Site` (403); every method but GET (405, override headers ignored, no CORS header anywhere); loopback-only
bind (no flag or environment changes it); path traversal in every encoding (400/404); artifact names with `..`,
absolute paths, backslashes, RTL, markup, newlines or credential shapes (never catalogued); symlinks, hard links, FIFOs,
oversized files, HTML and SVG, and archive members with `..`, absolute names, links and devices (refused); content
headers (`text/plain`, `nosniff`, sandbox CSP, `no-store`); the media opt-in; prompts, thinking, assistant text, tool
inputs and results, environment, working directory, secrets and absolute paths planted in every source (none served,
streamed, indexed or logged); malformed, huge, nested and invalid-UTF-8 lines (gaps, no crash, no 5xx); analytics reads
no file; the app makes GET requests to its own origin only and puts no prose in the address, the title or storage; the
observer wrote nothing outside its folder. Media in the page: no component shows evidence media yet, so the app's CSP
keeps no `media-src` (add `media-src 'self'` with the first viewer).

**Fixed (each with a test that fails before and passes after).**

| # | Finding | Fix | Test |
|---|---|---|---|
| F1 | One stream record dated 9999 placed its source in year 9999; the Timeline then made 32,863 to 56,934 requests in 20 s and the tab crashed | A time before 2000 or more than a day after its line was read is no own time (stream and intake: placed without one, `unknown`; lifecycle: an `unparsable-line` gap). `redact.Version` 6, so an index holding such times is rebuilt. The Timeline loader's own cap is the web owner's | `normalize.TestImplausibleTimestampsHaveNoOwnTime` |
| F2 | `.factory/local/observer/index` as a link made the observer replace `meta.json` and `checkpoints.json` and write its index elsewhere | The index folder is refused when it is a link; its files are opened with `O_NOFOLLOW` | `TestIndexFolderLinkIsRefused`, `store.TestOpenRefusesALinkedFolder` |
| F4 | The access log wrote the request path raw: CR, LF and ESC from any sender forged lines and drove the terminal | The escaped path, cut to 200 bytes and quoted | `server.TestAccessLogQuotesThePath` |
| F5 | An e-mail `data@…` was learned as the name `data`, and the reply filter renamed the `data` key of every reply | Words the replies are made of are never learned; a JSON key is never rewritten | `server.TestLearnedNameNeverRewritesKeys` |
| F6 | Copies of declared prose in other replies were not declared; `execution.completed.refused_tools[]` (kept through `redact.Scrub`) was not declared | `display_policy.free_text.projection_fields` (42 places, found by filling every declared field with a marker); `refused_tools[]` declared; the call-site tripwire counts `redact.Scrub` | `server.TestSessionDeclaresProjectionFreeText`, `redact.TestEveryProseCallSiteIsDeclared` |
| F7 | Refusals before routing were cacheable; a 70 MB file said "not there to read", a duplicated archive member "changed"; `mach-synth --cells 4` to `7` panicked | `no-store` on 403/405; `too-large` (413) and `duplicate` (409) reasons; small synthetic worlds generate | `server.TestRefusalsAreNotCached`, `artifact.TestOversizedAndDuplicateMembersSayWhy`, `synth.TestSmallWorldsGenerate` |

F3 (prose shown without the "not checked for names" label, and copied whole into SVG tooltips and accessible names)
is in the web app, section 6.

**R1 residual risk.** What can still be served: a name or description of a person that appears only in prose, and in
no MACH record or git identity, is served as written in the declared event fields and their projection copies, in
artifact content (findings, verification notes, evidence text, archived copies), in artifact and tool file names, and
in the project folder name. E-mail addresses, credentials of a known shape and absolute paths are replaced; a name a
record or git identity gives becomes "a person". Redaction is not comprehensive, and this review does not claim it is.

- *A single engineer on their own laptop:* low. Everything served is already in files the engineer can read; the
  observer adds no reader (loopback, a `SameSite=Strict` `HttpOnly` cookie, Host and Origin checks). The index under
  `.factory/local/observer/` (git-ignored, `0700`) holds the same prose.
- *A shared or screen-shared environment:* moderate. A screen share, recording or screenshot shows prose that may name
  or describe people, and until F3 lands there is no label saying it was not checked, while tooltips and screen readers
  repeat it whole. Another process of the same account can read the link file and the index. Nothing is exported,
  copied into a link or stored in the browser.

Two remediation options (not implemented):

1. *Contain fully, keep the decision.* Render every declared field and copy through one labelled component, keep prose
   out of accessible names and tooltips, and add a "presenting" switch that shows counts and codes instead of prose.
   Cost: web only, some 10 to 15 components and one test; names stay visible, but labelled and suppressible.
2. *Withhold event prose by default.* The observer serves counts, rule ids and codes, and the prose only on an explicit
   request (like artifact content) or a project setting. Cost: allowlist and projection changes, another
   `redact.Version` (an index rebuild), inspector and Timeline text reworked around codes, the most useful explanatory
   text gone from the default view, and the product owner reversing "label, do not withhold".
