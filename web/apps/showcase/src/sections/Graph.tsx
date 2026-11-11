import { useMemo, useState } from "react";
import { List, Network } from "lucide-react";
import { Button, Text, StateGlyph, toneClasses } from "@mach/ui";
import { GraphOutline, ProductGraph, graphStates, productGraphFromStatus, type GraphState, type MachNode } from "@mach/ui/graph";
import { Section, Specimen } from "../layout";
import { fx } from "../fixtures";

export function GraphSection() {
  const [selected, setSelected] = useState<MachNode | null>(null);
  const [view, setView] = useState<"graph" | "list">("graph");
  const conflicts = useMemo(() => productGraphFromStatus({ status: fx.statusAfterRenumber }), []);
  const published = useMemo(() => productGraphFromStatus({ status: fx.statusPublished, reviews: fx.feedbackAccepted.waves }), []);

  return (
    <Section
      id="graph"
      title="Graph"
      intro="Project, epics and slices as a laid-out map. Read-only: structure changes go through the engine. Every graph comes with the same facts as a list."
    >
      <Specimen
        title="Product graph"
        source="status.after-renumber.json"
        note="Tab moves between nodes; Enter selects. A warning line on a node names what must be settled."
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <Text size="body-sm" tone="muted" aria-live="polite">
              {selected ? (
                <>
                  Selected <span className="font-mono">{selected.data.artifactId}</span>: {selected.data.title}
                </>
              ) : (
                "Nothing selected."
              )}
            </Text>
            <div className="flex gap-1" role="group" aria-label="View">
              <Button size="sm" variant={view === "graph" ? "secondary" : "ghost"} aria-pressed={view === "graph"} onClick={() => setView("graph")}>
                <Network aria-hidden="true" />
                Graph
              </Button>
              <Button size="sm" variant={view === "list" ? "secondary" : "ghost"} aria-pressed={view === "list"} onClick={() => setView("list")}>
                <List aria-hidden="true" />
                List
              </Button>
            </div>
          </div>
          {view === "graph" ? (
            <div className="h-[420px]">
              <ProductGraph
                nodes={conflicts.nodes}
                edges={conflicts.edges}
                onSelect={setSelected}
                selectedId={selected?.id}
                ariaLabel="Team Space: project, epics and slices"
              />
            </div>
          ) : (
            <GraphOutline nodes={conflicts.nodes} edges={conflicts.edges} onSelect={setSelected} selectedId={selected?.id} />
          )}
        </div>
      </Specimen>

      <Specimen title="After review accepted the wave" source="status.published.json + feedback.accepted.json" note="The same slice, now accepted: a double border and a ringed glyph.">
        <div className="h-[260px]">
          <ProductGraph nodes={published.nodes} edges={published.edges} ariaLabel="Team Space after acceptance" />
        </div>
      </Specimen>

      <div className="grid grid-cols-[2fr_1fr] gap-6">
        <Specimen title="Node states">
          <ul className="grid grid-cols-2 gap-x-6 gap-y-3">
            {(Object.keys(graphStates) as GraphState[]).map((state) => {
              const s = graphStates[state];
              return (
                <li key={state} className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className={[
                      "inline-flex h-8 w-14 shrink-0 items-center justify-center rounded-sm bg-surface",
                      s.border === "dashed" ? "border border-dashed border-line-control" : "",
                      s.border === "solid" ? "border border-line-strong" : "",
                      s.border === "double" ? "border-[3px] border-double border-success-line" : "",
                      s.border === "heavy" ? "border-2 border-danger-ink" : "",
                      s.muted ? "opacity-60" : "",
                      toneClasses[s.tone].ink,
                    ].join(" ")}
                  >
                    <StateGlyph shape={s.glyph} />
                  </span>
                  <span className="flex flex-col">
                    <span className="text-label text-ink">{s.label}</span>
                    <span className="font-mono text-caption text-ink-subtle">{state}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </Specimen>
        <Specimen title="Edges" note="No fixture has a dependency yet, so the graph above shows none; this is how one is drawn.">
          <ul className="flex flex-col gap-4">
            <li className="flex items-center gap-3">
              <svg width="72" height="12" aria-hidden="true">
                <path d="M2 6H70" style={{ stroke: "var(--mach-graph-edge)", strokeWidth: 1.25 }} />
              </svg>
              <span className="flex flex-col">
                <span className="text-label text-ink">Contains</span>
                <span className="text-caption text-ink-muted">Project to epic, epic to slice</span>
              </span>
            </li>
            <li className="flex items-center gap-3">
              <svg width="72" height="12" aria-hidden="true">
                <path d="M2 6H62" style={{ stroke: "var(--mach-graph-edge-dependency)", strokeWidth: 1.5, strokeDasharray: "5 4" }} />
                <path d="M62 1L71 6L62 11z" style={{ fill: "var(--mach-graph-edge-dependency)" }} />
              </svg>
              <span className="flex flex-col">
                <span className="text-label text-ink">Needed by</span>
                <span className="text-caption text-ink-muted">From a slice to the slice that depends on it</span>
              </span>
            </li>
          </ul>
        </Specimen>
      </div>
    </Section>
  );
}
