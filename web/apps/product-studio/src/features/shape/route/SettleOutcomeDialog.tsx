import { useState, type FormEvent } from "react";
import { CircleAlert } from "lucide-react";
import { Button, Dialog, DialogClose, DialogContent, Field, HintAction, Select, Textarea, toast } from "@mach/ui";
import type { ShapeCoverageRow, ShapeMapSlice } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { REASON_MAX, REASON_NEEDED, settleArgs, type SettleChoice, type SettleForm } from "./model";

interface SettleOutcomeDialogProps {
  ideaId: string;
  /** The outcome being settled; null when the dialog is closed. */
  outcome: ShapeCoverageRow | null;
  /** The brief's words for it, shown as text; null when the brief as read does not have them. */
  outcomeText: string | null;
  slices: ShapeMapSlice[];
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

/**
 * Settle one outcome no slice carries (`idea.settle`), on the product manager's word: part of a slice, out of scope,
 * or later, with their reason. The engine records it or refuses in its own words. Modelled on the PRD on-ramp's
 * settle dialog (features/prd/SettleDialog.tsx), with outcomes in place of sections.
 */
export function SettleOutcomeDialog(props: SettleOutcomeDialogProps) {
  return (
    <Dialog open={props.outcome !== null} onOpenChange={props.onOpenChange}>
      {props.outcome ? <SettleBody key={props.outcome.outcome} {...props} outcome={props.outcome} /> : null}
    </Dialog>
  );
}

const CHOICES: Array<{ value: SettleChoice; label: string; description: string }> = [
  { value: "slice", label: "Part of a slice", description: "That slice carries it too." },
  { value: "out-of-scope", label: "Out of scope", description: "Nothing will be built for it from this idea." },
  { value: "later", label: "Later", description: "Left for later work." },
];

function SettleBody({ ideaId, outcome, outcomeText, slices, onOpenChange, onDone }: SettleOutcomeDialogProps & { outcome: ShapeCoverageRow }) {
  const act = useEngineAct();
  const [form, setForm] = useState<SettleForm>({ choice: "", slice: "", reason: "" });
  const [missing, setMissing] = useState<string | null>(null);
  const formId = `settle-outcome-${outcome.outcome}`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const built = settleArgs(ideaId, outcome.outcome, form);
    if ("missing" in built) {
      setMissing(built.missing);
      return;
    }
    const result = await act.run("idea.settle", built.args);
    if (!result) return;
    toast({ tone: "success", title: `Settled ${outcome.outcome}`, description: result.note });
    onOpenChange(false);
    onDone();
  };

  const update = (next: Partial<SettleForm>) => {
    setForm((f) => ({ ...f, ...next }));
    setMissing(null);
  };

  return (
    <DialogContent
      width="lg"
      onEscapeKeyDown={(e) => act.pending && e.preventDefault()}
      onPointerDownOutside={(e) => act.pending && e.preventDefault()}
      title={`Settle ${outcome.outcome}?`}
      description="No slice on the map carries this outcome. Say what it is: part of a slice, out of scope, or later. Nothing is made until you make the drafts."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={act.pending}>Not now</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form={formId} loading={act.pending}>
            Settle {outcome.outcome}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {outcomeText ? (
          <div className="flex flex-col gap-1">
            <p className="text-body-sm text-ink-muted">{outcome.outcome} in the brief:</p>
            <p className="rounded-sm border-l-2 border-line-strong bg-surface-sunken px-3 py-2 text-body-sm whitespace-pre-wrap break-words text-ink">{outcomeText}</p>
          </div>
        ) : null}
        <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="This outcome is" error={missing && form.choice === "" ? missing : null}>
            <Select
              value={form.choice}
              onValueChange={(value) => update({ choice: value as SettleChoice })}
              placeholder="Choose what it is"
              options={CHOICES.map((c) => ({ value: c.value, label: c.label, description: c.description }))}
            />
          </Field>
          {form.choice === "slice" ? (
            <Field label="Slice" hint="A slice on this idea's map." error={missing && !form.slice ? missing : null}>
              <Select
                value={form.slice}
                onValueChange={(value) => update({ slice: value })}
                placeholder="Choose a slice"
                options={slices.map((s) => ({ value: s.key, label: `${s.key}: ${s.title}`, description: s.scope }))}
              />
            </Field>
          ) : null}
          <Field
            label="Why"
            optional={form.choice === "slice" || form.choice === ""}
            hint={
              form.choice === "out-of-scope" || form.choice === "later"
                ? "In your own words, on one line. Leaving an outcome out is your decision, so the map keeps why."
                : "In your own words, on one line. Kept with the map."
            }
            error={missing === REASON_NEEDED ? missing : null}
          >
            <Textarea rows={2} value={form.reason} onChange={(e) => update({ reason: e.target.value })} maxLength={REASON_MAX} />
          </Field>
        </form>
        {act.shown ? (
          <div role="alert" className="flex items-start gap-2.5 rounded-md border border-danger-line bg-danger-soft px-3 py-2.5">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-ink" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-label text-danger-ink">{act.error?.kind === "refused" ? "Not settled" : act.shown.title}</p>
              <p className="whitespace-pre-line text-body-sm text-ink">{act.shown.message}</p>
              <HintAction hint={act.shown.hint} />
            </div>
          </div>
        ) : null}
      </div>
    </DialogContent>
  );
}
