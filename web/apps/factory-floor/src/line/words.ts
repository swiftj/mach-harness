/** The Line's words that read records: model names and recorded money, in plain words. */
import { MODELS } from "../sim";

/** A recorded model name in plain words: "Sonnet 5.5" for `claude-sonnet-5-5` or `sonnet`; anything else as recorded. */
export function modelName(recorded: string): string {
  for (const [key, m] of Object.entries(MODELS)) if (recorded === key || recorded === m.modelId) return m.name.replace(/^Claude /, "");
  return recorded;
}

/** The models recorded at a station, at most three, or null when none is recorded. */
export function modelWords(recorded: readonly string[]): string | null {
  if (!recorded.length) return null;
  const names = [...new Set(recorded.map(modelName))];
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} and more` : names.join(", ");
}

/** Recorded spend in words: "$4.18 recorded", "at least $4.18 recorded" when part of it is not, or "not recorded". */
export function costWords(cost: { readonly usd: number; readonly partial: boolean } | null): string {
  if (!cost) return "not recorded";
  return `${cost.partial ? "at least " : ""}$${cost.usd.toFixed(2)} recorded`;
}
