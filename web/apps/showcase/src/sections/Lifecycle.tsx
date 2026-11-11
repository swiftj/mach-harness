import {
  ArtifactId,
  EpicStatusPill,
  Quote,
  ReviewStatusPill,
  SliceLifecycle,
  SliceStatusPill,
  SourceBadge,
  StateGlyph,
  Text,
  WaveJourney,
  WaveStatusPill,
  epicStates,
  reviewStates,
  sliceStates,
  toneClasses,
  waveStates,
  type FeedbackWave,
  type SliceStatus,
  type WaveReviewStatus,
} from "@mach/ui";
import { Section, Specimen } from "../layout";
import { fx } from "../fixtures";

const remarkKind: Record<string, string> = {
  changes_requested: "asked for changes",
  comment: "commented",
  commented: "commented",
  approved: "approved",
};

const feedbackFixtures: Array<{ name: string; wave: FeedbackWave }> = [
  { name: "feedback.not-sent.json", wave: fx.feedbackNotSent.waves[0]! },
  { name: "feedback.waiting.json", wave: fx.feedbackWaiting.waves[0]! },
  { name: "feedback.changes-requested.json", wave: fx.feedbackChanges.waves[0]! },
  { name: "feedback.blocked-by-check.json", wave: fx.feedbackBlocked.waves[0]! },
  { name: "feedback.accepted.json", wave: fx.feedbackAccepted.waves[0]! },
];

const withoutFixture: WaveReviewStatus[] = ["Sent, pull request not opened", "Needs updating", "Accepted, waiting to merge", "Declined"];

export function Lifecycle() {
  const sliceExamples: Array<{ status: SliceStatus; source: string; open?: number }> = [
    { status: "draft", source: "slice.new.json" },
    { status: "interviewing", source: "status.conflicts.json (SLICE-002)", open: fx.statusConflicts.slices[1]?.open_questions },
    { status: "ready_for_approval", source: "status.slice-ready.json" },
    { status: "approved_for_engineering", source: "status.wave-approved.json" },
    { status: "superseded", source: "state table" },
  ];
  return (
    <Section
      id="lifecycle"
      title="Lifecycle"
      intro="A slice moves from draft to approved. A wave is approved, sent, reviewed and accepted. Each state has a word, a shape and a tone, so it reads without colour."
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

      <div className="grid grid-cols-3 gap-6">
        <Specimen title="Slice states">
          <StateTable rows={Object.entries(sliceStates).map(([key, d]) => ({ key, ...d }))} />
        </Specimen>
        <Specimen title="Epic states">
          <StateTable rows={Object.entries(epicStates).map(([key, d]) => ({ key, ...d }))} />
        </Specimen>
        <Specimen title="Wave states">
          <StateTable rows={Object.entries(waveStates).map(([key, d]) => ({ key, ...d }))} />
        </Specimen>
      </div>

      <Specimen title="Where an artifact stands" source="status.after-renumber.json" note="Compared with the shared project. A plain draft shows nothing; the rest say what they need.">
        <ul className="flex flex-col divide-y divide-line">
          {[...fx.statusAfterRenumber.epics.map((e) => ({ id: e.epic_id, title: e.title, source: e.source, pill: <EpicStatusPill status={e.status} size="sm" /> })),
            ...fx.statusAfterRenumber.slices.map((s) => ({ id: s.slice_id, title: s.title, source: s.source, pill: <SliceStatusPill status={s.status} size="sm" /> })),
            ...fx.statusAfterRenumber.waves.map((w) => ({ id: w.wave_id, title: `${w.slices.join(", ")}`, source: w.source, pill: <WaveStatusPill status={w.status} size="sm" /> })),
          ].map((row) => (
            <li key={row.id} className="grid grid-cols-[110px_1fr_auto_160px] items-center gap-4 py-2">
              <ArtifactId>{row.id}</ArtifactId>
              <span className="truncate text-body text-ink">{row.title}</span>
              {row.pill}
              <span className="flex justify-end">
                <SourceBadge source={row.source} showDraft />
              </span>
            </li>
          ))}
        </ul>
      </Specimen>

      <Specimen title="A wave through review" note="From the engine's feedback, one per fixture. Reviewer remarks are quotations: shown to the product manager, never acted on.">
        <ul className="flex flex-col gap-8">
          {feedbackFixtures.map(({ name, wave }) => (
            <li key={name} className="grid grid-cols-[1fr_220px] gap-6">
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2">
                  <ArtifactId>{wave.wave_id}</ArtifactId>
                  <Text as="span" size="body-sm" tone="muted">
                    {wave.slices.join(", ")}
                  </Text>
                </div>
                <WaveJourney status={wave.status} meaning={wave.meaning} />
                {wave.reviewer_remarks?.length ? (
                  <div className="flex flex-col gap-3 pl-1">
                    {wave.remarks_are_data ? (
                      <Text size="caption" tone="subtle">
                        Written by reviewers.
                      </Text>
                    ) : null}
                    {wave.reviewer_remarks.map((remark) => (
                      <Quote key={remark.said} from={remark.from ?? "A reviewer"} kind={remarkKind[remark.kind] ?? remark.kind}>
                        {remark.said}
                      </Quote>
                    ))}
                  </div>
                ) : null}
              </div>
              <span className="text-right font-mono text-caption text-ink-subtle">{name}</span>
            </li>
          ))}
        </ul>
      </Specimen>

      <Specimen title="Review states without a fixture yet" note="The engine can report these (collab.py) but no fixture records one. Shown from the state table so every state has a defined look.">
        <ul className="grid grid-cols-2 gap-x-8 gap-y-4">
          {withoutFixture.map((status) => (
            <li key={status} className="flex flex-col items-start gap-1.5">
              <ReviewStatusPill status={status} />
              <Text size="body-sm" tone="muted">
                {reviewStates[status].description}
              </Text>
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

