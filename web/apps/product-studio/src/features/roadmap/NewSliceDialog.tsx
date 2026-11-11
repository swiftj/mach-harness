import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Button, Dialog, DialogClose, DialogContent, Field, Input, Select, Textarea, toast, HintAction } from "@mach/ui";
import type { StatusEpicRow } from "@mach/ui/api";
import { useEngineAct } from "../../api/act";
import { rememberIdea } from "../../api/pendingIdea";

export interface NewSliceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  epics: StatusEpicRow[];
  /** Preselects the epic. */
  epicId?: string | null;
}

/**
 * Starts a slice: `slice.new` with the PM's title, then the interview. The idea, if given, is kept
 * for the slice (api/pendingIdea) and sent with its first POST /api/interview.
 */
export function NewSliceDialog(props: NewSliceDialogProps) {
  // A fresh body (empty fields) for every opening, kept mounted while it closes so the dialog can
  // hand focus back to whatever opened it.
  const [generation, setGeneration] = useState(0);
  const [wasOpen, setWasOpen] = useState(props.open);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) setGeneration((g) => g + 1);
  }
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <NewSliceBody key={generation} {...props} />
    </Dialog>
  );
}

function NewSliceBody({ onOpenChange, epics, epicId }: NewSliceDialogProps) {
  const navigate = useNavigate();
  const act = useEngineAct();
  const usable = epics.filter((e) => e.status !== "superseded" && e.status !== "completed");
  const [epic, setEpic] = useState(epicId ?? usable[0]?.epic_id ?? "");
  const [title, setTitle] = useState("");
  const [idea, setIdea] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setTitleError("Give the slice a title: the outcome for one kind of user, such as “Invite a teammate”.");
      return;
    }
    const result = await act.run("slice.new", { epic, title: title.trim() });
    if (!result) return;
    rememberIdea(result.slice.slice_id, idea);
    toast({ tone: "success", title: `Started ${result.slice.slice_id}`, description: result.slice.title });
    onOpenChange(false);
    navigate(`/slices/${result.slice.slice_id}/interview`);
  };

  return (
      <DialogContent
        onEscapeKeyDown={(e) => act.pending && e.preventDefault()}
        onPointerDownOutside={(e) => act.pending && e.preventDefault()}
        title="Start a slice"
        description="A slice is one complete outcome for one kind of user, thin enough to build and check in one go. The interview works out the rest with you."
        footer={
          <>
            <DialogClose asChild>
              <Button disabled={act.pending}>Cancel</Button>
            </DialogClose>
            <Button variant="primary" type="submit" form="new-slice" loading={act.pending}>
              Start and open the interview
            </Button>
          </>
        }
      >
        <form id="new-slice" onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="Epic" hint="The larger capability this slice delivers part of.">
            <Select
              value={epic}
              onValueChange={setEpic}
              options={usable.map((e) => ({ value: e.epic_id, label: `${e.epic_id} ${e.title}`, description: e.status === "approved" ? "Approved" : e.status === "deferred" ? "Deferred" : "Proposed" }))}
            />
          </Field>
          <Field label="Title" hint="The outcome, in a few words." error={titleError}>
            <Input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setTitleError(null);
              }}
              placeholder="For example, Invite a teammate"
            />
          </Field>
          <Field label="The idea" optional hint="A sentence or two for the interviewer to start from.">
            <Textarea editorial rows={3} value={idea} onChange={(e) => setIdea(e.target.value)} />
          </Field>
        </form>
        {act.shown ? (
          <div role="alert" className="mt-3 flex flex-col items-start gap-2">
            <p className="whitespace-pre-line text-body-sm text-danger-ink">{act.shown.message}</p>
            <HintAction hint={act.shown.hint} />
          </div>
        ) : null}
      </DialogContent>
  );
}
