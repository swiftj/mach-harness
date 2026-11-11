import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router";
import { CircleAlert, Plus, X } from "lucide-react";
import { ArtifactId, Banner, Button, EpicStatusPill, ErrorState, Field, Heading, Input, Page, Skeleton, SkeletonText, SourceBadge, Text, Textarea, cn, describeError, toast, type Status, type StatusEpicRow, HintAction } from "@mach/ui";
import { useEngineAct } from "../../api/act";
import { useRefresh, useStatus } from "../../api/store";
import { fieldWords } from "../../api/describe";
import { ApproveEpicDialog } from "./ApproveEpicDialog";
import { EpicSheet, knownCriteria } from "./EpicSheet";
import { NewSliceDialog } from "../roadmap/NewSliceDialog";

export function VisionScreen() {
  const status = useStatus();
  if (!status.data && !status.error) {
    return (
      <Page>
        <div role="status" aria-busy="true" aria-label="Reading the project" className="flex max-w-reading flex-col gap-5">
          <Skeleton className="h-10 w-72" />
          <SkeletonText lines={3} />
          <Skeleton className="h-36 w-full" />
        </div>
      </Page>
    );
  }
  if (!status.data) {
    const { title, message } = describeError(status.error!);
    return (
      <Page width="reading">
        <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={() => void status.reload()}>Try again</Button>} />
      </Page>
    );
  }
  return <Vision status={status.data} />;
}

function Vision({ status }: { status: Status }) {
  const location = useLocation();
  useEffect(() => {
    const focus = (location.state as { focus?: string } | null)?.focus;
    if (focus) document.getElementById(focus)?.scrollIntoView({ block: "start" });
  }, [location.state]);

  return (
    <Page>
      <div className="flex flex-col gap-14">
        {status.project ? (
          <ProjectEditor key={JSON.stringify([status.project.name, status.project.vision, status.project.outcomes, status.project.revision])} status={status} />
        ) : (
          <ProjectCreator />
        )}
        {status.project ? <Epics status={status} /> : null}
      </div>
    </Page>
  );
}

/* ── Guidance ────────────────────────────────────────────────────────── */

function Guidance({ items }: { items: Array<{ title: string; body: string }> }) {
  return (
    <aside className="flex flex-col gap-5 border-l border-line pl-6" aria-label="Writing guidance">
      {items.map((item) => (
        <div key={item.title} className="flex flex-col gap-1">
          <Text size="body-sm" weight="semibold">
            {item.title}
          </Text>
          <Text size="body-sm" tone="muted">
            {item.body}
          </Text>
        </div>
      ))}
    </aside>
  );
}

const projectGuidance = [
  { title: "A vision is one sentence", body: "Say what changes for people when the product exists, not how it works. “Teams work together without friction.”" },
  { title: "Outcomes are results for a person", body: "Each one should be observable: someone could tell whether it is true. “Admins stay in control of who has access”, not “Add an admin panel”." },
  { title: "No technology", body: "Engineering chooses how. The definition says what and why." },
];

/* ── Outcomes ────────────────────────────────────────────────────────── */

function OutcomesEditor({ outcomes, onChange, error }: { outcomes: string[]; onChange: (next: string[]) => void; error?: string | null }) {
  const id = useId();
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}>
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

const clean = (list: string[]) => list.map((s) => s.trim()).filter(Boolean);

/** A suggestion for the project ID from its name. The engine checks the ID; this only proposes one. */
const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/* ── Create ──────────────────────────────────────────────────────────── */

function ProjectCreator() {
  const act = useEngineAct();
  const [name, setName] = useState("");
  const [vision, setVision] = useState("");
  const [outcomes, setOutcomes] = useState<string[]>([""]);
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const projectId = idTouched ? id : slug(name);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Give the product a name.";
    if (!vision.trim()) next.vision = "Write the vision: one sentence about what the product is for.";
    if (!clean(outcomes).length) next.outcomes = "Add at least one outcome.";
    if (!projectId) next.id = "Give the project an ID: lowercase words joined by hyphens.";
    setErrors(next);
    if (Object.keys(next).length) return;
    const result = await act.run("project.init", { id: projectId, name: name.trim(), vision: vision.trim(), outcome: clean(outcomes) });
    if (result) toast({ tone: "success", title: `Created ${result.project.name}`, description: "It is a draft in your workspace. Add its epics next." });
  };

  return (
    <section aria-labelledby="create-title" className="grid grid-cols-[minmax(0,640px)_minmax(220px,300px)] gap-12">
      <form onSubmit={submit} noValidate className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Heading level={1} id="create-title">
            Define the project
          </Heading>
          <Text editorial size="body-lg" tone="muted">
            Start with what the product is for. You can refine every part of this later.
          </Text>
        </div>
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
          <Banner tone="danger" live="assertive" title={act.shown.title} actions={act.shown.hint ? <HintAction hint={act.shown.hint} /> : undefined}>
            <span className="whitespace-pre-line">{act.shown.message}</span>
          </Banner>
        ) : null}
        <div>
          <Button variant="primary" size="lg" type="submit" loading={act.pending}>
            Create the project
          </Button>
        </div>
      </form>
      <Guidance items={projectGuidance} />
    </section>
  );
}

/* ── Edit ────────────────────────────────────────────────────────────── */

function ProjectEditor({ status }: { status: Status }) {
  const project = status.project!;
  const act = useEngineAct();
  const refresh = useRefresh();
  const [name, setName] = useState(project.name);
  const [vision, setVision] = useState(project.vision);
  const [outcomes, setOutcomes] = useState<string[]>(project.outcomes.length ? project.outcomes : [""]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // The parent remounts this editor (by key) when the saved project changes, so it starts from it.
  const changed = {
    name: name.trim() !== project.name,
    vision: vision.trim() !== project.vision,
    outcomes: JSON.stringify(clean(outcomes)) !== JSON.stringify(project.outcomes),
  };
  const dirty = changed.name || changed.vision || changed.outcomes;
  const source = project.source ?? (status.needs_reconciling.conflicts.includes("product/project.json") ? "conflict" : undefined);
  const conflict = source === "conflict" || source === "collision";
  const sharedUpdate = refresh.data?.updated.find((u) => u.path === "product/project.json");

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "The product needs a name.";
    if (!vision.trim()) next.vision = "The vision cannot be empty.";
    if (!clean(outcomes).length) next.outcomes = "Keep at least one outcome.";
    setErrors(next);
    if (Object.keys(next).length) return;
    const result = await act.run("project.set", {
      ...(changed.name ? { name: name.trim() } : {}),
      ...(changed.vision ? { vision: vision.trim() } : {}),
      ...(changed.outcomes ? { outcome: clean(outcomes) } : {}),
    });
    if (result) toast({ tone: "success", title: "Saved the project", description: "Your draft is updated. Others see it once a wave that includes it is accepted." });
  };

  const discard = () => {
    setName(project.name);
    setVision(project.vision);
    setOutcomes(project.outcomes.length ? project.outcomes : [""]);
    setErrors({});
    act.reset();
  };

  return (
    <section aria-labelledby="project-title" className="grid grid-cols-[minmax(0,640px)_minmax(220px,300px)] gap-12">
      <form onSubmit={save} noValidate className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Heading level={1} id="project-title">
              Vision
            </Heading>
            <ArtifactId>{project.project_id}</ArtifactId>
            {source ? <SourceBadge source={source} showDraft /> : null}
          </div>
          <Text editorial size="body-lg" tone="muted">
            What the product is for and what people will get from it. Changes are saved to your draft; others see them once they are accepted.
          </Text>
          {source === "published" ? (
            <Text size="body-sm" tone="muted">
              This is the version in the shared project. Saving a change makes it your draft until it is sent and accepted.
            </Text>
          ) : source === "draft" ? (
            <Text size="body-sm" tone="muted">
              Only in your workspace: not yet in the shared project.
            </Text>
          ) : null}
        </div>
        {conflict ? (
          <Banner tone="warning" title="The project changed here and in the shared project" actions={<Button size="sm" asChild><Link to="/inbox">Settle it</Link></Button>}>
            Choose which version stands on the Decisions screen. Saving here changes only your draft.
          </Banner>
        ) : sharedUpdate ? (
          <Banner tone="info" title="Updated from the shared project">
            Another product manager’s accepted change arrived: {(sharedUpdate.fields ?? sharedUpdate.changed ?? []).map(fieldWords).join(", ") || "the project"}.
          </Banner>
        ) : null}
        <Field label="Name" error={errors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Vision" hint="One sentence: what changes for people when this product exists." error={errors.vision}>
          <Textarea editorial rows={3} value={vision} onChange={(e) => setVision(e.target.value)} />
        </Field>
        <OutcomesEditor outcomes={outcomes} onChange={setOutcomes} error={errors.outcomes} />
        {act.shown ? (
          <Banner tone="danger" live="assertive" title={act.shown.title} actions={act.shown.hint ? <HintAction hint={act.shown.hint} /> : undefined}>
            <span className="whitespace-pre-line">{act.shown.message}</span>
          </Banner>
        ) : null}
        <div className="flex items-center gap-3">
          <Button variant="primary" type="submit" loading={act.pending} disabled={!dirty}>
            Save changes
          </Button>
          <Button variant="ghost" onClick={discard} disabled={!dirty || act.pending}>
            Discard changes
          </Button>
          <Text as="span" size="body-sm" tone="muted" aria-live="polite">
            {dirty ? `Unsaved: ${[changed.name && "name", changed.vision && "vision", changed.outcomes && "outcomes"].filter(Boolean).join(", ")}` : `Revision ${project.revision}`}
          </Text>
        </div>
      </form>
      <Guidance items={projectGuidance} />
    </section>
  );
}

/* ── Epics ───────────────────────────────────────────────────────────── */

function Epics({ status }: { status: Status }) {
  const [sheet, setSheet] = useState<{ mode: "add" } | { mode: "edit"; epic: StatusEpicRow } | null>(null);
  const [approve, setApprove] = useState<StatusEpicRow | null>(null);
  const [newSlice, setNewSlice] = useState<string | null>(null);
  const act = useEngineAct();
  const slicesOf = useMemo(() => {
    const map = new Map<string, Status["slices"]>();
    for (const s of status.slices) map.set(s.epic_id, [...(map.get(s.epic_id) ?? []), s]);
    return map;
  }, [status.slices]);

  const setEpicStatus = async (epic: StatusEpicRow, next: "deferred" | "proposed") => {
    const result = await act.run("epic.set", { epic_id: epic.epic_id, status: next });
    if (result) toast({ tone: "success", title: next === "deferred" ? `Set ${epic.epic_id} aside` : `Brought back ${epic.epic_id}`, description: epic.title });
  };

  return (
    <section id="epics" aria-labelledby="epics-title" className="flex scroll-mt-6 flex-col gap-5">
      <div className="flex items-end justify-between gap-6 border-b border-line pb-3">
        <div className="flex max-w-reading flex-col gap-1">
          <Heading level={2} id="epics-title">
            Epics
          </Heading>
          <Text tone="muted">The larger capabilities that make up the product. Approving an epic lets its slices be approved.</Text>
        </div>
        <Button variant="primary" onClick={() => setSheet({ mode: "add" })}>
          <Plus aria-hidden="true" />
          Add an epic
        </Button>
      </div>
      {act.shown ? (
        <Banner tone="danger" live="assertive" title={act.shown.title} actions={act.shown.hint ? <HintAction hint={act.shown.hint} /> : undefined}>
          <span className="whitespace-pre-line">{act.shown.message}</span>
        </Banner>
      ) : null}
      {status.epics.length ? (
        <ul className="flex flex-col divide-y divide-line">
          {status.epics.map((epic) => {
            const slices = slicesOf.get(epic.epic_id) ?? [];
            const criteria = epic.acceptance_criteria ?? knownCriteria(epic.epic_id);
            return (
              <li key={epic.epic_id} className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2 py-5", epic.status === "superseded" && "opacity-70")}>
                <div className="flex min-w-0 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <ArtifactId>{epic.epic_id}</ArtifactId>
                    <Heading level={3} className="min-w-0">
                      {epic.title}
                    </Heading>
                    <EpicStatusPill status={epic.status} size="sm" />
                    <SourceBadge source={epic.source} showDraft />
                  </div>
                  {criteria ? (
                    <ul className="flex flex-col gap-0.5 pl-0.5">
                      {criteria.map((c) => (
                        <li key={c} className="text-body-sm text-ink-muted">
                          {c}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <Text size="body-sm" tone="muted">
                    {slices.length ? `Slices: ${slices.map((s) => s.title).join(", ")}.` : "No slices yet."}
                  </Text>
                </div>
                <div className="flex flex-wrap items-start justify-end gap-2">
                  {epic.status === "proposed" ? (
                    <Button size="sm" variant="primary" onClick={() => setApprove(epic)}>
                      Approve {epic.epic_id}
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => setNewSlice(epic.epic_id)} disabled={epic.status === "superseded" || epic.status === "completed"}>
                    Start a slice
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSheet({ mode: "edit", epic })}>
                    Edit
                  </Button>
                  {epic.status === "proposed" ? (
                    <Button size="sm" variant="ghost" onClick={() => void setEpicStatus(epic, "deferred")} disabled={act.pending}>
                      Set aside
                    </Button>
                  ) : epic.status === "deferred" ? (
                    <Button size="sm" variant="ghost" onClick={() => void setEpicStatus(epic, "proposed")} disabled={act.pending}>
                      Bring back
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-line-strong px-6 py-6">
          <Text weight="semibold">No epics yet</Text>
          <Text tone="muted" className="max-w-reading">
            An epic is a capability a stakeholder would recognise, such as “Team membership”, with a few criteria that say when it is done.
          </Text>
          <Button variant="primary" onClick={() => setSheet({ mode: "add" })}>
            Add the first epic
          </Button>
        </div>
      )}

      <EpicSheet state={sheet} onClose={() => setSheet(null)} />
      <ApproveEpicDialog
        epic={approve}
        sliceTitles={approve ? (slicesOf.get(approve.epic_id) ?? []).map((s) => `${s.slice_id} ${s.title}`) : []}
        onOpenChange={(open) => !open && setApprove(null)}
      />
      <NewSliceDialog open={newSlice !== null} onOpenChange={(open) => !open && setNewSlice(null)} epics={status.epics} epicId={newSlice} />
    </section>
  );
}
