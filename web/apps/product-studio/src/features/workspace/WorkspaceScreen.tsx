import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowRight, CircleAlert, RefreshCw } from "lucide-react";
import {
  ArtifactId,
  Banner,
  Button,
  Disclosure,
  EpicStatusPill,
  formatWhen,
  ErrorState,
  Heading,
  Page,
  ReviewStatusPill,
  Skeleton,
  SkeletonText,
  SliceStatusPill,
  SourceBadge,
  Spinner,
  StateGlyph,
  Text,
  cn,
  describeError,
  sliceStates,
  toneClasses,
  type FeedbackWave,
  type NextAction,
  type Refresh,
  type Status,
} from "@mach/ui";
import { useFeedback, useRefresh, useStatus } from "../../api/store";
import { describePath, fieldWords } from "../../api/describe";
import { nextActions, routeFor } from "../../api/nextActions";
import { ApproveEpicDialog } from "../vision/ApproveEpicDialog";
import { NewSliceDialog } from "../roadmap/NewSliceDialog";
import { FirstRun } from "./FirstRun";

/** Refresh once per visit, when the workspace first opens. */
let refreshedThisVisit = false;

export function WorkspaceScreen() {
  const status = useStatus();
  const refresh = useRefresh();

  useEffect(() => {
    if (!refreshedThisVisit) {
      refreshedThisVisit = true;
      void refresh.run();
    }
  }, [refresh]);

  if (!status.data && (status.loading || (!status.error && !status.data))) return <WorkspaceSkeleton />;
  if (!status.data && status.error) {
    const { title, message } = describeError(status.error);
    return (
      <Page width="reading">
        <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={() => void status.reload()}>Try again</Button>} />
      </Page>
    );
  }
  const data = status.data as Status;
  if (!data.project) return <FirstRun status={data} refreshing={refresh.loading} />;
  return <Workspace status={data} />;
}

function Workspace({ status }: { status: Status }) {
  const project = status.project!;
  const refresh = useRefresh();
  const anyApproved = status.waves.some((w) => w.status === "approved_for_engineering");
  const feedback = useFeedback(anyApproved);
  const [approveEpic, setApproveEpic] = useState<string | null>(null);
  const [newSlice, setNewSlice] = useState<{ epicId: string | null } | null>(null);
  const navigate = useNavigate();
  const actions = nextActions(status);
  const reconcileCount = status.needs_reconciling.conflicts.length + status.needs_reconciling.collisions.length;

  const runRoute = (action: NextAction) => {
    const route = routeFor(action);
    if (route.type === "navigate") navigate(route.to);
    else if (route.type === "approve-epic") setApproveEpic(route.epicId);
    else if (route.type === "new-slice") setNewSlice({ epicId: route.epicId });
    else void refresh.run();
  };

  const inProgress = status.slices.filter((s) => s.status === "draft" || s.status === "interviewing" || s.status === "ready_for_approval");
  inProgress.sort((a, b) => (a.slice_id === status.current_slice ? -1 : b.slice_id === status.current_slice ? 1 : 0));
  const epicToApprove = status.epics.find((e) => e.epic_id === approveEpic) ?? null;

  return (
    <Page>
      <div className="flex flex-col gap-10">
        <header className="flex items-start justify-between gap-8">
          <div className="flex min-w-0 max-w-reading flex-col gap-3">
            <Heading level={1} size="display">
              {project.name}
            </Heading>
            <Text editorial size="body-lg" className="text-ink">
              {project.vision}
            </Text>
            {project.outcomes.length ? (
              <div className="mt-1 flex flex-col gap-1.5">
                <Text size="body-sm" tone="muted" weight="semibold">
                  Intended outcomes
                </Text>
                <ul className="flex flex-col gap-1">
                  {project.outcomes.map((outcome) => (
                    <li key={outcome} className="flex gap-2.5 text-body text-ink">
                      <span aria-hidden="true" className="mt-[11px] h-px w-3 shrink-0 bg-accent" />
                      {outcome}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-2">
            <Button variant="ghost" asChild>
              <Link to="/vision">Edit vision</Link>
            </Button>
            <Button onClick={() => void refresh.run()} loading={refresh.loading}>
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
          </div>
        </header>

        <AttentionBanners status={status} refresh={refresh.data} refreshError={refresh.error ? describeError(refresh.error).message : null} onRetry={() => void refresh.run()} reconcileCount={reconcileCount} />

        <div className="grid grid-cols-[minmax(0,1fr)_minmax(280px,340px)] gap-10">
          <div className="flex min-w-0 flex-col gap-10">
            <Panel title="Recommended next" id="next">
              {actions.length ? (
                <ol className="flex flex-col divide-y divide-line">
                  {actions.slice(0, 5).map((action, index) => {
                    const route = routeFor(action);
                    return (
                      <li key={`${action.kind}-${action.target}-${index}`} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="text-body text-ink">{action.title}</span>
                          {action.reason ? <span className="text-body-sm text-ink-muted">{action.reason}</span> : null}
                        </div>
                        <Button variant={index === 0 ? "primary" : "secondary"} size="sm" onClick={() => runRoute(action)}>
                          {route.label}
                          {route.type === "navigate" ? <ArrowRight aria-hidden="true" /> : null}
                        </Button>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <Text tone="muted">Nothing is waiting. Start a new slice when you are ready.</Text>
              )}
            </Panel>

            <Panel
              title="In progress"
              id="progress"
              aside={
                <Button size="sm" onClick={() => setNewSlice({ epicId: null })} disabled={!status.epics.length}>
                  Start a slice
                </Button>
              }
            >
              {inProgress.length ? (
                <ul className="flex flex-col gap-3">
                  {inProgress.map((slice) => {
                    const current = slice.slice_id === status.current_slice;
                    const approvable = slice.status === "ready_for_approval";
                    return (
                      <li
                        key={slice.slice_id}
                        className={cn("flex flex-col gap-2 rounded-md border bg-surface px-4 py-3", current ? "border-accent" : "border-line")}
                      >
                        <div className="flex items-center gap-3">
                          <ArtifactId>{slice.slice_id}</ArtifactId>
                          <span className="min-w-0 flex-1 truncate text-body font-semibold text-ink">{slice.title}</span>
                          <SourceBadge source={slice.source} />
                          <SliceStatusPill status={slice.status} size="sm" />
                        </div>
                        {current ? <Text size="caption" tone="accent">You were last working on this slice.</Text> : null}
                        {slice.resume_note ? (
                          <Text editorial size="body" tone="muted">
                            {slice.resume_note}
                          </Text>
                        ) : null}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                          {slice.open_questions > 0 ? (
                            <Text as="span" size="body-sm" tone="info">
                              {slice.open_questions} {slice.open_questions === 1 ? "question is" : "questions are"} still open
                            </Text>
                          ) : approvable ? (
                            <Text as="span" size="body-sm" tone="accent">
                              Ready for your approval
                            </Text>
                          ) : null}
                          <span className="ml-auto flex gap-2">
                            <Button size="sm" variant="ghost" asChild>
                              <Link to={`/slices/${slice.slice_id}`}>Specification</Link>
                            </Button>
                            <Button size="sm" variant={approvable ? "secondary" : "primary"} asChild>
                              <Link to={`/slices/${slice.slice_id}/interview`}>{slice.status === "draft" ? "Start the interview" : "Continue the interview"}</Link>
                            </Button>
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <Text tone="muted">No slice is being worked on.</Text>
              )}
            </Panel>

            <Panel title="Scope" id="scope" aside={<Link className="text-body-sm font-semibold text-accent-ink underline-offset-2 hover:underline" to="/roadmap">Open the roadmap</Link>}>
              <ScopeByEpic status={status} onApprove={setApproveEpic} />
            </Panel>
          </div>

          <aside className="flex min-w-0 flex-col gap-8" aria-label="Status">
            <Decisions status={status} refresh={refresh.data} reconcileCount={reconcileCount} />
            <WithEngineering status={status} reviews={feedback.data?.waves ?? null} loading={feedback.loading} />
            <FromShared refresh={refresh.data} loading={refresh.loading} status={status} />
          </aside>
        </div>
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

function Panel({ title, id, aside, children }: { title: string; id: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4 border-b border-line pb-2">
        <Heading level={2} size="title-3" id={`${id}-title`}>
          {title}
        </Heading>
        {aside}
      </div>
      {children}
    </section>
  );
}

function SideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <Heading level={2} size="title-3" className="text-body font-semibold">
        {title}
      </Heading>
      {children}
    </section>
  );
}

function AttentionBanners({
  status,
  refresh,
  refreshError,
  onRetry,
  reconcileCount,
}: {
  status: Status;
  refresh: Refresh | null;
  refreshError: string | null;
  onRetry: () => void;
  reconcileCount: number;
}) {
  const banners: ReactNode[] = [];
  if (refreshError) {
    banners.push(
      <Banner key="host" tone="danger" live="assertive" title="Could not check the shared project" actions={<Button size="sm" onClick={onRetry}>Try again</Button>}>
        {refreshError}
      </Banner>,
    );
  } else if (refresh && !refresh.refreshed) {
    banners.push(
      <Banner key="offline" tone="warning" live="polite" title={refresh.problem ?? "The shared project could not be reached"} actions={<Button size="sm" onClick={onRetry}>Try again</Button>}>
        Your drafts are safe and you can keep working. What others have approved will appear when you are connected.
        {refresh.problem_detail ? (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-caption text-ink-muted">Details for an engineer</summary>
            <span className="font-mono text-caption text-ink-muted">{refresh.problem_detail}</span>
          </details>
        ) : null}
      </Banner>,
    );
  }
  const withdrawn = status.approvals_withdrawn ?? [];
  if (withdrawn.length) {
    banners.push(
      <Banner
        key="withdrawn"
        tone="warning"
        live="polite"
        title={withdrawn.length === 1 ? "An approval no longer holds" : `${withdrawn.length} approvals no longer hold`}
        actions={
          <Button size="sm" asChild>
            <Link to="/inbox">Review</Link>
          </Button>
        }
      >
        <ul className="flex flex-col gap-1">
          {withdrawn.map((w) => (
            <li key={w.artifact}>
              <span className="font-semibold">{titled(w.artifact, status)}</span>
              {w.reason ? `: ${w.reason}` : ""}
              {w.at ? <span className="text-ink-muted"> ({formatWhen(w.at)})</span> : null}
            </li>
          ))}
        </ul>
      </Banner>,
    );
  } else if (refresh?.approvals_withdrawn.length) {
    banners.push(
      <Banner key="withdrawn" tone="warning" live="polite" title="Some approvals no longer hold" actions={<Button size="sm" asChild><Link to="/inbox">Review</Link></Button>}>
        A change from the shared project made {refresh.approvals_withdrawn.length === 1 ? "this approval" : "these approvals"} untrue:{" "}
        {refresh.approvals_withdrawn.map((item) => titled(item, status)).join("; ")}. Approve again once you have looked.
      </Banner>,
    );
  }
  if (reconcileCount > 0) {
    banners.push(
      <Banner key="reconcile" tone="warning" title={`${reconcileCount === 1 ? "One item needs" : `${reconcileCount} items need`} your decision`} actions={<Button size="sm" asChild><Link to="/inbox">Open decisions</Link></Button>}>
        Your drafts and the shared project disagree. Settle these before approving anything that depends on them.
      </Banner>,
    );
  }
  if (status.structural_errors.length) {
    // The engine's message names files; the PM sees the items they belong to, the exact words behind a disclosure.
    const affected = [...new Set(status.structural_errors.map((error) => describePath(error.split(":")[0] ?? error, status).label))];
    banners.push(
      <Banner
        key="structure"
        tone="danger"
        title="Some of your drafts no longer fit together"
      >
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
  return banners.length ? <div className="flex flex-col gap-3">{banners}</div> : null;
}

/** "Slice SLICE-001, Invite a teammate" for an engine ID; workspace paths through describePath. */
function titled(id: string, status: Status): string {
  if (id.includes("/")) return describePath(id, status).label;
  const slice = status.slices.find((s) => s.slice_id === id);
  if (slice) return `Slice ${id}, ${slice.title}`;
  const epic = status.epics.find((e) => e.epic_id === id);
  if (epic) return `Epic ${id}, ${epic.title}`;
  if (id.startsWith("WAVE-")) return `Delivery wave ${id}`;
  return id;
}

function ScopeByEpic({ status, onApprove }: { status: Status; onApprove: (epicId: string) => void }) {
  if (!status.epics.length) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-line-strong px-5 py-5">
        <Text>No epics yet. An epic is a larger capability, such as “Team membership”, that several slices deliver.</Text>
        <Button asChild variant="primary" size="sm">
          <Link to="/vision" state={{ focus: "epics" }}>
            Add the first epic
          </Link>
        </Button>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-6">
      {status.epics.map((epic) => {
        const slices = status.slices.filter((s) => s.epic_id === epic.epic_id);
        const approved = slices.filter((s) => s.status === "approved_for_engineering");
        const open = slices.filter((s) => s.status !== "approved_for_engineering" && s.status !== "superseded");
        return (
          <li key={epic.epic_id} className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <ArtifactId>{epic.epic_id}</ArtifactId>
              <span className="min-w-0 text-body font-semibold text-ink">{epic.title}</span>
              <EpicStatusPill status={epic.status} size="sm" />
              <SourceBadge source={epic.source} />
              {epic.status === "proposed" ? (
                <Button size="sm" className="ml-auto" onClick={() => onApprove(epic.epic_id)}>
                  Review and approve
                </Button>
              ) : null}
            </div>
            {slices.length ? (
              <div className="flex flex-col gap-1.5 pl-1">
                {approved.length ? <ScopeLine label="Approved" slices={approved} /> : null}
                {open.length ? <ScopeLine label="Still being defined" slices={open} /> : null}
              </div>
            ) : (
              <Text size="body-sm" tone="muted" className="pl-1">
                No slices yet.
              </Text>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ScopeLine({ label, slices }: { label: string; slices: Status["slices"] }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] items-baseline gap-3">
      <Text as="span" size="body-sm" tone="muted">
        {label}
      </Text>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {slices.map((s) => {
          const d = sliceStates[s.status];
          return (
            <li key={s.slice_id}>
              <Link to={`/slices/${s.slice_id}`} className="inline-flex items-center gap-1.5 text-body-sm text-ink hover:underline">
                <span className={toneClasses[d.tone].ink}>
                  <StateGlyph shape={d.glyph} title={d.label} />
                </span>
                {s.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Decisions({ status, refresh, reconcileCount }: { status: Status; refresh: Refresh | null; reconcileCount: number }) {
  const items = [
    ...status.needs_reconciling.conflicts.map((path) => ({ path, why: "Changed here and in the shared project" })),
    ...status.needs_reconciling.collisions.map((path) => ({ path, why: "Needs a new number" })),
  ];
  const withdrawn = status.approvals_withdrawn ? status.approvals_withdrawn.map((w) => w.artifact) : (refresh?.approvals_withdrawn ?? []);
  return (
    <SideCard title="Needs your decision">
      {items.length || withdrawn.length ? (
        <>
          <ul className="flex flex-col gap-2">
            {items.slice(0, 5).map(({ path, why }) => (
              <li key={path} className="flex flex-col">
                <span className="text-body-sm text-ink">{describePath(path, status).label}</span>
                <span className="text-caption text-warning-ink">{why}</span>
              </li>
            ))}
            {withdrawn.map((item) => (
              <li key={item} className="flex flex-col">
                <span className="text-body-sm text-ink">{titled(item, status)}</span>
                <span className="text-caption text-warning-ink">
                  {status.approvals_withdrawn?.find((w) => w.artifact === item)?.reason ?? "Approval withdrawn by a shared change"}
                </span>
              </li>
            ))}
          </ul>
          <Button size="sm" asChild className="self-start">
            <Link to="/inbox">{reconcileCount > 5 ? `See all ${reconcileCount}` : "Open decisions"}</Link>
          </Button>
        </>
      ) : (
        <Text size="body-sm" tone="muted">
          Nothing is waiting for your decision.
        </Text>
      )}
    </SideCard>
  );
}

function WithEngineering({ status, reviews, loading }: { status: Status; reviews: FeedbackWave[] | null; loading: boolean }) {
  // Approved waves, with where each stands in review as the engine's feedback reports it.
  const waves = status.waves.filter((w) => w.status === "approved_for_engineering");
  const title = (id: string) => status.slices.find((s) => s.slice_id === id)?.title ?? id;
  return (
    <SideCard title="With engineering">
      {waves.length ? (
        <ul className="flex flex-col gap-3">
          {waves.map((wave) => {
            const review = reviews?.find((r) => r.wave_id === wave.wave_id);
            const reviewStatus = review?.status ?? (wave.sent ? "Sent" : "Approved, not sent");
            return (
              <li key={wave.wave_id} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <ArtifactId>{wave.wave_id}</ArtifactId>
                  {!review && loading ? (
                    <span className="inline-flex items-center gap-1.5 text-caption text-ink-muted">
                      <Spinner size="sm" /> Checking review
                    </span>
                  ) : (
                    <ReviewStatusPill status={reviewStatus} size="sm" />
                  )}
                </div>
                <span className="text-body-sm text-ink-muted">{wave.slices.map(title).join(", ")}</span>
                {review && review.status !== "Approved, not sent" && review.meaning ? (
                  <span className="text-caption text-ink-subtle">{review.meaning}</span>
                ) : null}
                {reviewStatus === "Approved, not sent" && !loading ? (
                  <Link to="/waves" className="text-body-sm font-semibold text-accent-ink hover:underline">
                    Prepare to send
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <Text size="body-sm" tone="muted">
          Nothing has been sent for review. Approved slices go to engineering in a delivery wave.
        </Text>
      )}
      {waves.length ? (
        <Text size="caption" tone="subtle">
          Accepted means engineering took the definitions into the shared project. It does not mean the work is built.
        </Text>
      ) : null}
    </SideCard>
  );
}

function FromShared({ refresh, loading, status }: { refresh: Refresh | null; loading: boolean; status: Status }) {
  const changes = useMemo(() => {
    if (!refresh) return [];
    return [
      ...refresh.arrived.map((path) => ({ path, what: "Arrived" })),
      ...refresh.updated.map((u) => ({ path: u.path, what: u.fields?.length ? `Changed: ${u.fields.map(fieldWords).join(", ")}` : u.changed?.length ? `Changed: ${u.changed.join(", ")}` : "Changed" })),
      ...refresh.merged.map((m) => ({ path: m.path, what: `Merged with your draft: ${m.taken_from_shared.map(fieldWords).join(", ")}` })),
    ];
  }, [refresh]);
  return (
    <SideCard title="From the shared project">
      {loading && !refresh ? (
        <p role="status" className="flex items-center gap-2 text-body-sm text-ink-muted">
          <Spinner size="sm" /> Checking what others have approved
        </p>
      ) : refresh && !refresh.refreshed ? (
        <Text size="body-sm" tone="warning">
          Not reachable just now.
        </Text>
      ) : changes.length ? (
        <>
          <ul className="flex flex-col gap-2">
            {changes.slice(0, 6).map(({ path, what }) => {
              const described = describePath(path, status);
              return (
                <li key={path + what} className="flex flex-col">
                  <span className="text-body-sm text-ink">{described.label}</span>
                  <span className="text-caption text-ink-muted">{what}</span>
                </li>
              );
            })}
          </ul>
          {changes.length > 6 ? (
            <Link to="/shared" className="text-body-sm font-semibold text-accent-ink hover:underline">
              See all {changes.length} changes
            </Link>
          ) : null}
        </>
      ) : (
        <Text size="body-sm" tone="muted">
          {refresh ? "Nothing new since you last looked." : "Not checked yet this visit."}
          {status.last_refreshed ? ` Last checked ${new Date(status.last_refreshed).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.` : ""}
        </Text>
      )}
    </SideCard>
  );
}

function WorkspaceSkeleton() {
  return (
    <Page>
      <div role="status" aria-busy="true" aria-label="Reading your workspace" className="flex flex-col gap-10">
        <div className="flex max-w-reading flex-col gap-4">
          <Skeleton className="h-11 w-80" />
          <SkeletonText lines={2} />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(280px,340px)] gap-10">
          <div className="flex flex-col gap-4">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
          <div className="flex flex-col gap-4">
            <Skeleton className="h-5 w-40" />
            <SkeletonText lines={3} />
            <Skeleton className="h-5 w-40" />
            <SkeletonText lines={2} />
          </div>
        </div>
      </div>
    </Page>
  );
}

