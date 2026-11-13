/**
 * Development proof for the investigation lenses alone: /dev/timeline-investigate.html (development
 * server only; not part of any build). ?theme=light|dark pins the theme; ?lens=<id> shows one lens.
 *
 * A deterministic in-file history (05:00–06:50 UTC) covering all five lenses:
 * - LOCAL-031: three passes through build and verify across two review rounds and three execution
 *   attempts (attempt 2 begins mid-pass), a failed verification, a round rejected by a security veto,
 *   a person's approval and a merge by policy;
 * - LOCAL-034: a refused verification gate and a retry, approved, merged with no recorded authority;
 * - SLICE-005 (LOCAL-036) blocked twice on SLICE-004, eligible, waiting for capacity against
 *   max_parallel 3, then claimed and started; SLICE-007 waiting on a slice not in the data;
 * - LOCAL-038: an interrupted execution with a visit ended without an exit record, a recovery, and
 *   attempt 2 taking it up (with a visit stopped and taken up again); LOCAL-039: outcome not known.
 */
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, TooltipProvider, type ThemePreference } from "@mach/ui";
import "../../index.css";
import { SceneStoreProvider, type SceneStore, type SceneStoreState } from "../../scene";
import { setTimeBase } from "../../shell/time";
import { INITIAL_TIMELINE_VIEW, LABEL_GUTTER, NO_FILTERS, type ConcurrencyBucket, type ConcurrencySeries, type LensId, type SpanAttrs, type SpanEnd, type SpanKind, type TimelineData, type TimelineMark, type TimelineSpan, type TimelineViewState, type TimeWindow } from "../contract";
import { InvestigationPanel, LENSES } from "../investigate";
import { buildTrackTree } from "../tracks";

setTimeBase("wall");

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 12, 5, 0, 0);
const t = (h: number, m: number, s = 0) => T0 + h * 60 * MIN + m * MIN + s * 1000;
const LIVE_AT = t(1, 50);
const WINDOW: TimeWindow = { from: t(0, 0), to: t(1, 55) };

const end = (at: number | null, o: Partial<SpanEnd> = {}): SpanEnd => ({ eventId: at === null ? null : `ev-${at}`, at, precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: null, ...o });

interface Opt {
  id?: string;
  parent?: string | null;
  ids?: Record<string, string>;
  outcome?: string | null;
  reason?: SpanEnd["reason"];
  endBasis?: "recorded" | "inferred";
  rule?: string;
  attrs?: SpanAttrs;
}

function sp(kind: SpanKind, entity: string, from: number, to: number | null, o: Opt = {}): TimelineSpan {
  const e = to === null ? null : end(to, { reason: o.reason ?? "completed", basis: o.endBasis ?? "recorded", rule: o.rule ?? null });
  return {
    id: o.id ?? `${kind}:${entity}`,
    kind,
    entity,
    parent: o.parent ?? null,
    ids: o.ids ?? {},
    start: end(from),
    end: e,
    duration: { ms: to === null ? null : to - from, minMs: null, maxMs: null, basis: to === null ? "open" : o.endBasis === "inferred" ? "inferred" : "measured" },
    outcome: o.outcome ?? null,
    authority: "authoritative",
    attrs: o.attrs ?? {},
  };
}

const SLICE: Record<string, [string, string]> = { "LOCAL-031": ["SLICE-004", "W-2"], "LOCAL-034": ["SLICE-006", "W-2"], "LOCAL-036": ["SLICE-005", "W-2"], "LOCAL-038": ["SLICE-008", "W-3"], "LOCAL-039": ["SLICE-009", "W-3"], "LOCAL-040": ["SLICE-010", "W-3"] };
const base = (tk: string) => ({ ticket_id: tk, slice_id: SLICE[tk]![0], wave_id: SLICE[tk]![1] });

function cell(tk: string, from: number, to: number | null, outcome: string | null = null) {
  return sp("cell", `cell:${tk}`, from, to, { ids: base(tk), outcome });
}
function exec(tk: string, x: string, attempt: number, claim: number, from: number, to: number | null, o: Opt = {}): TimelineSpan[] {
  const ids = { ...base(tk), execution_id: x, attempt: String(attempt) };
  return [sp("claim", `execution:${x}`, claim, from, { parent: `cell:${tk}`, ids }), sp("execution", `execution:${x}`, from, to, { parent: `cell:${tk}`, ids, outcome: to === null ? null : (o.outcome ?? "completed"), reason: o.reason, attrs: { attempt, state: o.outcome ?? "completed" } })];
}
const counters = new Map<string, number>();
function visit(tk: string, station: string, x: string | null, round: number, from: number, to: number | null, o: Opt & { action?: string } = {}): TimelineSpan[] {
  const key = `${tk}/${station === "revise" ? "build" : station}`;
  const n = (counters.get(key) ?? 0) + 1;
  counters.set(key, n);
  const st = station === "revise" ? "build" : station;
  const entity = `visit:${tk}/${st}#${n}`;
  const v = sp("visit", entity, from, to, { parent: x ? `execution:${x}` : null, ids: { ...base(tk), station: st, round: String(round), ...(x ? { execution_id: x } : {}) }, outcome: o.outcome ?? (to === null ? null : "completed"), reason: o.reason, endBasis: o.endBasis, rule: o.rule, attrs: { action: o.action ?? station, round, ...(o.attrs ?? {}) } });
  // One agent per build, verify and review visit, for the concurrency series.
  const agent = sp("agent", `agent:${tk}-${st}-${n}`, from + 20_000, to === null ? null : to - 20_000, { parent: x ? `execution:${x}` : null, ids: { ...base(tk), station: st }, attrs: { label: st === "verify" ? "verifier" : st === "review" ? "reviewer" : "builder", model: "sonnet" } });
  return [v, agent];
}
const seat = (tk: string, round: number, name: string, from: number, at: number, vote: string) =>
  sp("seat", `seat:${tk}/review#${round}/${name}`, from, at, { parent: `gate:${tk}/review#${round}`, ids: { ...base(tk), seat: name, round: String(round) }, outcome: vote, reason: vote === "REJECT" ? "refused" : "completed", attrs: { round, vote, model: name === "security" ? "opus" : "sonnet" } });
const round = (tk: string, n: number, from: number, to: number | null, outcome: string | null) => sp("round", `gate:${tk}/round#${n}`, from, to, { parent: `cell:${tk}`, ids: { ...base(tk), round: String(n) }, outcome, reason: outcome === "REJECTED" ? "failed" : "completed", attrs: { round: n } });
const waitSpan = (slice: string, tk: string | null, n: number, from: number, to: number | null, deps: string[], reasons?: string[]) =>
  sp("slice-wait", `slice:${slice}`, from, to, { id: `slice-wait:slice:${slice}${n > 1 ? `#${n}` : ""}`, parent: `slice:${slice}`, ids: { slice_id: slice, ...(tk ? { ticket_id: tk, wave_id: SLICE[tk]![1] } : { wave_id: "W-3" }) }, attrs: { dependsOn: deps, ...(reasons ? { reasons } : {}) } });

const SPANS: TimelineSpan[] = [
  // ---- LOCAL-031: three passes, two rounds, three attempts.
  cell("LOCAL-031", t(0, 2), t(1, 30), "merged"),
  ...exec("LOCAL-031", "x31a", 1, t(0, 2), t(0, 3), t(0, 21)),
  ...visit("LOCAL-031", "build", "x31a", 1, t(0, 4), t(0, 12)),
  ...visit("LOCAL-031", "verify", "x31a", 1, t(0, 13), t(0, 17), { outcome: "FAIL_WITH_EVIDENCE", reason: "failed" }),
  ...visit("LOCAL-031", "revise", "x31a", 1, t(0, 18), t(0, 21)),
  ...exec("LOCAL-031", "x31b", 2, t(0, 23), t(0, 24), t(0, 50)),
  ...visit("LOCAL-031", "verify", "x31b", 1, t(0, 25), t(0, 29), { outcome: "PASS" }),
  ...visit("LOCAL-031", "review", "x31b", 1, t(0, 30), t(0, 38), { outcome: "REJECTED", reason: "failed" }),
  ...visit("LOCAL-031", "revise", "x31b", 2, t(0, 40), t(0, 49)),
  ...exec("LOCAL-031", "x31c", 3, t(0, 53), t(0, 55), t(1, 12)),
  ...visit("LOCAL-031", "verify", "x31c", 2, t(0, 56), t(1, 0), { outcome: "PASS" }),
  ...visit("LOCAL-031", "review", "x31c", 2, t(1, 1), t(1, 8), { outcome: "AWAITING_HUMAN" }),
  round("LOCAL-031", 1, t(0, 4), t(0, 38), "REJECTED"),
  round("LOCAL-031", 2, t(0, 40), t(1, 8), "AWAITING_HUMAN"),
  seat("LOCAL-031", 1, "architecture", t(0, 30), t(0, 34), "APPROVE"),
  seat("LOCAL-031", 1, "security", t(0, 30), t(0, 37), "REJECT"),
  seat("LOCAL-031", 1, "product", t(0, 30), t(0, 33), "APPROVE"),
  seat("LOCAL-031", 2, "architecture", t(1, 1), t(1, 5), "APPROVE"),
  seat("LOCAL-031", 2, "security", t(1, 1), t(1, 7), "APPROVE"),
  seat("LOCAL-031", 2, "product", t(1, 1), t(1, 4), "APPROVE"),
  sp("gate-wait", "gate:LOCAL-031/human-approval", t(1, 8), t(1, 25), { parent: "cell:LOCAL-031", ids: base("LOCAL-031"), outcome: "passed", attrs: { round: 2 } }),

  // ---- LOCAL-034: a refused verification, a retry, merged without a recorded authority.
  cell("LOCAL-034", t(1, 4), t(1, 41), "merged"),
  ...exec("LOCAL-034", "x34a", 1, t(1, 4, 30), t(1, 5), t(1, 36)),
  ...visit("LOCAL-034", "build", "x34a", 1, t(1, 6), t(1, 12)),
  ...visit("LOCAL-034", "verify", "x34a", 1, t(1, 13), t(1, 16), { outcome: "INCOMPLETE_EVIDENCE", reason: "failed" }),
  ...visit("LOCAL-034", "revise", "x34a", 1, t(1, 17), t(1, 23)),
  ...visit("LOCAL-034", "verify", "x34a", 1, t(1, 24), t(1, 27), { outcome: "PASS" }),
  ...visit("LOCAL-034", "review", "x34a", 1, t(1, 28), t(1, 33), { outcome: "APPROVED" }),
  seat("LOCAL-034", 1, "architecture", t(1, 28), t(1, 31), "APPROVE"),
  seat("LOCAL-034", 1, "security", t(1, 28), t(1, 32), "APPROVE"),
  seat("LOCAL-034", 1, "product", t(1, 28), t(1, 30), "APPROVE"),

  // ---- SLICE-005 / LOCAL-036: blocked twice, eligible, waiting for capacity, claimed, started.
  waitSpan("SLICE-005", "LOCAL-036", 1, t(0, 1), t(0, 21), ["SLICE-004"]),
  sp("slice-eligible", "slice:SLICE-005", t(0, 21), t(0, 24), { id: "slice-eligible:slice:SLICE-005", parent: "slice:SLICE-005", ids: base("LOCAL-036") }),
  waitSpan("SLICE-005", "LOCAL-036", 2, t(0, 24), t(1, 31), ["SLICE-004"], ["SLICE-004 is not integrated"]),
  sp("slice-eligible", "slice:SLICE-005", t(1, 31), t(1, 33), { id: "slice-eligible:slice:SLICE-005#2", parent: "slice:SLICE-005", ids: base("LOCAL-036") }),
  sp("capacity-wait", "cell:LOCAL-036", t(1, 33), t(1, 37), { id: "capacity-wait:cell:LOCAL-036@ev-c1", parent: "cell:LOCAL-036", ids: base("LOCAL-036"), attrs: { reasons: ["limit 3 (max_parallel)"] } }),
  cell("LOCAL-036", t(1, 37), null),
  ...exec("LOCAL-036", "x36a", 1, t(1, 37), t(1, 39, 30), null),
  ...visit("LOCAL-036", "build", "x36a", 1, t(1, 40), null),
  waitSpan("SLICE-007", null, 1, t(1, 10), null, ["SLICE-012"], ["SLICE-012 is not integrated"]),

  // ---- LOCAL-038: interrupted, recovered, taken up again by attempt 2.
  cell("LOCAL-038", t(0, 39), null),
  ...exec("LOCAL-038", "x38a", 1, t(0, 39), t(0, 40), t(1, 4), { reason: "interrupted", outcome: "interrupted" }),
  ...visit("LOCAL-038", "build", "x38a", 1, t(0, 41), t(1, 4), { outcome: null, reason: "interrupted", endBasis: "inferred", rule: "execution-ended" }),
  ...exec("LOCAL-038", "x38b", 2, t(1, 13), t(1, 13, 30), t(1, 45)),
  ...visit("LOCAL-038", "build", "x38b", 1, t(1, 14), t(1, 30), { attrs: { interruptedAt: t(1, 20) } }),

  // ---- LOCAL-039: an execution whose outcome is not known.
  cell("LOCAL-039", t(0, 44), null),
  ...exec("LOCAL-039", "x39a", 1, t(0, 44), t(0, 45), t(1, 15), { reason: "unknown", outcome: "unknown" }),
  ...visit("LOCAL-039", "build", "x39a", 1, t(0, 46), t(1, 15), { outcome: null, reason: "unknown", endBasis: "inferred", rule: "execution-ended" }),

  // ---- LOCAL-040: a third execution running in parallel.
  cell("LOCAL-040", t(1, 19), null),
  ...exec("LOCAL-040", "x40a", 1, t(1, 19), t(1, 20), null),
  ...visit("LOCAL-040", "build", "x40a", 1, t(1, 21), null),
];

const mk = (id: string, kind: TimelineMark["kind"], at: number, entity: string | null, label: string, verdict: string | null = null, until: number | null = null): TimelineMark => ({ id, kind, at, until, eventId: `ev-${id}`, entity, label, verdict, authority: "authoritative" });

const MARKS: TimelineMark[] = [
  mk("f31-1", "failure", t(0, 17), "visit:LOCAL-031/verify#1", "Verification ended FAIL_WITH_EVIDENCE (4 of 7 checks).", "fail_with_evidence"),
  mk("g31-1", "gate", t(0, 17), "visit:LOCAL-031/verify#1", "Gate verify.verdict refused (4 of 7 checks).", "refused"),
  mk("g31-2", "gate", t(0, 29), "visit:LOCAL-031/verify#2", "Gate verify.verdict passed (7 of 7 checks).", "passed"),
  mk("g31-3", "gate", t(1, 0), "visit:LOCAL-031/verify#3", "Gate verify.verdict passed.", "passed"),
  mk("d31-1", "review", t(0, 38), "gate:LOCAL-031/review#1", "Review round 1 decided REJECTED (security veto).", "rejected"),
  mk("d31-2", "review", t(1, 8), "gate:LOCAL-031/review#2", "Review round 2 decided AWAITING_HUMAN.", "awaiting-human"),
  mk("h31-r", "human", t(1, 8), "gate:LOCAL-031/human-approval", "The review asked for a person's approval.", "required", t(1, 25)),
  mk("h31-a", "human", t(1, 25), "cell:LOCAL-031", "A person recorded an approval.", "approved"),
  mk("m31", "merge", t(1, 30), "cell:LOCAL-031", "Merged by the merge policy (auto, medium risk).", "merged"),
  mk("g34-1", "gate", t(1, 16), "visit:LOCAL-034/verify#1", "Gate verify.verdict refused (stale evidence).", "refused"),
  mk("g34-2", "gate", t(1, 27), "visit:LOCAL-034/verify#2", "Gate verify.verdict passed.", "passed"),
  mk("d34-1", "review", t(1, 33), "gate:LOCAL-034/review#1", "Review round 1 decided APPROVED.", "approved"),
  mk("m34", "merge", t(1, 41), "cell:LOCAL-034", "The ticket's branch was merged.", "merged"),
  mk("i38", "interruption", t(1, 4), "execution:x38a", "An execution was interrupted.", "interrupted"),
  mk("r38", "recovery", t(1, 4, 40), "execution:x38a", "The supervisor started a recovery (interrupted).", "interrupted"),
  mk("i39", "interruption", t(1, 16), "execution:x39a", "An execution's outcome is unknown.", "unknown"),
  mk("r39", "recovery", t(1, 16), "execution:x39a", "The supervisor started a recovery (outcome-unknown).", "outcome-unknown"),
];

function series(w: TimeWindow, buckets: number, withLimit: boolean): ConcurrencySeries {
  const bucketMs = Math.max(30_000, Math.ceil((w.to - w.from) / Math.max(1, buckets) / 30_000) * 30_000);
  const out: ConcurrencyBucket[] = [];
  for (let b = w.from; b < Math.min(w.to, LIVE_AT); b += bucketMs) {
    const active: Partial<Record<SpanKind, { max: number; mean: number }>> = {};
    for (const k of ["execution", "visit", "agent"] as const) {
      let max = 0;
      let sum = 0;
      let n = 0;
      for (let s = b; s < b + bucketMs; s += 15_000, n++) {
        let c = 0;
        for (const x of SPANS) if (x.kind === k && x.start!.at! <= s && (x.end?.at ?? LIVE_AT) > s) c++;
        max = Math.max(max, c);
        sum += c;
      }
      if (max > 0) active[k] = { max, mean: sum / n };
    }
    out.push({ from: b, active });
  }
  return { from: w.from, to: w.to, bucketMs, buckets: out, limits: withLimit ? [{ name: "max_parallel", value: 3, from: T0, to: null }, { name: "poll_seconds", value: 300, from: T0, to: null }] : [], complete: true };
}

function fakeData(withLimit: boolean): TimelineData {
  return {
    source: "replay",
    extent: () => ({ from: T0, to: LIVE_AT }),
    spans: async () => ({ spans: SPANS, truncated: false, total: SPANS.length, version: "proof" }),
    span: async (id) => SPANS.find((s) => s.id === id) ?? null,
    marks: async (w, kinds) => MARKS.filter((m) => (!kinds || kinds.includes(m.kind)) && m.at <= w.to && (m.until ?? m.at) >= w.from),
    nextMark: async () => null,
    density: async (w) => ({ from: w.from, to: w.to, bucketMs: MIN, buckets: [], complete: true }),
    concurrency: async (w, buckets) => series(w, buckets, withLimit),
    availability: () => ({ spans: "ok", marks: "ok", concurrency: "ok", density: "ok", unwindowed: false }),
    subscribe: () => () => {},
  };
}

function proofStore(selection: string | null): SceneStore {
  const state = { source: "replay", playhead: LIVE_AT, liveAt: LIVE_AT, following: false, selection } as unknown as SceneStoreState;
  return { getState: () => state, subscribe: () => () => {} } as unknown as SceneStore;
}

const inWindow = (w: TimeWindow) => SPANS.filter((s) => (s.start?.at ?? 0) <= w.to && (s.end?.at ?? LIVE_AT) >= w.from);

function Instance({ lens, width, selection = null, window = WINDOW, limit = true }: { lens: LensId; width: number; selection?: string | null; window?: TimeWindow; limit?: boolean }) {
  const data = useMemo(() => fakeData(limit), [limit]);
  const store = useMemo(() => proofStore(selection), [selection]);
  const [view, setView] = useState<TimelineViewState>({ ...INITIAL_TIMELINE_VIEW, lens });
  const [log, setLog] = useState<string>("");
  const def = LENSES.find((l) => l.id === lens)!;
  const spans = useMemo(() => inWindow(view.window ?? window), [view.window, window]);
  const tree = useMemo(() => buildTrackTree(spans, view.grouping, NO_FILTERS, LIVE_AT), [spans, view.grouping]);
  const preset = useMemo(() => def.preset(tree, INITIAL_TIMELINE_VIEW), [def, tree]);
  const vp = { window: view.window ?? window, width: width - LABEL_GUTTER, liveAt: LIVE_AT };
  return (
    <section style={{ marginBottom: 22 }} data-proof={`${lens}-${width}${selection ? "-sel" : ""}${limit ? "" : "-nolimit"}${window === WINDOW ? "" : "-empty"}`}>
      <p style={{ font: "11px/16px var(--mach-font-mono)", color: "var(--mach-ink-subtle)", margin: "0 0 4px" }}>
        {lens} · {width}px{selection ? ` · selected ${selection}` : ""} · preset: grouping {preset.grouping ?? "unchanged"}
        {preset.expanded ? `, expands ${preset.expanded.length} rows` : ""}
        {preset.filters ? `, filters ${JSON.stringify({ kinds: preset.filters.kinds, attentionOnly: preset.filters.attentionOnly })}` : ""} {log ? `· last reveal ${log}` : ""}
      </p>
      <div style={{ border: "1px solid var(--mach-line)", width: width + 2 }}>
        <SceneStoreProvider store={store}>
          {view.lens ? (
            <InvestigationPanel
              lens={view.lens}
              data={data}
              tree={tree}
              spans={spans}
              viewport={vp}
              width={width}
              onView={(patch) => setView((v) => ({ ...v, ...patch }))}
              onReveal={(ref, at) => setLog(`${ref}${at ? ` @ ${new Date(at).toISOString().slice(11, 19)}` : ""}`)}
            />
          ) : (
            <p style={{ padding: 8, font: "12px var(--mach-font-sans)", color: "var(--mach-ink-muted)" }}>Lens closed.</p>
          )}
          <div style={{ height: 40, background: "var(--mach-factory-ground)" }} aria-hidden="true" />
        </SceneStoreProvider>
      </div>
    </section>
  );
}

const ORDER: LensId[] = ["retries", "concurrency", "waits", "review", "recovery"];

function Proof() {
  const only = new URLSearchParams(window.location.search).get("lens") as LensId | null;
  const lenses = only && ORDER.includes(only) ? [only] : ORDER;
  return (
    <main style={{ padding: 16, background: "var(--mach-surface)", minHeight: "100vh" }}>
      {lenses.map((l) => (
        <div key={l}>
          <Instance lens={l} width={1512} />
          <Instance lens={l} width={1100} selection={l === "retries" || l === "review" ? "cell:LOCAL-031" : null} />
        </div>
      ))}
      {!only || only === "concurrency" ? <Instance lens="concurrency" width={1100} limit={false} /> : null}
      {!only || only === "retries" ? <Instance lens="retries" width={1100} window={{ from: t(1, 44), to: t(1, 50) }} /> : null}
    </main>
  );
}

const theme = new URLSearchParams(window.location.search).get("theme");
const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
createRoot(root).render(
  <StrictMode>
    <ThemeProvider product="control-tower" persist={false} defaultPreference={theme === "light" || theme === "dark" ? (theme as ThemePreference) : "system"}>
      <TooltipProvider>
        <Proof />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
