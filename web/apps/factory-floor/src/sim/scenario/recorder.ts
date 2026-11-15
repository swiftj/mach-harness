/**
 * The scenario's authoring tools: a recorder that collects events at scenario times and turns them
 * into an ordered, numbered fixture, and a per-cell lane that knows its ticket, its execution and
 * the IDs it hands out. Deterministic: no randomness and no wall clock. Every "hash" or ID is
 * derived from a label with FNV-1a, so the same script always produces the same bytes.
 */
import type { AnySimEvent, EventDataMap, EventKind, EventSource } from "../events";
import { SCHEMA_VERSION } from "../events";
import type { ArtifactKind, CellStage, StationId } from "../vocabulary";

/** Scenario time zero: 10 November 2026, 14:00:00 UTC. */
export const SCENARIO_START_MS = Date.UTC(2026, 10, 10, 14, 0, 0);
export const SCENARIO_START = "2026-11-10T14:00:00Z";

/** `at` as intake.now() writes it: UTC, whole seconds. */
export function isoAt(t: number): string {
  return new Date(SCENARIO_START_MS + t).toISOString().slice(0, 19) + "Z";
}

/** Deterministic hex of any length from a label (FNV-1a, re-seeded per block). */
export function hex(label: string, length: number): string {
  let out = "";
  let block = 0;
  while (out.length < length) {
    let h = 0x811c9dc5 ^ block;
    const text = `${label}#${block}`;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
    block++;
  }
  return out.slice(0, length);
}
export const sha40 = (label: string): string => hex(`sha:${label}`, 40);
export const uuidFrom = (label: string): string => {
  const h = hex(`uuid:${label}`, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export interface Envelope {
  source: EventSource;
  wave_id?: string | null;
  slice_id?: string | null;
  revision?: number | null;
  ticket_id?: string | null;
  execution_id?: string | null;
  refs?: Record<string, string> | null;
  source_commit?: string | null;
}

/** A recorded event, before it has a seq. Pass it as `cause` to link a later event to it. */
export interface Handle {
  readonly index: number;
  readonly t: number;
}

interface Draft {
  t: number;
  order: number;
  type: EventKind;
  env: Envelope;
  data: unknown;
  cause: Handle | null;
}

export class Recorder {
  readonly projectId: string;
  readonly runnerId: string;
  readonly productCommit: string;
  private readonly drafts: Draft[] = [];
  /** Every stage change, for the supervisor's per-tick observation pass. */
  readonly stageChanges: Array<{ t: number; ticket: string; slice: string; wave: string; to: CellStage; archivedAt?: number }> = [];

  constructor(projectId: string, runnerId: string, productCommit: string) {
    this.projectId = projectId;
    this.runnerId = runnerId;
    this.productCommit = productCommit;
  }

  emit<K extends EventKind>(t: number, type: K, data: EventDataMap[K], env: Envelope, cause: Handle | null = null): Handle {
    if (!Number.isFinite(t) || t < 0) throw new Error(`Bad time ${t} for ${type}`);
    const index = this.drafts.length;
    this.drafts.push({ t: Math.round(t), order: index, type, env, data, cause });
    return { index, t: Math.round(t) };
  }

  /** Order by time (then by recording order), number from 1, and resolve causes to seq. */
  build(): AnySimEvent[] {
    const sorted = [...this.drafts].sort((a, b) => a.t - b.t || a.order - b.order);
    const seqOf = new Map<number, number>();
    sorted.forEach((draft, i) => seqOf.set(draft.order, i + 1));
    return sorted.map((draft, i) => {
      const seq = i + 1;
      const cause = draft.cause ? seqOf.get(draft.cause.index) ?? null : null;
      if (cause !== null && cause >= seq) throw new Error(`Event ${seq} (${draft.type}) has a cause (${cause}) that does not come before it`);
      const env = draft.env;
      return {
        schema_version: SCHEMA_VERSION,
        seq,
        at: isoAt(draft.t),
        type: draft.type,
        project_id: this.projectId,
        source_commit: env.source_commit === undefined ? this.productCommit : env.source_commit,
        wave_id: env.wave_id ?? null,
        slice_id: env.slice_id ?? null,
        revision: env.revision ?? null,
        ticket_id: env.ticket_id ?? null,
        runner_id: this.runnerId,
        execution_id: env.execution_id ?? null,
        source: env.source,
        cause,
        refs: env.refs ?? null,
        data: draft.data,
        t: draft.t,
      } as AnySimEvent;
    });
  }
}

export interface ArtifactSpec {
  kind: ArtifactKind;
  path: string;
  label: string;
  summary: string;
  sha?: string | null;
  /** Artifact ID, when it is not `<ticket>:<path>` (commits use their SHA). */
  id?: string;
}

/** One cell's lane: its ticket, slice, current execution, and the IDs and versions it hands out. */
export class Lane {
  readonly rec: Recorder;
  readonly ticket: string;
  readonly slice: string;
  readonly wave: string;
  readonly revision: number;
  readonly num: string;
  execution: string | null = null;
  stage: CellStage | null = null;
  round = 1;
  station: StationId | null = null;
  private agentCount = 0;
  private toolCount = 0;
  private readonly versions = new Map<string, number>();

  constructor(rec: Recorder, ticket: string, slice: string, wave: string, revision: number) {
    this.rec = rec;
    this.ticket = ticket;
    this.slice = slice;
    this.wave = wave;
    this.revision = revision;
    this.num = ticket.replace(/^\D+/, "");
  }

  env(extra: Partial<Envelope> = {}): Envelope {
    return {
      source: "supervisor",
      wave_id: this.wave,
      slice_id: this.slice,
      revision: this.revision,
      ticket_id: this.ticket,
      execution_id: this.execution,
      ...extra,
    };
  }

  ev<K extends EventKind>(t: number, type: K, data: EventDataMap[K], cause: Handle | null = null, extra: Partial<Envelope> = {}): Handle {
    return this.rec.emit(t, type, data, this.env(extra), cause);
  }

  nextAgentId(): string {
    this.agentCount++;
    return `ag-${this.num}-${String(this.agentCount).padStart(2, "0")}`;
  }
  nextCallId(): string {
    this.toolCount++;
    return `tc-${this.num}-${String(this.toolCount).padStart(4, "0")}`;
  }
  artifactId(spec: ArtifactSpec): string {
    return spec.id ?? `${this.ticket}:${spec.path}`;
  }
  bumpVersion(id: string): number {
    const v = (this.versions.get(id) ?? 0) + 1;
    this.versions.set(id, v);
    return v;
  }

  setStage(t: number, to: CellStage, by: string, cause: Handle | null = null): Handle {
    const from = this.stage;
    this.stage = to;
    this.rec.stageChanges.push({ t, ticket: this.ticket, slice: this.slice, wave: this.wave, to });
    return this.ev(t, "cell.stage_changed", { from, to, by }, cause);
  }

  writeArtifact(t: number, spec: ArtifactSpec, writer: { agent_id: string | null; call_id: string | null; script: string | null }, cause: Handle | null): Handle {
    const id = this.artifactId(spec);
    return this.ev(
      t,
      "artifact.written",
      {
        artifact_id: id,
        kind: spec.kind,
        path: spec.path,
        label: spec.label,
        writer,
        station: this.station,
        round: this.round,
        version: this.bumpVersion(id),
        sha: spec.sha ?? null,
        summary: spec.summary,
      },
      cause,
    );
  }
}
