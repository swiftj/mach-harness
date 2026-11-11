import type { Tone } from "../components/tone";
import type { ArtifactSource, EpicStatus, SliceStatus, WaveReviewStatus, WaveStatus } from "../api/types";
import type { GlyphShape } from "./glyph";

/**
 * How each engine state looks and reads. Presentation only: the engine decides every state;
 * these tables say how to show the state it reported.
 */
export interface StateDescriptor {
  /** Shown to the person. */
  label: string;
  /** One sentence, for a tooltip, legend or screen reader. */
  description: string;
  tone: Tone;
  glyph: GlyphShape;
}

export const sliceStates: Record<SliceStatus, StateDescriptor> = {
  draft: {
    label: "Draft",
    description: "Created, not yet interviewed.",
    tone: "neutral",
    glyph: "open",
  },
  interviewing: {
    label: "Interviewing",
    description: "Being worked out with the interviewer; questions may be open.",
    tone: "info",
    glyph: "half",
  },
  ready_for_approval: {
    label: "Ready for approval",
    description: "The spec passes every check and nothing is open. Waiting for your approval.",
    tone: "accent",
    glyph: "ready",
  },
  approved_for_engineering: {
    label: "Approved",
    description: "You approved it. Frozen until reopened. It reaches engineering only when a wave containing it is sent.",
    tone: "success",
    glyph: "approved",
  },
  superseded: {
    label: "Superseded",
    description: "Replaced by later work. Kept for history.",
    tone: "neutral",
    glyph: "superseded",
  },
};

/** The forward path a slice takes. Superseded sits off this path. */
export const sliceLifecycle: readonly SliceStatus[] = ["draft", "interviewing", "ready_for_approval", "approved_for_engineering"];

export const epicStates: Record<EpicStatus, StateDescriptor> = {
  proposed: { label: "Proposed", description: "Not yet approved. Its slices cannot be approved until it is.", tone: "neutral", glyph: "open" },
  approved: { label: "Approved", description: "Approved. Its slices can be approved.", tone: "success", glyph: "approved" },
  deferred: { label: "Deferred", description: "Set aside for now.", tone: "warning", glyph: "superseded" },
  completed: { label: "Completed", description: "Every slice it needed has been delivered.", tone: "success", glyph: "accepted" },
  superseded: { label: "Superseded", description: "Replaced by another epic. Kept for history.", tone: "neutral", glyph: "superseded" },
};

export const waveStates: Record<WaveStatus, StateDescriptor> = {
  draft: { label: "Draft", description: "A grouping of slices, not yet approved.", tone: "neutral", glyph: "open" },
  approved_for_engineering: {
    label: "Approved",
    description: "You approved this wave. It stays in your workspace until you send it.",
    tone: "success",
    glyph: "approved",
  },
  superseded: { label: "Superseded", description: "Replaced by a later wave.", tone: "neutral", glyph: "superseded" },
};

/**
 * Review states of a sent wave. `stage` places it on the wave journey
 * (0 approved, 1 sent, 2 in review, 3 accepted). `attention` marks states the PM must act on.
 */
export interface ReviewDescriptor extends StateDescriptor {
  stage: 0 | 1 | 2 | 3;
  attention: boolean;
  /** The journey ends here (accepted or declined). */
  final: boolean;
}

export const reviewStates: Record<WaveReviewStatus, ReviewDescriptor> = {
  "Not approved yet": {
    label: "Not approved yet",
    description: "Approve the wave before sending it.",
    tone: "neutral",
    glyph: "open",
    stage: 0,
    attention: false,
    final: false,
  },
  "Approved, not sent": {
    label: "Approved, not sent",
    description: "Approved in your workspace; engineering has not been asked yet.",
    tone: "neutral",
    glyph: "approved",
    stage: 0,
    attention: false,
    final: false,
  },
  "Prepared, not sent": {
    label: "Prepared, not sent",
    description: "The wave was prepared but did not reach the shared repository. Sending again finishes the job.",
    tone: "warning",
    glyph: "blocked",
    stage: 1,
    attention: true,
    final: false,
  },
  Sent: {
    label: "Sent",
    description: "Sent for review; the review's state could not be read just now.",
    tone: "info",
    glyph: "submitted",
    stage: 2,
    attention: false,
    final: false,
  },
  "Sent, pull request not opened": {
    label: "Sent, review request not opened",
    description: "The work reached the shared repository but the review request could not be opened. Sending again finishes the job.",
    tone: "warning",
    glyph: "blocked",
    stage: 1,
    attention: true,
    final: false,
  },
  "Waiting for review": {
    label: "Waiting for review",
    description: "Nobody has decided yet.",
    tone: "info",
    glyph: "submitted",
    stage: 2,
    attention: false,
    final: false,
  },
  "Changes requested": {
    label: "Changes requested",
    description: "A reviewer asked for changes before accepting this.",
    tone: "warning",
    glyph: "half",
    stage: 2,
    attention: true,
    final: false,
  },
  "Blocked by a check": {
    label: "Blocked by a check",
    description: "An automatic check on the request is failing.",
    tone: "danger",
    glyph: "blocked",
    stage: 2,
    attention: true,
    final: false,
  },
  "Needs updating": {
    label: "Needs updating",
    description: "Other work reached the shared project first. Refresh, reconcile, and send again.",
    tone: "warning",
    glyph: "half",
    stage: 2,
    attention: true,
    final: false,
  },
  "Accepted, waiting to merge": {
    label: "Accepted, waiting to be added",
    description: "Reviewers approved it; it has not been added to the shared project yet.",
    tone: "success",
    glyph: "approved",
    stage: 3,
    attention: false,
    final: false,
  },
  Accepted: {
    label: "Accepted",
    description: "Engineering accepted this into the shared project. It is not built yet.",
    tone: "success",
    glyph: "accepted",
    stage: 3,
    attention: false,
    final: true,
  },
  Declined: {
    label: "Declined",
    description: "The request was closed without being accepted.",
    tone: "neutral",
    glyph: "superseded",
    stage: 2,
    attention: false,
    final: true,
  },
};

/** For a review word this version does not know: shown as is, neutral, never a crash. */
export function reviewDescriptor(status: string): ReviewDescriptor {
  return (
    (reviewStates as Record<string, ReviewDescriptor | undefined>)[status] ?? {
      label: status,
      description: status,
      tone: "neutral",
      glyph: "open",
      stage: 2,
      attention: false,
      final: false,
    }
  );
}

/** The wave journey's stage names, in order. */
export const waveJourney = ["Approved", "Sent", "In review", "Accepted"] as const;

export const sourceStates: Record<ArtifactSource, { label: string; description: string; tone: Tone }> = {
  draft: { label: "Your draft", description: "Only in your workspace.", tone: "neutral" },
  published: { label: "Shared", description: "The same as in the shared project.", tone: "info" },
  conflict: { label: "Conflict", description: "Changed both here and in the shared project. You choose which stands.", tone: "warning" },
  collision: { label: "Needs a new number", description: "Another item now holds this number. Renumber your draft.", tone: "warning" },
};
