/**
 * What the ideas board shows, from the engine's answers alone. Pure, so it is unit-tested against the real fixtures
 * (test/shape-ideas-model.test.mjs). It maps what the engine reported (stage, source, verdict, where the idea is saved)
 * to words and a look, keeps the engine's own order, and builds the arguments of `idea.add`. It decides no product
 * rule: no stage, verdict, next step or ranking is worked out here, and every act can still be refused in the engine's
 * words.
 */
import type { FaultTicket, IdeaGithubView, IdeaRow, IdeaSourceIds, IdeaStage, RequestItem, StatusIdeas } from "@mach/ui/api";

export const stages: readonly IdeaStage[] = ["new", "exploring", "brief", "decided", "shaped"];

/** The engine's words for each place (`stage_words`), used for a column no row has reported words for yet. */
const stageFallback: Record<IdeaStage, string> = {
  new: "New",
  exploring: "Exploring",
  brief: "Brief written",
  decided: "Decided",
  shaped: "Shaped into work",
};

/** One sentence under each column's name: what being in that place means. Presentation only. */
export const stageMeaning: Record<IdeaStage, string> = {
  new: "Added, not explored yet.",
  exploring: "Being talked through, with the facts looked up.",
  brief: "A brief is written; the verdict comes next.",
  decided: "Go, Not now or No, each kept with its reason.",
  shaped: "Turned into epics and slices.",
};

export interface BoardColumn {
  stage: IdeaStage;
  words: string;
  meaning: string;
  rows: IdeaRow[];
}

/**
 * The five columns, always all five, each holding its ideas in the engine's order (`by_stage`). An idea the engine
 * listed in `ideas` but not in `by_stage` still appears, after the listed ones, so nothing on the board is lost. An
 * idea at a place the app does not know is not dropped either: it goes into `elsewhere`.
 */
export function boardColumns(board: Pick<StatusIdeas, "ideas" | "by_stage">): { columns: BoardColumn[]; elsewhere: IdeaRow[] } {
  const byId = new Map(board.ideas.map((row) => [row.idea_id, row]));
  const placed = new Set<string>();
  const columns = stages.map((stage) => {
    const rows: IdeaRow[] = [];
    for (const id of board.by_stage?.[stage] ?? []) {
      const row = byId.get(id);
      if (row && row.stage === stage && !placed.has(id)) {
        rows.push(row);
        placed.add(id);
      }
    }
    for (const row of board.ideas) {
      if (row.stage === stage && !placed.has(row.idea_id)) {
        rows.push(row);
        placed.add(row.idea_id);
      }
    }
    const words = rows[0]?.stage_words ?? stageFallback[stage];
    return { stage, words, meaning: stageMeaning[stage], rows };
  });
  return { columns, elsewhere: board.ideas.filter((row) => !placed.has(row.idea_id)) };
}

/** The engine's own words for each source (shape.py's source view), with the identifier said beside them. */
export const sourceWordsByKind: Record<string, string> = {
  typed: "Typed by the product manager",
  idea: "Filed in the idea template",
  request: "From a request",
  fault: "A fault from production",
  change: "A change to a rule that has shipped",
};

export interface SourceShown {
  /** Where it came from, in words. */
  words: string;
  /** The issue, ticket or rule it came from, shown as an identifier; null when typed. */
  id: string | null;
  /** The issue number, when it came from one. */
  issue: number | null;
}

/** Where an idea came from: words, and the identifier the engine gave (never the issue's text). */
export function sourceShown(source: IdeaSourceIds): SourceShown {
  const words = sourceWordsByKind[source.kind] ?? String(source.kind);
  if ((source.kind === "request" || source.kind === "idea") && typeof source.number === "number") return { words, id: `#${source.number}`, issue: source.number };
  if (source.kind === "fault" && source.ticket) return { words, id: source.ticket, issue: null };
  if (source.kind === "change" && source.rule) return { words, id: source.rule, issue: null };
  return { words, id: null, issue: null };
}

export interface Look {
  word: string;
  /** One sentence for the pill's title. */
  description: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  glyph: "open" | "half" | "ready" | "approved" | "submitted" | "building" | "question" | "accepted" | "blocked" | "superseded";
}

/** The verdict as a word and a shape. A decision the app does not know is shown by its own word. */
export function verdictLook(decision: string): Look {
  switch (decision) {
    case "go":
      return { word: "Go", description: "The product manager decided to go ahead.", tone: "success", glyph: "approved" };
    case "not-now":
      return { word: "Not now", description: "The product manager decided not to do it now. It stays on the board.", tone: "warning", glyph: "superseded" };
    case "no":
      return { word: "No", description: "The product manager decided not to do it. It stays on the board with the reason.", tone: "neutral", glyph: "blocked" };
    default:
      return { word: decision, description: "The verdict as recorded.", tone: "neutral", glyph: "ready" };
  }
}

/** Whether the card quotes the verdict's reason: a decided idea, the engine having reported a verdict for it. */
export function showsReason(row: Pick<IdeaRow, "stage" | "verdict">): boolean {
  return row.stage === "decided" && row.verdict !== null;
}

export type SavedKey = "changed_after_verdict" | "changed_on_github" | "unfinished" | "number_taken" | "github" | "folder" | "not_yet";

export interface SavedShown extends Look {
  key: SavedKey;
  /** The idea's issue, where the engine reported one. */
  issue: number | null;
  url: string | null;
  /** Whether this is something for the person to look at (shown as a pill) or a quiet fact (shown as a line). */
  attention: boolean;
}

/**
 * Where the idea is saved, from the engine's flags (`github`), the most pressing first. Exactly one is shown on a
 * card, so the card stays uncluttered; the idea's own pages say the rest.
 */
export function savedShown(github: IdeaGithubView): SavedShown {
  const issue = typeof github.issue === "number" ? github.issue : null;
  const url = github.url ?? null;
  const base = { issue, url };
  if (github.changed_on_github && github.changed_after_verdict) {
    return { ...base, key: "changed_after_verdict", attention: true, word: "Changed on GitHub after the verdict", description: "Someone edited its issue after the verdict was recorded. Save it again to put your brief back.", tone: "danger", glyph: "blocked" };
  }
  if (github.changed_on_github) {
    return { ...base, key: "changed_on_github", attention: true, word: "Changed on GitHub", description: "Someone edited its issue on GitHub since you saved it.", tone: "warning", glyph: "blocked" };
  }
  if (github.unfinished) {
    return { ...base, key: "unfinished", attention: true, word: "Saving stopped part way", description: "Saving it to GitHub did not finish. Save it again to finish; nothing is made twice.", tone: "warning", glyph: "blocked" };
  }
  if (github.number_taken) {
    return { ...base, key: "number_taken", attention: true, word: "Number taken on GitHub", description: "Another idea on GitHub already uses this number. Saving it gives it the next free number.", tone: "warning", glyph: "blocked" };
  }
  if (github.saved === "github") {
    return { ...base, key: "github", attention: false, word: "Saved on GitHub", description: "Saved as an issue others can read.", tone: "neutral", glyph: "submitted" };
  }
  if (github.saved === "folder") {
    return { ...base, key: "folder", attention: false, word: "Saved to the folder", description: "Saved in the ready folder, because GitHub could not be used here.", tone: "neutral", glyph: "submitted" };
  }
  return { ...base, key: "not_yet", attention: false, word: "Only here so far", description: "Not saved to GitHub or the folder yet. It is safe in this workspace.", tone: "neutral", glyph: "open" };
}

/** "1 idea", "8 ideas". */
export const ideaCount = (n: number): string => `${n} ${n === 1 ? "idea" : "ideas"}`;

/** What `idea.add` is started from. */
export type StartFrom =
  | { kind: "nothing" }
  | { kind: "request"; number: number }
  | { kind: "idea"; number: number }
  /** A fault from production: an open self-healing ticket on this computer, by its ID (`idea.faults`). */
  | { kind: "fault"; ticket: string };

export type AddIdeaArgs = { title: string; from_request?: number; from_issue?: number; from_fault?: string };

/** The engine's limit on a title (one line, at most 120 characters). */
export const titleLimit = 120;

/** A title is one line: a line break typed or pasted becomes a space. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

/** What to ask before anything is sent, or null when the title can be sent. The engine still checks it. */
export function titleProblem(title: string): string | null {
  const trimmed = oneLine(title).trim();
  if (!trimmed) return "Give the idea a short title, such as: Let members renew a loan themselves.";
  if (trimmed.length > titleLimit) return `Keep the title to ${titleLimit} characters or fewer; it has ${trimmed.length}. The brief holds the detail.`;
  return null;
}

/** `idea.add`'s arguments: the title trimmed to one line, and at most one source. */
export function addIdeaArgs(title: string, from: StartFrom): AddIdeaArgs {
  const args: AddIdeaArgs = { title: oneLine(title).trim() };
  if (from.kind === "request") args.from_request = from.number;
  if (from.kind === "idea") args.from_issue = from.number;
  if (from.kind === "fault") args.from_fault = from.ticket;
  return args;
}

/**
 * The faults an idea can start from, out of what the engine listed (`idea.faults`): the open ones no idea has started
 * from yet. A fault already started from is not offered again.
 */
export function faultOptions(faults: readonly FaultTicket[] | null | undefined): FaultTicket[] {
  return (faults ?? []).filter((fault) => !fault.idea_id);
}

/** A fault's line in a choice: its ticket, then its summary as written (outside text, shown plain). */
export function faultOption(fault: Pick<FaultTicket, "ticket" | "summary">): string {
  return fault.summary ? `${fault.ticket}: ${fault.summary}` : `${fault.ticket} (no summary on this computer)`;
}

/**
 * What an idea can be started from, out of what the engine listed (`request.list`): every request it holds, and the
 * ones filed in the idea template. Nothing is offered that the engine did not list.
 */
export function startOptions(items: readonly RequestItem[] | null | undefined): { requests: RequestItem[]; ideaIssues: RequestItem[] } {
  const listed = items ?? [];
  return { requests: [...listed], ideaIssues: listed.filter((item) => item.idea_template === true) };
}

/** An issue's line in a choice: its number, then its title as written (outside text, shown plain). */
export function issueOption(item: Pick<RequestItem, "number" | "title">): string {
  return item.title ? `#${item.number}: ${item.title}` : `#${item.number} (title not recorded)`;
}
