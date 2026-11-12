import { dimmedOpacity, fc, type FactoryColor } from "./grammar";
import { planeStroke, planeTransform, round, type Vec3 } from "./projection";

/**
 * Lettering on the plant's floor and plan dimensions: text and measurements painted in the plane,
 * the way a plant drawing letters a bay or dimensions a run. Both are drawn in plan coordinates inside
 * a plane group, so they foreshorten with the floor.
 */

export type LetteringTone = "ink" | "muted" | "subtle" | FactoryColor;

function toneColor(tone: LetteringTone): string {
  if (tone === "ink") return "var(--mach-ink)";
  if (tone === "muted") return "var(--mach-ink-muted)";
  if (tone === "subtle") return "var(--mach-ink-subtle)";
  return fc(tone);
}

const faces = { serif: "var(--mach-font-serif)", sans: "var(--mach-font-sans)", mono: "var(--mach-font-mono)" } as const;

export interface FloorLetteringProps {
  /** Plan point of the text's anchor, on the floor at its elevation. */
  at: Vec3;
  text: string;
  /**
   * Plan axis the text runs along: x (with the flow, default) or y (across the floor). Text along y
   * runs from +y toward −y, so on screen it reads from lower left to upper right like the rest.
   */
  axis?: "x" | "y";
  /** Size in plan units. Regions 19 (26 far), IDs 11, notes 8. */
  size?: number;
  /** serif for places, mono for engine IDs, sans for words. */
  font?: "serif" | "sans" | "mono";
  tone?: LetteringTone;
  weight?: number;
  anchor?: "start" | "middle" | "end";
  /** Lettering that repeats a name already given elsewhere is hidden from assistive technology. */
  decorative?: boolean;
  dimmed?: boolean;
}

/**
 * Text painted on the floor. Text that is not decorative is read by assistive technology; text that
 * repeats a name already in an accessible label should be `decorative`. Mono only for engine IDs.
 */
export function FloorLettering({ at, text, axis = "x", size = 11, font = "sans", tone = "muted", weight = 500, anchor = "start", decorative, dimmed }: FloorLetteringProps) {
  return (
    <g transform={planeTransform(at.z ?? 0)} aria-hidden={decorative ? true : undefined} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      <text
        x={round(at.x)}
        y={round(at.y)}
        transform={axis === "y" ? `rotate(-90 ${round(at.x)} ${round(at.y)})` : undefined}
        textAnchor={anchor}
        className={font === "mono" ? "notranslate" : undefined}
        style={{ fill: toneColor(tone), fontFamily: faces[font], fontSize: size, fontWeight: weight, letterSpacing: font === "mono" ? "0.02em" : "0.01em" }}
      >
        {text}
      </text>
    </g>
  );
}

export interface PlanDimensionProps {
  /** Two plan points at the same elevation. */
  from: Vec3;
  to: Vec3;
  /** Distance of the dimension line from the measured edge, in plan units, to the left of from→to. Default 14. */
  offset?: number;
  /** The value: "216 pu", "3 cells", "max 3 parallel". */
  label: string;
  dimmed?: boolean;
}

/**
 * A dimension on the floor: extension lines from the measured points, a dimension line offset to one
 * side, architectural slash ticks at its ends and the value lettered along it in mono. For the
 * plant's own measures (bay width, the parallel limit across a row), never for decoration.
 */
export function PlanDimension({ from, to, offset = 14, label, dimmed }: PlanDimensionProps) {
  const z = from.z ?? 0;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = uy;
  const ny = -ux;
  const a = { x: from.x + nx * offset, y: from.y + ny * offset };
  const b = { x: to.x + nx * offset, y: to.y + ny * offset };
  const ext = (p: Vec3, q: { x: number; y: number }) => `M${round(p.x + nx * 3)} ${round(p.y + ny * 3)}L${round(q.x + nx * 3)} ${round(q.y + ny * 3)}`;
  const tick = (q: { x: number; y: number }) => `M${round(q.x - (ux + nx) * 2.6)} ${round(q.y - (uy + ny) * 2.6)}L${round(q.x + (ux + nx) * 2.6)} ${round(q.y + (uy + ny) * 2.6)}`;
  const mid = { x: (a.x + b.x) / 2 + nx * 3, y: (a.y + b.y) / 2 + ny * 3 };
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const color = "var(--mach-ink-muted)";
  return (
    <g role="img" aria-label={`Dimension: ${label}`} transform={planeTransform(z)} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      <path d={`${ext(from, a)}${ext(to, b)}`} aria-hidden="true" style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 * planeStroke }} />
      <line x1={round(a.x)} y1={round(a.y)} x2={round(b.x)} y2={round(b.y)} aria-hidden="true" style={{ stroke: color, strokeWidth: 0.75 * planeStroke }} />
      <path d={`${tick(a)}${tick(b)}`} aria-hidden="true" style={{ stroke: color, strokeWidth: 1.1 * planeStroke }} />
      <text
        x={round(mid.x)}
        y={round(mid.y)}
        transform={`rotate(${round(angle)} ${round(mid.x)} ${round(mid.y)})`}
        textAnchor="middle"
        aria-hidden="true"
        className="tabular"
        style={{ fill: color, fontFamily: "var(--mach-font-mono)", fontSize: 8 }}
      >
        {label}
      </text>
    </g>
  );
}
