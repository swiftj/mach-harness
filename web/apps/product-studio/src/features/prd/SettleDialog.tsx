import { useState, type FormEvent } from "react";
import { CircleAlert } from "lucide-react";
import { Button, Dialog, DialogClose, DialogContent, Field, HintAction, Select, Textarea, toast } from "@mach/ui";
import type { PrdCoverageRow, PrdMapSlice } from "@mach/ui/api";
import { useEngineAct } from "../../api/act";
import { settleArgs, type Quotation, type SettleChoice, type SettleForm } from "./model";
import { PrdQuote, linesLabel } from "./parts";

interface SettleDialogProps {
  prdId: string;
  /** The section being settled; null when the dialog is closed. */
  section: PrdCoverageRow | null;
  quotations: Quotation[];
  slices: PrdMapSlice[];
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

/**
 * Settle one section no slice cites (`prd.settle`), on the product manager's word: part of a slice,
 * out of scope, or later, with their reason. The engine records it or refuses in its own words.
 */
export function SettleDialog(props: SettleDialogProps) {
  return (
    <Dialog open={props.section !== null} onOpenChange={props.onOpenChange}>
      {props.section ? <SettleBody key={props.section.n} {...props} section={props.section} /> : null}
    </Dialog>
  );
}

const CHOICES: Array<{ value: SettleChoice; label: string; description: string }> = [
  { value: "slice", label: "Part of a slice", description: "Its lines join that slice's citations." },
  { value: "out-of-scope", label: "Out of scope", description: "Nothing will be built from it." },
  { value: "later", label: "Later", description: "Left for a later PRD or slice." },
];

function SettleBody({ prdId, section, quotations, slices, onOpenChange, onDone }: SettleDialogProps & { section: PrdCoverageRow }) {
  const act = useEngineAct();
  const [form, setForm] = useState<SettleForm>({ choice: "", slice: "", reason: "" });
  const [missing, setMissing] = useState<string | null>(null);
  const formId = `settle-section-${section.n}`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const built = settleArgs(prdId, section.n, form);
    if ("missing" in built) {
      setMissing(built.missing);
      return;
    }
    const result = await act.run("prd.settle", built.args);
    if (!result) return;
    toast({ tone: "success", title: `Settled section ${section.n}`, description: result.note });
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
      title={`Settle section ${section.n}, “${section.title}”?`}
      description="No slice cites this section. Say what it is: part of a slice, out of scope, or later. Nothing is made until you make the drafts."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={act.pending}>Not now</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form={formId} loading={act.pending}>
            Settle section {section.n}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <p className="text-body-sm text-ink-muted">{linesLabel(section.lines)} of the document:</p>
          <PrdQuote prdId={prdId} quotations={quotations} />
        </div>
        <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="This section is" error={missing && form.choice === "" ? missing : null}>
            <Select
              value={form.choice}
              onValueChange={(value) => update({ choice: value as SettleChoice })}
              placeholder="Choose what it is"
              options={CHOICES.map((c) => ({ value: c.value, label: c.label, description: c.description }))}
            />
          </Field>
          {form.choice === "slice" ? (
            <Field label="Slice" hint="A slice on this PRD's map." error={missing && !form.slice ? missing : null}>
              <Select
                value={form.slice}
                onValueChange={(value) => update({ slice: value })}
                placeholder="Choose a slice"
                options={slices.map((s) => ({ value: s.key, label: `${s.key}: ${s.title}`, description: s.scope }))}
              />
            </Field>
          ) : null}
          <Field label="Why" optional hint="In your own words. Kept with the map, never sent to GitHub.">
            <Textarea rows={2} value={form.reason} onChange={(e) => update({ reason: e.target.value })} maxLength={500} />
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
