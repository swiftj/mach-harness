import { CircleAlert, Scale } from "lucide-react";
import { Link, useParams } from "react-router";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, Heading, IdText, Quote, Skeleton, Text, describeError, plain, plural } from "@mach/ui";
import type { SliceShow } from "@mach/ui/api";
import { useSliceShow } from "../../api/useSliceShow";
import { useOperation } from "../../api/useOperation";
import { useStatus } from "../../api/store";
import { SliceScreenFrame } from "../../shared/ScreenFrame";
import { AcceptConcernDialog } from "./AcceptConcernDialog";
import {
  answerFindings,
  checkWords,
  concernState,
  openConcerns,
  policyRows,
  principleAnswerWords,
  principleRows,
  sliceTabState,
  type ConcernRow,
  type PolicyRow,
  type PrincipleRow,
  type SliceRowWithPolicies,
} from "./model";
import { Findings, StatePill } from "./parts";

/**
 * One slice's principles and policies: how its spec answers each product principle and each policy
 * pack that applies, from `slice.show` (`spec.model.principles`, `spec.model.policies`, the check's
 * findings), with names from `principle.list` and `policy.list` and the older-version flags from
 * `status`. A flagged concern is the centre: its statement, why it cannot be met, its owner and its
 * resolution. The owner's acceptance (`policy.accept`) is recorded only through its own dialog.
 */
export function SlicePoliciesScreen() {
  const sliceId = useParams().sliceId ?? "";
  const show = useSliceShow(sliceId);
  return (
    <SliceScreenFrame sliceId={sliceId} slice={show.data?.slice} title="Principles and policies" lead="How this slice keeps each product principle and follows each policy pack that applies to it.">
      {show.loading && !show.data ? (
        <div role="status" aria-busy="true" aria-label="Reading this slice" className="flex max-w-reading flex-col gap-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : !show.data ? (
        <ErrorState
          icon={<CircleAlert />}
          title={`${sliceId} could not be read`}
          message={show.error ? (show.error.kind === "refused" ? show.error.message : describeError(show.error).message) : undefined}
          hint={show.error?.hint}
          action={<Button onClick={show.reload}>Try again</Button>}
        />
      ) : (
        <Answers show={show.data} onChanged={show.reload} />
      )}
    </SliceScreenFrame>
  );
}

function Answers({ show, onChanged }: { show: SliceShow; onChanged: () => void }) {
  const sliceId = show.slice.slice_id;
  const model = show.spec?.model ?? null;
  const state = sliceTabState(show.spec ? model : null);
  const principleList = useOperation("principle.list", state === "answers" && model?.principles?.length ? {} : null);
  const packList = useOperation("policy.list", state === "answers" && model?.policies?.length ? {} : null);
  const status = useStatus();
  const row = status.data?.slices.find((s) => s.slice_id === sliceId) as SliceRowWithPolicies | undefined;
  const findings = answerFindings(show.check);

  if (state === "no-spec") {
    return (
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
    );
  }

  const principles = principleRows(model?.principles, principleList.data?.principles ?? [], row?.principles);
  const policies = policyRows(model?.policies, packList.data?.packs ?? []);
  const open = openConcerns(policies);

  return (
    <div className="flex flex-col gap-10">
      {open.length ? (
        <Banner tone="warning" title={open.length === 1 ? "1 concern waits for its owner" : `${open.length} concerns wait for their owners`}>
          This slice cannot be marked ready until each owner accepts their concern or the specification changes so the statement is met.
        </Banner>
      ) : null}
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

      {state === "nothing-to-answer" ? (
        <EmptyState
          icon={<Scale />}
          title="Nothing to answer here"
          description="This slice's specification answers no product principle and no policy pack. Either the project has none that apply, or the interview has not settled them yet; the check below says which, if it found anything."
        />
      ) : (
        <>
          {policies.length ? <PoliciesPart rows={policies} show={show} onChanged={onChanged} /> : null}
          {principles.length ? <PrinciplesPart rows={principles} /> : null}
        </>
      )}

      <Findings items={findings} />
    </div>
  );
}

/* ── Policy packs ─────────────────────────────────────────────────────────── */

function PoliciesPart({ rows, show, onChanged }: { rows: PolicyRow[]; show: SliceShow; onChanged: () => void }) {
  return (
    <section aria-labelledby="slice-policies" className="flex flex-col gap-5">
      <div className="flex max-w-reading flex-col gap-1">
        <Heading level={2} id="slice-policies">
          Policy packs
        </Heading>
        <Text tone="muted">Each pack that applies is followed, or lists the statements this slice cannot meet. Only a pack&apos;s owner settles such a concern.</Text>
      </div>
      <ul className="flex flex-col gap-6">
        {rows.map((row) => (
          <li key={row.pack} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Heading level={3}>{row.title ?? row.pack}</Heading>
              <ArtifactId>{row.pack}</ArtifactId>
              {row.answer === "followed" ? (
                <StatePill word="Followed" shape="approved" tone="success" />
              ) : (
                <StatePill word={plural(row.concerns.length, "concern")} shape="question" tone="warning" />
              )}
              <Text as="span" size="caption" tone="subtle">
                answered under version{" "}
                <span className="font-mono" translate="no">
                  {row.version}
                </span>
              </Text>
            </div>
            {row.concerns.length ? (
              <ol aria-label={`Concerns with ${row.title ?? row.pack}`} className="flex flex-col gap-4">
                {row.concerns.map((concern) => (
                  <Concern key={concern.statementId} concern={{ ...concern, pack: row.pack }} show={show} onChanged={onChanged} />
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Concern({ concern, show, onChanged }: { concern: ConcernRow & { pack: string }; show: SliceShow; onChanged: () => void }) {
  const state = concernState(concern.resolution);
  const sliceId = show.slice.slice_id;
  const headingId = `concern-${concern.statementId}`;
  const isOpen = concern.resolution === "open";
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
        <h4 id={headingId} className="text-label text-ink">
          <span className="sr-only">Concern with </span>
          <ArtifactId>{concern.statementId}</ArtifactId>
        </h4>
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

function PrinciplesPart({ rows }: { rows: PrincipleRow[] }) {
  return (
    <section aria-labelledby="slice-principles" className="flex flex-col gap-5">
      <div className="flex max-w-reading flex-col gap-1">
        <Heading level={2} id="slice-principles">
          Product principles
        </Heading>
        <Text tone="muted">How this slice answers each principle: what upholds it, why it does not apply, or your exception in your own words.</Text>
      </div>
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
        {rows.map((row) => {
          const answer = principleAnswerWords(row.answer);
          return (
            <li key={row.id} className="flex flex-col gap-2 px-5 py-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h3 className="text-title-3 font-semibold text-ink">{row.title ?? row.id}</h3>
                <ArtifactId>{row.id}</ArtifactId>
                <StatePill {...answer} />
                {row.older ? <StatePill word="Answered under an older revision" shape="half" tone="warning" /> : null}
                {row.retired ? <StatePill word="Retired" shape="superseded" tone="neutral" /> : null}
              </div>
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
            </li>
          );
        })}
      </ul>
    </section>
  );
}
