/**
 * The Timeline's own controls (M6.3 design section 3D), under the shared transport: grouping, filters
 * with a chip per active choice, the investigation lenses, jumps (the kind shown), zoom with the
 * window's length in words, fitting the recorded activity, show all, zoom to the selection, and the
 * table. Time, selection and playback stay the store's: a jump seeks the playhead with the store's
 * own seek (by event id when the mark has one) and selects the mark's entity; the window, filters and
 * lens are the Timeline's interface state (`onView`, kept in the store).
 *
 * The row is a size container: as the workspace narrows (an inspector beside it, a smaller window),
 * secondary labels give way to icons with accessible names, so nothing wraps or clips.
 *
 * Keys (registered only while the Timeline is up; src/shell/keyboard.ts routes them): g grouping,
 * / filters, n and p the next and previous mark of the kind last jumped to, z zoom to the selection,
 * a show all.
 */
import { ChevronDown, ChevronLeft, ChevronRight, Crosshair, Ellipsis, ListFilter, Maximize2, Microscope, Minus, Plus, ScanLine, Table2, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Checkbox, cn, Popover, PopoverContent, PopoverTrigger } from "@mach/ui";
import type { EntityRef } from "../../sim";
import { useSceneStore, useStore } from "../../scene";
import { registerTimelineKeys, type TimelineKeyCommand } from "../../shell/keyboard";
import { IconButton } from "../../shell/timeline/Transport";
import { NO_FILTERS, type Grouping, type LensDefinition, type LensId, type SpanKind, type TimelineFilters, type TimelineSpan, type TimelineToolbarProps, type TimeWindow } from "../contract";
import { useAsOf } from "./asOf";
import {
  ALL_WINDOW,
  asOfCaption,
  clampWindow,
  extentOfSpans,
  filterChips,
  filterCount,
  filterOptions,
  filterOptionsOfSpans,
  frameExtent,
  isAll,
  isFollow,
  isRunning,
  followWindow,
  followingZoom,
  JUMPS,
  jumpEndWords,
  jumpOf,
  panToInclude,
  spanIdForRef,
  spansOfRef,
  switchLens,
  toggled,
  toolbarFitKey,
  windowLengthWords,
  type JumpKind,
  type LensMemo,
} from "./frame";

/**
 * Per store: what the lens in use changed and what was there before it, so choosing another lens (or
 * none, here or in the band) gives the person's own filters and grouping back. Shared with the workspace.
 */
export const lensMemos = new WeakMap<object, LensMemo>();

const REF = /^[a-z]+:.+/;
/** One zoom step: the window's length is divided or multiplied by this. */
const ZOOM_STEP = 2;

const GROUPINGS: Array<{ value: Grouping; label: string; hint: string }> = [
  { value: "product", label: "Product", hint: "Wave, slice, cell, station: the work as the product sees it" },
  { value: "execution", label: "Execution", hint: "Execution, claim, workflow, agents, tools: the work as it ran" },
];

export const KIND_WORDS: Partial<Record<SpanKind, string>> = {
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
const kindWords = (k: SpanKind): string => KIND_WORDS[k] ?? k;

/** What the workspace gives the toolbar beyond the contract's props. All optional: without them it behaves as before. */
export interface ToolbarExtras {
  /** The spans of the window, unfiltered: the filter lists offer every value present. */
  readonly spans?: readonly TimelineSpan[];
  /** The window as drawn (the default, or the whole history for "all"). */
  readonly drawn?: TimeWindow;
  /** The whole history held. */
  readonly whole?: TimeWindow;
  /** The investigation lenses, once their module has loaded (null while it has not, or when it is absent). */
  readonly lenses?: readonly LensDefinition[] | null;
  /**
   * The window is pinned and the live edge has moved past it (`pinnedBehind`): how far ahead the edge
   * is, and how to follow it again. Said in the row ("Window pinned · live edge is 3 min ahead — Follow").
   */
  readonly pinned?: { readonly ahead: number; readonly onFollow: () => void } | null;
}

function Sep() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />;
}

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

/**
 * A button whose words give way to its icon when the row is narrow. The visible words are its
 * accessible name at every width (visually hidden when narrow, never removed), so a person who says
 * what they see reaches it; the longer `label` is its description (title).
 */
function LabelledButton({ label, words, shortcut, onClick, pressed, children, collapseBelow = "lg", disabled, squeezed }: { label: string; words: string; shortcut?: string; onClick: () => void; pressed?: boolean; children: ReactNode; collapseBelow?: "md" | "lg" | "xl"; disabled?: boolean; squeezed?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      disabled={disabled}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2 text-body-sm text-ink-muted transition-colors duration-[var(--mach-duration-fast)] hover:bg-surface-sunken hover:text-ink disabled:opacity-40 [&_svg]:size-4",
        pressed && "bg-surface-sunken text-ink",
      )}
    >
      {children}
      <span className={squeezed ? "sr-only" : collapseBelow === "xl" ? "@max-[1439px]:sr-only" : collapseBelow === "lg" ? "@max-[1199px]:sr-only" : "@max-[879px]:sr-only"}>{words}</span>
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

/** At most this many chips are drawn; the rest are counted. */
const MAX_CHIPS = 3;
/** The last squeeze step: the row wraps instead of clipping (M6.6). Exported for the tests. */
export const TOOLBAR_WRAP = 4;

export function TimelineToolbar({ data, tree, view, onView, spans, drawn, whole: wholeProp, lenses, pinned }: TimelineToolbarProps & ToolbarExtras) {
  const store = useStore();
  const selection = useSceneStore((s) => s.selection);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [jumpsOpen, setJumpsOpen] = useState(false);
  const [lensOpen, setLensOpen] = useState(false);
  const [lastJump, setLastJump] = useState<JumpKind>("failure");
  const [said, setSaid] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  // What a control said stays a few seconds, then the row's standing caption (if any) returns.
  useEffect(() => {
    if (!said) return;
    const id = globalThis.setTimeout(() => setSaid(""), 6000);
    return () => globalThis.clearTimeout(id);
  }, [said]);
  // T6: while the playhead is behind the live edge, say what the tracks show and where the playhead is.
  const asOf = useAsOf();
  const caption = asOfCaption(asOf);
  // Every value present in the window stays on offer while a filter is on: built from the spans, not the filtered tree.
  const options = useMemo(() => (spans ? filterOptionsOfSpans(spans, view.filters) : filterOptions(tree, view.filters)), [spans, tree, view.filters]);
  const count = filterCount(view.filters);
  const chips = useMemo(() => filterChips(view.filters, kindWords), [view.filters]);
  const jumping = useRef<AbortController | null>(null);

  const whole = useCallback((): TimeWindow => {
    if (wholeProp) return wholeProp;
    const s = store.getState();
    const ext = data.extent();
    return { from: Math.min(ext?.from ?? s.extent.start, s.extent.start), to: Math.max(ext?.to ?? s.liveAt, s.liveAt, s.extent.end) };
  }, [data, store, wholeProp]);
  /** The window as drawn now. */
  const shown = useCallback((): TimeWindow => drawn ?? (view.window && !isAll(view.window) ? view.window : whole()), [drawn, view.window, whole]);

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
        // X18: say how many lie the other way, and the key that reaches them.
        const all = whole();
        const t = store.getState().playhead;
        const other = await data.marks(direction > 0 ? { from: all.from, to: t } : { from: t, to: all.to }, j.kinds, ctl.signal).catch(() => null);
        if (ctl.signal.aborted) return;
        const n = other ? other.filter((m) => (direction > 0 ? m.at < t : m.at > t)).length : 0;
        setSaid(jumpEndWords(j.label, direction, n));
        return;
      }
      if (mark.eventId && store.getState().log.entry(mark.eventId)) store.seekToEvent(mark.eventId);
      else store.seek(mark.at);
      if (mark.entity && REF.test(mark.entity)) store.select(mark.entity as EntityRef, { focus: false });
      const current = shown();
      const next = panToInclude(current, { from: mark.at, to: mark.until ?? mark.at });
      if (next !== current) onView({ window: clampWindow(next, whole()) });
      setSaid(mark.label);
    },
    [data, store, onView, whole, shown],
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

  /** Narrow (factor < 1) or widen the window about its middle. */
  const zoom = useCallback(
    (factor: number) => {
      const w = shown();
      // A window following the live edge keeps following at the new length (L1).
      if (isFollow(view.window)) {
        const next = clampWindow({ from: w.to - (w.to - w.from) * factor, to: w.to }, whole());
        onView({ window: isAll(next) ? next : followWindow(next.to - next.from) });
        return;
      }
      // Following the live edge with the default window: anchored on the edge, still following (defect 8).
      const st = store.getState();
      const kept = followingZoom(w, (w.to - w.from) * factor, whole(), st.source === "live" && st.following);
      if (kept) {
        onView({ window: kept });
        return;
      }
      const mid = (w.from + w.to) / 2;
      const half = ((w.to - w.from) * factor) / 2;
      onView({ window: clampWindow({ from: mid - half, to: mid + half }, whole()) });
    },
    [onView, shown, whole, view.window, store],
  );
  const showAll = useCallback(() => onView({ window: ALL_WINDOW }), [onView]);
  const fitActivity = useCallback(() => onView({ window: null }), [onView]);
  const toggleGrouping = useCallback(() => onView({ grouping: view.grouping === "product" ? "execution" : "product" }), [onView, view.grouping]);
  const chooseLens = useCallback(
    (lens: LensDefinition | null) => {
      setLensOpen(false);
      // L1: a lens chosen while following the live edge keeps following (its frame sets the zoom level).
      const s = store.getState();
      // With nothing running there is nothing at the live edge to follow: the lens frames what it shows (pinned).
      const running = (spans ?? []).some(isRunning);
      const next = switchLens(lens, tree, view, shown(), lensMemos.get(store), s.source === "live" && s.following && running);
      if (next.memo) lensMemos.set(store, next.memo);
      else lensMemos.delete(store);
      onView(next.patch);
      setSaid(lens ? `${lens.label}: ${lens.about}` : "No investigation lens.");
    },
    [onView, tree, view, shown, store, spans],
  );

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

  /**
   * X8: the row never clips. Container queries collapse words to icons and move the time controls
   * into the overflow menu by width; whatever still does not fit (long lens names, many chips, a long
   * caption at an odd width) is squeezed step by step, measured after each render: 1 hides the filter
   * chips (the Filters count stays), 2 turns every label into its icon, 3 moves the time controls into
   * the overflow menu (and shortens the pinned control to "Window pinned — Follow"), and 4 (M6.6,
   * WCAG 1.4.10 and 1.4.12: at 320 CSS px, or with wider text spacing) lets the row wrap onto further
   * lines instead of clipping a control. Any change of what the row holds (`toolbarFitKey`) starts
   * again from 0.
   */
  const rowRef = useRef<HTMLDivElement>(null);
  const [squeeze, setSqueeze] = useState(0);
  const [rowWidth, setRowWidth] = useState(0);
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e?.contentRect.width ?? 0);
      setRowWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Every input that changes the row's content (the pinned control among them), not only its width.
  const fitKey = toolbarFitKey({
    rowWidth,
    lens: view.lens,
    filters: filterCount(view.filters),
    jump: lastJump,
    caption: caption === null ? false : asOf.revealed ? "revealed" : "held",
    table: view.table,
    pinnedAhead: pinned ? pinned.ahead : null,
    length: windowLengthWords(shown().to - shown().from),
  });
  const [fitFor, setFitFor] = useState(fitKey);
  if (fitFor !== fitKey) {
    setFitFor(fitKey);
    setSqueeze(0);
  }
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el || squeeze >= TOOLBAR_WRAP) return;
    if (el.scrollWidth > el.clientWidth + 1) setSqueeze((q) => Math.min(TOOLBAR_WRAP, q + 1));
  }, [squeeze, fitKey]);

  const last = jumpOf(lastJump);
  const w = shown();
  const length = windowLengthWords(w.to - w.from);
  const all = isAll(view.window);
  const activeLens: LensDefinition | null = view.lens ? (lenses?.find((l) => l.id === view.lens) ?? null) : null;
  const lensName = (id: LensId) => activeLens?.label ?? id.charAt(0).toUpperCase() + id.slice(1);

  return (
    <div className="@container shrink-0 border-b border-line bg-surface">
      <div ref={rowRef} className={cn("flex min-w-0 items-center gap-1 overflow-hidden px-2", squeeze >= TOOLBAR_WRAP ? "min-h-10 flex-wrap py-1" : "h-10")} role="toolbar" aria-label="Timeline controls" data-timeline-toolbar="" data-timeline-squeeze={squeeze || undefined}>
        <GroupingSwitch value={view.grouping} onChange={(grouping) => onView({ grouping })} />
        <Sep />

        {/* Filters, then a chip per active choice (removable). */}
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
              <span className="@max-[879px]:sr-only">Filters</span>
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
                <FilterList title="Kinds" values={options.kinds} chosen={view.filters.kinds} words={(v) => kindWords(v as SpanKind)} onToggle={(v) => setFilters({ kinds: toggled(view.filters.kinds, v as SpanKind) })} />
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
        {chips.length ? (
          <ul className={cn("flex shrink-0 items-center gap-1 @max-[999px]:hidden", squeeze >= 1 && "hidden")} aria-label="Active filters" data-timeline-chips="">
            {chips.slice(0, MAX_CHIPS).map((c) => (
              <li key={c.key} className="flex h-6 max-w-[9rem] items-center gap-0.5 rounded-full border border-line bg-surface-sunken pl-2 pr-0.5 text-caption text-ink">
                <span className="min-w-0 truncate">{c.label}</span>
                <button type="button" aria-label={`Remove the filter ${c.label}`} title={`Remove ${c.label}`} onClick={() => setFilters(c.without)} className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-surface hover:text-ink [&_svg]:size-3">
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
            {chips.length > MAX_CHIPS ? (
              <li className="shrink-0 text-caption text-ink-subtle">
                <button type="button" onClick={() => setFiltersOpen(true)} className="rounded-sm px-1 hover:text-ink" aria-label={`+${chips.length - MAX_CHIPS} more filters: open the filters`}>
                  +{chips.length - MAX_CHIPS}
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
        <Sep />

        {/* Investigation lenses. */}
        <Popover open={lensOpen} onOpenChange={setLensOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              title={lenses ? "Investigate: retries, concurrency, waits, review, recovery" : "Investigation lenses are not available in this build"}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2 text-body-sm text-ink-muted hover:bg-surface-sunken hover:text-ink [&_svg]:size-4",
                view.lens && "bg-accent-soft text-ink",
              )}
              data-timeline-investigate=""
            >
              <Microscope aria-hidden="true" />
              <span className={cn("max-w-40 truncate", view.lens ? "@max-[1099px]:sr-only" : "@max-[879px]:sr-only", squeeze >= 2 && "sr-only")}>{view.lens ? lensName(view.lens) : "Investigate"}</span>
              {view.lens ? <span className="sr-only"> lens on: investigate</span> : null}
              <ChevronDown aria-hidden="true" className="!size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[min(380px,calc(100vw-32px))] p-1.5" aria-label="Investigate">
            {lenses && lenses.length ? (
              <ul className="flex flex-col">
                {lenses.map((lens) => (
                  <li key={lens.id}>
                    <button
                      type="button"
                      aria-pressed={view.lens === lens.id}
                      onClick={() => chooseLens(lens)}
                      className={cn("flex w-full flex-col items-start gap-0.5 rounded-sm px-2.5 py-2 text-left hover:bg-surface-sunken", view.lens === lens.id && "bg-surface-sunken")}
                    >
                      <span className={cn("text-body-sm", view.lens === lens.id ? "font-semibold text-ink" : "text-ink")}>{lens.label}</span>
                      <span className="text-caption text-ink-muted">{lens.about}</span>
                    </button>
                  </li>
                ))}
                <li className="mt-1 border-t border-line pt-1">
                  <button type="button" disabled={!view.lens} onClick={() => chooseLens(null)} className="flex w-full rounded-sm px-2.5 py-2 text-left text-body-sm text-ink-muted hover:bg-surface-sunken hover:text-ink disabled:opacity-40">
                    No lens
                  </button>
                </li>
              </ul>
            ) : (
              <p className="px-2.5 py-2 text-body-sm text-ink-muted">The investigation lenses are not available in this build.</p>
            )}
          </PopoverContent>
        </Popover>
        {view.lens ? (
          <IconButton label={`Clear the ${lensName(view.lens)} lens`} onClick={() => chooseLens(null)} className="-ml-1 size-7">
            <X aria-hidden="true" />
          </IconButton>
        ) : null}
        <Sep />

        {/* Jumps: the kind is always shown. */}
        <IconButton label={`Previous ${last.label}`} shortcut="P" onClick={() => void jump(lastJump, -1)}>
          <ChevronLeft aria-hidden="true" />
        </IconButton>
        <Popover open={jumpsOpen} onOpenChange={setJumpsOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              title="Jump to a failure, retry, gate decision, human intervention or gap"
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-sm px-1.5 text-body-sm text-ink-muted hover:bg-surface-sunken hover:text-ink [&_svg]:size-3.5"
            >
              <span className="whitespace-nowrap">
                <span className={squeeze >= 2 ? "sr-only" : "@max-[1179px]:sr-only"}>Jump: </span>
                {last.plural}
              </span>
              <span className="sr-only">, choose another kind</span>
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
        <Sep />

        {/* Zoom, with the window's length in words; fit, show all, zoom to the selection. Below 760 px
            of row they move into the overflow menu (X8), so the row never clips. */}
        <span className={cn("flex shrink-0 items-center gap-1 @max-[759px]:hidden", squeeze >= 3 && "hidden")} data-timeline-secondary="">
          <IconButton label="Widen the time window" onClick={() => zoom(ZOOM_STEP)} disabled={all}>
            <Minus aria-hidden="true" />
          </IconButton>
          <span className="min-w-[4.5rem] shrink-0 whitespace-nowrap text-center text-caption text-ink tabular" data-timeline-length="" title={`${length} of the history shown`}>
            {length}
            <span className="@max-[1279px]:sr-only"> shown</span>
          </span>
          <IconButton label="Narrow the time window" onClick={() => zoom(1 / ZOOM_STEP)}>
            <Plus aria-hidden="true" />
          </IconButton>
          <LabelledButton label="Fit the recorded activity" words="Fit activity" onClick={fitActivity} pressed={view.window === null} collapseBelow={caption ? "xl" : "lg"} squeezed={squeeze >= 2}>
            <ScanLine aria-hidden="true" />
          </LabelledButton>
          <LabelledButton label="Show all of the history held" words="Show all" shortcut="A" onClick={showAll} pressed={all} collapseBelow={caption ? "xl" : "lg"} squeezed={squeeze >= 2}>
            <Maximize2 aria-hidden="true" />
          </LabelledButton>
          <IconButton label={selection ? "Zoom to the selection" : "Zoom to the selection (nothing selected)"} shortcut="Z" onClick={() => void zoomToSelection()} disabled={!selection}>
            <Crosshair aria-hidden="true" />
          </IconButton>
        </span>
        <Popover open={moreOpen} onOpenChange={setMoreOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              title={`More: zoom, fit, show all (${length} shown)`}
              className={cn("inline-flex h-8 shrink-0 items-center gap-1 rounded-sm px-1.5 text-body-sm text-ink-muted hover:bg-surface-sunken hover:text-ink [&_svg]:size-4", squeeze < 3 && "@min-[760px]:hidden")}
              data-timeline-more=""
            >
              <Ellipsis aria-hidden="true" />
              <span className="sr-only">More time controls</span>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-1.5" aria-label="More time controls">
            <p className="px-2.5 pb-1 pt-1.5 text-caption text-ink-muted tabular">{length} of the history shown</p>
            <ul className="flex flex-col">
              {(
                [
                  { words: "Narrow the window", icon: <Plus aria-hidden="true" />, run: () => zoom(1 / ZOOM_STEP) },
                  { words: "Widen the window", icon: <Minus aria-hidden="true" />, run: () => zoom(ZOOM_STEP), disabled: all },
                  { words: "Fit activity", icon: <ScanLine aria-hidden="true" />, run: fitActivity, pressed: view.window === null },
                  { words: "Show all", icon: <Maximize2 aria-hidden="true" />, run: showAll, pressed: all, key: "A" },
                  { words: "Zoom to the selection", icon: <Crosshair aria-hidden="true" />, run: () => void zoomToSelection(), disabled: !selection, key: "Z" },
                ] as Array<{ words: string; icon: ReactNode; run: () => void; disabled?: boolean; pressed?: boolean; key?: string }>
              ).map((item) => (
                <li key={item.words}>
                  <button
                    type="button"
                    disabled={item.disabled}
                    aria-pressed={item.pressed}
                    aria-keyshortcuts={item.key}
                    onClick={() => {
                      setMoreOpen(false);
                      item.run();
                    }}
                    className={cn("flex h-8 w-full items-center gap-2 rounded-sm px-2.5 text-left text-body-sm text-ink hover:bg-surface-sunken disabled:opacity-40 [&_svg]:size-4 [&_svg]:text-ink-muted", item.pressed && "font-semibold")}
                  >
                    {item.icon}
                    <span className="flex-1">{item.words}</span>
                    {item.key ? <kbd className="text-caption text-ink-subtle">{item.key}</kbd> : null}
                  </button>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>

        {pinned ? (
          // L1: a pinned window never sits beside a claim of following: it says where the live edge is, and follows it on a click.
          <button
            type="button"
            onClick={pinned.onFollow}
            data-timeline-pinned={Math.round(pinned.ahead)}
            title={`The window is pinned; the live edge is ${windowLengthWords(pinned.ahead)} ahead of its end. Follow the live edge (L).`}
            aria-keyshortcuts="L"
            className="ml-2 inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed border-line-strong px-2.5 text-caption text-ink-muted hover:text-ink"
          >
            <span>
              Window pinned<span className={cn("@max-[1099px]:hidden", squeeze >= 2 && "hidden")}> · live edge is {windowLengthWords(pinned.ahead)} ahead</span>
            </span>
            <span aria-hidden="true">—</span>
            <span className="font-semibold text-accent-ink underline decoration-1 underline-offset-[3px]">Follow</span>
          </button>
        ) : null}
        {/* What a control just said (announced), else the standing caption (not announced: it moves with the playhead). */}
        <div className="ml-2 min-w-0 flex-1 text-caption">
          <p role="status" className={said ? "truncate text-ink-subtle" : "sr-only"} title={said || undefined}>
            {said}
          </p>
          {/* Behind the live edge the reveal control below says the moment's rule itself (its title holds the sentence). */}
          {!said && caption && !asOf.behind ? (
            <p className="truncate text-ink-muted" title={caption} data-timeline-caption="">
              {/* The whole sentence where it fits; else its short form (the title keeps the sentence). */}
              <span className="@max-[1399px]:hidden">{caption}</span>
              <span className="@min-[1400px]:hidden">{asOf.caption}</span>
            </p>
          ) : null}
        </div>
        {asOf.behind ? (
          // M6.6 (I-04): scrubbed back, nothing after the playhead is drawn unless asked for; on, it is tinted and the control says so.
          <button
            type="button"
            aria-pressed={asOf.revealed}
            onClick={() => onView({ revealAfter: !asOf.revealed })}
            data-timeline-reveal-after={asOf.revealed ? "on" : "off"}
            title={`${caption ?? ""}. ${asOf.revealed ? "Select to hide it again: show only what had happened by the playhead." : "Select to show what happened after this moment, tinted, up to the live edge."}`}
            data-timeline-caption={caption ?? undefined}
            className={cn(
              "ml-auto inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-full border px-2.5 text-caption",
              asOf.revealed ? "mach-tl-after border-line-strong font-semibold text-ink" : "border-dashed border-line-strong text-ink-muted hover:text-ink",
            )}
          >
            {asOf.revealed ? (
              <>
                Showing what happened after<span className={cn("@max-[1099px]:hidden", squeeze >= 2 && "hidden")}> the playhead</span>
              </>
            ) : (
              <>
                <span className={cn("font-normal @max-[1099px]:hidden", squeeze >= 1 && "hidden")}>As of the playhead · </span>Show what happened after this moment
              </>
            )}
          </button>
        ) : null}
        <LabelledButton label={view.table ? "Show the tracks" : "Show the window as a table"} words="Table" onClick={() => onView({ table: !view.table })} pressed={view.table} collapseBelow="md" squeezed={squeeze >= 2}>
          <Table2 aria-hidden="true" />
        </LabelledButton>
      </div>
    </div>
  );
}
