/**
 * Reduced motion for the grammar's growing primitives (spec e, column "Reduced"; f.12). An artifact
 * card materialises by rising out of the floor, and an agent's post grows from its disc and sinks
 * back: both are changes of size, so under `prefers-reduced-motion` they must not happen. Here the
 * primitive is drawn at its end state and the same progress becomes a plain opacity ramp (the
 * grammar's 160 ms `fade`), with no change of position or size.
 */
import { ArtifactCard, type ArtifactCardProps } from "@mach/ui";

/** An artifact card whose materialisation is a fade (no rise) under reduced motion. */
export function Card({ reduced, progress = 1, ...props }: ArtifactCardProps & { reduced: boolean }) {
  if (!reduced) return <ArtifactCard progress={progress} {...props} />;
  return (
    <g style={{ opacity: Math.max(0, Math.min(1, progress)) }}>
      <ArtifactCard progress={1} {...props} />
    </g>
  );
}
