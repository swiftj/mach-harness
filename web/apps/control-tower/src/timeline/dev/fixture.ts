/**
 * Development only: a hand-built, deterministic TrackTree for the render proof page. It covers every
 * span family and every timing basis, with a minimal row layout of its own (the real tracks module
 * is built separately; nothing here depends on it). Times are wall-clock UTC and cross midnight, so
 * the ruler's date change shows.
 */
import { extentOf, ROW_HEIGHT, type DurationBasis, type FlatRow, type RowLayout, type SpanAuthority, type SpanAttrs, type SpanEnd, type SpanKind, type TimelineMark, type TimelineSpan, type TrackKind, type TrackNode, type TrackTree } from "../contract";
import type { EntityRef } from "../../sim";

export const T0 = Date.UTC(2026, 10, 12, 23, 18, 0);
const S = 1000;
const M = 60 * S;
export const LIVE_AT = T0 + 70 * M + 12 * S;
export const PLAYHEAD = T0 + 61 * M + 40 * S;

/** A small seeded generator, so every load draws the same picture. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function at(t: number | null, o: Partial<SpanEnd> = {}): SpanEnd {
  return { eventId: null, at: t, precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: null, ...o };
}

interface SpanOptions {
  basis?: DurationBasis;
  outcome?: string | null;
  authority?: SpanAuthority;
  attrs?: SpanAttrs;
  ids?: Record<string, string>;
  parent?: string | null;
  entity?: string;
}

export function span(id: string, kind: SpanKind, start: SpanEnd | null, end: SpanEnd | null, o: SpanOptions = {}): TimelineSpan {
  const s = start?.at ?? null;
  const e = end?.at ?? null;
  const basis: DurationBasis = o.basis ?? (end === null ? "open" : start === null || (start.at === null && start.notBefore === null) || (end.at === null && end.notBefore === null) ? "unknown" : end.notBefore !== null && end.at === null ? "bounded" : start.basis === "inferred" || end.basis === "inferred" ? "inferred" : "measured");
  const ms = s !== null && e !== null ? e - s : null;
  const minMs = basis === "bounded" && start?.at != null && end?.notBefore != null ? end.notBefore - start.at : ms;
  const maxMs = basis === "bounded" && start?.at != null && end?.notAfter != null ? end.notAfter - start.at : ms;
  return {
    id,
    kind,
    entity: o.entity ?? id,
    parent: o.parent ?? null,
    ids: o.ids ?? {},
    start,
    end,
    duration: { ms, minMs, maxMs, basis },
    outcome: o.outcome ?? null,
    authority: o.authority ?? "authoritative",
    attrs: o.attrs ?? {},
  };
}

interface NodeInput {
  id: string;
  kind: TrackKind;
  label: string;
  detail?: string | null;
  note?: string | null;
  lanes?: TimelineSpan[][];
  ribbons?: TimelineSpan[];
  children?: NodeInput[];
  attention?: TrackNode["attention"];
  counts?: TrackNode["counts"];
  ref?: EntityRef | null;
}

function build(input: NodeInput, depth: number, parentId: string | null, byId: Map<string, TrackNode>, ofSpan: Map<string, { trackId: string; lane: number }>, byEntity: Map<string, string[]>): TrackNode {
  const lanes = (input.lanes ?? []).map((spans) => ({ spans: [...spans].sort((a, b) => (extentOf(a)?.from ?? 0) - (extentOf(b)?.from ?? 0)) }));
  const children = (input.children ?? []).map((c) => build(c, depth + 1, input.id, byId, ofSpan, byEntity));
  lanes.forEach((lane, i) =>
    lane.spans.forEach((s) => {
      ofSpan.set(s.id, { trackId: input.id, lane: i });
      const list = byEntity.get(s.entity) ?? [];
      if (!list.includes(input.id)) list.push(input.id);
      byEntity.set(s.entity, list);
    }),
  );
  const own = lanes.reduce((n, l) => n + l.spans.length, 0);
  const node: TrackNode = {
    id: input.id,
    kind: input.kind,
    ref: input.ref ?? null,
    label: input.label,
    detail: input.detail ?? null,
    depth,
    parentId,
    children,
    lanes,
    ribbons: [...(input.ribbons ?? [])].sort((a, b) => (extentOf(a)?.from ?? 0) - (extentOf(b)?.from ?? 0)),
    spanCount: own + children.reduce((n, c) => n + c.spanCount, 0),
    attention: input.attention ?? "none",
    ...(input.counts ? { counts: input.counts } : {}),
    note: input.note ?? null,
  };
  byId.set(node.id, node);
  return node;
}

export function makeTree(roots: NodeInput[], extraEntities: Record<string, string> = {}): TrackTree {
  const byId = new Map<string, TrackNode>();
  const ofSpan = new Map<string, { trackId: string; lane: number }>();
  const byEntity = new Map<string, string[]>();
  const built = roots.map((r) => build(r, 0, null, byId, ofSpan, byEntity));
  for (const [ref, track] of Object.entries(extraEntities)) byEntity.set(ref, [track, ...(byEntity.get(ref) ?? [])]);
  return { grouping: "product", roots: built, byId, ofSpan, tracksOf: (ref: string) => byEntity.get(ref) ?? [] };
}

/** The proof's own row layout: expanded nodes open, one row per lane, binary-searched slices. */
export function layoutOf(tree: TrackTree, expanded: ReadonlySet<string>): RowLayout {
  const rows: FlatRow[] = [];
  let y = 0;
  const walk = (node: TrackNode) => {
    const open = expanded.has(node.id);
    const n = Math.max(1, node.lanes.length);
    for (let lane = 0; lane < n; lane++) {
      const height = ROW_HEIGHT[node.kind];
      rows.push({ node, lane, y, height, expanded: open, hasChildren: node.children.length > 0 });
      y += height;
    }
    if (open) node.children.forEach(walk);
  };
  tree.roots.forEach(walk);
  const ids = new Map(rows.map((r) => [`${r.node.id}#${r.lane}`, r]));
  return {
    rows,
    totalHeight: y,
    slice(top, bottom) {
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const r = rows[mid]!;
        if (r.y + r.height <= top) lo = mid + 1;
        else hi = mid;
      }
      const out: FlatRow[] = [];
      for (let i = lo; i < rows.length && rows[i]!.y < bottom; i++) out.push(rows[i]!);
      return out;
    },
    rowOf: (id, lane = 0) => ids.get(`${id}#${lane}`) ?? null,
  };
}

// ---------------------------------------------------------------- the story

export interface ProofFixture {
  readonly tree: TrackTree;
  readonly marks: readonly TimelineMark[];
  readonly expanded: readonly string[];
  readonly selection: EntityRef;
}

function mark(id: string, kind: TimelineMark["kind"], t: number, entity: string, label: string, verdict: string | null = null, until: number | null = null): TimelineMark {
  return { id, kind, at: t, until, eventId: null, entity, label, verdict, authority: "authoritative" };
}

export function proofFixture(): ProofFixture {
  const r = rng(31);
  const T = (min: number, sec = 0) => T0 + min * M + sec * S;
  const ticket = { ticket: "LOCAL-031" };

  // LOCAL-031: two rounds; the second build interrupted and taken up again.
  const groom = span("visit:LOCAL-031/groom#1", "visit", at(T(2, 4)), at(T(9, 41)), { outcome: "completed", attrs: { action: "groom" }, ids: ticket });
  const plan = span("visit:LOCAL-031/plan#1", "visit", at(T(9, 41)), at(T(13, 5), { basis: "inferred", rule: "plan-end-at-first-build-task" }), { outcome: "completed", attrs: { action: "plan" }, ids: ticket, authority: "reconstructed" });
  const build1 = span("visit:LOCAL-031/build#1", "visit", at(T(13, 5)), at(T(27, 48)), { outcome: "completed", attrs: { action: "build", round: 1 }, ids: ticket });
  const verify1 = span("visit:LOCAL-031/verify#1", "visit", at(T(28, 2)), at(null, { notBefore: T(33, 10), notAfter: T(34, 40), precision: "bounded" }), { outcome: "failed", basis: "bounded", attrs: { action: "verify", round: 1 }, ids: ticket, authority: "observed" });
  const build2 = span("visit:LOCAL-031/build#2", "visit", at(T(35, 20)), at(T(46, 52), { reason: "interrupted" }), { outcome: "interrupted", attrs: { action: "build", round: 2 }, ids: ticket, authority: "observed" });
  const build2b = span("visit:LOCAL-031/build#2b", "visit", at(T(52, 30)), at(T(61, 10)), { outcome: "completed", attrs: { action: "build", round: 2 }, ids: ticket, entity: "visit:LOCAL-031/build#2b" });
  const verify2 = span("visit:LOCAL-031/verify#2", "visit", at(T(61, 30)), null, { attrs: { action: "verify", round: 2 }, ids: ticket, authority: "observed" });
  const round1 = span("round:LOCAL-031#1", "round", at(T(13, 5)), at(T(34, 40)), { outcome: "rejected", attrs: { round: 1 } });
  const round2 = span("round:LOCAL-031#2", "round", at(T(35, 20)), null, { attrs: { round: 2 } });
  const cell31 = span("cell:LOCAL-031", "cell", at(T(1, 30)), null, { attrs: {} });

  const depWait = span("slice-wait:SLICE-021#1", "slice-wait", at(T(0, 0)), at(T(1, 10)), { ids: ticket });
  const capWait = span("capacity-wait:LOCAL-031#1", "capacity-wait", at(T(34, 40)), at(T(35, 20)), { ids: ticket });
  const person = span("person-wait:LOCAL-031/override#1", "person-wait", at(T(46, 52)), at(T(52, 30)), { ids: ticket, outcome: "approved", attrs: { label: "Override the scope gate" } });
  const lateWait = span("slice-wait:SLICE-021#2", "slice-wait", null, at(T(66, 0)), { ids: ticket, basis: "unknown" });

  // Review seats in round 1 (closed by default: a collapsed group shows its density strip).
  const seat = (name: string, model: string, a: number, b: number, vote: string, t = "LOCAL-031") =>
    span(`seat:${t}/review#1/${name}`, "seat", at(T(a)), at(T(b), vote === "REJECT" ? { reason: "refused" } : {}), { outcome: vote, attrs: { model, vote, round: 1 }, ids: { ticket_id: t, seat: name } });

  // Execution ex-031-2: claim, workflow, agents and their queue waits, and the builder's tool calls.
  const exStart = T(35, 2);
  const exec2 = span("execution:ex-031-2", "execution", at(exStart), at(T(46, 52), { reason: "interrupted" }), { outcome: "interrupted", attrs: { attempt: 2 }, ids: ticket, authority: "observed" });
  const exec3 = span("execution:ex-031-3", "execution", at(T(52, 20)), null, { attrs: { attempt: 3 }, ids: ticket, authority: "observed" });
  const exec1 = span("execution:ex-031-1", "execution", at(T(12, 50)), at(T(34, 40)), { outcome: "completed", attrs: { attempt: 1 }, ids: ticket, authority: "observed" });
  const claim = span("claim:ex-031-3", "claim", at(T(52, 20)), null, { authority: "observed" });
  const workflow = span("workflow:ex-031-3", "workflow", at(T(52, 26)), null, { attrs: { label: "mach-belt" }, authority: "observed" });
  const q = (id: string, a: number, b: number) => span(`agent-queue:${id}`, "agent-queue", at(a), at(b), { authority: "observed" });
  const planner = span("agent:ag-03-planner", "agent", at(T(52, 31)), at(T(54, 2)), { outcome: "completed", attrs: { label: "planner", model: "fable" }, authority: "observed" });
  const builder = span("agent:ag-03-builder", "agent", at(T(54, 20)), at(T(61, 6)), { outcome: "completed", attrs: { label: "builder", model: "sonnet", toolCalls: 260 }, authority: "observed" });
  const reviewer = span("agent:ag-03-reviewer", "agent", at(T(54, 40)), at(T(60, 30)), { outcome: "completed", attrs: { label: "security reviewer", model: "opus", toolCalls: 17, toolsCountOnly: true }, authority: "observed" });
  const linter = span("agent:ag-03-lint", "agent", at(T(61, 40)), null, { attrs: { label: "lint", model: "haiku" }, authority: "observed" });
  const tools: TimelineSpan[] = [];
  let t = T(54, 24);
  for (let i = 0; i < 260 && t < T(61, 4); i++) {
    const len = 200 + Math.floor(r() * 2600);
    const failed = i === 41 || i === 173;
    tools.push(span(`tool:ag-03-builder/${i}`, "tool", at(t), at(t + len, failed ? { reason: "failed" } : {}), { outcome: failed ? "failed" : "completed", attrs: { label: ["Read", "Edit", "Bash", "Grep", "Write"][i % 5]! }, authority: "observed" }));
    t += len + 300 + Math.floor(r() * 1400);
  }

  // Build tasks: many short spans; at a wide zoom they merge into a density run.
  const tasks: TimelineSpan[] = [];
  let k = T(13, 20);
  for (let i = 0; i < 140; i++) {
    const len = 1500 + Math.floor(r() * 9000);
    tasks.push(span(`task:LOCAL-031/${i}`, "task", at(k), at(k + len), { outcome: "completed", attrs: { label: `T${i + 1}` } }));
    k += len + 500 + Math.floor(r() * 2500);
    if (k > T(27, 40)) break;
  }

  // The grammar reference: one visit per basis, side by side.
  const g = (name: string, s: SpanEnd | null, e: SpanEnd | null, o: SpanOptions = {}) => span(`visit:GRAMMAR/${name}`, "visit", s, e, { attrs: { action: o.attrs?.action ?? "build", ...o.attrs }, ...o, outcome: o.outcome ?? null });
  const grammar = [
    { id: "measured", label: "Measured", detail: "both ends recorded", s: g("measured", at(T(40)), at(T(48, 12)), { outcome: "completed", attrs: { action: "verify" } }) },
    { id: "bounded", label: "Bounded", detail: "end within bounds", s: g("bounded", at(T(40)), at(null, { notBefore: T(46, 10), notAfter: T(48, 14), precision: "bounded" }), { basis: "bounded", outcome: "completed", authority: "observed" }) },
    { id: "inferred", label: "Inferred", detail: "end placed by a rule", s: g("inferred", at(T(40)), at(T(48), { basis: "inferred", rule: "visit-end-at-next-visit" }), { outcome: "completed", authority: "reconstructed", attrs: { action: "plan" } }) },
    { id: "open", label: "Open", detail: "running at the live edge", s: g("open", at(T(62)), null, { authority: "observed", attrs: { action: "review" } }) },
    { id: "unknown-start", label: "Unknown start", detail: "only the end is recorded", s: g("unknown-start", null, at(T(47, 30)), { basis: "unknown", attrs: { action: "audit" } }) },
    { id: "unknown-end", label: "Unknown end", detail: "the end applies, unrecorded", s: g("unknown-end", at(T(41)), at(null), { basis: "unknown", attrs: { action: "merge" } }) },
    { id: "interrupted", label: "Interrupted", detail: "stopped, taken up again", s: g("interrupted", at(T(40)), at(T(44, 30), { reason: "interrupted" }), { outcome: "interrupted", authority: "observed" }) },
    { id: "simulated", label: "Simulated", detail: "authority: the fixture", s: g("simulated", at(T(40)), at(T(47, 40)), { outcome: "failed", authority: "simulated", attrs: { action: "verify" } }) },
  ];
  // Ended without an exit record: its execution ended first; closed at that bound, never running.
  const noExitRaw = g("no-exit", at(T(40)), at(T(46, 30), { basis: "inferred", rule: "execution-ended", reason: "interrupted" }), { authority: "reconstructed", attrs: { action: "build", round: 2 } });
  const noExit: TimelineSpan = { ...noExitRaw, duration: { ms: null, minMs: null, maxMs: T(46, 30) - T(40), basis: "inferred" } };
  grammar.push({ id: "no-exit", label: "No exit record", detail: "closed at its execution's end", s: noExit });
  // The interrupted one is taken up again later on its row.
  const resumed = g("interrupted-resumed", at(T(49, 10)), at(T(55, 20)), { outcome: "completed", authority: "observed" });

  // LOCAL-032: a collapsed cell whose subtree failed.
  const cell32Visits = ["groom", "plan", "build", "verify"].map((st, i) =>
    span(`visit:LOCAL-032/${st}#1`, "visit", at(T(6 + i * 9)), at(T(6 + i * 9 + 8), st === "verify" ? { reason: "failed" } : {}), { outcome: st === "verify" ? "failed" : "completed", attrs: { action: st }, ids: { ticket: "LOCAL-032" } }),
  );
  const cell32 = span("cell:LOCAL-032", "cell", at(T(5, 40)), at(T(42, 30)), { outcome: "blocked" });
  // LOCAL-029: approved by its panel and by a person, then merged by the line.
  const t29 = { ticket_id: "LOCAL-029" };
  const review29 = span("visit:LOCAL-029/review#1", "visit", at(T(36)), at(T(41, 10)), { outcome: "approved", attrs: { action: "review", round: 1 }, ids: { ...t29, station: "review" } });
  const human29 = span("person-wait:LOCAL-029/human-approval#1", "person-wait", at(T(41, 20)), at(T(47, 40)), { outcome: "human.approval_recorded", ids: t29, entity: "gate:LOCAL-029/human-approval#1" });
  const merge29 = span("visit:LOCAL-029/merge#1", "visit", at(T(48, 10)), at(T(49, 30)), { outcome: "merged", attrs: { action: "merge" }, ids: { ...t29, station: "merge" } });
  const cell29 = span("cell:LOCAL-029", "cell", at(T(34)), at(T(49, 30)), { outcome: "merged" });
  // SLICE-025: waits on a person.
  const s25 = span("slice-wait:SLICE-025#1", "slice-wait", at(T(3)), at(T(31)), {});
  const s25p = span("person-wait:SLICE-025/approve#1", "person-wait", at(T(31)), null, { attrs: { label: "Approve the wave" } });

  const roots: NodeInput[] = [
    {
      id: "wave:WAVE-007",
      kind: "wave",
      label: "WAVE-007",
      detail: "Checkout, second wave",
      ref: "wave:WAVE-007",
      // Its OWN condition (open); what happened beneath it is counted, never worn.
      attention: "open",
      counts: { rejected: 1, failed: 2, interrupted: 2, waitingPerson: 2 },
      lanes: [[span("wave:WAVE-007", "wave", at(T(0)), null)]],
      children: [
        {
          id: "slice:SLICE-021",
          kind: "slice",
          label: "SLICE-021",
          detail: "Saved addresses",
          ref: "slice:SLICE-021",
          attention: "open",
          counts: { rejected: 1, failed: 2, interrupted: 2, waitingPerson: 1 },
          children: [
            {
              id: "cell:LOCAL-031",
              kind: "cell",
              label: "LOCAL-031",
              detail: "Round 2, verifying",
              ref: "cell:LOCAL-031",
              attention: "open",
              counts: { rejected: 1, failed: 1, interrupted: 2, waitingPerson: 1, open: 1 },
              lanes: [[cell31]],
              ribbons: [exec1, exec2, exec3],
              children: [
                { id: "cell:LOCAL-031/rounds", kind: "rounds", label: "Rounds", lanes: [[round1, round2]] },
                { id: "station:LOCAL-031/groom", kind: "station", label: "Groom", lanes: [[groom]] },
                { id: "station:LOCAL-031/plan", kind: "station", label: "Plan", lanes: [[plan]] },
                {
                  id: "station:LOCAL-031/build",
                  kind: "station",
                  label: "Build",
                  detail: "2 rounds",
                  counts: { interrupted: 2 },
                  lanes: [[build1, build2, build2b]],
                  children: [{ id: "station:LOCAL-031/build/tasks", kind: "tools", label: "Tasks", detail: `${tasks.length} recorded`, lanes: [tasks] }],
                },
                { id: "station:LOCAL-031/verify", kind: "station", label: "Verify", attention: "open", counts: { failed: 1, open: 1 }, lanes: [[verify1, verify2]] },
                { id: "cell:LOCAL-031/waits", kind: "waits", label: "Waits", attention: "person", lanes: [[depWait, capWait, person, lateWait]] },
                {
                  id: "cell:LOCAL-031/review",
                  kind: "review",
                  label: "Review",
                  detail: "round 1",
                  children: [
                    { id: "seat:LOCAL-031/review#1/architecture", kind: "seat", label: "Architecture", detail: "Sonnet", lanes: [[seat("architecture", "sonnet", 29, 31.5, "APPROVE")]] },
                    { id: "seat:LOCAL-031/review#1/security", kind: "seat", label: "Security", detail: "Opus", lanes: [[seat("security", "opus", 29, 33, "REJECT")]] },
                    { id: "seat:LOCAL-031/review#1/product", kind: "seat", label: "Product", detail: "Sonnet", lanes: [[seat("product", "sonnet", 29.2, 32, "APPROVE")]] },
                  ],
                },
                { id: "cell:LOCAL-031/verification", kind: "verification", label: "Verification", note: "not recorded" },
              ],
            },
            {
              id: "cell:LOCAL-032",
              kind: "cell",
              label: "LOCAL-032",
              detail: "Blocked, escalated",
              ref: "cell:LOCAL-032",
              attention: "failed",
              lanes: [[cell32]],
              children: cell32Visits.map((v) => ({ id: `station:LOCAL-032/${v.attrs.action}`, kind: "station" as const, label: (v.attrs.action ?? "").replace(/^./, (c) => c.toUpperCase()), lanes: [[v]] })),
            },
          ],
        },
        {
          id: "cell:LOCAL-029",
          kind: "cell",
          label: "LOCAL-029",
          detail: "Approved, merged",
          ref: "cell:LOCAL-029",
          lanes: [[cell29]],
          children: [
            { id: "station:LOCAL-029/review", kind: "station", label: "Review", lanes: [[review29]] },
            {
              id: "cell:LOCAL-029/review",
              kind: "review",
              label: "Review seats",
              detail: "round 1",
              children: [
                { id: "seat:LOCAL-029/review#1/architecture", kind: "seat", label: "Architecture", detail: "Sonnet", lanes: [[seat("architecture", "sonnet", 36.2, 38.4, "APPROVE", "LOCAL-029")]] },
                { id: "seat:LOCAL-029/review#1/security", kind: "seat", label: "Security", detail: "Opus", lanes: [[seat("security", "opus", 36.2, 40.6, "APPROVE", "LOCAL-029")]] },
              ],
            },
            { id: "cell:LOCAL-029/waits", kind: "waits", label: "Person", detail: "approval of the review", lanes: [[human29]] },
            { id: "station:LOCAL-029/merge", kind: "station", label: "Merge", lanes: [[merge29]] },
          ],
        },
        { id: "slice:SLICE-025", kind: "slice", label: "SLICE-025", detail: "Waiting for a person", ref: "slice:SLICE-025", attention: "person", lanes: [[s25, s25p]], children: [{ id: "slice:SLICE-025/waits", kind: "waits", label: "Waits", lanes: [[s25, s25p]] }] },
      ],
    },
    {
      id: "execution:ex-031-3",
      kind: "execution",
      label: "ex-031-3",
      detail: "Attempt 3 for LOCAL-031",
      ref: "execution:ex-031-3",
      attention: "open",
      lanes: [[exec3]],
      ribbons: [build2b, verify2],
      children: [
        { id: "execution:ex-031-3/claim", kind: "claim", label: "Claim", lanes: [[claim]] },
        {
          id: "execution:ex-031-3/workflow",
          kind: "workflow",
          label: "Workflow",
          detail: "mach-belt",
          lanes: [[workflow]],
          children: [
            { id: "agent:ag-03-planner", kind: "agent", label: "planner", detail: "Fable", lanes: [[q("ag-03-planner", T(52, 27), T(52, 31)), planner]] },
            {
              id: "agent:ag-03-builder",
              kind: "agent",
              label: "builder",
              detail: "Sonnet",
              lanes: [[q("ag-03-builder", T(54, 4), T(54, 20)), builder]],
              children: [{ id: "agent:ag-03-builder/tools", kind: "tools", label: "Tool calls", detail: `${tools.length}`, lanes: [tools] }],
            },
            { id: "agent:ag-03-reviewer", kind: "agent", label: "security reviewer", note: "17 tool calls, not observable one by one", lanes: [[q("ag-03-reviewer", T(54, 4), T(54, 40)), reviewer]] },
            { id: "agent:ag-03-lint", kind: "agent", label: "lint", detail: "Haiku", attention: "open", lanes: [[q("ag-03-lint", T(61, 12), T(61, 40)), linter]] },
          ],
        },
      ],
    },
    {
      id: "grammar",
      kind: "factory",
      label: "Timing grammar",
      detail: "one visit per basis",
      children: grammar.map((x) => ({ id: `grammar/${x.id}`, kind: "station" as const, label: x.label, detail: x.detail, lanes: [x.id === "interrupted" ? [x.s, resumed] : [x.s]] })),
    },
  ];

  const tree = makeTree(roots, {
    "gate:LOCAL-031/verification#1": "station:LOCAL-031/verify",
    "gate:LOCAL-031/scope#2": "cell:LOCAL-031/waits",
    "review:LOCAL-031#1": "cell:LOCAL-031/rounds",
    "human:LOCAL-031/override": "cell:LOCAL-031/waits",
    "retry:LOCAL-031#2": "execution:ex-031-3",
    "gate:LOCAL-029/human-approval#1": "cell:LOCAL-029/waits",
  });
  // Two executions of the same cell appear as ribbons; the one in this grouping is also a row.
  const marks: TimelineMark[] = [
    mark("m1", "gate", T(27, 55), "gate:LOCAL-031/verification#1", "Verification gate passed for LOCAL-031", "passed"),
    mark("m2", "failure", T(34, 40), "gate:LOCAL-031/verification#1", "Verification failed for LOCAL-031"),
    mark("m3", "review", T(33, 20), "review:LOCAL-031#1", "Review round 1 rejected LOCAL-031", "rejected"),
    mark("m4", "gate", T(46, 52), "gate:LOCAL-031/scope#2", "The scope gate refused LOCAL-031", "refused"),
    mark("m5", "human", T(47, 10), "human:LOCAL-031/override", "A person was asked to override the scope gate", "required"),
    mark("m6", "human", T(52, 20), "human:LOCAL-031/override", "A person overrode the scope gate", "approved"),
    mark("m7", "gate", T(52, 24), "gate:LOCAL-031/scope#2", "The scope gate let LOCAL-031 through on an override", "overridden"),
    mark("m8", "retry", T(52, 20), "retry:LOCAL-031#2", "Execution retried as attempt 3"),
    mark("m9", "review", T(41, 10), "cell:LOCAL-029", "Review round 1 approved LOCAL-029", "approved"),
    mark("m10", "human", T(47, 40), "cell:LOCAL-029", "A person approved the review", "approved"),
    mark("m11", "merge", T(49, 30), "cell:LOCAL-029", "LOCAL-029 was merged.", null),
  ];

  const expanded = ["wave:WAVE-007", "slice:SLICE-021", "cell:LOCAL-031", "cell:LOCAL-031/review", "cell:LOCAL-029", "cell:LOCAL-029/review", "station:LOCAL-031/build", "execution:ex-031-3", "execution:ex-031-3/workflow", "agent:ag-03-builder", "grammar"];
  return { tree, marks, expanded, selection: "visit:LOCAL-031/build#2b" as EntityRef };
}

/** The benchmark's tree: `rows` rows, each with `perRow` spans over [from, to], every one at least 2 px wide at `width`. */
export function benchTree(rows: number, perRow: number, from: number, to: number): TrackTree {
  const r = rng(7);
  const kinds: SpanKind[] = ["visit", "execution", "agent", "workflow", "slice-wait", "person-wait", "task", "claim"];
  const step = (to - from) / perRow;
  const nodes: NodeInput[] = [];
  for (let i = 0; i < rows; i++) {
    const kind = kinds[i % kinds.length]!;
    const spans: TimelineSpan[] = [];
    for (let j = 0; j < perRow; j++) {
      const a = from + j * step + r() * step * 0.1;
      const b = a + step * (0.55 + r() * 0.3);
      const basis = j % 9 === 0 ? "inferred" : j % 11 === 0 ? "bounded" : "measured";
      const end = basis === "bounded" ? at(null, { notBefore: b - step * 0.1, notAfter: b, precision: "bounded" }) : at(b, basis === "inferred" ? { basis: "inferred", rule: "bench" } : {});
      spans.push(span(`b:${i}:${j}`, kind, at(a), end, { outcome: j % 7 === 0 ? "failed" : "completed", attrs: { label: `${kind} ${j}`, model: "sonnet", action: "build" } }));
    }
    nodes.push({ id: `bench/${i}`, kind: "station", label: `Row ${i + 1}`, lanes: [spans] });
  }
  return makeTree(nodes);
}
