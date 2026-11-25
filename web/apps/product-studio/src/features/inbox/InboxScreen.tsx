import { CircleAlert, CircleCheck, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArtifactId, Button, EmptyState, ErrorState, Heading, Page, Skeleton, SliceGithubPills, Text, describeError, formatWhen, plural, type ApprovalWithdrawn, type Status, type StatusSliceRow } from "@mach/ui";
import { useStatus } from "../../api/store";
import { titleFor } from "../../api/describe";
import { IssueLink, IssueText } from "../../shared/IssueLink";
import { holderWords, momentUrls } from "../../shared/team";
import { AnswerQuestionButton, BuildersQuestion } from "../../shared/BuildersQuestion";
import { NewerVersionCard } from "./NewerVersionCard";
import { OpenQuestionsCard } from "./OpenQuestionsCard";
import { useRequestList } from "../../shared/useRequestList";
import { RequestsGroup } from "./requests/RequestsGroup";
import { requestActions } from "./requests/model";
import { openGroup, questionsSummary, requestsSummary, sliceGroupSummary } from "./model";
import { Part, Parts } from "../../shared/layout/Parts";
import { ContextRow, OnePane, WorkScreen } from "../../shared/layout/WorkScreen";

/** One group's body: the sentence that explains it, then its items. The id keeps the group's old anchor. */
function GroupBody({ id, hint, children }: { id: string; hint: string; children: ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-4">
      <Text size="body-sm" tone="muted" className="max-w-reading">
        {hint}
      </Text>
      {children}
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
      <div className="text-body text-ink">{children}</div>
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
  // Undefined until the person opens or closes a group: then the most urgent group is open.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);

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
  const requestsShown = Boolean(requests.data?.repository) || (requests.error !== null && !requests.data);

  const titles = (slices: StatusSliceRow[]) => slices.map((s) => s.title);
  const requestItems = requests.data?.items ?? null;
  const pickable = (requestItems ?? []).filter((item) => {
    const can = requestActions(item, []);
    return can.pickUp || can.pickUpAsWell;
  }).length;

  // Most urgent first. Each group is a part: closed, it says how many things wait in it and which.
  const groups: Array<{ id: string; name: string; summary: string; count: number; hint: string; body: ReactNode }> = [
    {
      id: "changed",
      name: "Changed on GitHub after you approved it",
      count: changed.length,
      summary: sliceGroupSummary(titles(changed)),
      hint: "The builders will not take these until you put your approved version back.",
      body: changed.map((slice) => (
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
      )),
    },
    {
      id: "newer",
      name: "Versions to choose",
      count: newer.length,
      summary: sliceGroupSummary(titles(newer)),
      hint: "Someone else saved a newer version of these on GitHub. Marking yours ready replaces it, and theirs is kept; or take theirs here.",
      body: newer.map((slice) => <NewerVersionCard key={slice.slice_id} slice={slice} />),
    },
    {
      id: "numbers",
      name: "Numbers someone else holds",
      count: taken.length,
      summary: sliceGroupSummary(titles(taken)),
      hint: "Another slice on GitHub already uses these numbers. Your work is fine: marking it ready gives it the next free number.",
      body: taken.map((slice) => (
        <SliceCard
          key={slice.slice_id}
          slice={slice}
          label="numbers"
          action={
            <Button asChild variant="primary">
              <Link to={`/slices/${slice.slice_id}`}>Read it and mark it ready</Link>
            </Button>
          }
        >
          {slice.github.same_moment ? (
            <IssueText
              text={`Someone else marked ${slice.slice_id} ready at the same moment. ${holderWords(slice.github.same_moment)} issue #${slice.github.same_moment.holder} was made first and keeps the number; yours, #${slice.github.same_moment.issue}, was closed and never reached the builders. Your draft keeps everything it says and gets the next free number.`}
              urls={momentUrls(slice.github.same_moment)}
            />
          ) : (
            `Another slice saved on GitHub uses the number ${slice.slice_id}. Your draft keeps everything it says and gets the next free number.`
          )}
        </SliceCard>
      )),
    },
    {
      id: "unfinished",
      name: "Saving to finish",
      count: unfinished.length,
      summary: sliceGroupSummary(titles(unfinished)),
      hint: "You approved these, but saving them to GitHub stopped part way.",
      body: unfinished.map((slice) => (
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
      )),
    },
    {
      id: "builders",
      name: "Questions from the builders",
      count: builders.length,
      summary: sliceGroupSummary(titles(builders)),
      hint: "The builders need your answer before they go on. Answering reopens the slice and starts its interview from their question.",
      body: builders.map((slice) => (
        <SliceCard key={slice.slice_id} slice={slice} label="builders" action={<AnswerQuestionButton sliceId={slice.slice_id} approved={!slice.editable} />}>
          <BuildersQuestion github={slice.github} headingLevel={3} />
        </SliceCard>
      )),
    },
    {
      id: "approvals",
      name: "Approvals to give again",
      count: withdrawn.length,
      summary: sliceGroupSummary(withdrawn.map((w) => titleFor(data, w.artifact) ?? w.artifact)),
      hint: "Something changed what you had approved. Look again before you rely on it.",
      body: withdrawn.map((item) => <WithdrawnCard key={item.artifact} item={item} status={data} />),
    },
    {
      id: "questions",
      name: "Open questions",
      count: questions.length,
      summary: questionsSummary(questions),
      hint: "Interviews waiting for your answers.",
      body: questions.map((slice) => <OpenQuestionsCard key={slice.slice_id} slice={slice} />),
    },
  ].filter((g) => g.count > 0);
  // Requests from GitHub issues: no group at all when the project is not on GitHub.
  if (requestsShown) {
    groups.push({
      id: "requests",
      name: "Requests",
      count: requestItems?.length ?? 0,
      summary: requestsSummary(requestItems ? requestItems.length : null, pickable),
      hint: "Requests other people filed as GitHub issues. Picking one up starts a draft slice; the interview still asks you every question.",
      body: <RequestsGroup list={requests} status={data} />,
    });
  }
  const total = groups.reduce((n, g) => n + g.count, 0);
  const open = openGroup(
    groups.map((g) => g.id),
    chosen,
  );

  return (
    <WorkScreen
      header={
        <ContextRow
          title="Decisions"
          about="Things only you can decide, most urgent first. Nothing here is decided for you, and every choice asks you to confirm it."
          trail={
            total > 0 ? (
              <Text as="span" size="body-sm" tone="muted">
                {plural(total, "thing")} waiting for you
              </Text>
            ) : null
          }
        />
      }
    >
      <OnePane label="What needs your decision">
        <div className="flex flex-col gap-8">
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
          {groups.length ? (
            <Parts label="Decisions by kind" open={open} onOpenChange={setChosen}>
              {groups.map((g) => (
                <Part key={g.id} id={g.id} name={g.name} summary={g.summary}>
                  <GroupBody id={g.id} hint={g.hint}>
                    {g.body}
                  </GroupBody>
                </Part>
              ))}
            </Parts>
          ) : null}
        </div>
      </OnePane>
    </WorkScreen>
  );
}
