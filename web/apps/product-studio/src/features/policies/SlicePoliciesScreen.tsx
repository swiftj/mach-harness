import { useState } from "react";
import { CircleAlert, Scale } from "lucide-react";
import { Link, useParams } from "react-router";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, Heading, IdText, Quote, Skeleton, Text, describeError, plain, plural } from "@mach/ui";
import type { SliceShow } from "@mach/ui/api";
import { useSliceShow } from "../../api/useSliceShow";
import { useOperation } from "../../api/useOperation";
import { useStatus } from "../../api/store";
import { Part, Parts } from "../../shared/layout/Parts";
import { OnePane, WorkPane, WorkPanes, WorkScreen } from "../../shared/layout/WorkScreen";
import { SliceContext } from "../effects/SliceContext";
import { AcceptConcernDialog } from "./AcceptConcernDialog";
import {
  answerFindings,
  checkWords,
  concernState,
  openConcerns,
  packAnswerSummary,
  policyRows,
  principleAnswerWords,
  principleRows,
  principleSummary,
  settledConcerns,
  sliceTabState,
  type ConcernRow,
  type PolicyRow,
  type PrincipleRow,
} from "./model";
import { Findings, StatePill } from "./parts";

/**
 * One slice's principles and policies: how its spec answers each product principle and each policy
 * pack that applies, from `slice.show` (`spec.model.principles`, `spec.model.policies`, the check's
 * findings), with names from `principle.list` and `policy.list` and the older-version flags from
 * `status`. A flagged concern is the centre: its statement, why it cannot be met, its owner and its
 * resolution. The owner's acceptance (`policy.accept`) is recorded only through its own dialog.
 *
 * M16 layout: the slice's context row with its pages as tabs; an open concern first and never folded, with its two
 * ways on (change the specification, record the owner's acceptance) as they were; then each pack and each principle a
 * row that says its state, its detail folded; what the check says and what changed since in the narrow pane.
 */
export function SlicePoliciesScreen() {
  const sliceId = useParams().sliceId ?? "";
  return <PoliciesPage key={sliceId} sliceId={sliceId} />;
}

const ABOUT = "How this slice keeps each product principle and follows each policy pack that applies to it. Each pack that applies is followed, or lists the statements this slice cannot meet; only a pack's owner settles such a concern.";

function PoliciesPage({ sliceId }: { sliceId: string }) {
  const show = useSliceShow(sliceId);
  return (
    <WorkScreen header={<SliceContext sliceId={sliceId} show={show.data} title="Principles and policies" about={ABOUT} refreshing={show.loading && Boolean(show.data)} />}>
      {show.loading && !show.data ? (
        <OnePane label="Principles and policies">
          <div role="status" aria-busy="true" aria-label="Reading this slice" className="flex max-w-reading flex-col gap-3">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        </OnePane>
      ) : !show.data ? (
        <OnePane label="Principles and policies">
          <ErrorState
            icon={<CircleAlert />}
            title={`${sliceId} could not be read`}
            message={show.error ? (show.error.kind === "refused" ? show.error.message : describeError(show.error).message) : undefined}
            hint={show.error?.hint}
            action={<Button onClick={show.reload}>Try again</Button>}
          />
        </OnePane>
      ) : (
        <Answers show={show.data} onChanged={show.reload} />
      )}
    </WorkScreen>
  );
}

function Answers({ show, onChanged }: { show: SliceShow; onChanged: () => void }) {
  const sliceId = show.slice.slice_id;
  const model = show.spec?.model ?? null;
  const state = sliceTabState(show.spec ? model : null);
  const principleList = useOperation("principle.list", state === "answers" && model?.principles?.length ? {} : null);
  const packList = useOperation("policy.list", state === "answers" && model?.policies?.length ? {} : null);
  const status = useStatus();
  const row = status.data?.slices.find((s) => s.slice_id === sliceId);
  const findings = answerFindings(show.check);
  // An open concern is shown above the rows, never folded. With none, the first pack whose concerns were settled opens,
  // so how each was settled (the owner's words) is in view on arrival; otherwise every row is closed and says its state.
  const [openPart, setOpenPart] = useState<string | null>(() => {
    const rows = policyRows(model?.policies);
    if (openConcerns(rows).length) return null;
    const settled = rows.find((r) => settledConcerns(r).length);
    return settled ? `pack-${settled.pack}` : null;
  });

  if (state === "no-spec") {
    return (
      <OnePane label="Principles and policies">
        <EmptyState
          icon={<Scale />}
          title="No specification yet"
          description="Once the interview has written this slice's specification, its answers to the product principles and to the policy packs that apply are shown here."
          action={
            <Button asChild variant="secondary">
              <Link to={`/slices/${sliceId}/interview`}>Start the interview</Link>
            </Button>
          }
        />
      </OnePane>
    );
  }

  const principles = principleRows(model?.principles, principleList.data?.principles ?? [], row?.principles);
  const policies = policyRows(model?.policies, packList.data?.packs ?? []);
  const open = openConcerns(policies);
  const titleOf = (pack: string) => policies.find((p) => p.pack === pack)?.title ?? pack;
  const aside = findings.length || row?.policies_changed || row?.principles?.note;

  const main = (
    <WorkPane label="Concerns, packs and principles">
      <div className="flex flex-col gap-8">
        {open.length ? (
          <section aria-labelledby="open-concerns-title" className="flex flex-col gap-4">
            <h2 id="open-concerns-title" className="sr-only">
              Concerns waiting for their owners
            </h2>
            <Banner tone="warning" title={open.length === 1 ? "1 concern waits for its owner" : `${open.length} concerns wait for their owners`}>
              This slice cannot be marked ready until each owner accepts their concern or the specification changes so the statement is met.
            </Banner>
            <ol aria-label="Open concerns" className="flex flex-col gap-4">
              {open.map((concern) => (
                <Concern key={`${concern.pack}-${concern.statementId}`} concern={concern} packTitle={titleOf(concern.pack)} level={3} show={show} onChanged={onChanged} />
              ))}
            </ol>
          </section>
        ) : null}

        {state === "nothing-to-answer" ? (
          <EmptyState
            icon={<Scale />}
            title="Nothing to answer here"
            description="This slice's specification answers no product principle and no policy pack. Either the project has none that apply, or the interview has not settled them yet; the check below says which, if it found anything."
          />
        ) : (
          <>
            {policies.length ? <PoliciesPart rows={policies} open={openPart} onOpenChange={setOpenPart} show={show} onChanged={onChanged} /> : null}
            {principles.length ? <PrinciplesPart rows={principles} open={openPart} onOpenChange={setOpenPart} /> : null}
          </>
        )}
      </div>
    </WorkPane>
  );

  if (!aside) return <WorkPanes>{main}</WorkPanes>;
  return (
    <WorkPanes>
      {main}
      <WorkPane side label="What the check says and what changed">
        <div className="flex flex-col gap-6">
          {row?.policies_changed ? (
            <Banner tone="info" title="A policy pack changed after this slice answered it">
              {row.policies_changed}
            </Banner>
          ) : null}
          {row?.principles?.note ? (
            <Banner tone="info" title="Principles changed after this slice answered them">
              {row.principles.note}
            </Banner>
          ) : null}
          <Findings items={findings} />
        </div>
      </WorkPane>
    </WorkPanes>
  );
}

/* ── Policy packs ─────────────────────────────────────────────────────────── */

function PoliciesPart({
  rows,
  open,
  onOpenChange,
  show,
  onChanged,
}: {
  rows: PolicyRow[];
  open: string | null;
  onOpenChange: (id: string | null) => void;
  show: SliceShow;
  onChanged: () => void;
}) {
  return (
    <section aria-labelledby="slice-policies" className="flex flex-col gap-3">
      <Heading level={2} size="title-3" id="slice-policies">
        Policy packs
      </Heading>
      <Parts label="Policy packs this slice answers" open={open} onOpenChange={onOpenChange} headingLevel={3}>
        {rows.map((row) => {
          const settled = settledConcerns(row);
          return (
            <Part
              key={row.pack}
              id={`pack-${row.pack}`}
              name={row.title ?? row.pack}
              summary={packAnswerSummary(row)}
              status={
                <>
                  <ArtifactId>{row.pack}</ArtifactId>
                  {row.answer === "followed" ? <StatePill word="Followed" shape="approved" tone="success" /> : <StatePill word={plural(row.concerns.length, "concern")} shape="question" tone="warning" />}
                </>
              }
            >
              {settled.length ? (
                <ol aria-label={`Settled concerns with ${row.title ?? row.pack}`} className="flex flex-col gap-4">
                  {settled.map((concern) => (
                    <Concern key={concern.statementId} concern={{ ...concern, pack: row.pack }} level={4} show={show} onChanged={onChanged} />
                  ))}
                </ol>
              ) : undefined}
            </Part>
          );
        })}
      </Parts>
    </section>
  );
}

function Concern({ concern, packTitle, level, show, onChanged }: { concern: ConcernRow & { pack: string }; packTitle?: string; level: 3 | 4; show: SliceShow; onChanged: () => void }) {
  const state = concernState(concern.resolution);
  const sliceId = show.slice.slice_id;
  const headingId = `concern-${concern.statementId}`;
  const isOpen = concern.resolution === "open";
  const H = level === 3 ? "h3" : "h4";
  return (
    <li
      aria-labelledby={headingId}
      className={
        isOpen
          ? "flex flex-col gap-4 rounded-lg border-2 border-dashed border-warning-line bg-surface px-5 py-5"
          : "flex flex-col gap-4 rounded-lg border border-line bg-surface px-5 py-5"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <H id={headingId} className="flex flex-wrap items-center gap-x-2 text-label text-ink">
          <span className="sr-only">Concern with </span>
          <ArtifactId>{concern.statementId}</ArtifactId>
          {packTitle ? (
            <span className="text-body-sm font-normal text-ink-muted">
              in {packTitle === concern.pack ? <ArtifactId plain>{concern.pack}</ArtifactId> : packTitle}
            </span>
          ) : null}
        </H>
        <StatePill {...state} size="md" />
      </div>

      <p className="max-w-reading text-body-lg font-semibold text-ink">“{plain(concern.statement)}”</p>

      <dl className="grid max-w-reading grid-cols-1 gap-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-x-5">
        <dt className="text-body-sm text-ink-muted">Why it cannot be met</dt>
        <dd className="min-w-0 break-words text-body text-ink">{concern.why}</dd>
        <dt className="text-body-sm text-ink-muted">Owner</dt>
        <dd className="min-w-0 break-words text-body text-ink">{concern.owner}</dd>
        <dt className="text-body-sm text-ink-muted">Resolution</dt>
        <dd className="min-w-0 text-body text-ink">
          <Resolution concern={concern} />
        </dd>
      </dl>

      {isOpen ? (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <Text size="body-sm" className="max-w-reading">
            Open: this slice cannot be marked ready until its owner accepts this concern, or the specification changes so the statement is met.
          </Text>
          {show.editable ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="secondary">
                <Link to={`/slices/${sliceId}/interview`}>Change the specification</Link>
              </Button>
              <AcceptConcernDialog sliceId={sliceId} concern={concern} onDone={onChanged} />
            </div>
          ) : (
            <Text size="body-sm" tone="muted" className="max-w-reading">
              {show.edit_refusal ?? "This slice cannot be changed now, so no acceptance can be recorded on it."}
            </Text>
          )}
        </div>
      ) : null}
    </li>
  );
}

function Resolution({ concern }: { concern: ConcernRow }) {
  if (concern.resolution === "open") return <>Open, waiting for {concern.owner}.</>;
  if (concern.resolution === "spec_changed") return <>Resolved by changing the specification so the statement is met.</>;
  const accepted = concern.accepted;
  if (!accepted) return <>Accepted.</>;
  return (
    <div className="flex flex-col gap-2">
      <Quote from={accepted.name} kind={accepted.on ? `accepted it on ${formatDay(accepted.on)}` : "accepted it; the date is not recorded"}>
        {accepted.words}
      </Quote>
      <Text size="body-sm" tone="muted">
        {checkWords(accepted.check)} This guards against accident, not forgery: the name is recorded as given.
      </Text>
    </div>
  );
}

/** A YYYY-MM-DD date as the day, month and year, in the person's locale. */
function formatDay(day: string): string {
  const date = new Date(`${day}T12:00:00`);
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/* ── Product principles ───────────────────────────────────────────────────── */

function PrinciplesPart({ rows, open, onOpenChange }: { rows: PrincipleRow[]; open: string | null; onOpenChange: (id: string | null) => void }) {
  return (
    <section aria-labelledby="slice-principles" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Heading level={2} size="title-3" id="slice-principles">
          Product principles
        </Heading>
        <Text size="body-sm" tone="muted" className="max-w-reading">
          How this slice answers each principle: what upholds it, why it does not apply, or your exception in your own words.
        </Text>
      </div>
      <Parts label="Product principles this slice answers" open={open} onOpenChange={onOpenChange} headingLevel={3}>
        {rows.map((row) => {
          const answer = principleAnswerWords(row.answer);
          return (
            <Part
              key={row.id}
              id={`principle-${row.id}`}
              name={row.title ?? row.id}
              summary={principleSummary(row)}
              status={
                <>
                  <ArtifactId>{row.id}</ArtifactId>
                  <StatePill {...answer} />
                  {row.older ? <StatePill word="Answered under an older revision" shape="half" tone="warning" /> : null}
                  {row.retired ? <StatePill word="Retired" shape="superseded" tone="neutral" /> : null}
                </>
              }
            >
              <div className="flex flex-col gap-2">
                <p className="max-w-reading text-body text-ink">
                  “{plain(row.statement)}” <span className="text-caption text-ink-subtle">revision {row.revision}</span>
                </p>
                {row.answer === "applies" ? (
                  <Text size="body-sm" tone="muted">
                    {row.upheldBy.length ? (
                      <>
                        Upheld by <IdText text={row.upheldBy.join(", ")} />.
                      </>
                    ) : (
                      "What upholds it is not recorded."
                    )}
                  </Text>
                ) : row.answer === "does_not_apply" ? (
                  <Text size="body-sm" tone="muted" className="max-w-reading">
                    Why it does not apply: <span className="text-ink">{row.reason ?? "not recorded"}</span>
                  </Text>
                ) : (
                  <Quote from="The product manager" kind="made an exception">
                    {row.reason ?? "The reason is not recorded."}
                  </Quote>
                )}
              </div>
            </Part>
          );
        })}
      </Parts>
    </section>
  );
}
