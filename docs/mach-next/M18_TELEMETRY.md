# M18, what the Factory sees of a small change, as built

Built 2026-11-22 against `M18_DESIGN.md` part D, second and third bullets, on top of `M18_ENGINE_B.md` (which records `kind` and `widened` in `cell.json` and `spec.json`). Telemetry, the observer, Factory Analytics, the Line, the change record and the pull request. Product Studio's app and host, Shape and the size rules are not changed here.

## What was built

| File | What |
|---|---|
| `skills/intent/scripts/cell.py` | `kind_facts(cell)`: the groom station's `station.exited` (both of `finalize`'s branches, `spec-open` and `spec-ready`) gains `kind: "small"`, `widened` (bool) and, once widened, `widened_rule` (the rule's code from `small.RULES`, null on a person's word). Read from `cell.json` only. Nothing for any other ticket. |
| `skills/merge/scripts/change_record.py` | `small_change_words(info)`: "a small change", "a full slice that began as a small change. <the rule's fixed sentence>", or "... made a full slice on a person's word"; None for every other ticket. The record's `- Ticket:` line carries it. |
| `skills/merge/scripts/merge.py` | The pull request's `**Ticket:**` line carries the same words; the title reads `<ticket> (small change): <title>` for a small change, and a full slice's title once widened. |
| `apps/observer/internal/normalize` | The groom exit's `kind` (enum `small`), `widened` (bool) and `widened_rule` (enum of `SmallRules`, the intent station's codes) are read, only when the exit names a kind; any other value is null. |
| `apps/observer/internal/redact/allow.go`, `event/event.go`, `feed/feed.go`, `docs/mach-next/schemas/factory-event.v3.schema.json`, `M6_1_EVENT_CONTRACT.md` | Event schema 3 revision 8 (additive): the three fields on `data_station_exited`. |
| `apps/observer/internal/project` | A cell keeps `change` (`small` or `full`), `widened` and `widened_rule` from its last groom exit (an exit cleanup closed records nothing of it; once widened, full from then on). `TicketDims` adds the joined dimensions `change` and `widened` (`yes`/`no`). `FormatVersion` 10, so a saved projection is rebuilt. |
| `apps/observer/internal/metrics` | `change` and `widened` are dimensions of C1 and C2 and joinable (read when the figure is read, as risk is), so a ticket widened after an earlier groom visit counts every visit as a full slice. The cells and `DefinitionsVersion` are unchanged. |
| `web/apps/factory-floor/src/analytics` | Flow's plan asks `C1` by `station,change` (with the distribution) and `C2` by `station,widened`; the loader and snapshot carry two-dimension rows (`groupedPairKey`). `model/groomSplit.ts` decides what is said; the Groom station's detail shows "Small changes beside full slices": a small table (measured visits, median, mean) when each side has at least five measured visits (`comparisonAllowed`), else the counts in words; a note of how many tickets counted as full slices began as small changes; a source that does not group by two dimensions (the simulation) says small changes are not told apart there. |
| `web/apps/factory-floor/src/sim`, `src/line` | The scene keeps `smallChange` (`widened`, `rule`) from the groom exit; the Line's panel facts add a "Small change" row ("yes", or "began as a small change, now a full slice") and the full record's identifiers line says so; nothing for any other ticket. |
| `docs/BLUEPRINT.md` | The Factory Floor ("A small change on the Floor (M18)") and the merge station ("A small change (M18)"). |

## Deviations and choices

- **Widened as a dimension, counted at read time.** The design asks for time at Groom split by kind, with a small change that became a full slice counted as full. A visit's C1 cell is written when it ends and cannot be moved, so the kind is joined to the ticket's cells when they are read (as risk and app type already are). Every groom visit of a widened ticket, including one that ended on the short interview, is counted as a full slice. The count of widened tickets is C2's distinct tickets at Groom with `widened=yes`.
- **No new filter.** `change` and `widened` can be grouped by (`group_by=station,change`), not passed as filters: the observer's filter parameters are a fixed set, and the split needs no filter.
- **The rule's code is shown nowhere on the Floor.** The Line says that a ticket began as a small change; the rule's sentence lives in `small.py` and is in the change record and the pull request. The code reaches the event and the observer's state only.
- **The change record and the pull request take the rule's sentence from `widened.reason`** when the cell records a rule code and the reason is one line beginning with the fixed lead ("This is not a small change: "); otherwise (a person's word) they say so without the words. `change_record.py` stays standard library and loads nothing new; the sentence is redacted and made inert as all cell text is.
- **Cleanup is unchanged.** Its run record and archive already carry `cell.json`; the change record is written by the merge station. The run record does not gain the kind.
- **The simulation does not tell small changes apart**: its fixture groups by one dimension, so the Groom block says so rather than inventing a split.

## How far it is tested

- `tests/test_small_change_factory.py` `GroomExitTest` (4): a ticket that is not small exits with exactly the keys and values it had before; a small change on the short interview (`kind`, `widened: false`); widened by a rule at `finalize` (both exits carry `widened_rule: risk`); widened on the engineer's word (`widened_rule: null`, and the words appear nowhere in the lifecycle log). Every record is checked against `cell-lifecycle.schema.json`.
- `tests/test_change_record.py` `SmallChangeTest` (4): not small, record, title and body identical; small, the ticket line and title; widened by a rule, the sentence and a full slice's title; widened on a person's word, no words. Only the ticket line changes, and no text says "light path" or "kind".
- `apps/observer/internal/normalize/m18_test.go` (4): a full slice's groom exit served as before; a small change, widened, unknown codes and words dropped, an unknown kind dropped; a plan exit's kind ignored; `SmallRules` equals `small.py`'s `RULES` (read from the file). `m15_test.go` now checks the current revision.
- `apps/observer/internal/server/m18_metrics_test.go` (2): C1 by `station,change` and C2 by `station,widened` over a full slice, a small change and a small change widened on its second groom visit (both its visits counted full; one widened ticket); an exit cleanup closed keeps the kind.
- `web/apps/factory-floor/test/m18-small-change.test.mjs` (5): the Line's fact for a small change and a widened one, none for a full slice; the split's three states and their words; Flow's plan, a two-dimension row through the parser and snapshot, and the simulation's reason.

Run on 2026-11-22: `make check`, 1985 tests in 458 classes passed (one skipped, as before), manifests validated with the existing warnings; `go test ./...` in `apps/observer`, every package passed; from `web/`, `pnpm typecheck`, `pnpm lint` and `pnpm build` passed, and the Factory Floor's unit tests, 396 of 396. Every existing test passes unchanged except `normalize/m15_test.go`, whose fixed revision 7 now reads `event.Revision`.

Not verified: the Analytics block and the Line's fact have not been looked at in a browser (no screenshots were taken); no real Factory run has produced a small change's lifecycle log for the observer to read; the e2e suites were not run.
