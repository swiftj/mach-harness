/**
 * The investigation band (M6.3, investigate/): a compact panel between the overview and the tracks for
 * the lens in use. At most 220 px high, and at most 30 % of the height below its top so the tracks keep
 * the larger part (`bandMaxHeight`), with its own scroll and a cue at an edge with more beyond it;
 * collapsible to its 28 px header. Each lens is a drawing in the Living Factory's language whose every
 * figure reveals the record it comes from: a click or Enter selects, Enter again or a double-click goes
 * to it (seeks), as on the tracks (X13).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { InvestigationPanelProps } from "../contract";
import { useSceneStore, useStore } from "../../scene";
import type { SelectGesture, TrackNode, TrackTree } from "../contract";
import { useAsOf } from "../controls";
import type { BodyProps } from "./body";
import { BandGesture, BandRoving, rovingKeys, rovingSync } from "./figures";
import { lensGesture } from "./gesture";
import { ConcurrencyBody } from "./Concurrency";
import { lensOf } from "./lenses";
import { bandMaxHeight, overflowCue, ticketOfRef } from "./model";
import { RecoveryBody } from "./Recovery";
import { RetriesBody } from "./Retries";
import { ReviewBody } from "./Review";
import { useLensData } from "./useLensData";
import { WaitsBody } from "./Waits";
import "./investigate.css";

export const PANEL_MAX_HEIGHT = 220;
export const PANEL_HEADER_HEIGHT = 28;

/** Each row's position among the tracks' rows, by its id (a seat row's id is its ref). */
function rowOrderOf(tree: TrackTree): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (n: TrackNode) => {
    out.set(n.id, out.size);
    n.children.forEach(walk);
  };
  tree.roots.forEach(walk);
  return out;
}

const BODIES = { retries: RetriesBody, concurrency: ConcurrencyBody, waits: WaitsBody, review: ReviewBody, recovery: RecoveryBody } as const;

export function InvestigationPanel(props: InvestigationPanelProps) {
  const lens = lensOf(props.lens);
  const [collapsed, setCollapsed] = useState(false);
  const selection = useSceneStore((s) => s.selection);
  const lensData = useLensData(props.data, props.viewport.window, props.lens === "concurrency");
  const asOf = useAsOf();
  const store = useStore();
  const rowOrder = useMemo(() => rowOrderOf(props.tree), [props.tree]);
  // Selecting a figure never seeks; "go to" (Enter again, a double-click) does (X13).
  const gesture = useMemo(() => lensGesture(() => store.getState().selection), [store]);
  const go = useRef(false);
  const decide = useCallback(
    (key: string, how: SelectGesture) => {
      const seek = gesture.decide(key, how);
      go.current = seek;
      return seek;
    },
    [gesture],
  );
  const { onReveal: reveal } = props;
  const onReveal = useCallback(
    (ref: string, at?: number) => {
      const seek = go.current;
      go.current = false;
      reveal(ref, seek ? at : undefined);
      if (!seek) gesture.settle();
    },
    [gesture, reveal],
  );
  // The band's height cap from the room below its top, and the cues at a scrolled edge.
  const scroller = useRef<HTMLDivElement>(null);
  const [maxH, setMaxH] = useState(PANEL_MAX_HEIGHT);
  const [cue, setCue] = useState({ above: false, below: false });
  const measure = useCallback(() => {
    const el = scroller.current;
    if (el) {
      const c = overflowCue(el.scrollTop, el.clientHeight, el.scrollHeight);
      setCue((p) => (p.above === c.above && p.below === c.below ? p : c));
    }
    const top = ref.current?.getBoundingClientRect().top;
    if (top !== undefined) setMaxH(bandMaxHeight(globalThis.innerHeight - top));
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    globalThis.addEventListener("resize", measure);
    // Its size, and anything added or removed inside it (a drawing, a hover card), can change what overflows.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(measure);
    if (scroller.current) {
      ro?.observe(scroller.current);
      mo?.observe(scroller.current, { childList: true, subtree: true });
    }
    return () => {
      globalThis.removeEventListener("resize", measure);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [measure, collapsed, props.lens]);
  // ONE tab stop for the whole band: the header buttons and every figure are reached by the arrow keys.
  const ref = useRef<HTMLElement>(null);
  const active = useRef<string | null>(null);
  useLayoutEffect(() => rovingSync(ref.current, active.current));
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const k = rovingKeys(ref.current, e);
    if (k !== undefined) active.current = k;
  }, []);
  if (!lens) return null;
  const Body = BODIES[lens.id];
  const bodyId = `mach-inv-body-${lens.id}`;
  const body: BodyProps = {
    spans: props.spans,
    marks: lensData.marks,
    series: lensData.series,
    status: lensData.status,
    viewport: props.viewport,
    width: props.width,
    selectedTicket: ticketOfRef(selection),
    rowOrder,
    onReveal,
    onWiden: () => props.onView({ window: null }),
    onFrame: (window, about) => {
      props.onView({ window });
      props.onFrameRows?.(about);
    },
  };
  const incomplete = (lensData.marks as { complete?: boolean; truncated?: boolean }).complete === false || (lensData.marks as { truncated?: boolean }).truncated === true;
  const partial = props.lens === "concurrency" && lensData.series !== null && lensData.series.complete === false && lensData.series.buckets.length > 0;
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the band's one roving-tabindex group: arrow keys move between its parts.
    <section
      ref={ref}
      aria-label={`Investigation: ${lens.label}`}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        const t = e.target as HTMLElement;
        active.current = t.dataset?.rove ?? t.dataset?.fig ?? active.current;
      }}
      className="relative shrink-0 border-b border-line bg-surface"
      style={{ width: props.width, maxHeight: maxH }}
    >
      <header className="flex items-center gap-2 border-b border-line pr-1" style={{ height: PANEL_HEADER_HEIGHT }}>
        <button
          type="button"
          data-rove="collapse"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => setCollapsed((c) => !c)}
          className="flex h-full shrink-0 items-center gap-1 rounded-xs px-2 text-body-sm font-semibold text-ink hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--mach-focus)]"
        >
          {collapsed ? <ChevronRight aria-hidden="true" className="size-4 text-ink-muted" /> : <ChevronDown aria-hidden="true" className="size-4 text-ink-muted" />}
          {lens.label}
        </button>
        <p className="min-w-0 flex-1 truncate text-[11px] text-ink-subtle" title={lens.about}>
          {lens.about}
        </p>
        <button
          type="button"
          data-rove="close"
          aria-label={`Close the lens: ${lens.label}`}
          onClick={() => props.onView({ lens: null })}
          className="flex size-6 shrink-0 items-center justify-center rounded-xs text-ink-muted hover:bg-surface-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-[var(--mach-focus)]"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </header>
      {collapsed ? null : (
        <div className="relative">
        <div ref={scroller} id={bodyId} onScroll={measure} className="overflow-x-auto overflow-y-auto" style={{ maxHeight: maxH - PANEL_HEADER_HEIGHT - 1 }}>
          {asOf.caption || incomplete || partial ? (
            <p className="px-2 pt-1 text-[11px] leading-[15px] text-ink-muted" data-lens-caption="">
              {[asOf.caption, incomplete ? "Landmarks incomplete in this window: the source returned only part of them" : null, partial ? "Counts partial: the source did not answer for the whole window" : null].filter(Boolean).join(". ")}.
            </p>
          ) : null}
          <BandRoving.Provider value={true}>
            <BandGesture.Provider value={decide}>
              <Body {...body} />
            </BandGesture.Provider>
          </BandRoving.Provider>
        </div>
        {/* More beyond a scrolled edge: a shade and a word, so a row cut at the edge reads as "scroll", not lost. */}
        {cue.above ? <div aria-hidden="true" data-lens-cue="above" className="pointer-events-none absolute inset-x-0 top-0 h-3 bg-gradient-to-b from-surface to-transparent" /> : null}
        {cue.below ? (
          <div aria-hidden="true" data-lens-cue="below" className="pointer-events-none absolute inset-x-0 bottom-0 flex h-6 items-end justify-end bg-gradient-to-t from-surface via-surface/80 to-transparent pr-3 pb-0.5">
            <span className="rounded-xs bg-surface px-1 text-[10.5px] leading-[14px] text-ink-muted">More below · scroll</span>
          </div>
        ) : null}
        </div>
      )}
    </section>
  );
}
