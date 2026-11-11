import { CircleAlert, CircleCheck, RefreshCw, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, Heading, Page, Skeleton, Text, describeError, reviewDescriptor, type FeedbackWave, type Renumber, type Status, Panel, formatWhen, plural } from "@mach/ui";
import { ReviewProgress } from "../waves/delivery/ReviewProgress";
import { forget, useDeliveryMemory, type Withdrawal } from "../waves/delivery/memory";
import { useDeliveryRead } from "../waves/delivery/ops";
import { CollisionCard } from "./CollisionCard";
import { ConflictCard } from "./ConflictCard";
import { OpenQuestionsCard } from "./OpenQuestionsCard";
import { artifactFromPath, titleFor } from "../../api/describe";

function Group({ id, title, hint, count, children }: { id: string; title: string; hint: string; count: number; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-6 flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <Heading level={2} id={`${id}-title`} size="title-2">
          {title} <span className="font-sans text-body text-ink-subtle tabular">({count})</span>
        </Heading>
        <Text size="body-sm" tone="muted">
          {hint}
        </Text>
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function WithdrawnCard({ item, status, again, dismissable = true }: { item: Withdrawal; status: Status; again: boolean; dismissable?: boolean }) {
  const title = titleFor(status, item.id);
  const to = item.id.startsWith("WAVE-") ? "/waves" : item.id.startsWith("SLICE-") ? `/slices/${item.id}` : "/roadmap";
  return (
    <article aria-label={`${item.id} ${again ? "needs approval again" : "approval withdrawn"}`} className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-line bg-surface px-5 py-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2 text-body font-semibold text-ink">
          <ArtifactId>{item.id}</ArtifactId>
          {title ? <span>{title}</span> : null}
        </p>
        <Text size="body-sm">{item.why}</Text>
        <Text size="caption" tone="subtle">
          {again ? "Needs your approval again" : "Approval withdrawn"}{item.at ? ` · ${formatWhen(item.at)}` : ""}
        </Text>
      </div>
      <div className="flex items-center gap-2">
        <Button asChild size="sm">
          <Link to={to}>Review and approve again</Link>
        </Button>
        {dismissable ? (
          <Button size="sm" variant="ghost" onClick={() => forget(item.id)}>
            <X aria-hidden="true" />
            Dismiss<span className="sr-only"> {item.id}</span>
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function RenumberResult({ result, onClose }: { result: Renumber; onClose: () => void }) {
  return (
    <Banner
      tone="success"
      live="polite"
      title={`${result.renumbered.from} is now ${result.renumbered.to}`}
      actions={
        <Button size="sm" variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <p>Every reference moved with it ({plural(result.changed.length, "item")} updated in your draft).</p>
      {result.needs_approval_again.length ? (
        <p className="mt-1 font-semibold">
          Needs your approval again: {result.needs_approval_again.join(", ")}. It is listed below under approvals.
        </p>
      ) : (
        <p className="mt-1">Nothing needs approving again.</p>
      )}
    </Banner>
  );
}

/**
 * The Decision Inbox: everything only the PM can decide, most urgent first. Items that block sharing
 * (conflicts, collisions) come first, then engineering waiting on the PM, withdrawn approvals, and open
 * interview questions. The engine reports every item; this screen only orders and explains them.
 */
export function InboxScreen() {
  const status = useDeliveryRead("status", {});
  const feedback = useDeliveryRead("feedback", status.data?.waves.some((w) => w.sent) ? {} : null);
  const memory = useDeliveryMemory();
  const [renumbered, setRenumbered] = useState<Renumber | null>(null);

  if (status.loading && !status.data) {
    return (
      <Page width="reading">
        <div role="status" aria-busy="true" aria-label="Reading what needs your decision" className="flex flex-col gap-4">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="mt-4 h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </Page>
    );
  }
  if (!status.data) {
    const { title, message } = status.error ? describeError(status.error) : { title: "Nothing to show", message: "" };
    return (
      <Page width="reading">
        <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={status.reload}>Try again</Button>} />
      </Page>
    );
  }

  const data = status.data;
  const reconciling = data.needs_reconciling;
  const collisionIds = [...new Set(reconciling.collisions.map((p) => artifactFromPath(p).owner ?? p))];
  const engineering: FeedbackWave[] = (feedback.data?.waves ?? []).filter((w) => reviewDescriptor(w.status).attention);
  const present = (id: string) => [...data.slices.map((s) => s.slice_id), ...data.waves.map((w) => w.wave_id), ...data.epics.map((e) => e.epic_id)].includes(id);
  // The engine reports withdrawn approvals and their reason (status.approvals_withdrawn); older
  // engines did not, so this browser's own record is the fallback.
  const fromEngine = data.approvals_withdrawn !== undefined;
  const withdrawn: Withdrawal[] = fromEngine
    ? (data.approvals_withdrawn ?? []).map((w) => ({ id: w.artifact, why: w.reason ?? "Something changed what you had approved.", at: w.at ?? "" }))
    : memory.withdrawn.filter((w) => present(w.id));
  const again = memory.needsApprovalAgain.filter((w) => present(w.id) && !withdrawn.some((x) => x.id === w.id));
  const questions = data.slices.filter((s) => s.open_questions > 0);

  const groups = [
    { id: "conflicts", label: "Versions to choose", count: reconciling.conflicts.length },
    { id: "collisions", label: "New numbers needed", count: collisionIds.length },
    { id: "engineering", label: "Engineering is waiting on you", count: engineering.length },
    { id: "approvals", label: "Approvals to give again", count: withdrawn.length + again.length },
    { id: "questions", label: "Open questions", count: questions.length },
  ].filter((g) => g.count > 0);
  const total = groups.reduce((n, g) => n + g.count, 0);

  return (
    <Page>
      <div className="flex max-w-[64rem] flex-col gap-8">
        <header className="flex max-w-reading flex-col gap-3">
          <Heading level={1}>Decisions</Heading>
          <Text tone="muted">
            Things only you can decide, most urgent first. Nothing here is decided for you, and every choice asks you to confirm it.
          </Text>
          {total > 0 ? (
            <nav aria-label="Decisions by kind">
              <ul className="flex flex-wrap gap-2">
                {groups.map((g) => (
                  <li key={g.id}>
                    <a
                      href={`#${g.id}`}
                      onClick={(event) => {
                        event.preventDefault();
                        document.getElementById(g.id)?.scrollIntoView({ block: "start" });
                      }}
                      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-body-sm text-ink hover:bg-surface-sunken"
                    >
                      {g.label}
                      <span className="font-semibold tabular">{g.count}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </header>

        {renumbered ? <RenumberResult result={renumbered} onClose={() => setRenumbered(null)} /> : null}

        {feedback.error ? (
          <Banner tone="info" title="Review progress could not be checked just now" actions={<Button size="sm" onClick={feedback.reload}>Check again</Button>}>
            Anything engineering is waiting on will appear here once it can be read.
          </Banner>
        ) : null}

        {total === 0 ? (
          <EmptyState
            layout="page"
            icon={<CircleCheck />}
            title="Nothing to decide"
            description={
              feedback.loading && !feedback.data
                ? "Your drafts agree with the shared project and no interview has an open question. Still checking engineering's review…"
                : "Your drafts agree with the shared project, no interview has an open question, and engineering isn't waiting on you."
            }
            action={
              <Button asChild>
                <Link to="/shared">
                  <RefreshCw aria-hidden="true" />
                  Check the shared project for changes
                </Link>
              </Button>
            }
          />
        ) : null}

        {reconciling.conflicts.length ? (
          <Group
            id="conflicts"
            title="Versions to choose"
            hint="These changed both in your draft and in the shared project. Nothing that contains them can be approved or sent until you choose."
            count={reconciling.conflicts.length}
          >
            {reconciling.conflicts.map((path) => (
              <ConflictCard key={path} path={path} detail={reconciling.details[path]} status={data} onSettled={status.reload} />
            ))}
          </Group>
        ) : null}

        {collisionIds.length ? (
          <Group id="collisions" title="New numbers needed" hint="Someone else's work took these numbers first. Your work is fine; it needs a new number before it can be shared." count={collisionIds.length}>
            {collisionIds.map((id) => (
              <CollisionCard
                key={id}
                id={id}
                status={data}
                onRenumbered={(result) => {
                  setRenumbered(result);
                  status.reload();
                }}
              />
            ))}
          </Group>
        ) : null}

        {engineering.length ? (
          <Group id="engineering" title="Engineering is waiting on you" hint="Review of a wave you sent needs your response." count={engineering.length}>
            {engineering.map((wave) => (
              <Panel key={wave.wave_id} aria-labelledby={`eng-${wave.wave_id}`} className="flex flex-col gap-4 px-5 py-4">
                <Heading level={3} id={`eng-${wave.wave_id}`} size="title-3">
                  <span className="inline-flex flex-wrap items-center gap-2">
                    Delivery wave <ArtifactId className="text-body text-ink">{wave.wave_id}</ArtifactId>
                  </span>
                </Heading>
                <ReviewProgress wave={wave} headingLevel={4} />
              </Panel>
            ))}
          </Group>
        ) : null}

        {withdrawn.length || again.length ? (
          <Group id="approvals" title="Approvals to give again" hint="Something changed what you had approved. Look again before you rely on it." count={withdrawn.length + again.length}>
            {withdrawn.map((item) => (
              <WithdrawnCard key={`w-${item.id}`} item={item} status={data} again={false} dismissable={!fromEngine} />
            ))}
            {again.map((item) => (
              <WithdrawnCard key={`a-${item.id}`} item={item} status={data} again />
            ))}
          </Group>
        ) : null}

        {questions.length ? (
          <Group id="questions" title="Open questions" hint="Interviews waiting for your answers." count={questions.length}>
            {questions.map((slice) => (
              <OpenQuestionsCard key={slice.slice_id} slice={slice} status={data} />
            ))}
          </Group>
        ) : null}
      </div>
    </Page>
  );
}
