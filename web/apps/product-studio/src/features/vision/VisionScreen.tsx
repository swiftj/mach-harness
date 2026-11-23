import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocation } from "react-router";
import { CircleAlert, Plus } from "lucide-react";
import { ArtifactId, Banner, Button, EpicStatusPill, ErrorState, Field, Heading, Input, Skeleton, SkeletonText, Text, Textarea, cn, describeError, plural, toast, type Status, type StatusEpicRow, HintAction } from "@mach/ui";
import { useEngineAct } from "../../api/act";
import { useStatus } from "../../api/store";
import { IssueNumber } from "../../shared/IssueLink";
import { Fold } from "../../shared/layout/Fold";
import { SectionNav } from "../../shared/layout/SectionNav";
import { ContextRow, OnePane, WorkPane, WorkPanes, WorkScreen } from "../../shared/layout/WorkScreen";
import { EpicSheet, knownCriteria } from "./EpicSheet";
import { OutcomesEditor, ProjectCreator, cleanList } from "./ProjectForm";
import { NewSliceDialog } from "../roadmap/NewSliceDialog";
import type { StartAs } from "../small-change/model";
import { SharedTextChoice } from "../../shared/SharedTextChoice";
import { ProjectStartNotice } from "../../shared/ProjectStartNotice";
import { mineOf, sharedTextAnchor } from "../../shared/team";

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
    const target = focus ? document.getElementById(focus) : null;
    target?.scrollIntoView({ block: "start" });
    // A choice waiting for the person (M20) is focusable: "Carry on" leads to it, and the keyboard lands on it too.
    if (target?.getAttribute("tabindex") === "-1") target.focus({ preventScroll: true });
  }, [location.state]);

  const project = status.project;
  if (!project) {
    return (
      <WorkScreen header={<ContextRow title="Define the project" about="Start with what the product is for. You can refine every part of this later." />}>
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
        />
      }
    >
      <WorkPanes>
        <WorkPane label="Vision, outcomes and epics">
          <div className="flex max-w-[44rem] flex-col gap-12">
            <ProjectStartNotice />
            {/* M20: someone else changed the project on GitHub while this person changed it too: both versions, before the editor. */}
            {project.changed_elsewhere ? (
              <SharedTextChoice id={sharedTextAnchor("project")} changed={project.changed_elsewhere} mine={mineOf(status, project.changed_elsewhere)} />
            ) : null}
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
    outcomes: JSON.stringify(cleanList(outcomes)) !== JSON.stringify(project.outcomes),
  };
  const dirty = changed.name || changed.vision || changed.outcomes;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "The product needs a name.";
    if (!vision.trim()) next.vision = "The vision cannot be empty.";
    if (!cleanList(outcomes).length) next.outcomes = "Keep at least one outcome.";
    setErrors(next);
    if (Object.keys(next).length) return;
    const result = await act.run("project.set", {
      ...(changed.name ? { name: name.trim() } : {}),
      ...(changed.vision ? { vision: vision.trim() } : {}),
      ...(changed.outcomes ? { outcome: cleanList(outcomes) } : {}),
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
  const [newSlice, setNewSlice] = useState<{ epicId: string; start?: StartAs } | null>(null);
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
                {epic.changed_elsewhere ? (
                  // M20: the epic's title or criteria changed on GitHub by someone else and here too; full width, under the epic.
                  <SharedTextChoice
                    id={sharedTextAnchor(epic.epic_id)}
                    className="order-last col-span-2 mt-2"
                    level={4}
                    changed={epic.changed_elsewhere}
                    mine={mineOf(status, epic.changed_elsewhere)}
                  />
                ) : null}
                <div className="flex flex-wrap items-start justify-end gap-2">
                  <Button size="sm" onClick={() => setNewSlice({ epicId: epic.epic_id })}>
                    Start a slice
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setNewSlice({ epicId: epic.epic_id, start: "small" })}>
                    Start a small change
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
      <NewSliceDialog open={newSlice !== null} onOpenChange={(open) => !open && setNewSlice(null)} epics={status.epics} epicId={newSlice?.epicId} start={newSlice?.start} />
    </section>
  );
}
