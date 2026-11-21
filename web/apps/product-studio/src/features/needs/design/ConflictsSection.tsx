import { useRef, useState } from "react";
import { CircleCheck, CircleDot } from "lucide-react";
import { Button, ConfirmDialog, Field, Heading, Quote, RadioGroup, RelativeTime, StatusPill, Text, Textarea, toast } from "@mach/ui";
import { failureText, type DesignConflict, type DesignMap, type DesignSettleAs } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { useOperation } from "../../../api/useOperation";
import { quote } from "../../../shared/lineRanges";
import { againstKind, againstWords, conflictsInOrder, linesWords, oneLine, rangesText, reasonLimit, settleArgs, settleChoices, settleFormProblem, settleWord } from "./model";
import { DesignQuote, WRITING_NOTE_ID } from "./parts";

/** What a conflict names, read from the engine: the need, principle or policy statement it contradicts. */
interface Against {
  label: string;
  text: string | null;
  detail: string | null;
}

/**
 * The lists a conflict's other side comes from, read only when a conflict names one of their kind: `need.list` for a
 * technical need, `principle.list` for a product principle, `policy.list` for a policy statement.
 */
function useAgainst(conflicts: readonly DesignConflict[]): (id: string) => Against {
  const kinds = new Set(conflicts.map((c) => againstKind(c.against)));
  const needs = useOperation("need.list", kinds.has("need") ? {} : null);
  const principles = useOperation("principle.list", kinds.has("principle") ? {} : null);
  const policies = useOperation("policy.list", kinds.has("policy") ? {} : null);
  return (id) => {
    const kind = againstKind(id);
    const label = `${againstWords[kind]} ${id}`;
    if (kind === "need") {
      const need = needs.data?.needs.find((n) => n.need_id === id);
      if (!need) return { label, text: null, detail: needs.loading ? "Reading your technical needs" : null };
      return { label, text: need.statement, detail: `Revision ${need.revision}${need.status === "retired" ? ", retired since" : ""}` };
    }
    if (kind === "principle") {
      const principle = principles.data?.principles.find((p) => p.id === id);
      if (!principle) return { label, text: null, detail: principles.loading ? "Reading your principles" : null };
      return { label, text: principle.statement.replace(/\b(MUST NOT|MUST|SHALL NOT|SHALL|REQUIRED)\b/g, (w) => w.toLowerCase()), detail: principle.title };
    }
    for (const pack of policies.data?.packs ?? []) {
      const statement = pack.statements.find((s) => s.id === id);
      if (statement) return { label, text: statement.text, detail: pack.title ?? pack.id };
    }
    return { label, text: null, detail: policies.loading ? "Reading the policy packs" : null };
  };
}

/**
 * The places where the document contradicts something the product manager already said, each settled on their word
 * alone: the cited lines beside what they contradict, three equal choices (none chosen, none recommended) and their
 * reason. A settled conflict says the choice, the reason, who and when.
 */
export function ConflictsSection({
  designId,
  map,
  lines,
  writing,
  onSettled,
}: {
  designId: string;
  map: DesignMap;
  lines: Map<number, string> | null;
  writing: boolean;
  onSettled: () => void;
}) {
  const against = useAgainst(map.conflicts);
  if (!map.conflicts.length) {
    return (
      <Text size="body-sm" tone="muted" className="max-w-reading">
        The document contradicts none of your technical needs, product principles or policy statements, so there is nothing to settle.
      </Text>
    );
  }
  const waiting = new Set(map.unsettled);
  return (
    <div className="flex flex-col gap-5">
      <Text size="body-sm" tone="muted" className="max-w-reading">
        Where the document contradicts something already said, only you settle it. Your word and your reason are kept with the design for the engineer to read;
        nothing is decided here.
      </Text>
      <ol aria-label={`Conflicts in ${designId}`} className="flex flex-col gap-5">
        {conflictsInOrder(map).map((conflict) => (
          <ConflictItem
            key={conflict.n}
            designId={designId}
            conflict={conflict}
            waiting={waiting.has(conflict.n)}
            against={against(conflict.against)}
            lines={lines}
            writing={writing}
            onSettled={onSettled}
          />
        ))}
      </ol>
    </div>
  );
}

function ConflictItem({
  designId,
  conflict,
  waiting,
  against,
  lines,
  writing,
  onSettled,
}: {
  designId: string;
  conflict: DesignConflict;
  waiting: boolean;
  against: Against;
  lines: Map<number, string> | null;
  writing: boolean;
  onSettled: () => void;
}) {
  const [changing, setChanging] = useState(false);
  const headingId = `conflict-${conflict.n}`;
  const quotations = quote(lines, rangesText(conflict.lines));
  return (
    <li aria-labelledby={headingId} className={waiting ? "flex flex-col gap-4 rounded-md border border-dashed border-line-strong bg-surface px-5 py-4" : "flex flex-col gap-4 rounded-md border border-line bg-surface px-5 py-4"}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Heading level={3} size="title-3" id={headingId}>
          Conflict {conflict.n}
        </Heading>
        {waiting ? (
          <StatusPill tone="warning" icon={<CircleDot aria-hidden="true" />} size="sm" className="border-dashed">
            Waits for your word
          </StatusPill>
        ) : (
          <StatusPill tone="neutral" icon={<CircleCheck aria-hidden="true" />} size="sm">
            Settled: {conflict.settled ? settleWord(conflict.settled) : "not recorded"}
          </StatusPill>
        )}
      </div>
      <p className="max-w-reading text-body-sm text-ink">
        <span className="text-ink-muted">How MACH reads it: </span>
        {conflict.note}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-label text-ink">The design says, {linesWords(conflict.lines)}</p>
          {quotations.length ? <DesignQuote designId={designId} quotations={quotations} /> : <Text size="body-sm" tone="muted">Those lines are not shown here.</Text>}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-label text-ink">It contradicts {against.label}</p>
          {against.text ? (
            <Quote from={against.label} kind={against.detail ?? undefined}>
              {against.text}
            </Quote>
          ) : (
            <Text size="body-sm" tone="muted">
              {against.detail ?? `${against.label} is not among those MACH can read now.`}
            </Text>
          )}
        </div>
      </div>
      {!waiting && !changing ? (
        <SettledRecord conflict={conflict} onChange={() => setChanging(true)} writing={writing} />
      ) : (
        <SettleForm
          designId={designId}
          conflict={conflict}
          writing={writing}
          onCancel={waiting ? null : () => setChanging(false)}
          onSettled={() => {
            setChanging(false);
            onSettled();
          }}
        />
      )}
    </li>
  );
}

/** A settled conflict: the choice, what it means in the engine's words, the reason, who and when. */
function SettledRecord({ conflict, onChange, writing }: { conflict: DesignConflict; onChange: () => void; writing: boolean }) {
  return (
    <div className="flex flex-col gap-4 border-t border-line pt-4">
      <dl className="grid max-w-reading grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-body-sm">
        <dt className="text-ink-muted">Your word</dt>
        <dd className="text-ink">
          {conflict.settled ? settleWord(conflict.settled) : "not recorded"}
          {conflict.settled_means ? <span className="text-ink-muted">: {conflict.settled_means}</span> : null}
        </dd>
        <dt className="text-ink-muted">Settled by</dt>
        <dd className="text-ink">{conflict.by ?? "not recorded"}</dd>
        <dt className="text-ink-muted">When</dt>
        <dd className="text-ink">{conflict.at ? <RelativeTime iso={conflict.at} /> : "not recorded"}</dd>
      </dl>
      {conflict.reason ? (
        <Quote from={conflict.by ?? "The product manager"} kind="gave this reason" className="max-w-reading">
          {conflict.reason}
        </Quote>
      ) : null}
      <div>
        <Button onClick={onChange} disabled={writing} aria-describedby={writing ? WRITING_NOTE_ID : undefined}>
          Settle conflict {conflict.n} differently
        </Button>
      </div>
    </div>
  );
}

/**
 * Settling one conflict. Deliberate departure from the style guide (8.1: "a person's act is the primary button"), as
 * on the verdict: the three choices have exactly equal weight, in one fixed order, none pre-selected, none larger or
 * coloured, and the button that opens the confirmation is secondary, so nothing beside them reads as MACH recommending.
 */
function SettleForm({
  designId,
  conflict,
  writing,
  onCancel,
  onSettled,
}: {
  designId: string;
  conflict: DesignConflict;
  writing: boolean;
  onCancel: (() => void) | null;
  onSettled: () => void;
}) {
  // Nothing is chosen until the product manager chooses.
  const [as, setAs] = useState<DesignSettleAs | null>(null);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<ReturnType<typeof settleFormProblem>>(null);
  const [confirming, setConfirming] = useState(false);
  const act = useEngineAct();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const firstChoiceRef = useRef<HTMLInputElement>(null);
  const line = oneLine(reason);
  const word = as ? settleWord(as) : "";

  const ask = () => {
    const found = settleFormProblem(as, reason);
    setProblem(found);
    if (found) {
      (found.field === "choice" ? firstChoiceRef.current : reasonRef.current)?.focus();
      return;
    }
    act.reset();
    setConfirming(true);
  };

  const settle = async () => {
    if (!as) return false;
    const result = await act.run("design.settle", settleArgs(designId, conflict.n, as, reason));
    if (!result) return false;
    toast({ tone: "success", title: `Settled conflict ${conflict.n}: ${settleWord(result.settled.settled)}`, description: result.note });
    setAs(null);
    setReason("");
    onSettled();
    return true;
  };

  return (
    <form
      noValidate
      aria-label={`Your word on conflict ${conflict.n}`}
      className="flex flex-col gap-5 border-t border-line pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        ask();
      }}
    >
      <RadioGroup
        legend={onCancel ? "Your word now" : "Your word on this conflict"}
        options={settleChoices.map((choice) => ({ value: choice.as, label: choice.word, description: choice.meaning }))}
        value={as}
        onValueChange={(next) => {
          setAs(next);
          if (problem?.field === "choice") setProblem(null);
        }}
        columns={3}
        chosenWord="Chosen"
        error={problem?.field === "choice" ? problem.message : undefined}
        firstRef={firstChoiceRef}
      />
      <Field
        label="Your reason"
        hint={`In your own words, on one line. It is kept with the design and the engineer reads it. ${line.length} of ${reasonLimit} characters.`}
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
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" data-part-act="" disabled={writing} aria-describedby={writing ? WRITING_NOTE_ID : undefined}>
          Settle conflict {conflict.n}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Keep it as it is
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        width="lg"
        open={confirming}
        onOpenChange={setConfirming}
        title={`Settle conflict ${conflict.n} of ${designId}?`}
        description="Your word and your reason are kept with the design and published with it, for the engineer to read. Nothing is decided and no work starts."
        confirmLabel={`Settle conflict ${conflict.n}`}
        cancelLabel="Not now"
        onConfirm={settle}
        error={act.error ? failureText(act.error, `Conflict ${conflict.n} was not settled`) : null}
      >
        <div className="flex flex-col gap-3 rounded-md bg-surface-sunken px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <p className="text-label text-ink">Your word</p>
            <p className="text-body text-ink">{word}</p>
          </div>
          <div className="flex flex-col gap-0.5">
            <p className="text-label text-ink">Your reason, exactly as it will be kept</p>
            <p className="whitespace-pre-wrap break-words text-body text-ink">{line}</p>
          </div>
        </div>
      </ConfirmDialog>
    </form>
  );
}
