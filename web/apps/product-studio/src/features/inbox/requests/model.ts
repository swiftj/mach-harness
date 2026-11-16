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

/**
 * The text inside the engine's fence: the opening and closing marker lines removed, nothing else
 * changed. Anything that does not look like a fenced text gives null, so nothing unfenced is shown.
 */
export function unfence(fenced: string | undefined | null): string | null {
  if (typeof fenced !== "string") return null;
  const lines = fenced.split("\n");
  const [first, last] = [lines[0] ?? "", lines[lines.length - 1] ?? ""];
  if (lines.length < 2 || !first.startsWith("<<<REQUEST-DATA ") || !last.startsWith("<<<END-REQUEST-DATA ")) return null;
  return lines.slice(1, -1).join("\n");
}
