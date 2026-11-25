/**
 * Moving the whole project (M21 F): the one place the app reads what `project export`, `project import`, `project import
 * --abandon` and `project imports` answered. Pure, so it is unit-tested against the real runs in web/fixtures
 * (test/move-model.test.mjs). Every sentence a person reads here is the engine's own; this only picks out the lists and
 * puts each in one place on the screen. Fields the engine is still gaining are read when present and never required
 * (see `assumed` in @mach/ui/api/move.ts): a field with another name is changed here.
 */
import type {
  DownloadOffer,
  MoveCounts,
  MoveItem,
  MoveSlice,
  ProjectExport,
  ProjectImportDone,
  ProjectImportResult,
  ProjectImportShared,
  ProjectImportsList,
  ProjectImportsLookup,
  Status,
} from "@mach/ui/api";

/* ── Small words ────────────────────────────────────────────────────── */

const NOUNS: Record<string, [string, string]> = {
  epics: ["epic", "epics"],
  slices: ["slice", "slices"],
  principles: ["principle", "principles"],
  needs: ["technical need", "technical needs"],
  ideas: ["idea", "ideas"],
  prds: ["PRD", "PRDs"],
  designs: ["design", "designs"],
  mocks: ["design mock", "design mocks"],
};

/** The kinds of an ID map, in the engine's order, as nouns. */
const KIND_NOUNS: Record<string, [string, string]> = {
  EPIC: ["epic", "epics"],
  SLICE: ["slice", "slices"],
  PP: ["principle", "principles"],
  TN: ["technical need", "technical needs"],
  IDEA: ["idea", "ideas"],
  PRD: ["PRD", "PRDs"],
  DES: ["design", "designs"],
};

const count = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

/** "2 epics, 3 slices and 1 principle": every kind with at least one, in the engine's order. */
export function holdsWords(counts: MoveCounts | Record<string, number> | null | undefined): string {
  const parts = Object.entries(NOUNS)
    .map(([key, noun]) => [(counts as Record<string, number> | undefined)?.[key] ?? 0, noun] as const)
    .filter(([n]) => typeof n === "number" && n > 0)
    .map(([n, noun]) => count(n, noun));
  return listWords(parts) || "nothing yet";
}

/** "a, b and c". */
export function listWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** A listed thing in the engine's words: a sentence when it gives one (after its ID, file and line when it names them),
 *  else its ID. Strings are shown as they are. */
export function itemText(item: unknown): string {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  const row = item as MoveItem;
  const sentence = [row.words, row.in_words, row.text, row.note].find((v): v is string => typeof v === "string" && v.trim() !== "");
  if (sentence) return sentence;
  const why = [row.why, row.reason].find((v): v is string => typeof v === "string" && v.trim() !== "");
  const where = row.file ? `${row.file}${typeof row.line === "number" ? `, line ${row.line}` : ""}` : null;
  const head = [row.id, where ? `(${where})` : null].filter(Boolean).join(" ");
  return [head, why].filter(Boolean).join(": ") || JSON.stringify(item);
}

/** A list from a field that may be absent, a list of strings, a list of objects, or a set of counts. */
export function itemsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(itemText).filter((text) => text !== "");
  if (value && typeof value === "object") {
    const counts = value as Record<string, unknown>;
    if (Object.values(counts).every((v) => typeof v === "number")) {
      const words = holdsWords(counts as Record<string, number>);
      return words === "nothing yet" ? [] : [words];
    }
  }
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

/** A sentence field that may be absent. */
const sentence = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/* ── Taking the project elsewhere (`project export`) ─────────────────── */

export interface ExportView {
  /** "2 epics, 3 slices and 1 principle". */
  holds: string;
  fileName: string | null;
  bytes: number;
  download: DownloadOffer | null;
  /** The host's sentence when it cannot offer the file (larger than it serves), with where it is. */
  downloadProblem: string | null;
  /** The engine's first sentence: what the file holds and what was read from GitHub. */
  lead: string | null;
  /** Where this workspace and GitHub differed, which version went in and why (`chosen[].note`), as written. */
  chosen: string[];
  /** What did not go in, each with its reason as written (`not_included[].reason`). */
  notIncluded: string[];
  /** GitHub could not be read for this export: the engine's sentence, said prominently. Null when it was read. */
  githubNotRead: string | null;
  /** The rest of the engine's sentences, in its order, warnings last. */
  rest: string[];
  /** How many things came from this workspace and from GitHub. */
  fromHere: number | null;
  fromGithub: number | null;
  staysBehind: string[];
  /** The engine's note, word for word. */
  note: string;
  /** Lists the engine adds that this screen does not know yet, shown as they come. */
  more: Array<{ title: string; items: string[] }>;
}

/** Fields read above, or of no use to a person (where the file is on this computer, its hash). */
const EXPORT_READ = new Set([
  "exported",
  "file",
  "bytes",
  "sha256",
  "counts",
  "left_out",
  "warnings",
  "stays_behind",
  "note",
  "factory_authorized",
  "downloads",
  "download_problem",
  "from_here",
  "from_github",
  "github",
  "not_included",
  "chosen",
  "in_words",
]);

/** A field's name as a heading: "left_out_why" → "Left out why", GitHub kept as GitHub. */
export function fieldTitle(key: string): string {
  const words = key.replace(/_/g, " ").replace(/\bgithub\b/gi, "GitHub").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function exportView(result: ProjectExport): ExportView {
  const more: ExportView["more"] = [];
  for (const [key, value] of Object.entries(result as unknown as Record<string, unknown>)) {
    if (EXPORT_READ.has(key) || typeof value === "boolean" || typeof value === "number") continue;
    const items = itemsOf(value);
    if (items.length) more.push({ title: fieldTitle(key), items });
  }
  const download = result.downloads?.[0] ?? null;
  const chosen = (result.chosen ?? []).map((row) => row.note).filter((text): text is string => Boolean(sentence(text)));
  const notIncluded = (result.not_included ?? []).map((row) => row.reason).filter((text): text is string => Boolean(sentence(text)));
  // An engine without `in_words` (before the exporter read GitHub): its warnings are the sentences.
  const words = result.in_words ?? itemsOf(result.warnings);
  const lead = result.in_words ? (words[0] ?? null) : null;
  const shownApart = new Set([...chosen, ...notIncluded]);
  let rest = (result.in_words ? words.slice(1) : words).filter((text) => !shownApart.has(text));
  // GitHub not read: its sentence is the one that carries the problem's own words; said apart, prominently.
  let githubNotRead: string | null = null;
  if (result.github && !result.github.checked) {
    const problem = result.github.problem;
    githubNotRead = (problem && rest.find((text) => text.includes(problem))) || (problem ? `MACH could not read GitHub just now: ${problem}` : null);
    if (githubNotRead) rest = rest.filter((text) => text !== githubNotRead);
  }
  return {
    holds: holdsWords(result.counts),
    fileName: download?.name ?? (result.file ? (result.file.split(/[\\/]/).pop() ?? null) : null),
    bytes: download?.bytes ?? result.bytes,
    download,
    downloadProblem: sentence(result.download_problem),
    lead,
    chosen,
    notIncluded,
    githubNotRead,
    rest,
    fromHere: typeof result.from_here?.count === "number" ? result.from_here.count : null,
    fromGithub: typeof result.from_github?.count === "number" ? result.from_github.count : null,
    staysBehind: itemsOf(result.stays_behind),
    note: result.note,
    more,
  };
}

/**
 * The export's refusal about this project's slices that are on GitHub but not in this workspace offers to export without
 * them (`only_mine`). The engine gives no hint for it, so its words are read: "... on GitHub but not in your workspace".
 */
export function offersOnlyMine(message: string | null | undefined): boolean {
  return typeof message === "string" && /on GitHub but not in (?:your|this) workspace/i.test(message);
}

/* ── Bringing a project in (`project import`) ─────────────────────────── */

/** Where a slice was in the old repository that counts as marked ready or further. */
const READY_THERE = new Set(["approved", "ready_to_build", "being_built", "question", "shipped"]);

export interface Renumbered {
  from: string;
  to: string;
}

export interface ImportView {
  /** The project's name in the file. */
  name: string;
  fileName: string;
  /** "joins" this project, or "becomes" the project here. */
  mode: "join" | "new";
  intoProject: string;
  holds: string;
  /** Every ID that gets a new number, old to new, epics first. */
  renumbered: Renumbered[];
  /** "2 epics and 3 slices get new numbers", or null when nothing does. */
  renumberedWords: string | null;
  whyNumbered: string[];
  numbersNote: string | null;
  notes: string[];
  /** Every slice, with where it was there and what it is here. */
  slices: Array<MoveSlice & { readyThere: boolean }>;
  /** How many slices were marked ready or further in the old repository (the engine's count when it gives one). */
  readyThere: number;
  checkByHand: string[];
  notInArchive: string[];
  linksDropped: string[];
  needsNoneLeftBehind: string[];
  shippedRules: string[];
  samePrinciples: string[];
  notAssessed: string[];
  /** Jira keys and the joining project's own words that stay behind, as sentences. */
  leftBehind: string[];
  after: string[];
  note: string;
}

/** A plan or an import that reported the full summary (not "already brought in"). */
export function isFullImport(result: ProjectImportResult): result is ProjectImportResult & ProjectImportShared {
  return !("already" in result && result.already) && Array.isArray((result as ProjectImportShared).slices);
}

export function importView(result: ProjectImportShared & { note: string }): ImportView {
  const renumbered: Renumbered[] = [];
  const changedByKind: Array<[string, number]> = [];
  for (const kind of Object.keys(KIND_NOUNS)) {
    const pairs = (result.map?.[kind] ?? []).filter(([from, to]) => from !== to);
    pairs.forEach(([from, to]) => renumbered.push({ from, to }));
    if (pairs.length) changedByKind.push([kind, pairs.length]);
  }
  const slices = (result.slices ?? []).map((row) => ({ ...row, readyThere: row.status_here !== "superseded" && READY_THERE.has(row.was ?? "") }));
  const assumed = result.would_mark_ready;
  const readyThere = typeof assumed === "number" ? assumed : Array.isArray(assumed) ? assumed.length : slices.filter((s) => s.readyThere).length;
  const left = result.left_behind ?? {};
  const keys = { ...(left.epic_jira ?? {}), ...(left.jira ?? {}) };
  const leftBehind = Object.entries(keys).map(([id, key]) => `${id} had the Jira key ${key}.`);
  const joining = left.project as { name?: string } | null | undefined;
  if (result.mode === "join" && joining && typeof joining === "object" && joining.name) {
    leftBehind.push(`The name, vision and outcomes of “${joining.name}”: this project's own stay as they are.`);
  }
  leftBehind.push(...itemsOf(left.accepted_concerns));
  return {
    name: result.from_project_name || result.from_project,
    fileName: result.archive?.file ?? "",
    mode: result.mode === "join" ? "join" : "new",
    intoProject: result.into_project,
    holds: holdsWords(result.counts),
    renumbered,
    renumberedWords: changedByKind.length ? `${listWords(changedByKind.map(([kind, n]) => count(n, KIND_NOUNS[kind] as [string, string])))} get new numbers` : null,
    whyNumbered: itemsOf(result.why_numbered),
    numbersNote: sentence(result.numbers_note),
    notes: itemsOf(result.notes),
    slices,
    readyThere,
    checkByHand: itemsOf(result.check_by_hand),
    notInArchive: itemsOf(result.not_in_archive),
    linksDropped: itemsOf(result.links_dropped),
    needsNoneLeftBehind: itemsOf(result.needs_none_left_behind),
    shippedRules: itemsOf(result.shipped_rules),
    samePrinciples: itemsOf(result.same_principles),
    notAssessed: itemsOf(result.not_assessed),
    leftBehind,
    after: itemsOf(result.after),
    note: result.note,
  };
}

export interface DoneView extends ImportView {
  /** Files MACH found changed or moved here after an earlier run, in its words. */
  keptYours: string[];
  structuralErrors: string[];
  numbersMoved: string[];
  markedReady: string[];
}

export function doneView(result: ProjectImportDone): DoneView {
  return {
    ...importView(result),
    keptYours: itemsOf(result.kept_yours),
    structuralErrors: itemsOf(result.structural_errors),
    numbersMoved: (result.numbers_moved ?? []).map((row) => `${row.id} was to be ${row.planned} and is ${row.now}.`),
    markedReady: itemsOf(result.marked_ready),
  };
}

/** "SLICE-001 becomes SLICE-031" for the first few, and how many more. */
export function renumberedPreview(pairs: readonly Renumbered[], shown = 3): { first: Renumbered[]; more: number } {
  return { first: pairs.slice(0, shown), more: Math.max(0, pairs.length - shown) };
}

/* ── An import that stopped part way ──────────────────────────────────── */

export interface Unfinished {
  /** The engine's sentence from `status.saved`. */
  text: string;
  /** The archive's SHA-256 from `project imports`: the host keeps the file under it while it has it. */
  sha256: string | null;
  fileName: string | null;
}

/** The `import_unfinished` row of `status.saved`, with the record `project imports` lists as neither finished nor set aside. */
export function unfinishedImport(status: Status | null | undefined, imports?: ProjectImportsList | null): Unfinished | null {
  const row = status?.saved?.not_saved?.find((item) => item.kind === "import_unfinished");
  if (!row) return null;
  const open = imports?.imports?.find((item) => !item.finished_at && !item.set_aside_at) ?? null;
  return { text: row.text, sha256: open?.archive_sha256 ?? null, fileName: open?.file ?? null };
}

/* ── The projects brought in here, and what an ID was ─────────────────── */

export interface ImportRow {
  key: string;
  name: string;
  fileName: string | null;
  /** "brought in", "set aside before it was finished", "being brought in; not finished". */
  state: "finished" | "set-aside" | "unfinished";
  /** The moment of that state. */
  at: string | null;
  joined: boolean;
  holds: string;
}

export function importRows(list: ProjectImportsList | null | undefined): ImportRow[] {
  return (list?.imports ?? []).map((row) => {
    const counted: Record<string, number> = {};
    for (const [kind, n] of Object.entries(row.counts ?? {})) {
      const noun = KIND_NOUNS[kind];
      if (noun) counted[`${noun[1] === "technical needs" ? "needs" : noun[1].toLowerCase()}`] = n;
    }
    return {
      key: row.archive_sha256,
      name: row.from_project_name || row.from_project || "A project",
      fileName: row.file,
      state: row.finished_at ? "finished" : row.set_aside_at ? "set-aside" : "unfinished",
      at: row.finished_at ?? row.set_aside_at ?? row.started_at,
      joined: row.mode === "join",
      holds: holdsWords(counted),
    };
  });
}

/** What a person typed, as an ID the lookup takes, or null with why. */
export function lookupId(typed: string): { id: string } | { problem: string } {
  const id = typed.trim().toUpperCase();
  if (!id) return { problem: "Type an ID, such as SLICE-007." };
  if (!/^(SLICE|EPIC|IDEA|PP|TN|PRD|DES)-[0-9]{2,}$/.test(id)) {
    return { problem: `“${typed.trim().slice(0, 40)}” is not an ID MACH gives. Type one such as SLICE-007, EPIC-002, PP-03 or IDEA-004.` };
  }
  return { id };
}

/** The lookup's answer: each match in the engine's words, or its note when nothing matched. */
export function lookupWords(result: ProjectImportsLookup): string[] {
  const found = (result.found ?? []).map((row) => row.words).filter(Boolean);
  return found.length ? found : [result.note];
}

/* ── Choosing the file ────────────────────────────────────────────────── */

export const PROJECT_FILE_MAX = 64 * 1024 * 1024;

/** The kind and size the host would refuse, said before anything is sent. */
export function fileProblem(file: { name: string; size: number }): string | null {
  if (!file.name.toLowerCase().endsWith(".zip")) return "Choose the file MACH made when the project was downloaded: its name ends in .zip.";
  if (file.size === 0) return "The file is empty. Choose the file MACH made when the project was downloaded.";
  if (file.size > PROJECT_FILE_MAX) {
    return "The file is larger than 64 MB, the most Product Studio takes in the browser. Bring it in with /mach-studio in Claude Code instead, which reads it from this computer.";
  }
  return null;
}

/** A file's size: "640 bytes", "8 KB", "12.5 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** A duration in the family's words: "48 s", "4 min 12 s", "1 h 3 min". */
export function elapsedWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
