import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { CircleAlert } from "lucide-react";
import { ArtifactId, Banner, Button, Heading, Spinner, Text, cn } from "@mach/ui";
import { uploadLimits, type Status } from "@mach/ui/api";
import { useRefresh } from "../../../api/store";
import { useRequestList } from "../../../shared/useRequestList";
import { IssueLink, IssueText } from "../../../shared/IssueLink";
import { ProjectOnGithubNotice } from "../../../shared/ProjectStartNotice";
import { CloseProjectIssues } from "../../../shared/CloseProjectIssue";
import { extraProjectIssues } from "../../../shared/team";
import { ContextRow, OnePane, WorkScreen } from "../../../shared/layout/WorkScreen";
import { usePrdImport } from "../../prd/usePrdImport";
import { AddIdeaDialog } from "../../shape/ideas/AddIdeaDialog";
import { ideaPath } from "../../shape/shell/steps";
import { joinProgressWords, projectEntry, requestsToStartFrom, startedWays, wayById, ways, type Started, type Way } from "./model";
import { chooseStartAnyway, startJoin, useJoin, useStartAnyway, type JoinState } from "../../../api/join";
import { ImportUnfinishedNotice } from "../../../shared/ImportUnfinishedNotice";
import { PROJECT_FILE_MAX } from "../../move/model";

const sizeWords = (bytes: number) => (bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MB` : `${Math.round(bytes / 1024)} KB`);

/**
 * A workspace with no project yet. When the repository is on GitHub and may hold one, the project someone else defined is
 * brought in first, by itself (FromGithub); the ways to start from nothing are offered only when GitHub was read and holds
 * no project for this repository, or when the repository is not on GitHub.
 */
export function StartScreen({ status }: { status: Status }) {
  const anyway = useStartAnyway();
  return projectEntry(status, anyway) === "join" ? <FromGithub /> : <Ways status={status} />;
}

/** How long the screen waits before reading GitHub again by itself after a failed read. */
const RETRY_MS = 60_000;

/**
 * The project is on GitHub: MACH brings it in. While it does, the screen says so with how many slices have come; if GitHub
 * cannot be read, it says that in the engine's own words, offers "Try again", tries again by itself, and never offers to
 * describe the product from nothing (that would start a second project).
 */
export function FromGithub() {
  const join = useJoin();
  const failedAt = join.phase === "failed" ? join.at : null;
  useEffect(() => {
    if (join.phase === "idle") void startJoin();
  }, [join.phase]);
  useEffect(() => {
    if (failedAt === null) return;
    const timer = window.setTimeout(() => void startJoin(), RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [failedAt]);
  if (join.phase !== "failed" && join.phase !== "done") return <BringingIn join={join.phase === "idle" ? { phase: "looking" } : join} />;
  const words = join.phase === "failed" ? join.text : (join.result?.note ?? "");
  return (
    <WorkScreen header={<ContextRow title="This project is on GitHub" />}>
      <OnePane label="Bringing in the project" width="content">
        <div className="flex max-w-reading flex-col gap-6 pb-6">
          <Banner
            tone="warning"
            live="polite"
            title="MACH could not read GitHub"
            actions={
              <Button size="sm" onClick={() => void startJoin()}>
                Try again
              </Button>
            }
          >
            {words}
          </Banner>
          <Text tone="muted">
            This repository is on GitHub, so its project, epics and slices come from there, exactly as the person who defined them saved them. Nothing here
            was changed. Meanwhile, check that this computer is online and signed in to GitHub. MACH tries again by itself every minute.
          </Text>
          <div className="flex flex-col items-start gap-2">
            <Text size="body-sm" tone="muted">
              If this repository has no project yet, you can start a product of your own here instead. A project that is on GitHub comes in once GitHub
              can be read.
            </Text>
            <Button variant="secondary" size="sm" onClick={chooseStartAnyway}>
              Start a product of my own
            </Button>
          </div>
        </div>
      </OnePane>
    </WorkScreen>
  );
}

/** "Bringing in Rulebook Explorer from GitHub", with how many slices have come. */
export function BringingIn({ join }: { join: Extract<JoinState, { phase: "looking" | "bringing" | "other_window" }> }) {
  const title =
    join.phase === "bringing"
      ? `Bringing in ${join.name} from GitHub`
      : join.phase === "other_window"
        ? "Another window is bringing the project in"
        : "Looking for this project on GitHub";
  const progress = join.phase === "bringing" ? joinProgressWords(join.done, join.total) : null;
  return (
    <WorkScreen header={<ContextRow title={title} />}>
      <OnePane label="Bringing in the project" width="content">
        <div className="flex max-w-reading flex-col gap-4 pb-6">
          <span role="status" className="inline-flex items-center gap-2 text-body text-ink">
            <Spinner size="sm" />
            {progress ? `${progress} so far` : "Reading the project, its epics and slices"}
          </span>
          <Text tone="muted">
            This repository's project was defined on GitHub. MACH brings it into your workspace as it is there, with its epics and slices, so you see the same
            product and have nothing to type again. Nothing is changed on GitHub.
          </Text>
        </div>
      </OnePane>
    </WorkScreen>
  );
}

/**
 * A project with no definition yet (M19). It asks how the person wants to start and lists every way, each with what
 * happens and what they need, as one ruled list rather than a set of cards. Once a way is started (a PRD imported, an
 * idea added) it first says where they are, with the way to carry on, and keeps the other ways below. Every state shown
 * is what the engine reported (`status.prds`, `status.ideas`, `request.list`).
 */
function Ways({ status }: { status: Status }) {
  const started = startedWays(status);
  const refresh = useRefresh();
  const requests = useRequestList();
  // The home refreshes once per visit; the requests it brings are read again when it finishes.
  const refreshedAt = refresh.at;
  const reloadRequests = requests.reload;
  useEffect(() => {
    if (refreshedAt) reloadRequests();
  }, [refreshedAt, reloadRequests]);
  const waiting = requests.data?.repository ? requestsToStartFrom(requests.data.items) : [];
  const several = (refresh.data?.github.same_id_twice ?? status.same_id_twice ?? []).find((clash) => clash.kind === "project") ?? null;

  return (
    <WorkScreen
      header={
        <ContextRow
          title={started.length ? "Carry on where you left off" : "How do you want to start?"}
          actions={
            refresh.loading ? (
              <span role="status" className="inline-flex items-center gap-2 text-body-sm text-ink-muted">
                <Spinner size="sm" /> Checking GitHub
              </span>
            ) : null
          }
        />
      }
    >
      <OnePane label="Ways to start the project" width="content">
        <div className="flex flex-col gap-10 pb-6">
          <Text size="body-lg" tone="muted" className="max-w-reading">
            {started.length
              ? "The product is not named yet. Carry on with what you started, or start another way. Everything stays a private draft in your workspace until you approve it."
              : "This project has no product definition yet. Choose the way that fits what you have. Everything stays a private draft in your workspace until you approve it."}
          </Text>
          {several ? (
            // M20: never a stop. Naming the product carries on with the oldest project issue and says so; closing an extra
            // one is offered beside the sentence, as the person's one yes.
            <Banner tone="info" title="This repository has more than one project on GitHub" className="max-w-reading">
              <IssueText text={several.note} urls={several.urls ?? {}} />
              <div className="mt-2">
                <CloseProjectIssues numbers={extraProjectIssues(several.others, null)} />
              </div>
            </Banner>
          ) : (
            // M20: one project already on GitHub; naming the product here takes its words. Said before anything is typed.
            <ProjectOnGithubNotice found={status.project_on_github} className="max-w-reading" />
          )}
          <ImportUnfinishedNotice status={status} className="max-w-reading" />
          {started.length ? <WhereYouAre started={started} /> : null}
          <section aria-labelledby="ways-title" className="flex flex-col gap-4">
            <Heading level={2} size="title-3" id="ways-title" className={started.length ? undefined : "sr-only"}>
              {started.length ? "Or start another way" : "Ways to start"}
            </Heading>
            <ul className="flex flex-col border-t border-line">
              <DescribeWay way={ways[0] as Way} />
              <PrdWay way={ways[1] as Way} />
              <IdeaWay way={ways[2] as Way} />
              {waiting.length ? (
                <WayRow way={ways[3] as Way} action={null}>
                  <ul aria-label="Requests waiting on GitHub" className="flex flex-col gap-2 pt-1">
                    {waiting.map((item) => (
                      <li key={item.number} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <IssueLink number={item.number} url={item.url} />
                        <span className="min-w-0 flex-1 break-words text-body text-ink">{item.title ?? "Title not recorded"}</span>
                        <Button size="sm" asChild>
                          <Link to={`/start/requests/${item.number}`}>{`Start from #${item.number}`}</Link>
                        </Button>
                      </li>
                    ))}
                  </ul>
                </WayRow>
              ) : null}
              <ImportWay way={wayById("import")} />
            </ul>
          </section>
        </div>
      </OnePane>
    </WorkScreen>
  );
}

/** What was started and where it stands, each with the one way to carry on. The first is the page's primary act. */
function WhereYouAre({ started }: { started: Started[] }) {
  return (
    <section aria-labelledby="where-title" className="flex flex-col gap-3">
      <Heading level={2} size="title-3" id="where-title">
        Where you are
      </Heading>
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
        {started.map((row, index) => (
          <li key={row.id} className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 px-5 py-4">
            <div className="flex min-w-0 max-w-reading flex-col gap-0.5">
              <span className="text-body-sm text-ink-muted">{row.kind === "prd" ? "Starting from a PRD" : "Shaping an idea"}</span>
              <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span className="break-words text-body font-semibold text-ink">{row.name}</span>
                <ArtifactId>{row.id}</ArtifactId>
              </span>
              <span className="text-body-sm text-ink-muted">{row.stands}</span>
            </div>
            <Button variant={index === 0 ? "primary" : "secondary"} asChild>
              <Link to={row.to}>{row.action}</Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One way: its name, what happens and what the person needs, and the button that starts it. On a wide window the three
 * sit in columns so the list reads down; on a narrow one they stack.
 */
function WayRow({ way, action, needs, children }: { way: Way; action: ReactNode; needs?: string; children?: ReactNode }) {
  return (
    <li
      className={cn("grid gap-x-10 gap-y-2 border-b border-line py-6", "md:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)_auto] md:items-start")}
    >
      <Heading level={3} size="title-3" id={`way-${way.id}`} className="md:pt-1">
        {way.title}
      </Heading>
      <div className="flex min-w-0 max-w-reading flex-col gap-2">
        <Text>{way.happens}</Text>
        <Text size="body-sm" tone="muted">
          You need {needs ?? way.needs}
        </Text>
        {children}
      </div>
      {action ? <div className="pt-1 md:justify-self-end">{action}</div> : null}
    </li>
  );
}

/** M21 F: a project downloaded from another repository; the "Move this project" screen looks at it first. */
function ImportWay({ way }: { way: Way }) {
  return (
    <WayRow
      way={way}
      needs={`${way.needs} It can be at most ${sizeWords(PROJECT_FILE_MAX)}.`}
      action={
        <Button asChild>
          <Link to="/move">{way.action}</Link>
        </Button>
      }
    />
  );
}

function DescribeWay({ way }: { way: Way }) {
  return (
    <WayRow
      way={way}
      action={
        <Button asChild>
          <Link to="/vision">{way.action}</Link>
        </Button>
      }
    />
  );
}

/** Choosing the file opens the browser's chooser straight away; once imported, the PRD's own page carries on. */
function PrdWay({ way }: { way: Way }) {
  const navigate = useNavigate();
  const { inputRef, onPicked, accept, choose, busy, act, tooEarly } = usePrdImport((imported) => void navigate(`/prds/${imported.prd.prd_id}`));
  const limit = uploadLimits.prd;
  const problem = tooEarly ? `${tooEarly} Nothing was imported.` : act.shown ? act.shown.message : null;
  return (
    <WayRow
      way={way}
      needs={`${way.needs} It can be at most ${sizeWords(limit.maxBytes)}.`}
      action={
        <>
          <input ref={inputRef} type="file" accept={accept} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void onPicked(e)} />
          <Button onClick={choose} loading={busy}>
            {way.action}
          </Button>
        </>
      }
    >
      {problem ? (
        <div role="alert" className="flex items-start gap-2 text-body-sm text-danger-ink">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>{problem}</p>
        </div>
      ) : null}
    </WayRow>
  );
}

/** Adding the idea is the same dialog as on the ideas board; the idea's own page then carries on with exploring it. */
function IdeaWay({ way }: { way: Way }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <WayRow
      way={way}
      action={
        <>
          <Button onClick={() => setOpen(true)}>{way.action}</Button>
          <AddIdeaDialog open={open} onOpenChange={setOpen} onAdded={(added) => void navigate(ideaPath(added.idea.idea_id, "explore"))} />
        </>
      }
    />
  );
}
