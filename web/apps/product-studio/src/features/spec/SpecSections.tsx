import type { ReactNode } from "react";
import { ArtifactId, Badge, Heading, StateGlyph, Text, cn } from "@mach/ui";
import { patternNames, sectionTitles, type Diagnostic, type SectionId, type SpecModel, type WhyDocument } from "./specModel";
import { inline, plain } from "./text";

/** One section of the specification, with the engine's diagnostics about it shown first. */
export function SpecSection({
  id,
  hint,
  diagnostics = [],
  children,
  aside,
}: {
  id: SectionId;
  hint?: ReactNode;
  diagnostics?: Diagnostic[];
  children: ReactNode;
  aside?: ReactNode;
}) {
  const headingId = `section-${id}-title`;
  return (
    <section id={`section-${id}`} aria-labelledby={headingId} className="flex scroll-mt-6 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Heading level={2} size="title-2" id={headingId}>
          {sectionTitles[id]}
        </Heading>
        {aside}
      </div>
      {hint ? <Text size="body-sm" tone="muted" className="-mt-2 max-w-reading">{hint}</Text> : null}
      {diagnostics.length ? <DiagnosticList items={diagnostics} /> : null}
      {children}
    </section>
  );
}

export function DiagnosticList({ items, compact = false }: { items: Diagnostic[]; compact?: boolean }) {
  return (
    <ul className={cn("flex flex-col gap-1.5", !compact && "rounded-md border border-danger-line bg-danger-soft px-3 py-2.5")}>
      {items.map((d, index) => (
        <li key={index} className="flex items-start gap-2 text-body-sm text-ink">
          <span className={cn("mt-0.5 shrink-0", d.severity === "error" || d.severity === "why" ? "text-danger-ink" : "text-warning-ink")}>
            <StateGlyph shape={d.severity === "error" || d.severity === "why" ? "blocked" : "half"} />
          </span>
          <span className="min-w-0">
            {d.message}
            {d.line ? <span className="ml-1.5 text-caption text-ink-subtle">line {d.line}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Missing({ children }: { children: ReactNode }) {
  return <Text size="body-sm" tone="subtle" className="italic">{children}</Text>;
}

function IdList({ ids }: { ids: string[] }) {
  if (!ids.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.map((id) => (
        <ArtifactId key={id}>{id}</ArtifactId>
      ))}
    </span>
  );
}

export function SummarySection({ model, diagnostics }: { model: SpecModel; diagnostics: Diagnostic[] }) {
  const rows: Array<[string, string | undefined]> = [
    ["Who", model.summary?.actor],
    ["When", model.summary?.trigger],
    ["Outcome", model.summary?.outcome],
  ];
  return (
    <SpecSection id="summary" diagnostics={diagnostics}>
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-md border border-line bg-surface px-5 py-4">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-label text-ink-muted">{label}</dt>
            <dd className="font-serif text-body-lg text-ink">{value ?? <Missing>Not stated.</Missing>}</dd>
          </div>
        ))}
      </dl>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-4">
        <TextList title="In this slice" items={model.in_scope} empty="Nothing listed." />
        <TextList title="Left for later slices" items={model.out_of_scope} empty="Nothing deferred." />
        <TextList title="Must already be true" items={model.preconditions} empty="No preconditions." />
      </div>
    </SpecSection>
  );
}

function TextList({ title, items, empty }: { title: string; items?: string[]; empty: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Heading level={3} size="title-3" className="text-body font-semibold">
        {title}
      </Heading>
      {items && items.length ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-body text-ink">
          {items.map((item, index) => (
            <li key={index}>{inline(item)}</li>
          ))}
        </ul>
      ) : (
        <Missing>{empty}</Missing>
      )}
    </div>
  );
}

function RequirementRow({ id, label, text }: { id: string; label?: string; text: string }) {
  return (
    <li id={`req-${id}`} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 border-t border-line px-1 py-3 first:border-t-0">
      <span className="pt-0.5">
        <ArtifactId>{id}</ArtifactId>
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        {label ? <span className="text-caption text-ink-subtle">{label}</span> : null}
        <p className="text-body text-ink">{plain(text)}</p>
      </div>
    </li>
  );
}

export function RulesSection({ model, diagnostics }: { model: SpecModel; diagnostics: Diagnostic[] }) {
  const items = model.invariants ?? [];
  return (
    <SpecSection id="rules" hint="Business limits the product must never break, whatever happens." diagnostics={diagnostics} aside={<Badge>{items.length}</Badge>}>
      {items.length ? (
        <ul className="rounded-md border border-line bg-surface px-4">
          {items.map((item) => (
            <RequirementRow key={item.id} id={item.id} text={item.text} />
          ))}
        </ul>
      ) : (
        <Missing>No rules in the draft.</Missing>
      )}
    </SpecSection>
  );
}

export function RequirementsSection({ model, diagnostics }: { model: SpecModel; diagnostics: Diagnostic[] }) {
  const items = model.functional_requirements ?? [];
  return (
    <SpecSection id="requirements" hint="What the product does, including every refusal and the exact words people see." diagnostics={diagnostics} aside={<Badge>{items.length}</Badge>}>
      {items.length ? (
        <ul className="rounded-md border border-line bg-surface px-4">
          {items.map((item) => (
            <RequirementRow key={item.id} id={item.id} label={item.pattern ? (patternNames[item.pattern] ?? item.pattern) : undefined} text={item.text} />
          ))}
        </ul>
      ) : (
        <Missing>No requirements in the draft.</Missing>
      )}
    </SpecSection>
  );
}

export function DecisionTableSection({ model, diagnostics }: { model: SpecModel; diagnostics: Diagnostic[] }) {
  const matrix = model.decision_matrix;
  return (
    <SpecSection id="decision-table" hint="Every combination of conditions and what happens in it. “Any” means the condition does not matter for that row." diagnostics={diagnostics}>
      {matrix && matrix.rules.length ? (
        // A scrollable region must be reachable by keyboard (WCAG 2.1.1; axe scrollable-region-focusable).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div className="overflow-x-auto rounded-md border border-line bg-surface" tabIndex={0} role="region" aria-label="Decision table, scrolls sideways when narrow">
          <table className="w-full min-w-[44rem] border-collapse text-left text-body-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken">
                <th scope="col" className="px-3 py-2 text-label text-ink-muted">
                  Rule
                </th>
                {matrix.conditions.map((c) => (
                  <th key={c.name} scope="col" className="px-3 py-2 text-label text-ink-muted">
                    {c.name}
                  </th>
                ))}
                <th scope="col" className="px-3 py-2 text-label text-ink-muted">
                  What happens
                </th>
                <th scope="col" className="px-3 py-2 text-label text-ink-muted">
                  Also
                </th>
              </tr>
            </thead>
            <tbody>
              {matrix.rules.map((rule) => (
                <tr key={rule.id} className="border-b border-line align-top last:border-b-0">
                  <th scope="row" className="px-3 py-2.5 font-normal">
                    <ArtifactId>{rule.id}</ArtifactId>
                  </th>
                  {matrix.conditions.map((c) => {
                    const values = rule.conditions[c.name] ?? [];
                    const any = values.length > 1 && values.length >= c.values.length;
                    return (
                      <td key={c.name} className={cn("px-3 py-2.5", any ? "text-ink-subtle" : "text-ink")}>
                        {any ? "Any" : values.join(" or ")}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2.5 text-ink">{rule.expected_outcome}</td>
                  <td className="px-3 py-2.5 text-ink-muted">{rule.side_effects}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Missing>No decision table in the draft.</Missing>
      )}
    </SpecSection>
  );
}

export function ScenariosSection({ model, diagnostics }: { model: SpecModel; diagnostics: Diagnostic[] }) {
  const items = model.scenarios ?? [];
  return (
    <SpecSection id="scenarios" hint="Concrete examples engineering will test, with real-looking data." diagnostics={diagnostics} aside={<Badge>{items.length}</Badge>}>
      {items.length ? (
        <ol className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-3">
          {items.map((s) => (
            <li key={s.id} className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-surface px-4 py-3">
              <div className="flex items-start gap-2">
                <ArtifactId>{s.id}</ArtifactId>
                <p className="text-label text-ink">{s.title}</p>
              </div>
              <ul className="flex flex-col gap-1 text-body-sm text-ink">
                {s.steps.map((step, index) => (
                  <li key={index} className={cn(step.keyword === "And" && "pl-4")}>
                    <span className="font-semibold">{step.keyword}</span> {step.text}
                  </li>
                ))}
              </ul>
              {s.covers.length ? (
                <p className="flex flex-wrap items-center gap-1.5 text-caption text-ink-subtle">
                  Shows <IdList ids={s.covers} />
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <Missing>No examples in the draft.</Missing>
      )}
    </SpecSection>
  );
}

export function DependenciesSection({ model, diagnostics, dependsOn }: { model: SpecModel; diagnostics: Diagnostic[]; dependsOn: string[] }) {
  const deps = model.external_dependencies ?? [];
  return (
    <SpecSection id="dependencies" diagnostics={diagnostics}>
      <dl className="grid grid-cols-[12rem_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-md border border-line bg-surface px-5 py-4 text-body">
        <dt className="text-label text-ink-muted">Outside services</dt>
        <dd className="text-ink">
          {deps.length ? (
            <ul className="flex flex-col gap-1">
              {deps.map((d) => (
                <li key={d.name}>
                  {d.name}
                  {d.failure_requirements.length ? (
                    <span className="ml-2 inline-flex items-center gap-1 text-caption text-ink-subtle">
                      if it fails: <IdList ids={d.failure_requirements} />
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <Missing>None.</Missing>
          )}
        </dd>
        <dt className="text-label text-ink-muted">Who may do it</dt>
        <dd className="text-ink">{model.required_permissions || <Missing>Not stated.</Missing>}</dd>
        <dt className="text-label text-ink-muted">Slices it builds on</dt>
        <dd className="text-ink">{dependsOn.length ? <IdList ids={dependsOn} /> : <Missing>None.</Missing>}</dd>
      </dl>
    </SpecSection>
  );
}

export function AssumptionsSection({ model, diagnostics }: { model: SpecModel; diagnostics: Diagnostic[] }) {
  const assumptions = model.assumptions ?? [];
  const defaults = model.accepted_defaults ?? [];
  return (
    <SpecSection id="assumptions" hint="Decided without a firm answer from you. Check them before approving." diagnostics={diagnostics}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] gap-4">
        <div className="flex flex-col gap-1.5">
          <Heading level={3} size="title-3" className="text-body font-semibold">
            Assumptions
          </Heading>
          {assumptions.length ? (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-body text-ink">
              {assumptions.map((a, i) => (
                <li key={i}>{inline(a)}</li>
              ))}
            </ul>
          ) : (
            <Missing>None.</Missing>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Heading level={3} size="title-3" className="text-body font-semibold">
            Common defaults you accepted
          </Heading>
          {defaults.length ? (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-body text-ink">
              {defaults.map((d, i) => (
                <li key={i}>
                  {d.default} <IdList ids={d.requirements} />
                </li>
              ))}
            </ul>
          ) : (
            <Missing>None.</Missing>
          )}
        </div>
      </div>
    </SpecSection>
  );
}

export function OpenQuestionsSection({ model, fallback, diagnostics }: { model: SpecModel | null; fallback: string[]; diagnostics: Diagnostic[] }) {
  const items = model?.open_questions?.length ? model.open_questions : fallback.map((question) => ({ question, follow_up: null }));
  return (
    <SpecSection id="open-questions" hint="Questions nobody could answer yet. A slice with open questions cannot be approved." diagnostics={diagnostics} aside={<Badge tone={items.length ? "warning" : "neutral"}>{items.length}</Badge>}>
      {items.length ? <OpenQuestionList items={items} /> : <Missing>None. Every question is settled.</Missing>}
    </SpecSection>
  );
}

export function OpenQuestionList({ items, compact = false }: { items: Array<{ question: string; follow_up?: string | null }>; compact?: boolean }) {
  return (
    <ul className={cn("flex flex-col", compact ? "gap-2" : "gap-2.5")}>
      {items.map((item, index) => (
        <li key={index} className={cn("flex items-start gap-2.5", !compact && "rounded-md border border-warning-line bg-surface px-4 py-3")}>
          <span className="mt-1 shrink-0 text-warning-ink">
            <StateGlyph shape="half" />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className={cn("text-ink", compact ? "text-body-sm" : "text-body")}>{item.question}</p>
            {item.follow_up ? <p className="text-caption text-ink-muted">Who can answer: {item.follow_up}</p> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function WhySection({ why, diagnostics }: { why: WhyDocument | null; diagnostics: Diagnostic[] }) {
  return (
    <SpecSection id="why" hint="The problem this slice solves and where it fits. Written by the interviewer from your answers." diagnostics={diagnostics}>
      {why?.exists && why.sections?.length ? (
        <div className="flex flex-col gap-5 rounded-md border border-line bg-surface px-5 py-4">
          {why.sections.map((section) => (
            <div key={section.heading} className="flex flex-col gap-1.5">
              <Heading level={3} size="title-3">
                {section.heading}
              </Heading>
              {Object.keys(section.fields).length ? (
                <dl className="grid grid-cols-[10rem_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                  {Object.entries(section.fields).map(([label, value]) => (
                    <div key={label} className="contents">
                      <dt className="text-label text-ink-muted">{label}</dt>
                      <dd className="font-serif text-body-lg text-ink">{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="font-serif text-body-lg text-ink">{section.text.replace(/^-\s*/gm, "")}</p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Missing>The slice's why has not been written yet.</Missing>
      )}
    </SpecSection>
  );
}
