import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowDown, ArrowRight, ArrowUp, CircleAlert, Feather, Plus } from "lucide-react";
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
  SliceGithubPills,
  SliceStatusPill,
  Text,
  cn,
  describeError,
  formatWhen,
  plural,
  toast,
  builderStates,
  type NextAction,
  type OrderRow,
  type StatusSliceRow,
  type Refresh,
  type Status,
  type StatusEpicRow,
} from "@mach/ui";
import { failureText, type OperationArgs } from "@mach/ui/api";
import { client } from "../../api/client";
import { toApiError } from "../../api/session";
import { useRefresh, useStatus } from "../../api/store";
import { describePath, titleFor } from "../../api/describe";
import { nextActions, routeFor } from "../../api/nextActions";
import { destinations } from "../registry";
import { useRequestList } from "../../shared/useRequestList";
import { NewSliceDialog } from "../roadmap/NewSliceDialog";
import { SmallChangeLabel } from "../small-change/SmallChangeLabel";
import type { StartAs } from "../small-change/model";
import { IssueLink, IssueNumber } from "../../shared/IssueLink";
import { RenumberDialog } from "../../shared/RenumberDialog";
import { AnswerQuestionDialog } from "../../shared/BuildersQuestion";
import { SliceTimes } from "../../shared/SliceTimes";
import { EpicSheet } from "../vision/EpicSheet";
import { StartScreen } from "./start/StartScreen";
import { ShapeCarryOn } from "../shape/shell/ShapeCarryOn";
import { Fold } from "../../shared/layout/Fold";
import { ContextRow, OnePane, WorkScreen } from "../../shared/layout/WorkScreen";
import { doneWhenLabel } from "./model";

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
  if (!data.project) return <StartScreen status={data} />;
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
  const [newSlice, setNewSlice] = useState<{ epicId: string | null; start?: StartAs } | null>(null);
  const [renumber, setRenumber] = useState<string | null>(null);
  const [addEpic, setAddEpic] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [answerError, setAnswerError] = useState<ReturnType<typeof failureText> | null>(null);
  const [next] = nextActions(status);

  const runRoute = (action: NextAction) => {
    const route = routeFor(action);
    if (route.type === "navigate") void navigate(route.to);
    else if (route.type === "new-slice") setNewSlice({ epicId: route.epicId });
    else if (route.type === "add-epic") setAddEpic(true);
    else if (route.type === "answer-question") {
      const row = status.slices.find((s) => s.slice_id === route.sliceId);
      if (row && !row.editable) setAnswer(route.sliceId);
      else void navigate(`/slices/${route.sliceId}/interview`, { state: { answer: true } });
    } else setRenumber(route.id);
  };

  // Requests from GitHub issues: only for a project whose shared repository is on GitHub (the engine
  // reports no repository otherwise), counted as the Decisions screen counts them.
  const requestCount = requests.data?.repository ? requests.data.items.length : 0;
  const known = new Set(status.epics.map((e) => e.epic_id));
  const orphans = status.slices.filter((s) => !known.has(s.epic_id));

  return (
    <WorkScreen
      header={
        <ContextRow
          title={project.name}
          trail={project.issue ? <IssueNumber number={project.issue} url={project.url} /> : null}
          below={
            <div className="flex flex-col gap-2 pb-3">
              <Text tone="muted" className="max-w-reading">
                {project.vision}
              </Text>
              <nav aria-label="Project">
                <ul className="flex flex-wrap items-center gap-x-5 gap-y-1 text-body-sm">
                  <li>
                    <button type="button" onClick={() => setAddEpic(true)} className="rounded-xs font-semibold text-accent-ink underline-offset-2 hover:underline">
                      Add an epic
                    </button>
                  </li>
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
            </div>
          }
        />
      }
    >
      <OnePane label="Next steps, epics and slices">
        <div className="flex flex-col gap-8">
          {/* The one act first: the engine's most useful next step. Then what waits for an answer, then the epics. */}
          {next ? <CarryOn action={next} onGo={() => runRoute(next)} /> : null}

          <Notices status={status} refresh={refresh.data} refreshError={refresh.error ? describeError(refresh.error).message : null} onRetry={() => void refresh.run()} />

          <ShapeCarryOn status={status} />

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
                  onAddSlice={(start) => setNewSlice({ epicId: epic.epic_id, start })}
                />
              ))
            ) : (
              <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-line-strong px-5 py-5">
                <Text>No epics yet. An epic is a larger capability, such as “Team membership”, that several slices of intent deliver.</Text>
                <Button variant="primary" size="sm" onClick={() => setAddEpic(true)}>
                  Add the first epic
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
      </OnePane>

      <NewSliceDialog open={newSlice !== null} onOpenChange={(open) => !open && setNewSlice(null)} epics={status.epics} epicId={newSlice?.epicId} start={newSlice?.start} />
      <RenumberDialog id={renumber} onOpenChange={(open) => !open && setRenumber(null)} />
      <EpicSheet state={addEpic ? { mode: "add" } : null} onClose={() => setAddEpic(false)} />
      <AnswerQuestionDialog
        sliceId={answer}
        open={answer !== null}
        onOpenChange={(open) => !open && setAnswer(null)}
        error={answerError}
        setError={setAnswerError}
        onReopened={() => answer && void navigate(`/slices/${answer}/interview`, { state: { answer: true } })}
      />
    </WorkScreen>
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
function CarryOn({ action, onGo }: { action: NextAction; onGo: () => void }) {
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
      <Button variant="primary" size="lg" onClick={onGo}>
        {route.label}
        {route.type === "navigate" ? <ArrowRight aria-hidden="true" /> : null}
      </Button>
    </section>
  );
}

/** Everything the engine reports as waiting for the PM, in one notice, plus problems reaching GitHub. */
function Notices({ status, refresh, refreshError, onRetry }: { status: Status; refresh: Refresh | null; refreshError: string | null; onRetry: () => void }) {
  const notices: ReactNode[] = [];
  if (refreshError) {
    notices.push(
      <Banner key="host" tone="danger" live="assertive" title="Could not check GitHub" actions={<Button size="sm" onClick={onRetry}>Try again</Button>}>
        {refreshError}
      </Banner>,
    );
  } else if (refresh?.github.problem) {
    notices.push(
      <Banner key="offline" tone="warning" live="polite" title="GitHub could not be read" actions={<Button size="sm" onClick={onRetry}>Try again</Button>}>
        {refresh.github.problem} Your drafts are safe and you can keep working; what is shown is from the last time GitHub was read.
      </Banner>,
    );
  }

  const waiting: ReactNode[] = [];
  const named = (slice: Status["slices"][number]) => <span className="font-semibold">{slice.title}</span>;
  for (const slice of status.slices) {
    if (slice.github.changed_on_github) waiting.push(<li key={`c-${slice.slice_id}`}>{named(slice)} was changed on GitHub after you approved it: the builders will not take it until you mark it ready again.</li>);
    if (slice.github.newer_elsewhere) waiting.push(<li key={`n-${slice.slice_id}`}>Someone else saved a newer version of {named(slice)}: choose theirs or keep yours.</li>);
    if (slice.github.number_taken) waiting.push(<li key={`t-${slice.slice_id}`}>{named(slice)} needs a new number, because another slice on GitHub uses it.</li>);
    if (slice.github.unfinished) waiting.push(<li key={`u-${slice.slice_id}`}>Saving {named(slice)} to GitHub stopped part way: mark it ready again to finish.</li>);
    if (slice.github.state_label === "mach:question") waiting.push(<li key={`b-${slice.slice_id}`}>The builders have a question about {named(slice)}.</li>);
  }
  for (const w of status.approvals_withdrawn) {
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
        {named(slice)} has {plural(slice.open_questions, "open question")}.
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
  if (status.github_updates_note || status.github_updates_not_made_note) {
    notices.push(
      <Banner key="updates" tone="info" title="Updates to GitHub">
        {[status.github_updates_note, status.github_updates_not_made_note].filter(Boolean).join(" ")}
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
          {affected.join("; ")}.
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

/** "Invite a teammate (SLICE-001)" for an engine ID. */
function titled(id: string, status: Status): string {
  const title = titleFor(status, id);
  return title ? `${title} (${id})` : id;
}

function EpicBlock({ epic, status, onAddSlice }: { epic: StatusEpicRow; status: Status; onAddSlice: (start?: StartAs) => void }) {
  const slices = status.slices.filter((s) => s.epic_id === epic.epic_id);
  const headingId = `epic-${epic.epic_id}-title`;
  const counts = epic.counts;
  const order = status.order.find((o) => o.epic_id === epic.epic_id);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 border-t border-line pt-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Heading level={3} size="title-2" id={headingId}>
          {epic.title}
        </Heading>
        <ArtifactId>{epic.epic_id}</ArtifactId>
        <EpicStatusPill status={epic.status} size="sm" />
        {epic.issue ? <IssueNumber number={epic.issue} url={epic.url} /> : null}
        {counts.total ? (
          <Text as="span" size="body-sm" tone="muted">
            {counts.ready_or_further} of {plural(counts.total, "slice")} ready or further
            <span className="sr-only"> ({counts.ready_or_further_means})</span>
          </Text>
        ) : null}
      </div>
      {counts.total ? (
        <Text size="caption" tone="subtle">
          Ready or further means {counts.ready_or_further_means}.
        </Text>
      ) : null}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <Link to={`/epics/${epic.epic_id}/today`} className="min-h-6 rounded-xs text-body-sm font-semibold text-accent-ink underline-offset-2 hover:underline">
          How {epic.title} works today
        </Link>
        {epic.acceptance_criteria?.length ? (
          <Fold label={doneWhenLabel(epic.acceptance_criteria.length)} className="max-w-reading">
            <ul className="flex list-disc flex-col gap-0.5 pl-5 text-body-sm text-ink-muted">
              {epic.acceptance_criteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Fold>
        ) : null}
      </div>
      {order?.slices.length ? (
        <OrderedSlices order={order} status={status} />
      ) : slices.length ? (
        <SliceList slices={slices} status={status} />
      ) : (
        <Text size="body-sm" tone="muted">
          No slices yet.
        </Text>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => onAddSlice()}>
          <Plus aria-hidden="true" />
          Add a slice to {epic.title}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onAddSlice("small")}>
          <Feather aria-hidden="true" />
          Start a small change in {epic.title}
        </Button>
      </div>
    </section>
  );
}

/** Each slice with the engine's state for it, when it got there, and the way into its interview or its specification. */
function SliceList({ slices, status }: { slices: Status["slices"]; status: Status }) {
  return (
    <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
      {slices.map((slice) => (
        <SliceRow key={slice.slice_id} slice={slice} status={status} />
      ))}
    </ul>
  );
}

function SliceRow({ slice, status, children }: { slice: StatusSliceRow; status: Status; children?: ReactNode }) {
  const current = slice.slice_id === status.current_slice;
  const interview = slice.editable === false ? null : slice.status === "draft" ? "Start the interview" : slice.status === "interviewing" ? "Continue the interview" : null;
  return (
    <li className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3", current && "bg-accent-soft")}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <Link to={`/slices/${slice.slice_id}`} className="rounded-xs text-body font-semibold text-ink underline-offset-2 hover:underline">
            {slice.title}
          </Link>
          <ArtifactId>{slice.slice_id}</ArtifactId>
          <SmallChangeLabel slice={slice} className="self-center" />
        </span>
        {slice.open_questions > 0 || current ? (
          <span className="text-caption text-ink-muted">
            {[current ? "You were last working on this slice" : null, slice.open_questions > 0 ? `${plural(slice.open_questions, "open question")}` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : null}
        <SliceTimes github={slice.github} mode="latest" />
      </div>
      <SliceStatusPill status={slice.status} size="sm" />
      <SliceGithubPills github={slice.github} size="sm" />
      {slice.github.issue ? <IssueLink number={slice.github.issue} url={slice.github.url} /> : null}
      {interview ? (
        <Button size="sm" variant={current ? "secondary" : "ghost"} asChild>
          <Link to={`/slices/${slice.slice_id}/interview`} aria-label={`${interview}: ${slice.title}`}>
            {interview}
          </Link>
        </Button>
      ) : null}
      {children}
    </li>
  );
}

/**
 * An epic's slices in the engine's order (`status.order`), each with Move up and Move down. Moving
 * is reversible, so it is not confirmed; the engine's note is announced politely. A slice GitHub
 * lists under the epic that is not in this workspace keeps its place and leads to "On GitHub".
 */
function OrderedSlices({ order, status }: { order: OrderRow; status: Status }) {
  const [moving, setMoving] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const move = async (key: string, args: OperationArgs<"slice.move">) => {
    setMoving(key);
    try {
      const result = await client.op("slice.move", args);
      setSaid(result.note);
    } catch (cause) {
      const { title, message } = failureText(toApiError(cause, "slice.move"), `${args.slice_id} was not moved`);
      setSaid(`${title}. ${message}`);
      toast({ tone: "danger", title, description: message });
    } finally {
      setMoving(null);
    }
  };
  const items = order.slices;
  const first = items[0];
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
        {items.map((item, index) => {
          const row = item.in_workspace ? status.slices.find((s) => s.slice_id === item.slice_id) : undefined;
          const title = row?.title ?? item.title ?? item.slice_id;
          const buttons = (
            <span className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Move ${title} up`}
                disabled={index === 0 || moving !== null}
                loading={moving === `${item.slice_id}-up`}
                onClick={() => void move(`${item.slice_id}-up`, { slice_id: item.slice_id, before: items[index - 1]!.slice_id })}
              >
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Move ${title} down`}
                disabled={index === items.length - 1 || moving !== null}
                loading={moving === `${item.slice_id}-down`}
                onClick={() => void move(`${item.slice_id}-down`, { slice_id: item.slice_id, after: items[index + 1]!.slice_id })}
              >
                <ArrowDown aria-hidden="true" />
              </Button>
            </span>
          );
          if (row) {
            return (
              <SliceRow key={item.slice_id} slice={row} status={status}>
                {buttons}
              </SliceRow>
            );
          }
          return (
            <li key={item.slice_id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <span className="min-w-0 break-words text-body text-ink">{title}</span>
                  <ArtifactId>{item.slice_id}</ArtifactId>
                </span>
                <span className="text-caption text-ink-muted">
                  Saved on GitHub by someone else; not in your workspace. Its title is as written on GitHub.{" "}
                  <Link to="/github" className="font-semibold text-accent-ink underline-offset-2 hover:underline">
                    See it on GitHub's list<span className="sr-only">: {item.slice_id}</span>
                  </Link>
                </span>
              </div>
              {item.state_label ? <Text as="span" size="body-sm" tone="muted">{builderStates[item.state_label].label}</Text> : null}
              {item.issue ? <IssueNumber number={item.issue} url={null} /> : null}
              {buttons}
            </li>
          );
        })}
      </ul>
      {order.note ? (
        <div className="flex flex-wrap items-center gap-3">
          <Text size="body-sm" tone={order.unfinished ? "warning" : "muted"}>
            {order.note}
          </Text>
          {order.unfinished && first ? (
            <Button size="sm" loading={moving === "finish"} disabled={moving !== null} onClick={() => void move("finish", { slice_id: first.slice_id, first: true })}>
              Finish the move
            </Button>
          ) : null}
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="sr-only">
        {said}
      </p>
    </div>
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
