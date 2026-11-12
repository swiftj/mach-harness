/** Where a leaf (a tool call, an artifact, a finding) is drawn: on its agent's lane, at its time. */
import type { Layout, Rect } from "./layout";
import { axisEnd } from "./time";
import type { Tree, TreeNode } from "./tree";

export function leafBounds(layout: Layout, tree: Tree, node: TreeNode, playhead: number): Rect | null {
  const agentId = node.parent;
  if (!agentId) return null;
  const row = layout.bounds.get(agentId);
  const agent = tree.byId.get(agentId);
  const parent = agent?.parent ? tree.byId.get(agent.parent) : null;
  if (!row || !parent) return null;
  let start = 0;
  let end: number | null = null;
  if (parent.data.kind === "visit") {
    start = parent.data.visit.enteredAt;
    end = parent.data.visit.leftAt;
  } else if (parent.data.kind === "relay") {
    start = parent.data.execution.startedAt ?? parent.data.execution.claimedAt;
    end = parent.data.execution.endedAt;
  } else return row;
  const e = axisEnd(start, end, playhead);
  const t = node.data.kind === "tool" ? node.data.call.startedAt : node.data.kind === "artifact" ? node.data.artifact.writtenAt : node.data.kind === "finding" ? node.data.finding.at : start;
  const x = layout.ax + ((Math.min(Math.max(t, start), e) - start) / (e - start)) * layout.aw;
  return { x: x - 90, y: row.y - 20, w: 180, h: row.h + 40 };
}
