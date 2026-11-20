import { useState, type FormEvent } from "react";
import { Banner, Button, Dialog, DialogClose, DialogContent, Field, HintAction, Input, Textarea, toast } from "@mach/ui";
import type { Principle, PrincipleChanged } from "@mach/ui/api";
import { useEngineAct } from "../../api/act";
import { addArgs, emptyFields, oneLine, refusalPlace, setArgs, type PrincipleDraft } from "./model";

/** What the form is for: a new principle, or a change to one in force. */
export type FormState = { mode: "add" } | { mode: "change"; principle: Principle } | null;

const askFor: Record<keyof PrincipleDraft, string> = {
  title: "Give it a short name, such as: Versions stay as published.",
  statement: "Write the one sentence every slice must keep.",
  reason: "Say in a sentence why it matters.",
};

/**
 * Adding or changing a principle, on the product manager's word: the dialog says what saving does
 * (it is saved here; the builders get it when the principles are published), and the engine checks
 * the statement. Its refusal is shown as written, beside the statement.
 */
export function PrincipleForm({ state, onClose, onSaved }: { state: FormState; onClose: () => void; onSaved: (result: PrincipleChanged) => void }) {
  // A fresh body for every opening, so its fields start from the principle being changed.
  const [last, setLast] = useState<NonNullable<FormState> | null>(state);
  const [generation, setGeneration] = useState(0);
  if (state && state !== last) {
    setLast(state);
    setGeneration((g) => g + 1);
  }
  const shown = state ?? last;
  return (
    <Dialog open={state !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      {shown ? <FormBody key={generation} state={shown} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function FormBody({ state, onClose, onSaved }: { state: NonNullable<FormState>; onClose: () => void; onSaved: (result: PrincipleChanged) => void }) {
  const act = useEngineAct();
  const original = state.mode === "change" ? state.principle : null;
  const [draft, setDraft] = useState<PrincipleDraft>({ title: original?.title ?? "", statement: original?.statement ?? "", reason: original?.reason ?? "" });
  const [missing, setMissing] = useState<Array<keyof PrincipleDraft>>([]);
  const [nothingChanged, setNothingChanged] = useState(false);
  const [refusedAt, setRefusedAt] = useState<"statement" | "form">("form");

  const edit = (key: keyof PrincipleDraft) => (value: string) => {
    setDraft((d) => ({ ...d, [key]: oneLine(value) }));
    setMissing((m) => m.filter((k) => k !== key));
    setNothingChanged(false);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const empty = emptyFields(draft);
    setMissing(empty);
    if (empty.length) return;
    if (!original) {
      const args = addArgs(draft);
      setRefusedAt(refusalPlace(args));
      const result = await act.run("principle.add", args);
      if (!result) return;
      toast({ tone: "success", title: `Added ${result.principle.id}`, description: "It is saved here. The builders get it when you publish the principles." });
      onSaved(result);
    } else {
      const args = setArgs(original, draft);
      if (!args) {
        setNothingChanged(true);
        return;
      }
      setRefusedAt(refusalPlace(args));
      const result = await act.run("principle.set", args);
      if (!result) return;
      toast({ tone: "success", title: `Saved ${result.principle.id}`, description: "The change is saved here. The builders get it when you publish the principles." });
      onSaved(result);
    }
    onClose();
  };

  const refusal = act.shown;
  // Only the engine's own refusal belongs beside the statement; a host or network failure is about the act.
  const atStatement = refusal !== null && act.error?.kind === "refused" && refusedAt === "statement";
  const statementError = atStatement ? refusal.message : missing.includes("statement") ? askFor.statement : undefined;

  return (
    <DialogContent
      width="lg"
      onEscapeKeyDown={(e) => act.pending && e.preventDefault()}
      onPointerDownOutside={(e) => act.pending && e.preventDefault()}
      title={original ? `Change ${original.id}?` : "Add a principle?"}
      description={
        original
          ? "Your change is saved here. The builders get it when you publish the principles. A changed statement becomes its next revision, and slices answered under the old one are listed for checking; a new name or reason is not a new revision."
          : "A principle is one sentence that must hold in every slice. It is saved here; the builders get it when you publish the principles, and every slice marked ready after that must say how it keeps it."
      }
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={act.pending}>Not now</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="principle-form" loading={act.pending}>
            {original ? `Save ${original.id}` : "Add principle"}
          </Button>
        </>
      }
    >
      <form id="principle-form" onSubmit={save} noValidate className="flex flex-col gap-5 pb-1">
        {refusal && !atStatement ? (
          <Banner tone="danger" live="assertive" title={original ? `${original.id} was not changed` : "The principle was not added"} actions={refusal.hint ? <HintAction hint={refusal.hint} /> : undefined}>
            <span className="whitespace-pre-line">{refusal.message}</span>
          </Banner>
        ) : null}
        <Field label="Name" hint="A few words that name the rule." error={missing.includes("title") ? askFor.title : undefined}>
          <Input value={draft.title} onChange={(e) => edit("title")(e.target.value)} autoComplete="off" />
        </Field>
        <Field
          label="Statement"
          hint={
            <>
              One sentence about what your product does for people, with MUST or MUST NOT in capitals and no technology words. For example: “A published version MUST NOT be changed in place.”
            </>
          }
          error={statementError ? <span className="whitespace-pre-line">{statementError}</span> : undefined}
        >
          <Textarea editorial rows={2} value={draft.statement} onChange={(e) => edit("statement")(e.target.value)} />
        </Field>
        <Field label="Why it matters" hint="One sentence the builders and reviewers will read beside it." error={missing.includes("reason") ? askFor.reason : undefined}>
          <Input value={draft.reason} onChange={(e) => edit("reason")(e.target.value)} autoComplete="off" />
        </Field>
        {nothingChanged ? (
          <p role="status" className="text-body-sm text-ink-muted">
            Nothing has changed yet. Change the name, the statement or the reason, or close this without saving.
          </p>
        ) : null}
        {atStatement ? (
          <p className="sr-only" role="alert">
            {original ? `${original.id} was not changed.` : "The principle was not added."} The reason is under the statement.
          </p>
        ) : null}
      </form>
    </DialogContent>
  );
}
