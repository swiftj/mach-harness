/** Where a leaf (a tool call, an artifact, a finding) is drawn: on its agent's lane, at its time on the execution's axis. */
import { execAxis, xOn } from "./axis";
import type { Layout, Rect } from "./layout";
import type { Tree, TreeNode } from "./tree";

export function leafBounds(layout: Layout, tree: Tree, node: TreeNode, playhead: number): Rect | null {
  const agentId = node.parent;
  if (!agentId) return null;
  const row = layout.bounds.get(agentId);
  const agent = tree.byId.get(agentId);
  const parent = agent?.parent ? tree.byId.get(agent.parent) : null;
  const exec = parent?.parent ? tree.byId.get(parent.parent) : null;
  if (!row || !exec || exec.data.kind !== "execution") return row ?? null;
  const visits = exec.children.flatMap((c) => (c.data.kind === "visit" ? [c.data.visit] : []));
  const axis = execAxis(layout.ax, layout.aw, exec.data.execution, visits, playhead);
  const t = node.data.kind === "tool" ? node.data.call.startedAt : node.data.kind === "artifact" ? node.data.artifact.writtenAt : node.data.kind === "finding" ? node.data.finding.at : axis.start;
  const x = xOn(axis, t);
  return { x: x - 90, y: row.y - 20, w: 180, h: row.h + 40 };
}
