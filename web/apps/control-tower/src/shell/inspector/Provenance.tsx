/**
 * The record behind a selected entity, for every kind (contract sections 7 and 8): who stands behind
 * it (authoritative, observed, reconstructed; the simulation's are simulated), how its times are
 * known (measured to the millisecond or second, arrival time, bounded, unknown), the id of the event
 * that last set it with "Go to event", the fields that apply but are not recorded ("Not recorded",
 * never 0 or blank), and the fields the observer filled by inference ("read from its label").
 *
 * The simulation keeps the M6.0 telemetry class of its events (exists, derivable, missing): it says
 * what MACH would know today, which is a different question from where a real value came from.
 */
import { EVENT_CATALOG, findAgent, refKind, sourceRuntimeOf, streamObservationOf, type AnyRef, type AnySimEvent, type EntityMeta, type Scene } from "../../sim";
import { useScene, useSceneStore } from "../../scene";
import { AuthorityBadge, Facts, JumpButton, Mono, precisionWords, Section, TelemetryBadge, useEntityEvents } from "./parts";
import { runtimeStateWords } from "./words";

const FIELD_WORDS: Readonly<Record<string, string>> = {
  title: "Title",
  risk: "Risk",
  appType: "App type",
  effort: "Effort",
  tier: "Tier",
  model: "Model",
  phase: "Phase",
  startedAt: "Start time",
  costUsd: "Cost",
  stage: "Stage",
  next: "Next step",
  attempt: "Attempt",
  claimedAt: "Claim time",
  text: "Task text",
  files: "Files",
  ids: "Requirement ids",
  writer: "Writer",
  summary: "Summary",
  kind: "Kind",
  epicTitle: "Epic",
  approvedAt: "Approval time",
  discoveredAt: "Arrival time",
  outcome: "How it ended",
  ticket_id: "Ticket",
  station: "Station",
  seat: "Seat",
  leftAt: "End time",
};

export const RULE_WORDS: Readonly<Record<string, string>> = {
  label: "read from its label",
  "time-window": "placed by its time window",
  execution: "taken from its execution",
  "unclosed-visit": "bounded by the next entry: it never recorded an exit",
  "execution-ended": "bounded by its execution's end: it never recorded an exit",
};

export const fieldWord = (field: string) => FIELD_WORDS[field] ?? field.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

/** The entity's meta, if it has one (a station visit: its latest visit's). */
function metaOf(entity: AnyRef, value: unknown): EntityMeta | null {
  if (!value || typeof value !== "object") return null;
  if (entity.startsWith("station:")) {
    const station = entity.slice(entity.lastIndexOf("/") + 1);
    const visits = (value as { visits?: ReadonlyArray<{ station: string; meta: EntityMeta }> }).visits;
    const last = visits ? [...visits].reverse().find((v) => v.station === station) : undefined;
    return last?.meta ?? null;
  }
  return (value as { meta?: EntityMeta }).meta ?? null;
}

/**
 * The execution whose stream an entity was read from (an execution, its workflow, an agent, a tool
 * call), or null: other kinds are not stream records.
 */
function streamExecutionOf(scene: Scene, entity: AnyRef, value: unknown): string | null {
  const v = (value ?? {}) as { id?: string; executionId?: string | null; agentId?: string };
  switch (refKind(entity)) {
    case "execution":
      return v.id ?? null;
    case "workflow":
    case "agent":
      return v.executionId ?? null;
    case "tool":
      return v.agentId ? (findAgent(scene, v.agentId)?.executionId ?? null) : null;
    default:
      return null;
  }
}

export function Provenance({ entity, value }: { entity: AnyRef; value: unknown }) {
  const source = useSceneStore((s) => s.source);
  const { all, happened } = useEntityEvents(entity);
  const latest = all[happened - 1] ?? null;
  const meta = metaOf(entity, value);
  // Stream records (observer M6.2): the Claude Code runtime that wrote them, as the observer judged
  // its records (proven, compatible but unproven, some refused, not stated yet). Said, never silent.
  const factory = useSceneStore((s) => s.factoryStatus);
  const runtime = useScene((s) => {
    if (source === "simulation") return null;
    const x = streamExecutionOf(s, entity, value);
    if (!x || !s.executions[x] || s.executions[x].meta.authority === "simulated") return null;
    return runtimeStateWords(streamObservationOf(s, x, sourceRuntimeOf(factory?.sources, x)));
  });

  if (source === "simulation") {
    const kind = latest ? (latest.event as AnySimEvent).type : null;
    return (
      <Section title="Record" id={`rec-${entity}`}>
        <Facts
          facts={[
            ["Authority", <AuthorityBadge key="a" authority="simulated" />],
            ["Time", "Simulated"],
            kind ? ["Telemetry today", <TelemetryBadge key="t" telemetry={EVENT_CATALOG[kind]?.telemetry ?? "missing"} />] : null,
            latest ? ["Source record", <Mono key="r">{latest.id}</Mono>] : null,
          ]}
        />
        {latest ? (
          <div className="mt-2">
            <JumpButton eventId={latest.id} label="Go to event" />
          </div>
        ) : null}
      </Section>
    );
  }

  const recordId = meta?.eventId || latest?.id || null;
  const fields = meta ? Object.entries(meta.fields) : [];
  const inferred = meta ? Object.entries(meta.inferred) : [];
  return (
    <Section title="Record" id={`rec-${entity}`}>
      <Facts
        facts={[
          ["Authority", meta ? <AuthorityBadge key="a" authority={meta.authority} /> : latest ? <AuthorityBadge key="a" authority={latest.authority} /> : "Not recorded"],
          meta ? ["Start time", meta.start === "unknown" ? "Not recorded" : precisionWords(meta.start)] : null,
          meta ? ["End time", meta.end === "unknown" ? "Not recorded, or still open" : precisionWords(meta.end)] : null,
          latest ? ["Latest record's time", precisionWords(latest.precision)] : null,
          ["Source record", recordId ? <Mono key="r">{recordId}</Mono> : "Not recorded"],
          runtime ? ["Runtime", runtime] : null,
          fields.length ? ["Fields from elsewhere", <span key="f">{fields.map(([f, a]) => `${fieldWord(f)}: ${a}`).join("; ")}</span>] : null,
        ]}
      />
      {recordId ? (
        <div className="mt-2">
          <JumpButton eventId={recordId} label="Go to event" />
        </div>
      ) : null}
      {meta?.unknown.length ? (
        <div className="mt-3">
          <p className="text-caption font-semibold text-ink">Not recorded</p>
          <p className="mt-0.5 text-body-sm text-ink-muted">{meta.unknown.map(fieldWord).join(", ")}. These apply but no record says them; nothing here stands in for them.</p>
        </div>
      ) : null}
      {inferred.length ? (
        <div className="mt-3">
          <p className="text-caption font-semibold text-ink">Inferred by the observer</p>
          <ul className="mt-0.5 list-disc pl-4 text-body-sm text-ink-muted">
            {inferred.map(([field, rule]) => (
              <li key={field}>
                {fieldWord(field)}: {RULE_WORDS[rule] ?? rule}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  );
}
