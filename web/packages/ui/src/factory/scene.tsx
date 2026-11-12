import { createContext, useContext, useId, useMemo, type ReactNode, type SVGProps } from "react";
import { fc } from "./grammar";

/**
 * The SVG root for factory drawing. It renders the shared definitions (hatching, the lamp pool,
 * arrowheads) once, with ids unique to this scene, and gives them to every primitive inside.
 * Primitives must be drawn inside a `<FactoryScene>` (or a `<FactoryDefs>` of their own).
 */
export interface FactoryIds {
  hatch: string;
  hatchFine: string;
  lamp: string;
  arrow: string;
  arrowLive: string;
  arrowFail: string;
  arrowWait: string;
  arrowPass: string;
  arrowHuman: string;
  tick: string;
}

const FactoryIdsContext = createContext<FactoryIds | null>(null);

export function useFactoryIds(): FactoryIds {
  const ids = useContext(FactoryIdsContext);
  if (!ids) throw new Error("Factory primitives must be drawn inside <FactoryScene> or <FactoryDefs>.");
  return ids;
}

export function arrowFor(ids: FactoryIds, ink: string): string {
  switch (ink) {
    case "live":
      return ids.arrowLive;
    case "fail":
      return ids.arrowFail;
    case "wait":
      return ids.arrowWait;
    case "pass":
      return ids.arrowPass;
    case "human":
      return ids.arrowHuman;
    default:
      return ids.arrow;
  }
}

function Arrow({ id, color }: { id: string; color: string }) {
  return (
    <marker id={id} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
      <path d="M1 1.2L9 5L1 8.8L3 5z" style={{ fill: color }} />
    </marker>
  );
}

/** Definitions only, for drawing factory primitives into an SVG you own. */
export function FactoryDefs({ children }: { children?: ReactNode }) {
  const base = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const ids = useMemo<FactoryIds>(
    () => ({
      hatch: `${base}-hatch`,
      hatchFine: `${base}-hatch-fine`,
      lamp: `${base}-lamp`,
      arrow: `${base}-arrow`,
      arrowLive: `${base}-arrow-live`,
      arrowFail: `${base}-arrow-fail`,
      arrowWait: `${base}-arrow-wait`,
      arrowPass: `${base}-arrow-pass`,
      arrowHuman: `${base}-arrow-human`,
      tick: `${base}-tick`,
    }),
    [base],
  );
  return (
    <FactoryIdsContext.Provider value={ids}>
      <defs>
        {/* Poché: the section hatching of a drafted cut face, 45 degrees on screen. */}
        <pattern id={ids.hatch} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" style={{ stroke: fc("hatch"), strokeWidth: 1.1 }} />
        </pattern>
        <pattern id={ids.hatchFine} width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="3" style={{ stroke: fc("hatch"), strokeWidth: 0.6 }} />
        </pattern>
        {/* The lamp pool on an active cell floor: warm, centred, no hard edge. Lighting, not activity. */}
        <radialGradient id={ids.lamp} cx="50%" cy="50%" r="50%">
          <stop offset="0%" style={{ stopColor: fc("lamp"), stopOpacity: 1 }} />
          <stop offset="70%" style={{ stopColor: fc("lamp"), stopOpacity: 0.55 }} />
          <stop offset="100%" style={{ stopColor: fc("lamp"), stopOpacity: 0 }} />
        </radialGradient>
        <Arrow id={ids.arrow} color={fc("route")} />
        <Arrow id={ids.arrowLive} color={fc("live")} />
        <Arrow id={ids.arrowFail} color={fc("fail")} />
        <Arrow id={ids.arrowWait} color={fc("wait")} />
        <Arrow id={ids.arrowPass} color={fc("pass")} />
        <Arrow id={ids.arrowHuman} color={fc("human")} />
        {/* Architectural dimension tick: a short slash. */}
        <marker id={ids.tick} viewBox="-5 -5 10 10" refX="0" refY="0" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M-3 3L3 -3" style={{ stroke: "var(--mach-ink-muted)", strokeWidth: 1.2 }} />
        </marker>
      </defs>
      {children}
    </FactoryIdsContext.Provider>
  );
}

export interface FactorySceneProps extends Omit<SVGProps<SVGSVGElement>, "role"> {
  /** What the drawing shows, for assistive technology. */
  label: string;
  /** A static drawing is one image; an interactive one is a group whose parts are focusable. */
  interactive?: boolean;
  /** Paint the ground colour behind the drawing. */
  ground?: boolean;
  children?: ReactNode;
}

export function FactoryScene({ label, interactive = false, ground = true, children, style, ...rest }: FactorySceneProps) {
  return (
    <svg
      role={interactive ? "group" : "img"}
      aria-label={label}
      {...rest}
      style={{ display: "block", background: ground ? fc("ground") : undefined, fontFamily: "var(--mach-font-sans)", ...style }}
    >
      <FactoryDefs>{children}</FactoryDefs>
    </svg>
  );
}
