import type { Edge, Node } from "@xyflow/react";
import type { Tone } from "../components/tone";
import type { GlyphShape } from "../lifecycle/glyph";

/** What a node stands for. Factory Floor will add its own kinds (station, cell, agent). */
export type GraphNodeKind = "product" | "epic" | "slice";

/**
 * Visual states on the graph. One vocabulary for both products:
 *
 *   proposed        nothing settled yet (draft slice, draft project); an open epic, which is a container and is never approved
 *   interviewing    being worked out
 *   ready           settled, waiting for a person's approval
 *   approved        a person approved it
 *   ready_to_build  saved for the builders, waiting for them
 *   building        the builders are building it
 *   question        the builders asked the product manager a question
 *   shipped         built and merged
 *   superseded      replaced; kept for history (an epic: set aside)
 */
export type GraphState = "proposed" | "interviewing" | "ready" | "approved" | "ready_to_build" | "building" | "question" | "shipped" | "superseded";

export interface GraphStateDescriptor {
  label: string;
  tone: Tone;
  glyph: GlyphShape;
  /** Border treatment, so state reads without colour: dashed, solid, double, heavy. */
  border: "dashed" | "solid" | "double" | "heavy";
  /** Faded: superseded only. */
  muted?: boolean;
}

export const graphStates: Record<GraphState, GraphStateDescriptor> = {
  proposed: { label: "Proposed", tone: "neutral", glyph: "open", border: "dashed" },
  interviewing: { label: "Interviewing", tone: "info", glyph: "half", border: "solid" },
  ready: { label: "Ready for approval", tone: "accent", glyph: "ready", border: "solid" },
  approved: { label: "Approved", tone: "success", glyph: "approved", border: "solid" },
  ready_to_build: { label: "Ready to build", tone: "info", glyph: "submitted", border: "solid" },
  building: { label: "Being built", tone: "info", glyph: "building", border: "solid" },
  question: { label: "Question from the builders", tone: "warning", glyph: "question", border: "heavy" },
  shipped: { label: "Shipped", tone: "success", glyph: "accepted", border: "double" },
  superseded: { label: "Superseded", tone: "neutral", glyph: "superseded", border: "dashed", muted: true },
};

export interface MachNodeData extends Record<string, unknown> {
  kind: GraphNodeKind;
  /** The engine's ID (team-space, EPIC-001, SLICE-002). */
  artifactId: string;
  title: string;
  state: GraphState;
  /** Overrides the state's label when the engine's own word is more precise ("Deferred", "Draft"). */
  stateLabel?: string;
  /** A short secondary fact: "2 open questions", "#41". */
  meta?: string;
  /** Something the person must settle on this item ("Changed on GitHub", "Number taken"). Shown with a warning mark. */
  attention?: string;
}

export type MachNode = Node<MachNodeData, "mach">;

/** contains: product → epic → slice. depends: slice → the slice it needs (drawn from the dependent to its dependency). */
export type MachEdgeKind = "contains" | "depends";

export interface MachEdgeData extends Record<string, unknown> {
  kind: MachEdgeKind;
}

export type MachEdge = Edge<MachEdgeData>;

/** Laid-out size per node kind, in px. The layout and the node component both use these. */
export const nodeSize: Record<GraphNodeKind, { width: number; height: number }> = {
  product: { width: 264, height: 84 },
  epic: { width: 232, height: 84 },
  slice: { width: 256, height: 92 },
};
