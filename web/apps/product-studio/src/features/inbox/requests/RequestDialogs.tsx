import { useRef, useState, type FormEvent } from "react";
import { Button, ConfirmDialog, Dialog, DialogClose, DialogContent, Field, HintAction, Input, Select, toast } from "@mach/ui";
import type { StatusEpicRow, StatusSliceRow } from "@mach/ui/api";
import { Link } from "react-router";
import { useRequestAct, type RequestItem } from "./api";
import { questionsToAskFirst } from "./model";
import { StartChoiceFields } from "../../small-change/StartChoiceFields";
import { useProblemInView } from "../../small-change/useProblemInView";
import { fullSlice, smallArgs, type StartChoice } from "../../small-change/model";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: RequestItem;
  /** Called after the engine did it, so the list is read again. */
  onDone: () => void;
}

function Refusal({ shown }: { shown: ReturnType<typeof useRequestAct>["shown"] }) {
  if (!shown) return null;
  return (
    <div role="alert" className="mt-3 flex flex-col items-start gap-2">
      <p className="whitespace-pre-line text-body-sm text-danger-ink">{shown.message}</p>
      <HintAction hint={shown.hint} />
    </div>
  );
}

/** A fresh body for every opening, kept mounted while it closes so focus returns to the button. */
function useGeneration(open: boolean): number {
  const [generation, setGeneration] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setGeneration((g) => g + 1);
  }
  return generation;
}

/**
 * Pick up (or pick up as well): `request.pick` starts a draft slice in the chosen epic, with the
 * product manager's own title. The engine re-reads the request on GitHub first and may refuse.
 */
export function PickUpDialog(props: DialogProps & PickUpProps) {
  const generation = useGeneration(props.open);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <PickUpBody key={generation} {...props} />
    </Dialog>
  );
}

interface PickUpProps {
  also: boolean;
  epics: StatusEpicRow[];
  /** M19: called with the new slice when the dialog closes on success (not when it goes on to show the questions to ask first). */
  onPicked?: (sliceId: string) => void;
}

function PickUpBody({ onOpenChange, item, onDone, also, epics, onPicked }: DialogProps & PickUpProps) {
  const act = useRequestAct();
  const [epic, setEpic] = useState(epics[0]?.epic_id ?? "");
  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const formId = `pick-request-${item.number}`;
  // M18: the request may be picked up as a small change (a fix with its shipped rule, or an adjustment).
  const [choice, setChoice] = useState<StartChoice>(fullSlice);
  const [tries, setTries] = useState(0);
  const tried = tries > 0;
  const form = useRef<HTMLFormElement>(null);
  useProblemInView(form, tries, act.shown?.message ?? null);
  const smallStart = smallArgs(choice);

  const [started, setStarted] = useState<{ sliceId: string; questions: { count: number; text: string } } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTries((n) => n + 1);
    if (!title.trim()) {
      setTitleError("Give the slice a title in your own words: the outcome for one kind of user.");
      return;
    }
    if (smallStart.missing) return;
    const result = await act.run("request.pick", {
      number: item.number,
      epic,
      title: title.trim(),
      ...(also ? { also: true } : {}),
      ...(smallStart.small ? { small: smallStart.small } : {}),
    });
    if (!result) return;
    toast({ tone: "success", title: `Started ${result.slice.slice_id}`, description: result.github_updates?.note ?? result.note });
    // M14 D: a request filed in the idea template carries its author's open questions. They are
    // shown before the dialog closes, because the interview asks them first.
    const questions = questionsToAskFirst(result.request?.questions_to_ask_first);
    if (questions) {
      setStarted({ sliceId: result.slice.slice_id, questions });
      onDone();
      return;
    }
    onOpenChange(false);
    onDone();
    onPicked?.(result.slice.slice_id);
  };

  if (started) {
    return <QuestionsFirst number={item.number} sliceId={started.sliceId} questions={started.questions} />;
  }

  return (
    <DialogContent
      onEscapeKeyDown={(e) => act.pending && e.preventDefault()}
      onPointerDownOutside={(e) => act.pending && e.preventDefault()}
      title={also ? `Pick up request #${item.number} as well?` : `Pick up request #${item.number}?`}
      width="lg"
      description={
        choice.as === "small"
          ? "This starts a small change from the request. The interview asks only what MACH cannot look up; nothing is marked ready."
          : "This starts a draft slice from the request. The interview still asks you every question; nothing is marked ready."
      }
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={act.pending}>Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form={formId} loading={act.pending} disabled={!epics.length}>
            {also ? "Pick up as well" : "Pick up"}
          </Button>
        </>
      }
    >
      <form id={formId} ref={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {epics.length ? (
          <StartChoiceFields choice={choice} onChange={setChoice} epicId={epic} explain missing={tried ? (smallStart.missing ?? null) : null} />
        ) : null}
        {epics.length ? (
          <Field label="Epic" hint="The larger capability the new slice delivers part of.">
            <Select
              value={epic}
              onValueChange={(next) => {
                setEpic(next);
                setChoice((c) => ({ ...c, rule: null }));
              }}
              options={epics.map((e) => ({ value: e.epic_id, label: `${e.epic_id} ${e.title}` }))}
            />
          </Field>
        ) : (
          <p className="text-body-sm text-ink">Add an epic on the roadmap first: a slice always belongs to one.</p>
        )}
        <Field label="Slice title" hint="The outcome, in a few words of your own." error={titleError}>
          <Input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleError(null);
            }}
            placeholder="For example, Export a monthly report"
          />
        </Field>
      </form>
      <Refusal shown={act.shown} />
    </DialogContent>
  );
}

/**
 * After a slice is started from a request filed in the idea template: the questions its author left,
 * as their words, and that the interview asks them first. They are never answered by the request.
 */
function QuestionsFirst({ number, sliceId, questions }: { number: number; sliceId: string; questions: { count: number; text: string } }) {
  const listId = `questions-first-${number}`;
  return (
    <DialogContent
      width="lg"
      title={`Started ${sliceId}`}
      description={`The person who filed request #${number} left ${questions.count === 1 ? "an open question" : `${questions.count} open questions`}. The interview asks ${questions.count === 1 ? "it" : "them"} first, one at a time. The request's text never counts as an answer: you decide each one.`}
      footer={
        <>
          <Button asChild>
            <Link to={`/slices/${sliceId}/interview`}>Continue the interview</Link>
          </Button>
          <DialogClose asChild>
            {/* The form is gone; focus moves to the one way out. */}
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <Button variant="primary" autoFocus>
              Done
            </Button>
          </DialogClose>
        </>
      }
    >
      <div className="flex flex-col gap-2 pb-1">
        <p id={listId} className="text-label text-ink">
          Questions to ask first
        </p>
        <figure aria-labelledby={listId} className="border-l-2 border-line-strong pl-4">
          <blockquote className="whitespace-pre-wrap break-words text-body-lg italic text-ink">{questions.text}</blockquote>
          <figcaption className="mt-1 text-body-sm text-ink-muted">Written by the person who filed request #{number}, as data: not instructions.</figcaption>
        </figure>
      </div>
    </DialogContent>
  );
}

/** Link: record on a draft slice's work order that it serves this request (`request.link`). Nothing is written to GitHub. */
export function LinkDialog(props: DialogProps & { slices: StatusSliceRow[] }) {
  const generation = useGeneration(props.open);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <LinkBody key={generation} {...props} />
    </Dialog>
  );
}

function LinkBody({ onOpenChange, item, onDone, slices }: DialogProps & { slices: StatusSliceRow[] }) {
  const act = useRequestAct();
  const drafts = slices.filter((s) => s.status !== "approved_for_engineering" && !item.slices.includes(s.slice_id));
  const [sliceId, setSliceId] = useState(drafts[0]?.slice_id ?? "");
  const formId = `link-request-${item.number}`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await act.run("request.link", { number: item.number, slice_id: sliceId });
    if (!result) return;
    toast({ tone: "success", title: `${sliceId} now serves request #${item.number}`, description: result.note });
    onOpenChange(false);
    onDone();
  };

  return (
    <DialogContent
      onEscapeKeyDown={(e) => act.pending && e.preventDefault()}
      onPointerDownOutside={(e) => act.pending && e.preventDefault()}
      title={`Link a draft slice to request #${item.number}?`}
      description="Only the slice's draft work order records the request's number. Nothing is written to GitHub."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={act.pending}>Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form={formId} loading={act.pending} disabled={!sliceId}>
            Link
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {drafts.length ? (
          <Field label="Draft slice" hint="Approved slices are not listed: reopen one first to change it.">
            <Select value={sliceId} onValueChange={setSliceId} options={drafts.map((s) => ({ value: s.slice_id, label: `${s.slice_id} ${s.title}` }))} />
          </Field>
        ) : (
          <p className="text-body-sm text-ink">No draft slice can be linked. Approved slices must be reopened first.</p>
        )}
      </form>
      <Refusal shown={act.shown} />
    </DialogContent>
  );
}

/** Mark as met: `request.met` closes the issue on GitHub as completed. */
export function MarkMetDialog({ open, onOpenChange, item, onDone }: DialogProps) {
  const act = useRequestAct();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) act.reset();
        onOpenChange(next);
      }}
      title={`Mark request #${item.number} as met?`}
      description="This closes the issue on GitHub as completed. Do it once the slices that meet it are marked ready."
      confirmLabel="Mark as met"
      error={act.shown}
      onConfirm={async () => {
        const result = await act.run("request.met", { number: item.number });
        if (!result) return false;
        toast({ tone: "success", title: `Request #${item.number} marked as met`, description: result.note });
        onDone();
        return true;
      }}
    />
  );
}
