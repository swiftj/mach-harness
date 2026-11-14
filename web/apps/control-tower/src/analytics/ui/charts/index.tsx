/**
 * Factory Analytics' charts, in SVG (and one HTML table). Each draws rows it is given and adds
 * nothing: zero baselines wherever a length encodes a value, one scale per chart (never two
 * y-axes), log time axes labelled as such, hairline grids, tabular numbers, a hit area larger than
 * the mark, one Tab stop per chart with the arrows moving between marks, and a card with exact
 * values on hover or focus.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import type { HistBucket } from "../../contract";
import { durationTicks, histogramBins, linear, logScale, niceTicks, stepPath, type HistBin } from "../../model/charts";
import { dayText, durationText, durationTick, plural } from "../../model/format";
import { brushIndices, brushWindow, pageOf, sortRows, type SortDir } from "../../model/series";
import { chartKey } from "../keys";
import { cardWords, Mark, useMarkNav, useTip, useWidth, type Card } from "../kit";
import type { Interval } from "../types";

const NUM = { fontFamily: "var(--mach-font-sans)", fontVariantNumeric: "tabular-nums" } as const;
const AXIS_TEXT = { ...NUM, fontSize: 11, fill: "var(--an-subtle)" } as const;
const SANS = { fontFamily: "var(--mach-font-sans)" } as const;

// ------------------------------------------------------------------------------------- columns

export interface ColumnPoint {
  readonly key: string;
  readonly value: number | null;
  /** Shown under the axis when set. */
  readonly tick?: string | undefined;
  readonly card: Card;
  /** A second part of the same unit stacked on the value, with a 2px gap (e.g. failed above passed). */
  readonly stack?: number;
  /** Hatched behind the column: something in this period was not recorded (its value is a lower bound). */
  readonly flag?: boolean;
  /** The period the column stands for, for the brush. */
  readonly from?: number;
  readonly to?: number;
}

/**
 * Columns from zero. A null value draws no column and a small open mark on the baseline: no value is
 * not zero. With `onWindow`, dragging across the columns (or Shift and the arrows, then Enter) sets
 * the workspace window to those periods.
 */
export function Columns({ points, height = 150, format, tone = "var(--an-bar)", stackTone = "var(--an-fail)", onActivate, selected, minTop, onWindow, label, focusable = true, ringed = false, series }: { points: readonly ColumnPoint[]; height?: number; format(v: number): string; tone?: string; stackTone?: string; onActivate?: ((key: string) => void) | undefined; selected?: string | null | undefined; minTop?: number; onWindow?: ((w: Interval) => void) | undefined; label: string; focusable?: boolean; ringed?: boolean; series?: string | undefined }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [, setTip, tipNode] = useTip(width);
  const nav = useMarkNav(points.length);
  const left = 40;
  const right = 8;
  const top = 10;
  const bottom = 22;
  const max = Math.max(minTop ?? 0, ...points.map((p) => (p.value ?? 0) + (p.stack ?? 0)));
  const ticks = niceTicks(max, Math.max(1, Math.min(3, Math.floor((height - top - bottom) / 26))));
  const y = linear(0, ticks[ticks.length - 1]!, height - bottom, top);
  const plotW = width - left - right;
  const step = plotW / Math.max(1, points.length);
  const bw = Math.max(2, Math.min(30, step - Math.max(2, step * 0.24)));
  // Tick labels never meet: one is shown only where it clears the last one shown by 56px.
  const shownTicks = new Set<number>();
  {
    let last = -Infinity;
    points.forEach((p, i) => {
      const cx = left + i * step + step / 2;
      if (p.tick && cx - last >= 56) {
        shownTicks.add(i);
        last = cx;
      }
    });
  }
  const brushable = !!onWindow && points.length > 1 && points.every((p) => p.from !== undefined && p.to !== undefined);
  const periods = brushable ? points.map((p) => ({ from: p.from!, to: p.to! })) : [];

  // The brush: a drag in pixels, or a keyboard selection of periods.
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [sel, setSel] = useState<{ anchor: number; first: number; last: number } | null>(null);
  const dragged = useRef(false);
  const svg = useRef<SVGSVGElement>(null);
  const localX = (e: PointerEvent) => e.clientX - (svg.current?.getBoundingClientRect().left ?? 0);
  const apply = (first: number, last: number) => {
    const w = brushWindow(periods, first, last);
    setSel(null);
    if (w && onWindow) onWindow(w);
  };
  const dragSel = drag ? brushIndices(drag.a, drag.b, left, left + plotW, points.length) : null;
  const shown = dragSel ?? (sel ? { first: sel.first, last: sel.last } : null);
  const brushKey = (i: number, e: KeyboardEvent): boolean => {
    if (!brushable) return false;
    if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const anchor = sel?.anchor ?? i;
      const edge = sel ? (sel.first === anchor ? sel.last : sel.first) : i;
      const next = Math.max(0, Math.min(points.length - 1, edge + (e.key === "ArrowRight" ? 1 : -1)));
      setSel({ anchor, first: Math.min(anchor, next), last: Math.max(anchor, next) });
      nav.focusAt(next);
      return true;
    }
    if (e.key === "Enter" && sel) {
      e.preventDefault();
      apply(sel.first, sel.last);
      return true;
    }
    if (e.key === "Escape" && sel) {
      setSel(null);
      return true;
    }
    return false;
  };
  const handleKey = (which: "first" | "last") => (e: KeyboardEvent) => {
    if (chartKey(e.key, true, { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey }).stop) e.stopPropagation();
    if (!sel) return;
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (d) {
      e.preventDefault();
      const v = Math.max(0, Math.min(points.length - 1, sel[which] + d));
      const first = which === "first" ? Math.min(v, sel.last) : sel.first;
      const last = which === "last" ? Math.max(v, sel.first) : sel.last;
      setSel({ anchor: sel.anchor, first, last });
    } else if (e.key === "Enter") {
      e.preventDefault();
      apply(sel.first, sel.last);
    } else if (e.key === "Escape") setSel(null);
  };

  return (
    <div ref={ref} className="relative" style={{ height }}>
      <svg
        ref={svg}
        width={width}
        height={height}
        role="group"
        aria-label={label}
        className={brushable ? "an-plot-brushable" : undefined}
        style={{ display: "block", overflow: "visible", touchAction: brushable ? "pan-y" : undefined }}
        onPointerDown={
          brushable
            ? (e) => {
                if (e.button !== 0) return;
                dragged.current = false;
                (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
                setDrag({ a: localX(e), b: localX(e) });
              }
            : undefined
        }
        onPointerMove={
          brushable
            ? (e) => {
                if (!drag) return;
                if (Math.abs(localX(e) - drag.a) > 4) dragged.current = true;
                setDrag({ a: drag.a, b: localX(e) });
              }
            : undefined
        }
        onPointerUp={
          brushable
            ? () => {
                const r = dragSel;
                setDrag(null);
                if (r && dragged.current) apply(r.first, r.last);
              }
            : undefined
        }
        onClickCapture={(e) => {
          if (dragged.current) {
            e.stopPropagation();
            dragged.current = false;
          }
        }}
      >
        {ticks.map((t) => (
          <g key={t} aria-hidden="true">
            <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} style={{ stroke: t === 0 ? "var(--an-axis)" : "var(--an-grid)", strokeWidth: 1 }} />
            <text x={left - 6} y={y(t) + 3.5} textAnchor="end" style={AXIS_TEXT}>
              {format(t)}
            </text>
          </g>
        ))}
        {shown ? <rect className="an-brush-sel" x={left + shown.first * step} y={top - 4} width={(shown.last - shown.first + 1) * step} height={height - bottom - top + 4} rx={2} aria-hidden="true" /> : null}
        {points.map((p, i) => {
          const cx = left + i * step + step / 2;
          const x = cx - bw / 2;
          const v = p.value ?? 0;
          const h = y(0) - y(v);
          const sh = p.stack ? y(0) - y(p.stack) : 0;
          const quiet = selected && selected !== p.key;
          const tickAnchor = cx > width - right - 24 ? "end" : cx < left + 20 ? "start" : "middle";
          return (
            <g key={p.key}>
              {p.flag ? <rect x={left + i * step + Math.max(1, step * 0.12)} y={y(0) + 3} width={Math.max(2, step - 2 * Math.max(1, step * 0.12))} height={3} rx={1} style={{ fill: "var(--an-wait)" }} aria-hidden="true" /> : null}
              {p.tick && shownTicks.has(i) ? (
                <text x={tickAnchor === "end" ? width - right : tickAnchor === "start" ? left : cx} y={height - 6} textAnchor={tickAnchor} style={AXIS_TEXT} aria-hidden="true">
                  {p.tick}
                </text>
              ) : null}
              <Mark name={series ? `${series}, ${cardWords(p.card)}` : undefined} nav={focusable ? nav : undefined} index={i} x={x} y={Math.min(y(v) - sh, y(0) - 6)} w={bw} h={Math.max(6, h + sh)} tipAt={{ x: cx, y: Math.min(y(v) - sh, y(0) - 6) }} card={p.card} onTip={setTip} onActivate={onActivate ? () => onActivate(p.key) : undefined} pressed={onActivate ? selected === p.key : undefined} onKeyExtra={(e) => brushKey(i, e)}>
                {p.value === null ? (
                  <circle cx={cx} cy={y(0) - 3} r={2.2} style={{ fill: "none", stroke: "var(--an-subtle)", strokeWidth: 1 }} />
                ) : h > 0 ? (
                  <path d={roundTop(x, y(v), bw, h, Math.min(3, bw / 2))} style={{ fill: quiet ? "var(--an-bar-quiet)" : tone, ...(ringed ? { stroke: "var(--an-ink)", strokeWidth: 1, strokeOpacity: 0.55 } : {}) }} />
                ) : null}
                {sh > 0 ? <path d={roundTop(x, y(v) - sh, bw, Math.max(1, sh - (h > 0 ? 2 : 0)), Math.min(3, bw / 2))} style={{ fill: quiet ? "var(--an-bar-quiet)" : stackTone }} /> : null}
              </Mark>
            </g>
          );
        })}
        {brushable ? (
          <g data-analytics-brush="" aria-label="Choose periods for the window">
            {(["first", "last"] as const).map((which) => {
              const idx = sel ? sel[which] : which === "first" ? 0 : points.length - 1;
              const hx = left + (which === "first" ? idx * step : (idx + 1) * step);
              const p = points[idx]!;
              return (
                <rect
                  key={which}
                  className="an-brush-handle"
                  role="slider"
                  tabIndex={sel ? 0 : -1}
                  aria-label={which === "first" ? "Start of the chosen periods" : "End of the chosen periods"}
                  aria-valuemin={0}
                  aria-valuemax={points.length - 1}
                  aria-valuenow={idx}
                  aria-valuetext={which === "first" ? `from ${dayText(p.from!)}` : `to ${dayText(p.to! - 1)}`}
                  x={hx - 3}
                  y={top + (height - bottom - top) / 2 - 10}
                  width={6}
                  height={20}
                  rx={2}
                  // Keyboard handles only: a pointer chooses periods by dragging across the plot, a
                  // target as wide and tall as the chart (WCAG 2.5.8's equivalent).
                  data-target-equivalent="dragging across the columns, the whole plot"
                  style={{ opacity: sel ? 1 : 0, pointerEvents: "none" }}
                  onKeyDown={handleKey(which)}
                />
              );
            })}
          </g>
        ) : null}
      </svg>
      {sel ? (
        <p className="an-num absolute right-0 -top-6 text-caption text-accent-ink" role="status">
          {dayText(points[sel.first]!.from!)} – {dayText(points[sel.last]!.to! - 1)}: Enter sets the window, Escape cancels
        </p>
      ) : null}
      {tipNode}
    </div>
  );
}

/** A column path with rounded data end, square at the baseline. */
export function roundTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, h, w / 2));
  return `M${x} ${y + h}V${y + rr}Q${x} ${y} ${x + rr} ${y}H${x + w - rr}Q${x + w} ${y} ${x + w} ${y + rr}V${y + h}Z`;
}
/** A bar path with rounded data end on the right, square at the zero edge. */
export function roundRight(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w, h / 2));
  return `M${x} ${y}H${x + w - rr}Q${x + w} ${y} ${x + w} ${y + rr}V${y + h - rr}Q${x + w} ${y + h} ${x + w - rr} ${y + h}H${x}Z`;
}

// ------------------------------------------------------------------------------------ bar rows

export interface BarRow {
  readonly key: string;
  readonly label: ReactNode;
  readonly value: number | null;
  readonly valueText: string;
  readonly card: Card;
  readonly tone?: string;
  readonly dim?: boolean;
}

/**
 * Short horizontal bars from zero with the value written at the end. A null value is written as
 * words, never drawn as a zero-length bar. For rankings that sort and page, use RankTable.
 */
export function BarRows({ rows, labelW = 132, valueW = 76, onActivate, selected, max, rowH = 24, nullText = "not recorded", label }: { rows: readonly BarRow[]; labelW?: number; valueW?: number; onActivate?: ((key: string) => void) | undefined; selected?: string | null | undefined; max?: number; rowH?: number; nullText?: string; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [, setTip, tipNode] = useTip(width);
  const nav = useMarkNav(rows.length);
  const plotW = Math.max(40, width - labelW - valueW);
  const top = Math.max(max ?? 0, ...rows.map((r) => r.value ?? 0));
  const x = linear(0, top || 1, 0, plotW);
  const height = rows.length * rowH + 2;
  return (
    <div ref={ref} className="relative" style={{ height }}>
      <svg width={width} height={height} role="group" aria-label={label} style={{ display: "block" }}>
        <line x1={labelW} x2={labelW} y1={0} y2={height} style={{ stroke: "var(--an-axis)" }} aria-hidden="true" />
        {rows.map((r, i) => {
          const ry = i * rowH;
          const bh = Math.min(14, rowH - 9);
          const by = ry + (rowH - bh) / 2;
          const w = r.value === null ? 0 : Math.max(r.value > 0 ? 2 : 0, x(r.value));
          const isSel = selected === r.key;
          return (
            <Mark key={r.key} name={`${r.card.title}: ${r.value === null ? r.valueText || nullText : r.valueText}. ${cardWords({ title: "", rows: r.card.rows ?? [], ...(r.card.foot ? { foot: r.card.foot } : {}) })}`} nav={nav} index={i} x={0} y={ry + 1} w={width - 4} h={rowH - 2} tipAt={{ x: Math.min(width - 120, labelW + Math.max(w, 40)), y: by }} card={r.card} onTip={setTip} onActivate={onActivate ? () => onActivate(r.key) : undefined} pressed={onActivate ? isSel : undefined}
              overlay={
                <>
                  <foreignObject x={0} y={ry} width={labelW - 8} height={rowH}>
                    <div className={`flex h-full items-center truncate text-body-sm ${r.dim ? "text-ink-subtle" : "text-ink"} ${isSel ? "font-semibold" : ""}`}>{r.label}</div>
                  </foreignObject>
                  <text x={labelW + w + 6} y={by + bh - 2.5} style={{ ...NUM, fontSize: 12, fill: r.value === null ? "var(--an-subtle)" : "var(--an-ink)" }}>
                    {r.value === null ? r.valueText || nullText : r.valueText}
                  </text>
                </>
              }
            >
              {r.value !== null && w > 0 ? <path d={roundRight(labelW, by, w, bh, 3)} style={{ fill: selected && !isSel ? "var(--an-bar-quiet)" : r.tone ?? "var(--an-bar)" }} /> : null}
            </Mark>
          );
        })}
      </svg>
      {tipNode}
    </div>
  );
}

// ---------------------------------------------------------------------------------- rank table

export interface RankColumn<T> {
  readonly key: string;
  readonly label: string;
  readonly num?: boolean;
  /** The value sorted on; null sorts last. Omit for a column that does not sort. */
  readonly sort?: (r: T) => number | string | null;
  readonly cell: (r: T) => ReactNode;
  /** Draw this column's value as a bar from zero (on the largest value among all rows). */
  readonly bar?: { readonly value: (r: T) => number | null; readonly tone?: string };
  readonly width?: string;
}

/**
 * A ranking as a table: sortable by any column with a value (missing values last whatever the
 * direction), paged, rows selectable with one Tab stop and the arrows. The bar column is drawn from
 * zero on the largest value of every row, not just the page, so pages compare.
 */
export function RankTable<T>({ rows, columns, rowKey, rowName, initial, pageSize = 8, onActivate, selected, caption }: { rows: readonly T[]; columns: readonly RankColumn<T>[]; rowKey(r: T): string; rowName(r: T): string; initial: { readonly key: string; readonly dir: SortDir }; pageSize?: number; onActivate?: ((r: T) => void) | undefined; selected?: string | null | undefined; caption: string }) {
  const [sort, setSort] = useState(initial);
  const [page, setPage] = useState(0);
  const col = columns.find((c) => c.key === sort.key && c.sort) ?? columns.find((c) => c.sort);
  const sorted = useMemo(() => (col?.sort ? sortRows(rows, col.sort, sort.dir, rowKey) : [...rows]), [rows, col, sort.dir, rowKey]);
  const pg = pageOf(sorted, page, pageSize);
  const nav = useMarkNav(pg.items.length);
  const maxOf = (c: RankColumn<T>) => Math.max(0, ...rows.map((r) => c.bar!.value(r) ?? 0));
  return (
    <div>
      <table className="an-table an-rank">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const on = col?.key === c.key;
              return (
                <th key={c.key} scope="col" className={c.num ? "num" : undefined} style={c.width ? { width: c.width } : undefined} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                  {c.sort ? (
                    <button type="button" onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key && s.dir === "desc" ? "asc" : "desc" }))}>
                      {c.label}
                      {on ? sort.dir === "desc" ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" /> : null}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {pg.items.map((r, i) => {
            const k = rowKey(r);
            const isSel = selected === k;
            return (
              <tr key={k} data-selected={isSel ? "" : undefined} data-activatable={onActivate ? "" : undefined} onClick={onActivate ? () => onActivate(r) : undefined}>
                {columns.map((c, ci) => (
                  <td key={c.key} className={c.num ? "num" : undefined}>
                    {ci === 0 && onActivate ? (
                      <button
                        type="button"
                        className="an-row-button"
                        ref={nav.register(i)}
                        tabIndex={nav.tabIndex(i)}
                        aria-pressed={isSel}
                        aria-label={`${typeof c.cell(r) === "string" ? `${c.cell(r) as string}: ` : ""}${rowName(r)}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onActivate(r);
                        }}
                        onKeyDown={(e) => {
                          // A row's keys stay in the table (Space would otherwise also reach the shell's play/pause).
                          if (chartKey(e.key, true, { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey }).stop) e.stopPropagation();
                          if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") nav.onKey(i, e);
                        }}
                      >
                        {c.cell(r)}
                      </button>
                    ) : c.bar ? (
                      <InlineBar value={c.bar.value(r)} max={maxOf(c)} tone={c.bar.tone} text={c.cell(r)} quiet={!!selected && !isSel} />
                    ) : (
                      c.cell(r)
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {pg.pages > 1 ? (
        <div className="mt-2 flex items-center justify-end gap-2 text-caption text-ink-muted">
          <span className="an-num">
            {pg.from}–{pg.to} of {sorted.length}
          </span>
          <button type="button" className="inline-flex size-7 items-center justify-center rounded-sm hover:bg-surface-sunken disabled:opacity-40" disabled={pg.page === 0} onClick={() => setPage(pg.page - 1)} aria-label="Previous rows">
            <ChevronLeft size={15} aria-hidden="true" />
          </button>
          <button type="button" className="inline-flex size-7 items-center justify-center rounded-sm hover:bg-surface-sunken disabled:opacity-40" disabled={pg.page >= pg.pages - 1} onClick={() => setPage(pg.page + 1)} aria-label="Next rows">
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function InlineBar({ value, max, tone, text, quiet }: { value: number | null; max: number; tone?: string | undefined; text: ReactNode; quiet: boolean }) {
  const share = value === null || max <= 0 ? 0 : value / max;
  return (
    <span className="flex items-center gap-2">
      <span className="relative h-2.5 min-w-[40px] flex-1" aria-hidden="true">
        {value !== null && value > 0 ? <span className="absolute inset-y-0 left-0 rounded-r-[3px]" style={{ width: `${Math.max(1.5, share * 100)}%`, background: quiet ? "var(--an-bar-quiet)" : tone ?? "var(--an-bar)" }} /> : null}
      </span>
      <span className="an-num w-[6.5rem] shrink-0 text-right">{text}</span>
    </span>
  );
}

// ------------------------------------------------------------------------------- distribution

/** The words under a log time axis. */
export function LogNote() {
  return <span className="text-caption text-ink-subtle">Time axis on a log scale: each step multiplies.</span>;
}

/**
 * A duration distribution: the observer's log buckets merged to whole doublings, columns from zero
 * on a log time axis (labelled as such), the median and, with enough members, the 90th percentile
 * as rules (each read as the observer reads it: the upper bound of its bucket).
 */
export function DurationHistogram({ buckets, p50, p90, height = 124, name, tone = "var(--an-bar)" }: { buckets: readonly HistBucket[] | undefined; p50?: number | undefined; p90?: number | undefined; height?: number; name: string; tone?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [, setTip, tipNode] = useTip(width);
  const bins: HistBin[] = histogramBins(buckets);
  const nav = useMarkNav(bins.length);
  if (bins.length === 0) return <p className="text-body-sm text-ink-muted">No measured durations in this window.</p>;
  const left = 30;
  const right = 10;
  const top = 18;
  const bottom = 22;
  const lo = Math.max(1000, bins[0]!.fromMs || 500);
  const hi = bins[bins.length - 1]!.toMs;
  const x = logScale(lo, hi, left, width - right);
  const max = Math.max(...bins.map((b) => b.count));
  const ticks = niceTicks(max, 2);
  const y = linear(0, ticks[ticks.length - 1]!, height - bottom, top);
  const total = bins.reduce((s, b) => s + b.count, 0);
  const p50x = p50 !== undefined ? x(Math.min(hi, Math.max(lo, p50))) : null;
  const p90x = p90 !== undefined ? x(Math.min(hi, Math.max(lo, p90))) : null;
  // The two labels go either side of their rules; if they would meet, the 90th's moves to the right edge.
  const crowded = p50x !== null && p90x !== null && p90x - p50x < 150;
  return (
    <div ref={ref} className="relative" style={{ height }}>
      <svg width={width} height={height} role="group" aria-label={`Distribution of ${name}`} style={{ display: "block", overflow: "visible" }}>
        {ticks.map((t) => (
          <g key={t} aria-hidden="true">
            <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} style={{ stroke: t === 0 ? "var(--an-axis)" : "var(--an-grid)" }} />
            <text x={left - 5} y={y(t) + 3.5} textAnchor="end" style={AXIS_TEXT}>
              {t}
            </text>
          </g>
        ))}
        {durationTicks(lo, hi).map((t) => (
          <text key={t} x={x(t)} y={height - 6} textAnchor="middle" style={AXIS_TEXT} aria-hidden="true">
            {durationTick(t)}
          </text>
        ))}
        {bins.map((b, i) => {
          const x0 = x(Math.max(lo, b.fromMs)) + 1;
          const x1 = x(b.toMs) - 1;
          const h = y(0) - y(b.count);
          return (
            <Mark key={i} nav={nav} index={i} x={x0} y={Math.min(y(b.count), y(0) - 6)} w={Math.max(2, x1 - x0)} h={Math.max(6, h)} tipAt={{ x: (x0 + x1) / 2, y: y(b.count) }} card={{ title: `${durationText(b.fromMs)} to ${durationText(b.toMs)}`, rows: [[name, String(b.count)], ["share", `${Math.round((b.count / total) * 100)}%`]] }} onTip={setTip}>
              {h > 0 ? <path d={roundTop(x0, y(b.count), Math.max(2, x1 - x0), h, 2)} style={{ fill: tone }} /> : null}
            </Mark>
          );
        })}
        {p50x !== null ? <Rule x={p50x} top={top - 8} bottom={height - bottom} label={`median ${durationText(p50)}`} anchor="end" /> : null}
        {p90x !== null ? <Rule x={p90x} top={top - 8} bottom={height - bottom} label={`90th ${durationText(p90)}`} anchor="start" dashed labelX={crowded ? width - right : undefined} /> : null}
      </svg>
      {tipNode}
    </div>
  );
}

function Rule({ x, top, bottom, label, anchor, dashed, labelX }: { x: number; top: number; bottom: number; label: string; anchor: "start" | "end"; dashed?: boolean; labelX?: number | undefined }) {
  return (
    <g aria-hidden="true">
      <line x1={x} x2={x} y1={top} y2={bottom} style={{ stroke: "var(--an-ink)", strokeWidth: 1.2, strokeDasharray: dashed ? "3 2" : undefined }} />
      <text x={labelX ?? x + (anchor === "start" ? 4 : -4)} y={top + 4} textAnchor={labelX !== undefined ? "end" : anchor} style={{ ...NUM, fontSize: 11, fill: "var(--an-ink)", paintOrder: "stroke", stroke: "var(--mach-canvas)", strokeWidth: 3 }}>
        {label}
      </text>
    </g>
  );
}

// ------------------------------------------------------------------------------------- ranges

export interface RangeRow {
  readonly key: string;
  readonly label: string;
  readonly n: number;
  readonly min?: number | undefined;
  readonly p50?: number | undefined;
  readonly p90?: number | undefined;
  readonly max?: number | undefined;
  readonly total?: number | null | undefined;
  readonly tone: string;
  readonly note?: string;
  readonly open?: number;
}

/**
 * Wait kinds side by side on one log time axis: the range (shortest to longest), the median to the
 * 90th percentile as a bar, the median as a tick. Each row keeps its own count; nothing is stacked or
 * summed, because the waits overlap (a capacity hold is part of a queue wait).
 */
export function RangeRows({ rows, onActivate, selected }: { rows: readonly RangeRow[]; onActivate?: ((key: string) => void) | undefined; selected?: string | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [, setTip, tipNode] = useTip(width);
  const nav = useMarkNav(rows.length);
  const labelW = Math.min(200, Math.max(150, width * 0.2));
  const right = 92;
  const rowH = 36;
  const top = 6;
  const withData = rows.filter((r) => r.min !== undefined);
  const lo = Math.max(1000, Math.min(...withData.map((r) => r.min!), 60_000));
  const hi = Math.max(...withData.map((r) => r.max!), 3_600_000);
  const x = logScale(lo, hi, labelW, width - right);
  const height = top + rows.length * rowH + 24;
  return (
    <div ref={ref} className="relative" style={{ height }}>
      <svg width={width} height={height} role="group" aria-label="Waits by kind, on a log time axis" style={{ display: "block" }}>
        {durationTicks(lo, hi, Math.max(3, Math.floor((width - labelW - right) / 80))).map((t) => (
          <g key={t} aria-hidden="true">
            <line x1={x(t)} x2={x(t)} y1={top} y2={height - 20} style={{ stroke: "var(--an-grid)" }} />
            <text x={x(t)} y={height - 6} textAnchor="middle" style={AXIS_TEXT}>
              {durationTick(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const ry = top + i * rowH;
          const cy = ry + rowH / 2;
          const has = r.min !== undefined && r.p50 !== undefined;
          const card: Card = has
            ? { title: r.label, rows: [["measured", String(r.n)], ["median", durationText(r.p50)], ...(r.n >= 10 ? ([["90th", durationText(r.p90)]] as [string, string][]) : []), ["shortest", durationText(r.min)], ["longest", durationText(r.max)], ["total recorded", r.total ? durationText(r.total) : "–"]], foot: r.open ? `${r.open} still open, not counted` : undefined }
            : { title: r.label, foot: r.note === "not recorded" ? "Not recorded in this history." : "None measured in this window." };
          return (
            <Mark key={r.key} nav={nav} index={i} x={0} y={ry + 2} w={width - 4} h={rowH - 4} tipAt={{ x: has ? x(r.p50!) : labelW + 40, y: cy - 8 }} card={card} onTip={setTip} onActivate={onActivate ? () => onActivate(r.key) : undefined} pressed={onActivate ? selected === r.key : undefined}
              overlay={
                <>
                  <text x={0} y={cy - 2} style={{ ...SANS, fontSize: 13, fill: "var(--an-ink)" }}>
                    {r.label}
                  </text>
                  <text x={0} y={cy + 12} style={{ ...SANS, fontSize: 11, fill: "var(--an-subtle)" }}>
                    {r.note ?? `${r.n} measured${r.open ? `, ${r.open} still open` : ""}`}
                  </text>
                  {has ? null : (
                    <text x={labelW} y={cy + 4} style={{ ...SANS, fontSize: 12, fill: "var(--an-subtle)" }}>
                      {r.note === "not recorded" ? "not recorded in this history" : "none measured in this window"}
                    </text>
                  )}
                  <text x={width - 4} y={cy + 4} textAnchor="end" style={{ ...NUM, fontSize: 12, fill: "var(--an-ink)" }}>
                    {r.total ? durationText(r.total) : "–"}
                  </text>
                </>
              }
            >
              {has ? (
                <g>
                  <line x1={x(r.min!)} x2={x(r.max!)} y1={cy} y2={cy} style={{ stroke: r.tone, strokeWidth: 1 }} />
                  {r.n >= 10 && r.p90 !== undefined ? <rect x={x(r.p50!)} y={cy - 5} width={Math.max(2, x(Math.min(r.p90, r.max!)) - x(r.p50!))} height={10} rx={2} style={{ fill: r.tone, opacity: 0.35 }} /> : null}
                  <line x1={x(r.p50!)} x2={x(r.p50!)} y1={cy - 8} y2={cy + 8} style={{ stroke: r.tone, strokeWidth: 2.5 }} />
                  <circle cx={x(r.max!)} cy={cy} r={2} style={{ fill: r.tone }} />
                </g>
              ) : null}
            </Mark>
          );
        })}
        <text x={width - 4} y={height - 6} textAnchor="end" style={{ ...SANS, fontSize: 11, fill: "var(--an-subtle)" }} aria-hidden="true">
          total recorded
        </text>
        <text x={0} y={height - 6} style={{ ...SANS, fontSize: 11, fill: "var(--an-subtle)" }} aria-hidden="true">
          time, log scale
        </text>
      </svg>
      {tipNode}
    </div>
  );
}

// ---------------------------------------------------------------------------------- parallelism

export interface StepLine {
  readonly kind: "execution" | "visit" | "agent";
  readonly label: string;
  readonly counts: readonly number[];
  readonly limit: readonly { readonly from: number; readonly to: number; readonly value: number }[];
}

/**
 * The Timeline's concurrency lens, at the scale of days: one small panel per line, each on its own
 * scale labelled 0 and its top, the recorded limit as a dashed rule only where recorded.
 */
export function StepPanels({ lines, from, to, bucketMs }: { lines: readonly StepLine[]; from: number; to: number; bucketMs: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const gutter = 156;
  const panelH = 40;
  const gap = 14;
  const height = lines.length * (panelH + gap) + 18;
  const x = linear(from, to, gutter, width - 4);
  const D = 86_400_000;
  const days: number[] = [];
  for (let t = Math.ceil(from / D) * D; t < to; t += D) days.push(t);
  const every = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor((width - gutter) / 72))));
  return (
    <div ref={ref} style={{ height }}>
      <svg width={width} height={height} role="presentation" style={{ display: "block" }}>
        {days.map((t, i) => (i % every === 0 ? <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={height - 18} style={{ stroke: "var(--an-grid)" }} aria-hidden="true" /> : null))}
        {days.map((t, i) =>
          i % every === 0 && x(t) < width - 48 ? (
            <text key={`l${t}`} x={x(t) + 2} y={height - 4} style={AXIS_TEXT} aria-hidden="true">
              {dayText(t)}
            </text>
          ) : null,
        )}
        {lines.map((l, i) => {
          const top = i * (panelH + gap) + 4;
          const peak = Math.max(0, ...l.counts);
          const scaleMax = Math.max(peak, ...l.limit.map((v) => v.value), 1);
          const yOf = (c: number) => top + panelH - (c / scaleMax) * panelH;
          const tone = l.kind === "execution" ? "var(--an-live)" : "var(--an-bar)";
          const end = x(Math.min(to, from + l.counts.length * bucketMs));
          return (
            <g key={l.kind}>
              <text x={0} y={top + 12} style={{ ...SANS, fontSize: 13, fill: "var(--an-ink)" }}>
                {l.label}
              </text>
              <text x={0} y={top + 28} style={{ ...SANS, fontSize: 11, fill: "var(--an-muted)" }}>
                <tspan style={{ ...NUM, fill: "var(--an-ink)", fontWeight: 600 }}>{peak}</tspan> at most
                {l.limit.length ? (
                  <>
                    {", limit "}
                    <tspan style={{ ...NUM, fill: "var(--an-ink)", fontWeight: 600 }}>{[...new Set(l.limit.map((v) => v.value))].join(" then ")}</tspan>
                  </>
                ) : null}
              </text>
              <line x1={gutter} x2={width - 4} y1={yOf(0)} y2={yOf(0)} style={{ stroke: "var(--an-axis)" }} aria-hidden="true" />
              <line x1={gutter} x2={width - 4} y1={yOf(scaleMax)} y2={yOf(scaleMax)} style={{ stroke: "var(--an-grid)" }} aria-hidden="true" />
              <text x={gutter - 6} y={yOf(0) + 3} textAnchor="end" style={{ ...AXIS_TEXT, fontSize: 10 }} aria-hidden="true">
                0
              </text>
              <text x={gutter - 6} y={yOf(scaleMax) + 8} textAnchor="end" style={{ ...AXIS_TEXT, fontSize: 10 }} aria-hidden="true">
                {scaleMax}
              </text>
              {l.kind === "visit" ? (
                <path d={`${stepPath(l.counts, gutter, end, yOf(0), yOf(scaleMax), scaleMax)}V${yOf(0)}H${gutter}Z`} style={{ fill: "var(--mach-factory-plate-lit)", stroke: "var(--an-bar)", strokeWidth: 0.8 }} aria-hidden="true" />
              ) : (
                <path d={stepPath(l.counts, gutter, end, yOf(0), yOf(scaleMax), scaleMax)} style={{ fill: "none", stroke: tone, strokeWidth: l.kind === "execution" ? 1.8 : 1 }} aria-hidden="true" />
              )}
              {l.limit.map((lim, j) => (
                <g key={j} aria-hidden="true">
                  <line x1={x(Math.max(from, lim.from))} x2={x(Math.min(to, lim.to))} y1={yOf(lim.value)} y2={yOf(lim.value)} style={{ stroke: "var(--an-ink)", strokeDasharray: "5 3" }} />
                  {x(Math.min(to, lim.to)) - x(Math.max(from, lim.from)) > 70 ? (
                    <text x={x(Math.max(from, lim.from)) + 4} y={yOf(lim.value) - 3} textAnchor="start" style={{ ...SANS, fontSize: 10.5, fill: "var(--an-muted)" }}>
                      limit {lim.value}
                    </text>
                  ) : null}
                </g>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------------------- bullet

/**
 * A value against its target on a zero-based scale: the value as a bar, the target as a tick. No
 * band colours a range as good or bad; the words beside it say whether the target is met.
 */
export function Bullet({ value, target, max, name }: { value: number | null; target?: number | undefined; max: number; name: string }) {
  const [ref, width] = useWidth<HTMLDivElement>(200, 32);
  const h = 22;
  const x = linear(0, max, 0, width - 2);
  return (
    <div ref={ref} style={{ height: h }} role="img" aria-label={name}>
      <svg width={width} height={h} style={{ display: "block" }} aria-hidden="true">
        <line x1={0} x2={width} y1={h - 4} y2={h - 4} style={{ stroke: "var(--an-grid)" }} />
        <line x1={0.5} x2={0.5} y1={2} y2={h - 2} style={{ stroke: "var(--an-axis)" }} />
        {value !== null ? <path d={roundRight(0.5, 6, Math.max(2, x(Math.min(value, max))), 9, 2.5)} style={{ fill: "var(--an-bar)" }} /> : null}
        {target !== undefined ? <line x1={x(target)} x2={x(target)} y1={1} y2={h - 1} style={{ stroke: "var(--an-ink)", strokeWidth: 2 }} /> : null}
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------------------------ composition

export interface Part {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly tone: string;
  /** The value as words, e.g. "83" or "8.55 M". */
  readonly text: string;
  /** A hatched part: something whose end was not recorded. */
  readonly hatch?: boolean;
}

/**
 * One bar, parts of one whole (same unit), separated by 2px surface gaps, with the labels under it:
 * the large parts named at their start, every part in the key. Use only when the parts really
 * partition the whole. With `target`, an upright mark at that share of the whole, labelled.
 */
export function PartsBar({ parts, name, target, targetLabel, onActivate, selected, height = 18, labels = true }: { parts: readonly Part[]; name: string; target?: number | undefined; targetLabel?: string | undefined; onActivate?: ((key: string) => void) | undefined; selected?: string | null | undefined; height?: number; labels?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [, setTip, tipNode] = useTip(width);
  const nav = useMarkNav(parts.length);
  const pid = useId().replace(/:/g, "");
  const total = parts.reduce((s, p) => s + p.value, 0);
  const top = target !== undefined ? 16 : 2;
  const h = top + height + 4;
  const starts = parts.map((_, i) => parts.slice(0, i).reduce((s, q) => s + q.value, 0));
  const xOf = (v: number) => (v / Math.max(1, total)) * width;
  return (
    <div>
      <div ref={ref} className="relative" style={{ height: h }}>
        <svg width={width} height={h} role="group" aria-label={name} style={{ display: "block", overflow: "visible" }}>
          <defs>
            <pattern id={`p${pid}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="5" style={{ stroke: "var(--an-hatch-ink)", strokeWidth: 1.4 }} />
            </pattern>
          </defs>
          {parts.map((p, i) => {
            const x0 = xOf(starts[i]!);
            const w = Math.max(0, xOf(p.value) - (i < parts.length - 1 ? 2 : 0));
            const share = total ? p.value / total : 0;
            const quiet = selected && selected !== p.key;
            return (
              <Mark key={p.key} nav={nav} index={i} x={x0} y={top} w={Math.max(4, w)} h={height} tipAt={{ x: x0 + w / 2, y: top }} card={{ title: p.label, rows: [["count", p.text], ["share of the whole", `${share * 100 < 10 && share > 0 ? (share * 100).toFixed(1) : Math.round(share * 100)}%`], ["whole", plural(total, "member")]] }} onTip={setTip} onActivate={onActivate ? () => onActivate(p.key) : undefined} pressed={onActivate ? selected === p.key : undefined}>
                {p.value > 0 ? <rect x={x0} y={top} width={Math.max(1.5, w)} height={height} rx={2} style={{ fill: p.hatch ? `url(#p${pid})` : quiet ? "var(--an-bar-quiet)" : p.tone, stroke: p.hatch ? "var(--an-subtle)" : undefined, strokeWidth: p.hatch ? 0.8 : undefined }} /> : null}
              </Mark>
            );
          })}
          {target !== undefined ? (
            <g aria-hidden="true">
              <line x1={xOf(target * total)} x2={xOf(target * total)} y1={top - 6} y2={top + height + 3} style={{ stroke: "var(--an-ink)", strokeWidth: 2 }} />
              <text x={xOf(target * total)} y={top - 9} textAnchor={xOf(target * total) > width - 90 ? "end" : "middle"} style={{ ...SANS, fontSize: 11, fill: "var(--an-ink)" }}>
                {targetLabel}
              </text>
            </g>
          ) : null}
        </svg>
        {tipNode}
      </div>
      {labels ? (
        <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-caption text-ink-muted">
          {parts.map((p) => (
            <li key={p.key} className="inline-flex items-center gap-1.5">
              <svg width="10" height="10" aria-hidden="true">
                {p.hatch ? <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" style={{ fill: `url(#p${pid})`, stroke: "var(--an-subtle)" }} /> : <rect x="0" y="0" width="10" height="10" rx="2" style={{ fill: p.tone }} />}
              </svg>
              {p.label} <span className="an-num font-semibold text-ink">{p.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The belt as one strip: each station's share of measured station time, in belt order, parts of one
 * whole with 2px gaps. One tone for every station (colour does not name a station here), the largest
 * a step darker; names and shares are written under the segments wide enough to hold them, and the
 * rest are listed after.
 */
export function BeltStrip({ parts, name, onActivate }: { parts: readonly Part[]; name: string; onActivate?: ((key: string) => void) | undefined }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [, setTip, tipNode] = useTip(width);
  const nav = useMarkNav(parts.length);
  const total = parts.reduce((s, p) => s + p.value, 0);
  const h = 22;
  const starts = parts.map((_, i) => parts.slice(0, i).reduce((s, q) => s + q.value, 0));
  const xOf = (v: number) => (v / Math.max(1, total)) * width;
  const wide = parts.map((p) => xOf(p.value) >= 44);
  const narrow = parts.filter((_, i) => !wide[i]);
  return (
    <div>
      <div ref={ref} className="relative" style={{ height: h + 34 }}>
        <svg width={width} height={h + 34} role="group" aria-label={name} style={{ display: "block" }}>
          {parts.map((p, i) => {
            const x0 = xOf(starts[i]!);
            const w = Math.max(1.5, xOf(p.value) - (i < parts.length - 1 ? 2 : 0));
            const share = total ? p.value / total : 0;
            return (
              <g key={p.key}>
                <Mark nav={nav} index={i} x={x0} y={0} w={Math.max(4, w)} h={h} tipAt={{ x: x0 + w / 2, y: 0 }} card={{ title: p.label, rows: [["share of measured time", p.text], ["of the whole", `${Math.round(share * 1000) / 10}%`]], ...(onActivate ? { foot: "Enter opens it in Flow." } : {}) }} onTip={setTip} onActivate={onActivate ? () => onActivate(p.key) : undefined}>
                  <rect x={x0} y={0} width={w} height={h} rx={2} style={{ fill: p.tone }} />
                </Mark>
                {wide[i] ? (
                  <g aria-hidden="true">
                    <line x1={x0 + 0.5} x2={x0 + 0.5} y1={h + 2} y2={h + 8} style={{ stroke: "var(--an-axis)" }} />
                    <text x={x0 + 3} y={h + 17} style={{ ...SANS, fontSize: 12, fill: "var(--an-ink)" }}>
                      {p.label}
                    </text>
                    <text x={x0 + 3} y={h + 31} style={{ ...NUM, fontSize: 11.5, fontWeight: 600, fill: "var(--an-muted)" }}>
                      {p.text}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </svg>
        {tipNode}
      </div>
      {narrow.length ? (
        <p className="an-num mt-1 text-caption text-ink-subtle">
          Also {narrow.map((p) => `${p.label} ${p.text}`).join(", ")}.
        </p>
      ) : null}
    </div>
  );
}
