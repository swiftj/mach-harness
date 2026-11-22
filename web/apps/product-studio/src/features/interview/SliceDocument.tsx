import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight, CircleAlert } from "lucide-react";
import {
  ArtifactId,
  Badge,
  Button,
  CheckPill,
  DiagnosticList,
  ErrorState,
  Heading,
  OpenQuestionList,
  SkeletonText,
  SliceStatusPill,
  Spinner,
  Text,
  cn,
  describeError,
  diagnostics,
  plain,
  plural,
  specModel,
} from "@mach/ui";
import type { SliceShow, SpecModel } from "@mach/ui/api";
import { type SliceShowState } from "../../api/useSliceShow";
import { matrixCell } from "../spec/SpecSections";
import { SectionNav, type SectionNavItem } from "../../shared/layout/SectionNav";
import { ScrollRegion, WorkPane } from "../../shared/layout/WorkScreen";
import { docSections } from "./model";
import { SmallChangeLabel } from "../small-change/SmallChangeLabel";

/** Every identifier in the draft: requirements, rules, decision rules, examples. */
function idsOf(model: Partial<SpecModel> | null): string[] {
  if (!model) return [];
  return [
    ...(model.invariants ?? []).map((i) => i.id),
    ...(model.functional_requirements ?? []).map((r) => r.id),
    ...(model.decision_matrix?.rules ?? []).map((r) => r.id),
    ...(model.scenarios ?? []).map((s) => s.id),
  ];
}

/**
 * Which identifiers appeared with the latest read of the draft. Only a comparison of two engine
 * reads in this window: nothing is marked on the first read, and the marks stay until the next change.
 */
function useJustAdded(data: SliceShow | null): Set<string> {
  const ids = idsOf(data ? specModel(data) : null);
  const signature = ids.join(" ");
  const [track, setTrack] = useState<{ signature: string | null; ids: string[]; added: Set<string> }>({ signature: null, ids: [], added: new Set() });
  if (data && signature !== track.signature) {
    const before = new Set(track.ids);
    setTrack({ signature, ids, added: track.signature === null ? new Set() : new Set(ids.filter((id) => !before.has(id))) });
  }
  return track.added;
}

/**
 * Beside the question: the slice as it builds up, set as a document to read. Everything here is the
 * engine's own read of the draft (`slice.show`), reloaded whenever the host reports a write; what
 * appeared with the latest write is marked "New".
 *
 * M16 layout: the top of the column keeps the slice's state and the list of the document's sections in view (each
 * with its findings or what is new in it, and a way to jump there); the document scrolls below them on its own.
 */
export function SliceSoFar({ sliceId, show, epicTitle }: { sliceId: string; show: SliceShowState; epicTitle: string | null }) {
  const added = useJustAdded(show.data);
  const data = show.data;
  const sections: SectionNavItem[] = data
    ? docSections(diagnostics(data.check), specModel(data), data.check.open_questions.length, added).map((s) => ({
        id: `${s.id}-section`,
        label: s.label,
        note:
          s.note === null ? undefined : (
            <span className={cn("shrink-0 text-caption font-semibold", s.note.kind === "problems" ? "text-danger-ink" : s.note.kind === "new" ? "text-accent-ink" : "text-warning-ink")}>
              {s.note.kind === "problems" ? plural(s.note.count, "problem") : `${s.note.count} ${s.note.kind}`}
            </span>
          ),
      }))
    : [];
  const head = data ? (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Heading level={2} size="title-3" id="doc-check">
          Check
        </Heading>
        <SliceStatusPill status={data.slice.status} size="sm" />
        <SmallChangeLabel slice={data.slice} />
        <CheckPill check={data.check} status={data.slice.status} size="sm" />
        <span className="flex items-center gap-1.5 text-caption text-ink-subtle" role="status">
          {show.loading ? (
            <>
              <Spinner size="sm" />
              Updating
            </>
          ) : null}
        </span>
      </div>
      {sections.length ? (
        // Two columns of sections, so the document below keeps most of the height.
        <div className="-mx-2">
          <SectionNav label="Sections of the slice so far" title="In the slice so far" items={sections} columns={2} />
        </div>
      ) : null}
    </div>
  ) : undefined;
  return (
    <WorkPane side as="aside" label="The slice so far" header={head}>
      <SliceDocument sliceId={sliceId} show={show} epicTitle={epicTitle} added={added} />
    </WorkPane>
  );
}

function SliceDocument({ sliceId, show, epicTitle, added }: { sliceId: string; show: SliceShowState; epicTitle: string | null; added: Set<string> }) {
  if (!show.data && show.loading) {
    return (
      <div role="status" aria-busy="true" aria-label="Reading the draft">
        <SkeletonText lines={8} />
      </div>
    );
  }
  if (!show.data) {
    const described = show.error ? describeError(show.error) : { title: "Could not read the draft", message: "" };
    return (
      <ErrorState
        icon={<CircleAlert />}
        title={show.error?.kind === "refused" ? "Could not read the draft" : described.title}
        message={show.error?.kind === "refused" ? show.error.message : described.message}
        hint={show.error?.hint}
        action={
          <Button size="sm" onClick={show.reload}>
            Try again
          </Button>
        }
      />
    );
  }

  const data = show.data;
  const check = data.check;
  const model = specModel(data);
  const problems = diagnostics(check);
  const openQuestions = model?.open_questions?.length ? model.open_questions : check.open_questions.map((question) => ({ question, follow_up: null }));
  const matrix = model?.decision_matrix;
  const written = idsOf(model).length > 0;

  return (
    <article aria-labelledby="doc-title" className="flex flex-col gap-7" aria-busy={show.loading || undefined}>
      <header className="flex flex-col gap-2">
        <p className="flex flex-wrap items-center gap-2 text-caption text-ink-subtle">
          <ArtifactId>{sliceId}</ArtifactId>
          {epicTitle ? <span>in {epicTitle}</span> : null}
        </p>
        <Heading level={2} size="title-1" id="doc-title">
          {data.slice.title}
        </Heading>
        {model?.summary?.outcome ? <p className="text-body-lg text-ink-muted">{model.summary.outcome}</p> : null}
      </header>

      {problems.length ? (
        <section aria-labelledby="doc-found" className="flex flex-col gap-2 rounded-md border border-line bg-canvas px-4 py-3">
          <Heading level={3} size="title-3" id="doc-found" className="text-body">
            What MACH&apos;s check found
          </Heading>
          <Text size="caption" tone="subtle">
            The interviewer proposes; this is what MACH checked in your draft.
          </Text>
          <div className="flex flex-col gap-1.5">
            <DiagnosticList items={problems.slice(0, 4)} compact />
            {problems.length > 4 ? (
              <Text size="caption" tone="muted">
                And {problems.length - 4} more on the specification page.
              </Text>
            ) : null}
          </div>
        </section>
      ) : null}

      {!written ? (
        <Text tone="subtle">Nothing written yet. The interviewer writes the specification once the questions are settled.</Text>
      ) : null}

      {model?.invariants?.length ? (
        <DocSection id="doc-rules" title="What must always be true">
          <ul className="flex flex-col gap-2.5">
            {model.invariants.map((item) => (
              <Statement key={item.id} id={item.id} isNew={added.has(item.id)}>
                {plain(item.text)}
              </Statement>
            ))}
          </ul>
        </DocSection>
      ) : null}

      {model?.functional_requirements?.length ? (
        <DocSection id="doc-reqs" title="What it does">
          <ul className="flex flex-col gap-2.5">
            {model.functional_requirements.map((item) => (
              <Statement key={item.id} id={item.id} isNew={added.has(item.id)}>
                {plain(item.text)}
              </Statement>
            ))}
          </ul>
        </DocSection>
      ) : null}

      {matrix && matrix.rules.length ? (
        <DocSection id="doc-cases" title="Every case">
          <ScrollRegion framed label="Every case, scrolls sideways when narrow" className="rounded-md">
            <table className="w-full border-collapse text-left text-body-sm">
              <thead>
                <tr className="border-b border-line bg-surface-sunken">
                  {matrix.conditions.map((c) => (
                    <th key={c.name} scope="col" className="px-3 py-2 text-label text-ink-muted">
                      {c.name}
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2 text-label text-ink-muted">
                    Result
                  </th>
                </tr>
              </thead>
              <tbody>
                {matrix.rules.map((rule) => (
                  <tr key={rule.id} className={cn("border-b border-line align-top last:border-b-0", added.has(rule.id) && "bg-accent-soft")}>
                    {matrix.conditions.map((c) => {
                      const cell = matrixCell(rule.conditions[c.name] ?? [], c.values);
                      return (
                        <td key={c.name} className={cn("px-3 py-2", cell.any ? "text-ink-subtle" : "text-ink")}>
                          {cell.text}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-ink">
                      {rule.expected_outcome}
                      {added.has(rule.id) ? <NewMark /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </DocSection>
      ) : null}

      {model?.scenarios?.length ? (
        <DocSection id="doc-examples" title="Examples to prove it">
          <ul className="flex flex-col gap-3">
            {model.scenarios.map((s) => (
              <Statement key={s.id} id={s.id} isNew={added.has(s.id)}>
                <span className="font-semibold">{s.title}</span>
                <span className="mt-1 flex flex-col gap-0.5 text-body-sm text-ink-muted">
                  {s.steps.map((step, index) => (
                    <span key={index} className={cn(step.keyword === "And" && "pl-4")}>
                      <span className="font-semibold text-ink">{step.keyword}</span> {step.text}
                    </span>
                  ))}
                </span>
              </Statement>
            ))}
          </ul>
        </DocSection>
      ) : null}

      {openQuestions.length ? (
        <DocSection id="doc-open" title="Still open">
          <OpenQuestionList items={openQuestions} compact />
        </DocSection>
      ) : null}

      {model?.assumptions?.length ? (
        <DocSection id="doc-assumptions" title="Assumed">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-ink">
            {model.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </DocSection>
      ) : null}

      <Button variant="link" asChild className="self-start">
        <Link to={`/slices/${sliceId}`}>
          Open the full specification
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </article>
  );
}

function DocSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={`${id}-section`} aria-labelledby={id} className="flex scroll-mt-6 flex-col gap-3">
      <Heading level={3} size="title-3" id={id}>
        {title}
      </Heading>
      {children}
    </section>
  );
}

function NewMark() {
  return (
    <Badge tone="accent" className="ml-2 align-middle">
      New
    </Badge>
  );
}

/** One identified statement; one that appeared with the latest write carries a bar and the word "New". */
function Statement({ id, isNew, children }: { id: string; isNew: boolean; children: ReactNode }) {
  return (
    <li className={cn("grid grid-cols-[4.25rem_minmax(0,1fr)] gap-3 border-l-2 pl-3", isNew ? "border-accent" : "border-transparent")}>
      <span className="pt-0.5">
        <ArtifactId>{id}</ArtifactId>
      </span>
      <span className="flex min-w-0 flex-col text-body text-ink">
        {children}
        {isNew ? (
          <span className="mt-1">
            <NewMark />
          </span>
        ) : null}
      </span>
    </li>
  );
}
