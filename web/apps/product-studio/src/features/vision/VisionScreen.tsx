import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useLocation } from "react-router";
import { CircleAlert, Plus, X } from "lucide-react";
import { ArtifactId, Banner, Button, EpicStatusPill, ErrorState, Field, Heading, Input, Skeleton, SkeletonText, Text, Textarea, cn, describeError, plural, toast, type Status, type StatusEpicRow, HintAction } from "@mach/ui";
import { useEngineAct } from "../../api/act";
import { useStatus } from "../../api/store";
import { IssueNumber } from "../../shared/IssueLink";
import { Fold } from "../../shared/layout/Fold";
import { SectionNav } from "../../shared/layout/SectionNav";
import { ContextRow, OnePane, WorkPane, WorkPanes, WorkScreen } from "../../shared/layout/WorkScreen";
import { EpicSheet, knownCriteria } from "./EpicSheet";
import { NewSliceDialog } from "../roadmap/NewSliceDialog";

const LEAD =
  "What the product is for and what people will get from it. Changes are saved to your draft; the project's issue on GitHub follows the next time you mark a slice ready.";

/**
 * Vision and outcomes, laid out as a document (docs/mach-next/M16_LAYOUT.md): the project's name, vision and outcomes,
 * then its epics, in the wide pane; the list of those sections and the writing guidance in the narrow pane beside them.
 * The epic sheet and every act are unchanged.
 */
export function VisionScreen() {
  const status = useStatus();
  if (!status.data && !status.error) {
    return (
      <WorkScreen header={<ContextRow title="Vision" />}>
        <OnePane label="Vision">
          <div role="status" aria-busy="true" aria-label="Reading the project" className="flex max-w-reading flex-col gap-5">
            <Skeleton className="h-10 w-72" />
            <SkeletonText lines={3} />
            <Skeleton className="h-36 w-full" />
          </div>
        </OnePane>
      </WorkScreen>
    );
  }
  if (!status.data) {
    const { title, message } = describeError(status.error!);
    return (
      <WorkScreen header={<ContextRow title="Vision" />}>
        <OnePane label="Vision" width="reading">
          <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={() => void status.reload()}>Try again</Button>} />
        </OnePane>
      </WorkScreen>
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

  const project = status.project;
  if (!project) {
    return (
      <WorkScreen header={<ContextRow title="Define the project" about="Start with what the product is for. You can refine every part of this later." aboutLabel="About this page" />}>
        <WorkPanes>
          <WorkPane label="The project">
            <ProjectCreator />
          </WorkPane>
          <WorkPane side label="Writing guidance">
            <Guidance items={projectGuidance} />
          </WorkPane>
        </WorkPanes>
      </WorkScreen>
    );
  }

  return (
    <WorkScreen
      header={
        <ContextRow
          identity={
            <>
              <ArtifactId>{project.project_id}</ArtifactId>
              <span>{project.name}</span>
              {project.issue ? <IssueNumber number={project.issue} url={project.url} /> : null}
            </>
          }
          title="Vision and outcomes"
          about={LEAD}
          aboutLabel="About this page"
        />
      }
    >
      <WorkPanes>
        <WorkPane label="Vision, outcomes and epics">
          <div className="flex max-w-[44rem] flex-col gap-12">
            <ProjectEditor key={JSON.stringify([project.name, project.vision, project.outcomes, project.revision])} status={status} />
            <Epics status={status} />
          </div>
        </WorkPane>
        <WorkPane side label="Sections and writing guidance">
          <div className="flex flex-col gap-8">
            <SectionNav
              label="Sections of the project"
              items={[
                { id: "vision-section-vision", label: "Name and vision" },
                { id: "vision-section-outcomes", label: "Intended outcomes" },
                { id: "epics", label: "Epics", note: <span className="shrink-0 text-caption tabular text-ink-subtle">{plural(status.epics.length, "epic")}</span> },
              ]}
            />
            <Guidance items={projectGuidance} />
          </div>
        </WorkPane>
      </WorkPanes>
    </WorkScreen>
  );
}

/* ── Guidance ────────────────────────────────────────────────────────── */

function Guidance({ items }: { items: Array<{ title: string; body: string }> }) {
  return (
    <aside className="flex flex-col gap-5" aria-label="Writing guidance">
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

function OutcomesEditor({ outcomes, onChange, error, sectionId }: { outcomes: string[]; onChange: (next: string[]) => void; error?: string | null; sectionId?: string }) {
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
    <form onSubmit={submit} noValidate aria-label="Define the project" className="flex max-w-[40rem] flex-col gap-6">
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
  );
}

/* ── Edit ────────────────────────────────────────────────────────────── */

function ProjectEditor({ status }: { status: Status }) {
  const project = status.project!;
  const act = useEngineAct();
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
    if (result) toast({ tone: "success", title: "Saved the project", description: "Your draft is updated. The project's issue on GitHub follows the next time you mark a slice ready." });
  };

  const discard = () => {
    setName(project.name);
    setVision(project.vision);
    setOutcomes(project.outcomes.length ? project.outcomes : [""]);
    setErrors({});
    act.reset();
  };

  return (
    <form id="vision-section-vision" onSubmit={save} noValidate aria-label="The project" className="flex scroll-mt-6 flex-col gap-6">
      <Field label="Name" error={errors.name}>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Vision" hint="One sentence: what changes for people when this product exists." error={errors.vision}>
        <Textarea editorial rows={3} value={vision} onChange={(e) => setVision(e.target.value)} />
      </Field>
      <OutcomesEditor sectionId="vision-section-outcomes" outcomes={outcomes} onChange={setOutcomes} error={errors.outcomes} />
      {act.shown ? (
        <Banner tone="danger" live="assertive" title={act.shown.title} actions={act.shown.hint ? <HintAction hint={act.shown.hint} /> : undefined}>
          <span className="whitespace-pre-line">{act.shown.message}</span>
        </Banner>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
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
  );
}

/* ── Epics ───────────────────────────────────────────────────────────── */

function Epics({ status }: { status: Status }) {
  const [sheet, setSheet] = useState<{ mode: "add" } | { mode: "edit"; epic: StatusEpicRow } | null>(null);
  const [newSlice, setNewSlice] = useState<string | null>(null);
  const act = useEngineAct();
  const slicesOf = useMemo(() => {
    const map = new Map<string, Status["slices"]>();
    for (const s of status.slices) map.set(s.epic_id, [...(map.get(s.epic_id) ?? []), s]);
    return map;
  }, [status.slices]);

  const setEpicStatus = async (epic: StatusEpicRow, next: StatusEpicRow["status"]) => {
    const result = await act.run("epic.set", { epic_id: epic.epic_id, status: next });
    if (result) toast({ tone: "success", title: next === "deferred" ? `Set ${epic.epic_id} aside` : `Brought back ${epic.epic_id}`, description: epic.title });
  };

  return (
    <section id="epics" aria-labelledby="epics-title" className="flex scroll-mt-6 flex-col gap-4 border-t border-line-strong pt-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex max-w-reading flex-col gap-1">
          <Heading level={2} id="epics-title">
            Epics
          </Heading>
          <Text size="body-sm" tone="muted">
            The larger capabilities that make up the product. Each holds the slices of intent that deliver it; you mark each slice ready to build on its own.
          </Text>
        </div>
        <Button size="sm" onClick={() => setSheet({ mode: "add" })}>
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
              <li key={epic.epic_id} className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2 py-5", epic.status === "deferred" && "opacity-70")}>
                <div className="flex min-w-0 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <ArtifactId>{epic.epic_id}</ArtifactId>
                    <Heading level={3} className="min-w-0">
                      {epic.title}
                    </Heading>
                    <EpicStatusPill status={epic.status} size="sm" />
                    {epic.issue ? <IssueNumber number={epic.issue} url={epic.url} /> : null}
                  </div>
                  <Text size="body-sm" tone="muted">
                    {slices.length ? `Slices: ${slices.map((s) => s.title).join(", ")}.` : "No slices yet."}
                  </Text>
                  {criteria?.length ? (
                    <Fold label={`Done when: ${plural(criteria.length, "criterion", "criteria")}`}>
                      <ul className="flex flex-col gap-0.5 pl-6">
                        {criteria.map((c) => (
                          <li key={c} className="text-body-sm text-ink-muted">
                            {c}
                          </li>
                        ))}
                      </ul>
                    </Fold>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-start justify-end gap-2">
                  <Button size="sm" onClick={() => setNewSlice(epic.epic_id)}>
                    Start a slice
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSheet({ mode: "edit", epic })}>
                    Edit
                  </Button>
                  {epic.status === "deferred" ? (
                    <Button size="sm" variant="ghost" onClick={() => void setEpicStatus(epic, "open")} disabled={act.pending}>
                      Bring back
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => void setEpicStatus(epic, "deferred")} disabled={act.pending}>
                      Set aside
                    </Button>
                  )}
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
      <NewSliceDialog open={newSlice !== null} onOpenChange={(open) => !open && setNewSlice(null)} epics={status.epics} epicId={newSlice} />
    </section>
  );
}
