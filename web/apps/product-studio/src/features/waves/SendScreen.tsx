import { ArrowLeft, CircleAlert, CircleCheck, RefreshCw, Send as SendIcon } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { ArtifactId, Badge, Banner, Button, ConfirmDialog, ErrorState, Heading, LoadingState, Page, SkeletonText, SliceStatusPill, Text, describeError, toast, type Send, type Status, Disclosure, FactList, IdText, Panel, Stepper, plural } from "@mach/ui";
import { ReviewProgress } from "./delivery/ReviewProgress";
import { asApiError, deliveryOp, useDeliveryRead, type DeliveryRead } from "./delivery/ops";
import { failureText } from "@mach/ui/api";

const steps = [{ label: "Check what will be sent" }, { label: "Confirm" }, { label: "Sent" }];

/** "the spec SLICE-001-invite-teammate.md (new)" → words and whether it is new. */
export function describeShared(line: string): { text: string; isNew: boolean } {
  const match = line.match(/^(.*) \((new|changed)\)$/);
  const what = match?.[1] ?? line;
  const isNew = match?.[2] === "new";
  const spec = what.match(/^the spec ([A-Z]+-\d{3,})/);
  let text = what;
  if (spec?.[1]) text = `The specification for ${spec[1]}`;
  else if (what.startsWith("the work order for ")) text = `The slice ${what.slice("the work order for ".length)}: its title, epic and dependencies`;
  else if (what.startsWith("the why for ")) text = `The why for ${what.slice("the why for ".length)}`;
  else if (what === "the project") text = "The project: its name, vision and outcomes";
  else if (what.startsWith("epic ")) text = `Epic ${what.slice(5)}`;
  else if (what.startsWith("delivery wave ")) text = `Delivery wave ${what.slice(14)}`;
  return { text, isNew };
}

export function SharedList({ lines, label }: { lines: string[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-line">
      {lines.map((line) => {
        const { text, isNew } = describeShared(line);
        return (
          <li key={line} className="flex items-center justify-between gap-4 py-2.5 text-body">
            <span className="min-w-0">
              <IdText text={text} />
            </span>
            <Badge tone={isNew ? "info" : "neutral"} outline>
              {isNew ? "New to the shared project" : "Changed"}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

function BackLink() {
  return (
    <Link to="/waves" className="inline-flex w-fit items-center gap-1.5 rounded-xs text-body-sm font-semibold text-accent-ink hover:underline">
      <ArrowLeft aria-hidden="true" className="size-4" />
      Delivery waves
    </Link>
  );
}

function WaveSlices({ status, sliceIds }: { status: Status; sliceIds: string[] }) {
  return (
    <ul className="flex flex-col divide-y divide-line">
      {sliceIds.map((id) => {
        const row = status.slices.find((s) => s.slice_id === id);
        return (
          <li key={id} className="flex flex-wrap items-center gap-2 py-2.5">
            <ArtifactId>{id}</ArtifactId>
            <span className="text-body font-semibold text-ink">{row?.title ?? "Not in your workspace"}</span>
            {row ? <SliceStatusPill status={row.status} size="sm" /> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function SendScreen() {
  const { waveId = "" } = useParams();
  const status = useDeliveryRead("status", {});
  const [result, setResult] = useState<Send | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sendError, setSendError] = useState<ReturnType<typeof failureText> | null>(null);
  const wave = status.data?.waves.find((w) => w.wave_id === waveId) ?? null;
  const preview = useDeliveryRead("send.preview", wave && !result ? { wave_id: waveId } : null);
  const feedback = useDeliveryRead("feedback", result?.sent ? { wave_id: waveId } : null);

  if (status.loading && !status.data) {
    return (
      <Page width="reading">
        <LoadingState label={`Reading ${waveId}`} />
      </Page>
    );
  }
  if (!status.data) {
    const { title, message } = status.error ? describeError(status.error) : { title: "", message: "" };
    return (
      <Page width="reading">
        <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={status.reload}>Try again</Button>} />
      </Page>
    );
  }
  const data = status.data;
  if (!wave) {
    return (
      <Page width="reading">
        <div className="flex flex-col gap-6">
          <BackLink />
          <ErrorState title={`There is no ${waveId} in your workspace`} message="It may have been renumbered or replaced. Choose a wave from the list." action={<Button asChild><Link to="/waves">See delivery waves</Link></Button>} />
        </div>
      </Page>
    );
  }

  const send = async () => {
    setSendError(null);
    try {
      const sent = await deliveryOp("send", { wave_id: waveId });
      setResult(sent);
      if (sent.sent && sent.status !== "Sent, pull request not opened") toast({ tone: "success", title: `Sent ${waveId}`, description: sent.note });
      status.reload();
      return true;
    } catch (cause) {
      setSendError(failureText(asApiError(cause, "send"), `${waveId} was not sent`));
      return false;
    }
  };

  const current = result ? 2 : confirming ? 1 : 0;
  const project = data.project?.name ?? "this project";

  return (
    <Page width="reading">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <BackLink />
          <Heading level={1}>
            Send <span translate="no">{waveId}</span> to engineering
          </Heading>
          <Stepper steps={steps} current={current} label="Sending steps" />
        </div>

        {result ? (
          <SendResult result={result} waveId={waveId} onSendAgain={() => setConfirming(true)} />
        ) : (
          <>
            {wave.sent ? (
              <Banner tone="info" title={`${waveId} has been sent before`} actions={<Button size="sm" asChild><Link to={`/waves/${waveId}/review`}>See review progress</Link></Button>}>
                Sending again adds your latest approved version to the same request; nothing is sent twice.
              </Banner>
            ) : null}

            <Text size="body-lg" editorial>
              You are about to ask engineering to accept {plural(wave.slices.length, "approved slice")} from {project} into the shared project.
            </Text>

            <Panel aria-labelledby="send-slices" className="px-5 py-4">
              <Heading level={2} id="send-slices" size="title-3">
                In this wave
              </Heading>
              <WaveSlices status={data} sliceIds={wave.slices} />
            </Panel>

            {preview.loading && !preview.data ? (
              <Panel className="flex flex-col gap-3 px-5 py-4" aria-busy="true" aria-label="Checking what would be sent">
                <LoadingState label="Checking the wave against the latest shared project…" className="py-0" />
                <SkeletonText lines={4} />
              </Panel>
            ) : preview.error ? (
              <ErrorState
                icon={<CircleAlert />}
                title={failureText(preview.error, `${waveId} can't be sent yet`).title}
                message={failureText(preview.error, `${waveId} can't be sent yet`).message}
                hint={preview.error.hint}
                action={
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={preview.reload}>
                      <RefreshCw aria-hidden="true" />
                      Check again
                    </Button>
                    {data.needs_reconciling.conflicts.length || data.needs_reconciling.collisions.length ? (
                      <Button asChild>
                        <Link to="/inbox">Open Decisions</Link>
                      </Button>
                    ) : null}
                  </div>
                }
              />
            ) : preview.data ? (
              <>
                <Panel aria-labelledby="send-what" className="px-5 py-4">
                  <Heading level={2} id="send-what" size="title-3">
                    What will be shared
                  </Heading>
                  <Text size="body-sm" tone="muted" className="mt-1">
                    Only product definitions. Your other drafts stay private.
                  </Text>
                  <SharedList lines={preview.data.would_share} label="What will be shared" />
                </Panel>

                <Panel aria-labelledby="send-checks" className="flex flex-col gap-3 px-5 py-4">
                  <Heading level={2} id="send-checks" size="title-3">
                    Checks and destination
                  </Heading>
                  {preview.data.refreshed ? (
                    <p className="flex items-start gap-2 text-body text-ink">
                      <CircleCheck aria-hidden="true" className="mt-1 size-4 shrink-0 text-success-ink" />
                      <span>Checked against the latest shared project: the wave is approved and nothing in it is waiting for a decision.</span>
                    </p>
                  ) : (
                    <Banner tone="warning" title="The shared project could not be reached">
                      This was checked against the last copy you have. Sending needs a connection; if it fails, nothing is sent.
                    </Banner>
                  )}
                  <FactList
                    facts={[
                      ["Goes to", `The shared project for ${project}, as a request for engineering review`],
                      ["Review request", preview.data.request === "opens a new request" ? "A new request is opened" : "Adds to the request already open for this wave"],
                      ["Starts engineering work", "No. Engineering reviews the definitions first"],
                    ]}
                  />
                  <Text size="caption" tone="subtle">
                    {preview.data.note}
                  </Text>
                </Panel>

                <Disclosure summary="Details for an engineer">
                  <FactList facts={[["Destination", preview.data.to], ["Shared project", data.shared_project], ["Request", preview.data.request]]} />
                </Disclosure>

                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="primary" size="lg" onClick={() => setConfirming(true)}>
                    <SendIcon aria-hidden="true" />
                    Send {waveId} to engineering…
                  </Button>
                  <Button size="lg" asChild>
                    <Link to="/waves">Not now</Link>
                  </Button>
                </div>
              </>
            ) : null}
          </>
        )}

        {result?.sent && result.status !== "Sent, pull request not opened" ? (
          <section aria-labelledby="review-title" className="flex flex-col gap-4 border-t border-line pt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Heading level={2} id="review-title" size="title-2">
                Review progress
              </Heading>
              <Button size="sm" loading={feedback.loading} onClick={feedback.reload}>
                <RefreshCw aria-hidden="true" />
                Check again
              </Button>
            </div>
            <FeedbackBody feedback={feedback} waveId={waveId} />
          </section>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) setSendError(null);
        }}
        title={`Send ${waveId} to engineering?`}
        description={`Engineering will be asked to accept ${plural(wave.slices.length, "slice")} into the shared project.`}
        confirmLabel={`Send ${waveId}`}
        onConfirm={send}
        error={sendError}
      >
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-body-sm text-ink">
          <li>
            <span className="font-semibold">It is visible to other people at once.</span> Other product managers and engineering see it as soon as it
            is sent.
          </li>
          <li>
            <span className="font-semibold">It does not start any engineering work.</span> Engineering reviews the definitions first.
          </li>
          <li>To change it later, revise and send again; that updates the same request.</li>
        </ul>
      </ConfirmDialog>
    </Page>
  );
}

function SendResult({ result, waveId, onSendAgain }: { result: Send; waveId: string; onSendAgain: () => void }) {
  if (result.already_accepted) {
    return (
      <Banner tone="info" title={`Nothing to send: the shared project already has ${waveId}`}>
        {result.note}
      </Banner>
    );
  }
  const opened = result.status !== "Sent, pull request not opened";
  return (
    <div className="flex flex-col gap-5">
      {opened ? (
        <Banner tone="success" title={`${waveId} was sent to engineering`} live="polite">
          {result.note ?? "Engineering has been asked to accept this."} You'll see their response below and in Decisions.
        </Banner>
      ) : (
        <Banner
          tone="warning"
          live="polite"
          title={`${waveId} reached the shared project, but the review request could not be opened`}
          actions={
            <Button size="sm" variant="primary" onClick={onSendAgain}>
              Send {waveId} again
            </Button>
          }
        >
          Engineering has not been asked to review it yet. Sending again finishes the job without sending anything twice. If it keeps failing, an
          engineer can use the details below.
        </Banner>
      )}
      {result.shared?.length ? (
        <Panel aria-labelledby="sent-what" className="px-5 py-4">
          <Heading level={2} id="sent-what" size="title-3">
            What was shared
          </Heading>
          <SharedList lines={result.shared} label="What was shared" />
        </Panel>
      ) : null}
      {result.problem || result.branch || result.pull_request ? (
        <Disclosure summary="Details for an engineer">
          <FactList
            facts={[
              ...(result.problem ? ([["Problem reported", result.problem]] as Array<[string, string]>) : []),
              ...(result.branch ? ([["Branch", result.branch]] as Array<[string, string]>) : []),
              ...(result.pull_request ? ([["Pull request", result.pull_request]] as Array<[string, string]>) : []),
            ]}
          />
        </Disclosure>
      ) : null}
    </div>
  );
}

export function FeedbackBody({ feedback, waveId }: { feedback: DeliveryRead<"feedback">; waveId: string }) {
  if (feedback.loading && !feedback.data) return <LoadingState label="Checking how review is going…" />;
  if (feedback.error) {
    const { title, message } = failureText(feedback.error, "Review progress could not be checked");
    return <ErrorState title={title} message={message} action={<Button onClick={feedback.reload}>Check again</Button>} />;
  }
  const row = feedback.data?.waves.find((w) => w.wave_id === waveId);
  if (!row) return <Text tone="muted">No review has been reported for {waveId} yet.</Text>;
  return (
    <>
      {feedback.data && !feedback.data.refreshed ? (
        <Banner tone="warning" title="The shared project could not be reached">
          This is the last review state your workspace knows.
        </Banner>
      ) : null}
      <ReviewProgress wave={row} />
    </>
  );
}
