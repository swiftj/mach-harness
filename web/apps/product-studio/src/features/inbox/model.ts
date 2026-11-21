/**
 * What each group of the Decisions screen says while it is closed (M16 layout, docs/mach-next/M16_LAYOUT.md 2.4):
 * how many things wait in it and which, in plain words, from the engine's answers only. Pure, so it is unit-tested
 * (test/inbox-model.test.mjs).
 */

const counted = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "A", "A and B", "A, B and 1 more". */
export function namesInLine(names: readonly string[], shown = 2): string {
  const named = names.slice(0, shown);
  const rest = names.length - named.length;
  if (rest > 0) return `${named.join(", ")} and ${rest} more`;
  if (named.length <= 1) return named.join("");
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/** A group of slices: "1 slice: Remove a teammate", "3 slices: Invite, Rename and 1 more". */
export function sliceGroupSummary(titles: readonly string[]): string {
  if (titles.length === 0) return "Nothing waiting";
  return `${counted(titles.length, "slice")}: ${namesInLine(titles)}`;
}

/** Open questions: "2 open questions on Invite a teammate by email". */
export function questionsSummary(slices: ReadonlyArray<{ title: string; open_questions: number }>): string {
  const total = slices.reduce((n, s) => n + s.open_questions, 0);
  if (total === 0) return "Nothing waiting";
  return `${counted(total, "open question")} on ${namesInLine(slices.map((s) => s.title))}`;
}

/**
 * Requests: how many, and how many can still be picked up here. `pickable` counts the requests whose offers include
 * "Pick up" or "Pick up as well" (requestActions). Null items: the list could not be read yet.
 */
export function requestsSummary(items: number | null, pickable: number): string {
  if (items === null) return "Not read yet";
  if (items === 0) return "No open requests";
  const head = counted(items, "request");
  return pickable > 0 ? `${head}, ${pickable} you can pick up` : `${head}, none to pick up`;
}

/**
 * Which group opens on arrival: the one the person last opened while it still has something in it, otherwise the
 * first (the groups are in order of urgency). `chosen` is undefined until the person opens or closes one; null when
 * they closed it.
 */
export function openGroup(ids: readonly string[], chosen: string | null | undefined): string | null {
  if (chosen === null) return null;
  if (chosen !== undefined && ids.includes(chosen)) return chosen;
  return ids[0] ?? null;
}
