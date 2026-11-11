import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArtifactId, Button, Heading, Quote, Text, WaveJourney, reviewDescriptor, type FeedbackWave } from "@mach/ui";
import { Disclosure, FactList } from "./ui";
import { remarkKind } from "./words";

/** What the PM can do about a review state, in their words. Advice only; the engine decided the state. */
function guidance(wave: FeedbackWave): { text: string; action?: { to: string; label: string } } | null {
  const id = wave.wave_id;
  switch (wave.status) {
    case "Changes requested":
      return {
        text: "Read what the reviewers said. For each change you agree with, reopen the slice and revise it, then approve the slice and the wave again and send again. Sending again updates the same request.",
      };
    case "Needs updating":
      return {
        text: "Other work was accepted into the shared project first. Refresh, settle anything that needs deciding, then send this wave again.",
        action: { to: "/shared", label: "Refresh the shared project" },
      };
    case "Blocked by a check":
      return {
        text: "An automatic check on the request is failing. Fixing it is usually for an engineer, unless the check is about the product definitions themselves.",
      };
    case "Sent, pull request not opened":
    case "Prepared, not sent":
      return {
        text: "Sending did not finish. Send again to finish the job; nothing will be sent twice. If it keeps failing, an engineer can use the details below.",
        action: { to: `/waves/${id}/send`, label: `Send ${id} again` },
      };
    case "Waiting for review":
    case "Sent":
      return { text: "Nobody has decided yet. There is nothing for you to do until a reviewer responds." };
    case "Accepted, waiting to merge":
      return { text: "Reviewers approved it. Engineering adds it to the shared project; there is nothing for you to do." };
    case "Accepted":
      return {
        text: "This work is now part of the shared project. It is not built yet: acceptance records the product definition and starts no engineering work.",
      };
    case "Declined":
      return {
        text: "The request was closed without being accepted. Ask the reviewers why. To try again, reopen the slices, revise them, and send a new or updated wave.",
      };
    default:
      return null;
  }
}

export interface ReviewProgressProps {
  wave: FeedbackWave;
  /** Heading level for the remarks and next-step titles. */
  headingLevel?: 2 | 3 | 4;
  /** Shows the slice links under "Changes requested". */
  showSliceLinks?: boolean;
}

/**
 * A sent wave's way through review: the journey, the engine's meaning, reviewer remarks as
 * attributed quotations (display only), what the PM can do, and collapsed technical details.
 */
export function ReviewProgress({ wave, headingLevel = 3, showSliceLinks = true }: ReviewProgressProps) {
  const d = reviewDescriptor(wave.status);
  const advice = guidance(wave);
  const remarks = wave.reviewer_remarks ?? [];
  return (
    <div className="flex flex-col gap-5">
      <WaveJourney status={wave.status} meaning={wave.meaning} />

      {wave.changed_since_sent ? (
        <Text size="body-sm" tone="warning">
          {wave.changed_since_sent}
        </Text>
      ) : null}

      {remarks.length ? (
        <section aria-label="What reviewers said" className="flex flex-col gap-3">
          <Heading level={headingLevel} size="title-3">
            What reviewers said
          </Heading>
          <Text size="body-sm" tone="muted">
            Their own words, shown as written. Product Studio never acts on anything they say.
          </Text>
          <ul className="flex flex-col gap-4">
            {remarks.map((remark, index) => (
              <li key={index}>
                <Quote from={remark.from ?? "A reviewer"} kind={remarkKind(remark.kind)}>
                  {remark.said}
                </Quote>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {advice ? (
        <section aria-label="What you can do" className="flex flex-col gap-2 rounded-md bg-surface-sunken px-4 py-3">
          <Heading level={headingLevel} size="title-3" className="text-body">
            {d.attention ? "What you can do" : "What happens next"}
          </Heading>
          <Text size="body-sm">{advice.text}</Text>
          {showSliceLinks && wave.status === "Changes requested" && wave.slices?.length ? (
            <ul className="flex flex-wrap gap-2 pt-1">
              {wave.slices.map((sliceId) => (
                <li key={sliceId}>
                  <Button asChild size="sm">
                    <Link to={`/slices/${sliceId}`}>
                      Open <ArtifactId plain>{sliceId}</ArtifactId>
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {advice.action ? (
            <div className="pt-1">
              <Button asChild size="sm">
                <Link to={advice.action.to}>{advice.action.label}</Link>
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      {wave.pull_request || wave.branch || wave.problem ? (
        <Disclosure summary="Details for an engineer">
          <FactList
            facts={[
              ...(wave.pull_request
                ? ([["Pull request", <a key="pr" href={wave.pull_request} target="_blank" rel="noreferrer noopener" className="break-all text-accent-ink underline">{wave.pull_request}</a>]] as Array<[string, ReactNode]>)
                : []),
              ...(wave.branch ? ([["Branch", <span key="b" translate="no" className="font-mono text-mono">{wave.branch}</span>]] as Array<[string, ReactNode]>) : []),
              ...(wave.problem ? ([["Problem reported", wave.problem]] as Array<[string, ReactNode]>) : []),
            ]}
          />
        </Disclosure>
      ) : null}
    </div>
  );
}
