import { useState, type FormEvent } from "react";
import { Button, ConfirmDialog, Dialog, DialogClose, DialogContent, Field, HintAction, Input, Select, toast } from "@mach/ui";
import type { StatusEpicRow, StatusSliceRow } from "@mach/ui/api";
import { useRequestAct, type RequestItem } from "./api";

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
export function PickUpDialog(props: DialogProps & { also: boolean; epics: StatusEpicRow[] }) {
  const generation = useGeneration(props.open);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <PickUpBody key={generation} {...props} />
    </Dialog>
  );
}

function PickUpBody({ onOpenChange, item, onDone, also, epics }: DialogProps & { also: boolean; epics: StatusEpicRow[] }) {
  const act = useRequestAct();
  const usable = epics.filter((e) => e.status !== "superseded" && e.status !== "completed");
  const [epic, setEpic] = useState(usable[0]?.epic_id ?? "");
  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const formId = `pick-request-${item.number}`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setTitleError("Give the slice a title in your own words: the outcome for one kind of user.");
      return;
    }
    const result = await act.run("request.pick", { number: item.number, epic, title: title.trim(), ...(also ? { also: true } : {}) });
    if (!result) return;
    toast({ tone: "success", title: `Started ${result.slice.slice_id}`, description: result.github_updates?.note ?? result.note });
    onOpenChange(false);
    onDone();
  };

  return (
    <DialogContent
      onEscapeKeyDown={(e) => act.pending && e.preventDefault()}
      onPointerDownOutside={(e) => act.pending && e.preventDefault()}
      title={also ? `Pick up request #${item.number} as well?` : `Pick up request #${item.number}?`}
      description="This starts a draft slice from the request. The interview still asks you every question; nothing is approved or sent."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={act.pending}>Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form={formId} loading={act.pending} disabled={!usable.length}>
            {also ? "Pick up as well" : "Pick up"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {usable.length ? (
          <Field label="Epic" hint="The larger capability the new slice delivers part of.">
            <Select value={epic} onValueChange={setEpic} options={usable.map((e) => ({ value: e.epic_id, label: `${e.epic_id} ${e.title}` }))} />
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
      description="This closes the issue on GitHub as completed. Do it once the slices that meet it are approved."
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
