# M15: Control bands over the Factory's measures, and scheduled security scan intake (as built)

Two practices from the AI-native SDLC playbook, added to the observe and ticket stations.

1. **Control bands.** A deterministic script watches each of the Factory's own measures against a stable rolling baseline and responds in tiers (record; say; make an observe pass due). No model is involved in detection; the tiers live in tracked settings; a person's dismissal sets a breach aside.
2. **Security scan intake.** A scanner runs on a schedule outside the Factory. Its findings export is read as data, and each finding becomes one ticket that goes through the same gates as any change.

Neither starts an agent, a station or the supervisor.

---

## 1. Control bands: `observe.py bands` (`/mach bands`)

### What it measures

The six scorecard measures `observe.py collect` already reports, each turned into one value per finished ticket in `.factory/archive/runs.jsonl`, ordered by `closed_at` (ties keep file order, as `select` does):

| Measure | Value per ticket | Tickets counted | Better |
|---|---|---|---|
| `average_rounds` | judging rounds | merged, with a recorded number | lower |
| `first_pass_rate` | 1 if first pass, else 0 | merged | higher |
| `escalation_rate` | 1 if escalated | all | lower |
| `abandonment_rate` | 1 if abandoned | all | lower |
| `tests_failing_first_share` | failing / (failing + passing) | those with any recorded test task | higher |
| `deviations_per_ticket` | number of deviations | all | lower |

These are the scorecard's own definitions applied per ticket; `scorecard()` itself is unchanged, so the observer's parity test (`tests/test_mach_analytics_parity.py`) still holds (run and passing).

### The band

For a measure with `n` values:

- Fewer than `min_sample + 1` values: the answer is **"not enough finished tickets yet"**, never a band.
- Otherwise the **recent** segment is the last `min(recent, n - min_sample)` values; the **baseline** is up to `window` values immediately before it. The band is the baseline's mean and **sample** standard deviation (`statistics.stdev`). The baseline excludes the recent tickets so a shift does not drag its own reference with it; it is rolling because it moves forward as tickets finish.
- Defaults: `window` 30, `min_sample` 20, `recent` 8 (eight is what the run rule needs).
- With no spread in the baseline (standard deviation 0, for example no escalation in 30 tickets), any value off the mean is beyond every line. This is stated, not smoothed: one escalation after thirty clean tickets is a tier-2 signal by default.

### The rules

The four Western Electric zone rules, as the NIST/SEMATECH e-Handbook of Statistical Methods lists them in section 6.3.2, "What are Variables Control Charts?" (https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc32.htm), read from that page during this work, not from memory:

1. Any single point beyond 3 sigma.
2. 2 of the last 3 points beyond 2 sigma, on the same side.
3. 4 of the last 5 points beyond 1 sigma, on the same side.
4. 8 consecutive points on the same side of the centre line.

The handbook also lists two trend rules (6 in a row rising or falling, 14 alternating); they are **not** implemented. A rule is checked at each recent ticket over the window that ends there (which may reach back into baseline tickets), and fires only if that ticket is itself one of the points beyond the line, so the signal belongs to the ticket that completed the pattern. "Beyond k sigma" is strict (`> mean + k·sd`). A breach lasts while a firing remains in the recent segment; when the last firing ticket scrolls into the baseline, the measure is back inside.

Choice: standard deviation of the baseline values, as the brief asked, rather than the moving-range estimate (MR̄/1.128) NIST uses for individuals charts. Choice: the binary measures (first pass, escalation, abandonment) are charted as 0/1 values per ticket; the rules are less well behaved on such data than on continuous values (the zones are coarse), which is one reason a rule's tier is a setting.

### Tiers (tracked settings, `observe.bands` in `templates/config.json`)

```json
"bands": {
  "enabled": true, "window": 30, "min_sample": 20, "recent": 8,
  "measures": ["average_rounds", "first_pass_rate", "escalation_rate", "abandonment_rate", "tests_failing_first_share", "deviations_per_ticket"],
  "rules": { "1": 2, "2": 2, "3": 3, "4": 3 },
  "tiers": { "1": ["record"], "2": ["record", "say"], "3": ["record", "say", "observe-pass"] }
}
```

- `rules` maps each rule to the tier it raises for a shift in the **worse** direction: by default a spike (rules 1, 2) is tier 2 and a sustained shift (rules 3, 4) is tier 3. A shift in the better direction is always tier 1, recorded only. A rule left out is not applied.
- `tiers` gives each tier its actions, from a fixed set of three; nothing else can be named:
  - `record`: `observe.py bands` appends each new signal and breach once to `.factory/observations/bands-log.jsonl`.
  - `say`: one fixed line, `A Factory measure is outside its control band: <measures>. /mach bands shows the tickets behind it.`, in `run.py status` (`control_bands`) and in the observe report (metrics.json `bands.say`, which the observe skill quotes under "Analyzed data").
  - `observe-pass`: the existing "a pass is due" signal. `run.py`'s `Project.observe_status` (the one source for `/mach status`, the belt workflow and the supervisor) now adds `due: true, because: "control-band", bands_due: [...]` when an undismissed breach's tier has this action and the ticket at which it reached that tier finished after the last observe pass (`last-pass.json` `runs_total`). So each breach makes at most one pass due; a breach that persists after the pass is still said but not due again.
- Invalid settings (unknown key, a value out of range, an unknown measure, rule or action) compute **no** band and say why (`problems`); nothing falls back silently to a weaker setting.
- `enabled: false` switches bands off.

Every figure carries its sample: per measure the number of tickets with a value, the baseline and recent counts and their ticket IDs; per signal the rule, the ticket and the tickets behind it; per breach the ticket it began at (`since`) and the one at which it reached its tier. Identifiers only. The output carries no time, so the same record gives the same answer (tested).

### Dismissal

`observe.py bands dismiss <measure> --reason "<why>" [--by <role>]` (`/mach bands dismiss`), only on a person's explicit word; refused inside a supervised execution (`MACH_EXECUTION_ID`). It records `{measure, since, tier, reason, by, at}` in `.factory/observations/bands-dismissed.json` and the breach shows as `outside, dismissed` with the dismissal. A dismissed breach is not said and makes no pass due. It is raised again only after the measure returns inside its band and leaves it again (a new breach has a new `since`). Dismissals do **not** widen the band: in the playbook dismissals tune the bands; here tuning stays a person's change to `observe.bands`, because automatic widening would weaken a gate.

### What the bands never do

Start an agent, file a ticket, change a rule, a threshold or a setting. `observe.py collect` puts the bands into `metrics.json` so a breach can be cited as evidence; the observe skill is told never to propose changing a band, a tier or a rule mapping (and a proposal cannot target `.factory/config.json` anyway).

### Shared-file wiring

`skills/run/scripts/run.py` (one block between `# ---- M15 control bands` and `# ---- end of M15 control bands ----`, after the M14 evals block): `bands_station()`, `bands_due()`, `cmd_bands()`, `bands_parser()`. Plus three one-line touches: `Project.observe_status` returns `bands_due(self.root, cleanup_station().observe_due(self.root))`; `cmd_status` adds `control_bands` (null inside a supervised execution, as `observe_due` is false there); `bands_parser(sub)` after `eval_parser(sub)`; one usage line in the module docstring. `skills/run/SKILL.md`: a "Control bands (M15)" section after "Factory evals", and `bands [dismiss <measure> <why>]` in the argument hint.

Known rough edge: the supervisor's own "an observe pass is due" message (`supervisor.py`, not changed here) quotes the count since the last pass and `observe.every`; when the pass is due because of a band, those numbers can read below the count. The cleanup station's `observe_due` (used in cleanup's own output) does not know about bands; `/mach status`, the belt and the supervisor all go through `run.py` and do.

---

## 2. Security scan intake: `ticket.py ingest-scan`

```
ticket.py ingest-scan <file> [--source <name>] [--format sarif|csv] [--min-severity info|low|medium|high|critical] [--dry-run] [--no-sync]
ticket.py scan-dismiss <fingerprint> --reason "<why>" [--by <role>]
```

Reached as `/mach-ticket ingest-scan`. Code: `skills/ticket/scripts/scans.py` (reading, scrubbing, fingerprint, risk) and the "security scan intake (M15)" block in `ticket.py` (filing, ledger, dismissal).

### Formats

**SARIF 2.1.0**, from the OASIS specification (SARIF v2.1.0 Errata 01, https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html), the fields used and what the spec says of each:

| Field | Section | Use |
|---|---|---|
| `version` = `"2.1.0"`, `runs` | 3.13 | refused otherwise |
| `run.tool.driver.name`, `driver.rules` | 3.19.8, 3.19.23 | source name; rule descriptors |
| `result.kind` | 3.27.9 | absent means `fail`; any other kind is skipped |
| `result.ruleId`, `ruleIndex`, `rule` | 3.27.5-3.27.7 | the descriptor by index, else by id |
| `result.level` | 3.27.10 | absent: the descriptor's `defaultConfiguration.level`, else `warning`. error→high, warning→medium, note→low, none→info |
| `result.message.text` (else `markdown`) | 3.27.11 | the finding's words |
| `result.locations[0].physicalLocation.artifactLocation.uri`, `region.startLine`, `region.snippet.text` | 3.27.12, 3.30.5, 3.30.13 | file, line, snippet (fingerprint only) |
| `result.partialFingerprints` | 3.27.17 | fingerprint when there is no snippet |
| `result.guid` | 3.27.3 | fingerprint when neither |
| `result.suppressions[].status` | 3.27.23, 3.35.3 | a suppression with status `accepted` skips the result |
| `result.baselineState` = `absent` | 3.27.24 | skipped: no longer present |

Not used: `ruleConfigurationOverrides` (the first step of the level lookup in 3.27.10; a result whose level comes only from an invocation override is read at the descriptor's or the default level), `rank`, `fingerprints`, related locations, code flows. A suppression whose status is absent is **not** treated as suppressed: I did not read section 3.35.3 closely enough on that case to rely on it, and dropping a real finding is the worse error.

**Severity score.** Where a descriptor or result carries `properties["security-severity"]` (a GitHub code scanning convention, not part of SARIF), it outranks the level, banded as GitHub documents (https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support-for-code-scanning): 7.0-8.9 high, 4.0-6.9 medium, 0.1-3.9 low, "over 9.0" critical (9.0 itself is treated as critical, as in CVSS); 0.0 or out of range has none. The descriptor's `properties.precision` (a CodeQL convention) is carried as confidence.

**The documented CSV.** A header row; names matched without regard to case, spaces, `_` or `-`:

| Field | Required | Header names accepted |
|---|---|---|
| rule or title | yes | Rule, Title, Name, Rule ID, Check |
| severity | yes | Severity, Level (critical, high, medium/moderate, low, info/informational/none, error, warning, note, or a 0-10 score banded as above) |
| file | yes | File, File path, Path, Location |
| line | yes (the value may be empty) | Line, Line number, Start line |
| description | yes | Description, Message, Details |
| confidence | no | Confidence, Precision |
| finding ID | no | Finding ID, ID |
| status | no | Status, State: a row marked dismissed, closed, resolved, fixed, false positive or suppressed is skipped |

**Claude Security's exports: not verified.** Anthropic's help article "Use Claude Security" (https://support.claude.com/en/articles/14661296-use-claude-security), read during this work, names the API, the Claude Security connector and webhooks as the ways to get findings out and lists the fields a finding has (title, severity, category, location among them), but documents no CSV columns, no Markdown layout and no SARIF export; it also says scans run when new commits land, with no fixed schedule. Search results say the product offers CSV and Markdown downloads, and Qualys's connector page (https://docs.qualys.com/en/conn/latest/integrations/claude_security_sast_connector.htm) lists sixteen CSV columns (Severity, Status, Discovery, Date created, Category, Repository, Branch, Name, Description, File path, Line, Confidence, CWE, Finding URL, Dismissal reason, Dismissal note), but that is a third party's description, not Anthropic's. So Claude Security's export is **not supported as such**: SARIF 2.1.0 and the CSV above are what is supported. A file shaped as Qualys describes happens to fit the CSV's aliases (Name, Severity, File path, Line, Description, Confidence, Status), but that has not been checked against a real export, and the Markdown export is not read at all.

### Each finding

- **Threshold**: `--min-severity`, default `medium`.
- **Data, never instructions.** Every text is cleaned (`issue_rules.clean_text`), checked line by line with the build station's secret shapes (`skills/intent/scripts/scan.py` `secrets_in_line`, loaded, never copied); every value found in any field (including the snippet) is removed from every field; a line that still has a secret's shape becomes `[a <kind> was here; the value is not shown]`; then redacted and bounded with the shared rules (`issue_rules.bound_text`, which applies `redact`). The description is quoted in the seed as "The scanner's words, quoted as data", with mentions and issue references broken (`issue_rules.quiet`). The snippet is used only, scrubbed, inside the fingerprint and is never written. The export itself is never kept (unlike `ingest-telemetry`, which keeps the payload as `.raw`).
- **Secrets**: the ticket says `a <kind> was found at <file:line>. The value was not copied and is not shown. Rotating the exposed credential is a person's task outside the Factory.`, and the scope adds moving it to configuration. Best effort: a credential with none of the known shapes (a short plain password, say) is caught only by the shared redaction, if at all.
- **Fingerprint**: SHA-256 of `[source, rule, file, region]`, 16 hex characters, where region is the scrubbed snippet with whitespace folded, else the SARIF partial fingerprints, else the finding ID, else the line. A finding that moved lines with the same snippet keeps its fingerprint; one reported by a different `--source` does not.
- **Risk**: never below Medium. High where the intent station raises a ticket to High (`skills/intent/references/contracts-and-plan.md`, "Risk tier": sign-in or permissions, billing, a database schema, an existing contract), applied to the finding's path: a contract file by the audit station's `CONTRACT_RE` that exists at the main checkout's `HEAD` (the file on disk when there is no Git history), a migration folder from `baseline.py`'s `MIGRATION_DIRS` or a schema or `.sql` file, and path words for sign-in/permissions and billing/payments (`scans.AUTH_RE`, `BILLING_RE`; these words are this module's own, as no script in MACH classes those by path). The tier and its reason go into the seed's `## 3. Risk` and a `risk-medium`/`risk-high` label. **Not enforced by a script**: the intent station sets the tier from the seed when grooming and its instructions say never to lower it, but no script holds a scan ticket at Medium; enforcing that floor (as `monitoring.py` and intake do for their work) belongs to the intent or run station and is not built here.
- **The ticket**: `SCAN-<first 10 of the fingerprint>` (with `-2`, `-3` when a finding comes back after its ticket closed), labels `security-scan`, `risk-<tier>`, `severity-<level>`, `scan-<source>`; title `[Security/Scan] <Severity>: <title> in <file>`; body from the seed (problem, acceptance criteria, risk) ending `mach-scan-finding: <fingerprint>`; inbox `SCAN-….json` with `security_scan` (identifiers and redacted text) and the seed `SCAN-…-intent.md` in the telemetry seed's form, which also says: fix it as one bounded change, and if it needs more, groom the first thin slice and defer the rest.
- **Duplicates**: `.factory/inbox/scans/ledger.json` maps fingerprint to ticket. A finding whose ticket is still open is counted (`times_seen`, `last_seen`), not ticketed. One whose ticket is closed (local ticket state, a run record, or the inbox state) is ticketed again, noting the earlier ticket. The same finding twice in one file is one. The ledger is saved after each ticket, so an interrupted run never files one twice.
- **Dismissal**: `scan-dismiss <fingerprint> --reason` records `.factory/inbox/scans/dismissed.json`; that finding is never ticketed again. A person's word only; refused inside a supervised execution. A ticket already filed is not changed.
- **Limits**: a file over 10 MB is refused whole; at most 5000 findings are read (the rest counted as skipped); at most 25 new tickets per run (the rest listed under `not_filed_over_limit`; a re-run files them). Skipped findings are summarised by reason and count.
- `--dry-run` lists exactly what would be filed and writes nothing.

### Who runs scan tickets

It files tickets and nothing more: it starts no station. The Factory's supervisor runs only product work through intake's dispatch and, behind its own grant, monitoring requests (`docs/mach-next/M8_DESIGN.md` D7); scan tickets are neither, and this was not widened. **An engineer runs a scan ticket with `/mach <ticket>`** (grooming with `--headless` is their choice, as for `AUTO-` tickets). Scheduling the scanner itself is outside MACH; the export can be left anywhere, and release qualification still reads reports placed under `.factory/release/scans/` as before.

---

## Tests

- `tests/test_observe_bands.py` (28): each rule alone; the strict line and the "ticket must be part of the pattern" convention; zero spread; the minimum sample; a steady history inside every band; slow drift (rule 4, tier 3, pass due, the tickets behind it); a single spike (tier 2, said, no pass); an improvement only recorded; determinism; records written once; a pass after the breach clears "due"; collect carries the bands; the template's defaults; window, measures and tiers from settings; bad settings compute nothing and say why; switched off; dismissal recorded, shown and suppressing; raised again only after returning inside and leaving; dismissal refusals including inside a supervised execution; `run.py status` carries the line and the due pass and is unchanged when steady; `run.py bands` routed; the bands code calls no process, ticket script or agent.
- `tests/test_ticket_scans.py` (25): the hand-written SARIF sample (`tests/fixtures/scans/sample.sarif`) by the specification (security-severity over level, default level, kind pass, accepted suppression); tickets, labels, seed form and inbox; High risk for auth, billing, migration and existing contract paths, Medium for a new contract; the existing contract judged at `HEAD` in a real Git repository; level defaults and the critical band; non-SARIF refused; a finding quoting a GitHub token and an AWS key (assembled at run time, so none is committed): no part of either value in any file written or in the output, kinds and place shown; the fingerprint independent of the secret; injected instructions quoted as data, mentions broken; a second run creates nothing and counts; a moved line with the same snippet is the same finding; duplicates in one file; a finding back after its ticket closed; dry run writes nothing; dismissal and its refusals; the CSV, aliases, closed rows, missing columns and unknown severity; the size, findings and per-run limits; the intake block starts nothing; supervisor, monitoring, intake and pull do not mention scan tickets.
- `tests/test_installer.py`: the installed config's `observe` now has `bands`.
- Not tested: a real scanner's export (no scanner was run), a GitHub tracker (`--no-sync` off with the `github` provider files through the existing `create`, unchanged), a supervised execution's `status` (the scope branch sets `control_bands` to null beside `observe_due`, by reading, not by a test).

## Not built

- The trend rules and any rule beyond the four zone rules; any moving-range or p-chart variant.
- Automatic tuning of a band from dismissals.
- A script-held Medium floor for scan tickets in the intent station; scan tickets in the supervisor.
- Reading Claude Security's Markdown export, or its CSV beyond what fits the documented CSV.
- Changes to the supervisor's message or the cleanup station's `observe_due` for a band-driven pass.
