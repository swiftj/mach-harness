/**
 * What the Look back screen shows, from the engine's answers alone (`idea.show`, `idea.chain`, `lookback.record`).
 * Pure, so it is unit-tested against the real fixtures (test/shape-lookback.test.mjs). It maps what the engine reported
 * to words and shapes and builds the arguments of the one act; it decides no product rule. It never infers a result:
 * a look back is the product manager's judgement, every choice has equal weight and none is ever chosen for them.
 */
import type { GlyphShape } from "@mach/ui";
import type { IdeaAct, AssumptionResult, IdeaChain, IdeaGithubView, IdeaLookbackRecord, IdeaRow, IdeaVerdict, LookbackEntry, OutcomeResult } from "@mach/ui/api";

/** The engine's own limit on a note (`shape_route.NOTE_CHARS`). */
export const NOTE_LIMIT = 500;

export type ItemKind = "outcome" | "assumption";

/** One of the three results, as the person sees it. No choice carries a tone or an order of preference. */
export interface ResultChoice {
  value: OutcomeResult | AssumptionResult;
  word: string;
  glyph: GlyphShape;
}

/** The three results for an outcome and for an assumption, in the engine's order. */
export const resultChoices: Record<ItemKind, readonly ResultChoice[]> = {
  outcome: [
    { value: "met", word: "Met", glyph: "approved" },
    { value: "not-met", word: "Not met", glyph: "blocked" },
    { value: "too-early", word: "Too early to say", glyph: "half" },
  ],
  assumption: [
    { value: "confirmed", word: "Confirmed", glyph: "approved" },
    { value: "wrong", word: "Wrong", glyph: "blocked" },
    { value: "unknown", word: "Still unknown", glyph: "half" },
  ],
};

/** A recorded result's word and shape. A result the app does not know is shown by its own word, never hidden. */
export function resultLook(result: string): { word: string; glyph: GlyphShape } {
  const found = [...resultChoices.outcome, ...resultChoices.assumption].find((choice) => choice.value === result);
  return found ? { word: found.word, glyph: found.glyph } : { word: result, glyph: "ready" };
}

/** The form's starting state: nothing chosen and nothing written, always, even when recording again. */
export interface RecordDraft {
  result: string | null;
  note: string;
}
export const emptyDraft = (): RecordDraft => ({ result: null, note: "" });

/** A note is one line: a line break typed or pasted becomes a space (the engine collapses whitespace the same way). */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

export type LookbackArgs =
  | { idea_id: string; outcome: string; result: OutcomeResult; note: string }
  | { idea_id: string; assumption: string; result: AssumptionResult; note: string };

/**
 * Checks the draft before anything is sent and builds the act's arguments. Only the form's own completeness is checked
 * here (a choice and a note within the engine's length); everything else is the engine's to refuse, in its words.
 */
export function recordArgs(
  ideaId: string,
  kind: ItemKind,
  item: string,
  draft: RecordDraft,
): { args: LookbackArgs; problems: null } | { args: null; problems: { result?: string; note?: string } } {
  const problems: { result?: string; note?: string } = {};
  const choices = resultChoices[kind];
  const chosen = choices.find((choice) => choice.value === draft.result);
  if (!chosen) problems.result = `Choose what you saw: ${choices[0]!.word}, ${choices[1]!.word} or ${choices[2]!.word}.`;
  const note = oneLine(draft.note).trim().replace(/\s+/g, " ");
  if (!note) problems.note = "Write what you saw, in your own words.";
  else if (note.length > NOTE_LIMIT) problems.note = `Keep the note to ${NOTE_LIMIT} characters; it is ${note.length} now.`;
  if (!chosen || problems.note) return { args: null, problems };
  const args: LookbackArgs =
    kind === "outcome"
      ? { idea_id: ideaId, outcome: item, result: chosen.value as OutcomeResult, note }
      : { idea_id: ideaId, assumption: item, result: chosen.value as AssumptionResult, note };
  return { args, problems: null };
}

/** Where the look back on this idea stands, from the idea's stage, its next step and what is already recorded. */
export type Gate =
  /** Never became work: a verdict of Not now or No. */
  | { kind: "decided-against"; decision: string; verdict: IdeaVerdict }
  /** Still being shaped: nothing was made from it yet. */
  | { kind: "not-shaped"; sentence: string }
  /** Shaped into work, but nothing made from it has shipped as the last refresh saw it. */
  | { kind: "waiting"; sentence: string }
  /** The engine allows the look back: each item can be recorded. */
  | { kind: "open"; sentence: string };

export const recordedCount = (lookback: IdeaLookbackRecord | null | undefined): number =>
  Object.keys(lookback?.outcomes ?? {}).length + Object.keys(lookback?.assumptions ?? {}).length;

/**
 * The engine allows a look back once the idea is shaped and a slice made from it has shipped. The app reads that from
 * `idea.show`'s `acts.look_back`, and says why not in the engine's own sentence (the one it would refuse with); it never
 * works it out from the slices or the next step.
 */
export function lookbackGate(row: Pick<IdeaRow, "stage" | "next" | "verdict">, act: IdeaAct | null | undefined): Gate {
  if (row.stage !== "shaped") {
    const decision = row.verdict?.decision;
    if (row.stage === "decided" && row.verdict && (decision === "no" || decision === "not-now")) return { kind: "decided-against", decision, verdict: row.verdict };
    return { kind: "not-shaped", sentence: row.next.sentence };
  }
  if (act?.allowed) return { kind: "open", sentence: row.next.sentence };
  return { kind: "waiting", sentence: act?.why ?? row.next.sentence };
}

export const decisionWord = (decision: string): string => (decision === "no" ? "No" : decision === "not-now" ? "Not now" : decision === "go" ? "Go" : decision);

/** Where a slice stands with the builders, as the last refresh saw it (`progress`), as a word and a shape. */
export function progressLook(progress: string | null | undefined): { word: string; glyph: GlyphShape; known: boolean } {
  switch (progress) {
    case "draft":
      return { word: "Drafted", glyph: "open", known: true };
    case "interviewing":
      return { word: "Being specified", glyph: "half", known: true };
    case "ready_for_approval":
      return { word: "Ready for your approval", glyph: "ready", known: true };
    case "approved":
      return { word: "Approved, saving not finished", glyph: "approved", known: true };
    case "ready_to_build":
      return { word: "Ready to build", glyph: "submitted", known: true };
    case "being_built":
      return { word: "Being built", glyph: "building", known: true };
    case "question":
      return { word: "The builders asked a question", glyph: "question", known: true };
    case "shipped":
      return { word: "Shipped", glyph: "accepted", known: true };
    case "superseded":
      return { word: "Replaced", glyph: "superseded", known: true };
    case null:
    case undefined:
      return { word: "Not known here", glyph: "open", known: false };
    default:
      return { word: progress, glyph: "ready", known: true };
  }
}

/** Where a recorded look back was saved, in words, from the engine's `comment` and the idea's issue. */
export function savedWhere(entry: Pick<LookbackEntry, "comment">, github: Pick<IdeaGithubView, "issue" | "url"> | null): { onIssue: number | null; url: string | null; words: string } {
  const comment = entry.comment;
  const issue = comment?.issue ?? github?.issue ?? null;
  const url = issue !== null && github?.issue === issue ? github.url : null;
  if (!comment) return { onIssue: null, url: null, words: "Kept on this computer." };
  if (comment.posted) return { onIssue: issue, url, words: "Saved on the idea's issue" };
  switch (comment.why) {
    case "already_there":
      return { onIssue: issue, url, words: "Already on the idea's issue" };
    case "not_on_github":
      return { onIssue: null, url: null, words: "Kept on this computer only: the idea is not saved on GitHub." };
    case "github_not_here":
      return { onIssue: null, url: null, words: "Kept on this computer only: GitHub cannot be used from here for the idea's issue." };
    case "not_signed_in":
      return { onIssue: null, url: null, words: "Kept on this computer only: it was recorded with nobody signed in to GitHub." };
    case "github_failed":
      return { onIssue: null, url: null, words: "Kept on this computer: posting it to the idea's issue failed. Record it again to post it." };
    default:
      return { onIssue: null, url: null, words: "Kept on this computer." };
  }
}

/** Which link of a line a missing sentence belongs to, by what it is about. Anything not placed is shown under the line. */
export type Link = "outcome" | "slice" | "spec" | "stands" | "lookback";
export function placeMissing(sentences: readonly string[]): { placed: Partial<Record<Link, string[]>>; rest: string[] } {
  const placed: Partial<Record<Link, string[]>> = {};
  const rest: string[] = [];
  const put = (link: Link, sentence: string) => (placed[link] ??= []).push(sentence);
  for (const sentence of sentences) {
    const s = sentence.toLowerCase();
    if (s.includes("look-back") || s.includes("look back")) put("lookback", sentence);
    else if (s.includes("spec")) put("spec", sentence);
    else if (s.includes("where it stands") || s.includes("builders")) put("stands", sentence);
    else if (s.includes("no slice") || s.includes("not in this workspace")) put("slice", sentence);
    else if (s.includes("brief")) put("outcome", sentence);
    else rest.push(sentence);
  }
  return { placed, rest };
}

type ChainOutcome = IdeaChain["outcomes"][number];
type ChainSlice = IdeaChain["slices"][number];
type ChainEpic = IdeaChain["epics"][number];

/** One line of the chain: an outcome, each slice that serves it with its epic's acceptance, and the look back. */
export interface ChainLine {
  outcome: ChainOutcome;
  /** Each serving slice as the chain reports it; a slice the chain lists by ID only is still a row, said to be missing. */
  slices: Array<{ slice: ChainSlice; epic: ChainEpic | null }>;
  missing: { placed: Partial<Record<Link, string[]>>; rest: string[] };
}

export function chainLines(chain: Pick<IdeaChain, "outcomes" | "slices" | "epics">): ChainLine[] {
  return chain.outcomes.map((outcome) => ({
    outcome,
    slices: outcome.slices.map((id) => {
      const slice = chain.slices.find((s) => s.slice_id === id) ?? { slice_id: id, missing: ["this slice is not in this workspace"] };
      const epic = slice.epic_id ? (chain.epics.find((e) => e.epic_id === slice.epic_id) ?? null) : null;
      return { slice, epic };
    }),
    missing: placeMissing(outcome.missing),
  }));
}

/** How a settlement from the map reads, when an outcome was settled rather than carried by a slice. */
export function settledWords(settled: ChainOutcome["settled"]): string | null {
  if (!settled) return null;
  if (settled.as === "out-of-scope") return "Settled as out of scope";
  if (settled.as === "later") return "Settled as for later";
  if (settled.as === "slice") return "Settled to a slice in the map";
  return `Settled as ${settled.as}`;
}

/** The items a look back is recorded on, from the chain: outcomes in the brief as it is now, and every assumption. */
export interface LookbackItem {
  kind: ItemKind;
  id: string;
  text: string | null;
  howWeWouldKnow: string | null;
  /** An outcome a slice serves that the brief no longer holds: the engine will not take a look back on it. */
  recordable: boolean;
  entry: LookbackEntry | null;
}

export function lookbackItems(chain: Pick<IdeaChain, "outcomes" | "assumptions">, lookback: IdeaLookbackRecord | null | undefined): LookbackItem[] {
  return [
    ...chain.outcomes.map<LookbackItem>((o) => ({
      kind: "outcome",
      id: o.outcome,
      text: o.text,
      howWeWouldKnow: o.how_we_would_know,
      recordable: o.in_brief,
      entry: lookback?.outcomes?.[o.outcome] ?? (o.lookback ? { ...o.lookback } : null),
    })),
    ...chain.assumptions.map<LookbackItem>((a) => ({
      kind: "assumption",
      id: a.assumption,
      text: a.text,
      howWeWouldKnow: null,
      recordable: true,
      entry: lookback?.assumptions?.[a.assumption] ?? (a.lookback ? { ...a.lookback } : null),
    })),
  ];
}

/** "2 of 4 recorded": items in the brief with a result, of all items that can take one. */
export function progressWords(items: readonly LookbackItem[]): string {
  const can = items.filter((i) => i.recordable);
  const done = can.filter((i) => i.entry !== null).length;
  if (can.length === 0) return "Nothing in the brief to look back on";
  return `${done} of ${can.length} recorded`;
}

/** The confirm dialog's words for one act. */
export function confirmWords(kind: ItemKind, item: string, result: string): { title: string; description: string } {
  const what = resultLook(result).word;
  return {
    title: `Record ${item} as ${what}?`,
    description:
      `This saves your look back on ${item} in your words. Where the idea is saved on GitHub it is also posted on the idea's issue as a comment signed with your GitHub login. ` +
      `It replaces any earlier result for this ${kind}. It changes no slice and starts nothing.`,
  };
}
