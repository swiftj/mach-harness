/**
 * The sticky label column: the same rows as the canvas, in DOM, virtualised (one screen of overscan).
 * Each row: depth rails, a disclosure triangle (a 24 px target even in a thin row), the state mark of
 * the subtree's worst condition, the label, a quieter detail (or the row's note, in italic subtle ink),
 * and the span count. Resizable from 176 to 320 px by pointer or by arrow keys on the separator.
 */
import { ChevronRight } from "lucide-react";
import { memo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn, StateMark, type MarkState } from "@mach/ui";
import type { FlatRow, TrackKind, TrackLabelsProps, TrackNode } from "../contract";
import "./render.css";

export const LABEL_MIN = 176;
export const LABEL_MAX = 320;
const INDENT = 12;

const ATTENTION: Readonly<Record<TrackNode["attention"], { state: MarkState; words: string } | null>> = {
  none: null,
  open: { state: "active", words: "work in progress" },
  person: { state: "human", words: "waiting for a person" },
  interrupted: { state: "interrupted", words: "something was interrupted" },
  failed: { state: "failed", words: "something failed" },
};

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
        <span key={d} aria-hidden="true" className="absolute inset-y-0 w-px" style={{ left: 14 + d * INDENT, background: "var(--mach-factory-grid-major)" }} />
      ))}
    </>
  );
}

const LabelRow = memo(function LabelRow({ row, onToggle, onSelect }: { row: FlatRow; onToggle: (id: string) => void; onSelect: (node: TrackNode) => void }) {
  const { node } = row;
  const h = row.height;
  const group = row.hasChildren && node.depth <= 1;
  const style = { top: row.y, height: h };
  const indent = 6 + node.depth * INDENT;
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
  return (
    <div className={cn("absolute inset-x-0 flex items-center gap-1 pr-2", group && "border-t")} style={{ ...style, paddingLeft: indent, borderColor: group ? "var(--mach-factory-grid-major)" : undefined }}>
      <Rails depth={node.depth} />
      {row.hasChildren ? (
        <button
          type="button"
          onClick={() => onToggle(node.id)}
          aria-expanded={row.expanded}
          aria-label={`${row.expanded ? "Collapse" : "Expand"} ${node.label}`}
          className="mach-tl-hit relative z-[1] inline-flex size-4 shrink-0 items-center justify-center rounded-xs text-ink-subtle hover:bg-surface-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
        >
          <ChevronRight aria-hidden="true" className={cn("size-3.5", row.expanded && "rotate-90")} />
        </button>
      ) : (
        <span aria-hidden="true" className="size-4 shrink-0" />
      )}
      <button
        type="button"
        onClick={() => onSelect(node)}
        className={cn("relative z-[1] flex min-w-0 flex-1 items-center gap-1.5 rounded-xs px-0.5 text-left hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-focus", thin ? "h-full" : "py-0.5")}
      >
        <AttentionMark attention={node.attention} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
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
          {quiet ? (
            <span className={cn("block min-w-0 flex-1 truncate leading-tight text-ink-subtle", thin ? "text-[10.5px]" : "text-[11px]", node.note && "italic")}>
              {node.note ?? node.detail}
            </span>
          ) : null}
          {attention ? <span className="sr-only">, {attention.words}</span> : null}
        </span>
        {node.spanCount > 0 && !thin ? (
          <span className="shrink-0 font-mono text-[10.5px] text-ink-subtle tabular" title={`${node.spanCount} span${node.spanCount === 1 ? "" : "s"} in this track and below`}>
            <span className="sr-only">, </span>
            {node.spanCount.toLocaleString("en-GB")}
            <span className="sr-only"> spans</span>
          </span>
        ) : null}
      </button>
    </div>
  );
});

export const TrackLabels = memo(function TrackLabels({ layout, height, scrollTop, width, onToggle, onSelect, onResize }: TrackLabelsProps) {
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
  return (
    <div className="relative shrink-0 overflow-hidden" style={{ width, height, background: "var(--mach-factory-ground)", borderRight: "1px solid var(--mach-factory-plate-edge)" }}>
      <div className="absolute inset-x-0 top-0" style={{ transform: `translateY(${-scrollTop}px)`, height: layout.totalHeight }}>
        {rows.map((r) => (
          <LabelRow key={`${r.node.id}#${r.lane}`} row={r} onToggle={onToggle} onSelect={onSelect} />
        ))}
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
        className="absolute inset-y-0 right-0 z-[2] w-1.5 cursor-col-resize touch-none hover:bg-line-strong focus-visible:bg-focus focus-visible:outline-none"
      />
    </div>
  );
});
