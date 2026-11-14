/**
 * Which event fields hold prose the observer has not checked for names (R1), and their limits.
 *
 * The session declares them (`display_policy.free_text.event_fields`); a client shows each as plain,
 * bounded, labelled text. When no policy is declared (an older observer, the simulation, or before
 * `/session` answers) the client fails closed: it contains every field the observer is known to keep
 * as prose (`KNOWN_FREE_TEXT_FIELDS`, the observer's `redact.FreeTextFields`), at its known limit.
 * A declared policy adds to that list and may only lower a limit, never lift containment.
 */
import { DEFAULT_UNCHECKED_MAX, unchecked, uncheckedView, type DisplayPolicy, type FreeTextField, type UncheckedText } from "./unchecked";

/** The observer's own list (apps/observer/internal/redact/freetext.go, `FreeTextFields`). */
export const KNOWN_FREE_TEXT_FIELDS: readonly FreeTextField[] = Object.freeze([
  { kind: "review.finding", path: "data.title", max: 200 },
  { kind: "slice.materialized", path: "data.title", max: 200 },
  { kind: "agent.queued", path: "data.label", max: 120 },
  { kind: "agent.started", path: "data.label", max: 120 },
  { kind: "agent.queued", path: "data.phase", max: 60 },
  { kind: "agent.started", path: "data.phase", max: 60 },
  { kind: "workflow.phases_declared", path: "data.phases[].title", max: 60 },
  { kind: "intake.refused", path: "data.problems[]", max: 280 },
  { kind: "dependency.blocked", path: "data.reasons[]", max: 280 },
  { kind: "human.required", path: "data.reason", max: 280 },
  { kind: "factory.paused", path: "data.reason", max: 280 },
  { kind: "scheduling.decided", path: "data.held[].why", max: 280 },
  { kind: "work.scheduled", path: "data.authorization", max: 280 },
  { kind: "revision.superseded", path: "data.effect", max: 280 },
  { kind: "execution.completed", path: "data.waiting_for", max: 200 },
  { kind: "workflow.finished", path: "data.tickets[].waiting_for", max: 200 },
  { kind: "execution.completed", path: "data.refused_tools[]", max: 60 },
]);

/** Every field to contain under `policy`: the known list and whatever the policy declares besides. */
export function freeTextFieldsOf(policy: DisplayPolicy | null): readonly FreeTextField[] {
  const declared = policy?.fields ?? [];
  if (!declared.length) return KNOWN_FREE_TEXT_FIELDS;
  const out: FreeTextField[] = [];
  const key = (f: FreeTextField) => `${f.kind}\u0000${f.path}`;
  const byKey = new Map(declared.map((f) => [key(f), f]));
  for (const f of KNOWN_FREE_TEXT_FIELDS) {
    const d = byKey.get(key(f));
    out.push(d ? { ...f, max: Math.min(f.max, d.max) } : f);
    byKey.delete(key(f));
  }
  out.push(...byKey.values());
  return out;
}

/**
 * The limit for one field (`kind`, `path`); for a field read in several kinds (an agent's label is
 * `agent.queued` and `agent.started`), the smallest. The default when neither list names it.
 */
export function freeTextMax(policy: DisplayPolicy | null, kind: string | readonly string[], path: string): number {
  const kinds = typeof kind === "string" ? [kind] : kind;
  const maxes = freeTextFieldsOf(policy)
    .filter((f) => kinds.includes(f.kind) && f.path === path)
    .map((f) => f.max);
  return maxes.length ? Math.min(...maxes) : DEFAULT_UNCHECKED_MAX;
}

/** Whether events of `kind` carry a prose field. */
export function kindHasFreeText(policy: DisplayPolicy | null, kind: string): boolean {
  return freeTextFieldsOf(policy).some((f) => f.kind === kind);
}

/** The string values at a policy path ("data.held[].why") in an event. */
export function valuesAt(event: unknown, path: string): string[] {
  let current: unknown[] = [event];
  for (const raw of path.split(".")) {
    const many = raw.endsWith("[]");
    const name = many ? raw.slice(0, -2) : raw;
    const next: unknown[] = [];
    for (const c of current) {
      if (!c || typeof c !== "object") continue;
      const v = (c as Record<string, unknown>)[name];
      if (many) {
        if (Array.isArray(v)) next.push(...v);
      } else if (v !== undefined) next.push(v);
    }
    current = next;
  }
  return current.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

/** The data keys (top level of `data`) that hold prose for `kind`: `keyFields` never prints these raw. */
export function freeTextDataKeys(policy: DisplayPolicy | null, kind: string): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const f of freeTextFieldsOf(policy)) {
    if (f.kind !== kind || !f.path.startsWith("data.")) continue;
    keys.add(f.path.slice(5).split(".")[0]!.replace(/\[\]$/, ""));
  }
  return keys;
}

/** Wraps one field's value as `UncheckedText`, at the policy's limit for it. */
export function containField(policy: DisplayPolicy | null, kind: string | readonly string[], path: string, value: unknown): UncheckedText | null {
  const kinds = typeof kind === "string" ? [kind] : kind;
  return unchecked(value, `${kinds.join(" / ")} ${path}`, freeTextMax(policy, kinds, path));
}

// ---------------------------------------------------------------- the scene's copies of the policy's fields

/**
 * The scene fields that copy a policy field, by name, with the event kind and path they come from.
 * The limit is always the session's (`freeTextMax` over the declared fields, failing closed to the
 * observer's known list); this table only says which declared field a scene value is a copy of.
 */
export const FREE_TEXT = {
  findingTitle: { kind: ["review.finding"], path: "data.title" },
  // A slice's title (and a cell's, which copies it), from the intake ledger.
  sliceTitle: { kind: ["slice.materialized"], path: "data.title" },
  refusedTool: { kind: ["execution.completed"], path: "data.refused_tools[]" },
  agentLabel: { kind: ["agent.queued", "agent.started"], path: "data.label" },
  agentPhase: { kind: ["agent.queued", "agent.started"], path: "data.phase" },
  declaredPhase: { kind: ["workflow.phases_declared"], path: "data.phases[].title" },
  waitReason: { kind: ["dependency.blocked"], path: "data.reasons[]" },
  // The scene keeps a person's attention reason from human.required (and intake.refused's problems, same limit).
  personNeeded: { kind: ["human.required"], path: "data.reason" },
  heldWhy: { kind: ["scheduling.decided"], path: "data.held[].why" },
  waitingFor: { kind: ["execution.completed", "workflow.finished"], path: "data.waiting_for" },
  pausedReason: { kind: ["factory.paused"], path: "data.reason" },
  authorization: { kind: ["work.scheduled"], path: "data.authorization" },
  effect: { kind: ["revision.superseded"], path: "data.effect" },
} as const;
export type FreeTextKind = keyof typeof FREE_TEXT;

// The session's policy for code outside React (drawing, labels): set once `/session` answers
// (shell/displayPolicy.ts); until then null, which fails closed to the known list.
let session: DisplayPolicy | null = null;
export function setSessionPolicy(policy: DisplayPolicy | null): void {
  session = policy;
}
export function sessionPolicy(): DisplayPolicy | null {
  return session;
}

/**
 * A copy of a policy field as bounded plain words, for surfaces that draw strings (SVG, canvas): the
 * same `uncheckedView` the `UncheckedText` component reads, cut to the session's limit for the field
 * (or `max`, if smaller). Empty for nothing to show. Never for an `aria-label`, a `title` or a tooltip:
 * those say codes and counts only (C1); the panel carries the label once (C3).
 */
export function containedWords(field: FreeTextKind, text: string | null | undefined, max?: number): string {
  const f = FREE_TEXT[field];
  const t = containField(session, f.kind, f.path, text);
  return t ? uncheckedView(t, max !== undefined ? { max } : {}).shown : "";
}

/** What an event of a prose-carrying kind is, in words that quote nothing (for names, tooltips and the announcer). */
const KIND_WORDS: Readonly<Record<string, string>> = {
  "review.finding": "A review finding was recorded",
  "agent.queued": "An agent was queued",
  "agent.started": "An agent started",
  "workflow.phases_declared": "A workflow declared its phases",
  "intake.refused": "Intake refused a wave",
  "dependency.blocked": "A slice waits on a dependency",
  "human.required": "A person is needed",
  "factory.paused": "The Factory was paused",
  "scheduling.decided": "The supervisor decided what to dispatch, start or hold",
  "work.scheduled": "A slice was dispatched",
  "revision.superseded": "A slice revision was superseded",
  "execution.completed": "An execution ended",
  "workflow.finished": "A workflow finished",
};

/**
 * Words for an event that never quote its prose: null when its kind carries no prose under the session's
 * policy (its own sentence is MACH's words and may be used as it is). `who` is an id (ticket, slice, wave).
 */
export function codesOnlyWords(kind: string, who: string | null = null): string | null {
  if (!kindHasFreeText(session, kind)) return null;
  return `${KIND_WORDS[kind] ?? `A ${kind} record`}${who ? ` (${who})` : ""}. Its words are free text, shown in the inspector.`;
}

/** Whether an event holds a value at one of the policy's prose paths for its kind (it quotes free text). */
export function eventQuotesFreeText(event: { readonly type: string }, policy: DisplayPolicy | null = session, words?: string): boolean {
  // With the sentence made from it: only when it carries one of those values (a sentence that counts them quotes none).
  return freeTextFieldsOf(policy).some((f) => f.kind === event.type && valuesAt(event, f.path).some((v) => words === undefined || words.includes(v.trim().slice(0, 24))));
}
