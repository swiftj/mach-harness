import { useId, useRef, useState } from "react";
import { Link } from "react-router";
import { CircleAlert, Route, Scale, TriangleAlert } from "lucide-react";
import { Banner, Button, Field, Heading, Quote, RelativeTime, StatusPill, Text, Textarea, cn, toast } from "@mach/ui";
import { failureText, type IdeaRow, type IdeaShow, type VerdictDecision, type VerdictRecorded } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { ideaPath } from "../shell/steps";
import { ActDialog } from "./ActDialog";
import {
  decisionWord,
  oneLine,
  reasonLimit,
  recordedWithSentence,
  verdictArgs,
  verdictChoices,
  verdictConsequence,
  verdictFor,
  verdictFormProblem,
  verdictState,
} from "./model";

/** Where focus goes once the form that opened the confirmation has closed. */
const verdictHeading = () => document.getElementById("verdict-h");

/**
 * Part 3: the verdict, the product manager's alone.
 *
 * Deliberate departure from the style guide (7.2, 8.1: "a person's main act is the primary button"): the three
 * choices have exactly equal weight, in a fixed order, none pre-selected, none larger or coloured, none a primary
 * button; the chosen one is shown by a heavier ink outline and the word "Chosen". The button that opens the
 * confirmation is secondary too, so no accent sits beside the choices. A primary button here would read as MACH
 * recommending. The dialog's confirming button is the same for every decision.
 */
export function VerdictSection({ row, show, onRecorded }: { row: IdeaRow; show: IdeaShow; onRecorded: () => void }) {
  const state = verdictState(show.verdict);
  const shaped = row.stage === "shaped";
  const [replacing, setReplacing] = useState(false);
  const [lastRecorded, setLastRecorded] = useState<VerdictRecorded | null>(null);

  const formOpen = !shaped && (state.kind !== "holds" || replacing);

  return (
    <section aria-labelledby="verdict-h" className="flex flex-col gap-5 rounded-md border border-line bg-surface px-6 py-5">
      <div className="flex flex-col gap-1.5">
        <Heading level={2} size="title-2" id="verdict-h" tabIndex={-1} className="focus-visible:outline-none">
          Your verdict
        </Heading>
        <Text size="body-sm" tone="muted" className="max-w-reading">
          {show.verdict_note}
        </Text>
      </div>

      {lastRecorded?.recorded_without_github ? (
        <Banner tone="warning" title="Recorded without a GitHub name">
          {lastRecorded.why_no_login ?? "Nobody was signed in to GitHub on this computer."} {lastRecorded.note}
        </Banner>
      ) : null}

      {state.kind !== "none" ? <RecordedVerdict verdict={state.verdict} stale={state.kind === "stale"} ideaId={row.idea_id} /> : null}

      {shaped ? (
        <Text size="body-sm" tone="muted" className="max-w-reading">
          This idea is shaped into work, so its verdict stays as it is.
        </Text>
      ) : formOpen ? (
        <VerdictForm
          row={row}
          show={show}
          replacing={state.kind !== "none"}
          onCancel={state.kind === "holds" ? () => setReplacing(false) : null}
          focusAfter={verdictHeading}
          onRecorded={(result) => {
            setReplacing(false);
            setLastRecorded(result);
            onRecorded();
          }}
        />
      ) : (
        <div>
          <Button onClick={() => setReplacing(true)}>Record a different verdict</Button>
        </div>
      )}
    </section>
  );
}

/** A verdict already recorded: who, when, their reason quoted, the brief it was for, and whether it still holds. */
function RecordedVerdict({ verdict, stale, ideaId }: { verdict: NonNullable<IdeaShow["verdict"]>; stale: boolean; ideaId: string }) {
  const consequence = verdictConsequence(verdict.decision);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill icon={<Scale aria-hidden="true" />}>{decisionWord(verdict.decision)}</StatusPill>
        {stale ? (
          <StatusPill tone="warning" icon={<TriangleAlert aria-hidden="true" />} className="border-dashed">
            No longer holds
          </StatusPill>
        ) : null}
      </div>
      <dl className="grid max-w-reading grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-body-sm">
        <dt className="text-ink-muted">Recorded by</dt>
        <dd className="text-ink">
          {verdict.by ? (
            <span translate="no" className="font-mono">
              {verdict.by}
            </span>
          ) : (
            "Not recorded: nobody was signed in to GitHub"
          )}
        </dd>
        <dt className="text-ink-muted">When</dt>
        <dd className="text-ink">
          <RelativeTime iso={verdict.at} />
        </dd>
        <dt className="text-ink-muted">For</dt>
        <dd className="text-ink">{verdictFor(verdict)}</dd>
      </dl>
      {verdict.reason ? (
        <Quote from={verdict.by ?? "The product manager"} kind="gave this reason" className="max-w-reading">
          <span className="whitespace-pre-wrap">{verdict.reason}</span>
        </Quote>
      ) : null}
      {stale ? (
        <Banner tone="warning" title="This verdict no longer holds">
          {verdict.stale_note ?? "The brief changed after this verdict was recorded."} Ask yourself again, and record the verdict on the brief as it is now.
        </Banner>
      ) : (
        <div className="flex max-w-reading flex-col gap-3">
          <Text size="body-sm">{consequence.sentence}</Text>
          {consequence.wayOn === "route" ? (
            <div>
              <Button asChild>
                <Link to={ideaPath(ideaId, "route")}>
                  <Route aria-hidden="true" />
                  Go to Size and route
                </Link>
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function VerdictForm({
  row,
  show,
  replacing,
  onCancel,
  focusAfter,
  onRecorded,
}: {
  row: IdeaRow;
  show: IdeaShow;
  replacing: boolean;
  onCancel: (() => void) | null;
  focusAfter: () => HTMLElement | null;
  onRecorded: (result: VerdictRecorded) => void;
}) {
  // Nothing is chosen until the product manager chooses.
  const [decision, setDecision] = useState<VerdictDecision | null>(null);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<ReturnType<typeof verdictFormProblem>>(null);
  const [confirming, setConfirming] = useState(false);
  const act = useEngineAct();
  const name = useId();
  const choicesError = useId();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const firstChoiceRef = useRef<HTMLInputElement>(null);

  const ask = () => {
    const found = verdictFormProblem(decision, reason);
    setProblem(found);
    if (found) {
      (found.field === "choice" ? firstChoiceRef.current : reasonRef.current)?.focus();
      return;
    }
    act.reset();
    setConfirming(true);
  };

  const record = async () => {
    if (!decision) return false;
    const result = await act.run("verdict.record", verdictArgs(row.idea_id, decision, reason));
    if (!result) return false;
    toast({ tone: "success", title: `Recorded the verdict: ${decisionWord(result.verdict.decision)}`, description: result.note });
    setDecision(null);
    setReason("");
    onRecorded(result);
    return true;
  };

  const line = oneLine(reason);
  const word = decision ? decisionWord(decision) : "";

  return (
    <form
      noValidate
      aria-labelledby="verdict-h"
      className="flex flex-col gap-5 border-t border-line pt-5"
      onSubmit={(event) => {
        event.preventDefault();
        ask();
      }}
    >
      <fieldset className="flex flex-col gap-2" aria-describedby={problem?.field === "choice" ? `${choicesError} verdict-recorded-with` : "verdict-recorded-with"}>
        <legend className="pb-1 text-label text-ink">{replacing ? "Your verdict now" : "Choose your verdict"}</legend>
        <div className="grid grid-cols-3 gap-3">
          {verdictChoices.map((choice, index) => {
            const chosen = decision === choice.decision;
            return (
              <label
                key={choice.decision}
                className={cn(
                  "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 rounded-md border border-line-control bg-surface px-4 py-3 hover:bg-surface-sunken",
                  "has-[:checked]:border-ink has-[:checked]:ring-1 has-[:checked]:ring-inset has-[:checked]:ring-ink",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
                )}
              >
                <input
                  ref={index === 0 ? firstChoiceRef : undefined}
                  type="radio"
                  name={name}
                  value={choice.decision}
                  checked={chosen}
                  onChange={() => {
                    setDecision(choice.decision);
                    if (problem?.field === "choice") setProblem(null);
                  }}
                  className="row-span-2 mt-1 size-4 shrink-0 accent-ink focus-visible:outline-none"
                />
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-body font-semibold text-ink">{choice.word}</span>
                  {chosen ? <span className="text-caption font-semibold text-ink">Chosen</span> : null}
                </span>
                <span className="text-body-sm text-ink-muted">{choice.meaning}</span>
              </label>
            );
          })}
        </div>
        {problem?.field === "choice" ? (
          <p id={choicesError} className="flex items-start gap-1.5 text-body-sm text-danger-ink">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{problem.message}</span>
          </p>
        ) : null}
      </fieldset>

      <Field
        label="Your reason"
        hint={`In your own words, on one line. It is kept with the verdict and shown wherever the verdict is. ${line.length} of ${reasonLimit} characters.`}
        error={problem?.field === "reason" ? problem.message : undefined}
        className="max-w-reading"
      >
        <Textarea
          ref={reasonRef}
          editorial
          rows={3}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            if (problem?.field === "reason") setProblem(null);
          }}
        />
      </Field>

      <Text id="verdict-recorded-with" size="body-sm" tone="muted" className="max-w-reading">
        {recordedWithSentence(show.brief.revision, show.brief.changed_since_check)}
      </Text>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit">Record the verdict</Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Keep the verdict as it is
          </Button>
        ) : null}
      </div>

      <ActDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Record “${word}” for ${row.idea_id}?`}
        description={show.verdict_note}
        confirmLabel={`Record “${word}”`}
        onConfirm={record}
        error={act.error ? failureText(act.error, "The verdict was not recorded") : null}
        focusAfter={focusAfter}
      >
        <div className="flex flex-col gap-3 rounded-md bg-surface-sunken px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <p className="text-label text-ink">Your decision</p>
            <p className="text-body text-ink">{word}</p>
          </div>
          <div className="flex flex-col gap-0.5">
            <p className="text-label text-ink">Your reason, exactly as it will be kept</p>
            <p className="whitespace-pre-wrap break-words text-body text-ink">{line}</p>
          </div>
        </div>
        <Text size="body-sm" tone="muted">
          {recordedWithSentence(show.brief.revision, show.brief.changed_since_check)}
          {replacing ? " It replaces the verdict recorded before." : ""}
        </Text>
      </ActDialog>
    </form>
  );
}
