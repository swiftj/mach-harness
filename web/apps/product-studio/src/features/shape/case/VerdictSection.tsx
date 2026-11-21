import { useRef, useState } from "react";
import { Link } from "react-router";
import { Route } from "lucide-react";
import { Banner, Button, ConfirmDialog, Field, Quote, RadioGroup, RelativeTime, Text, Textarea, toast } from "@mach/ui";
import { failureText, type IdeaRow, type IdeaShow, type VerdictDecision, type VerdictRecorded } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { Fold } from "../../../shared/layout/Fold";
import { ideaPath } from "../shell/steps";
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

/** Where focus goes once the form that opened the confirmation has closed: the verdict part's own row. */
const verdictHeading = () => document.getElementById("verdict-part")?.closest("li")?.querySelector<HTMLElement>("button") ?? null;

/**
 * The body of the verdict part: the verdict, the product manager's alone. The part's row is its heading.
 *
 * Deliberate departure from the style guide (7.2, 8.1: "a person's main act is the primary button"): the three
 * choices have exactly equal weight, in a fixed order, none pre-selected, none larger or coloured, none a primary
 * button; the chosen one is shown by a heavier ink outline and the word "Chosen". The button that opens the
 * confirmation is secondary too, so no accent sits beside the choices. A primary button here would read as MACH
 * recommending. The dialog's confirming button is the same for every decision.
 */
export function VerdictSection({ row, show, onRecorded }: { row: IdeaRow; show: IdeaShow; onRecorded: () => void }) {
  const state = verdictState(show.verdict);
  // Whether any verdict may be recorded now, in the engine's own answer (refused once the idea is shaped into work).
  const shaped = !show.acts.verdict.allowed;
  const [replacing, setReplacing] = useState(false);
  const [lastRecorded, setLastRecorded] = useState<VerdictRecorded | null>(null);

  const formOpen = !shaped && (state.kind !== "holds" || replacing);

  return (
    <div id="verdict-part" className="flex flex-col gap-5">
      {/* With no verdict yet, the engine's note is the part's own summary, in the row just above. */}
      {state.kind !== "none" ? (
        <Text size="body-sm" tone="muted" className="max-w-reading">
          {show.verdict_note}
        </Text>
      ) : null}

      {lastRecorded?.recorded_without_github ? (
        <Banner tone="warning" title="Recorded without a GitHub name">
          {lastRecorded.why_no_login ?? "Nobody was signed in to GitHub on this computer."} {lastRecorded.note}
        </Banner>
      ) : null}

      {state.kind !== "none" ? <RecordedVerdict verdict={state.verdict} stale={state.kind === "stale"} ideaId={row.idea_id} /> : null}

      {shaped ? (
        <Text size="body-sm" tone="muted" className="max-w-reading">
          {show.acts.verdict.why}
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
    </div>
  );
}

/** A verdict already recorded: who, when, their reason quoted, the brief it was for, and whether it still holds. */
function RecordedVerdict({ verdict, stale, ideaId }: { verdict: NonNullable<IdeaShow["verdict"]>; stale: boolean; ideaId: string }) {
  const consequence = verdictConsequence(verdict.decision);
  // The decision and whether it holds are the part's pills, in its row just above; the body says who, when and why.
  const details = (
    <div className="flex flex-col gap-4">
      <dl className="grid max-w-reading grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-body-sm">
        {stale ? (
          // Folded away under a new verdict, the old decision is said again here; while it holds, it is the row's pill.
          <>
            <dt className="text-ink-muted">Decision</dt>
            <dd className="text-ink">{decisionWord(verdict.decision)}</dd>
          </>
        ) : null}
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
    </div>
  );
  if (stale)
    return (
      <div className="flex flex-col gap-3">
        <Banner tone="warning" title="This verdict no longer holds">
          {verdict.stale_note ?? "The brief changed after this verdict was recorded."} Ask yourself again, and record the verdict on the brief as it is now.
        </Banner>
        {/* The old verdict is reference now: the act is a new verdict, so who gave the old one and why fold away. */}
        <Fold label={`The verdict recorded before: ${decisionWord(verdict.decision)}, with its reason`}>{details}</Fold>
      </div>
    );
  return (
    <div className="flex flex-col gap-4">
      {details}
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
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const firstChoiceRef = useRef<HTMLInputElement>(null);

  const ask = () => {
    const found = verdictFormProblem(decision, reason, show.acts.go.allowed ? null : show.acts.go.why);
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
      aria-label="Your verdict"
      // Replacing a verdict that holds: a rule sets the new verdict apart from the one recorded above it.
      className={onCancel ? "flex flex-col gap-5 border-t border-line pt-5" : "flex flex-col gap-5"}
      onSubmit={(event) => {
        event.preventDefault();
        ask();
      }}
    >
      <RadioGroup
        legend={replacing ? "Your verdict now" : "Choose your verdict"}
        options={verdictChoices.map((choice) => ({ value: choice.decision, label: choice.word, description: choice.meaning }))}
        value={decision}
        onValueChange={(next) => {
          setDecision(next);
          if (problem?.field === "choice") setProblem(null);
        }}
        columns={3}
        chosenWord="Chosen"
        error={problem?.field === "choice" ? problem.message : undefined}
        describedBy="verdict-recorded-with"
        firstRef={firstChoiceRef}
      />

      <Field
        label="Your reason"
        hint={`In your own words, on one line. It is kept with the verdict and shown wherever the verdict is. ${line.length} of ${reasonLimit} characters.`}
        error={problem?.field === "reason" ? problem.message : undefined}
        className="max-w-reading"
      >
        <Textarea
          ref={reasonRef}
          editorial
          rows={2}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            if (problem?.field === "reason") setProblem(null);
          }}
        />
      </Field>

      {/* The sentence, then the act beside it on one row: said before the click, and the act in view with the choices. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Text id="verdict-recorded-with" size="body-sm" tone="muted" className="min-w-0 max-w-reading flex-1 basis-80 whitespace-pre-line">
          {recordedWithSentence(show.brief.revision, show.brief.changed_since_check)}
          {/* Said before the click, in the engine's own words; Go stays one of three equal choices. */}
          {show.acts.go.allowed ? null : `\n${show.acts.go.why ?? ""}`}
        </Text>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit">Record the verdict</Button>
          {onCancel ? (
            <Button variant="ghost" onClick={onCancel}>
              Keep the verdict as it is
            </Button>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        width="lg"
        open={confirming}
        onOpenChange={setConfirming}
        title={`Record “${word}” for ${row.idea_id}?`}
        description={show.verdict_note}
        confirmLabel={`Record “${word}”`}
        onConfirm={record}
        error={act.error ? failureText(act.error, "The verdict was not recorded") : null}
        focusAfter={focusAfter}
      >
        <div className="flex flex-col gap-4 pb-1">
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
        </div>
      </ConfirmDialog>
    </form>
  );
}
