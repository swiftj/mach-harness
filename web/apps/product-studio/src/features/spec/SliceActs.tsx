import { useEffect, useRef, useState } from "react";
import { CircleCheck, FolderUp, GitBranch, Hash, Pause, RotateCcw } from "lucide-react";
import { Banner, Button, Dialog, DialogClose, DialogContent, DialogTrigger, ErrorState, Field, Text, Textarea, describeError, toast, CheckCounts, CheckPill, DiagnosticList, diagnostics, plural as count } from "@mach/ui";
import type { MachApiError, MocksToCommit, SliceReady, SliceReadyWidened, SliceShow } from "@mach/ui/api";
import { Link, useNavigate } from "react-router";
import { RenumberDialog } from "../../shared/RenumberDialog";
import { renumberHint, sharedTextAfterReady, sharedTextAnchor } from "../../shared/team";
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
 * M20: marking ready was refused because the slice's or its epic's number is someone else's on GitHub (taken at the same
 * moment, or before). Something to settle, not a failure: the engine's words as written (who holds the number, which
 * issue), and the one act, a new number.
 */
function NumberTaken({ error, what, onRenumber }: { error: MachApiError; what: string; onRenumber: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-md border border-warning-line bg-warning-soft px-5 py-4">
      <div className="flex items-start gap-3">
        <Hash aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning-ink" />
        <div className="flex flex-col gap-1">
          <p className="text-title-3 font-semibold text-warning-ink">{what}</p>
          <p className="whitespace-pre-line text-body text-ink">{error.message}</p>
        </div>
      </div>
      <div className="pl-8">
        <Button variant="primary" onClick={onRenumber}>
          Give it a new number
        </Button>
      </div>
    </div>
  );
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
  // M20: a refusal whose hint is a new number for this slice or its epic.
  const taken = error?.kind === "refused" ? renumberHint(error.hint) : null;
  const [renumber, setRenumber] = useState<string | null>(null);
  const navigate = useNavigate();

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
    <>
    <RenumberDialog
      id={renumber}
      onOpenChange={(next) => !next && setRenumber(null)}
      onRenumbered={({ to }) => {
        // A slice moves to its new number's page, where it is marked ready again; an epic's slice stays here.
        if (to.startsWith("SLICE-")) void navigate(`/slices/${to}`, { replace: true });
        else onDone();
      }}
    />
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
          // A short description of its own; MACH's note, which can run long, is the body's last line.
          description={saved.saved_to === "github" ? "Saved to GitHub and marked ready for the builders." : "Approved and written to a folder, not to GitHub."}
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
          <div className="flex flex-col gap-4">
            <SavedPlace result={saved} />
            {saved.note ? (
              <Text size="body-sm" tone="muted" className="max-w-reading">
                {saved.note}
              </Text>
            ) : null}
          </div>
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
              {/* After a refusal for a taken number, the new number is the act; marking ready again would be refused. */}
              <Button variant={taken ? "secondary" : "primary"} loading={busy} onClick={markReady}>
                Mark ready to build
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4 pb-1">
            {/* First, so the reason and the way on are never below the fold. */}
            {error && taken ? (
              <NumberTaken
                error={error}
                what={`${id} was not marked ready`}
                onRenumber={() => {
                  // This dialog closes and the renumbering one opens: one dialog at a time.
                  setOpen(false);
                  setError(null);
                  setRenumber(taken.id);
                }}
              />
            ) : error ? (
              <Failure error={error} what={`${id} was not marked ready`} />
            ) : null}
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
    </>
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
        <SharedTextAfterReady result={result} />
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

/**
 * M20: what happened to the project's and the epic's own text while the slice was saved. Someone else's text MACH took
 * in instead of writing over it, or a change on both sides that was not written and waits for a choice on Vision. The
 * slice itself was saved either way; this is said calmly, in the engine's words.
 */
function SharedTextAfterReady({ result }: { result: SliceReady }) {
  const notes = sharedTextAfterReady(result.shared_text);
  if (!notes.length) return null;
  return (
    <section aria-labelledby="shared-text-after-ready" className="flex flex-col gap-2 rounded-md border border-info-line bg-info-soft px-4 py-3">
      <h3 id="shared-text-after-ready" className="flex items-start gap-2 text-label text-info-ink">
        <GitBranch aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        Shared with other product managers
      </h3>
      <ul className="flex flex-col gap-1.5 pl-6 text-body-sm text-ink">
        {notes.map((note) => (
          <li key={note.key}>
            {note.text}
            {note.choose ? (
              <>
                {" "}
                <Link to="/vision" state={{ focus: sharedTextAnchor(note.choose) }} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
                  Choose a version on Vision
                </Link>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
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
