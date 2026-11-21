import { useRef, useState } from "react";
import { ArtifactId, Button, ConfirmDialog, Field, Quote, RadioGroup, RelativeTime, StateGlyph, StatusPill, Text, Textarea, cn, toast } from "@mach/ui";
import { failureText, type IdeaGithubView, type MachApiError } from "@mach/ui/api";
import { client } from "../../../api/client";
import { toApiError } from "../../../api/session";
import { IssueLink } from "../../../shared/IssueLink";
import {
  NOTE_LIMIT,
  confirmWords,
  emptyDraft,
  oneLine,
  recordArgs,
  resultChoices,
  resultLook,
  savedWhere,
  type LookbackArgs,
  type LookbackItem,
  type RecordDraft,
} from "./model";

/**
 * The act on one outcome or assumption, inside its part (M16 layout): once the engine allows it, the three-way record.
 * The part's row is the item's heading and says its result; what is already recorded (who, when, the note) is beside
 * the parts. Nothing is chosen for the person, the three choices look alike, and each record is its own act, confirmed
 * in a dialog that repeats the result and the note. `partRow` is the part's own row, where focus returns.
 */
export function RecordItem({
  ideaId,
  item,
  open,
  onRecorded,
  partRow,
}: {
  ideaId: string;
  item: LookbackItem;
  /** The engine allows recording now. */
  open: boolean;
  onRecorded: () => Promise<void>;
  partRow: () => HTMLElement | null;
}) {
  const [editing, setEditing] = useState(false);
  const showForm = open && item.recordable && (item.entry === null || editing);
  if (!item.recordable)
    return (
      <Text size="body-sm" tone="muted">
        This outcome is no longer in the brief, so a look back cannot be recorded on it.
      </Text>
    );
  if (showForm)
    return (
      <RecordForm
        ideaId={ideaId}
        item={item}
        again={item.entry !== null}
        onCancel={item.entry ? () => setEditing(false) : null}
        onDone={async () => {
          await onRecorded();
          setEditing(false);
        }}
        focusAfter={partRow}
      />
    );
  if (open && item.entry)
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button size="sm" onClick={() => setEditing(true)}>
          Record {item.id} again
        </Button>
        <Text size="body-sm" tone="muted">
          What is recorded now, with your note, is under “What you saw so far”.
        </Text>
      </div>
    );
  return null;
}

/** What is already recorded: the result as a word and a shape, the note quoted with who wrote it and when, where it is saved. */
export function Recorded({ id, entry, github }: { id: string; entry: NonNullable<LookbackItem["entry"]>; github: IdeaGithubView | null }) {
  const look = resultLook(entry.result);
  const saved = savedWhere(entry, github);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ArtifactId className="text-body-sm">{id}</ArtifactId>
        <StatusPill tone="neutral" icon={<StateGlyph shape={look.glyph} />}>
          {look.word}
        </StatusPill>
      </div>
      <Quote
        from="Product manager"
        kind={
          <>
            {entry.by ? (
              <>
                signed in as{" "}
                <span translate="no" className="font-mono">
                  {entry.by}
                </span>
                ,{" "}
              </>
            ) : (
              "with nobody signed in to GitHub, "
            )}
            <RelativeTime iso={entry.at} />
          </>
        }
      >
        {entry.note}
      </Quote>
      <Text size="body-sm" tone="muted">
        {saved.onIssue !== null ? (
          <>
            {saved.words} <IssueLink number={saved.onIssue} url={saved.url} />.
          </>
        ) : (
          saved.words
        )}
      </Text>
    </div>
  );
}

function RecordForm({
  ideaId,
  item,
  again,
  onCancel,
  onDone,
  focusAfter,
}: {
  ideaId: string;
  item: LookbackItem;
  again: boolean;
  onCancel: (() => void) | null;
  onDone: () => Promise<void>;
  focusAfter: () => HTMLElement | null;
}) {
  const [draft, setDraft] = useState<RecordDraft>(emptyDraft);
  const [problems, setProblems] = useState<{ result?: string; note?: string }>({});
  const [confirming, setConfirming] = useState<LookbackArgs | null>(null);
  const firstChoice = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const choices = resultChoices[item.kind];

  const check = () => {
    const built = recordArgs(ideaId, item.kind, item.id, draft);
    if (built.args) {
      setProblems({});
      setConfirming(built.args);
      return;
    }
    setProblems(built.problems);
    if (built.problems.result) firstChoice.current?.focus();
    else noteRef.current?.focus();
  };

  const length = oneLine(draft.note).trim().length;
  return (
    <div className="flex max-w-reading flex-col gap-4 rounded-md border border-line bg-surface px-4 py-4">
      <RadioGroup
        legend={
          <>
            Your look back on <span translate="no">{item.id}</span>
          </>
        }
        hint={`${again ? "Recording again replaces the result recorded before. " : ""}Choose the one that matches what you saw. Nothing is chosen for you.`}
        layout="chips"
        options={choices.map((choice) => ({ value: choice.value, label: choice.word, icon: <StateGlyph shape={choice.glyph} /> }))}
        value={draft.result}
        onValueChange={(result) => {
          setDraft((d) => ({ ...d, result }));
          setProblems((p) => ({ ...p, result: undefined }));
        }}
        error={problems.result}
        firstRef={firstChoice}
      />
      <Field
        label="Your note"
        hint={`What you saw, in your own words. One line, up to ${NOTE_LIMIT} characters. It is shared on the idea's issue where the idea has one.`}
        error={problems.note}
      >
        <Textarea
          ref={noteRef}
          rows={2}
          value={draft.note}
          onChange={(event) => {
            const note = oneLine(event.target.value);
            setDraft((d) => ({ ...d, note }));
            setProblems((p) => ({ ...p, note: undefined }));
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={check}>Record the look back on {item.id}</Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Keep it as it is
          </Button>
        ) : null}
        <span className={cn("ml-auto text-caption tabular", length > NOTE_LIMIT ? "text-danger-ink" : "text-ink-subtle")}>
          {length} of {NOTE_LIMIT} characters
        </span>
      </div>
      <RecordDialog
        args={confirming}
        item={item}
        onClose={() => setConfirming(null)}
        onRecorded={async () => {
          setDraft(emptyDraft());
          await onDone();
        }}
        focusAfter={focusAfter}
      />
    </div>
  );
}

/** The act itself: repeats the result and the note, and keeps a refusal in the dialog in the engine's words. */
function RecordDialog({
  args,
  item,
  onClose,
  onRecorded,
  focusAfter,
}: {
  args: LookbackArgs | null;
  item: LookbackItem;
  onClose: () => void;
  onRecorded: () => Promise<void>;
  focusAfter: () => HTMLElement | null;
}) {
  const [error, setError] = useState<MachApiError | null>(null);
  const words = args ? confirmWords(item.kind, item.id, args.result) : null;
  const look = args ? resultLook(args.result) : null;

  const record = async (): Promise<boolean> => {
    if (!args) return false;
    setError(null);
    try {
      const result = await client.op("lookback.record", args);
      toast({ tone: "success", title: `Recorded the look back on ${result.item}`, description: result.note });
      // The form is gone once the act is done: focus goes to the item's heading (focusAfter).
      void onRecorded();
      return true;
    } catch (cause) {
      setError(toApiError(cause, "lookback.record"));
      return false;
    }
  };

  return (
    <ConfirmDialog
      width="lg"
      open={args !== null}
      onOpenChange={(next) => {
        if (next) return;
        setError(null);
        onClose();
      }}
      title={words?.title ?? ""}
      description={words?.description ?? ""}
      confirmLabel="Record the look back"
      onConfirm={record}
      error={error ? failureText(error, "The look back was not recorded") : null}
      focusAfter={focusAfter}
    >
      {args && look ? (
        <div className="flex flex-col gap-4 pb-1">
          <div className="flex flex-col gap-3 rounded-md bg-surface-sunken px-4 py-3">
            <p className="text-label text-ink">
              Your look back on <span translate="no">{item.id}</span>
            </p>
            <div>
              <StatusPill tone="neutral" icon={<StateGlyph shape={look.glyph} />}>
                {look.word}
              </StatusPill>
            </div>
            <blockquote className="border-l-2 border-line-strong pl-4 text-body italic text-ink">{args.note}</blockquote>
          </div>
          {item.entry ? (
            <Text size="body-sm" tone="muted">
              It replaces {resultLook(item.entry.result).word}, recorded <RelativeTime iso={item.entry.at} />.
            </Text>
          ) : null}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
