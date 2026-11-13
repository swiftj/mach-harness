/**
 * What every lens panel draws with: the time scale shared with the tracks, a roving-tabindex group of
 * figures (one tab stop per panel, arrows between figures, Enter to reveal, Shift+Enter for the
 * second choice), the hover card that names the records a figure comes from, small marks in the
 * Living Factory's grammar, and the designed empty state. Tokens only; no transitions.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Button, fc, StateMark, type MarkState } from "@mach/ui";
import { timecode } from "../../shell/time";
import type { TimelineViewport } from "../contract";
import { figureName, type Source } from "./model";

// ---------------------------------------------------------------- type

export const MONO = { fontFamily: "var(--mach-font-mono)", fontVariantNumeric: "tabular-nums" } as const;
export const SANS = { fontFamily: "var(--mach-font-sans)" } as const;
export const INK = "var(--mach-ink)";
export const MUTED = "var(--mach-ink-muted)";
export const SUBTLE = "var(--mach-ink-subtle)";

export const when = (t: number): string => timecode(t, false);

// ---------------------------------------------------------------- time scale

/** The panel's x for a time: the same window and plot width as the tracks, after the label gutter. */
export interface Scale {
  readonly gutter: number;
  readonly plotW: number;
  readonly from: number;
  readonly to: number;
  x(t: number): number;
  /** Clamped into the plot. */
  cx(t: number): number;
}

export function scaleOf(viewport: TimelineViewport, width: number): Scale {
  const g = width - viewport.width;
  const gutter = g >= 96 && g <= 360 ? g : 176;
  const plotW = Math.max(40, width - gutter - 8);
  const { from, to } = viewport.window;
  const k = plotW / Math.max(1, to - from);
  const x = (t: number) => gutter + (t - from) * k;
  return { gutter, plotW, from, to, x, cx: (t: number) => Math.max(gutter, Math.min(gutter + plotW, x(t))) };
}

// ---------------------------------------------------------------- figures

interface Tip {
  readonly name: string;
  readonly sources: readonly Source[];
  readonly x: number;
  readonly y: number;
  /** The group's size when the tip was asked for, to keep the card inside it. */
  readonly w?: number;
  readonly h?: number;
}

interface FigureCtx {
  show(tip: Tip): void;
  hide(): void;
}

const Ctx = createContext<FigureCtx | null>(null);

/**
 * A group of figures: one tab stop, arrow keys between figures in document order, Home and End.
 * Hover and focus show which records a figure comes from.
 */
export function Figures({ children, label, className, style }: { children: ReactNode; label: string; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const active = useRef<string | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  // Exactly one figure is reachable by Tab: the last one used, else the first.
  useLayoutEffect(() => {
    const figs = [...(ref.current?.querySelectorAll<SVGElement>("[data-fig]") ?? [])];
    const keep = figs.find((f) => f.dataset.fig === active.current) ?? figs[0];
    for (const f of figs) f.setAttribute("tabindex", f === keep ? "0" : "-1");
  });

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const figs = [...(ref.current?.querySelectorAll<SVGElement>("[data-fig]") ?? [])];
    const i = figs.indexOf(document.activeElement as SVGElement);
    if (i < 0 || figs.length === 0) return;
    e.preventDefault();
    const j = e.key === "Home" ? 0 : e.key === "End" ? figs.length - 1 : Math.max(0, Math.min(figs.length - 1, i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1)));
    const next = figs[j]!;
    for (const f of figs) f.setAttribute("tabindex", f === next ? "0" : "-1");
    active.current = next.dataset.fig ?? null;
    next.focus();
  }, []);

  const ctx = useMemo<FigureCtx>(
    () => ({
      show: (t) => {
        const box = ref.current?.getBoundingClientRect();
        setTip(box ? { ...t, x: t.x - box.left, y: t.y - box.top, w: box.width, h: box.height } : t);
      },
      hide: () => setTip(null),
    }),
    [],
  );

  return (
    <Ctx.Provider value={ctx}>
      {/* A roving-tabindex group: the arrow keys of its figures are handled once, here. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div ref={ref} role="group" aria-label={label} onKeyDown={onKeyDown} onFocus={(e) => (active.current = (e.target as HTMLElement).dataset?.fig ?? active.current)} className={className} style={{ position: "relative", ...style }}>
        {children}
        {tip ? <TipCard tip={tip} width={tip.w ?? 600} height={tip.h ?? 200} /> : null}
      </div>
    </Ctx.Provider>
  );
}

function TipCard({ tip, width, height }: { tip: Tip; width: number; height: number }) {
  const w = 340;
  const left = Math.max(4, Math.min(width - w - 4, tip.x - w / 2));
  // Below the pointer in the upper half, above it in the lower half, so it never hides what it names.
  const below = tip.y < height / 2;
  return (
    <div role="presentation" className="pointer-events-none absolute z-10 rounded-sm border border-line bg-surface-raised px-2.5 py-1.5 shadow-2" style={below ? { left, top: tip.y + 16, width: w } : { left, bottom: height - tip.y + 16, width: w }}>
      <p className="text-caption text-ink">{tip.name}</p>
      {tip.sources.length ? (
        <ul className="mt-0.5 space-y-px">
          {tip.sources.map((s, i) => (
            <li key={i} className="text-[11px] leading-[15px] text-ink-muted">
              From {s.what} <span className="font-mono text-ink-subtle tabular">{s.ref}</span>
              {s.eventId ? <span className="font-mono text-ink-subtle tabular"> · event {s.eventId}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-ink-subtle">No record holds this.</p>
      )}
    </div>
  );
}

/**
 * One interactive figure: a button with an accessible name (what, when, how its time is known), the
 * records it comes from on hover and focus, and `onActivate(shift)` on click or Enter.
 */
export function Fig({ id, name, sources, onActivate, selected, children }: { id: string; name: string; sources: readonly Source[]; onActivate(shift: boolean): void; selected?: boolean; children: ReactNode }) {
  const ctx = useContext(Ctx);
  const ref = useRef<SVGGElement>(null);
  // The accessible name starts with the figure's visible words (WCAG 2.5.3), then says the rest.
  useLayoutEffect(() => {
    const g = ref.current;
    if (g) g.setAttribute("aria-label", figureName(name, visibleText(g)));
  });
  const show = (el: Element, x?: number, y?: number) => {
    const r = el.getBoundingClientRect();
    ctx?.show({ name, sources, x: x ?? r.left + r.width / 2, y: y ?? r.bottom - 8 });
  };
  return (
    <g
      ref={ref}
      data-fig={id}
      role="button"
      tabIndex={-1}
      aria-pressed={selected === undefined ? undefined : selected}
      className="mach-inv-fig"
      style={{ cursor: "pointer", outline: "none" }}
      onClick={(e) => onActivate(e.shiftKey)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate(e.shiftKey);
        }
      }}
      onMouseEnter={(e) => show(e.currentTarget, e.clientX, e.clientY)}
      onMouseMove={(e) => show(e.currentTarget, e.clientX, e.clientY)}
      onMouseLeave={() => ctx?.hide()}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => ctx?.hide()}
    >
      {children}
    </g>
  );
}

/** The words a figure shows: its `text` elements outside anything hidden from assistive technology. */
function visibleText(g: SVGGElement): string {
  const parts: string[] = [];
  for (const t of g.querySelectorAll("text")) {
    if (t.closest("[aria-hidden='true']")) continue;
    const words = (t.textContent ?? "").replace(/\s+/g, " ").trim();
    if (words) parts.push(words);
  }
  return parts.join(" ");
}

/** A transparent hit area so thin figures keep a 24 px target. */
export function Hit({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const ww = Math.max(w, 24);
  const hh = Math.max(h, 24);
  return <rect x={x - (ww - w) / 2} y={y - (hh - h) / 2} width={ww} height={hh} style={{ fill: "transparent" }} />;
}

/** The focus ring a figure draws for itself (CSS shows it only on :focus-visible). */
export function Ring({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return <rect className="mach-inv-ring" x={x - 3} y={y - 3} width={w + 6} height={h + 6} rx={3} style={{ fill: "none", stroke: "var(--mach-focus)", strokeWidth: 2 }} />;
}

// ---------------------------------------------------------------- marks

/** A verdict diamond: filled for a recorded decision, outlined for a refusal, with the state's colour. */
export function Diamond({ x, y, r = 4.5, tone, open = false, cross = false }: { x: number; y: number; r?: number; tone: "pass" | "fail" | "wait" | "human" | "ink" | "halt"; open?: boolean; cross?: boolean }) {
  const ink = tone === "ink" ? fc("ink-soft") : fc(tone);
  return (
    <g transform={`translate(${x} ${y})`} aria-hidden="true">
      <path d={`M0 ${-r}L${r} 0L0 ${r}L${-r} 0Z`} style={{ fill: open ? fc("ground") : ink, stroke: ink, strokeWidth: 1.2 }} />
      {cross ? <path d={`M${-r * 0.38} ${-r * 0.38}L${r * 0.38} ${r * 0.38}M${r * 0.38} ${-r * 0.38}L${-r * 0.38} ${r * 0.38}`} style={{ stroke: open ? ink : fc("ground"), strokeWidth: 1.1 }} /> : null}
    </g>
  );
}

export function Mark({ x, y, state, r = 5 }: { x: number; y: number; state: MarkState; r?: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <StateMark state={state} r={r} surface={fc("ground")} />
    </g>
  );
}

/** A person's gate: the terracotta down-triangle. */
export function HumanTriangle({ x, y, s = 5 }: { x: number; y: number; s?: number }) {
  return <path aria-hidden="true" d={`M${x - s} ${y - s * 0.7}H${x + s}L${x} ${y + s * 0.8}Z`} style={{ fill: fc("human"), stroke: fc("human"), strokeWidth: 1, strokeLinejoin: "round" }} />;
}

/** An open wait's end: the band fades into the live edge, no cap. */
export function FadeDefs({ id, color }: { id: string; color: string }) {
  return (
    <defs>
      <linearGradient id={id} x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stopColor={color} stopOpacity={1} />
        <stop offset="1" stopColor={color} stopOpacity={0} />
      </linearGradient>
    </defs>
  );
}

// ---------------------------------------------------------------- frame pieces

export function Caption({ children }: { children: ReactNode }) {
  return <p className="px-2 pt-1 text-[11px] leading-[15px] text-ink-subtle">{children}</p>;
}

/** A designed empty state: what is absent, and a way to widen the window to the whole history. */
export function Empty({ text, detail, onWiden }: { text: string; detail?: string; onWiden(): void }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <svg width={18} height={18} viewBox="-9 -9 18 18" aria-hidden="true">
        <StateMark state="idle" r={7} surface={fc("ground")} />
      </svg>
      <div className="min-w-0">
        <p className="text-body-sm text-ink">{text}</p>
        {detail ? <p className="text-[11px] text-ink-subtle">{detail}</p> : null}
      </div>
      <Button variant="secondary" size="sm" className="ml-auto" onClick={onWiden}>
        Widen to the whole history
      </Button>
    </div>
  );
}

/** Thin label gutter rule, like the tracks' gutter edge. */
export function GutterEdge({ x, h }: { x: number; h: number }) {
  return <line x1={x - 0.5} y1={0} x2={x - 0.5} y2={h} aria-hidden="true" style={{ stroke: "var(--mach-line)", strokeWidth: 1 }} />;
}

/** The live edge, when it falls inside the plot. */
export function LiveEdge({ s, liveAt, h }: { s: Scale; liveAt: number; h: number }) {
  if (liveAt < s.from || liveAt > s.to) return null;
  const x = s.x(liveAt);
  return <line x1={x} y1={0} x2={x} y2={h} aria-hidden="true" style={{ stroke: fc("live"), strokeWidth: 1, opacity: 0.7 }} />;
}
