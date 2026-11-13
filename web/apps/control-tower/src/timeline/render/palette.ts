/**
 * The tokens the canvas draws with, read from CSS variables at draw time (both themes, nothing
 * hard-coded), and the state of a span in tone: which ink and tint carry it. The tone function is pure.
 */
import { outcomeKnownAt, type SpanKind, type TimelineSpan } from "../contract";
import type { SpanTimes } from "./lod";

export interface Palette {
  readonly ground: string;
  readonly grid: string;
  readonly gridMajor: string;
  readonly plateTop: string;
  readonly plateLit: string;
  readonly plateEdge: string;
  readonly hatch: string;
  readonly fInk: string;
  readonly fInkSoft: string;
  readonly route: string;
  readonly live: string;
  readonly liveSoft: string;
  readonly pass: string;
  readonly passSoft: string;
  readonly fail: string;
  readonly failSoft: string;
  readonly wait: string;
  readonly waitSoft: string;
  readonly human: string;
  readonly humanSoft: string;
  readonly select: string;
  readonly halt: string;
  readonly stale: string;
  readonly ink: string;
  readonly inkMuted: string;
  readonly inkSubtle: string;
  readonly line: string;
  readonly lineStrong: string;
  readonly sans: string;
  readonly mono: string;
  /** The keyboard focus ink (the cursor's bracket). */
  readonly focus: string;
}

export function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const f = (name: string) => v(`--mach-factory-${name}`);
  return {
    ground: f("ground"),
    grid: f("grid"),
    gridMajor: f("grid-major"),
    plateTop: f("plate-top"),
    plateLit: f("plate-lit"),
    plateEdge: f("plate-edge"),
    hatch: f("hatch"),
    fInk: f("ink"),
    fInkSoft: f("ink-soft"),
    route: f("route"),
    live: f("live"),
    liveSoft: f("live-soft"),
    pass: f("pass"),
    passSoft: f("pass-soft"),
    fail: f("fail"),
    failSoft: f("fail-soft"),
    wait: f("wait"),
    waitSoft: f("wait-soft"),
    human: f("human"),
    humanSoft: f("human-soft"),
    select: f("select"),
    halt: f("halt"),
    stale: f("stale"),
    ink: v("--mach-ink"),
    inkMuted: v("--mach-ink-muted"),
    inkSubtle: v("--mach-ink-subtle"),
    line: v("--mach-line"),
    lineStrong: v("--mach-line-strong"),
    sans: v("--mach-font-sans") || "sans-serif",
    mono: v("--mach-font-mono") || "monospace",
    focus: v("--mach-focus"),
  };
}

export type Tone = "live" | "pass" | "fail" | "halt" | "wait" | "human" | "neutral";

const PERSON_KINDS: ReadonlySet<SpanKind> = new Set<SpanKind>(["person-wait", "gate-wait"]);
const WAIT_TONE_KINDS: ReadonlySet<SpanKind> = new Set<SpanKind>(["slice-wait", "capacity-wait", "agent-queue"]);

/** An outcome word's tone: failures, stops from outside, or a pass. */
export function outcomeTone(outcome: string): Tone {
  const o = outcome.toLowerCase();
  if (/fail|reject|refus|block|escalat|error|denied|changes/.test(o)) return "fail";
  if (/interrupt|supersed|time.?out|killed|cancel|abandon|unknown/.test(o)) return "halt";
  return "pass";
}

/**
 * The tone a span is drawn in at `liveAt`. Waits keep their own tone (amber, or terracotta for a
 * person) whether open or ended. Work that is open is live blue. An outcome colours a span only once
 * `outcomeKnownAt` allows it; an interruption recorded at the end reads in the halt ink. Anything
 * else that has ended is neutral ink: ended, outcome not known.
 */
export function toneOf(span: TimelineSpan, times: SpanTimes, liveAt: number): Tone {
  if (PERSON_KINDS.has(span.kind)) return "human";
  if (WAIT_TONE_KINDS.has(span.kind)) return "wait";
  if (span.kind === "slice-eligible") return "neutral";
  if (times.open) return "live";
  if (outcomeKnownAt(span, liveAt) && span.outcome) return outcomeTone(span.outcome);
  const r = span.end?.reason;
  const endAt = span.end?.at ?? null;
  if ((r === "interrupted" || r === "superseded") && endAt !== null && endAt <= liveAt) return "halt";
  return "neutral";
}

export function toneInk(p: Palette, tone: Tone): { ink: string; soft: string } {
  switch (tone) {
    case "live":
      return { ink: p.live, soft: p.liveSoft };
    case "pass":
      return { ink: p.pass, soft: p.passSoft };
    case "fail":
      return { ink: p.fail, soft: p.failSoft };
    case "halt":
      return { ink: p.halt, soft: p.plateTop };
    case "wait":
      return { ink: p.wait, soft: p.waitSoft };
    case "human":
      return { ink: p.human, soft: p.humanSoft };
    default:
      return { ink: p.fInkSoft, soft: p.plateTop };
  }
}
