/**
 * The sticky label column: the same rows as the canvas, in DOM, virtualised (one screen of overscan).
 * Each row is one target, its full width and height (never overlapping the next row): depth rails, a
 * disclosure triangle (a press there opens or closes the row, anywhere else selects it), the state
 * mark of the subtree's worst condition, the label, a quieter detail (or the row's note, in italic
 * subtle ink), and the span count. The rows are out of the Tab order: the tracks are one tab stop and
 * their keys do the same (the equivalent control under WCAG 2.5.8 for rows thinner than 24 px).
 * Resizable from 176 to 320 px by pointer or by arrow keys on the separator, a 24 px target; 224 px
 * by default (LABEL_DEFAULT), so ids are not cut.
 *
 * The mark is the row's OWN state (render/words.ts nodeState): a parent never wears a child's failure;
 * what happened beneath it is said as counts in the attention ink ("2 rejections"). A label too long
 * for the column drops its trailing " · " details before its id is ever cut (fitLabel).
 *
 * A press never moves focus here (Space stays play and pause everywhere in the workspace).
 */
import { ChevronRight } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { cn, StateMark, type MarkState } from "@mach/ui";
import type { FlatRow, TrackKind, TrackLabelsProps, TrackNode } from "../contract";
import { laneWords } from "../tracks/lanes";
import { countsTone, countsWords, DETAIL_MIN_CHARS, executionTitle, fitLabel, nodeState, shortNote, showDetail, showsCounts, shownCounts } from "./words";
import "./render.css";

export const LABEL_MIN = 176;
/** The column's width until a person resizes it: wide enough for "LOCAL-001 · run 2/3". */
export const LABEL_DEFAULT = 224;
export const LABEL_MAX = 320;
const INDENT = 12;
/**
 * The width separator's target is 24 px (WCAG 2.5.8), centred on the column's edge: 12 px inside, where the
 * rows stop, and 12 px over the tracks' edge.
 */
const SEPARATOR = 12;


let measurer: CanvasRenderingContext2D | null = null;
const measured = new Map<string, number>();
/** Text width in CSS px for a font, measured once (falls back to an estimate where there is no canvas). */
function textWidth(text: string, font: string): number {
  const key = `${font}|${text}`;
  const hit = measured.get(key);
  if (hit !== undefined) return hit;
  if (!measurer && typeof document !== "undefined") measurer = document.createElement("canvas").getContext("2d");
  let w = text.length * 6.6;
  if (measurer) {
    measurer.font = font;
    w = measurer.measureText(text).width;
  }
  if (measured.size > 2000) measured.clear();
  measured.set(key, w);
  return w;
}


const MONO_KINDS: ReadonlySet<TrackKind> = new Set<TrackKind>(["wave", "slice", "cell", "execution"]);

function OwnMark({ state }: { state: MarkState | null }) {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="-6 -6 12 12" className="shrink-0 overflow-visible">
      {state ? <StateMark state={state} r={5} surface="var(--mach-factory-ground)" /> : null}
    </svg>
  );
}

const TONE_INK = { fail: "var(--mach-factory-fail)", halt: "var(--mach-factory-halt)", muted: "var(--mach-ink-muted)" } as const;

function Rails({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, d) => (
        <span key={d} aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-[2] w-px" style={{ left: 14 + d * INDENT, background: "var(--mach-factory-grid-major)" }} />
      ))}
    </>
  );
}

function fonts(): { sans: string; mono: string } {
  if (typeof document === "undefined") return { sans: "sans-serif", mono: "monospace" };
  const cs = getComputedStyle(document.documentElement);
  return { sans: cs.getPropertyValue("--mach-font-sans").trim() || "sans-serif", mono: cs.getPropertyValue("--mach-font-mono").trim() || "monospace" };
}

/**
 * The full words of a label the tracks shortened: an agent or workflow under an execution drops the
 * execution's ticket from its label ("LOCAL-001: build" reads "build"), and its title says it again.
 */
function fullTitle(layout: TrackLabelsProps["layout"], node: TrackNode): string | null {
  if (node.kind === "execution") return executionTitle(node);
  if (node.kind !== "agent") return null;
  let id = node.parentId;
  while (id) {
    const parent = layout.rowOf(id, 0)?.node;
    if (!parent) return null;
    if (parent.kind === "execution") {
      const ticket = parent.label.split(" · ")[0] as string;
      return node.label.startsWith(ticket) ? null : `${ticket}: ${node.label}`;
    }
    id = parent.parentId;
  }
  return null;
}

const LabelRow = memo(function LabelRow({ row, width, title, liveAt, onToggle, onSelect }: { row: FlatRow; width: number; title: string | null; liveAt: number; onToggle: (id: string) => void; onSelect: (node: TrackNode) => void }) {
  const { node } = row;
  const h = row.height;
  const group = row.hasChildren && node.depth <= 1;
  const style = { top: row.y, height: h };
  const indent = 6 + node.depth * INDENT;
  const disclosure = useRef<HTMLSpanElement>(null);
  if (row.lane > 0) {
    // A further lane of the same track: the rails continue, the label is on the first lane, and the lane
    // says what it holds ("lane 2 · 4 agents"), never a blank band (round 6, defect 5).
    const words = laneWords(node, row.lane);
    return (
      <div className="absolute inset-x-0" style={style} title={`${node.label}, ${words}: lanes hold what did not overlap in time`}>
        <Rails depth={node.depth + 1} />
        <span className="absolute inset-y-0 right-3 flex items-center truncate whitespace-nowrap text-[10.5px] leading-tight text-ink-subtle" style={{ left: indent + 16 + 4 + 12 + 2 }}>
          {words}
        </span>
      </div>
    );
  }
  const thin = h < 22;
  const own = nodeState(node, liveAt);
  const mono = MONO_KINDS.has(node.kind);
  const quiet = node.note ?? node.detail;
  // Shown: a shorter form of a long note (its full words are in the title).
  const quietShown = node.note ? shortNote(node.note) : node.detail;
  const counted = showsCounts(node) ? countsWords(shownCounts(node)) : [];
  const tone = countsTone(shownCounts(node));
  const f = fonts();
  const labelPx = thin ? 11 : group ? 12.5 : mono ? 11.5 : 12;
  const labelFont = `${group && !thin ? 600 : 400} ${labelPx}px ${mono ? f.mono : f.sans}`;
  const detailFont = `${node.note ? "italic " : ""}400 ${thin ? 10.5 : 11}px ${f.sans}`;
  const countsFont = `500 ${thin ? 10 : 10.5}px ${f.sans}`;
  const countText = node.spanCount.toLocaleString("en-GB");
  const countW = node.spanCount > 0 && !thin ? textWidth(countText, `400 10.5px ${f.mono}`) + 8 : 0;
  const base = width - indent - 16 - 4 - 2 - 12 - 6 - SEPARATOR - 4;
  // Priority: the label (dropping its " · " details before cutting an id), the counts, the span count,
  // then the quieter detail; what does not fit is in the title.
  const label = fitLabel(node.label, base, (t) => textWidth(t, labelFont));
  const labelW = textWidth(label.text, labelFont);
  let room = base - labelW;
  let countsText = counted.join(", ");
  if (countsText) {
    const short = counted[0] as string;
    if (textWidth(countsText, countsFont) + 6 <= room) room -= textWidth(countsText, countsFont) + 6;
    else if (textWidth(short, countsFont) + 6 <= room) {
      countsText = counted.length > 1 ? `${short} +` : short;
      room -= textWidth(countsText, countsFont) + 6;
    } else countsText = "";
  }
  const countShown = countW > 0 && countW <= room;
  if (countShown) room -= countW;
  // A label that had to drop its own details (a run, a start) keeps the room: the quieter detail goes first.
  const detailShown = quietShown && !label.truncated && !label.dropped ? showDetail(room + labelW, labelW, textWidth(quietShown, detailFont), textWidth(`${quietShown.slice(0, DETAIL_MIN_CHARS)}…`, detailFont)) : false;
  // For sighted readers: the full label, then its state and counts, then the spans; one line each.
  const head = [node.label, quiet].filter(Boolean).join(" — ");
  const state = [own.words, ...counted].filter(Boolean).join("; ");
  const full = [title ?? head, state ? state[0]!.toUpperCase() + state.slice(1) : null, node.spanCount > 0 ? `${countText} span${node.spanCount === 1 ? "" : "s"} recorded here and below` : null].filter(Boolean).join("\n");
  // One target per row, the row's full width and height: a press on the disclosure triangle (or the
  // indent before it) opens or closes the row, anywhere else selects it. Out of the Tab order, and a
  // press never takes focus (Space must stay play and pause): the tracks are one tab stop and their
  // keys do both (Enter, Alt+Left / Alt+Right).
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    const tri = disclosure.current;
    if (row.hasChildren && tri && e.clientX <= tri.getBoundingClientRect().right + 2) onToggle(node.id);
    else onSelect(node);
  };
  return (
    <div className={cn("absolute inset-x-0", group && "border-t")} style={{ ...style, borderColor: group ? "var(--mach-factory-grid-major)" : undefined }}>
      <Rails depth={node.depth} />
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          // Never reached by Tab; should focus land here anyway, Space is play and pause, not a press.
          if (e.key === " ") e.preventDefault();
        }}
        onClick={onClick}
        title={full}
        data-target-equivalent="tracks"
        className="absolute inset-y-0 left-0 right-3 z-[1] flex items-center gap-1 text-left hover:bg-surface-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
        style={{ paddingLeft: indent }}
      >
        <span ref={disclosure} aria-hidden="true" className="inline-flex size-4 shrink-0 items-center justify-center text-ink-subtle">
          {row.hasChildren ? <ChevronRight className={cn("size-3.5", row.expanded && "rotate-90")} /> : null}
        </span>
        <OwnMark state={own.state} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden whitespace-nowrap pl-0.5">
          <span
            className={cn(
              "block min-w-0 shrink-0 truncate leading-tight",
              mono ? "font-mono" : "",
              thin ? "text-[11px] text-ink-muted" : group ? "text-[12.5px] font-semibold text-ink" : "text-[12px] text-ink",
              mono && !thin && "text-[11.5px]",
            )}
            style={{ maxWidth: "100%" }}
          >
            {label.text}
          </span>
          {label.dropped ? <span className="sr-only"> · {label.dropped}</span> : null}
          {countsText ? (
            <span className={cn("block shrink-0 font-medium leading-tight", thin ? "text-[10px]" : "text-[10.5px]")} style={{ color: tone ? TONE_INK[tone] : undefined }} aria-hidden="true">
              {countsText}
            </span>
          ) : null}
          {quietShown && detailShown ? (
            <span className={cn("block min-w-0 flex-1 truncate leading-tight text-ink-subtle", thin ? "text-[10.5px]" : "text-[11px]", node.note && "italic")}>
              <span aria-hidden={quietShown !== quiet || undefined}>{quietShown}</span>
              {quietShown !== quiet ? <span className="sr-only">{quiet}</span> : null}
            </span>
          ) : quiet ? (
            <span className="sr-only">, {quiet}</span>
          ) : null}
          {own.words ? <span className="sr-only">, {own.words}</span> : null}
          {counted.length ? <span className="sr-only">, {counted.join(", ")}</span> : null}
          {row.hasChildren ? <span className="sr-only">, {row.expanded ? "expanded" : "collapsed"}</span> : null}
        </span>
        {countShown ? (
          <span className="min-w-[3ch] shrink-0 pr-1 text-right font-mono text-[10.5px] text-ink-subtle tabular-nums">
            <span className="sr-only">, </span>
            {countText}
            <span className="sr-only"> spans</span>
          </span>
        ) : null}
      </button>
    </div>
  );
});

export const TrackLabels = memo(function TrackLabels({ layout, height, scrollTop, width, onToggle, onSelect, onResize, onScroll }: TrackLabelsProps) {
  // The tree was built at the live edge: a node's attention already holds what is known there, so the
  // labels need no subscription to time (they would re-render every frame).
  const liveAt = Number.POSITIVE_INFINITY;
  // One screen of overscan above and below.
  const rows = layout.slice(Math.max(0, scrollTop - height), scrollTop + 2 * height);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.max(LABEL_MIN, Math.min(LABEL_MAX, w)));
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: width };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) onResize(clamp(d.w + e.clientX - d.x));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === "ArrowLeft") onResize(clamp(width - step));
    else if (e.key === "ArrowRight") onResize(clamp(width + step));
    else if (e.key === "Home") onResize(LABEL_MIN);
    else if (e.key === "End") onResize(LABEL_MAX);
    else return;
    e.preventDefault();
  };
  // The wheel over the labels scrolls the rows (cancellable, so the page does not scroll instead).
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef({ scrollTop, height, total: layout.totalHeight, onScroll });
  useLayoutEffect(() => {
    latest.current = { scrollTop, height, total: layout.totalHeight, onScroll };
  });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      const L = latest.current;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? L.height : 1;
      const dy = e.deltaY * unit;
      if (!dy) return;
      e.preventDefault();
      const next = Math.max(0, Math.min(Math.max(0, L.total - L.height), L.scrollTop + dy));
      if (next === L.scrollTop) return;
      // Wheel events arrive faster than the caller re-renders: build on what was last asked for.
      L.scrollTop = next;
      L.onScroll(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <div ref={box} className="relative shrink-0" style={{ width, height, background: "var(--mach-factory-ground)", borderRight: "1px solid var(--mach-factory-plate-edge)" }}>
      <div className="absolute inset-0 overflow-hidden">
      <div className="absolute inset-x-0 top-0" style={{ transform: `translateY(${-scrollTop}px)`, height: layout.totalHeight }}>
        {rows.map((r) => (
          <LabelRow key={`${r.node.id}#${r.lane}`} row={r} width={width} title={fullTitle(layout, r.node)} liveAt={liveAt} onToggle={onToggle} onSelect={onSelect} />
        ))}
      </div>
      </div>
      {/* A focusable separator is a widget (WAI-ARIA window splitter); the lint rule counts it as static. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Label column width"
        aria-valuemin={LABEL_MIN}
        aria-valuemax={LABEL_MAX}
        aria-valuenow={width}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={onKey}
        className="group absolute inset-y-0 -right-3 z-[2] flex w-6 cursor-col-resize touch-none justify-center outline-hidden"
      >
        <span aria-hidden="true" className="h-full w-1 group-hover:bg-line-strong group-focus-visible:bg-focus" />
      </div>
    </div>
  );
});
