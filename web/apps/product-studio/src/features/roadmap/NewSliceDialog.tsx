import { useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Button, Dialog, DialogClose, DialogContent, Field, Input, Select, Textarea, epicStates, toast, HintAction } from "@mach/ui";
import type { StatusEpicRow } from "@mach/ui/api";
import { useEngineAct } from "../../api/act";
import { rememberIdea } from "../../api/pendingIdea";
import { StartChoiceFields } from "../small-change/StartChoiceFields";
import { useProblemInView } from "../small-change/useProblemInView";
import { SMALL_CHANGE_MEANS, smallArgs, type StartAs, type StartChoice } from "../small-change/model";

export interface NewSliceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  epics: StatusEpicRow[];
  /** Preselects the epic. */
  epicId?: string | null;
  /** M18: what the dialog opens on, a new slice (the default) or a small change; the person can change it. */
  start?: StartAs;
}

/**
 * Starts a slice: `slice.new` with the PM's title, then the interview. The idea, if given, is kept
 * for the slice (api/pendingIdea) and sent with its first POST /api/interview. M18: or a small change, the same
 * operation with `small` (a fix with its shipped rule, or an adjustment).
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

function NewSliceBody({ onOpenChange, epics, epicId, start = "slice" }: NewSliceDialogProps) {
  const navigate = useNavigate();
  const act = useEngineAct();
  const [epic, setEpic] = useState(epicId ?? epics[0]?.epic_id ?? "");
  const [title, setTitle] = useState("");
  const [idea, setIdea] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [choice, setChoice] = useState<StartChoice>({ as: start, change: null, rule: null });
  const [tries, setTries] = useState(0);
  const tried = tries > 0;
  const form = useRef<HTMLFormElement>(null);
  const small = choice.as === "small";
  const args = smallArgs(choice);
  useProblemInView(form, tries, act.shown?.message ?? null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTries((n) => n + 1);
    if (!title.trim()) {
      setTitleError(
        small
          ? "Give the change a title: what changes, in a few words, such as “Clearer expired invitation message”."
          : "Give the slice a title: the outcome for one kind of user, such as “Invite a teammate”.",
      );
      return;
    }
    if (args.missing) return;
    const result = await act.run("slice.new", { epic, title: title.trim(), ...(args.small ? { small: args.small } : {}) });
    if (!result) return;
    rememberIdea(result.slice.slice_id, idea);
    toast({ tone: "success", title: `Started ${result.slice.slice_id}`, description: small ? `${result.slice.title} · Small change` : result.slice.title });
    onOpenChange(false);
    navigate(`/slices/${result.slice.slice_id}/interview`);
  };

  return (
      <DialogContent
        width="lg"
        onEscapeKeyDown={(e) => act.pending && e.preventDefault()}
        onPointerDownOutside={(e) => act.pending && e.preventDefault()}
        title={small ? "Start a small change" : "Start a slice"}
        description={
          small
            ? SMALL_CHANGE_MEANS
            : "A slice of intent is one complete outcome for one kind of user, thin enough to build and check in one go. The interview works out the rest with you."
        }
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
        <form id="new-slice" ref={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <StartChoiceFields choice={choice} onChange={setChoice} epicId={epic} missing={tried ? (args.missing ?? null) : null} />
          <Field label="Epic" hint={small ? "The capability the change belongs to." : "The larger capability this slice delivers part of."}>
            <Select
              value={epic}
              onValueChange={(next) => {
                setEpic(next);
                setChoice((c) => ({ ...c, rule: null }));
              }}
              options={epics.map((e) => ({ value: e.epic_id, label: `${e.epic_id} ${e.title}`, description: epicStates[e.status].label }))}
            />
          </Field>
          <Field label="Title" hint={small ? "What changes, in a few words." : "The outcome, in a few words."} error={titleError}>
            <Input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setTitleError(null);
              }}
              placeholder={small ? "For example, Clearer expired invitation message" : "For example, Invite a teammate"}
            />
          </Field>
          <Field
            label={small ? "What is so today, and what should be so" : "The idea"}
            optional
            hint={small ? "A sentence or two in your words, for the interviewer to start from." : "A sentence or two for the interviewer to start from."}
          >
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
