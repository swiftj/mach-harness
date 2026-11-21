/**
 * A design you already have: the screens' logic, from the engine's answers alone (design.list, design.show,
 * design.settle, design.publish). Pure, so it is unit-tested (test/needs-design-model.test.mjs). It adds no product
 * rule: the engine decides every act and can refuse any of them; this only says what to show and what a button sends.
 * It never chooses, ranks or recommends how a conflict is settled, and it offers no act on an engineer's decision.
 */
import type { DesignConflict, DesignLines, DesignMap, DesignSettleAs, DesignShow, DesignSummary, DesignTopicState } from "@mach/ui/api";
import { unfence } from "../../../shared/unfence.ts";

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/* ── Where a design stands ─────────────────────────────────────────────── */

export type DesignStage = "changed-copy" | "not-read" | "conflicts" | "ready" | "published" | "changed";

/** Where a design stands, from its summary: the list's pill and the page's narrow pane. */
export function designStage(design: DesignSummary): DesignStage {
  if (!design.document_matches) return "changed-copy";
  if (!design.mapped) return "not-read";
  if ((design.unsettled ?? []).length > 0) return "conflicts";
  if (design.published) return design.unpublished_changes ? "changed" : "published";
  return "ready";
}

/** The stage in words, the same on the list and the page. */
export function stageWord(design: DesignSummary): string {
  switch (designStage(design)) {
    case "changed-copy":
      return "Copy changed";
    case "not-read":
      return "Not read yet";
    case "conflicts": {
      const n = (design.unsettled ?? []).length;
      return `${count(n, "conflict")} waiting`;
    }
    case "ready":
      return "Ready to publish";
    case "published":
      return "Published";
    case "changed":
      return "Changed since published";
  }
}

/** "Markdown, 5 sections, 22 lines": what was brought in. */
export function designFacts(design: Pick<DesignSummary, "format" | "sections" | "line_count">): string {
  const format = design.format === "markdown" ? "Markdown" : design.format === "text" ? "Plain text" : "A text file";
  return `${format}, ${count(design.sections, "section")}, ${count(design.line_count, "line")}`;
}

/** Each topic's state counted, in the engine's three states. */
export function topicCounts(topics: Record<string, DesignTopicState> | Record<string, { state: DesignTopicState }> | undefined): Record<DesignTopicState, number> {
  const out: Record<DesignTopicState, number> = { decided: 0, partly: 0, silent: 0 };
  for (const value of Object.values(topics ?? {}) as Array<DesignTopicState | { state: DesignTopicState }>) {
    const state: DesignTopicState = typeof value === "string" ? value : value.state;
    out[state] += 1;
  }
  return out;
}

/** What the document decides, in one line: "Decides 1 of 6 topics, partly decides 1, silent on 4, and makes 1 other decision". */
export function decidesSentence(topics: Record<string, DesignTopicState> | Record<string, { state: DesignTopicState }> | undefined, other: number): string {
  const c = topicCounts(topics);
  const total = c.decided + c.partly + c.silent;
  const parts = [`Decides ${c.decided} of ${count(total, "topic")}`];
  if (c.partly) parts.push(`partly decides ${c.partly}`);
  if (c.silent) parts.push(`silent on ${c.silent}`);
  const head = parts.join(", ");
  return other ? `${head}, and makes ${count(other, "other decision")}` : head;
}

/** One line for a design's row on the list. */
export function listLine(design: DesignSummary): string {
  if (!design.document_matches) return "The copy in your workspace no longer matches what was brought in. Bring the document in again.";
  if (!design.mapped) return "Not read yet: the conversation on Technical needs reads it";
  const read = decidesSentence(design.topics, design.other ?? 0);
  const waiting = design.unsettled ?? [];
  if (waiting.length) return `${read}. ${waiting.length === 1 ? "1 conflict waits" : `${waiting.length} conflicts wait`} for your word.`;
  if (design.conflicts) return `${read}. ${design.conflicts === 1 ? "Its conflict is settled" : `Its ${design.conflicts} conflicts are settled`}.`;
  return `${read}. It contradicts nothing you said.`;
}

/* ── The document, as data ────────────────────────────────────────────── */

/**
 * The numbered lines inside the engine's design fence (`<<<DESIGN-DATA ...>>>`), by line number. Anything that is not
 * one such fence gives null, so nothing unfenced is ever shown. The text is kept exactly as the engine bounded and
 * redacted it.
 */
export function designLines(fenced: string | null | undefined): Map<number, string> | null {
  if (typeof fenced !== "string" || !fenced.startsWith("<<<DESIGN-DATA ")) return null;
  const inside = unfence(fenced);
  if (inside === null) return null;
  const out = new Map<number, string>();
  for (const line of inside.split("\n")) {
    const match = /^\s*(\d+)\| ?(.*)$/.exec(line);
    if (match) out.set(Number(match[1]), match[2] ?? "");
  }
  return out;
}

/** The engine's merged line ranges ([[7, 9], [13, 13]]) as "7-9, 13-13", for the shared quotation helpers. */
export function rangesText(lines: DesignLines | undefined): string {
  return (lines ?? [])
    .filter((pair) => pair.length >= 2)
    .map((pair) => `${pair[0]}-${pair[1]}`)
    .join(", ");
}

/** "line 22", "lines 7 to 9", "lines 7 to 9 and 13". */
export function linesWords(lines: DesignLines | undefined): string {
  const pairs = (lines ?? []).filter((pair) => pair.length >= 2) as Array<[number, number]>;
  const one = ([a, b]: [number, number]) => (a === b ? `${a}` : `${a} to ${b}`);
  if (!pairs.length) return "no lines";
  const single = pairs.length === 1 && pairs[0]?.[0] === pairs[0]?.[1];
  return `${single ? "line" : "lines"} ${pairs.map(one).join(" and ")}`;
}

/* ── What the engineers must decide ───────────────────────────────────── */

export interface TopicRow {
  topic: string;
  /** The topic's name, from the engine's description ("Data storage"). */
  name: string;
  /** What the topic covers, from the engine's description. */
  means: string;
  /** Null before the document is read. */
  state: DesignTopicState | null;
  summary: string | null;
  missing: string | null;
  lines: DesignLines;
}

/** "Data storage: where and how ..." split into its name and what it covers. Without a colon, the topic's own word. */
export function topicName(topic: string, means: string): { name: string; means: string } {
  const at = means.indexOf(": ");
  if (at > 0) {
    const rest = means.slice(at + 2);
    return { name: means.slice(0, at), means: rest.charAt(0).toUpperCase() + rest.slice(1) };
  }
  return { name: topic.charAt(0).toUpperCase() + topic.slice(1).replace(/-/g, " "), means };
}

/** The required topics in the engine's order, each with what the map says of it (or nothing, before it is read). */
export function topicRows(show: Pick<DesignShow, "topics_to_map" | "map">): TopicRow[] {
  const listed = show.topics_to_map.map((t) => t.topic);
  // A topic the map holds that is no longer required (the project's topics changed) is still shown, after them.
  const extra = Object.keys(show.map?.topics ?? {}).filter((t) => !listed.includes(t));
  return [...show.topics_to_map, ...extra.map((topic) => ({ topic, means: "" }))].map(({ topic, means }) => {
    const entry = show.map?.topics[topic];
    return {
      topic,
      ...topicName(topic, means),
      state: entry?.state ?? null,
      summary: entry?.summary ?? null,
      missing: entry?.missing ?? null,
      lines: entry?.lines ?? [],
    };
  });
}

export const topicStateWords: Record<DesignTopicState, string> = { decided: "Decided", partly: "Partly decided", silent: "Silent" };

/** `topic:search` as "search"; `path:src/**` as the path; `app:web` as "web applications"; `all` as "everything". */
export function appliesWords(applies: readonly string[]): string {
  const one = (value: string): string => {
    if (value === "all") return "everything";
    const at = value.indexOf(":");
    if (at < 0) return value;
    const [kind, what] = [value.slice(0, at), value.slice(at + 1)];
    if (kind === "topic") return what.replace(/-/g, " ");
    if (kind === "app") return `${what} applications`;
    return what;
  };
  return applies.map(one).join(", ");
}

/* ── Conflicts ────────────────────────────────────────────────────────── */

export type AgainstKind = "need" | "principle" | "policy";

/** What a conflict names: a technical need (TN-NN), a product principle (PP-NN) or a policy statement (POL-...). */
export function againstKind(against: string): AgainstKind {
  if (against.startsWith("TN-")) return "need";
  if (against.startsWith("PP-")) return "principle";
  return "policy";
}

export const againstWords: Record<AgainstKind, string> = { need: "Technical need", principle: "Product principle", policy: "Policy statement" };

/**
 * The three ways to settle a conflict, in one fixed order, each worded from the engine's own meaning
 * (design.py SETTLE_WORDS). None is a default, none is recommended, and each needs the person's reason.
 */
export const settleChoices: ReadonlyArray<{ as: DesignSettleAs; word: string; meaning: string }> = [
  { as: "stands", word: "The design stands", meaning: "It holds, and the engineer weighs it against the other." },
  { as: "design-is-wrong", word: "The design is wrong", meaning: "It is wrong on this point, and the other holds." },
  { as: "ask-engineer", word: "Ask the engineer", meaning: "The engineer decides which of the two holds." },
];

export const settleWord = (as: DesignSettleAs): string => settleChoices.find((c) => c.as === as)?.word ?? as;

/** The reason's limit, the engine's own (design.REASON_CHARS, the host's bound). */
export const reasonLimit = 300;

/** The reason as it will be kept: one line, spaces collapsed. */
export const oneLine = (text: string): string => text.trim().replace(/\s+/g, " ");

/** What the settle form still needs, in words, or null. */
export function settleFormProblem(as: DesignSettleAs | null, reason: string): { field: "choice" | "reason"; message: string } | null {
  if (!as) return { field: "choice", message: "Choose one of the three." };
  const line = oneLine(reason);
  if (!line) return { field: "reason", message: "Give your reason, in your words." };
  if (line.length > reasonLimit) return { field: "reason", message: `Keep your reason to ${reasonLimit} characters; it is ${line.length}.` };
  return null;
}

/** What `design.settle` is sent. `by` is left out: the engine records "the product manager". */
export function settleArgs(designId: string, conflict: number, as: DesignSettleAs, reason: string): { design_id: string; conflict: number; as: DesignSettleAs; reason: string } {
  return { design_id: designId, conflict, as, reason: oneLine(reason) };
}

/** The conflicts waiting first, then the settled ones, each in the map's order. */
export function conflictsInOrder(map: Pick<DesignMap, "conflicts" | "unsettled">): DesignConflict[] {
  const waiting = new Set(map.unsettled);
  return [...map.conflicts.filter((c) => waiting.has(c.n)), ...map.conflicts.filter((c) => !waiting.has(c.n))];
}

/* ── The parts of the page (M16 layout) ───────────────────────────────── */

export type DesignPart = "read" | "settle" | "publish";
export const DESIGN_PARTS: readonly DesignPart[] = ["read", "settle", "publish"];

/** The part that needs the product manager: read it, then settle what waits, then publish (open once done). */
export function partForDesign(show: Pick<DesignShow, "map">): DesignPart {
  if (!show.map) return "read";
  if (show.map.unsettled.length > 0) return "settle";
  return "publish";
}

/** Where a part is on the path. Publishing is done once published with nothing changed since. */
export function designPartPlace(part: DesignPart, show: Pick<DesignShow, "map">): "done" | "current" | "later" {
  const at = DESIGN_PARTS.indexOf(partForDesign(show));
  const index = DESIGN_PARTS.indexOf(part);
  if (part === "publish" && show.map?.published && !show.map.unpublished_changes && show.map.unsettled.length === 0) return "done";
  return index < at ? "done" : index === at ? "current" : "later";
}

/** The read part in one line. */
export function readSummary(show: Pick<DesignShow, "map">): string {
  if (!show.map) return "Not read yet: the conversation on Technical needs reads it";
  return decidesSentence(show.map.topics, show.map.other.length);
}

/** The settle part in one line. */
export function settleSummary(show: Pick<DesignShow, "map">): string {
  const map = show.map;
  if (!map) return "After it is read";
  if (!map.conflicts.length) return "No conflict: it contradicts nothing you already said";
  if (map.unsettled.length) return `${map.unsettled.length === 1 ? "1 conflict waits" : `${map.unsettled.length} conflicts wait`} for your word: ${map.unsettled.join(", ")}`;
  return `Every conflict is settled, ${map.conflicts.length} of ${map.conflicts.length}`;
}

export type PublishState = "not-read" | "blocked" | "ready" | "published" | "changed";

export function publishState(show: Pick<DesignShow, "map">): PublishState {
  const map = show.map;
  if (!map) return "not-read";
  if (map.unsettled.length) return "blocked";
  if (map.published) return map.unpublished_changes ? "changed" : "published";
  return "ready";
}

/**
 * Why publishing is not offered yet, said before the click, or null. While a conflict waits it is the engine's own
 * refusal (design.py, the app's wording) without its "Nothing was published:" opening, as nothing was tried yet.
 */
export function publishBlocked(designId: string, show: Pick<DesignShow, "map">): string | null {
  const map = show.map;
  if (!map) return `${designId} is read first, in the conversation on Technical needs. Nothing can be published before that.`;
  const waiting = map.unsettled;
  if (!waiting.length) return null;
  const n = waiting.length;
  return `${n} conflict${n !== 1 ? "s" : ""} of ${designId} ${n !== 1 ? "wait" : "waits"} for your word (${waiting.join(", ")}). Settle each first.`;
}

/** The publish part in one line. */
export function publishSummary(designId: string, show: Pick<DesignShow, "map">): string {
  switch (publishState(show)) {
    case "not-read":
      return "After it is read";
    case "blocked":
      return `Waits for the conflicts: ${show.map?.unsettled.join(", ")}`;
    case "ready":
      return `Ready to publish ${designId} to a folder for you to commit`;
    case "published":
      return "Published to a folder for you to commit";
    case "changed":
      return "Changed since it was published: publish it again";
  }
}

/** The publish button's words; the toast uses the same verb. */
export function publishLabel(designId: string, state: PublishState): string {
  return state === "published" || state === "changed" ? `Publish ${designId} again` : `Publish ${designId}`;
}
