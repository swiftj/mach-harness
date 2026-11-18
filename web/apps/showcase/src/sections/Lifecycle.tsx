import {
  ArtifactId,
  EpicStatusPill,
  SliceGithubPills,
  SliceLifecycle,
  SliceStatusPill,
  StateGlyph,
  builderStates,
  epicStates,
  githubMarks,
  sliceStates,
  toneClasses,
  type SliceStatus,
} from "@mach/ui";
import { Section, Specimen } from "../layout";
import { fx } from "../fixtures";

export function Lifecycle() {
  const interviewing = fx.statusRich.slices.find((s) => s.status === "interviewing");
  const sliceExamples: Array<{ status: SliceStatus; source: string; open?: number }> = [
    { status: "draft", source: "slice.new.json" },
    { status: "interviewing", source: `status.rich.json (${interviewing?.slice_id ?? ""})`, open: interviewing?.open_questions },
    { status: "ready_for_approval", source: "status.slice-ready.json" },
    { status: "approved_for_engineering", source: "status.states.json" },
    { status: "superseded", source: "state table" },
  ];
  return (
    <Section
      id="lifecycle"
      title="Lifecycle"
      intro="A slice moves from draft to approved, and is marked ready to build. Then the builders take it, may ask a question, and ship it. Each state has a word, a shape and a tone, so it reads without colour."
    >
      <Specimen title="Slice lifecycle" note="Past steps are ticked, the current step is marked and announced as the current step, later steps are quiet.">
        <ul className="flex flex-col divide-y divide-line">
          {sliceExamples.map(({ status, source, open }) => (
            <li key={status} className="grid grid-cols-[210px_minmax(0,1fr)] items-center gap-6 py-4">
              <div className="flex flex-col items-start gap-1">
                <SliceStatusPill status={status} />
                <span className="font-mono text-caption text-ink-subtle">{source}</span>
              </div>
              <SliceLifecycle status={status} openQuestions={open} />
            </li>
          ))}
        </ul>
      </Specimen>

      <div className="grid grid-cols-2 gap-6">
        <Specimen title="Slice states">
          <StateTable rows={Object.entries(sliceStates).map(([key, d]) => ({ key, ...d }))} />
        </Specimen>
        <Specimen title="Epic states">
          <StateTable rows={Object.entries(epicStates).map(([key, d]) => ({ key, ...d }))} />
        </Specimen>
        <Specimen title="With the builders" note="Where a slice is once it is marked ready to build, as the engine read it from GitHub.">
          <StateTable rows={Object.entries(builderStates).map(([key, d]) => ({ key, ...d }))} />
        </Specimen>
        <Specimen title="Things to settle" note="What the engine reports about a slice's place on GitHub that needs the product manager.">
          <StateTable rows={Object.entries(githubMarks).map(([key, d]) => ({ key, ...d }))} />
        </Specimen>
      </div>

      <Specimen title="Where each slice stands" source="status.states.json" note="The slice's own state, then where it is with the builders and anything to settle. Only what the engine reported.">
        <ul className="flex flex-col divide-y divide-line">
          {fx.statusStates.epics.map((e) => (
            <li key={e.epic_id} className="grid grid-cols-[110px_1fr_auto] items-center gap-4 py-2">
              <ArtifactId>{e.epic_id}</ArtifactId>
              <span className="truncate text-body text-ink">
                {e.title}
                {e.issue ? <span className="ml-2 text-body-sm text-ink-muted">#{e.issue}</span> : null}
              </span>
              <EpicStatusPill status={e.status} size="sm" />
            </li>
          ))}
          {fx.statusStates.slices.map((s) => (
            <li key={s.slice_id} className="grid grid-cols-[110px_1fr_auto] items-center gap-4 py-2">
              <ArtifactId>{s.slice_id}</ArtifactId>
              <span className="truncate text-body text-ink">
                {s.title}
                {s.github.issue ? <span className="ml-2 text-body-sm text-ink-muted">#{s.github.issue}</span> : null}
              </span>
              <span className="flex flex-wrap justify-end gap-2">
                <SliceStatusPill status={s.status} size="sm" />
                <SliceGithubPills github={s.github} size="sm" />
              </span>
            </li>
          ))}
        </ul>
      </Specimen>
    </Section>
  );
}

function StateTable({ rows }: { rows: Array<{ key: string; label: string; description: string; tone: keyof typeof toneClasses; glyph: Parameters<typeof StateGlyph>[0]["shape"] }> }) {
  return (
    <dl className="flex flex-col gap-3">
      {rows.map((row) => (
        <div key={row.key} className="flex flex-col">
          <dt className="flex flex-wrap items-center gap-x-2 text-label text-ink">
            <span className={toneClasses[row.tone].ink}>
              <StateGlyph shape={row.glyph} />
            </span>
            {row.label} <span className="min-w-0 break-all font-mono text-caption font-normal text-ink-subtle">{row.key}</span>
          </dt>
          <dd className="pl-[22px] text-body-sm text-ink-muted">{row.description}</dd>
        </div>
      ))}
    </dl>
  );
}
