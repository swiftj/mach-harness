import { CircleAlert, CircleCheck, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArtifactId, Button, EmptyState, ErrorState, Heading, Page, Skeleton, SliceGithubPills, Text, describeError, formatWhen, type ApprovalWithdrawn, type Status, type StatusSliceRow } from "@mach/ui";
import { useStatus } from "../../api/store";
import { titleFor } from "../../api/describe";
import { IssueLink } from "../../shared/IssueLink";
import { RenumberDialog } from "../../shared/RenumberDialog";
import { NewerVersionCard } from "./NewerVersionCard";
import { OpenQuestionsCard } from "./OpenQuestionsCard";
import { useRequestList } from "./requests/api";
import { RequestsGroup } from "./requests/RequestsGroup";

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

/** One slice the engine reports something about, with the one way to settle it. */
function SliceCard({ slice, label, children, action }: { slice: StatusSliceRow; label: string; children: ReactNode; action: ReactNode }) {
  const headingId = `${label}-${slice.slice_id}`;
  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border border-line bg-surface px-5 py-4">
      <header className="flex flex-wrap items-center gap-2">
        <Heading level={3} id={headingId} size="title-3">
          <span className="inline-flex flex-wrap items-center gap-2">
            <ArtifactId className="text-body text-ink">{slice.slice_id}</ArtifactId>
            <span>{slice.title}</span>
          </span>
        </Heading>
        <SliceGithubPills github={slice.github} size="sm" />
        {slice.github.issue ? <IssueLink number={slice.github.issue} url={slice.github.url} /> : null}
      </header>
      <Text>{children}</Text>
      <div className="flex flex-wrap gap-2">{action}</div>
    </article>
  );
}

function WithdrawnCard({ item, status }: { item: ApprovalWithdrawn; status: Status }) {
  const title = titleFor(status, item.artifact);
  return (
    <article aria-label={`${item.artifact} approval withdrawn`} className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-line bg-surface px-5 py-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2 text-body font-semibold text-ink">
          <ArtifactId>{item.artifact}</ArtifactId>
          {title ? <span>{title}</span> : null}
        </p>
        {item.reason ? <Text size="body-sm">{item.reason}</Text> : null}
        <Text size="caption" tone="subtle">
          Approval withdrawn{item.at ? ` · ${formatWhen(item.at)}` : ""}
        </Text>
      </div>
      <Button asChild size="sm">
        <Link to={`/slices/${item.artifact}`}>Read it and mark it ready again</Link>
      </Button>
    </article>
  );
}

/**
 * The Decision Inbox: everything only the PM can decide, most urgent first. Every item is something
 * the engine reports (`status`, and the requests found at the last refresh); this screen only orders
 * and explains them, and each act is confirmed in a dialog or made on the slice's own screen.
 */
export function InboxScreen() {
  const status = useStatus();
  const requests = useRequestList();
  const [renumber, setRenumber] = useState<string | null>(null);

  if (!status.data && !status.error) {
    return (
      <Page width="reading">
        <div role="status" aria-busy="true" aria-label="Reading what needs your decision" className="flex flex-col gap-4">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="mt-4 h-40 w-full" />
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
  const changed = data.slices.filter((s) => s.github.changed_on_github);
  const newer = data.slices.filter((s) => s.github.newer_elsewhere);
  const taken = data.slices.filter((s) => s.github.number_taken);
  const unfinished = data.slices.filter((s) => s.github.unfinished);
  const builders = data.slices.filter((s) => s.github.state_label === "mach:question");
  const withdrawn = data.approvals_withdrawn;
  const questions = data.slices.filter((s) => s.open_questions > 0);
  // Requests from GitHub issues: no section at all when the project is not on GitHub.
  const requestsShown = Boolean(requests.data?.repository) || (requests.error !== null && !requests.data);

  const groups = [
    { id: "changed", label: "Changed on GitHub", count: changed.length },
    { id: "newer", label: "Versions to choose", count: newer.length },
    { id: "numbers", label: "New numbers needed", count: taken.length },
    { id: "unfinished", label: "Saving to finish", count: unfinished.length },
    { id: "builders", label: "Questions from the builders", count: builders.length },
    { id: "approvals", label: "Approvals to give again", count: withdrawn.length },
    { id: "questions", label: "Open questions", count: questions.length },
    { id: "requests", label: "Requests", count: requests.data?.items.length ?? 0 },
  ].filter((g) => g.count > 0);
  const total = groups.reduce((n, g) => n + g.count, 0);

  return (
    <Page>
      <div className="flex max-w-[64rem] flex-col gap-8">
        <header className="flex max-w-reading flex-col gap-3">
          <Heading level={1}>Decisions</Heading>
          <Text tone="muted">Things only you can decide, most urgent first. Nothing here is decided for you, and every choice asks you to confirm it.</Text>
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

        {total === 0 ? (
          <EmptyState
            layout="page"
            icon={<CircleCheck />}
            title="Nothing to decide"
            description="Nothing is waiting for your decision, and no interview has an open question."
            action={
              data.github.repository ? (
                <Button asChild>
                  <Link to="/github">
                    <RefreshCw aria-hidden="true" />
                    Check GitHub for changes
                  </Link>
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {changed.length ? (
          <Group id="changed" title="Changed on GitHub after you approved it" hint="The builders will not take these until you put your approved version back." count={changed.length}>
            {changed.map((slice) => (
              <SliceCard
                key={slice.slice_id}
                slice={slice}
                label="changed"
                action={
                  <Button asChild variant="primary">
                    <Link to={`/slices/${slice.slice_id}`}>Read it and mark it ready again</Link>
                  </Button>
                }
              >
                Someone edited this slice&apos;s issue on GitHub after you approved it. Marking it ready again puts your approved version back.
              </SliceCard>
            ))}
          </Group>
        ) : null}

        {newer.length ? (
          <Group id="newer" title="Versions to choose" hint="Someone else saved a newer version of these on GitHub. Choose before you mark them ready." count={newer.length}>
            {newer.map((slice) => (
              <NewerVersionCard key={slice.slice_id} slice={slice} />
            ))}
          </Group>
        ) : null}

        {taken.length ? (
          <Group id="numbers" title="New numbers needed" hint="Another slice on GitHub already uses these numbers. Your work is fine; it needs a new number." count={taken.length}>
            {taken.map((slice) => (
              <SliceCard
                key={slice.slice_id}
                slice={slice}
                label="numbers"
                action={
                  <Button variant="primary" onClick={() => setRenumber(slice.slice_id)}>
                    Give {slice.slice_id} a new number
                  </Button>
                }
              >
                Another slice saved on GitHub uses the number {slice.slice_id}. Your draft keeps everything it says and gets the next free number.
              </SliceCard>
            ))}
          </Group>
        ) : null}

        {unfinished.length ? (
          <Group id="unfinished" title="Saving to finish" hint="You approved these, but saving them to GitHub stopped part way." count={unfinished.length}>
            {unfinished.map((slice) => (
              <SliceCard
                key={slice.slice_id}
                slice={slice}
                label="unfinished"
                action={
                  <Button asChild variant="primary">
                    <Link to={`/slices/${slice.slice_id}`}>Finish marking it ready</Link>
                  </Button>
                }
              >
                Marking it ready again finishes the job; nothing is made twice.
              </SliceCard>
            ))}
          </Group>
        ) : null}

        {builders.length ? (
          <Group id="builders" title="Questions from the builders" hint="The builders asked a question about these slices on GitHub." count={builders.length}>
            {builders.map((slice) => (
              <SliceCard
                key={slice.slice_id}
                slice={slice}
                label="builders"
                action={
                  <Button asChild>
                    <Link to={`/slices/${slice.slice_id}`}>Open the slice</Link>
                  </Button>
                }
              >
                The builders need your answer before they go on. Product Studio does not show their question yet; it is on the slice&apos;s issue.
              </SliceCard>
            ))}
          </Group>
        ) : null}

        {withdrawn.length ? (
          <Group id="approvals" title="Approvals to give again" hint="Something changed what you had approved. Look again before you rely on it." count={withdrawn.length}>
            {withdrawn.map((item) => (
              <WithdrawnCard key={item.artifact} item={item} status={data} />
            ))}
          </Group>
        ) : null}

        {questions.length ? (
          <Group id="questions" title="Open questions" hint="Interviews waiting for your answers." count={questions.length}>
            {questions.map((slice) => (
              <OpenQuestionsCard key={slice.slice_id} slice={slice} />
            ))}
          </Group>
        ) : null}

        {requestsShown ? (
          <Group id="requests" title="Requests" hint="Requests other people filed as GitHub issues. Picking one up starts a draft slice; the interview still asks you every question." count={requests.data?.items.length ?? 0}>
            <RequestsGroup list={requests} status={data} />
          </Group>
        ) : null}
      </div>
      <RenumberDialog id={renumber} onOpenChange={(open) => !open && setRenumber(null)} />
    </Page>
  );
}
