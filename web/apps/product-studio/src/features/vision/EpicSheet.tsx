import { useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";
import { Banner, Button, Field, Input, Sheet, SheetClose, SheetContent, Text, toast, type Epic, type StatusEpicRow, HintAction } from "@mach/ui";
import { useEngineAct } from "../../api/act";

/**
 * Acceptance criteria the app has seen this visit (from epic.add and epic.set results). Engines from
 * M5 wave 3 report them in `status`; this is the fallback for older ones.
 */
const criteriaSeen = new Map<string, string[]>();
export const knownCriteria = (epicId: string) => criteriaSeen.get(epicId) ?? null;
const remember = (epic: Epic) => criteriaSeen.set(epic.epic_id, epic.acceptance_criteria);

export type EpicSheetState = { mode: "add" } | { mode: "edit"; epic: StatusEpicRow } | null;

export function EpicSheet({ state, onClose }: { state: EpicSheetState; onClose: () => void }) {
  // The body mounts each time the sheet opens, so its fields start from the epic.
  return (
    <Sheet open={state !== null} onOpenChange={(open) => !open && onClose()}>
      {state ? <EpicSheetBody state={state} onClose={onClose} /> : null}
    </Sheet>
  );
}

function EpicSheetBody({ state, onClose }: { state: NonNullable<EpicSheetState>; onClose: () => void }) {
  const act = useEngineAct();
  const editing = state?.mode === "edit" ? state.epic : null;
  const known = editing ? (editing.acceptance_criteria ?? knownCriteria(editing.epic_id)) : null;
  const [title, setTitle] = useState(editing?.title ?? "");
  const [criteria, setCriteria] = useState<string[]>(known?.length ? known : [""]);
  const [replaceCriteria, setReplaceCriteria] = useState(state.mode === "add" || Boolean(known));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const list = criteria.map((c) => c.trim()).filter(Boolean);
    const next: Record<string, string> = {};
    if (!title.trim()) next.title = "Give the epic a title a stakeholder would recognise.";
    if (replaceCriteria && !list.length) next.criteria = "Add at least one criterion that says when this capability is done.";
    setErrors(next);
    if (Object.keys(next).length) return;
    if (!editing) {
      const result = await act.run("epic.add", { title: title.trim(), criterion: list });
      if (!result) return;
      remember(result.epic);
      toast({ tone: "success", title: `Added ${result.epic.epic_id}`, description: `${result.epic.title}. It is proposed until you approve it.` });
    } else {
      const result = await act.run("epic.set", {
        epic_id: editing.epic_id,
        ...(title.trim() !== editing.title ? { title: title.trim() } : {}),
        ...(replaceCriteria ? { criterion: list } : {}),
      });
      if (!result) return;
      remember(result.epic);
      toast({ tone: "success", title: `Saved ${result.epic.epic_id}`, description: result.epic.title });
    }
    onClose();
  };

  return (
      <SheetContent
        onEscapeKeyDown={(e) => act.pending && e.preventDefault()}
        onPointerDownOutside={(e) => act.pending && e.preventDefault()}
        width={480}
        title={editing ? `Edit ${editing.epic_id}` : "Add an epic"}
        description={
          editing
            ? editing.status === "approved"
              ? "This epic is approved. Changing it keeps the approval; check that its slices still fit."
              : "Changes are saved to your draft."
            : "A capability several slices will deliver. It starts as proposed; you approve it when its scope is right."
        }
        footer={
          <>
            <SheetClose asChild>
              <Button disabled={act.pending}>Cancel</Button>
            </SheetClose>
            <Button variant="primary" type="submit" form="epic-form" loading={act.pending}>
              {editing ? "Save epic" : "Add epic"}
            </Button>
          </>
        }
      >
        <form id="epic-form" onSubmit={submit} noValidate className="flex flex-col gap-6">
          <Field label="Title" hint="A capability a stakeholder would recognise." error={errors.title}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example, Team membership" />
          </Field>
          {replaceCriteria ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-label text-ink">Acceptance criteria</legend>
              <p className="-mt-0.5 text-body-sm text-ink-muted">Each says something that is true when the whole capability is done.</p>
              <ol className="flex flex-col gap-2">
                {criteria.map((criterion, index) => (
                  <li key={index} className="flex items-center gap-2">
                    <Input
                      aria-label={`Criterion ${index + 1}`}
                      value={criterion}
                      onChange={(e) => setCriteria(criteria.map((c, i) => (i === index ? e.target.value : c)))}
                      placeholder={index === 0 ? "For example: Only invited people can join" : "Another criterion"}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove criterion ${index + 1}`}
                      disabled={criteria.length === 1}
                      onClick={() => setCriteria(criteria.filter((_, i) => i !== index))}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ol>
              <Button size="sm" variant="ghost" className="self-start" onClick={() => setCriteria([...criteria, ""])}>
                <Plus aria-hidden="true" />
                Add a criterion
              </Button>
              {errors.criteria ? <p className="text-body-sm text-danger-ink">{errors.criteria}</p> : null}
            </fieldset>
          ) : (
            <div className="flex flex-col items-start gap-2 rounded-md bg-surface-sunken px-4 py-3">
              <Text size="body-sm">The current acceptance criteria are kept as they are.</Text>
              <Text size="body-sm" tone="muted">
                This screen cannot show them yet. Writing new criteria replaces the whole list.
              </Text>
              <Button size="sm" onClick={() => setReplaceCriteria(true)}>
                Write new criteria
              </Button>
            </div>
          )}
          {act.shown ? (
            <Banner tone="danger" live="assertive" title={act.shown.title} actions={act.shown.hint ? <HintAction hint={act.shown.hint} /> : undefined}>
              <span className="whitespace-pre-line">{act.shown.message}</span>
            </Banner>
          ) : null}
        </form>
      </SheetContent>
  );
}
