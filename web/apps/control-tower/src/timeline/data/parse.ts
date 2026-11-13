/**
 * The observer's wire shapes for spans, marks and concurrency (docs/mach-next/M6_3_DESIGN.md section 6;
 * apps/observer/internal/project/spans.go) read into the Timeline's contract. Everything is read
 * tolerantly: unknown fields are ignored, a missing optional one is null or absent, and anything that
 * cannot be read as what it claims to be is dropped, never guessed. Times arrive as RFC 3339 strings
 * (or `*_ms` numbers) and leave as epoch milliseconds.
 */
import { timeOf } from "../../live/observer";
import type {
  ConcurrencyBucket,
  ConcurrencySeries,
  DurationBasis,
  MarkKind,
  SpanAttrs,
  SpanAuthority,
  SpanEnd,
  SpanEndReason,
  SpanKind,
  SpanPrecision,
  TimelineMark,
  TimelineSpan,
} from "../contract";

export const SPAN_KINDS: readonly SpanKind[] = [
  "wave",
  "slice-wait",
  "slice-eligible",
  "capacity-wait",
  "cell",
  "round",
  "visit",
  "task",
  "seat",
  "gate-wait",
  "person-wait",
  "claim",
  "execution",
  "workflow",
  "agent-queue",
  "agent",
  "tool",
];
export const MARK_KINDS: readonly MarkKind[] = ["failure", "retry", "gate", "review", "human", "recovery", "interruption", "gap", "wave", "merge"];

const BASES: readonly DurationBasis[] = ["measured", "bounded", "inferred", "open", "unknown"];
const AUTHORITIES: readonly SpanAuthority[] = ["authoritative", "observed", "reconstructed", "simulated"];
const PRECISIONS: readonly SpanPrecision[] = ["ms", "s", "arrival", "bounded", "unknown", "simulated"];
const REASONS: readonly SpanEndReason[] = ["completed", "failed", "refused", "interrupted", "superseded", "unknown"];

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null => (typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null);
const strings = (value: unknown): string[] | null => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : null);
/** A time: `<name>` (RFC 3339 or ms) or `<name>_ms`. */
const timeField = (o: Record<string, unknown>, name: string): number | null => timeOf(o[name]) ?? timeOf(o[`${name}_ms`]);

export function isSpanKind(value: unknown): value is SpanKind {
  return oneOf(value, SPAN_KINDS) !== null;
}

function readEnd(value: unknown, isEnd: boolean): SpanEnd | null {
  if (!value || typeof value !== "object") return null;
  const e = obj(value);
  const at = timeField(e, "at");
  const notBefore = timeField(e, "not_before");
  const notAfter = timeField(e, "not_after");
  const eventId = str(e.event_id);
  // An end with no time, no bounds and no event says nothing: it is not an end.
  if (at === null && notBefore === null && notAfter === null && eventId === null) return null;
  return {
    eventId,
    at,
    precision: oneOf(e.precision, PRECISIONS) ?? "unknown",
    notBefore,
    notAfter,
    basis: e.basis === "inferred" ? "inferred" : "recorded",
    rule: str(e.rule),
    reason: isEnd ? oneOf(e.reason, REASONS) : null,
  };
}

/** `attrs` (M6.3), snake_case on the wire. Absent fields stay absent: absent means not recorded. */
export function readAttrs(value: unknown): SpanAttrs {
  const a = obj(value);
  const out: { -readonly [K in keyof SpanAttrs]: SpanAttrs[K] } = {};
  const s = (k: string) => str(a[k]) ?? undefined;
  const n = (k: string) => num(a[k]) ?? undefined;
  if (s("label") !== undefined) out.label = s("label");
  if (s("model") !== undefined) out.model = s("model");
  if (s("agent_type") !== undefined) out.agentType = s("agent_type");
  if (n("tool_calls") !== undefined) out.toolCalls = n("tool_calls");
  if (typeof a.tools_count_only === "boolean") out.toolsCountOnly = a.tools_count_only;
  if (s("last_tool") !== undefined) out.lastTool = s("last_tool");
  if (n("tokens") !== undefined) out.tokens = n("tokens");
  if (s("action") !== undefined) out.action = s("action");
  if (n("round") !== undefined) out.round = n("round");
  if (n("attempt") !== undefined) out.attempt = n("attempt");
  if (s("state") !== undefined) out.state = s("state");
  if (n("cost_usd") !== undefined) out.costUsd = n("cost_usd");
  if (s("vote") !== undefined) out.vote = s("vote");
  const reasons = strings(a.reasons);
  if (reasons) out.reasons = reasons;
  const deps = strings(a.depends_on);
  if (deps) out.dependsOn = deps;
  const interrupted = timeField(a, "interrupted_at");
  if (interrupted !== null) out.interruptedAt = interrupted;
  return out;
}

/** The basis when the reply does not say: open while unended, otherwise not known. Never "measured" by assumption. */
function fallbackBasis(start: SpanEnd | null, end: SpanEnd | null): DurationBasis {
  return start !== null && end === null ? "open" : "unknown";
}

/** One span from the wire, or null when it is not one (no id, an unknown kind, no time at all). */
export function readSpan(value: unknown): TimelineSpan | null {
  const s = obj(value);
  const id = str(s.span_id) ?? str(s.id);
  const kind = oneOf(s.kind, SPAN_KINDS);
  if (!id || !kind) return null;
  const start = readEnd(s.start, false);
  const end = readEnd(s.end, true);
  if (!start && !end) return null;
  const d = obj(s.duration);
  const ids: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(s.ids))) if (typeof v === "string" && v !== "") ids[k] = v;
  return {
    id,
    kind,
    entity: str(s.entity) ?? id.slice(id.indexOf(":") + 1),
    parent: str(s.parent),
    ids,
    start,
    end,
    duration: { ms: num(d.ms), minMs: num(d.min_ms), maxMs: num(d.max_ms), basis: oneOf(d.basis, BASES) ?? fallbackBasis(start, end) },
    // An outcome is established by the event that ends the span: none without an end.
    outcome: end ? str(s.outcome) : null,
    // Unknown authority is not upgraded: it reads as reconstructed, the weakest real-history claim.
    authority: oneOf(s.authority, AUTHORITIES) ?? "reconstructed",
    attrs: readAttrs(s.attrs),
  };
}

const MARK_WORDS: Readonly<Record<MarkKind, string>> = {
  failure: "A failure was recorded.",
  retry: "Work was tried again.",
  gate: "A gate was evaluated.",
  review: "A review was decided.",
  human: "A person was involved.",
  recovery: "The supervisor recovered an execution.",
  interruption: "Work was interrupted.",
  gap: "History is missing here.",
  wave: "A wave arrived.",
  merge: "Work was merged.",
};

/** One mark from the wire, or null when it has no kind or no time. */
export function readMark(value: unknown): TimelineMark | null {
  const m = obj(value);
  const kind = oneOf(m.kind, MARK_KINDS);
  const at = timeField(m, "at");
  if (!kind || at === null) return null;
  const eventId = str(m.event_id);
  return {
    id: str(m.mark_id) ?? str(m.id) ?? `${kind}:${eventId ?? at}`,
    kind,
    at,
    until: timeField(m, "until"),
    eventId,
    entity: str(m.entity),
    label: str(m.label) ?? MARK_WORDS[kind],
    verdict: str(m.verdict),
    authority: oneOf(m.authority, AUTHORITIES) ?? "reconstructed",
  };
}

/** `/api/v1/concurrency`'s reply, or null when it holds no bucket size. */
export function readConcurrency(value: unknown, asked: { readonly from: number; readonly to: number; readonly bucketMs: number }): ConcurrencySeries | null {
  const d = obj(value);
  const bucketMs = num(d.bucket_ms) ?? asked.bucketMs;
  if (!(bucketMs > 0)) return null;
  const buckets: ConcurrencyBucket[] = [];
  for (const raw of Array.isArray(d.buckets) ? d.buckets : []) {
    const b = obj(raw);
    const from = timeField(b, "from");
    if (from === null) continue;
    const active: Partial<Record<SpanKind, { max: number; mean: number }>> = {};
    for (const [k, v] of Object.entries(obj(b.active))) {
      if (!isSpanKind(k)) continue;
      const max = num(obj(v).max);
      const mean = num(obj(v).mean);
      if (max !== null) active[k] = { max, mean: mean ?? max };
    }
    buckets.push({ from, active });
  }
  buckets.sort((a, b) => a.from - b.from);
  const limits: { name: string; value: number; from: number; to: number | null }[] = [];
  for (const raw of Array.isArray(d.limits) ? d.limits : []) {
    const l = obj(raw);
    const name = str(l.name);
    const v = num(l.value);
    const from = timeField(l, "from");
    if (name && v !== null && from !== null) limits.push({ name, value: v, from, to: timeField(l, "to") });
  }
  return { from: num(d.from_ms) ?? asked.from, to: num(d.to_ms) ?? asked.to, bucketMs, buckets, limits, complete: d.complete === true };
}
