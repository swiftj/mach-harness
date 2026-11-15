/**
 * Flattening the tree to rows for the canvas and the label column: a node with n lanes is n rows (the
 * label on the first), heights from ROW_HEIGHT, cumulative y, binary search for the visible slice.
 */
import { ROW_HEIGHT, type FlatRow, type RowLayout, type TrackNode, type TrackTree } from "../contract";

export function layoutRows(tree: TrackTree, expanded: ReadonlySet<string>): RowLayout {
  const rows: FlatRow[] = [];
  const first = new Map<string, number>();
  let y = 0;
  const visit = (node: TrackNode): void => {
    const hasChildren = node.children.length > 0;
    const open = hasChildren && expanded.has(node.id);
    const height = ROW_HEIGHT[node.kind];
    const lanes = Math.max(1, node.lanes.length);
    first.set(node.id, rows.length);
    for (let lane = 0; lane < lanes; lane++) {
      rows.push({ node, lane, y, height, expanded: open, hasChildren });
      y += height;
    }
    if (open) for (const child of node.children) visit(child);
  };
  for (const root of tree.roots) visit(root);
  const totalHeight = y;
  return {
    rows,
    totalHeight,
    slice(top: number, bottom: number): readonly FlatRow[] {
      if (bottom <= top || rows.length === 0) return [];
      // The first row whose bottom edge is below `top`.
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const row = rows[mid] as FlatRow;
        if (row.y + row.height <= top) lo = mid + 1;
        else hi = mid;
      }
      let end = lo;
      while (end < rows.length && (rows[end] as FlatRow).y < bottom) end++;
      return rows.slice(lo, end);
    },
    rowOf(trackId: string, lane = 0): FlatRow | null {
      const index = first.get(trackId);
      if (index === undefined) return null;
      const row = rows[index + lane];
      return row && row.node.id === trackId && row.lane === lane ? row : null;
    },
  };
}

/** Group kinds that open by default; their nested rows open only while the tree is small. */
const OPEN_KINDS = new Set<TrackNode["kind"]>(["wave", "slice", "cell", "factory", "execution", "workflow"]);
const SMALL = 6;

/**
 * Waves, slices and cells open (executions and workflows in the execution grouping); the rows nested
 * inside a cell (or an execution) open too while there are at most six of them, and stay closed beyond.
 */
export function defaultExpanded(tree: TrackTree): string[] {
  const out: string[] = [];
  let owners = 0;
  for (const node of tree.byId.values()) if (node.kind === "cell" || node.kind === "execution") owners++;
  const small = owners <= SMALL;
  const visit = (node: TrackNode, insideOwner: boolean): void => {
    if (node.children.length > 0 && (OPEN_KINDS.has(node.kind) || (insideOwner && small))) out.push(node.id);
    const owner = insideOwner || node.kind === "cell" || node.kind === "execution";
    for (const child of node.children) visit(child, owner);
  };
  for (const root of tree.roots) visit(root, false);
  return out;
}
