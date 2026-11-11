import {
  Background,
  BackgroundVariant,
  Controls,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeMouseHandler,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "../lib/cn";
import { motion as motionTokens } from "../tokens/tokens";
import { Skeleton } from "../components/skeleton";
import { EdgeMarkers, edgeTypes } from "./edges";
import { layoutGraph, type LayoutDirection } from "./layout";
import { MachNodeView } from "./MachNode";
import type { MachEdge, MachNode as MachNodeType } from "./types";

const nodeTypes = { mach: MachNodeView };

export interface ProductGraphProps {
  nodes: MachNodeType[];
  edges: MachEdge[];
  direction?: LayoutDirection;
  /** Called with the node's engine ID and kind when a node is clicked or chosen with Enter. */
  onSelect?: (node: MachNodeType) => void;
  selectedId?: string | null;
  /** Names the graph for assistive technology. Pair the graph with a <GraphOutline> for a text alternative. */
  ariaLabel: string;
  className?: string;
}

function GraphInner({ nodes, edges, direction = "RIGHT", onSelect, selectedId, ariaLabel, className }: ProductGraphProps) {
  const [laidOut, setLaidOut] = useState<MachNodeType[] | null>(null);
  const reduce = useReducedMotion();
  const flow = useReactFlow();

  useEffect(() => {
    let cancelled = false;
    layoutGraph(nodes, edges, { direction }).then((result) => {
      if (cancelled) return;
      const horizontal = direction === "RIGHT";
      setLaidOut(
        result.map((node) => ({
          ...node,
          sourcePosition: horizontal ? Position.Right : Position.Bottom,
          targetPosition: horizontal ? Position.Left : Position.Top,
          draggable: false,
          connectable: false,
        })),
      );
      requestAnimationFrame(() => flow.fitView({ padding: 0.15, duration: reduce ? 0 : motionTokens.duration.layout, maxZoom: 1 }));
    });
    return () => {
      cancelled = true;
    };
  }, [nodes, edges, direction, flow, reduce]);

  // Refit when the graph's box changes size (window resize, rail collapse), so nothing is cut off.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element || laidOut === null || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => flow.fitView({ padding: 0.15, duration: 0, maxZoom: 1 }));
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [flow, laidOut]);

  const shown = useMemo(
    () => (laidOut ?? []).map((node) => ({ ...node, selected: node.id === selectedId })),
    [laidOut, selectedId],
  );

  const onNodeClick: NodeMouseHandler<MachNodeType> = (_, node) => onSelect?.(node);

  return (
    <div
      ref={box}
      className={cn("mach-graph relative h-full min-h-48 w-full overflow-hidden rounded-md border border-line bg-canvas", className)}
      aria-busy={laidOut === null || undefined}
    >
      <EdgeMarkers />
      {laidOut === null ? (
        <div className="absolute inset-0 flex items-center justify-center gap-6 p-8" aria-hidden="true">
          <Skeleton className="h-20 w-60" />
          <Skeleton className="h-20 w-56" />
          <Skeleton className="h-20 w-56" />
        </div>
      ) : null}
      <ReactFlow<MachNodeType, MachEdge>
        nodes={shown}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        nodesFocusable
        edgesFocusable={false}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        aria-label={ariaLabel}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          const target = (event.target as HTMLElement).closest<HTMLElement>("[data-id]");
          const node = target ? shown.find((n) => n.id === target.dataset.id) : undefined;
          if (node) {
            event.preventDefault();
            onSelect?.(node);
          }
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--mach-graph-dot)" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}

/**
 * The product graph: project → epics → slices, with dependencies. Laid out by ELK, read-only
 * (no dragging or connecting: structure changes go through the engine). Tab moves between nodes,
 * Enter selects. Re-layout animates node positions unless reduced motion is on.
 */
export function ProductGraph(props: ProductGraphProps) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}
