import { useEffect, useRef, useState } from "react";
import { CircleCheck, FolderUp, Pause, RotateCcw } from "lucide-react";
import { Banner, Button, Dialog, DialogClose, DialogContent, DialogTrigger, ErrorState, Field, Text, Textarea, describeError, toast, CheckCounts, CheckPill, DiagnosticList, diagnostics, plural as count } from "@mach/ui";
import type { MachApiError, MocksToCommit, SliceReady, SliceReadyWidened, SliceShow } from "@mach/ui/api";
import { Link } from "react-router";
import { MadeFullAtReady } from "../small-change/MadeFullAtReady";
import { isMadeFullAtReady, madeFullAtReady } from "../small-change/model";
import { IssueLink, SignInNote } from "../../shared/IssueLink";
import { client as studioClient } from "../../api/client";
import { toApiError } from "../../api/session";
import { useStatus } from "../../api/store";
import { Fold } from "../../shared/layout/Fold";
import { forgetReadyAnswer, rememberReadyAnswer } from "../../shared/mocksDelivery";

function Failure({ error, what }: { error: MachApiError; what: string }) {
  // A refusal is the engine's own words, shown as written; the title names what did not happen.
  const described = describeError(error);
  return <ErrorState title={error.kind === "refused" ? what : described.title} message={error.kind === "refused" ? error.message : described.message} hint={error.hint} />;
}

/**
 * Mark ready to build: the PM's approval of exactly this text. The dialog says what the engine does
 * and shows its check; the engine still decides, and its refusal is shown exactly. Once it is done,
 * the dialog says where the slice was saved, in the engine's words.
 */
export function MarkReadyDialog({ show, onDone, primary }: { show: SliceShow; onDone: () => void; primary: boolean }) {
  const id = show.slice.slice_id;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MachApiError | null>(null);
  const [saved, setSaved] = useState<SliceReady | null>(null);
  // M18: marking a small change ready may make it a full slice instead; nothing is saved then.
  const [madeFull, setMadeFull] = useState<SliceReadyWidened | null>(null);
  const done = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (saved || madeFull) done.current?.focus();
  }, [saved, madeFull]);
  const check = show.check;
  const problems = diagnostics(check);
  const again = show.slice.status === "approved_for_engineering";
  const epicId = show.slice.epic_id;
  const epicTitle = useStatus().data?.epics.find((e) => e.epic_id === epicId)?.title;
  const epicName = epicTitle ? `the epic “${epicTitle}” (${epicId})` : `its epic, ${epicId}`;

  const markReady = () => {
    setBusy(true);
    setError(null);
    studioClient.op("slice.ready", { slice_id: id }).then(
      (result) => {
        setBusy(false);
        if (isMadeFullAtReady(result)) {
          setMadeFull(result);
          return;
        }
        rememberReadyAnswer(result);
        setSaved(result);
      },
      (cause: unknown) => {
        setBusy(false);
        setError(toApiError(cause, "slice.ready"));
      },
    );
  };

  const close = (next: boolean) => {
    setOpen(next);
    if (next) return;
    setError(null);
    if (saved || madeFull) {
      setSaved(null);
      setMadeFull(null);
      onDone();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : close(next))}>
      <DialogTrigger asChild>
        <Button variant={primary ? "primary" : "secondary"}>
          <CircleCheck aria-hidden="true" />
          {again ? `Mark ${id} ready again` : "Mark ready to build"}
        </Button>
      </DialogTrigger>
      {madeFull ? (
        <DialogContent
          width="lg"
          title={madeFullAtReady(madeFull).title}
          description={madeFullAtReady(madeFull).lead}
          footer={
            <>
              <DialogClose asChild>
                <Button variant="secondary">Close</Button>
              </DialogClose>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <Button ref={done} variant="primary" autoFocus asChild>
                <Link to={`/slices/${id}/interview`} onClick={() => close(false)}>
                  Continue the interview
                </Link>
              </Button>
            </>
          }
        >
          <MadeFullAtReady answer={madeFull} />
        </DialogContent>
      ) : saved ? (
        <DialogContent
          width="lg"
          title={`${id} is ready to build`}
          description={saved.note}
          footer={
            <DialogClose asChild>
              {/* The confirming button is gone; focus moves to the one way out (the dialog stays open, so autoFocus alone does not). */}
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <Button ref={done} variant="primary" autoFocus>
                Done
              </Button>
            </DialogClose>
          }
        >
          <SavedPlace result={saved} />
        </DialogContent>
      ) : (
        <DialogContent
          width="lg"
          title={again ? `Mark ${id} ready again?` : `Mark ${id} ready to build?`}
          description={`This saves the slice to the project on GitHub, under ${epicName}, and tells the builders it is ready. It records that you approved exactly this text. The slice cannot change until you reopen it.`}
          footer={
            <>
              <DialogClose asChild>
                <Button variant="secondary" disabled={busy}>
                  Cancel
                </Button>
              </DialogClose>
              <Button variant="primary" loading={busy} onClick={markReady}>
                Mark ready to build
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4 pb-1">
            {/* First, so the reason and the way on are never below the fold. */}
            {error ? <Failure error={error} what={`${id} was not marked ready`} /> : null}
            <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-label text-ink">What MACH's check says</p>
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
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * What marking ready did, at a glance (M16 layout): what was saved, where, and the one thing left for the person, each
 * on its own row; the long detail (the pictures' file names) folded. Every fact is the engine's answer, shown as given.
 */
export function SavedPlace({ result }: { result: SliceReady }) {
  if (result.saved_to === "github") {
    const mocks = result.mocks;
    return (
      <div className="flex flex-col gap-4 pb-1">
        <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-md border border-line bg-surface px-4 py-3 text-body">
          <dt className="text-label text-ink-muted">Saved</dt>
          <dd className="flex min-w-0 flex-col gap-0.5">
            <span>
              Version {result.revision} of this text, approved as <span className="font-mono text-body-sm">{result.approved_by}</span>
            </span>
          </dd>
          <dt className="text-label text-ink-muted">Where</dt>
          <dd className="flex min-w-0 flex-col gap-0.5">
            <span>
              On GitHub as issue <IssueLink number={result.issue} url={result.url} />, under the epic&apos;s issue #{result.epic_issue}
              {result.follows ? `; it changes #${result.follows}, which has shipped` : ""}
            </span>
            <SignInNote />
          </dd>
          {mocks ? null : (
            <>
              <dt className="text-label text-ink-muted">Your next step</dt>
              <dd className="min-w-0 font-semibold">Nothing. The builders take it from here.</dd>
            </>
          )}
        </dl>
        {mocks ? <PicturesToAdd mocks={mocks} /> : null}
      </div>
    );
  }
  const [first, ...others] = result.ways_on;
  return (
    <div className="flex flex-col gap-4 pb-1">
      <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-md border border-line bg-surface px-4 py-3 text-body">
        <dt className="text-label text-ink-muted">Saved</dt>
        <dd className="min-w-0">Version {result.revision} of this text, approved by you</dd>
        <dt className="text-label text-ink-muted">Where</dt>
        <dd className="flex min-w-0 flex-col gap-1">
          <span>In a folder, not on GitHub</span>
          <span translate="no" className="break-all font-mono text-body-sm text-ink">
            {result.folder}
          </span>
        </dd>
        <dt className="text-label text-ink-muted">Your next step</dt>
        <dd className="flex min-w-0 flex-col gap-1">
          {first ? <span className="font-semibold">{first}</span> : null}
          {others.map((way) => (
            <span key={way} className="text-body-sm text-ink-muted">
              {way}
            </span>
          ))}
        </dd>
      </dl>
      <Fold label="Why it went to a folder">
        <Text size="body-sm" tone="muted" className="max-w-reading">
          {result.why_folder}
        </Text>
      </Fold>
    </div>
  );
}

/** The one thing left after marking a slice with design mocks ready: the pictures go to the repository by hand. */
function PicturesToAdd({ mocks }: { mocks: MocksToCommit }) {
  return (
    <section aria-labelledby="pictures-to-add" className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-md border-2 border-dashed border-warning-line bg-warning-soft px-4 py-3">
      <p className="flex items-start gap-1.5 text-label text-ink-muted">
        <FolderUp aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-ink" />
        Your next step
      </p>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 id="pictures-to-add" className="text-body font-semibold text-ink">
            Add its pictures to the project&apos;s repository
          </h3>
          {mocks.factory_waits ? (
            <Text size="body-sm" tone="muted">
              The builders wait until they are there.
            </Text>
          ) : null}
        </div>
        <PicturePaths mocks={mocks} />
      </div>
    </section>
  );
}

function PicturePaths({ mocks }: { mocks: MocksToCommit }) {
  const names = mocks.files;
  return (
    <>
      <dl className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-body-sm">
        <dt className="text-ink-muted">From</dt>
        <dd translate="no" className="min-w-0 break-all font-mono text-ink">
          {mocks.folder}
        </dd>
        <dt className="text-ink-muted">To</dt>
        <dd translate="no" className="min-w-0 break-all font-mono text-ink">
          {mocks.commit_as}
        </dd>
      </dl>
      <Text size="body-sm" tone="muted">
        Or hand the folder to an engineer to add.
      </Text>
      {names.length ? (
        <Fold label={`File names: ${names.length}`}>
          <ul className="flex flex-col gap-1 text-body-sm">
            {names.map((name) => (
              <li key={name} translate="no" className="break-all font-mono">
                {name}
              </li>
            ))}
          </ul>
        </Fold>
      ) : null}
    </>
  );
}

/** Reopen: takes the slice back from the builders so it can change. Shows the engine's note on what that did. */
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
        forgetReadyAnswer(id);
        toast({ tone: "info", title: `Reopened ${id}`, description: result.note });
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
        if (busy) return;
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
        description="Reopening withdraws your approval so the specification can change. It first takes the slice off the builders' list of ready work; if the builders have already started, they are told it changed when you mark it ready again."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={busy}>
                Keep it ready
              </Button>
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
