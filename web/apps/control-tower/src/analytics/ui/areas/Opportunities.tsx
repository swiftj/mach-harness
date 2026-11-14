/**
 * Improvement Opportunities: the observer's deterministic rules (apps/observer/internal/insight),
 * each as a card that states its condition and threshold, the measurements that met it, the sample
 * and window, why it may matter, and a possible investigation. Advisory and read-only; nothing here
 * changes the Factory. Rules that could not be evaluated say why.
 *
 * The words are the observer's own rule templates. Pulse's "What stands out" lists the first few.
 */
import type { Insight, InsightMeasurement, InsightsReply } from "../../data/types";
import type { AreaId } from "../../model/findings";
import { count, durationText, plural, tokens, usd, windowText } from "../../model/format";
import { capitalFirst, insightPopulation, populationWords, repeatsTitle, sampleWords } from "../../model/insights";
import { shareText } from "../../model/sample";
import { AreaFrame, NotRecorded, SectionHead, useAnalytics } from "../kit";
import type { AreaData, OpportunitiesProps } from "../types";
import { AreaLink } from "./shared";

export function Opportunities(props: OpportunitiesProps) {
  return (
    <AreaFrame id="opportunities" title="Improvement opportunities" intro="Fixed rules over recorded values. Each says what it checked and what it found; none states a cause, and none suggests weakening verification, security or a person's approval. Changes to the Factory's rules go through a factory-tuning ticket and its review." props={props}>
      {() => <OpportunitiesBody insights={props.insights} />}
    </AreaFrame>
  );
}

/** The area a rule's first measurement belongs to, by catalog family. */
export function areaOf(i: Insight): AreaId {
  const m = i.measurements[0]?.metric ?? "";
  if (/^[CW]/.test(m) || /^T3/.test(m)) return "flow";
  if (/^[QRG]/.test(m)) return "quality";
  if (/^K/.test(m)) return "economics";
  if (/^[XS]/.test(m)) return "reliability";
  return "pulse";
}

/** A measurement in its unit, from the observer's numbers (or the simulation's words). */
export function measurementText(m: InsightMeasurement): string {
  if (m.display) return m.display;
  if (m.value === null) return "–";
  switch (m.unit) {
    case "ratio":
    case "rate":
      return m.numerator !== null && m.denominator ? shareText(m.numerator, m.denominator) : `${Math.round(m.value * 100)}%`;
    case "ms":
      return durationText(m.value);
    case "usd":
      return usd(m.value);
    case "tokens":
      return tokens(m.value);
    default:
      return Number.isInteger(m.value) ? count(m.value) : m.value.toFixed(2);
  }
}

const WINDOW_WORDS: Readonly<Record<InsightMeasurement["window"], string>> = { selection: "", later: " (later half)", earlier: " (earlier half)", unknown: "" };

function OpportunitiesBody({ insights }: { insights: AreaData<InsightsReply> | undefined }) {
  if (!insights) return <NotRecorded title="Not served by this source" what="This source does not evaluate the improvement rules." why="Nothing is shown in their place." state="unavailable" />;
  if (insights.state === "loading") return <p className="text-body text-ink-muted" role="status">Evaluating the rules for this window.</p>;
  if (insights.state === "error") return <p className="text-body text-danger-ink" role="alert">{insights.status !== null ? `The observer answered ${insights.status}: ${insights.reason}` : insights.reason}</p>;
  if (insights.state === "unavailable") return <NotRecorded title="Not available from this source" what={insights.reason} why="Nothing is shown in their place." state="unavailable" />;
  const r = insights.value;
  return (
    <>
      {r.notice ? <p className="max-w-[80ch] text-body-sm text-ink-muted">{r.notice}</p> : null}
      {r.insights.length === 0 ? (
        <section className="an-section">
          <SectionHead title="No rule's condition holds in this window" />
          <p className="text-body-sm text-ink-muted">Every rule has a minimum sample; widen the window or clear a filter to include more.</p>
        </section>
      ) : (
        <div className="an-grid-2">
          {r.insights.map((f) => (
            <InsightCard key={f.id} f={f} label={r.investigation_label} />
          ))}
        </div>
      )}
      {r.not_evaluated.length ? (
        <section className="an-section">
          <SectionHead title="Not evaluated" question="Rules that could not be checked on this selection, and why." />
          <ul className="flex flex-col gap-1 text-body-sm">
            {r.not_evaluated.map((n, i) => (
              <li key={`${n.rule}-${n.subject ?? ""}-${i}`} className="grid grid-cols-[minmax(0,16rem)_minmax(0,1fr)] gap-4">
                <span className="an-mono text-[12.5px] text-ink-muted" translate="no">
                  {n.rule}
                  {n.subject ? `:${n.subject}` : ""}
                </span>
                <span className="text-ink-muted">{n.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function InsightCard({ f, label }: { f: Insight; label: string | null }) {
  const { rows } = useAnalytics();
  const contributorKey = f.contributors && Object.keys(f.contributors.group).length === 0 ? f.contributors.metric : f.contributors ? `${f.contributors.metric}|${Object.entries(f.contributors.group).map(([k, v]) => `${k}=${v}`).join("|")}` : null;
  return (
    <article className="an-section flex flex-col gap-3" aria-labelledby={`op-${f.id}`} data-insight={f.rule} data-severity={f.severity}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={`op-${f.id}`} className="text-title-3 text-ink">
            {capitalFirst(f.title)}
          </h2>
          <p className="an-num mt-0.5 text-body-sm text-ink-muted" data-insight-population="">
            {[populationWords(f), sampleWords(f)].filter(Boolean).join("; ")}
          </p>
        </div>
        <span className={`shrink-0 rounded-full border px-2 text-caption ${f.severity === "attention" ? "border-warning-line text-warning-ink" : "border-line text-ink-muted"}`}>{f.severity === "attention" ? "Attention" : "Note"}</span>
      </div>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-body-sm">
        {f.measurements.filter((m) => !repeatsTitle(m, f.title)).map((m, i) => (
          <div key={`${m.metric}-${i}`} className="contents">
            <dt className="text-ink-muted">
              {m.label ?? m.metric}
              {WINDOW_WORDS[m.window]}
              {m.sample_count !== null ? <span className="an-num text-caption text-ink-subtle"> n {count(m.sample_count)}</span> : null}
            </dt>
            <dd className="an-fig text-right text-ink">{measurementText(m)}</dd>
          </div>
        ))}
      </dl>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-body-sm">
        {f.condition ? (
          <>
            <dt className="text-ink-muted">Found</dt>
            <dd>{f.condition}</dd>
          </>
        ) : null}
        {f.threshold ? (
          <>
            <dt className="text-ink-muted">Rule</dt>
            <dd>{f.threshold}</dd>
          </>
        ) : null}
        {f.sample ? (
          <>
            <dt className="text-ink-muted">Sample</dt>
            <dd className="an-num">
              {[f.sample.count !== null && f.sample.unit ? plural(f.sample.count, f.sample.unit.replace(/s$/, ""), f.sample.unit) : null, f.sample.population].filter(Boolean).join("; ") || "–"}
            </dd>
          </>
        ) : null}
        {f.window.from_ms !== null && f.window.to_ms !== null ? (
          <>
            <dt className="text-ink-muted">Window</dt>
            <dd className="an-num">{windowText(f.window.from_ms, f.window.to_ms)}</dd>
          </>
        ) : null}
        {f.why ? (
          <>
            <dt className="text-ink-muted">Why it may matter</dt>
            <dd>{f.why}</dd>
          </>
        ) : null}
        {f.investigation ? (
          <>
            <dt className="text-ink-muted">Where to look</dt>
            <dd>
              {f.investigation.text}
              <div className="text-caption text-ink-subtle">{f.investigation.label || label}</div>
            </dd>
          </>
        ) : null}
        <dt className="text-ink-muted">Metrics</dt>
        <dd className="an-mono text-caption" translate="no">
          {[...new Set(f.measurements.map((m) => m.metric))].join(", ")}
        </dd>
      </dl>
      <div className="flex flex-wrap items-center gap-4">
        <AreaLink to={areaOf(f)}>Open the figures</AreaLink>
        {rows && contributorKey ? (
          <button type="button" className="an-link text-body-sm" onClick={() => rows({ key: contributorKey, title: capitalFirst(f.title), unit: "count", population: insightPopulation(f), insight: f.id })}>
            {f.contributors?.relation === "related" ? "Related rows" : "Rows"}
          </button>
        ) : null}
      </div>
    </article>
  );
}
