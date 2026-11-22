import { useState, type FormEvent } from "react";
import { Banner, Button, Dialog, DialogClose, DialogContent, Field, HintAction, Input, Select, Textarea, toast } from "@mach/ui";
import type { NeedChanged, NeedKind, TechnicalNeed } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { addArgs, asksWho, draftOf, emptyFields, givenOffered, kindNames, kindOrder, limits, oneLine, refusalPlace, setArgs, type NeedDraft } from "./model";

/** What the form is for: a new need of a kind, or a change to one that is active. */
export type NeedFormState = { mode: "add"; kind: NeedKind } | { mode: "change"; need: TechnicalNeed } | null;

const askFor: Record<keyof NeedDraft, string> = {
  statement: "Say in one or two sentences what the product requires.",
  why: "Say in a sentence why it matters.",
  said_by: "Say who decided it: a person's name or role, or a policy pack.",
  said_on: "Give the date it was said.",
};

/**
 * Adding or changing a technical need by hand, on the product manager's word. The dialog says what saving does (it is
 * saved here; the engineer gets it when the needs are published), and the engine checks the statement: a technology
 * named in it is refused in the engine's words, beside the statement, with the other way to say it (record it as a
 * given). Only a given asks who said it and when.
 */
export function NeedForm({ state, onClose, onSaved }: { state: NeedFormState; onClose: () => void; onSaved: (result: NeedChanged) => void }) {
  // A fresh body for every opening, so its fields start from the need being changed.
  const [last, setLast] = useState<NonNullable<NeedFormState> | null>(state);
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

function FormBody({ state, onClose, onSaved }: { state: NonNullable<NeedFormState>; onClose: () => void; onSaved: (result: NeedChanged) => void }) {
  const act = useEngineAct();
  const original = state.mode === "change" ? state.need : null;
  const [kind, setKind] = useState<NeedKind>(state.mode === "change" ? state.need.kind : state.kind);
  const [draft, setDraft] = useState<NeedDraft>(draftOf(original));
  const [missing, setMissing] = useState<Array<keyof NeedDraft>>([]);
  const [nothingChanged, setNothingChanged] = useState(false);
  const [refusedAt, setRefusedAt] = useState<"statement" | "form">("form");
  const who = asksWho(kind);

  const edit = (key: keyof NeedDraft) => (value: string) => {
    setDraft((d) => ({ ...d, [key]: key === "said_on" ? value : oneLine(value) }));
    setMissing((m) => m.filter((k) => k !== key));
    setNothingChanged(false);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const empty = emptyFields(kind, draft);
    setMissing(empty);
    if (empty.length) return;
    if (!original) {
      const args = addArgs(kind, draft);
      setRefusedAt(refusalPlace(args));
      const result = await act.run("need.add", args);
      if (!result) return;
      toast({ tone: "success", title: `Added ${result.need.need_id}`, description: result.note });
      onSaved(result);
    } else {
      const args = setArgs(original, draft);
      if (!args) {
        setNothingChanged(true);
        return;
      }
      setRefusedAt(refusalPlace(args));
      const result = await act.run("need.set", args);
      if (!result) return;
      toast({ tone: "success", title: `Saved ${result.need.need_id}`, description: result.note });
      onSaved(result);
    }
    onClose();
  };

  const refusal = act.shown;
  // Only the engine's own refusal belongs beside the statement; a host or network failure (or the conversation
  // writing) is about the act, above the form.
  const atStatement = refusal !== null && act.error?.kind === "refused" && refusedAt === "statement";
  const statementError = atStatement ? refusal.message : missing.includes("statement") ? askFor.statement : undefined;
  const offerGiven = givenOffered(state.mode, kind, atStatement);

  const recordAsGiven = () => {
    setKind("given");
    act.reset();
  };

  return (
    <DialogContent
      width="lg"
      onEscapeKeyDown={(e) => act.pending && e.preventDefault()}
      onPointerDownOutside={(e) => act.pending && e.preventDefault()}
      title={original ? `Change ${original.need_id}?` : "Add a technical need?"}
      description={
        original
          ? "Your change is saved here. The engineer gets it when you publish the technical needs. A changed statement becomes the need's next revision; a new why is not a new revision."
          : "Say what the product requires of whatever is built, in your own words and without naming technology. It is saved here; the engineer gets it when you publish the technical needs."
      }
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={act.pending}>Not now</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="need-form" loading={act.pending}>
            {original ? `Save ${original.need_id}` : "Add the need"}
          </Button>
        </>
      }
    >
      <form id="need-form" onSubmit={save} noValidate className="flex flex-col gap-5 pb-1">
        {refusal && !atStatement ? (
          <Banner tone="danger" live="assertive" title={original ? `${original.need_id} was not changed` : "The need was not added"} actions={refusal.hint ? <HintAction hint={refusal.hint} /> : undefined}>
            <span className="whitespace-pre-line">{refusal.message}</span>
          </Banner>
        ) : null}
        {original ? null : (
          <Field label="Kind of need" hint="Which of the six questions it answers.">
            <Select
              value={kind}
              onValueChange={(value) => {
                setKind(value as NeedKind);
                setMissing([]);
                act.reset();
              }}
              options={kindOrder.map((k) => ({ value: k, label: kindNames[k] }))}
            />
          </Field>
        )}
        <Field
          label="Statement"
          hint={
            who
              ? "What was decided outside this product. A given may name a technology, since someone else decided it."
              : "One or two sentences about what the product requires, without naming a technology. For example: “About five hundred staff use it from three offices, busiest on Monday mornings.”"
          }
          error={statementError ? <span className="whitespace-pre-line">{statementError}</span> : undefined}
        >
          <Textarea editorial rows={2} maxLength={limits.statement} value={draft.statement} onChange={(e) => edit("statement")(e.target.value)} />
        </Field>
        {offerGiven ? (
          <div className="-mt-2 flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={recordAsGiven}>
              Record it as a given instead
            </Button>
            <span className="text-body-sm text-ink-muted">A given says who decided it and when.</span>
          </div>
        ) : null}
        <Field label="Why it matters" hint="One sentence the engineer reads beside it." error={missing.includes("why") ? askFor.why : undefined}>
          <Input value={draft.why} maxLength={limits.why} onChange={(e) => edit("why")(e.target.value)} autoComplete="off" />
        </Field>
        {who ? (
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,11rem)] gap-4 max-[640px]:grid-cols-1">
            <Field label="Who said it" hint="A person's name or role, or a policy pack." error={missing.includes("said_by") ? askFor.said_by : undefined}>
              <Input value={draft.said_by} maxLength={limits.said_by} onChange={(e) => edit("said_by")(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="When" hint="The date it was said." error={missing.includes("said_on") ? askFor.said_on : undefined}>
              <Input type="date" value={draft.said_on} onChange={(e) => edit("said_on")(e.target.value)} />
            </Field>
          </div>
        ) : null}
        {nothingChanged ? (
          <p role="status" className="text-body-sm text-ink-muted">
            Nothing has changed yet. Change the statement or the why, or close this without saving.
          </p>
        ) : null}
        {atStatement ? (
          <p className="sr-only" role="alert">
            {original ? `${original.need_id} was not changed.` : "The need was not added."} The reason is under the statement.
          </p>
        ) : null}
      </form>
    </DialogContent>
  );
}
