/**
 * Parts several areas share: a number in prose that opens its definition, the recorded total
 * (always a lower bound), a small supporting figure, a link to another area, and the empty-history
 * explanation of what MACH records.
 */
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import type { MetricRow } from "../../contract";
import type { AreaId } from "../../model/findings";
import { coverageText, sampleText, usd } from "../../model/format";
import { Definition, headline, rowMissing, stateOf, useAnalytics } from "../kit";

export function Num({ row, children, label }: { row: MetricRow | undefined; children: string; label?: string }) {
  if (!row) return <>{children}</>;
  return (
    <Definition row={row} label={label}>
      {children}
    </Definition>
  );
}

/** K1's numerator is the recorded total; shown with its coverage, never as a complete figure. */
export function RecordedTotal({ row, size = "md" }: { row: MetricRow | undefined; size?: "md" | "sm" }) {
  if (!row) return null;
  const missing = rowMissing(row);
  return (
    <div className="min-w-0" data-readout="K1" data-value={missing || row.numerator_value === null ? undefined : row.numerator_value} data-state={missing ? stateOf(row) : undefined}>
      <div className="flex items-center gap-1 text-body-sm text-ink-muted">
        <span>Recorded total</span>
        <Definition row={row} label="Recorded total" />
      </div>
      {missing ? (
        <>
          <div className="text-body text-ink-muted">{missing.title}</div>
          <div className="mt-1.5 text-caption text-ink-subtle">{missing.why}</div>
        </>
      ) : (
        <>
          <div className={`an-fig leading-none text-ink ${size === "md" ? "text-[24px]" : "text-[19px]"}`}>{row.numerator_value === null ? "–" : usd(row.numerator_value)}</div>
          <div className="mt-1.5 text-caption text-ink-subtle">
            a lower bound: <span className="an-num">{coverageText(row.coverage)}</span> executions with a cost
          </div>
        </>
      )}
    </div>
  );
}

/** A quiet supporting figure: the value large enough to read, its sample and coverage small beside it. */
export function MiniFig({ row, label, value, sub }: { row: MetricRow | undefined; label: string; value?: string | null; sub?: ReactNode }) {
  if (!row) return null;
  const missing = rowMissing(row);
  const h = headline(row);
  const v = value !== undefined ? value : h.text;
  return (
    <div className="min-w-0" data-readout={row.id} data-value={missing || v === null ? undefined : (h.raw ?? undefined)} data-state={missing ? stateOf(row) : undefined}>
      <div className="flex items-center gap-1 text-caption text-ink-muted">
        <span className="truncate">{label}</span>
        <Definition row={row} label={label} />
      </div>
      {missing || v === null ? (
        <div className="text-body-sm text-ink-muted">{missing?.title ?? "No value"}</div>
      ) : (
        <div className="an-fig text-[17px] leading-tight text-ink">
          {h.lead && value === undefined ? <span className="mr-1 text-caption font-normal text-ink-subtle">{h.lead}</span> : null}
          {v}
        </div>
      )}
      <div className="an-num mt-0.5 text-caption text-ink-subtle">{sub ?? (missing ? null : v === null ? (row.null_reason ?? "").replace(/^(not recorded|not available|no value):\s*/, "") : `n ${sampleText(row)}${row.coverage.share !== null && row.coverage.share < 1 ? `; coverage ${coverageText(row.coverage)}` : ""}`)}</div>
    </div>
  );
}

export function AreaLink({ to, focus, children }: { to: AreaId; focus?: string; children: ReactNode }) {
  const { area } = useAnalytics();
  if (!area) return null;
  return (
    <button type="button" className="an-link inline-flex items-center gap-1 text-body-sm" onClick={() => area(to, focus)}>
      {children}
      <ArrowRight size={13} aria-hidden="true" />
    </button>
  );
}

/** An empty history: what MACH records, and that none of it has been recorded yet. */
export function NothingYet({ about }: { about: string }) {
  return (
    <div className="max-w-[72ch] rounded-md border border-line px-5 py-4" data-state="empty">
      <h2 className="text-title-3 text-ink">Nothing has been recorded yet</h2>
      <p className="mt-1 text-body text-ink-muted">{about}</p>
      <dl className="mt-4 grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-body-sm">
        <dt className="text-ink">Station visits</dt>
        <dd className="text-ink-muted">Each cell's lifecycle log: when a ticket entered and left groom, plan, audit, build, verify, review, merge and cleanup, and every gate's verdict.</dd>
        <dt className="text-ink">Executions</dt>
        <dd className="text-ink-muted">The supervisor's intake log: each execution claimed, how it ended, and the cost Claude Code reported for it.</dd>
        <dt className="text-ink">Agents and models</dt>
        <dd className="text-ink-muted">The execution stream: agents, their tool-call counts and tokens, and usage per model.</dd>
        <dt className="text-ink">Finished tickets</dt>
        <dd className="text-ink-muted">The run record cleanup writes: judging rounds, verification failures, review blockers, escalation and how the ticket landed.</dd>
        <dt className="text-ink">Delivery</dt>
        <dd className="text-ink-muted">Merges into the default branch and product slices whose commit reached the integration branch.</dd>
      </dl>
      <p className="mt-4 text-caption text-ink-subtle">Figures appear as soon as the first of these is recorded. Nothing here is shown as zero in the meantime.</p>
    </div>
  );
}
