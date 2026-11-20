/**
 * What the Jira screen shows, from the engine's answers alone. Pure, so it is unit-tested
 * (test/jira-model.test.mjs). It decides no product rule: which key a slice is handed over with,
 * what goes in the file and whether a key is acceptable are the engine's; this only arranges what
 * the engine reported, in the product manager's order, with names beside the IDs.
 */
import type { JiraExport, JiraKeys, SliceGithub, SliceStatus, Status, StatusEpicRow, WorkOrder } from "@mach/ui/api";

/* ── The keys each epic and slice carries ─────────────────────────────── */

/**
 * A Jira key as far as this page knows it.
 * - `own`: the item's own key, as the engine stored it.
 * - `inherited`: a slice with no key of its own whose epic has one; the slice is handed over with it.
 * - `inherits-unknown`: a slice with no key of its own, under an epic whose key this page has not read.
 * - `none`: no key, and (for a slice) none from its epic either.
 * - `unknown`: not read yet, or could not be read.
 */
export type KeyFact =
  | { kind: "own"; key: string }
  | { kind: "inherited"; key: string; from: string }
  | { kind: "inherits-unknown"; from: string }
  | { kind: "none" }
  | { kind: "unknown" };

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

/**
 * An epic's key. The engine stores it on the epic (`tracking`), but `status` does not report it,
 * so this page knows it only from a row that carries it (should status ever report it) or from
 * the engine's answer to an act on this page (`epic.link`, or `slice.link`'s `jira`).
 * `learned` maps an epic ID to its key, or to null when the engine said it has none.
 */
export function epicKey(row: StatusEpicRow, learned: Readonly<Record<string, string | null>>): KeyFact {
  if (Object.prototype.hasOwnProperty.call(learned, row.epic_id)) {
    const key = learned[row.epic_id];
    return key ? { kind: "own", key } : { kind: "none" };
  }
  const reported = (row as StatusEpicRow & { tracking?: { jira?: unknown } }).tracking;
  if (reported && typeof reported.jira === "string") return { kind: "own", key: reported.jira };
  return { kind: "unknown" };
}

/** A slice's key: its own, else its epic's (shown as inherited), as the engine hands it over. */
export function sliceKey(order: WorkOrder | null | undefined, epic: KeyFact, epicId: string): KeyFact {
  if (!order) return { kind: "unknown" };
  const own = order.tracking?.jira;
  if (own) return { kind: "own", key: own };
  if (epic.kind === "own") return { kind: "inherited", key: epic.key, from: epicId };
  if (epic.kind === "none") return { kind: "none" };
  return { kind: "inherits-unknown", from: epicId };
}

/**
 * Every epic and its slices in the product manager's order: epics as status lists them; within
 * each, the order status reports (`order[].slices`, the slices in this workspace), then any slice
 * of the epic the order does not name, in status's order.
 */
export function buildLedger(
  status: Pick<Status, "epics" | "slices" | "order">,
  workOrders: Readonly<Record<string, WorkOrder | null | undefined>>,
  learned: Readonly<Record<string, string | null>>,
): LedgerEpic[] {
  const byId = new Map(status.slices.map((s) => [s.slice_id, s]));
  return status.epics.map((row) => {
    const key = epicKey(row, learned);
    const ordered = status.order.find((o) => o.epic_id === row.epic_id)?.slices.filter((s) => s.in_workspace).map((s) => s.slice_id) ?? [];
    const rest = status.slices.filter((s) => s.epic_id === row.epic_id && !ordered.includes(s.slice_id)).map((s) => s.slice_id);
    const slices = [...ordered, ...rest]
      .map((id) => byId.get(id))
      .filter((s): s is NonNullable<typeof s> => s !== undefined && s.epic_id === row.epic_id)
      .map((s) => {
        const order = workOrders[s.slice_id];
        return {
          id: s.slice_id,
          title: s.title,
          status: s.status,
          github: s.github,
          editable: s.editable,
          key: sliceKey(order, key, row.epic_id),
          ownKey: order?.tracking?.jira ?? null,
        };
      });
    return { id: row.epic_id, title: row.title, key, slices };
  });
}

export interface LedgerFacts {
  epics: number;
  slices: number;
  /** Slices with a key of their own. */
  sliceKeys: number;
  /** Epics whose key this page knows. */
  epicKeys: number;
  /** Epics whose key this page has not read. */
  epicsUnknown: number;
  /** True while some slice's work order has not been read. */
  reading: boolean;
}

export function ledgerFacts(ledger: readonly LedgerEpic[]): LedgerFacts {
  const slices = ledger.flatMap((e) => e.slices);
  return {
    epics: ledger.length,
    slices: slices.length,
    sliceKeys: slices.filter((s) => s.key.kind === "own").length,
    epicKeys: ledger.filter((e) => e.key.kind === "own").length,
    epicsUnknown: ledger.filter((e) => e.key.kind === "unknown").length,
    reading: slices.some((s) => s.key.kind === "unknown"),
  };
}

/**
 * What an epic's key is, learned from an answer the engine gave on this page. `epic.link` names it
 * outright. `slice.link` says the key a slice is handed over with: when the slice has no key of its
 * own, that is its epic's (or none).
 */
export function learnFromSliceLink(answer: { slice: WorkOrder; jira: string | null }): { epic: string; key: string | null } | null {
  if (answer.slice.tracking?.jira) return null;
  return { epic: answer.slice.epic_id, key: answer.jira };
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
