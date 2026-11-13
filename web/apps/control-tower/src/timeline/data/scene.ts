/**
 * Spans from a scene: the same shape the observer's `/api/v1/spans` serves, derived from what the
 * scene holds (cells' visits, rounds, tasks, review seats, gates for a person, executions, their
 * workflow, agents and per-call tools, slice waits, capacity waits). Used by the simulation, which
 * has no observer. Pure: the same scene and log give the same spans.
 *
 * Honesty: an end and an outcome exist only when the scene recorded them; a count-only agent yields
 * no `tool` span; nothing is placed to fill a gap. Each end names the event that bounds it when the
 * log holds one at that moment for that entity.
 */
import type {
  AgentState,
  Authority,
  CellState,
  EntityMeta,
  ExecutionState,
  LogEntry,
  Precision,
  Scene,
  SceneLog,
  StationVisit,
} from "../../sim";
import type { DurationBasis, SpanAttrs, SpanAuthority, SpanEnd, SpanEndReason, SpanKind, SpanPrecision, TimelineMark, TimelineSpan } from "../contract";

interface EndInput {
  readonly at: number | null;
  /** Refs whose log entries may hold the bounding event. */
  readonly refs?: readonly string[];
  /** The event, when the scene names it. */
  readonly eventId?: string | null;
  readonly basis?: "recorded" | "inferred";
  readonly rule?: string | null;
  readonly reason?: SpanEndReason | null;
}

interface SpanInput {
  readonly kind: SpanKind;
  readonly entity: string;
  /** Defaults to `<kind>:<entity>`. */
  readonly id?: string;
  readonly parent: string | null;
  readonly ids: Readonly<Record<string, string | number | null | undefined>>;
  readonly start: EndInput | null;
  readonly end: EndInput | null;
  readonly outcome?: string | null;
  readonly authority: Authority;
  readonly attrs?: SpanAttrs;
  /** A recorded duration (more exact than the difference of the ends). */
  readonly durationMs?: number | null;
  /** The whole duration, when it is not the difference of the ends (a visit closed by rule: bounded, never measured). */
  readonly duration?: TimelineSpan["duration"];
}

const PRECISIONS: readonly SpanPrecision[] = ["ms", "s", "arrival", "bounded", "unknown", "simulated"];

/** Finds the log entry at time `t` for any of `refs` (the bounding event of a span end). */
function eventFinder(log: SceneLog | null): (refs: readonly string[], t: number) => LogEntry | null {
  const held = new Map<string, readonly LogEntry[]>();
  return (refs, t) => {
    if (!log) return null;
    for (const r of refs) {
      let list = held.get(r);
      if (!list) {
        list = log.entriesFor(r as Parameters<SceneLog["entriesFor"]>[0]);
        held.set(r, list);
      }
      for (const e of list) if (e.t === t) return e;
    }
    return null;
  };
}

/** Derive every span the scene supports, ordered by start. */
export function spansOfScene(scene: Scene, log: SceneLog | null = null): TimelineSpan[] {
  const find = eventFinder(log);
  const simulated = scene.provenance.source === "simulation";
  const out: TimelineSpan[] = [];

  const end = (input: EndInput | null, isEnd: boolean): SpanEnd | null => {
    if (!input || input.at === null) return null;
    const entry = input.eventId ? (log?.entry(input.eventId) ?? null) : input.refs ? find(input.refs, input.at) : null;
    const eventId = input.eventId ?? entry?.id ?? null;
    let precision: SpanPrecision = simulated ? "simulated" : "unknown";
    const p: Precision | "simulated" | undefined = entry?.precision;
    if (!simulated && p && (PRECISIONS as readonly string[]).includes(p)) precision = p as SpanPrecision;
    return { eventId, at: input.at, precision, notBefore: null, notAfter: null, basis: input.basis ?? "recorded", rule: input.rule ?? null, reason: isEnd ? (input.reason ?? "completed") : null };
  };

  const add = (s: SpanInput): void => {
    const start = end(s.start, false);
    const stop = end(s.end, true);
    if (!start && !stop) return;
    let basis: DurationBasis;
    let ms: number | null = null;
    if (!stop) basis = start ? "open" : "unknown";
    else if (!start || start.at === null || stop.at === null) basis = "unknown";
    else {
      ms = s.durationMs ?? Math.max(0, stop.at - start.at);
      basis = start.basis === "inferred" || stop.basis === "inferred" ? "inferred" : "measured";
    }
    const ids: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.ids)) if (v !== null && v !== undefined && v !== "") ids[k] = String(v);
    out.push({
      id: s.id ?? `${s.kind}:${s.entity}`,
      kind: s.kind,
      entity: s.entity,
      parent: s.parent,
      ids,
      start,
      end: stop,
      duration: s.duration ?? { ms, minMs: ms, maxMs: ms, basis },
      outcome: stop ? (s.outcome ?? null) : null,
      authority: s.authority as SpanAuthority,
      attrs: s.attrs ?? {},
    });
  };

  const waveOfSlice = (sliceId: string | null | undefined): string | null => (sliceId ? (scene.slices[sliceId]?.waveId ?? null) : null);

  // ---- waves: from discovery to the last integration, once every slice is integrated.
  for (const w of Object.values(scene.waves)) {
    const slices = w.sliceIds.map((id) => scene.slices[id]);
    const integratedAt = slices.map((sl) => sl?.history.find((h) => h.state === "integrated")?.at ?? null);
    const done = slices.length > 0 && integratedAt.every((t) => t !== null);
    add({
      kind: "wave",
      entity: `wave:${w.id}`,
      parent: null,
      ids: { wave_id: w.id },
      start: { at: w.discoveredAt, refs: [`wave:${w.id}`], eventId: simulated ? `sim:${w.seq}` : w.meta.eventId || null },
      end: done ? { at: Math.max(...(integratedAt as number[])), refs: w.sliceIds.map((id) => `slice:${id}`) } : null,
      authority: w.meta.authority,
    });
  }

  // ---- slices: every wait for a dependency and every stretch of eligibility, from the scheduler's history.
  for (const sl of Object.values(scene.slices)) {
    const ref = `slice:${sl.id}`;
    const ids = { slice_id: sl.id, wave_id: sl.waveId, ticket_id: sl.ticketId };
    let waits = 0;
    let eligible = 0;
    sl.history.forEach((h, i) => {
      const next = sl.history[i + 1] ?? null;
      const last = next === null;
      const startEnd: EndInput = { at: h.at, refs: [ref], eventId: simulated ? `sim:${h.seq}` : null };
      const stop: EndInput | null = next ? { at: next.at, refs: [ref], eventId: simulated ? `sim:${next.seq}` : null } : null;
      if (h.state === "waiting-on-dependency") {
        waits += 1;
        add({
          kind: "slice-wait",
          entity: ref,
          id: `slice-wait:${ref}${waits > 1 ? `#${waits}` : ""}`,
          parent: ref,
          ids,
          start: startEnd,
          end: stop,
          authority: sl.meta.authority,
          // The scheduler's reasons are the latest ones: only the latest wait can carry them.
          attrs: { dependsOn: sl.dependsOn, ...(last ? { reasons: sl.reasons } : {}) },
        });
      } else if (h.state === "eligible") {
        eligible += 1;
        add({
          kind: "slice-eligible",
          entity: ref,
          id: `slice-eligible:${ref}${eligible > 1 ? `#${eligible}` : ""}`,
          parent: ref,
          ids,
          start: startEnd,
          end: stop,
          authority: sl.meta.authority,
        });
      }
    });
  }

  // ---- cells and what happened in them.
  for (const c of Object.values(scene.cells)) cellSpans(c);

  // ---- executions, their claim, workflow, agents and tools.
  for (const x of Object.values(scene.executions)) executionSpans(x);
  for (const agent of Object.values(scene.strayAgents)) agentSpans(agent, null);

  // ---- waits for an execution place (live; still waiting: released ones are not kept by the scene).
  for (const w of Object.values(scene.capacityWaits)) {
    add({
      kind: "capacity-wait",
      entity: `cell:${w.ticketId}`,
      // As the observer names it: one id per wait, by the event that opened it.
      id: `capacity-wait:cell:${w.ticketId}@${w.eventId}`,
      parent: `cell:${w.ticketId}`,
      ids: { ticket_id: w.ticketId, slice_id: w.sliceId, wave_id: waveOfSlice(w.sliceId), execution_id: w.executionId },
      start: { at: w.since, eventId: w.eventId },
      end: null,
      authority: "reconstructed",
      attrs: w.limit !== null ? { reasons: [`limit ${w.limit} (${w.scope})`] } : {},
    });
  }

  // ---- a person needed (human.required), still waiting: the scene keeps only open ones.
  for (const [key, a] of Object.entries(scene.supervisor.attention)) {
    const cell = scene.cells[key];
    const entity = cell ? `cell:${key}` : `slice:${key}`;
    add({
      kind: "person-wait",
      entity: `gate:${key}/human-required`,
      parent: entity,
      ids: cell ? { ticket_id: key, slice_id: cell.sliceId, wave_id: waveOfSlice(cell.sliceId) } : { slice_id: key, wave_id: waveOfSlice(key) },
      start: { at: a.at, eventId: simulated ? `sim:${a.seq}` : null, refs: [entity] },
      end: null,
      authority: simulated ? "simulated" : "observed",
      attrs: { reasons: [a.reason] },
    });
  }

  out.sort((a, b) => (a.start?.at ?? a.end?.at ?? 0) - (b.start?.at ?? b.end?.at ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;

  function cellSpans(c: CellState): void {
    const t = c.ticketId;
    const cellRef = `cell:${t}`;
    const base = { ticket_id: t, slice_id: c.sliceId, wave_id: waveOfSlice(c.sliceId), cell_instance: c.cellInstance };
    const outcomeEnd = c.merged ? { at: c.merged.at, outcome: "merged", reason: "completed" as const } : c.runRecord ? { at: c.runRecord.at, outcome: c.runRecord.outcome, reason: c.runRecord.outcome === "abandoned" ? ("superseded" as const) : ("completed" as const) } : null;
    add({
      kind: "cell",
      entity: cellRef,
      parent: null,
      ids: base,
      start: { at: c.openedAt, refs: [cellRef] },
      end: outcomeEnd ? { at: outcomeEnd.at, refs: [cellRef], reason: outcomeEnd.reason } : null,
      outcome: outcomeEnd?.outcome ?? null,
      authority: c.meta.authority,
    });

    // Visits, numbered per station as the lifecycle log numbers them (`<ticket>/<station>#<n>`).
    const perStation = new Map<string, number>();
    const visitIds: { visit: StationVisit; id: string }[] = [];
    for (const v of c.visits) {
      const n = (perStation.get(v.station) ?? 0) + 1;
      perStation.set(v.station, n);
      const vid = v.visitId ?? `${t}/${v.station}#${n}`;
      visitIds.push({ visit: v, id: vid });
      const stationRef = `station:${t}/${v.station}`;
      const refs = [`visit:${vid}`, stationRef, cellRef];
      const unclosed = v.unclosed;
      add({
        kind: "visit",
        entity: `visit:${vid}`,
        parent: v.executionId ? `execution:${v.executionId}` : null,
        ids: { ...base, visit_id: vid, station: v.station, round: v.round, execution_id: v.executionId },
        start: { at: v.enteredAt, refs, eventId: simulated ? `sim:${v.enteredSeq}` : null },
        end:
          v.leftAt === null
            ? null
            : unclosed
              ? { at: unclosed.at, eventId: unclosed.eventId, basis: "inferred", rule: unclosed.reason === "superseded" ? "unclosed-visit" : "execution-ended", reason: unclosed.reason === "superseded" ? "superseded" : "interrupted" }
              : { at: v.leftAt, refs, reason: v.outcome === "failed" ? "failed" : "completed" },
        // A visit the scene closed by inference (the observer's rule, apps/observer spans.go) has no
        // outcome, is reconstructed, and its length is only bounded: at most entry to the bound.
        outcome: unclosed ? null : (v.outcomeWord ?? v.outcome),
        authority: unclosed && v.meta.authority !== "simulated" ? "reconstructed" : v.meta.authority,
        durationMs: unclosed ? null : v.durationMs,
        ...(unclosed && v.leftAt !== null ? { duration: { ms: null, minMs: null, maxMs: Math.max(0, unclosed.at - v.enteredAt), basis: "inferred" as const } } : {}),
        attrs: { action: v.action, round: v.round, ...(v.interrupted ? { interruptedAt: v.interrupted.at } : {}) },
      });
    }

    // Rounds: from the round's first visit to the verdict that ended it.
    const rounds = new Map<number, number>();
    for (const v of c.visits) if (!rounds.has(v.round)) rounds.set(v.round, v.enteredAt);
    for (const [n, startAt] of rounds) {
      const failedVerification = c.verifications.find((x) => x.round === n && x.decidedAt !== null && x.status !== "running" && x.status !== "PASS");
      const review = c.reviews.find((r) => r.round === n && r.decidedAt !== null);
      const endOf = failedVerification
        ? { at: failedVerification.decidedAt as number, outcome: failedVerification.status as string, eventId: null }
        : review
          ? { at: review.decidedAt as number, outcome: review.outcome as string, eventId: review.decidedEventId }
          : null;
      const gate = `gate:${t}/round#${n}`;
      add({
        kind: "round",
        entity: gate,
        parent: cellRef,
        ids: { ...base, round: n },
        start: { at: startAt, refs: [cellRef] },
        end: endOf ? { at: endOf.at, eventId: endOf.eventId, refs: [`gate:${t}/verification#${n}`, `gate:${t}/review#${n}`, cellRef], reason: endOf.outcome === "APPROVED" || endOf.outcome === "AWAITING_HUMAN" ? "completed" : "failed" } : null,
        outcome: endOf?.outcome ?? null,
        authority: c.meta.authority,
        attrs: { round: n },
      });
    }

    // Build tasks, inside the build visit that held them. A start no record gives is placed by rule.
    const sorted = [...c.tasks].sort((a, b) => (a.doneAt ?? a.startedAt) - (b.doneAt ?? b.startedAt));
    let previous: number | null = null;
    for (const task of sorted) {
      const at = task.doneAt ?? task.startedAt;
      const holder = visitIds.find(({ visit }) => visit.station === "build" && visit.enteredAt <= at && (visit.leftAt === null || at <= visit.leftAt)) ?? null;
      const visitRef = holder ? `visit:${holder.id}` : cellRef;
      const startKnown = !task.meta.unknown.includes("startedAt");
      const inferredStart = startKnown ? null : (previous !== null && holder && previous >= holder.visit.enteredAt ? previous : (holder?.visit.enteredAt ?? null));
      add({
        kind: "task",
        entity: `${visitRef}/task:${task.id}`,
        parent: visitRef,
        ids: { ...base, visit_id: holder?.id, task_id: task.id, round: task.loop + 1 },
        start: startKnown ? { at: task.startedAt, refs: [cellRef] } : inferredStart === null ? null : { at: inferredStart, basis: "inferred", rule: "previous-completion" },
        end: task.doneAt === null ? null : { at: task.doneAt, refs: [cellRef] },
        outcome: task.doneAt === null ? null : task.status,
        authority: startKnown ? task.meta.authority : task.meta.authority === "authoritative" ? "reconstructed" : task.meta.authority,
        attrs: { label: task.text, round: task.loop + 1 },
      });
      if (task.doneAt !== null) previous = task.doneAt;
    }

    // Review seats: from the round's start to the seat's verdict.
    for (const r of c.reviews) {
      const gate = `gate:${t}/review#${r.round}`;
      for (const seat of r.seats) {
        const entity = `seat:${t}/review#${r.round}/${seat.seat}`;
        add({
          kind: "seat",
          entity,
          parent: gate,
          ids: { ...base, round: r.round, seat: seat.seat, agent_id: seat.agentId },
          start: { at: r.startedAt, eventId: r.eventId || null, refs: [gate] },
          end: seat.votedAt === null ? null : { at: seat.votedAt, eventId: seat.votedEventId, refs: [gate], reason: seat.vote === "REJECT" ? "refused" : "completed" },
          outcome: seat.vote,
          authority: c.meta.authority,
          attrs: { model: seat.model, round: r.round, ...(seat.vote ? { vote: seat.vote } : {}) },
        });
      }
    }

    // Waits for a person's approval (the human-approval gate).
    for (const g of Object.values(scene.gates)) {
      if (g.ticketId !== t || g.gate !== "human-approval") continue;
      const decided = g.decidedAt !== null && g.state !== "open" && g.state !== "waiting";
      add({
        kind: "gate-wait",
        entity: `gate:${g.id}`,
        parent: cellRef,
        ids: { ...base, round: g.round },
        start: { at: g.openedAt, refs: [`gate:${g.id}`, cellRef], eventId: simulated ? `sim:${g.seq}` : null },
        end: decided ? { at: g.decidedAt as number, refs: [`gate:${g.id}`, cellRef], reason: g.state === "failed" ? "refused" : "completed" } : null,
        outcome: decided ? g.state : null,
        authority: g.meta.authority,
        ...(g.round !== null ? { attrs: { round: g.round } } : {}),
      });
    }

    // Agents of the cell that no execution of the scene holds.
    for (const id of c.agentOrder) {
      const a = c.agents[id];
      if (a && (!a.executionId || !scene.executions[a.executionId])) agentSpans(a, null);
    }
  }

  function executionSpans(x: ExecutionState): void {
    const ref = `execution:${x.id}`;
    const cell = scene.cells[x.ticketId] ?? null;
    const parent = x.ticketId ? `cell:${x.ticketId}` : null;
    const ids = { execution_id: x.id, ticket_id: x.ticketId, slice_id: x.sliceId ?? cell?.sliceId, wave_id: waveOfSlice(x.sliceId ?? cell?.sliceId), attempt: x.attempt };
    const started = x.processStartedAt ?? x.startedAt;
    add({
      kind: "claim",
      entity: ref,
      parent,
      ids,
      start: { at: x.claimedAt, refs: [ref] },
      end: started === null ? null : { at: started, refs: [ref] },
      authority: x.meta.authority,
    });
    const endedAt = x.processEndedAt ?? x.endedAt;
    const failed = x.state === "failed" || x.ended === "could-not-start";
    const interrupted = x.ended === "interrupted" || x.ended === "timed-out";
    add({
      kind: "execution",
      entity: ref,
      parent,
      ids,
      start: started === null ? null : { at: started, refs: [ref] },
      end: endedAt === null ? null : { at: endedAt, refs: [ref], reason: failed ? "failed" : interrupted ? "interrupted" : "completed" },
      outcome: endedAt === null ? null : (x.ended && x.ended !== "exited" ? x.ended : x.state),
      authority: x.meta.authority,
      attrs: {
        attempt: x.attempt,
        state: x.state,
        ...((x.usage?.costUsd ?? x.outcome?.costUsd) !== undefined && (x.usage?.costUsd ?? x.outcome?.costUsd) !== null ? { costUsd: (x.usage?.costUsd ?? x.outcome?.costUsd) as number } : {}),
      },
    });
    const workflowRef = workflowOf(x);
    if (workflowRef && x.startedAt !== null) {
      const finished = x.workflowFinishedAt;
      add({
        kind: "workflow",
        entity: workflowRef,
        parent: ref,
        ids,
        start: { at: x.startedAt, refs: [workflowRef, ref] },
        end: finished === null ? null : { at: finished, refs: [workflowRef, ref], reason: x.workflowStatus === "killed" ? "interrupted" : x.workflowStatus === "unknown" ? "unknown" : "completed" },
        outcome: finished === null ? null : x.workflowStatus,
        authority: (x.workflowMeta ?? x.meta).authority,
        attrs: x.workflow ? { label: x.workflow } : {},
      });
    }
    // Agents a workflow queued and has not started (known by index only).
    for (const q of Object.values(x.queued)) {
      add({
        kind: "agent-queue",
        entity: `agent:${x.id}#${q.index}`,
        parent: workflowRef ?? ref,
        ids: { ...ids, ticket_id: q.ticketId ?? x.ticketId },
        start: { at: q.queuedAt, eventId: q.eventId },
        end: null,
        authority: x.meta.authority,
        attrs: { label: q.label, ...(q.modelName ? { model: q.modelName } : {}) },
      });
    }
    if (cell) for (const id of cell.agentOrder) {
      const a = cell.agents[id];
      if (a && a.executionId === x.id) agentSpans(a, x);
    }
  }

  function workflowOf(x: ExecutionState): string | null {
    if (x.workflowId) return `workflow:${x.workflowId}`;
    return x.workflow ? `workflow:${x.id}/${x.workflow}` : null;
  }

  function agentSpans(a: AgentState, x: ExecutionState | null): void {
    const ref = `agent:${a.id}`;
    const parent = a.parentId ? `agent:${a.parentId}` : a.workflowId ? `workflow:${a.workflowId}` : x ? (workflowOf(x) ?? `execution:${x.id}`) : a.ticketId ? `cell:${a.ticketId}` : null;
    const countOnly = a.observation === "count-only";
    const ended = a.finishedAt !== null && a.lifecycle !== "running" && a.lifecycle !== "queued";
    const ids = { execution_id: a.executionId, ticket_id: a.ticketId, slice_id: scene.cells[a.ticketId]?.sliceId, wave_id: waveOfSlice(scene.cells[a.ticketId]?.sliceId), agent_id: a.id, station: a.station, seat: a.seat };
    const attrs: { -readonly [K in keyof SpanAttrs]: SpanAttrs[K] } = { label: a.label, model: a.modelName ?? a.model, toolsCountOnly: countOnly };
    if (a.agentType) attrs.agentType = a.agentType;
    const calls = countOnly ? a.toolCallCount : a.toolCalls.length;
    if (calls !== null) attrs.toolCalls = calls;
    if (a.lastTool) attrs.lastTool = a.lastTool;
    if (a.tokens !== null) attrs.tokens = a.tokens;
    add({
      kind: "agent",
      entity: ref,
      parent,
      ids,
      start: known(a.meta, "startedAt") ? { at: a.startedAt, refs: [ref], eventId: simulated ? `sim:${a.startedSeq}` : null } : null,
      end: ended ? { at: a.finishedAt, refs: [ref], reason: a.lifecycle === "error" ? "failed" : a.lifecycle === "unknown" ? "unknown" : "completed" } : null,
      outcome: ended ? a.lifecycle : null,
      authority: a.meta.authority,
      durationMs: a.durationMs,
      attrs,
    });
    // Count-only: its calls are not observable one by one. No tool span is made for it.
    if (countOnly) return;
    for (const call of a.toolCalls) {
      const done = call.finishedAt !== null && call.result !== "running";
      add({
        kind: "tool",
        entity: `tool:${call.id}`,
        parent: ref,
        ids: { ...ids, tool_call_id: call.id },
        start: { at: call.startedAt, refs: [`tool:${call.id}`], eventId: simulated ? `sim:${call.startedSeq}` : null },
        end: done ? { at: call.finishedAt, refs: [`tool:${call.id}`], reason: call.result === "error" ? "failed" : call.result === "unknown" ? "unknown" : "completed" } : null,
        outcome: done ? call.result : null,
        authority: call.meta.authority,
        attrs: { label: call.toolName },
      });
    }
  }
}

const known = (meta: EntityMeta, field: string): boolean => !meta.unknown.includes(field);

/**
 * Marks from a scene: failures, retries, gate decisions, review verdicts, a person needed or
 * approving, merges and waves. Each is one recorded moment of the scene, never a guess.
 */
export function marksOfScene(scene: Scene, spans: readonly TimelineSpan[]): TimelineMark[] {
  const out: TimelineMark[] = [];
  const auth = (a: Authority): TimelineMark["authority"] => a;
  for (const s of spans) {
    const at = s.end?.at ?? null;
    if (at === null) continue;
    if ((s.kind === "execution" || s.kind === "agent" || s.kind === "visit") && s.end?.reason === "failed") {
      out.push({ id: `failure:${s.id}`, kind: "failure", at, until: null, eventId: s.end.eventId, entity: s.entity, label: `${KIND_WORDS[s.kind]} failed.`, verdict: null, authority: auth(s.authority) });
    }
    if (s.kind === "round" && s.end?.reason === "failed") {
      out.push({ id: `failure:${s.id}`, kind: "failure", at, until: null, eventId: s.end.eventId, entity: s.entity, label: s.attrs.round !== undefined ? `Round ${s.attrs.round} ended without approval.` : "A round ended without approval.", verdict: s.outcome, authority: auth(s.authority) });
    }
    if ((s.kind === "execution" || s.kind === "visit") && (s.end?.reason === "interrupted" || s.end?.reason === "superseded")) {
      out.push({ id: `interruption:${s.id}`, kind: "interruption", at, until: null, eventId: s.end.eventId, entity: s.entity, label: `${KIND_WORDS[s.kind]} was interrupted.`, verdict: null, authority: auth(s.authority) });
    }
    if (s.kind === "gate-wait" && s.start?.at !== null && s.start?.at !== undefined) {
      out.push({ id: `human:${s.id}`, kind: "human", at: s.start.at, until: at, eventId: s.start.eventId, entity: s.entity, label: "A person's approval was required.", verdict: "required", authority: auth(s.authority) });
      out.push({ id: `human-approved:${s.id}`, kind: "human", at, until: null, eventId: s.end?.eventId ?? null, entity: s.entity, label: s.outcome === "failed" ? "A person declined the approval." : "A person approved.", verdict: s.outcome === "failed" ? "rejected" : "approved", authority: auth(s.authority) });
    }
    if (s.kind === "visit" && s.attrs.action === "revise" && s.start?.at !== null && s.start?.at !== undefined) {
      out.push({ id: `retry:${s.id}`, kind: "retry", at: s.start.at, until: null, eventId: s.start.eventId, entity: s.entity, label: "The build station revised the work.", verdict: null, authority: auth(s.authority) });
    }
    if (s.kind === "execution" && (s.attrs.attempt ?? 1) > 1 && s.start?.at !== null && s.start?.at !== undefined) {
      out.push({ id: `retry:${s.id}`, kind: "retry", at: s.start.at, until: null, eventId: s.start.eventId, entity: s.entity, label: `Execution attempt ${s.attrs.attempt} started.`, verdict: null, authority: auth(s.authority) });
    }
  }
  for (const s of spans) {
    if (s.kind === "person-wait" && s.start?.at !== null && s.start?.at !== undefined) {
      out.push({ id: `human:${s.id}`, kind: "human", at: s.start.at, until: s.end?.at ?? null, eventId: s.start.eventId, entity: s.entity, label: "A person was needed.", verdict: "required", authority: auth(s.authority) });
    }
  }
  for (const c of Object.values(scene.cells)) {
    for (const r of c.reviews) {
      if (r.decidedAt === null || r.outcome === null) continue;
      const verdict = r.outcome === "APPROVED" ? "approved" : r.outcome === "ESCALATE" ? "escalated" : r.outcome === "AWAITING_HUMAN" ? "approved" : "rejected";
      out.push({ id: `review:${c.ticketId}#${r.round}`, kind: "review", at: r.decidedAt, until: null, eventId: r.decidedEventId, entity: `gate:${c.ticketId}/review#${r.round}`, label: `Review round ${r.round} decided: ${r.outcome.toLowerCase().replace(/_/g, " ")}.`, verdict, authority: c.meta.authority });
    }
    for (const g of c.gateLog) {
      out.push({ id: `gate:${g.eventId}`, kind: "gate", at: g.at, until: null, eventId: g.eventId, entity: g.ref, label: `Gate ${g.gate} ${g.verdict}.`, verdict: g.verdict, authority: c.meta.authority });
    }
    if (c.merged) out.push({ id: `merge:${c.ticketId}`, kind: "merge", at: c.merged.at, until: null, eventId: null, entity: `cell:${c.ticketId}`, label: `${c.ticketId} was merged.`, verdict: null, authority: c.meta.authority });
  }
  // Gate decisions the scene holds as states (the simulation has no gate log).
  for (const g of Object.values(scene.gates)) {
    const cell = scene.cells[g.ticketId];
    if (g.gate === "human-approval" || g.decidedAt === null || (cell && cell.gateLog.length > 0)) continue;
    const verdict = g.state === "passed" || g.state === "skipped" ? "passed" : g.state === "failed" ? "refused" : g.state === "overridden" ? "overridden" : null;
    if (!verdict) continue;
    out.push({ id: `gate:${g.id}`, kind: "gate", at: g.decidedAt, until: null, eventId: null, entity: `gate:${g.id}`, label: `Gate ${g.gate} ${verdict}.`, verdict, authority: g.meta.authority });
  }
  for (const w of Object.values(scene.waves)) out.push({ id: `wave:${w.id}`, kind: "wave", at: w.discoveredAt, until: null, eventId: w.meta.eventId || null, entity: `wave:${w.id}`, label: `Wave ${w.id} arrived.`, verdict: null, authority: w.meta.authority });
  const seen = new Set<string>();
  return out.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true))).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

const KIND_WORDS: Readonly<Partial<Record<SpanKind, string>>> = { execution: "An execution", agent: "An agent", visit: "A station visit" };
