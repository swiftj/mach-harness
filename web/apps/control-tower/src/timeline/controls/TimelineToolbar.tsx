/**
 * The Timeline's own controls (M6.3 design section 3D), under the shared transport: grouping, filters,
 * jumps, zoom to the selection, show all, and the table. Time, selection and playback stay the
 * store's: a jump seeks the playhead with the store's own seek (by event id when the mark has one)
 * and selects the mark's entity; the window and filters are the Timeline's interface state
 * (`onView`, kept in the store).
 *
 * Keys (registered only while the Timeline is up; src/shell/keyboard.ts routes them): g grouping,
 * / filters, n and p the next and previous mark of the kind last jumped to, z zoom to the selection,
 * a show all.
 */
import { ChevronDown, ChevronLeft, ChevronRight, Crosshair, ListFilter, Maximize2, Table2 } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Checkbox, cn, Popover, PopoverContent, PopoverTrigger } from "@mach/ui";
import type { EntityRef } from "../../sim";
import { useSceneStore, useStore } from "../../scene";
import { registerTimelineKeys, type TimelineKeyCommand } from "../../shell/keyboard";
import { IconButton } from "../../shell/timeline/Transport";
import { NO_FILTERS, type Grouping, type SpanKind, type TimelineFilters, type TimelineToolbarProps, type TimeWindow } from "../contract";
import { clampWindow, extentOfSpans, filterCount, filterOptions, frameExtent, JUMPS, jumpOf, panToInclude, spanIdForRef, spansOfRef, toggled, type JumpKind } from "./frame";

const REF = /^[a-z]+:.+/;

const GROUPINGS: Array<{ value: Grouping; label: string; hint: string }> = [
  { value: "product", label: "Product", hint: "Wave, slice, cell, station: the work as the product sees it" },
  { value: "execution", label: "Execution", hint: "Execution, claim, workflow, agents, tools: the work as it ran" },
];

const KIND_WORDS: Partial<Record<SpanKind, string>> = {
  wave: "Waves",
  "slice-wait": "Dependency waits",
  "slice-eligible": "Eligible, not started",
  "capacity-wait": "Capacity waits",
  cell: "Cells",
  round: "Rounds",
  visit: "Station visits",
  task: "Build tasks",
  seat: "Review seats",
  "gate-wait": "Gate waits",
  "person-wait": "Waits for a person",
  claim: "Claims",
  execution: "Executions",
  workflow: "Workflows",
  "agent-queue": "Agent queue time",
  agent: "Agents",
  tool: "Tool calls",
};

function GroupingSwitch({ value, onChange }: { value: Grouping; onChange: (g: Grouping) => void }) {
  const name = useId();
  return (
    <fieldset className="flex shrink-0 rounded-sm border border-line bg-surface-sunken p-0.5" data-timeline-grouping="">
      <legend className="sr-only">Group the tracks by</legend>
      {GROUPINGS.map((g) => (
        <label
          key={g.value}
          title={`${g.hint} (G)`}
          className={cn(
            "relative flex h-7 cursor-pointer items-center rounded-xs px-2.5 text-body-sm text-ink-muted transition-colors duration-[var(--mach-duration-fast)]",
            "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-focus",
            value === g.value ? "bg-surface font-semibold text-ink shadow-1" : "hover:text-ink",
          )}
        >
          <input type="radio" name={name} value={g.value} checked={value === g.value} onChange={() => onChange(g.value)} aria-keyshortcuts="G" className="sr-only" />
          {g.label}
        </label>
      ))}
    </fieldset>
  );
}

function ToolbarButton({ label, shortcut, onClick, pressed, children, wide }: { label: string; shortcut?: string; onClick: () => void; pressed?: boolean; children: ReactNode; wide?: string }) {
  if (!wide) {
    return (
      <IconButton label={label} shortcut={shortcut} onClick={onClick} pressed={pressed}>
        {children}
      </IconButton>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2 text-body-sm text-ink-muted transition-colors duration-[var(--mach-duration-fast)] hover:bg-surface-sunken hover:text-ink [&_svg]:size-4",
        pressed && "bg-surface-sunken text-ink",
      )}
    >
      {children}
      <span className="max-[1279px]:sr-only">{wide}</span>
    </button>
  );
}

function FilterList({ title, values, chosen, words, onToggle }: { title: string; values: readonly string[]; chosen: readonly string[]; words?: (v: string) => string; onToggle: (v: string) => void }) {
  if (!values.length) return null;
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1 text-label text-ink">{title}</legend>
      <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto pr-1">
        {values.map((v) => (
          <Checkbox key={v} label={words ? words(v) : v} checked={chosen.includes(v)} onCheckedChange={() => onToggle(v)} />
        ))}
      </div>
    </fieldset>
  );
}

export function TimelineToolbar({ data, tree, view, onView }: TimelineToolbarProps) {
  const store = useStore();
  const selection = useSceneStore((s) => s.selection);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [jumpsOpen, setJumpsOpen] = useState(false);
  const [lastJump, setLastJump] = useState<JumpKind>("failure");
  const [said, setSaid] = useState("");
  const options = useMemo(() => filterOptions(tree, view.filters), [tree, view.filters]);
  const count = filterCount(view.filters);
  const jumping = useRef<AbortController | null>(null);

  const whole = useCallback((): TimeWindow => {
    const s = store.getState();
    const ext = data.extent();
    return { from: Math.min(ext?.from ?? s.extent.start, s.extent.start), to: Math.max(ext?.to ?? s.liveAt, s.liveAt, s.extent.end) };
  }, [data, store]);

  const setFilters = useCallback((patch: Partial<TimelineFilters>) => onView({ filters: { ...view.filters, ...patch } }), [onView, view.filters]);

  const jump = useCallback(
    async (kind: JumpKind, direction: 1 | -1) => {
      setLastJump(kind);
      jumping.current?.abort();
      const ctl = new AbortController();
      jumping.current = ctl;
      const j = jumpOf(kind);
      const s = store.getState();
      let mark;
      try {
        mark = await data.nextMark(s.playhead, direction, j.kinds, ctl.signal);
      } catch {
        if (!ctl.signal.aborted) setSaid(`Could not look for the ${direction > 0 ? "next" : "previous"} ${j.label}.`);
        return;
      }
      if (ctl.signal.aborted) return;
      if (!mark) {
        setSaid(`No ${direction > 0 ? "later" : "earlier"} ${j.label} in what is held.`);
        return;
      }
      if (mark.eventId && store.getState().log.entry(mark.eventId)) store.seekToEvent(mark.eventId);
      else store.seek(mark.at);
      if (mark.entity && REF.test(mark.entity)) store.select(mark.entity as EntityRef, { focus: false });
      const current = view.window;
      if (current) {
        const next = panToInclude(current, { from: mark.at, to: mark.until ?? mark.at });
        if (next !== current) onView({ window: clampWindow(next, whole()) });
      }
      setSaid(mark.label);
    },
    [data, store, view.window, onView, whole],
  );

  const zoomToSelection = useCallback(async () => {
    const sel = store.getState().selection;
    if (!sel) {
      setSaid("Nothing is selected to zoom to.");
      return;
    }
    let ext = extentOfSpans(spansOfRef(tree, sel), store.getState().liveAt);
    if (!ext) {
      const id = spanIdForRef(sel);
      const span = id ? await data.span(id).catch(() => null) : null;
      ext = span ? extentOfSpans([span], store.getState().liveAt) : null;
    }
    if (!ext) {
      setSaid("The selection has no recorded time to zoom to.");
      return;
    }
    onView({ window: clampWindow(frameExtent(ext), whole()) });
  }, [data, onView, store, tree, whole]);

  const showAll = useCallback(() => onView({ window: null }), [onView]);
  const toggleGrouping = useCallback(() => onView({ grouping: view.grouping === "product" ? "execution" : "product" }), [onView, view.grouping]);

  useEffect(
    () =>
      registerTimelineKeys((command: TimelineKeyCommand) => {
        switch (command) {
          case "grouping":
            toggleGrouping();
            return true;
          case "filters":
            setFiltersOpen(true);
            return true;
          case "next-mark":
            void jump(lastJump, 1);
            return true;
          case "previous-mark":
            void jump(lastJump, -1);
            return true;
          case "zoom-selection":
            void zoomToSelection();
            return true;
          case "show-all":
            showAll();
            return true;
          default:
            return false;
        }
      }),
    [toggleGrouping, jump, lastJump, zoomToSelection, showAll],
  );
  useEffect(() => () => jumping.current?.abort(), []);

  const last = jumpOf(lastJump);
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-surface px-2" role="toolbar" aria-label="Timeline controls" data-timeline-toolbar="">
      <GroupingSwitch value={view.grouping} onChange={(grouping) => onView({ grouping })} />
      <span className="mx-1.5 h-5 w-px shrink-0 bg-line" aria-hidden="true" />

      <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-keyshortcuts="/"
            title="Filters (/)"
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2 text-body-sm text-ink-muted hover:bg-surface-sunken hover:text-ink [&_svg]:size-4",
              count > 0 && "bg-surface-sunken text-ink",
            )}
          >
            <ListFilter aria-hidden="true" />
            <span>Filters</span>
            {count > 0 ? (
              <span className="rounded-full bg-ink px-1.5 text-caption leading-4 text-ink-inverse">
                {count}
                <span className="sr-only"> on</span>
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(560px,calc(100vw-32px))]" aria-label="Filters">
          <div className="flex flex-col gap-4">
            <Checkbox
              label="Needs attention only"
              description="Tracks holding something that failed, was interrupted or refused, or waits on a person."
              checked={view.filters.attentionOnly}
              onCheckedChange={(on) => setFilters({ attentionOnly: on === true })}
            />
            <div className="grid grid-cols-2 gap-x-6 gap-y-4">
              <FilterList title="Cells" values={options.tickets} chosen={view.filters.tickets} onToggle={(v) => setFilters({ tickets: toggled(view.filters.tickets, v) })} />
              <FilterList title="Slices" values={options.slices} chosen={view.filters.slices} onToggle={(v) => setFilters({ slices: toggled(view.filters.slices, v) })} />
              <FilterList title="Executions" values={options.executions} chosen={view.filters.executions} onToggle={(v) => setFilters({ executions: toggled(view.filters.executions, v) })} />
              <FilterList title="Stations" values={options.stations} chosen={view.filters.stations} onToggle={(v) => setFilters({ stations: toggled(view.filters.stations, v) })} />
              <FilterList
                title="Kinds"
                values={options.kinds}
                chosen={view.filters.kinds}
                words={(v) => KIND_WORDS[v as SpanKind] ?? v}
                onToggle={(v) => setFilters({ kinds: toggled(view.filters.kinds, v as SpanKind) })}
              />
            </div>
            {options.tickets.length + options.slices.length + options.executions.length + options.stations.length + options.kinds.length === 0 ? (
              <p className="text-body-sm text-ink-muted">Nothing in this window to filter by yet.</p>
            ) : null}
            <div className="flex justify-end">
              <button type="button" disabled={count === 0} onClick={() => onView({ filters: NO_FILTERS })} className="h-8 rounded-sm px-2.5 text-body-sm font-semibold text-accent-ink hover:bg-surface-sunken disabled:opacity-40">
                Clear filters
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <span className="mx-1.5 h-5 w-px shrink-0 bg-line" aria-hidden="true" />
      <IconButton label={`Previous ${last.label}`} shortcut="P" onClick={() => void jump(lastJump, -1)}>
        <ChevronLeft aria-hidden="true" />
      </IconButton>
      <Popover open={jumpsOpen} onOpenChange={setJumpsOpen}>
        <PopoverTrigger asChild>
          <button type="button" title="Jump to a failure, retry, gate decision, human intervention or gap" className="inline-flex h-8 shrink-0 items-center gap-1 rounded-sm px-2 text-body-sm text-ink-muted hover:bg-surface-sunken hover:text-ink [&_svg]:size-3.5">
            <span>
              Jump<span className="max-[1099px]:sr-only">: {last.plural.toLowerCase()}</span>
            </span>
            <ChevronDown aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-2" aria-label="Jump to">
          <ul className="flex flex-col">
            {JUMPS.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-2 rounded-sm px-2 py-1 hover:bg-surface-sunken">
                <span className={cn("text-body-sm", j.id === lastJump ? "font-semibold text-ink" : "text-ink-muted")}>{j.plural}</span>
                <span className="flex gap-0.5">
                  <IconButton
                    label={`Previous ${j.label}`}
                    onClick={() => {
                      setJumpsOpen(false);
                      void jump(j.id, -1);
                    }}
                  >
                    <ChevronLeft aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={`Next ${j.label}`}
                    onClick={() => {
                      setJumpsOpen(false);
                      void jump(j.id, 1);
                    }}
                  >
                    <ChevronRight aria-hidden="true" />
                  </IconButton>
                </span>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
      <IconButton label={`Next ${last.label}`} shortcut="N" onClick={() => void jump(lastJump, 1)}>
        <ChevronRight aria-hidden="true" />
      </IconButton>

      <span className="mx-1.5 h-5 w-px shrink-0 bg-line" aria-hidden="true" />
      <ToolbarButton label={selection ? "Zoom to the selection" : "Zoom to the selection (nothing selected)"} shortcut="Z" onClick={() => void zoomToSelection()} wide="Zoom to selection">
        <Crosshair aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton label="Show all of the history held" shortcut="A" onClick={showAll} pressed={view.window === null} wide="Show all">
        <Maximize2 aria-hidden="true" />
      </ToolbarButton>

      <p role="status" className="ml-2 min-w-0 flex-1 truncate text-caption text-ink-subtle">
        {said}
      </p>
      <ToolbarButton label="Show the window as a table" onClick={() => onView({ table: !view.table })} pressed={view.table} wide="Table">
        <Table2 aria-hidden="true" />
      </ToolbarButton>
    </div>
  );
}
