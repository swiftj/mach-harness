import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowRight, CircleAlert, Plus } from "lucide-react";
import {
  ArtifactId,
  Banner,
  Button,
  Disclosure,
  EpicStatusPill,
  ErrorState,
  Heading,
  Page,
  Skeleton,
  SkeletonText,
  SliceStatusPill,
  SourceBadge,
  Text,
  cn,
  describeError,
  formatWhen,
  plural,
  type NextAction,
  type Refresh,
  type Status,
  type StatusEpicRow,
} from "@mach/ui";
import { useRefresh, useStatus } from "../../api/store";
import { describePath } from "../../api/describe";
import { nextActions, routeFor } from "../../api/nextActions";
import { destinations } from "../registry";
import { useRequestList } from "../inbox/requests/api";
import { ApproveEpicDialog } from "../vision/ApproveEpicDialog";
import { NewSliceDialog } from "../roadmap/NewSliceDialog";
import { FirstRun } from "./FirstRun";

/** Refresh once per visit, when the project home first opens. */
let refreshedThisVisit = false;

export function HomeScreen() {
  const status = useStatus();
  const refresh = useRefresh();

  useEffect(() => {
    if (!refreshedThisVisit) {
      refreshedThisVisit = true;
      void refresh.run();
    }
  }, [refresh]);

  if (!status.data && (status.loading || (!status.error && !status.data))) return <HomeSkeleton />;
  if (!status.data && status.error) {
    const { title, message } = describeError(status.error);
    return (
      <Page width="reading">
        <h1 className="sr-only">Project home</h1>
        <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={() => void status.reload()}>Try again</Button>} />
      </Page>
    );
  }
  const data = status.data as Status;
  if (!data.project) return <FirstRun status={data} refreshing={refresh.loading} />;
  return <ProjectHome status={data} />;
}

/**
 * The project home: what the product is for, the way to everything else, the one most useful next
 * step the engine reports, anything waiting for the PM's answer, then each epic with its slices.
 */
function ProjectHome({ status }: { status: Status }) {
  const project = status.project!;
  const refresh = useRefresh();
  const requests = useRequestList();
  const navigate = useNavigate();
  const [approveEpic, setApproveEpic] = useState<string | null>(null);
  const [newSlice, setNewSlice] = useState<{ epicId: string | null } | null>(null);
  const [next] = nextActions(status);

  const runRoute = (action: NextAction) => {
    const route = routeFor(action);
    if (route.type === "navigate") void navigate(route.to, route.state === undefined ? undefined : { state: route.state });
    else if (route.type === "approve-epic") setApproveEpic(route.epicId);
    else if (route.type === "new-slice") setNewSlice({ epicId: route.epicId });
    else void refresh.run();
  };

  // Requests from GitHub issues: only for a project whose shared repository is on GitHub (the engine
  // reports no repository otherwise), counted as the Decisions screen counts them.
  const requestCount = requests.data?.repository ? requests.data.items.length : 0;
  const epicToApprove = status.epics.find((e) => e.epic_id === approveEpic) ?? null;
  const known = new Set(status.epics.map((e) => e.epic_id));
  const orphans = status.slices.filter((s) => !known.has(s.epic_id));

  return (
    <Page width="reading" className="max-w-[calc(var(--mach-reading-measure)+12rem)]">
      <div className="flex flex-col gap-10">
        <header className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <Heading level={1} size="display">
              {project.name}
            </Heading>
            <Text size="body-lg" className="max-w-reading text-ink-muted">
              {project.vision}
            </Text>
          </div>
          <nav aria-label="Project">
            <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-body-sm">
              <RowLink to="/vision" state={{ focus: "epics" }}>
                Add an epic
              </RowLink>
              <RowLink to="/vision">Edit the vision and outcomes</RowLink>
              {requestCount > 0 ? <RowLink to="/inbox">{plural(requestCount, "request")} from other people</RowLink> : null}
              {destinations
                .filter((d) => d.to !== "/vision")
                .map((d) => (
                  <RowLink key={d.to} to={d.to}>
                    {d.label}
                  </RowLink>
                ))}
            </ul>
          </nav>
        </header>

        <Notices status={status} refresh={refresh.data} refreshError={refresh.error ? describeError(refresh.error).message : null} onRetry={() => void refresh.run()} />

        {next ? <CarryOn action={next} onGo={() => runRoute(next)} busy={routeFor(next).type === "refresh" && refresh.loading} /> : null}

        <section aria-labelledby="epics-title" className="flex flex-col gap-8">
          <Heading level={2} size="title-3" id="epics-title" className="sr-only">
            Epics and their slices
          </Heading>
          {status.epics.length ? (
            status.epics.map((epic) => (
              <EpicBlock
                key={epic.epic_id}
                epic={epic}
                status={status}
                onApprove={() => setApproveEpic(epic.epic_id)}
                onAddSlice={() => setNewSlice({ epicId: epic.epic_id })}
              />
            ))
          ) : (
            <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-line-strong px-5 py-5">
              <Text>No epics yet. An epic is a larger capability, such as “Team membership”, that several slices deliver.</Text>
              <Button asChild variant="primary" size="sm">
                <Link to="/vision" state={{ focus: "epics" }}>
                  Add the first epic
                </Link>
              </Button>
            </div>
          )}
          {orphans.length ? (
            <section aria-labelledby="orphans-title" className="flex flex-col gap-3">
              <Heading level={3} size="title-2" id="orphans-title">
                Slices whose epic is not in your workspace
              </Heading>
              <SliceList slices={orphans} status={status} />
            </section>
          ) : null}
        </section>
      </div>

      <ApproveEpicDialog
        epic={epicToApprove}
        sliceTitles={status.slices.filter((s) => s.epic_id === approveEpic).map((s) => `${s.slice_id} ${s.title}`)}
        onOpenChange={(open) => !open && setApproveEpic(null)}
      />
      <NewSliceDialog open={newSlice !== null} onOpenChange={(open) => !open && setNewSlice(null)} epics={status.epics} epicId={newSlice?.epicId} />
    </Page>
  );
}

function RowLink({ to, state, children }: { to: string; state?: unknown; children: ReactNode }) {
  return (
    <li>
      <Link to={to} state={state} className="rounded-xs font-semibold text-accent-ink underline-offset-2 hover:underline">
        {children}
      </Link>
    </li>
  );
}

/** The engine's first recommended step, in its own words, with the one button that does it. */
function CarryOn({ action, onGo, busy }: { action: NextAction; onGo: () => void; busy: boolean }) {
  const route = routeFor(action);
  return (
    <section aria-labelledby="carry-on-title" className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 rounded-md border border-line bg-surface px-6 py-5">
      <div className="flex min-w-0 max-w-reading flex-col gap-1">
        <Text as="p" size="caption" tone="subtle">
          Carry on
        </Text>
        <Heading level={2} size="title-2" id="carry-on-title">
          {action.title}
        </Heading>
        {action.reason ? <Text tone="muted">{action.reason}</Text> : null}
      </div>
      <Button variant="primary" size="lg" loading={busy} onClick={onGo}>
        {route.label}
        {route.type === "navigate" ? <ArrowRight aria-hidden="true" /> : null}
      </Button>
    </section>
  );
}

/** Everything the engine reports as waiting for the PM, in one notice, plus problems reaching the shared project. */
function Notices({ status, refresh, refreshError, onRetry }: { status: Status; refresh: Refresh | null; refreshError: string | null; onRetry: () => void }) {
  const notices: ReactNode[] = [];
  if (refreshError) {
    notices.push(
      <Banner key="host" tone="danger" live="assertive" title="Could not check the shared project" actions={<Button size="sm" onClick={onRetry}>Try again</Button>}>
        {refreshError}
      </Banner>,
    );
  } else if (refresh && !refresh.refreshed) {
    notices.push(
      <Banner key="offline" tone="warning" live="polite" title={refresh.problem ?? "The shared project could not be reached"} actions={<Button size="sm" onClick={onRetry}>Try again</Button>}>
        Your drafts are safe and you can keep working. What others have approved will appear when you are connected.
        {refresh.problem_detail ? (
          <Disclosure summary="Details for an engineer" className="mt-1.5 bg-transparent">
            <span className="font-mono text-caption text-ink-muted">{refresh.problem_detail}</span>
          </Disclosure>
        ) : null}
      </Banner>,
    );
  }

  const waiting: ReactNode[] = [];
  const conflicts = status.needs_reconciling.conflicts.length;
  const collisions = status.needs_reconciling.collisions.length;
  if (conflicts) waiting.push(<li key="conflicts">{conflicts === 1 ? "One item was changed" : `${conflicts} items were changed`} both in your draft and in the shared project: choose which version to keep.</li>);
  if (collisions) waiting.push(<li key="collisions">{collisions === 1 ? "One item needs" : `${collisions} items need`} a new number, because someone else's work took it first.</li>);
  const withdrawn = status.approvals_withdrawn ?? refresh?.approvals_withdrawn.map((artifact) => ({ artifact, reason: null, at: null })) ?? [];
  for (const w of withdrawn) {
    waiting.push(
      <li key={`w-${w.artifact}`}>
        Your approval of <span className="font-semibold">{titled(w.artifact, status)}</span> no longer holds{w.reason ? `: ${w.reason}` : "."}
        {w.at ? <span className="text-ink-muted"> ({formatWhen(w.at)})</span> : null}
      </li>,
    );
  }
  for (const slice of status.slices.filter((s) => s.open_questions > 0)) {
    waiting.push(
      <li key={`q-${slice.slice_id}`}>
        <span className="font-semibold">{slice.title}</span> has {plural(slice.open_questions, "open question")}.
      </li>,
    );
  }
  if (waiting.length) {
    notices.push(
      <Banner
        key="waiting"
        tone="warning"
        title={waiting.length === 1 ? "Something needs your answer" : `${waiting.length} things need your answer`}
        actions={
          <Button size="sm" asChild>
            <Link to="/inbox">Answer them</Link>
          </Button>
        }
      >
        <ul className="flex flex-col gap-1">{waiting}</ul>
      </Banner>,
    );
  }

  if (status.structural_errors.length) {
    // The engine's message names files; the PM sees the items they belong to, the exact words behind a disclosure.
    const affected = [...new Set(status.structural_errors.map((error) => describePath(error.split(":")[0] ?? error, status).label))];
    notices.push(
      <Banner key="structure" tone="danger" title="Some of your drafts no longer fit together">
        <p>
          {affected.length === 1 ? "Look at " : "Look at these: "}
          {affected.join("; ")}. Anything that disagrees with the shared project is on the Decisions screen.
        </p>
        <Disclosure summary="What the check reported" className="mt-2 bg-transparent">
          <ul className="flex flex-col gap-1">
            {status.structural_errors.map((error) => (
              <li key={error} className="break-words font-mono text-caption text-ink-muted">
                {error}
              </li>
            ))}
          </ul>
        </Disclosure>
      </Banner>,
    );
  }
  return notices.length ? <div className="flex flex-col gap-3">{notices}</div> : null;
}

/** "Slice SLICE-001, Invite a teammate" for an engine ID; workspace paths through describePath. */
function titled(id: string, status: Status): string {
  if (id.includes("/")) return describePath(id, status).label;
  const slice = status.slices.find((s) => s.slice_id === id);
  if (slice) return `${slice.title} (${id})`;
  const epic = status.epics.find((e) => e.epic_id === id);
  if (epic) return `${epic.title} (${id})`;
  if (id.startsWith("WAVE-")) return `delivery wave ${id}`;
  return id;
}

function EpicBlock({ epic, status, onApprove, onAddSlice }: { epic: StatusEpicRow; status: Status; onApprove: () => void; onAddSlice: () => void }) {
  const slices = status.slices.filter((s) => s.epic_id === epic.epic_id);
  const headingId = `epic-${epic.epic_id}-title`;
  // The same epics the start-a-slice dialog offers.
  const open = epic.status !== "superseded" && epic.status !== "completed";
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 border-t border-line pt-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Heading level={3} size="title-2" id={headingId}>
          {epic.title}
        </Heading>
        <ArtifactId>{epic.epic_id}</ArtifactId>
        <EpicStatusPill status={epic.status} size="sm" />
        <SourceBadge source={epic.source} />
        {epic.status === "proposed" ? (
          <Button size="sm" className="ml-auto" onClick={onApprove}>
            Approve {epic.epic_id}
          </Button>
        ) : null}
      </div>
      {epic.acceptance_criteria?.length ? (
        <div className="flex max-w-reading flex-col gap-1">
          <Text size="body-sm" tone="muted">
            Done when:
          </Text>
          <ul className="flex list-disc flex-col gap-0.5 pl-5 text-body-sm text-ink-muted">
            {epic.acceptance_criteria.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {slices.length ? (
        <SliceList slices={slices} status={status} />
      ) : (
        <Text size="body-sm" tone="muted">
          No slices yet.
        </Text>
      )}
      {open ? (
        <Button variant="ghost" size="sm" className="self-start" onClick={onAddSlice}>
          <Plus aria-hidden="true" />
          Add a slice to {epic.title}
        </Button>
      ) : null}
    </section>
  );
}

/** Each slice with the engine's state for it, and the way into its interview or its specification. */
function SliceList({ slices, status }: { slices: Status["slices"]; status: Status }) {
  return (
    <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
      {slices.map((slice) => {
        const current = slice.slice_id === status.current_slice;
        const interview =
          slice.editable === false ? null : slice.status === "draft" ? "Start the interview" : slice.status === "interviewing" ? "Continue the interview" : null;
        return (
          <li key={slice.slice_id} className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3", current && "bg-accent-soft")}>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <Link to={`/slices/${slice.slice_id}`} className="rounded-xs text-body font-semibold text-ink underline-offset-2 hover:underline">
                  {slice.title}
                </Link>
                <ArtifactId>{slice.slice_id}</ArtifactId>
              </span>
              {slice.open_questions > 0 || current ? (
                <span className="text-caption text-ink-muted">
                  {[current ? "You were last working on this slice" : null, slice.open_questions > 0 ? `${plural(slice.open_questions, "open question")}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
            </div>
            <SourceBadge source={slice.source} />
            <SliceStatusPill status={slice.status} size="sm" />
            {interview ? (
              <Button size="sm" variant={current ? "secondary" : "ghost"} asChild>
                <Link to={`/slices/${slice.slice_id}/interview`} aria-label={`${interview}: ${slice.title}`}>
                  {interview}
                </Link>
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function HomeSkeleton() {
  return (
    <Page width="reading">
      <div role="status" aria-busy="true" aria-label="Reading your project" className="flex flex-col gap-10">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-11 w-80" />
          <SkeletonText lines={2} />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-24 w-full" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      </div>
    </Page>
  );
}
