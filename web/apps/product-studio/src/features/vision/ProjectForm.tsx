import { useId, useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";
import { Banner, Button, Field, HintAction, Input, Textarea, toast } from "@mach/ui";
import type { OperationResult } from "@mach/ui/api";
import { useEngineAct } from "../../api/act";
import { projectIdFrom } from "../home/start/model";
import { rememberProjectStart } from "../../api/projectStart";
import { projectStartNote } from "../../shared/team";

/* ── Outcomes ────────────────────────────────────────────────────────── */

export function OutcomesEditor({ outcomes, onChange, error, sectionId }: { outcomes: string[]; onChange: (next: string[]) => void; error?: string | null; sectionId?: string }) {
  const id = useId();
  return (
    <fieldset id={sectionId} className="flex scroll-mt-6 flex-col gap-2" aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}>
      <legend className="text-label text-ink">Intended outcomes</legend>
      <p id={`${id}-hint`} className="-mt-0.5 text-body-sm text-ink-muted">
        What people will be able to do, or what will be true, because of the product.
      </p>
      <ol className="flex flex-col gap-2">
        {outcomes.map((outcome, index) => (
          <li key={index} className="flex items-center gap-2">
            <Input
              aria-label={`Outcome ${index + 1}`}
              value={outcome}
              onChange={(e) => onChange(outcomes.map((o, i) => (i === index ? e.target.value : o)))}
              placeholder={index === 0 ? "For example: Teams can work together" : "Another outcome"}
            />
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Remove outcome ${index + 1}`}
              disabled={outcomes.length === 1}
              onClick={() => onChange(outcomes.filter((_, i) => i !== index))}
            >
              <X aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ol>
      <Button size="sm" variant="ghost" className="self-start" onClick={() => onChange([...outcomes, ""])}>
        <Plus aria-hidden="true" />
        Add an outcome
      </Button>
      {error ? (
        <p id={`${id}-error`} className="text-body-sm text-danger-ink">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export const cleanList = (list: string[]) => list.map((s) => s.trim()).filter(Boolean);

/* ── Create ──────────────────────────────────────────────────────────── */

/**
 * Naming the product: its name, vision and outcomes, and the project ID proposed from the name (`project.init`). The
 * person writes every word; nothing here fills them in. Used by the Vision screen and, inside a way to start, at the
 * point where that way needs the project to exist (making the drafts from a PRD or an idea, picking up a request).
 */
export function ProjectCreator({
  onCreated,
  submitLabel = "Create the project",
  createdNote = "It is a draft in your workspace. Add its epics next.",
  doneVerb = "Created",
}: {
  onCreated?: (result: OperationResult<"project.init">) => void;
  submitLabel?: string;
  createdNote?: string;
  /** The toast's verb, the past tense of the button's own act: "Created" for "Create the project", "Named" for "Name the product". */
  doneVerb?: string;
}) {
  const act = useEngineAct();
  const [name, setName] = useState("");
  const [vision, setVision] = useState("");
  const [outcomes, setOutcomes] = useState<string[]>([""]);
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const projectId = idTouched ? id : projectIdFrom(name);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Give the product a name.";
    if (!vision.trim()) next.vision = "Write the vision: one sentence about what the product is for.";
    if (!cleanList(outcomes).length) next.outcomes = "Add at least one outcome.";
    if (!projectId) next.id = "Give the project an ID: lowercase words joined by hyphens.";
    setErrors(next);
    if (Object.keys(next).length) return;
    const result = await act.run("project.init", { id: projectId, name: name.trim(), vision: vision.trim(), outcome: cleanList(outcomes) });
    if (!result) return;
    // M20: the repository already had a project on GitHub (its words were taken, not these), or GitHub was not checked.
    // The page moves on at once, so the note is kept for the next page as well as said here.
    const note = projectStartNote(result);
    rememberProjectStart(note);
    if (note?.kind === "taken") toast({ tone: "info", title: `Took ${result.project.name} from GitHub`, description: note.note });
    else toast({ tone: "success", title: `${doneVerb} ${result.project.name}`, description: note ? `${createdNote} ${note.note}` : createdNote });
    onCreated?.(result);
  };

  return (
    <form onSubmit={submit} noValidate aria-label="Name the product" className="flex max-w-[40rem] flex-col gap-6">
      <Field label="Name" error={errors.name}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="For example, Team Space" />
      </Field>
      <Field label="Vision" hint="One sentence: what changes for people when this product exists." error={errors.vision}>
        <Textarea editorial rows={3} value={vision} onChange={(e) => setVision(e.target.value)} placeholder="For example: Teams work together without friction." />
      </Field>
      <OutcomesEditor outcomes={outcomes} onChange={setOutcomes} error={errors.outcomes} />
      <Field label="Project ID" hint="Used in file names and links. Proposed from the name; it cannot be changed later." error={errors.id}>
        <Input
          className="font-mono"
          value={projectId}
          onChange={(e) => {
            setIdTouched(true);
            setId(e.target.value);
          }}
        />
      </Field>
      {act.shown ? (
        <Banner
          tone="danger"
          live="assertive"
          title={act.error?.kind === "refused" ? "The project was not defined" : act.shown.title}
          actions={act.shown.hint ? <HintAction hint={act.shown.hint} /> : undefined}
        >
          <span className="whitespace-pre-line">{act.shown.message}</span>
        </Banner>
      ) : null}
      <p className="max-w-reading text-body-sm text-ink-muted">
        A repository holds one project. If this one already has a project on GitHub, MACH uses its name, vision and outcomes instead of these, and tells you.
      </p>
      <div>
        <Button variant="primary" size="lg" type="submit" loading={act.pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
