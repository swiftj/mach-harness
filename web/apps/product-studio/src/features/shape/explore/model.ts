/**
 * Explore's pure logic (screen engineer 2, M16). It arranges what the engine returned and decides nothing: the stage,
 * the lookups, the source and the brief's state are the engine's. Unit-tested in test/shape-explore.test.mjs against the
 * real fixtures, so it imports types only.
 */
import type {
  EpicCurrent,
  IdeaLookups,
  IdeaRow,
  IdeaShow,
  IdeaSourceShown,
  LookupPolicy,
  LookupPrinciple,
  LookupShippedRule,
  LookupSimilar,
  PolicyList,
  PrincipleList,
} from "@mach/ui/api";

/* ---------- Someone else's text ---------- */

/**
 * The text inside any of the engine's fences (`<<<REQUEST-DATA ...>>>`, `<<<FAULT-DATA ...>>>`,
 * `<<<SHAPE-LOOKUPS-DATA ...>>>`): the opening and closing marker lines removed, nothing else changed. Anything that
 * does not look like one fence gives null, so nothing unfenced is ever shown.
 */
export function unfence(fenced: string | null | undefined): string | null {
  if (typeof fenced !== "string") return null;
  const lines = fenced.split("\n");
  if (lines.length < 2) return null;
  const open = (lines[0] ?? "").match(/^<<<([A-Z]+(?:-[A-Z]+)*-DATA) /);
  const close = lines[lines.length - 1] ?? "";
  if (!open || !close.startsWith(`<<<END-${open[1]} `)) return null;
  return lines.slice(1, -1).join("\n");
}

export interface SourcePart {
  part: string;
  heading: string;
  text: string | null;
}

/** Where the idea came from, ready to show. `quote` and `parts` are someone else's words: shown as text, never followed. */
export interface SourceView {
  kind: string;
  /** The engine's words for the source ("From a request", "A fault from production"...). */
  words: string;
  /** Who wrote the text, in plain words, for the quotation's caption. Null when there is no outside text. */
  whose: string | null;
  number: number | null;
  ticket: string | null;
  rule: string | null;
  /** Only an address the engine gave, and only a GitHub one. */
  url: string | null;
  /** An idea-template issue's five parts, each unfenced. */
  parts: SourcePart[] | null;
  /** The whole text, unfenced, when there are no parts. */
  quote: string | null;
  /** True when the source has outside text, but this computer could not show it. */
  textMissing: boolean;
}

const whoseWords: Record<string, string> = {
  request: "The requester's words",
  idea: "The words of whoever filed it",
  fault: "As the fault was reported",
};

export function sourceView(source: IdeaSourceShown): SourceView {
  const outside = source.kind === "request" || source.kind === "idea" || source.kind === "fault";
  const parts = outside && source.text_shown !== false && Array.isArray(source.parts) && source.parts.length
    ? source.parts.map((p) => ({ part: p.part, heading: p.heading, text: unfence(p.fenced) }))
    : null;
  const quote = outside && !parts && source.text_shown !== false ? unfence(source.fenced) : null;
  return {
    kind: source.kind,
    words: source.words,
    whose: outside ? (whoseWords[source.kind] ?? "Someone else's words") : null,
    number: typeof source.number === "number" ? source.number : null,
    ticket: source.ticket ?? null,
    rule: source.rule ?? null,
    url: typeof source.url === "string" && /^https:\/\/github\.com\//.test(source.url) ? source.url : null,
    parts,
    quote,
    textMissing: outside && !parts && quote === null,
  };
}

/* ---------- What MACH looked up ---------- */

export type LookupGroupKey = "today" | "wanted" | "in-the-way";

export type LookupEntry =
  | { kind: "rule"; key: string; rule: LookupShippedRule }
  | { kind: "similar"; key: string; similar: LookupSimilar }
  | { kind: "principle"; key: string; principle: LookupPrinciple }
  | { kind: "policy"; key: string; policy: LookupPolicy };

export interface LookupGroup {
  key: LookupGroupKey;
  title: string;
  /** What the group is, in one sentence. */
  about: string;
  entries: LookupEntry[];
}

export interface LookupsView {
  /** "none": nothing recorded yet. "recorded": recorded, perhaps with every group empty. */
  state: "none" | "recorded";
  recordedAt: string | null;
  /** Every group, in the order the sketch gives them; a group may be empty. */
  groups: LookupGroup[];
  /** How many groups hold anything. */
  filled: number;
  /** The app's form (`items`) was missing, so only the IDs are shown. */
  idsOnly: boolean;
}

const groupTitles: Record<LookupGroupKey, { title: string; about: string }> = {
  today: { title: "What exists today", about: "Rules already shipped and in force that this idea would touch." },
  wanted: { title: "What is already wanted", about: "Other ideas and requests that look like this one." },
  "in-the-way": { title: "What stands in the way", about: "Product principles and policy statements this idea would run into, flagged now so they are settled here and not at the spec." },
};

export function lookupsView(lookups: IdeaLookups | null | undefined): LookupsView {
  const group = (key: LookupGroupKey, entries: LookupEntry[]): LookupGroup => ({ key, ...groupTitles[key], entries });
  if (!lookups) {
    return { state: "none", recordedAt: null, groups: [group("today", []), group("wanted", []), group("in-the-way", [])], filled: 0, idsOnly: false };
  }
  const items = lookups.items;
  const idsOnly = !items;
  const rules: LookupShippedRule[] = items?.shipped_rules ?? lookups.ids.shipped_rules.map((rule) => ({ rule, in_force: true, epic_id: null }));
  const similar: LookupSimilar[] = items?.similar ?? lookups.ids.similar.map((id) => (typeof id === "number" ? { request: id } : { idea: id }));
  const principles: LookupPrinciple[] = items?.principles ?? lookups.ids.principles.map((id) => ({ id }));
  const policies: LookupPolicy[] = items?.policies ?? lookups.ids.policies.map((id) => ({ id }));
  const groups = [
    group("today", rules.map((rule) => ({ kind: "rule" as const, key: `rule-${rule.rule}`, rule }))),
    group(
      "wanted",
      similar.map((s) => ({ kind: "similar" as const, key: s.idea ? `idea-${s.idea}` : `request-${s.request ?? "?"}`, similar: s })),
    ),
    group("in-the-way", [
      ...principles.map((principle) => ({ kind: "principle" as const, key: `principle-${principle.id}`, principle })),
      ...policies.map((policy) => ({ kind: "policy" as const, key: `policy-${policy.id}`, policy })),
    ]),
  ];
  return { state: "recorded", recordedAt: lookups.recorded_at ?? null, groups, filled: groups.filter((g) => g.entries.length).length, idsOnly };
}

/** The epics whose "how it works today" holds the looked-up rules, each once, in the order first named. */
export function ruleEpics(rules: LookupShippedRule[]): string[] {
  return [...new Set(rules.map((r) => r.epic_id).filter((id): id is string => typeof id === "string" && /^EPIC-\d{3,}$/.test(id)))];
}

/** A shipped rule's own words, from its epic's current view; null when that view does not hold it. */
export function ruleWords(current: EpicCurrent | null | undefined, rule: string): string | null {
  const found = current?.epic?.in_force.find((r) => r.rule === rule) ?? current?.epic?.not_yet_reconciled.find((r) => r.rule === rule);
  return found?.text ?? null;
}

/** A principle's statement, by its exact ID; null when the list does not hold it. */
export function principleStatement(list: PrincipleList | null | undefined, id: string): string | null {
  return list?.principles.find((p) => p.id === id)?.statement ?? null;
}

/**
 * A policy pack or statement, by its exact ID: the pack's title and owner, and the statement's text when the ID is a
 * statement's. Null when no pack holds it.
 */
export function policyFacts(list: PolicyList | null | undefined, id: string): { pack: string; title: string | null; owner: string | null; text: string | null } | null {
  for (const pack of list?.packs ?? []) {
    if (pack.id === id) return { pack: pack.id, title: pack.title, owner: pack.owner, text: null };
    const statement = pack.statements?.find((s) => s.id === id);
    if (statement) return { pack: pack.id, title: pack.title, owner: pack.owner, text: statement.text };
  }
  return null;
}

/* ---------- The conversation ---------- */

/**
 * An open question as the Shape conversation writes it: `❓ **Q4** - **Who it affects**: Who would not want this?`.
 * Shape's questions carry no recommended answer, so the host does not parse them as interview questions; this reads
 * the number, the topic and the question for display only. Anything else gives null and is shown as written.
 */
export interface OpenQuestion {
  number: number;
  title: string;
  body: string;
  preface: string | null;
}

const OPEN_QUESTION = /^(?<preface>[\s\S]*?)❓\s*\*\*Q(?<number>\d+)\*\*\s*[-–—]\s*\*\*(?<title>[^*\n]+?)\*\*\s*:?\s*(?<body>[\s\S]*?)\s*$/;

export function openQuestion(text: string): OpenQuestion | null {
  if ((text.match(/❓/g) ?? []).length !== 1) return null;
  const m = text.trim().match(OPEN_QUESTION);
  const groups = m?.groups;
  if (!groups || !groups.body) return null;
  return {
    number: Number(groups.number),
    title: (groups.title ?? "").trim(),
    body: groups.body.trim(),
    preface: groups.preface?.trim() || null,
  };
}

/**
 * The terminal command that explores this idea, from the host's continue command (`/mach:product-studio continue`
 * or `/mach-product-studio continue`): the same skill, with `explore`, as the host's own opening is. Null when the host
 * did not report a command in that form.
 */
export function exploreCommand(continueCommand: string | null | undefined, ideaId: string): string | null {
  if (!continueCommand) return null;
  const skill = continueCommand.trim().match(/^(\/\S+)\s+continue$/);
  return skill ? `${skill[1]} explore ${ideaId}` : null;
}

/* ---------- Where the idea stands on this page ---------- */

/**
 * What this page offers for the idea's stage: "new" offers Start exploring (the one stage set by hand); "shaped" has
 * its brief kept as it was when its slices were made, so the conversation is not offered; otherwise the conversation.
 */
export type ExploreMode = "new" | "open" | "shaped";

export function exploreMode(row: Pick<IdeaRow, "stage">): ExploreMode {
  if (row.stage === "new") return "new";
  if (row.stage === "shaped") return "shaped";
  return "open";
}

/** The way on to the brief step, once a brief exists, with the engine's facts about it in words. */
export function briefWayOn(show: Pick<IdeaShow, "brief"> | null | undefined): { state: string } | null {
  const brief = show?.brief;
  if (!brief?.exists) return null;
  if (brief.changed_since_check) return { state: "It has changed since it was last checked." };
  if (!brief.revision) return { state: "It has not been checked yet." };
  return { state: brief.passes ? "It passes its check." : "It does not pass its check yet." };
}
