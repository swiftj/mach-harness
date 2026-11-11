import { cn } from "../lib/cn";
import { StateGlyph } from "../lifecycle/glyph";
import { toneClasses } from "../components/tone";
import { graphStates, type MachEdge, type MachNode } from "./types";

export interface GraphOutlineProps {
  nodes: MachNode[];
  edges: MachEdge[];
  onSelect?: (node: MachNode) => void;
  selectedId?: string | null;
  className?: string;
}

/**
 * The graph as a nested list: the same facts, readable by screen readers and by keyboard without
 * a canvas. Every graph view should offer it (beside the graph or behind a "List" toggle).
 */
export function GraphOutline({ nodes, edges, onSelect, selectedId, className }: GraphOutlineProps) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  const needs = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const edge of edges) {
    if (edge.data?.kind === "depends") {
      needs.set(edge.target, [...(needs.get(edge.target) ?? []), edge.source]);
    } else {
      children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target]);
      hasParent.add(edge.target);
    }
  }
  const roots = nodes.filter((node) => !hasParent.has(node.id));

  const render = (id: string, depth: number) => {
    const node = byId.get(id);
    if (!node) return null;
    const s = graphStates[node.data.state];
    const kids = children.get(id) ?? [];
    const prerequisites = (needs.get(id) ?? []).map((need) => byId.get(need)?.data.artifactId).filter(Boolean);
    return (
      <li key={id}>
        <button
          type="button"
          onClick={() => onSelect?.(node)}
          aria-current={selectedId === id ? "true" : undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-body-sm hover:bg-surface-sunken",
            selectedId === id && "bg-accent-soft",
          )}
        >
          <span className={toneClasses[s.tone].ink}>
            <StateGlyph shape={s.glyph} />
          </span>
          <span translate="no" className="font-mono text-caption text-ink-muted tabular">
            {node.data.artifactId}
          </span>
          <span className={cn("min-w-0 flex-1 truncate", depth === 0 ? "font-semibold" : "")}>{node.data.title}</span>
          <span className="shrink-0 text-caption text-ink-subtle">{node.data.stateLabel ?? s.label}</span>
          {node.data.attention ? <span className="shrink-0 text-caption font-semibold text-warning-ink">{node.data.attention}</span> : null}
          {prerequisites.length ? <span className="shrink-0 text-caption text-ink-subtle">needs {prerequisites.join(", ")}</span> : null}
        </button>
        {kids.length ? <ul className="ml-4 border-l border-line pl-2">{kids.map((kid) => render(kid, depth + 1))}</ul> : null}
      </li>
    );
  };

  return <ul className={cn("flex flex-col gap-0.5", className)}>{roots.map((root) => render(root.id, 0))}</ul>;
}
