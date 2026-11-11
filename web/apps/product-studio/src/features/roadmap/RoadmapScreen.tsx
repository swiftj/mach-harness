import { useMemo, useState } from "react";
import { Link } from "react-router";
import { CircleAlert, Info, List, Network, Plus } from "lucide-react";
import {
  Button,
  EmptyState,
  ErrorState,
  Heading,
  Page,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  Skeleton,
  StateGlyph,
  Text,
  cn,
  describeError,
  toneClasses,
  type Status,
} from "@mach/ui";
import { GraphOutline, ProductGraph, graphStates, productGraphFromStatus, type GraphState, type MachEdge, type MachNode } from "@mach/ui/graph";
import { useFeedback, useStatus } from "../../api/store";
import { NewSliceDialog } from "./NewSliceDialog";
import { NodeSheet } from "./NodeSheet";

const stateOrder: GraphState[] = ["proposed", "interviewing", "ready", "approved", "submitted", "accepted", "blocked", "superseded"];

export function RoadmapScreen() {
  const status = useStatus();
  if (!status.data && !status.error) {
    return (
      <Page>
        <div role="status" aria-busy="true" aria-label="Reading the roadmap" className="flex flex-col gap-5">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-[480px] w-full" />
        </div>
      </Page>
    );
  }
  if (!status.data) {
    const { title, message } = describeError(status.error!);
    return (
      <Page width="reading">
        <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={() => void status.reload()}>Try again</Button>} />
      </Page>
    );
  }
  const data = status.data;
  if (!data.project) {
    return (
      <Page>
        <EmptyState
          layout="page"
          headingLevel={1}
          icon={<Network />}
          title="No roadmap yet"
          description="The roadmap shows the project, its epics and their slices. Define the project first."
          action={
            <Button variant="primary" asChild>
              <Link to="/vision">Define the project</Link>
            </Button>
          }
        />
      </Page>
    );
  }
  return <Roadmap status={data} />;
}

function Roadmap({ status }: { status: Status }) {
  const feedback = useFeedback(status.waves.some((w) => w.sent));
  const [view, setView] = useState<"graph" | "list">("graph");
  const [epicFilter, setEpicFilter] = useState("all");
  const [states, setStates] = useState<Set<GraphState>>(new Set());
  const [selected, setSelected] = useState<MachNode | null>(null);
  const [newSlice, setNewSlice] = useState<{ epicId: string | null } | null>(null);

  const full = useMemo(() => productGraphFromStatus({ status, reviews: feedback.data?.waves ?? [] }), [status, feedback.data]);
  const present = useMemo(() => new Set(full.nodes.filter((n) => n.data.kind === "slice").map((n) => n.data.state)), [full]);
  const shown = useMemo(() => filterGraph(full.nodes, full.edges, epicFilter, states), [full, epicFilter, states]);
  const filtered = epicFilter !== "all" || states.size > 0;

  const toggle = (state: GraphState) =>
    setStates((prev) => {
      const next = new Set(prev);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });

  return (
    <Page className="flex h-full flex-col gap-5 pb-6">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex max-w-reading flex-col gap-1">
          <Heading level={1}>Roadmap</Heading>
          <Text tone="muted">Everything in {status.project!.name}, from the project to its slices. Select an item to see where it stands and what you can do.</Text>
        </div>
        <Button variant="primary" onClick={() => setNewSlice({ epicId: epicFilter === "all" ? null : epicFilter })} disabled={!status.epics.length}>
          <Plus aria-hidden="true" />
          Start a slice
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-y border-line py-3" role="toolbar" aria-label="Roadmap filters and view">
        <div className="flex items-center gap-2">
          <span id="epic-filter" className="text-label text-ink-muted">
            Epic
          </span>
          <Select
            size="sm"
            aria-label="Epic"
            className="w-60"
            value={epicFilter}
            onValueChange={setEpicFilter}
            options={[{ value: "all", label: "All epics" }, ...status.epics.map((e) => ({ value: e.epic_id, label: `${e.epic_id} ${e.title}` }))]}
          />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Show slices that are">
          <span className="mr-1 text-label text-ink-muted">State</span>
          {stateOrder
            .filter((s) => present.has(s) || states.has(s))
            .map((state) => {
              const d = graphStates[state];
              const on = states.has(state);
              return (
                <button
                  key={state}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(state)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-caption font-semibold transition-colors duration-[var(--mach-duration-fast)]",
                    on ? cn(toneClasses[d.tone].soft, toneClasses[d.tone].ink, toneClasses[d.tone].line) : "border-line-strong text-ink-muted hover:bg-surface-sunken hover:text-ink",
                  )}
                >
                  <StateGlyph shape={d.glyph} size={12} />
                  {d.label}
                </button>
              );
            })}
          {filtered ? (
            <Button
              size="sm"
              variant="link"
              className="ml-1"
              onClick={() => {
                setStates(new Set());
                setEpicFilter("all");
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Legend />
          <div className="flex gap-1" role="group" aria-label="View">
            <Button size="sm" variant={view === "graph" ? "secondary" : "ghost"} aria-pressed={view === "graph"} onClick={() => setView("graph")}>
              <Network aria-hidden="true" />
              Map
            </Button>
            <Button size="sm" variant={view === "list" ? "secondary" : "ghost"} aria-pressed={view === "list"} onClick={() => setView("list")}>
              <List aria-hidden="true" />
              List
            </Button>
          </div>
        </div>
      </div>

      {!status.epics.length ? (
        <EmptyState
          title="No epics yet"
          description="Add the larger capabilities of the product first; their slices then appear here."
          action={
            <Button variant="primary" asChild>
              <Link to="/vision" state={{ focus: "epics" }}>
                Add an epic
              </Link>
            </Button>
          }
        />
      ) : shown.nodes.length <= 1 && filtered ? (
        <EmptyState
          title="Nothing matches these filters"
          description="No slice is in the chosen states for this epic."
          action={
            <Button
              onClick={() => {
                setStates(new Set());
                setEpicFilter("all");
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : view === "graph" ? (
        <div className="min-h-[420px] flex-1">
          <ProductGraph
            nodes={shown.nodes}
            edges={shown.edges}
            onSelect={setSelected}
            selectedId={selected?.id}
            ariaLabel={`Roadmap of ${status.project!.name}. Use Tab to move between items and Enter to open one.`}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-line bg-surface p-3">
          <GraphOutline nodes={shown.nodes} edges={shown.edges} onSelect={setSelected} selectedId={selected?.id} />
        </div>
      )}

      <Text as="p" size="caption" tone="subtle">
        Approved means you approved the definition. Accepted means engineering took it into the shared project. Neither means it has been built.
      </Text>

      <NodeSheet node={selected} status={status} onClose={() => setSelected(null)} onSelect={setSelected} nodes={full.nodes} onNewSlice={(epicId) => setNewSlice({ epicId })} />
      <NewSliceDialog open={newSlice !== null} onOpenChange={(open) => !open && setNewSlice(null)} epics={status.epics} epicId={newSlice?.epicId} />
    </Page>
  );
}

/** Keeps slices in the chosen epic and states, with the epics and project above them. Presentation only. */
function filterGraph(nodes: MachNode[], edges: MachEdge[], epic: string, states: Set<GraphState>) {
  if (epic === "all" && states.size === 0) return { nodes, edges };
  const parentOf = new Map(edges.filter((e) => e.data?.kind === "contains").map((e) => [e.target, e.source]));
  const keep = new Set<string>();
  for (const node of nodes) {
    if (node.data.kind !== "slice") continue;
    const epicId = parentOf.get(node.id);
    if (epic !== "all" && epicId !== `epic:${epic}`) continue;
    if (states.size && !states.has(node.data.state)) continue;
    keep.add(node.id);
    if (epicId) keep.add(epicId);
  }
  for (const node of nodes) {
    if (node.data.kind === "epic" && epic === `${node.data.artifactId}` && states.size === 0) keep.add(node.id);
    if (node.data.kind === "product") keep.add(node.id);
  }
  return { nodes: nodes.filter((n) => keep.has(n.id)), edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
}

function Legend() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">
          <Info aria-hidden="true" />
          Legend
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="text-label text-ink">What the map shows</p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {stateOrder.map((state) => {
            const d = graphStates[state];
            return (
              <li key={state} className="flex items-center gap-2 text-body-sm">
                <span className={toneClasses[d.tone].ink}>
                  <StateGlyph shape={d.glyph} />
                </span>
                {d.label}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 border-t border-line pt-3 text-body-sm text-ink-muted">
          Lines connect the project to its epics and each epic to its slices. A dashed arrow will show when one slice needs another first.
        </p>
      </PopoverContent>
    </Popover>
  );
}
