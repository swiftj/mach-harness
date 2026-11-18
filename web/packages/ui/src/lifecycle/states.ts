import type { Tone } from "../components/tone";
import type { EpicStatus, SliceGithub, SliceStateLabel, SliceStatus } from "../api/types";
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
    description: "You approved this text and marked it ready to build. Frozen until reopened.",
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
  open: { label: "Open", description: "In the project. Its slices are defined and marked ready one at a time.", tone: "neutral", glyph: "open" },
  deferred: { label: "Set aside", description: "Set aside for now. Bring it back when its slices are wanted again.", tone: "warning", glyph: "superseded" },
};

/**
 * Where a slice is with the builders: the state the engine read from its GitHub issue
 * (`github.state_label`). Each has a word and a shape of its own.
 */
export const builderStates: Record<SliceStateLabel, StateDescriptor> = {
  "mach:ready": { label: "Ready to build", description: "Saved for the builders and waiting for them to take it.", tone: "info", glyph: "submitted" },
  "mach:building": { label: "Being built", description: "The builders have taken it and are building it.", tone: "info", glyph: "building" },
  "mach:question": {
    label: "Question from the builders",
    description: "The builders need your answer before they can go on.",
    tone: "warning",
    glyph: "question",
  },
  "mach:shipped": { label: "Shipped", description: "Built and merged; its issue is closed.", tone: "success", glyph: "accepted" },
};

/** A slice's place outside the workspace that needs the PM, or says where it was saved, from `github`. */
export type GithubMark = "changed_on_github" | "newer_elsewhere" | "number_taken" | "unfinished" | "folder";

export const githubMarks: Record<GithubMark, StateDescriptor> = {
  changed_on_github: {
    label: "Changed on GitHub after you approved it",
    description: "Someone edited it on GitHub, so the builders will not take it until you mark it ready again.",
    tone: "danger",
    glyph: "blocked",
  },
  newer_elsewhere: {
    label: "Newer version saved by someone else",
    description: "Choose theirs or keep yours before you mark it ready.",
    tone: "warning",
    glyph: "superseded",
  },
  number_taken: {
    label: "Number already taken",
    description: "Another slice on GitHub uses this number. Give your draft a new one.",
    tone: "warning",
    glyph: "blocked",
  },
  unfinished: { label: "Saving did not finish", description: "Mark it ready again to finish; nothing is made twice.", tone: "warning", glyph: "blocked" },
  folder: { label: "Saved to a folder", description: "Written to the ready folder, because GitHub could not be used here.", tone: "neutral", glyph: "submitted" },
};

/** The marks the engine reports for one slice, in a fixed order. Presentation only. */
export function githubMarksOf(github: SliceGithub): GithubMark[] {
  const marks: GithubMark[] = [];
  if (github.changed_on_github) marks.push("changed_on_github");
  if (github.newer_elsewhere) marks.push("newer_elsewhere");
  if (github.number_taken) marks.push("number_taken");
  if (github.unfinished) marks.push("unfinished");
  if (github.saved === "folder") marks.push("folder");
  return marks;
}
