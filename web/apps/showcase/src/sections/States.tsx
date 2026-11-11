import { FileQuestion, Layers, RefreshCw, Send, WifiOff } from "lucide-react";
import {
  ArtifactId,
  Badge,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Skeleton,
  SkeletonText,
  StatusPill,
  Text,
  StateGlyph,
} from "@mach/ui";
import { Section, Specimen } from "../layout";
import { fx, runs } from "../fixtures";

export function States() {
  const refresh = fx.refreshConflicts;
  const offline = fx.refreshOffline;
  const check = fx.sliceCheckErrors;
  return (
    <Section
      id="states"
      title="Status and feedback"
      intro="Every state says what happened and what to do next, in plain words. The engine's own sentences are shown as it wrote them."
    >
      <Specimen title="Badges and status pills" note="Badges state a fact. Status pills state where something stands, with a shape as well as a colour.">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>3 slices</Badge>
            <Badge tone="warning">Risk High</Badge>
            <Badge tone="info" outline>
              Shared
            </Badge>
            <Badge tone="warning">Conflict</Badge>
            <Badge tone="danger">2 errors</Badge>
            <Badge tone="success">Ready</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone="neutral" icon={<StateGlyph shape="open" />}>Proposed</StatusPill>
            <StatusPill tone="info" icon={<StateGlyph shape="half" />}>Interviewing</StatusPill>
            <StatusPill tone="accent" icon={<StateGlyph shape="ready" />}>Ready for approval</StatusPill>
            <StatusPill tone="success" icon={<StateGlyph shape="approved" />}>Approved</StatusPill>
            <StatusPill tone="info" icon={<StateGlyph shape="submitted" />}>Waiting for review</StatusPill>
            <StatusPill tone="success" icon={<StateGlyph shape="accepted" />}>Accepted</StatusPill>
            <StatusPill tone="danger" icon={<StateGlyph shape="blocked" />}>Blocked by a check</StatusPill>
            <StatusPill tone="neutral" icon={<StateGlyph shape="superseded" />}>Superseded</StatusPill>
          </div>
        </div>
      </Specimen>

      <Specimen title="Banners" source="refresh.conflicts.json, refresh.offline.json, validate.json" note="A banner stays while the situation lasts. It is not dismissed by a timer.">
        <div className="flex flex-col gap-3">
          <Banner
            tone="warning"
            title={`${refresh.needs_reconciling.conflicts.length} items changed both in your drafts and in the shared project`}
            actions={<Button size="sm">Settle them</Button>}
          >
            {refresh.needs_reconciling.conflicts.map((path, i) => (
              <span key={path}>
                {i > 0 ? ", " : null}
                <span className="font-mono text-caption">{path}</span>
              </span>
            ))}
            . Choose which version stands before approving anything that depends on them.
          </Banner>
          <Banner tone="info" title={`${refresh.arrived.length} item arrived from the shared project`}>
            <span className="font-mono text-caption">{refresh.arrived.join(", ")}</span>. Updated: the project's{" "}
            {refresh.updated.flatMap((u) => u.fields ?? []).join(", ")}.
          </Banner>
          <Banner
            tone="warning"
            title="Could not reach the shared project"
            actions={
              <Button size="sm">
                <RefreshCw aria-hidden="true" />
                Try again
              </Button>
            }
          >
            Your drafts are safe and you can keep working. The last attempt said:{" "}
            <span className="font-mono text-caption">{offline.problem}</span>
          </Banner>
          <Banner tone="danger" title="The workspace has a structural problem">
            {fx.validate.errors[0]}
          </Banner>
          <Banner tone="success" title={`${fx.waveApprove.wave.wave_id} approved`}>
            {fx.waveApprove.note}
          </Banner>
        </div>
      </Specimen>

      <div className="grid grid-cols-2 gap-6">
        <Specimen title="Empty" source="status.empty.json" note="Empty is an invitation: what belongs here and the one action that starts it.">
          <EmptyState
            icon={<Layers />}
            title="No project yet"
            description={fx.statusEmpty.suggested_next[0]}
            action={<Button variant="primary">Define the project</Button>}
          />
        </Specimen>
        <Specimen title="Error: the engine refused" source="send.refused-offline.json" note="A refusal is the engine saying no. Its message is written for a person, so it is shown as is.">
          <ErrorState
            icon={<WifiOff />}
            title="WAVE-001 was not sent"
            message={runs.sendRefusedOffline.refused}
            action={
              <Button size="sm">
                <Send aria-hidden="true" />
                Send again
              </Button>
            }
          />
        </Specimen>
        <Specimen title="Error: a check found problems" source="slice.check.errors.json" note="A failed check is not an error of the app: the check ran, and these are its findings.">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <ArtifactId>{check.slice_id}</ArtifactId>
              <Badge tone="danger">{check.errors.length} problems</Badge>
              <Badge tone="info">{check.open_questions.length} open questions</Badge>
            </div>
            <ul className="flex flex-col gap-1.5">
              {check.errors.slice(0, 3).map((error) => (
                <li key={error} className="flex items-start gap-2 text-body-sm text-ink">
                  <StateGlyph shape="blocked" className="mt-0.5 text-danger-ink" />
                  <span className="font-mono text-caption">{error}</span>
                </li>
              ))}
            </ul>
            <Text size="caption" tone="subtle">
              and {check.errors.length - 3} more
            </Text>
          </div>
        </Specimen>
        <Specimen title="Refusal with steps" source="slice.approve.refused-no-spec.json">
          <ErrorState
            icon={<FileQuestion />}
            title="SLICE-001 cannot be approved yet"
            message={(runs.sliceApproveRefusedNoSpec.refused ?? "").split("\n").slice(1).map((line) => `• ${line.trim()}`).join("\n")}
          />
        </Specimen>
        <Specimen title="Loading" note="Say what is loading. Use a skeleton when the shape of the result is known.">
          <div className="flex flex-col gap-4">
            <LoadingState label="Fetching from the shared project" />
            <div role="status" aria-busy="true" aria-label="Loading slices" className="flex flex-col gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-6 w-24 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        </Specimen>
        <Specimen title="Skeleton text" note="Shimmer stops under reduced motion.">
          <SkeletonText lines={4} />
        </Specimen>
      </div>
    </Section>
  );
}
