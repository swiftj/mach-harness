/**
 * M22: a ticket's lanes on the Line (a strip under its belt, from Build on) and in its side panel
 * (the tasks grouped by lane, each with its time, and the lanes' wall time against their summed
 * time). Words and shapes from src/line/lanesModel.ts; nothing here reads the observer itself.
 */
import { cn } from "@mach/ui";
import { duration } from "../shell/time";
import type { CommandsPanel, LaneChip, LaneLine, LanesPanel, PanelTask } from "./lanesModel";
import { STATE_TONE, StateShape } from "./Marks";
import type { LineState } from "./model";

/** A lane chip's tone as a Line state: its shape and colours (never colour alone; the words say it). */
const CHIP_STATE: Readonly<Record<Exclude<LaneChip["tone"], "unknown">, LineState>> = { working: "working", held: "held", done: "landed", fail: "stopped" };

function Chip({ chip }: { chip: LaneChip }) {
  const state = chip.tone === "unknown" ? null : CHIP_STATE[chip.tone];
  return (
    <li
      className={cn(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap border px-1.5 text-caption font-semibold",
        state ? STATE_TONE[state] : "border-dashed border-line-strong bg-surface text-ink-muted",
        state === "stopped" ? "rounded-xs" : "rounded-full",
      )}
      data-lane-chip={chip.lane}
      data-lane-tone={chip.tone}
    >
      {state ? <StateShape state={state} size={9} /> : null}
      <span>{chip.words}</span>
    </li>
  );
}

const MOMENT_TONE: Readonly<Record<NonNullable<LaneLine["moment"]>["tone"], string>> = {
  working: "text-factory-live",
  done: "text-factory-pass",
  fail: "text-factory-fail",
  held: "text-ink-muted",
};

/** Under a ticket's belt, from the Build column on: each lane where it is, and the moment of the join. */
export function LanesStrip({ ticketId, line, offset }: { ticketId: string; line: LaneLine; offset: number }) {
  return (
    <div className="relative pb-2 pr-2" style={{ marginLeft: `${offset}%` }} data-lanes-strip={ticketId}>
      {line.chips.length ? (
        <ul className="flex flex-wrap gap-1" aria-label={`Lanes of ${ticketId}`}>
          {line.chips.map((c) => (
            <Chip key={c.lane} chip={c} />
          ))}
        </ul>
      ) : null}
      {line.moment ? (
        <p className={cn("mt-1 text-caption font-semibold", MOMENT_TONE[line.moment.tone])} data-lanes-moment={line.moment.tone}>
          {line.moment.words}
        </p>
      ) : null}
    </div>
  );
}

const timeWords = (t: PanelTask): string => (t.seconds === null ? "not recorded" : duration(t.seconds * 1000));

/** The side panel's part: the lanes' summary, the tasks grouped by lane, and where the time went. */
export function LanesPart({ panel }: { panel: LanesPanel }) {
  const timing = panel.timing;
  return (
    <div data-lanes-panel="">
      <p className="text-body-sm text-ink">{panel.summary}</p>
      {panel.problems.map((p) => (
        <p key={p} className="mt-1 text-body-sm text-warning-ink" data-lanes-problem="">
          {p}
        </p>
      ))}
      {panel.notes.map((n) => (
        <p key={n} className="mt-1 text-body-sm text-ink" data-lanes-note="">
          {n}
        </p>
      ))}
      {timing ? (
        <dl className="mt-2 grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1 text-body-sm" data-lanes-timing={timing.basis ?? "not-recorded"}>
          <dt className="text-ink-muted">Lanes, wall time</dt>
          <dd className="text-ink tabular">{timing.wallSeconds === null ? "not recorded" : duration(timing.wallSeconds * 1000)}</dd>
          <dt className="text-ink-muted">Lanes, added up</dt>
          <dd className="text-ink tabular">
            {timing.summedSeconds === null ? "not recorded" : duration(timing.summedSeconds * 1000)}
            {timing.wallSeconds && timing.summedSeconds !== null ? <span className="text-ink-muted">{` (${(timing.summedSeconds / timing.wallSeconds).toFixed(1)} times the wall time)`}</span> : null}
          </dd>
          <dt className="text-ink-muted">Whole build</dt>
          <dd className="text-ink tabular">{timing.buildSeconds === null ? "not recorded yet" : `${duration(timing.buildSeconds * 1000)} elapsed`}</dd>
          <dt className="text-ink-muted">Its tasks, added up</dt>
          <dd className="text-ink tabular">
            {timing.tasksSeconds === null ? "not recorded" : duration(timing.tasksSeconds * 1000)}
            {timing.tasksNotRecorded ? <span className="text-ink-muted">{`, ${timing.tasksNotRecorded} not recorded`}</span> : null}
          </dd>
        </dl>
      ) : null}
      {timing ? <p className="mt-1 text-caption text-ink-muted">{timing.note}</p> : null}
      {panel.groups.map((g) => (
        <section key={g.key} className="mt-3" data-lanes-group={g.key}>
          <h5 className="text-body-sm font-semibold text-ink">
            {g.title}
            {g.note ? <span className="font-normal text-ink-muted">{` · ${g.note}`}</span> : null}
          </h5>
          <ul className="mt-1 divide-y divide-line border-y border-line">
            {g.tasks.map((t) => (
              <li key={t.task} className="py-1 text-body-sm" data-lanes-task={t.task}>
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-mono text-[13px] text-ink" translate="no">
                      {t.task}
                    </span>
                    <span className="text-ink-muted">{` ${t.kind ? `${t.kind} · ` : ""}${t.status}`}</span>
                  </span>
                  <span className="shrink-0 text-caption text-ink-muted tabular">{t.status === "done" ? timeWords(t) : ""}</span>
                </span>
                {t.commitWords ? <span className="block font-mono text-[12px] text-ink-subtle">{t.commitWords}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The side panel's part for a build whose test or lint command changed: which one and when, and where the rest is recorded. */
export function CommandsPart({ panel }: { panel: CommandsPanel }) {
  return (
    <div data-commands-panel="">
      {panel.lines.map((l, i) => (
        <p key={`${i}:${l}`} className="text-body-sm text-ink" data-commands-change="">
          {l}
        </p>
      ))}
      <p className="mt-1 text-caption text-ink-muted">{panel.note}</p>
    </div>
  );
}
