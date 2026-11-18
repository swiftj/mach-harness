import { useState } from "react";
import { useNavigate } from "react-router";
import { MessageCircleQuestion } from "lucide-react";
import { Button, ConfirmDialog, RelativeTime, Text, toast, type SliceGithub } from "@mach/ui";
import { failureText } from "@mach/ui/api";
import { client } from "../api/client";
import { toApiError } from "../api/session";

/**
 * The builders' question on a slice, as the engine read it from the slice's issue: their words,
 * shown as a quotation in plain text and said to be theirs. Nothing when there is none.
 */
export function BuildersQuestion({ github, headingLevel = 2 }: { github: SliceGithub; headingLevel?: 2 | 3 }) {
  if (!github.question) return null;
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <figure className="flex flex-col gap-2 rounded-md border border-warning-line bg-warning-soft px-4 py-3">
      <Heading className="flex items-center gap-2 text-label text-warning-ink">
        <MessageCircleQuestion aria-hidden="true" className="size-4" />
        The builders&apos; question
      </Heading>
      <blockquote className="whitespace-pre-line border-l-2 border-warning-line pl-3 text-body text-ink">{github.question}</blockquote>
      <figcaption className="text-caption text-ink-muted">
        {github.question_note}
        {github.times.question ? (
          <>
            {" "}
            Asked <RelativeTime iso={github.times.question} />.
          </>
        ) : null}
      </figcaption>
    </figure>
  );
}

/**
 * "Answer it": for a slice the builders asked about. An approved slice is reopened first, confirmed
 * in a dialog; then its interview opens and starts from their question.
 */
export function AnswerQuestionButton({ sliceId, approved, primary = true }: { sliceId: string; approved: boolean; primary?: boolean }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ReturnType<typeof failureText> | null>(null);
  const toInterview = () => void navigate(`/slices/${sliceId}/interview`, { state: { answer: true } });
  return (
    <>
      <Button variant={primary ? "primary" : "secondary"} onClick={() => (approved ? setOpen(true) : toInterview())}>
        Answer it<span className="sr-only">: the builders&apos; question on {sliceId}</span>
      </Button>
      <AnswerQuestionDialog sliceId={sliceId} open={open} onOpenChange={setOpen} error={error} setError={setError} onReopened={toInterview} />
    </>
  );
}

export function AnswerQuestionDialog({
  sliceId,
  open,
  onOpenChange,
  error,
  setError,
  onReopened,
}: {
  sliceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  error: ReturnType<typeof failureText> | null;
  setError: (error: ReturnType<typeof failureText> | null) => void;
  onReopened: () => void;
}) {
  const reopen = async () => {
    if (!sliceId) return false;
    setError(null);
    try {
      const result = await client.op("slice.reopen", { slice_id: sliceId });
      toast({ tone: "info", title: `Reopened ${sliceId}`, description: result.note });
      onReopened();
      return true;
    } catch (cause) {
      setError(failureText(toApiError(cause, "slice.reopen"), `${sliceId} was not reopened`));
      return false;
    }
  };
  return (
    <ConfirmDialog
      open={open && sliceId !== null}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setError(null);
      }}
      title={`Answer the builders' question on ${sliceId ?? ""}?`}
      description="This reopens the slice: it comes off the builders' list of ready work while you change it. The interview starts from their question. When you mark it ready again, they take the new version and plan again."
      confirmLabel="Reopen and answer"
      onConfirm={reopen}
      error={error}
    >
      <Text size="body-sm" tone="muted">
        Their question is shown as they wrote it. It never answers a question for you.
      </Text>
    </ConfirmDialog>
  );
}
