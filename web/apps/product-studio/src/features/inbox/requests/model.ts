/**
 * What a request card offers, from the engine's item alone. Pure, so it is unit-tested
 * (test/requests-model.test.mjs). The engine still decides: every act can be refused.
 */

export interface RequestFacts {
  state: string;
  picked_up_here: boolean;
  picked_up_by: string[];
  slices: string[];
  url: string | null;
}

export interface RequestActions {
  pickUp: boolean;
  pickUpAsWell: boolean;
  link: boolean;
  markMet: boolean;
  viewOnGitHub: boolean;
}

/** An issue filed by a monitoring account (the engine's `handled_by_…` state): shown, never acted on here. */
export const handledElsewhere = (item: { state: string }): boolean => item.state.startsWith("handled_by_");

/** `approved` lists the slice IDs that are approved for engineering. */
export function requestActions(item: RequestFacts, approved: readonly string[]): RequestActions {
  if (handledElsewhere(item)) return { pickUp: false, pickUpAsWell: false, link: false, markMet: false, viewOnGitHub: false };
  const accepted = item.state === "accepted";
  const elsewhere = !item.picked_up_here && item.picked_up_by.length > 0;
  return {
    pickUp: accepted && !item.picked_up_here && !elsewhere,
    pickUpAsWell: accepted && elsewhere,
    link: accepted,
    markMet: accepted && item.picked_up_here && item.slices.some((id) => approved.includes(id)),
    viewOnGitHub: item.url !== null && /^https:\/\/github\.com\//.test(item.url),
  };
}

import { unfence } from "../../../shared/unfence.ts";

/** The engine's fences are opened by the one shared helper (shared/unfence.ts). */
export { unfence };

/** One part of a request filed in the idea template, ready to show: its heading and its text, or null when it could not be unfenced. */
export interface IdeaSection {
  part: string;
  heading: string;
  text: string | null;
}

/**
 * The parts of an idea as the engine returned them, in its order, each unfenced. Only the engine's
 * parts are shown; nothing is parsed from the request's text here.
 */
export function ideaSections(idea: { parts: Array<{ part: string; heading: string; fenced: string }> } | null | undefined): IdeaSection[] | null {
  if (!idea || !Array.isArray(idea.parts) || idea.parts.length === 0) return null;
  return idea.parts.map((p) => ({ part: p.part, heading: p.heading, text: unfence(p.fenced) }));
}

/** The questions an idea's author left, to be asked first in the interview; null when there are none to show. */
export function questionsToAskFirst(q: { count: number; fenced: string } | null | undefined): { count: number; text: string } | null {
  if (!q || q.count <= 0) return null;
  const text = unfence(q.fenced);
  return text === null ? null : { count: q.count, text };
}
