/**
 * The sticky label column: the same rows as the canvas, in DOM, virtualised (one screen of overscan).
 * Each row is one target, its full width and height (never overlapping the next row): depth rails, a
 * disclosure triangle (a press there opens or closes the row, anywhere else selects it), the state
 * mark of the subtree's worst condition, the label, a quieter detail (or the row's note, in italic
 * subtle ink), and the span count. The rows are out of the Tab order: the tracks are one tab stop and
 * their keys do the same (the equivalent control under WCAG 2.5.8 for rows thinner than 24 px).
 * Resizable from 176 to 320 px by pointer or by arrow keys on the separator, a 24 px target.
 */
import { ChevronRight } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { cn, StateMark, type MarkState } from "@mach/ui";
import type { FlatRow, TrackKind, TrackLabelsProps, TrackNode } from "../contract";
import { DETAIL_MIN_CHARS, showDetail } from "./words";
import "./render.css";

export const LABEL_MIN = 176;
export const LABEL_MAX = 320;
const INDENT = 12;
/**
 * The width separator's target is 24 px (WCAG 2.5.8), centred on the column's edge: 12 px inside, where the
 * rows stop, and 12 px over the tracks' edge.
 */
const SEPARATOR = 12;

const ATTENTION: Readonly<Record<TrackNode["attention"], { state: MarkState; words: string } | null>> = {
  none: null,
  open: { state: "active", words: "work in progress" },
  person: { state: "human", words: "waiting for a person" },
  interrupted: { state: "interrupted", words: "something was interrupted" },
  failed: { state: "failed", words: "something failed" },
};


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

function AttentionMark({ attention }: { attention: TrackNode["attention"] }) {
  const a = ATTENTION[attention];
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="-6 -6 12 12" className="shrink-0 overflow-visible">
      {a ? <StateMark state={a.state} r={5} surface="var(--mach-factory-ground)" /> : null}
    </svg>
  );
}

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
  if (node.kind !== "agent") return null;
  let id = node.parentId;
  while (id) {
    const parent = layout.rowOf(id, 0)?.node;
    if (!parent) return null;
    if (parent.kind === "execution") return node.label.startsWith(parent.label) ? null : `${parent.label}: ${node.label}`;
    id = parent.parentId;
  }
  return null;
}

const LabelRow = memo(function LabelRow({ row, width, title, onToggle, onSelect }: { row: FlatRow; width: number; title: string | null; onToggle: (id: string) => void; onSelect: (node: TrackNode) => void }) {
  const { node } = row;
  const h = row.height;
  const group = row.hasChildren && node.depth <= 1;
  const style = { top: row.y, height: h };
  const indent = 6 + node.depth * INDENT;
  const disclosure = useRef<HTMLSpanElement>(null);
  if (row.lane > 0) {
    // A further lane of the same track: the rails continue, the label is on the first lane.
    return (
      <div className="absolute inset-x-0" style={style}>
        <Rails depth={node.depth + 1} />
      </div>
    );
  }
  const thin = h < 22;
  const attention = ATTENTION[node.attention];
  const mono = MONO_KINDS.has(node.kind);
  const quiet = node.note ?? node.detail;
  // The label has priority: the detail shows only when a useful part of it fits.
  const f = fonts();
  const labelPx = thin ? 11 : group ? 12.5 : mono ? 11.5 : 12;
  const labelFont = `${group && !thin ? 600 : 400} ${labelPx}px ${mono ? f.mono : f.sans}`;
  const detailFont = `${node.note ? "italic " : ""}400 ${thin ? 10.5 : 11}px ${f.sans}`;
  const countW = node.spanCount > 0 && !thin ? textWidth(node.spanCount.toLocaleString("en-GB"), `400 10.5px ${f.mono}`) + 8 : 0;
  const available = width - indent - 16 - 4 - 2 - 12 - 6 - SEPARATOR - 4 - countW;
  // An execution's detail (attempt and start) is what tells executions of one cell apart: it takes a
  // second line under the ticket, starting below the triangle, rather than whatever is left beside it.
  const twoLines = node.kind === "execution" && Boolean(quiet) && h >= 26;
  const detailShown = twoLines ? true : quiet ? showDetail(available, textWidth(node.label, labelFont), textWidth(quiet, detailFont), textWidth(`${quiet.slice(0, DETAIL_MIN_CHARS)}…`, detailFont)) : false;
  const full = [title ?? node.label, quiet, node.spanCount > 0 ? `${node.spanCount} span${node.spanCount === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");
  // One target per row, the row's full width and height: a press on the disclosure triangle (or the
  // indent before it) opens or closes the row, anywhere else selects it. Out of the Tab order: the
  // tracks are one tab stop and their keys do both (Enter, Alt+Left / Alt+Right).
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
        onClick={onClick}
        title={full}
        data-target-equivalent="tracks"
        className={cn("absolute inset-y-0 left-0 right-3 z-[1] flex text-left hover:bg-surface-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus", twoLines ? "flex-col justify-center" : "items-center gap-1")}
        data-two-lines={twoLines || undefined}
        style={{ paddingLeft: indent }}
      >
        <span className={cn("flex w-full min-w-0 items-center gap-1", twoLines && "h-[13px]")}>
        <span ref={disclosure} aria-hidden="true" className="inline-flex size-4 shrink-0 items-center justify-center text-ink-subtle">
          {row.hasChildren ? <ChevronRight className={cn("size-3.5", row.expanded && "rotate-90")} /> : null}
        </span>
        <AttentionMark attention={node.attention} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 pl-0.5">
          <span
            className={cn(
              "block min-w-0 max-w-full shrink-0 truncate leading-tight",
              mono ? "font-mono" : "",
              thin ? "text-[11px] text-ink-muted" : group ? "text-[12.5px] font-semibold text-ink" : "text-[12px] text-ink",
              mono && !thin && "text-[11.5px]",
            )}
          >
            {node.label}
          </span>
          {quiet && detailShown && !twoLines ? (
            <span className={cn("block min-w-0 flex-1 truncate leading-tight text-ink-subtle", thin ? "text-[10.5px]" : "text-[11px]", node.note && "italic")}>
              {quiet}
            </span>
          ) : quiet ? (
            <span className="sr-only">, {quiet}</span>
          ) : null}
          {attention ? <span className="sr-only">, {attention.words}</span> : null}
          {row.hasChildren ? <span className="sr-only">, {row.expanded ? "expanded" : "collapsed"}</span> : null}
        </span>
        {node.spanCount > 0 && !thin ? (
          <span className="min-w-[3ch] shrink-0 pr-1 text-right font-mono text-[10.5px] text-ink-subtle tabular-nums" title={`${node.spanCount} span${node.spanCount === 1 ? "" : "s"} in this track and below`}>
            <span className="sr-only">, </span>
            {node.spanCount.toLocaleString("en-GB")}
            <span className="sr-only"> spans</span>
          </span>
        ) : null}
        </span>
        {twoLines ? (
          <span className="block h-[12px] min-w-0 truncate text-[10.5px] leading-[12px] text-ink-subtle tabular-nums">
            <span className="sr-only">, </span>
            {quiet}
          </span>
        ) : null}
      </button>
    </div>
  );
});

export const TrackLabels = memo(function TrackLabels({ layout, height, scrollTop, width, onToggle, onSelect, onResize, onScroll }: TrackLabelsProps) {
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
          <LabelRow key={`${r.node.id}#${r.lane}`} row={r} width={width} title={fullTitle(layout, r.node)} onToggle={onToggle} onSelect={onSelect} />
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
