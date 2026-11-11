import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import { memo } from "react";
import type { MachEdge } from "./types";

/** contains: thin, solid, neutral. The hierarchy recedes so states stand out. */
export const ContainsEdge = memo(function ContainsEdge(props: EdgeProps<MachEdge>) {
  const [path] = getSmoothStepPath({ ...props, borderRadius: 10, offset: 18 });
  return <BaseEdge id={props.id} path={path} style={{ stroke: "var(--mach-graph-edge)", strokeWidth: 1.25 }} />;
});

/** depends: dashed, accent, with an arrowhead pointing at the slice that needs the other. */
export const DependsEdge = memo(function DependsEdge(props: EdgeProps<MachEdge>) {
  const [path] = getSmoothStepPath({ ...props, borderRadius: 10, offset: 24 });
  return (
    <BaseEdge
      id={props.id}
      path={path}
      markerEnd="url(#mach-arrow-depends)"
      style={{ stroke: "var(--mach-graph-edge-dependency)", strokeWidth: 1.5, strokeDasharray: "5 4" }}
    />
  );
});

/** Shared SVG definitions for edge markers. Rendered once inside <ProductGraph>. */
export function EdgeMarkers() {
  return (
    <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute" }}>
      <defs>
        <marker id="mach-arrow-depends" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" style={{ fill: "var(--mach-graph-edge-dependency)" }} />
        </marker>
      </defs>
    </svg>
  );
}

export const edgeTypes = { contains: ContainsEdge, depends: DependsEdge };
