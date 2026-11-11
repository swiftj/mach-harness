import { useState } from "react";
import { CircleCheck, Pause, RotateCcw } from "lucide-react";
import { Banner, Button, Dialog, DialogClose, DialogContent, DialogTrigger, ErrorState, Field, Text, Textarea, describeError, toast, CheckCounts, CheckPill, DiagnosticList, diagnostics, plural as count } from "@mach/ui";
import type { MachApiError, SliceShow } from "@mach/ui/api";
import { client as studioClient } from "../../api/client";
import { toApiError } from "../../api/session";

function Failure({ error, what }: { error: MachApiError; what: string }) {
  // A refusal is the engine's own words, shown as written; the title names what did not happen.
  const described = describeError(error);
  return <ErrorState title={error.kind === "refused" ? what : described.title} message={error.kind === "refused" ? error.message : described.message} />;
}

/**
 * Approve: a personal act. The dialog says what approval means and shows the engine's readiness;
 * the engine still decides, and its refusal is shown exactly.
 */
export function ApproveDialog({ show, onDone, primary }: { show: SliceShow; onDone: () => void; primary: boolean }) {
  const id = show.slice.slice_id;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MachApiError | null>(null);
  const check = show.check;
  const problems = diagnostics(check);

  const approve = () => {
    setBusy(true);
    setError(null);
    studioClient.op("slice.approve", { slice_id: id }).then(
      (result) => {
        setBusy(false);
        setOpen(false);
        toast({ tone: "success", title: `Approved ${id}`, description: result.note });
        onDone();
      },
      (cause: unknown) => {
        setBusy(false);
        setError(toApiError(cause, "slice.approve"));
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant={primary ? "primary" : "secondary"}>
          <CircleCheck aria-hidden="true" />
          Approve {id}
        </Button>
      </DialogTrigger>
      <DialogContent
        width="lg"
        title={`Approve ${id}?`}
        description="Approving records your decision that this specification is what you want built. It freezes the slice until you reopen it. Nothing goes to engineering until you send a delivery wave that contains it."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button variant="primary" loading={busy} onClick={approve}>
              Approve {id}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 pb-1">
          <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-label text-ink">What the engine's check says</p>
              <CheckPill check={check} size="sm" />
            </div>
            <CheckCounts check={check} />
            {check.risk ? (
              <Text size="body-sm" tone="muted">
                Risk the interviewer assigned: <span className="font-semibold text-ink">{check.risk}</span>
              </Text>
            ) : null}
            {problems.length ? <DiagnosticList items={problems} compact /> : null}
            {check.open_questions.length ? (
              <Text size="body-sm" tone="warning">
                {count(check.open_questions.length, "question is", "questions are")} still open.
              </Text>
            ) : null}
          </div>
          <Text size="body-sm" tone="muted">
            The engine checks again when you approve, including whether the slice's epic is approved. If something is missing it says what, and
            nothing changes.
          </Text>
          {error ? <Failure error={error} what={`${id} was not approved`} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Reopen: withdraws an approval so the slice can change. Approved waves containing it return to draft. */
export function ReopenDialog({ show, onDone }: { show: SliceShow; onDone: () => void }) {
  const id = show.slice.slice_id;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MachApiError | null>(null);

  const reopen = () => {
    setBusy(true);
    setError(null);
    studioClient.op("slice.reopen", { slice_id: id }).then(
      (result) => {
        setBusy(false);
        setOpen(false);
        const waves = result.waves_returned_to_draft;
        toast({
          tone: "info",
          title: `Reopened ${id}`,
          description: waves.length ? `${waves.join(", ")} returned to draft and need your approval again.` : "No approved wave contained it.",
        });
        onDone();
      },
      (cause: unknown) => {
        setBusy(false);
        setError(toApiError(cause, "slice.reopen"));
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary">
          <RotateCcw aria-hidden="true" />
          Reopen {id}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Reopen ${id}?`}
        description="Reopening withdraws your approval so the specification can change. Any approved delivery wave that contains this slice returns to draft and needs your approval again."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">Keep it approved</Button>
            </DialogClose>
            <Button variant="danger" loading={busy} onClick={reopen}>
              Reopen {id}
            </Button>
          </>
        }
      >
        {error ? (
          <div className="pb-1">
            <Failure error={error} what={`${id} was not reopened`} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Pause with a note: saves where the PM stopped, so the interview picks up from it. */
export function PauseDialog({ show, onDone }: { show: SliceShow; onDone: () => void }) {
  const id = show.slice.slice_id;
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MachApiError | null>(null);
  const [tried, setTried] = useState(false);
  const empty = note.trim() === "";

  const pause = () => {
    setTried(true);
    if (empty) return;
    setBusy(true);
    setError(null);
    studioClient.op("slice.pause", { slice_id: id, note: note.trim() }).then(
      () => {
        setBusy(false);
        setOpen(false);
        setNote("");
        setTried(false);
        toast({ tone: "success", title: `Paused ${id}`, description: "Your note is saved; the interview picks up from it." });
        onDone();
      },
      (cause: unknown) => {
        setBusy(false);
        setError(toApiError(cause, "slice.pause"));
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setError(null);
          setTried(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost">
          <Pause aria-hidden="true" />
          Pause with a note
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Pause ${id}?`}
        description="Your draft stays as it is. The note says where you stopped, so you or the interviewer can pick up from it later."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button variant="primary" loading={busy} onClick={pause}>
              Save note and pause
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 pb-1">
          {show.resume_note ? (
            <Banner tone="info" title="The note saved last time">
              {show.resume_note}
            </Banner>
          ) : null}
          <Field label="Where you stopped" hint="What is settled, and what to ask next." error={tried && empty ? "Write a short note, such as: Settled who may invite. Next: do invitations expire?" : undefined}>
            <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} />
          </Field>
          {error ? <Failure error={error} what={`${id} was not paused`} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
