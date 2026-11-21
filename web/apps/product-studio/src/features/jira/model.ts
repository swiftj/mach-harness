/**
 * What the Jira screen shows, from the engine's answers alone. Pure, so it is unit-tested
 * (test/jira-model.test.mjs). It decides no product rule: which key a slice is handed over with,
 * what goes in the file and whether a key is acceptable are the engine's; this only arranges what
 * the engine reported, in the product manager's order, with names beside the IDs.
 */
import type { JiraExport, JiraKeys, SliceGithub, SliceStatus, Status, StatusEpicRow, StatusSliceRow } from "@mach/ui/api";

/* ── The keys each epic and slice carries ─────────────────────────────── */

/**
 * A Jira key, as status reports it (`tracking` on each epic and slice row).
 * - `own`: the item's own key, as the engine stored it.
 * - `inherited`: a slice with no key of its own whose epic has one; the slice is handed over with it.
 * - `none`: no key, and (for a slice) none from its epic either.
 */
export type KeyFact = { kind: "own"; key: string } | { kind: "inherited"; key: string; from: string } | { kind: "none" };

export interface LedgerSlice {
  id: string;
  title: string;
  status: SliceStatus;
  github: SliceGithub;
  /** The engine's own word on whether the slice may change now (status `editable`). */
  editable: boolean;
  key: KeyFact;
  /** The slice's own key, when it has one: what "Change" and "Remove" act on. */
  ownKey: string | null;
}

export interface LedgerEpic {
  id: string;
  title: string;
  key: KeyFact;
  slices: LedgerSlice[];
}

/** An epic's key, as its status row reports it. */
export function epicKey(row: StatusEpicRow): KeyFact {
  return row.tracking ? { kind: "own", key: row.tracking.jira } : { kind: "none" };
}

/** A slice's key: its own, else its epic's (shown as inherited), as the engine hands it over. */
export function sliceKey(row: StatusSliceRow, epic: KeyFact, epicId: string): KeyFact {
  if (row.tracking) return { kind: "own", key: row.tracking.jira };
  if (epic.kind === "own") return { kind: "inherited", key: epic.key, from: epicId };
  return { kind: "none" };
}

/**
 * Every epic and its slices in the product manager's order: epics as status lists them; within
 * each, the order status reports (`order[].slices`, the slices in this workspace), then any slice
 * of the epic the order does not name, in status's order.
 */
export function buildLedger(status: Pick<Status, "epics" | "slices" | "order">): LedgerEpic[] {
  const byId = new Map(status.slices.map((s) => [s.slice_id, s]));
  return status.epics.map((row) => {
    const key = epicKey(row);
    const ordered = status.order.find((o) => o.epic_id === row.epic_id)?.slices.filter((s) => s.in_workspace).map((s) => s.slice_id) ?? [];
    const rest = status.slices.filter((s) => s.epic_id === row.epic_id && !ordered.includes(s.slice_id)).map((s) => s.slice_id);
    const slices = [...ordered, ...rest]
      .map((id) => byId.get(id))
      .filter((s): s is NonNullable<typeof s> => s !== undefined && s.epic_id === row.epic_id)
      .map((s) => ({
        id: s.slice_id,
        title: s.title,
        status: s.status,
        github: s.github,
        editable: s.editable,
        key: sliceKey(s, key, row.epic_id),
        ownKey: s.tracking?.jira ?? null,
      }));
    return { id: row.epic_id, title: row.title, key, slices };
  });
}

export interface LedgerFacts {
  epics: number;
  slices: number;
  /** Slices with a key of their own. */
  sliceKeys: number;
  /** Epics with a key. */
  epicKeys: number;
}

export function ledgerFacts(ledger: readonly LedgerEpic[]): LedgerFacts {
  const slices = ledger.flatMap((e) => e.slices);
  return {
    epics: ledger.length,
    slices: slices.length,
    sliceKeys: slices.filter((s) => s.key.kind === "own").length,
    epicKeys: ledger.filter((e) => e.key.kind === "own").length,
  };
}

/* ── The export ──────────────────────────────────────────────────────── */

export type Flavour = "cloud" | "data-center";

export const flavours: ReadonlyArray<{ value: Flavour; label: string; detail: string }> = [
  { value: "cloud", label: "Jira Cloud", detail: "Stories sit under their epic through the Parent column." },
  { value: "data-center", label: "Jira Data Center", detail: "Stories sit under their epic through Epic Name and Epic Link." },
];

/** Why the file differs, in one sentence. */
export const flavourWhy = "Jira Cloud and Jira Data Center tie a story to its epic with different columns, so the file is written for one of them.";

export interface ExportChoice {
  flavour: Flavour;
  /** An epic ID, or "all" for everything. */
  scope: string;
  drafts: boolean;
}

export const defaultExportChoice: ExportChoice = { flavour: "cloud", scope: "all", drafts: false };

/** The `jira.export` arguments for a choice. */
export function exportArgs(choice: ExportChoice): { flavour: Flavour; state: "ready" | "all"; epic?: string } {
  return { flavour: choice.flavour, state: choice.drafts ? "all" : "ready", ...(choice.scope !== "all" ? { epic: choice.scope } : {}) };
}

export interface Named {
  id: string;
  /** The title from status, or null when status does not name it. */
  name: string | null;
}

export interface ExportSummary {
  /** True when the file holds no epic and no story. */
  empty: boolean;
  epics: number;
  stories: number;
  flavour: Flavour;
  /** Items left out because each is already in Jira, with the key the engine named. */
  inJira: Array<Named & { jira: string | null }>;
  /** Items left out for any other reason, in the engine's words. */
  leftOut: Array<Named & { reason: string }>;
  /** Items whose description was cut to fit. */
  cut: Named[];
  /** The host's own download links; anything else is dropped. */
  downloads: Array<{ name: string; url: string; bytes: number }>;
  note: string;
}

/** Titles by ID, for epics and slices, from status. */
export function namesFrom(status: Pick<Status, "epics" | "slices">): Record<string, string> {
  const names: Record<string, string> = {};
  for (const e of status.epics) names[e.epic_id] = e.title;
  for (const s of status.slices) names[s.slice_id] = s.title;
  return names;
}

const named = (id: string, names: Readonly<Record<string, string>>): Named => ({ id, name: names[id] ?? null });

/**
 * A download link the page may offer: the host's own route (`/api/downloads/<token>/<name>`), or,
 * in the development fixtures only, a plain-text data address. Nothing that leads anywhere else.
 */
export function isHostDownload(url: string): boolean {
  if (/^\/api\/downloads\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/.test(url)) return true;
  return url.startsWith("data:text/plain;");
}

export function exportSummary(result: JiraExport, names: Readonly<Record<string, string>>): ExportSummary {
  const inJira = result.left_out.filter((item) => typeof item.jira === "string");
  const other = result.left_out.filter((item) => typeof item.jira !== "string");
  return {
    empty: result.counts.epics === 0 && result.counts.stories === 0,
    epics: result.counts.epics,
    stories: result.counts.stories,
    flavour: result.flavour,
    inJira: inJira.map((item) => ({ ...named(item.id, names), jira: item.jira ?? null })),
    leftOut: other.map((item) => ({ ...named(item.id, names), reason: item.reason })),
    cut: result.cut.map((id) => named(id, names)),
    downloads: (result.downloads ?? []).filter((d) => typeof d.url === "string" && isHostDownload(d.url)),
    note: result.note,
  };
}

/** "1 epic and 3 stories", "no epics and 1 story". */
export function fileContents(epics: number, stories: number): string {
  const count = (n: number, one: string, many: string) => (n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`);
  return `${count(epics, "epic", "epics")} and ${count(stories, "story", "stories")}`;
}

/** The README's essentials, per Jira: which screen, the one field worth creating first, and what follows the import. */
export function readmeEssentials(flavour: Flavour): { screen: string[]; field: string; after: string[] } {
  const screen =
    flavour === "cloud"
      ? [
          "A Jira administrator imports it from Settings, then System, then External System Import, then CSV.",
          "Others may be able to use the space's own CSV import. It keeps stories under their epics too, but may not offer every column.",
        ]
      : ["A Jira administrator imports it from the cog menu, then System, then External System Import, then CSV."];
  return {
    screen: [...screen, "On the first screen choose UTF-8 and a comma, and choose the Jira project to import into: the file does not name one."],
    field:
      "Before importing, ask a Jira administrator to create a URL field called “GitHub issue”. Each item's GitHub issue then has a field of its own; without it, the address is still in each description.",
    after: [
      "In Jira, search for the imported items: every one carries the label mach.",
      "Export the results as a CSV file, with at least the key and the labels.",
      "Bring that file back here, under “Bring the keys back”.",
    ],
  };
}

/* ── The keys back ───────────────────────────────────────────────────── */

type KeysRow = JiraKeys["unmatched"][number];

/** Where in the file a row of the answer is: "Row 3", "Rows 4 and 5", or the item it names. Never a key. */
export function rowWords(item: KeysRow): string | null {
  const rows = item.rows ?? (typeof item.row === "number" ? [item.row] : []);
  if (rows.length === 0) return null;
  if (rows.length === 1) return `Row ${rows[0]}`;
  return `Rows ${rows.slice(0, -1).join(", ")} and ${rows[rows.length - 1]}`;
}

export interface KeysSummary {
  dryRun: boolean;
  rowsRead: number;
  link: Array<Named & { jira: string }>;
  already: Array<Named & { jira: string }>;
  reopen: Array<Named & { jira: string; reason: string }>;
  /** Rows that name no item here; `where` is the row (never the key), `item` the ID when one was named. */
  unmatched: Array<{ where: string | null; item: Named | null; reason: string }>;
  refused: Array<{ where: string | null; item: Named | null; reason: string }>;
  /** Epics that would carry a new key, with their slices already marked ready under the old one. */
  epicsWithReady: Array<Named & { slices: Named[] }>;
  note: string;
}

export function keysSummary(result: JiraKeys, names: Readonly<Record<string, string>>): KeysSummary {
  const rowItem = (item: KeysRow) => ({ where: rowWords(item), item: item.id ? named(item.id, names) : null, reason: item.reason });
  return {
    dryRun: result.dry_run,
    rowsRead: result.rows_read,
    link: result.linked.map((l) => ({ ...named(l.id, names), jira: l.jira })),
    already: result.already_linked.map((l) => ({ ...named(l.id, names), jira: l.jira })),
    reopen: result.needs_reopening.map((l) => ({ ...named(l.id, names), jira: l.jira, reason: l.reason })),
    unmatched: result.unmatched.map(rowItem),
    refused: result.refused.map(rowItem),
    epicsWithReady: Object.entries(result.epics_with_ready_slices).map(([epic, slices]) => ({ ...named(epic, names), slices: slices.map((id) => named(id, names)) })),
    note: result.note,
  };
}

/** Whether applying the file would record anything: the dry run found at least one key to link. */
export const wouldRecord = (summary: KeysSummary): boolean => summary.link.length > 0;

/** "SLICE-001 Invite a teammate", or the ID alone. */
export const label = (item: Named): string => (item.name ? `${item.id} ${item.name}` : item.id);

/* ── The parts of the page (M16 layout) ───────────────────────────────── */

/** The page's three parts, in the order a team does them. */
export type JiraPart = "keys" | "export" | "back";

/**
 * The part open on arrival: the export while no epic or slice has a key of its own (the team has not been to Jira
 * yet), otherwise the keys. Which part is open is only a matter of what is shown first; every part can be opened.
 */
export function jiraOpenPart(facts: LedgerFacts): JiraPart {
  return facts.sliceKeys === 0 && facts.epicKeys === 0 ? "export" : "keys";
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The keys in one line: "1 epic, 2 slices, 1 slice with a key of its own". */
export function keysPartSummary(facts: LedgerFacts): string {
  return `${n(facts.epics, "epic")}, ${n(facts.slices, "slice")}, ${n(facts.sliceKeys, "slice")} with a key of its own`;
}

/** The export in one line: not done on this visit, or what the file holds. */
export function exportPartSummary(summary: ExportSummary | null): string {
  if (!summary) return "One CSV file and a README for Jira's importer. Not exported on this visit.";
  return summary.empty ? "Exported: nothing to export" : `Exported: the file holds ${fileContents(summary.epics, summary.stories)}`;
}

/** Bringing the keys back in one line: no file yet, what a try found, or what was recorded. */
export function keysBackSummary(state: { chosen: boolean; trial: KeysSummary | null; applied: KeysSummary | null }): string {
  const found = (s: KeysSummary, linked: string) =>
    [linked, s.reopen.length ? `${s.reopen.length} to reopen first` : null, s.unmatched.length ? `${s.unmatched.length} not matched` : null, s.refused.length ? `${s.refused.length} refused` : null]
      .filter(Boolean)
      .join(", ");
  if (state.applied) return `Recorded: ${found(state.applied, `${n(state.applied.link.length, "key")} linked`)}`;
  if (state.trial) return `Tried, nothing changed yet: ${found(state.trial, `would link ${n(state.trial.link.length, "key")}`)}`;
  return state.chosen ? "A file is chosen: try it without changing anything" : "No file chosen yet";
}
