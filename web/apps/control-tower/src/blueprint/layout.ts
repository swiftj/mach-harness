/**
 * The sheet's layout: where every lane and row stands. Pure arithmetic over the tree, the ELK
 * column template and the expansion set; no measuring, no async, nothing per frame. Lanes stack in
 * wave order, so expanding one cell moves only the lanes below it and never reorders anything.
 */
import type { CellState, GateState, Scene, SliceState } from "../sim";
import { PANELS } from "../sim";
import type { ColumnTemplate } from "./columns";
import { flowOf, ROW, type Flow } from "./flow";
import type { Tree, TreeNode } from "./tree";

export const SHEET = {
  /** Left and top of the content, inside the sheet's border and zone strip. */
  left: 40,
  top: 40,
  /** The gutter: titles, IDs and state marks. The drawing starts after it. */
  gutter: 400,
  /** The dependency channel at the right edge of the drawing. */
  channel: 170,
  right: 24,
  /** Space kept below the content for the title-block strip (BlueprintSheet titleBlock="strip", 4 facts). */
  titleBlock: 152,
  waveHeader: 64,
  cellCollapsed: 80,
  sliceWaiting: 78,
  execRow: 32,
  /** The execution's one ruler, under its header when it is open. */
  execRuler: 28,
  visitRow: 32,
  gateRow: 24,
  agentRow: 28,
  agentExpanded: 78,
  dimBand: 19,
} as const;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Lane {
  readonly id: string;
  readonly node: TreeNode;
  readonly slice: SliceState;
  readonly cell: CellState | null;
  readonly gates: readonly GateState[];
  readonly y: number;
  readonly h: number;
  readonly expanded: boolean;
  /** The workflow drawing (cells only). */
  readonly flow: Flow | null;
  /** y of the main line (row 0). */
  readonly row0: number;
  /** y of the first dimension band. */
  readonly dimsY: number;
  readonly dimRows: number;
  /** The execution rows and everything under them, in order. */
  readonly rows: readonly Row[];
}

export interface Row {
  readonly id: string;
  readonly node: TreeNode;
  readonly y: number;
  readonly h: number;
  /** 0 for an execution, 1 for its visits, gates and relay, 2 for agents. */
  readonly depth: number;
  readonly expanded: boolean;
  readonly expandable: boolean;
}

export interface Layout {
  readonly width: number;
  readonly height: number;
  /** x where the drawing (columns, time axes) starts, and its width. */
  readonly ax: number;
  readonly aw: number;
  readonly waveY: number;
  readonly waveH: number;
  readonly waveExpanded: boolean;
  readonly lanes: readonly Lane[];
  readonly rows: readonly Row[];
  /** Visible tree items in order, for keyboard navigation. */
  readonly visible: readonly string[];
  /** The rectangle of any visible tree item, in sheet coordinates. */
  readonly bounds: ReadonlyMap<string, Rect>;
}

export function needsHuman(slice: SliceState): boolean {
  return PANELS[slice.risk].human_approval;
}

function flowHeight(flow: Flow): { rowsBottom: number; dimRows: number } {
  const lastRow = flow.rows - 1;
  const seatPad = flow.seatRows.has(lastRow) ? 46 : 0;
  return { rowsBottom: lastRow * ROW + 40 + seatPad, dimRows: flow.rows };
}

/** `minHeight`: the sheet's planned size, so it does not grow under a fitted camera as the run proceeds. */
export function computeLayout(scene: Scene, tree: Tree, expanded: ReadonlySet<string>, template: ColumnTemplate, minHeight = 0): Layout {
  const ax = SHEET.left + SHEET.gutter;
  const aw = Math.ceil(template.width);
  const width = ax + aw + SHEET.channel + SHEET.right + SHEET.left;
  const lanes: Lane[] = [];
  const rows: Row[] = [];
  const visible: string[] = [];
  const bounds = new Map<string, Rect>();
  const laneW = width - SHEET.left * 2;
  let y: number = SHEET.top;
  const root = tree.root;
  if (!root) return { width, height: Math.max(y + 220 + SHEET.titleBlock, minHeight), ax, aw, waveY: y, waveH: 0, waveExpanded: false, lanes, rows, visible, bounds };

  const waveY = y;
  const waveExpanded = expanded.has(root.id);
  visible.push(root.id);
  y += SHEET.waveHeader;
  if (waveExpanded) {
    const gatesByTicket = new Map<string, GateState[]>();
    for (const g of Object.values(scene.gates)) {
      let list = gatesByTicket.get(g.ticketId);
      if (!list) gatesByTicket.set(g.ticketId, (list = []));
      list.push(g);
    }
    for (const laneNode of root.children) {
      if (laneNode.data.kind !== "slice") continue;
      const { slice, cell } = laneNode.data;
      const laneY = y;
      const isOpen = expanded.has(laneNode.id);
      visible.push(laneNode.id);
      const gates = cell ? (gatesByTicket.get(cell.ticketId) ?? []).sort((a, b) => a.openedAt - b.openedAt || a.seq - b.seq) : [];
      if (!cell) {
        const h = isOpen ? SHEET.sliceWaiting + 12 + laneNode.children.length * 13 : SHEET.sliceWaiting;
        lanes.push({ id: laneNode.id, node: laneNode, slice, cell, gates, y: laneY, h, expanded: isOpen, flow: null, row0: laneY + 30, dimsY: laneY + h, dimRows: 0, rows: [] });
        bounds.set(laneNode.id, { x: SHEET.left, y: laneY, w: laneW, h });
        if (isOpen) for (const d of laneNode.children) {
          visible.push(d.id);
          bounds.set(d.id, { x: SHEET.left, y: laneY, w: laneW, h });
        }
        y += h;
        continue;
      }
      const flow = flowOf(cell, gates, slice, template, needsHuman(slice));
      if (!isOpen) {
        const h = SHEET.cellCollapsed;
        lanes.push({ id: laneNode.id, node: laneNode, slice, cell, gates, y: laneY, h, expanded: false, flow, row0: laneY + 29, dimsY: laneY + h, dimRows: 0, rows: [] });
        bounds.set(laneNode.id, { x: SHEET.left, y: laneY, w: laneW, h });
        y += h;
        continue;
      }
      const row0 = laneY + 88;
      const { rowsBottom, dimRows } = flowHeight(flow);
      const dimsY = row0 + rowsBottom + 6;
      let cy = Math.max(laneY + 128, dimsY + dimRows * SHEET.dimBand + 2);
      const laneStartRows = rows.length;
      // Children: dependencies and script-written artifacts are drawn in the workflow; executions get rows.
      for (const child of laneNode.children) {
        if (child.kind !== "execution") {
          visible.push(child.id);
          continue;
        }
        cy = placeExecution(child, cy, expanded, rows, visible);
      }
      cy += 10;
      const h = cy - laneY;
      lanes.push({ id: laneNode.id, node: laneNode, slice, cell, gates, y: laneY, h, expanded: true, flow, row0, dimsY, dimRows, rows: rows.slice(laneStartRows) });
      bounds.set(laneNode.id, { x: SHEET.left, y: laneY, w: laneW, h: Math.min(h, row0 - laneY + 60) });
      for (let i = laneStartRows; i < rows.length; i++) {
        const r = rows[i] as Row;
        bounds.set(r.id, { x: SHEET.left, y: r.y, w: laneW, h: r.h });
      }
      y = cy;
    }
  } else {
    y += 10;
  }
  const waveH = y - waveY;
  bounds.set(root.id, { x: SHEET.left, y: waveY, w: laneW, h: SHEET.waveHeader });
  const height = Math.max(y + 24 + SHEET.titleBlock, 700, minHeight);
  return { width, height, ax, aw, waveY, waveH, waveExpanded, lanes, rows, visible, bounds };
}

function placeExecution(node: TreeNode, y: number, expanded: ReadonlySet<string>, rows: Row[], visible: string[]): number {
  const open = expanded.has(node.id);
  visible.push(node.id);
  const eh = SHEET.execRow + (open ? SHEET.execRuler : 0);
  rows.push({ id: node.id, node, y, h: eh, depth: 0, expanded: open, expandable: node.children.length > 0 });
  y += eh;
  if (!open) return y;
  for (const child of node.children) {
    visible.push(child.id);
    if (child.kind === "gate") {
      rows.push({ id: child.id, node: child, y, h: SHEET.gateRow, depth: 1, expanded: false, expandable: false });
      y += SHEET.gateRow;
      continue;
    }
    const childOpen = expanded.has(child.id) && child.children.length > 0;
    rows.push({ id: child.id, node: child, y, h: SHEET.visitRow, depth: 1, expanded: childOpen, expandable: child.children.length > 0 });
    y += SHEET.visitRow;
    if (!childOpen) continue;
    for (const agent of child.children) {
      visible.push(agent.id);
      const agentOpen = expanded.has(agent.id) && agent.children.length > 0;
      const h = agentOpen ? SHEET.agentExpanded : SHEET.agentRow;
      rows.push({ id: agent.id, node: agent, y, h, depth: 2, expanded: agentOpen, expandable: agent.children.length > 0 });
      y += h;
      if (agentOpen) for (const leafNode of agent.children) visible.push(leafNode.id);
    }
  }
  return y + 4;
}

/** The sheet's proportion: cut landscape to the stage (16:10 to 16:9, with the inspector open about 1.85). */
export const SHEET_ASPECT = 1.8;

/** The drawing width that makes a sheet of this height landscape at SHEET_ASPECT. */
export function drawingWidthFor(height: number, min: number): number {
  const chrome = SHEET.left * 2 + SHEET.gutter + SHEET.channel + SHEET.right;
  return Math.max(min, Math.round(height * SHEET_ASPECT - chrome));
}
