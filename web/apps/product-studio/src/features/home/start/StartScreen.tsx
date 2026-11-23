import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { CircleAlert } from "lucide-react";
import { ArtifactId, Banner, Button, Heading, Spinner, Text, cn } from "@mach/ui";
import { uploadLimits, type Status } from "@mach/ui/api";
import { useRefresh } from "../../../api/store";
import { useRequestList } from "../../../shared/useRequestList";
import { IssueLink } from "../../../shared/IssueLink";
import { ContextRow, OnePane, WorkScreen } from "../../../shared/layout/WorkScreen";
import { usePrdImport } from "../../prd/usePrdImport";
import { AddIdeaDialog } from "../../shape/ideas/AddIdeaDialog";
import { ideaPath } from "../../shape/shell/steps";
import { requestsToStartFrom, startedWays, ways, type Started, type Way } from "./model";

const sizeWords = (bytes: number) => (bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MB` : `${Math.round(bytes / 1024)} KB`);

/**
 * A project with no definition yet (M19). It asks how the person wants to start and lists every way, each with what
 * happens and what they need, as one ruled list rather than a set of cards. Once a way is started (a PRD imported, an
 * idea added) it first says where they are, with the way to carry on, and keeps the other ways below. Every state shown
 * is what the engine reported (`status.prds`, `status.ideas`, `request.list`).
 */
export function StartScreen({ status }: { status: Status }) {
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
            // M20: naming the product would be refused until one of the project issues is closed; said before they try.
            <Banner tone="warning" title="This repository has more than one project on GitHub" className="max-w-reading">
              {several.note}
            </Banner>
          ) : null}
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
