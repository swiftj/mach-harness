import type { ELK as ElkInstance, ElkNode } from "elkjs/lib/elk-api";
import { nodeSize, type MachEdge, type MachNode } from "./types";

export type LayoutDirection = "RIGHT" | "DOWN";

export interface LayoutOptions {
  direction?: LayoutDirection;
  /** Space between nodes in the same layer. */
  nodeSpacing?: number;
  /** Space between layers. */
  layerSpacing?: number;
}

// One ELK instance for the app, loaded on first use so screens without a graph never pay for it
// (ELK is about 1.4 MB minified). The bundled build runs on the main thread: no worker, no network.
let elk: Promise<ElkInstance> | null = null;
function getElk(): Promise<ElkInstance> {
  elk ??= import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());
  return elk;
}

/**
 * Lays out MACH nodes with ELK's layered algorithm and returns them with positions.
 * Containment edges define the layers; dependency edges are laid out too, so a slice sits after the
 * slice it needs. Pure: same input, same output.
 */
export async function layoutGraph(nodes: MachNode[], edges: MachEdge[], options: LayoutOptions = {}): Promise<MachNode[]> {
  const { direction = "RIGHT", nodeSpacing = 28, layerSpacing = 72 } = options;
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.spacing.nodeNode": String(nodeSpacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(layerSpacing),
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.edgeRouting": "ORTHOGONAL",
    },
    children: nodes.map((node) => ({ id: node.id, ...nodeSize[node.data.kind] })),
    edges: edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  };
  const result = await (await getElk()).layout(graph);
  const positions = new Map((result.children ?? []).map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }]));
  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? node.position,
    width: nodeSize[node.data.kind].width,
    height: nodeSize[node.data.kind].height,
  }));
}
