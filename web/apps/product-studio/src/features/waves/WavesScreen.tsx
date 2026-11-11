import { CircleAlert, Layers, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, Heading, Page, Skeleton, Text, describeError, type FeedbackWave, type StatusWaveRow, plural, HintAction } from "@mach/ui";
import { ChooseSlicesDialog } from "./ChooseSlicesDialog";
import { WaveCard } from "./WaveCard";
import { useDeliveryRead } from "./delivery/ops";
import { useDependencies } from "./useDependencies";

type Group = { key: string; title: string; hint: string; waves: StatusWaveRow[] };

export function WavesScreen() {
  const status = useDeliveryRead("status", {});
  const anySent = Boolean(status.data?.waves.some((w) => w.sent));
  const feedback = useDeliveryRead("feedback", anySent ? {} : null);
  const inWaves = status.data ? status.data.waves.filter((w) => w.status !== "superseded").flatMap((w) => w.slices) : [];
  const deps = useDependencies(inWaves);
  const [choosing, setChoosing] = useState<{ waveId: string | null; preselected: string[] } | null>(null);

  if (status.loading && !status.data) {
    return (
      <Page>
        <div role="status" aria-busy="true" aria-label="Reading your delivery waves" className="flex flex-col gap-4">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-5 w-[32rem] max-w-full" />
          <Skeleton className="mt-4 h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </Page>
    );
  }
  if (!status.data) {
    const { title, message } = status.error ? describeError(status.error) : { title: "Nothing to show", message: "" };
    return (
      <Page width="reading">
        <ErrorState icon={<CircleAlert />} title={`Delivery waves could not be read. ${title}`} message={message} action={<Button onClick={status.reload}>Try again</Button>} />
      </Page>
    );
  }

  const data = status.data;
  const reviews = new Map<string, FeedbackWave>((feedback.data?.waves ?? []).map((w) => [w.wave_id, w]));
  const approvedSlices = data.slices.filter((s) => s.status === "approved_for_engineering");
  const waiting = approvedSlices.filter((s) => !data.waves.some((w) => w.status !== "superseded" && w.slices.includes(s.slice_id)));
  const unsettled = data.needs_reconciling.conflicts.length + data.needs_reconciling.collisions.length;

  const groups: Group[] = [
    { key: "draft", title: "Being prepared", hint: "Draft waves. Change them freely, then approve.", waves: data.waves.filter((w) => w.status === "draft") },
    {
      key: "ready",
      title: "Approved, not sent",
      hint: "Approved by you and still in your workspace. Send each when you are ready.",
      waves: data.waves.filter((w) => w.status === "approved_for_engineering" && !w.sent),
    },
    { key: "sent", title: "With engineering", hint: "Sent for review.", waves: data.waves.filter((w) => w.sent && w.status === "approved_for_engineering") },
    { key: "superseded", title: "Superseded", hint: "Replaced by later waves. Kept for history.", waves: data.waves.filter((w) => w.status === "superseded") },
  ].filter((g) => g.waves.length > 0);

  const startNew = (preselected: string[] = []) => setChoosing({ waveId: null, preselected });

  return (
    <Page>
      <div className="flex flex-col gap-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex max-w-reading flex-col gap-2">
            <Heading level={1}>Delivery waves</Heading>
            <Text tone="muted">
              Group approved slices into waves that engineering receives together. Approving a wave and sending it are separate steps: approval
              keeps it in your workspace; sending makes it visible to engineering.
            </Text>
          </div>
          {data.waves.length ? (
            <Button onClick={() => startNew()}>
              <Plus aria-hidden="true" />
              New wave
            </Button>
          ) : null}
        </header>

        {unsettled ? (
          <Banner
            tone="warning"
            title={`${plural(unsettled, "item")} in your workspace ${unsettled === 1 ? "needs" : "need"} a decision`}
            actions={
              <Button size="sm" asChild>
                <Link to="/inbox">Open Decisions</Link>
              </Button>
            }
          >
            A wave that contains them can't be sent until you settle them.
          </Banner>
        ) : null}

        {feedback.error ? (
          <Banner
            tone="info"
            title="Review progress could not be checked just now"
            actions={
              <>
                <HintAction hint={feedback.error.hint} />
                <Button size="sm" onClick={feedback.reload}>Check again</Button>
              </>
            }
          >
            {feedback.error.kind === "refused" ? feedback.error.message : describeError(feedback.error).message} Your waves are shown as your workspace has them.
          </Banner>
        ) : null}

        {data.waves.length === 0 ? (
          <EmptyState
            icon={<Layers />}
            title="No delivery waves yet"
            description={
              approvedSlices.length
                ? `You have ${plural(approvedSlices.length, "approved slice")}. Start a wave to group the ones engineering should receive together.`
                : "A wave groups approved slices for engineering. Approve a slice first; then start a wave here."
            }
            action={
              approvedSlices.length ? (
                <Button variant="primary" onClick={() => startNew()}>
                  <Plus aria-hidden="true" />
                  Start a wave
                </Button>
              ) : (
                <Button asChild>
                  <Link to="/roadmap">See your slices</Link>
                </Button>
              )
            }
          />
        ) : null}

        {waiting.length ? (
          <section aria-labelledby="waiting-title" className="flex flex-col gap-3 rounded-md border border-dashed border-line-strong px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <Heading level={2} id="waiting-title" size="title-3">
                  Approved slices not in a wave
                </Heading>
                <Text size="body-sm" tone="muted">
                  They reach engineering only as part of a wave you send.
                </Text>
              </div>
              <Button size="sm" onClick={() => startNew(waiting.map((s) => s.slice_id))}>
                Start a wave with {waiting.length === 1 ? "it" : `these ${waiting.length}`}
              </Button>
            </div>
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {waiting.map((s) => (
                <li key={s.slice_id} className="flex items-center gap-2 text-body-sm">
                  <ArtifactId>{s.slice_id}</ArtifactId>
                  <span className="text-ink">{s.title}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {groups.map((group) => (
          <section key={group.key} aria-labelledby={`group-${group.key}`} className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <Heading level={2} id={`group-${group.key}`} size="title-2">
                {group.title}
              </Heading>
              <Text size="body-sm" tone="muted">
                {group.hint}
              </Text>
            </div>
            <div className="flex flex-col gap-4">
              {group.waves.map((wave) => (
                <WaveCard
                  key={wave.wave_id}
                  wave={wave}
                  status={data}
                  review={reviews.get(wave.wave_id) ?? null}
                  dependencies={deps.dependencies}
                  dependenciesLoading={deps.loading}
                  onChanged={status.reload}
                  onAddSlices={(waveId) => setChoosing({ waveId, preselected: [] })}
                  onStartNew={startNew}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      <ChooseSlicesDialog
        open={choosing !== null}
        onOpenChange={(open) => (open ? undefined : setChoosing(null))}
        status={data}
        waveId={choosing?.waveId ?? null}
        preselected={choosing?.preselected ?? []}
        onDone={status.reload}
      />
    </Page>
  );
}
