import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { CircleAlert, CircleCheck, CircleDashed, CircleHelp, Lock, MessageCircleQuestion, Split } from "lucide-react";
import {
  ArtifactId,
  Banner,
  Button,
  Checkbox,
  CommandLine,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Heading,
  LoadingState,
  StatusPill,
  Text,
  describeError,
  plural,
  toast,
} from "@mach/ui";
import type { PrdAnswer, PrdForSlice, WorkOrder } from "@mach/ui/api";
import { useEngineAct } from "../../api/act";
import { interviewCapability } from "../../api/session";
import { useSession } from "../../api/store";
import { useSliceShow } from "../../api/useSliceShow";
import { Fold } from "../../shared/layout/Fold";
import { SectionNav } from "../../shared/layout/SectionNav";
import { OnePane, WorkPane, WorkPanes, WorkScreen } from "../../shared/layout/WorkScreen";
import { answerGroups, answerSections, confirmArgs, confirmLabel, fencedLines, quote, quotedCount, rangeWords, type AnswerGroups } from "./model";
import { DataNotice, PrdQuote, linesLabel } from "./parts";
import { SliceContextRow } from "../../shared/SliceContextRow";

const about = "The PRD's lines this slice rests on, and the answers drafted from them. Accept them, or set some aside to discuss in the interview.";

/**
 * A slice made from a PRD, as a document in two panes (M16 layout): the lines it rests on and the answers drafted from
 * them, grouped, with a list of the groups beside them. The product manager accepts drafted answers as a group, naming
 * the ones to discuss instead (`prd.confirm`); the act is in the context row so it is in view on arrival. Points the PRD
 * does not settle and contradictions are always asked in the interview and stay apart. `slice.show` carries the PRD
 * part and changes nothing (it does not make this the slice being worked on).
 */
export function SlicePrdScreen() {
  const sliceId = useParams().sliceId ?? "";
  const show = useSliceShow(sliceId);
  const prd = show.data?.prd ?? null;
  const slice = show.data?.slice;

  if (show.data && prd) {
    return (
      <FromPrd
        key={sliceId}
        sliceId={sliceId}
        slice={show.data.slice}
        prd={prd}
        problems={show.data.check.prd_problems ?? []}
        onConfirmed={show.reload}
      />
    );
  }

  let body;
  if (!show.data && show.loading) body = <LoadingState label={`Reading what ${sliceId} was made from`} />;
  else if (!show.data) {
    const shown = show.error ? describeError(show.error) : { title: "Not available right now", message: "" };
    body = (
      <ErrorState
        className="max-w-reading"
        icon={<CircleAlert />}
        title={show.error?.kind === "refused" ? `Could not read ${sliceId}` : shown.title}
        message={shown.message}
        action={<Button onClick={show.reload}>Try again</Button>}
      />
    );
  } else {
    body = (
      <EmptyState
        title="This slice was not made from a PRD"
        description="Its questions are answered in the interview, from nothing."
        action={
          <Button asChild variant="secondary">
            <Link to={`/slices/${sliceId}`}>Open the specification</Link>
          </Button>
        }
      />
    );
  }
  return (
    <WorkScreen header={<SliceContextRow sliceId={sliceId} slice={slice} title="From the PRD" about={about} />}>
      <OnePane label="From the PRD" width="reading">
        {body}
      </OnePane>
    </WorkScreen>
  );
}

function FromPrd({ sliceId, slice, prd, problems, onConfirmed }: { sliceId: string; slice: WorkOrder; prd: PrdForSlice; problems: string[]; onConfirmed: () => void }) {
  const lines = fencedLines(prd.fenced);
  const sliceTitle = slice.title ?? sliceId;
  const [answers, setAnswers] = useState<PrdAnswer[]>(prd.answers?.recorded ?? []);
  const groups = answerGroups(answers);
  const [toDiscuss, setToDiscuss] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState(false);
  const act = useEngineAct();
  const args = confirmArgs(sliceId, groups.waiting, toDiscuss);
  const acceptN = args?.accept?.length ?? 0;
  const discussN = args?.discuss?.length ?? 0;
  const cited = quote(lines, prd.lines);

  const confirm = async () => {
    if (!args) return true;
    const result = await act.run("prd.confirm", args);
    if (!result) return false;
    const parts = [acceptN ? `Accepted ${plural(acceptN, "drafted answer")}` : null, discussN ? `set ${discussN} aside to discuss` : null].filter(Boolean);
    toast({ tone: "success", title: parts.join(" and "), description: result.note });
    setToDiscuss(new Set());
    setAnswers(result.answers);
    onConfirmed();
    return true;
  };

  const title =
    acceptN && discussN
      ? `Accept ${plural(acceptN, "drafted answer")} for “${sliceTitle}” and discuss ${discussN}?`
      : acceptN
        ? `Accept ${plural(acceptN, "drafted answer")} for “${sliceTitle}”?`
        : `Discuss ${discussN === 1 ? "this answer" : `these ${discussN} answers`} in the interview for “${sliceTitle}”?`;

  const action = groups.waiting.length ? (
    <Button
      variant="primary"
      onClick={() => {
        act.reset();
        setOpen(true);
      }}
    >
      {confirmLabel(acceptN, discussN)}
    </Button>
  ) : null;

  return (
    <WorkScreen header={<SliceContextRow sliceId={sliceId} slice={slice} title="From the PRD" about={about} actions={action} />}>
      <WorkPanes>
        <WorkPane label={`${sliceId}, from the PRD`}>
          <div className="flex max-w-[48rem] flex-col gap-10">
            {!prd.document_matches || problems.length ? (
              <div className="flex flex-col gap-4">
                {!prd.document_matches ? (
                  <Banner tone="danger" title="The PRD's copy in your workspace changed">
                    It no longer matches what was imported, so its lines are not shown. Import the document again from Start from a PRD.
                  </Banner>
                ) : null}
                {problems.length ? (
                  <Banner tone="warning" title="Before this slice can be marked ready">
                    <ul className="flex list-disc flex-col gap-1 pl-5">
                      {problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </Banner>
                ) : null}
              </div>
            ) : null}

            <section id="prd-section-lines" aria-labelledby="cited-heading" className="flex scroll-mt-6 flex-col gap-3">
              <Heading level={2} id="cited-heading">
                The lines it rests on
              </Heading>
              {lines && quotedCount(cited) ? (
                <Fold label={`${linesLabel(prd.lines)} of ${prd.prd_id}`}>
                  <PrdQuote prdId={prd.prd_id} quotations={cited} />
                </Fold>
              ) : (
                <Text tone="muted">{prd.document_matches ? "The lines could not be read." : "Not shown while the copy does not match."}</Text>
              )}
              {prd.truncated ? <Text size="body-sm" tone="muted">Only the first part of these lines is shown.</Text> : null}
            </section>

            <Answers sliceId={sliceId} prd={prd} lines={lines} groups={groups} toDiscuss={toDiscuss} setToDiscuss={setToDiscuss} total={answers.length} actLabel={confirmLabel(acceptN, discussN)} />

            {prd.why_line ? (
              <Fold boxed label="The line its why must carry">
                <p className="mb-2 text-body-sm text-ink-muted">The interview writes this line into the slice's why, so the builders can find the PRD by its ID, hash and lines. It holds none of the PRD's text.</p>
                <code className="block break-all font-mono text-mono text-ink" translate="no">
                  {prd.why_line}
                </code>
              </Fold>
            ) : null}
          </div>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title={title}
            description="An accepted answer is settled and is not asked again. Answers set aside, points the PRD does not settle and contradictions are asked in the interview, one at a time. The specification and the why are still written there and checked as always."
            confirmLabel={confirmLabel(acceptN, discussN)}
            cancelLabel="Not yet"
            onConfirm={confirm}
            error={act.shown ? { ...act.shown, title: act.error?.kind === "refused" ? "Nothing was recorded" : act.shown.title } : null}
          >
            <div className="flex flex-col gap-3 text-body-sm">
              {acceptN ? (
                <div className="flex flex-col gap-1">
                  <p className="font-semibold text-ink">Accept</p>
                  <ul className="flex flex-col gap-1 text-ink">
                    {groups.waiting
                      .filter((a) => args?.accept?.includes(a.n))
                      .map((a) => (
                        <li key={a.n}>
                          {a.n}. {a.question}
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}
              {discussN ? (
                <div className="flex flex-col gap-1">
                  <p className="font-semibold text-ink">Discuss in the interview</p>
                  <ul className="flex flex-col gap-1 text-ink">
                    {groups.waiting
                      .filter((a) => args?.discuss?.includes(a.n))
                      .map((a) => (
                        <li key={a.n}>
                          {a.n}. {a.question}
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </ConfirmDialog>
        </WorkPane>
        <WorkPane side label="Sections and where it came from">
          <Aside prd={prd} groups={groups} />
        </WorkPane>
      </WorkPanes>
    </WorkScreen>
  );
}

/** The narrow pane: the page's sections with their counts, where the slice came from, and where the PRD's text goes. */
function Aside({ prd, groups }: { prd: PrdForSlice; groups: AnswerGroups }) {
  const drafted = groups.accepted.length + groups.waiting.length + groups.discuss.length;
  return (
    <div className="flex flex-col gap-8">
      <SectionNav
        label="Sections of this page"
        items={[
          { id: "prd-section-lines", label: "The lines it rests on" },
          ...answerSections(groups).map((s) => ({
            id: `prd-section-${s.id}`,
            label: s.label,
            note: <span className="shrink-0 text-caption font-semibold text-ink-muted tabular">{s.count}</span>,
          })),
        ]}
      />
      <section aria-labelledby="made-from-heading" className="flex flex-col gap-2">
        <Heading level={2} size="title-3" id="made-from-heading">
          Made from
        </Heading>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-ink">
          <Link to={`/prds/${prd.prd_id}`} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
            {prd.prd_id}
          </Link>
          <span className="text-ink-muted">
            map slice <ArtifactId plain>{prd.map_slice}</ArtifactId>, {linesLabel(prd.lines).toLowerCase()}
          </span>
        </p>
        {prd.scope ? <Text size="body-sm">{prd.scope}</Text> : null}
        {drafted ? (
          <p className="text-body-sm text-ink-muted tabular">
            {groups.accepted.length} of {plural(drafted, "drafted answer")} accepted
          </p>
        ) : null}
      </section>
      <DataNotice />
    </div>
  );
}

function Answers({
  sliceId,
  prd,
  lines,
  groups,
  toDiscuss,
  setToDiscuss,
  total,
  actLabel,
}: {
  /** The words of the page's act in the context row, which accepts the waiting answers not ticked. */
  actLabel: string;
  sliceId: string;
  prd: PrdForSlice;
  lines: Map<number, string> | null;
  groups: AnswerGroups;
  toDiscuss: Set<number>;
  setToDiscuss: (update: (current: Set<number>) => Set<number>) => void;
  total: number;
}) {
  return (
    <section aria-labelledby="answers-heading" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Heading level={2} id="answers-heading">
          Drafted answers
        </Heading>
        {total ? (
          <Text size="body-sm" tone="muted" className="max-w-reading">
            {groups.accepted.length} of {plural(groups.accepted.length + groups.waiting.length + groups.discuss.length, "drafted answer")} accepted. An accepted answer is settled
            and is not asked again; everything else is asked in the interview, one question at a time.
          </Text>
        ) : null}
      </div>

      {!total ? <NoDrafts sliceId={sliceId} /> : null}

      {groups.waiting.length ? (
        <section id="prd-section-waiting" aria-labelledby="waiting-heading" className="flex scroll-mt-6 flex-col gap-3">
          <Heading level={3} size="title-3" id="waiting-heading">
            Waiting for your word
          </Heading>
          <Text size="body-sm" tone="muted">
            Tick any you would rather discuss in the interview instead. The rest are accepted together with “{actLabel}”, the button at the top of
            the page beside the slice's name; its words change as you tick.
          </Text>
          <ol className="flex flex-col gap-3">
            {groups.waiting.map((a) => (
              <AnswerCard key={a.n} prdId={prd.prd_id} answer={a} lines={lines}>
                <Checkbox
                  checked={toDiscuss.has(a.n)}
                  onCheckedChange={(checked) =>
                    setToDiscuss((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(a.n);
                      else next.delete(a.n);
                      return next;
                    })
                  }
                  label={`Discuss answer ${a.n} in the interview instead`}
                />
              </AnswerCard>
            ))}
          </ol>
        </section>
      ) : null}

      {groups.alwaysAsked.length ? (
        <section
          id="prd-section-always"
          aria-labelledby="always-heading"
          className="flex scroll-mt-6 flex-col gap-3 rounded-md border border-dashed border-line-strong bg-surface-sunken px-5 py-4"
        >
          <Heading level={3} size="title-3" id="always-heading" className="flex items-center gap-2">
            <Lock aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
            Always asked in the interview
          </Heading>
          <Text size="body-sm" tone="muted">
            The PRD does not settle these, or says two different things. They cannot be accepted here: the interviewer asks you each one, quoting the PRD.
          </Text>
          <ol className="flex flex-col gap-3">
            {groups.alwaysAsked.map((a) => (
              <AnswerCard key={a.n} prdId={prd.prd_id} answer={a} lines={lines}>
                <p className="flex items-center gap-1.5 text-body-sm text-ink-muted">
                  <Lock aria-hidden="true" className="size-4 shrink-0" />
                  Cannot be accepted here
                </p>
              </AnswerCard>
            ))}
          </ol>
        </section>
      ) : null}

      {groups.accepted.length || groups.discuss.length ? (
        <section id="prd-section-word" aria-labelledby="word-heading" className="flex scroll-mt-6 flex-col gap-3">
          <Heading level={3} size="title-3" id="word-heading">
            Your word so far
          </Heading>
          <ol className="flex flex-col gap-3">
            {[...groups.accepted, ...groups.discuss]
              .sort((x, y) => x.n - y.n)
              .map((a) => (
                <AnswerCard key={a.n} prdId={prd.prd_id} answer={a} lines={lines} />
              ))}
          </ol>
        </section>
      ) : null}
    </section>
  );
}

/** As built, the app's interview cannot draft answers: they are drafted from Claude Code. Never faked here. */
function NoDrafts({ sliceId }: { sliceId: string }) {
  const session = useSession();
  const capability = session.data ? interviewCapability(session.data) : null;
  const command = capability?.continueCommand ? `${capability.continueCommand} ${sliceId}` : null;
  return (
    <EmptyState
      icon={<MessageCircleQuestion />}
      headingLevel={3}
      title="No drafted answers yet"
      description="Answers are drafted from the PRD's lines in Claude Code for now: the interview in Product Studio cannot write them yet. Continue this slice there with the product studio skill and ask it to draft answers from the PRD; they then appear here for you to accept. You can also interview this slice from nothing."
      action={command ? <CommandLine command={command} purpose={`to continue ${sliceId} in Claude Code`} className="max-w-md" /> : undefined}
    />
  );
}

const kindLook: Record<PrdAnswer["kind"], { icon: ReactNode; tone: "neutral" | "warning" | "info" }> = {
  drafted: { icon: <CircleHelp aria-hidden="true" />, tone: "neutral" },
  not_settled: { icon: <CircleHelp aria-hidden="true" />, tone: "info" },
  contradiction: { icon: <Split aria-hidden="true" />, tone: "warning" },
};

const stateLook: Record<PrdAnswer["state"], { word: string; icon: ReactNode; tone: "neutral" | "success" | "info" }> = {
  pending: { word: "Waiting for your word", icon: <CircleDashed aria-hidden="true" />, tone: "neutral" },
  accepted: { word: "Accepted", icon: <CircleCheck aria-hidden="true" />, tone: "success" },
  discuss: { word: "To discuss in the interview", icon: <MessageCircleQuestion aria-hidden="true" />, tone: "info" },
};

/** One drafted answer: the question in plain words, the drafted answer (or why there is none), and its citation folded. */
function AnswerCard({ prdId, answer, lines, children }: { prdId: string; answer: PrdAnswer; lines: Map<number, string> | null; children?: ReactNode }) {
  const look = kindLook[answer.kind];
  const quotations = quote(lines, answer.cites);
  const where = quotations.map((q) => rangeWords(q.range)).join(" and ");
  return (
    <li className="flex flex-col gap-2.5 rounded-md border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-64 text-body font-semibold text-ink">
          <span className="text-ink-subtle tabular">{answer.n}.</span> {answer.question}
        </p>
        <div className="flex flex-wrap gap-2">
          {answer.kind !== "drafted" ? (
            <StatusPill tone={look.tone} icon={look.icon} size="sm" className="border-dashed">
              {answer.kind_words}
            </StatusPill>
          ) : null}
          <StatusPill tone={stateLook[answer.state].tone} icon={stateLook[answer.state].icon} size="sm">
            {stateLook[answer.state].word}
          </StatusPill>
        </div>
      </div>
      {answer.answer !== null ? (
        <p className="text-body text-ink">
          <span className="text-ink-muted">Drafted answer: </span>
          {answer.answer}
        </p>
      ) : (
        <p className="text-body-sm text-ink-muted">
          {answer.kind === "contradiction" ? "No drafted answer: the PRD says different things in the places quoted below." : "No drafted answer: the PRD does not settle this."}
        </p>
      )}
      {quotations.length ? (
        <Fold label={answer.kind === "contradiction" ? `The places that disagree: ${where}` : `Rests on ${where}`}>
          <PrdQuote prdId={prdId} quotations={quotations} />
        </Fold>
      ) : null}
      {children}
    </li>
  );
}
