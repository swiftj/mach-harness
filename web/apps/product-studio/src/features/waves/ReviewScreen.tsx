import { ArrowLeft, CircleAlert, RefreshCw } from "lucide-react";
import { Link, useParams } from "react-router";
import { ArtifactId, Button, ErrorState, Heading, LoadingState, Page, SliceStatusPill, Text, describeError } from "@mach/ui";
import { FeedbackBody } from "./SendScreen";
import { useDeliveryRead } from "./delivery/ops";
import { Panel } from "./delivery/ui";

/** How review of one sent wave is going, in the PM's words. */
export function ReviewScreen() {
  const { waveId = "" } = useParams();
  const status = useDeliveryRead("status", {});
  const feedback = useDeliveryRead("feedback", { wave_id: waveId });
  const wave = status.data?.waves.find((w) => w.wave_id === waveId) ?? null;

  return (
    <Page width="reading">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <Link to="/waves" className="inline-flex w-fit items-center gap-1.5 rounded-xs text-body-sm font-semibold text-accent-ink hover:underline">
            <ArrowLeft aria-hidden="true" className="size-4" />
            Delivery waves
          </Link>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <Heading level={1}>
              <span translate="no">{waveId}</span> in review
            </Heading>
            <Button loading={feedback.loading} onClick={feedback.reload}>
              <RefreshCw aria-hidden="true" />
              Check again
            </Button>
          </div>
          <Text tone="muted">Engineering decides whether to accept what you sent. Their response appears here as it comes in.</Text>
        </div>

        {status.loading && !status.data ? (
          <LoadingState label={`Reading ${waveId}`} />
        ) : status.error && !status.data ? (
          <ErrorState icon={<CircleAlert />} {...describeError(status.error)} action={<Button onClick={status.reload}>Try again</Button>} />
        ) : wave ? (
          <Panel aria-labelledby="review-slices" className="px-5 py-4">
            <Heading level={2} id="review-slices" size="title-3">
              Slices in this wave
            </Heading>
            <ul className="mt-1 flex flex-col divide-y divide-line">
              {wave.slices.map((id) => {
                const row = status.data?.slices.find((s) => s.slice_id === id);
                return (
                  <li key={id} className="flex flex-wrap items-center gap-2 py-2.5">
                    <ArtifactId>{id}</ArtifactId>
                    <Link to={`/slices/${id}`} className="text-body font-semibold text-ink hover:text-accent-ink">
                      {row?.title ?? id}
                    </Link>
                    {row ? <SliceStatusPill status={row.status} size="sm" /> : null}
                  </li>
                );
              })}
            </ul>
          </Panel>
        ) : (
          <ErrorState title={`There is no ${waveId} in your workspace`} message="It may have been renumbered or replaced." action={<Button asChild><Link to="/waves">See delivery waves</Link></Button>} />
        )}

        <section aria-labelledby="progress-title" className="flex flex-col gap-4">
          <Heading level={2} id="progress-title" size="title-2">
            Review progress
          </Heading>
          <FeedbackBody feedback={feedback} waveId={waveId} />
        </section>
      </div>
    </Page>
  );
}
