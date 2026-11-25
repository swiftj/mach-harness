/**
 * M21 F: moving the whole project to another repository (docs/mach-next/M21_EXPORT_IMPORT.md). The shapes are the
 * engine's own (skills/studio/scripts/project_export.py and project_import.py), from the real runs in web/fixtures
 * (move_memory.py), plus what the host adds (apps/studio/internal/engine/ops_move.go): `downloads` and
 * `download_problem` after an export, `kept` after a plan.
 *
 * Fields an older engine does not print are optional. The app reads every one of these results in one place only
 * (apps/product-studio/src/features/move/model.ts), so a name that changes is changed there and here.
 */
import type { DownloadOffer } from "./types";

/** What an archive holds, by kind: `{epics: 2, slices: 7, ...}`. */
export type MoveCounts = Partial<Record<"epics" | "slices" | "principles" | "needs" | "ideas" | "prds" | "designs" | "mocks" | "files", number>>;

/** `project export`. */
export interface ProjectExport {
  exported: true;
  /** Where MACH wrote the file, on this computer. The app offers `downloads` instead of showing it. */
  file: string;
  bytes: number;
  sha256: string;
  counts: MoveCounts;
  /** The IDs of the slices left out (their reasons are in `not_included`). */
  left_out: string[];
  /** Sentences: a slice changed since it was marked ready (the file holds the draft), slices left out as asked. */
  warnings: string[];
  /** What stays in this repository, in words: approvals, GitHub issues, Jira keys, requests, ready folders. */
  stays_behind: string[];
  note: string;
  factory_authorized: false;
  /** What came from this workspace and what MACH read from GitHub: how many, and their IDs ("project", "principles",
   *  "needs" for the sets). */
  from_here?: { count: number; ids: string[] };
  from_github?: { count: number; ids: string[] };
  /** Whether GitHub was read for this export; `problem` when it could not be. */
  github?: { checked: boolean; problem: string | null; read_at: string | null };
  /** What did not go in the file, each with its reason in words. */
  not_included?: Array<{ id: string; what: string; issue: number | null; reason: string }>;
  /** Where this workspace and GitHub held different versions: which was used, and why in words. */
  chosen?: Array<{ id: string; used: "here" | "github"; issue: number | null; note: string }>;
  /** Every sentence a person reads about this export, in order, then the warnings. */
  in_words?: string[];
  /** Added by the host: the one file to download, or none when `download_problem` says why. */
  downloads: DownloadOffer[];
  download_problem?: string;
}

/** One listed thing in a result, in whatever words the engine gives it. Every field is optional: the app shows the first
 *  sentence it finds (`words`, `in_words`, `text`, `note`, `why`, `reason`) after the ID. */
export interface MoveItem {
  id?: string;
  from?: string;
  to?: string;
  file?: string;
  line?: number | null;
  words?: string;
  in_words?: string;
  text?: string;
  note?: string;
  why?: string;
  reason?: string;
  [key: string]: unknown;
}

/** One slice of the archive and where it was in the old repository. */
export interface MoveSlice {
  from: string;
  to: string;
  title: string;
  epic: string;
  /** Where it was: draft, interviewing, ready_for_approval, approved, ready_to_build, being_built, question, shipped, superseded; null when not recorded. */
  was: string | null;
  /** That, in words: "ready to build in the old repository". */
  was_words: string;
  status_here: "draft" | "superseded" | (string & {});
  revision_there?: number | null;
}

/** What the plan and the import report share (project_import.summary). */
export interface ProjectImportShared {
  archive: { file: string; sha256: string; exported_at?: string | null; mach_version?: string | null };
  mode: "new" | "join";
  into_project: string;
  from_project: string;
  from_project_name?: string | null;
  /** Old and new IDs by kind: `{SLICE: [["SLICE-001", "SLICE-031"]], ...}`. */
  map: Record<string, Array<[string, string]>>;
  renumbered: boolean;
  /** Sentences: why a kind was numbered on although the project is new. */
  why_numbered: string[];
  numbers_note: string | null;
  notes: string[];
  counts: MoveCounts;
  slices: MoveSlice[];
  superseded: string[];
  check_by_hand: MoveItem[];
  not_in_archive: MoveItem[];
  links_dropped: MoveItem[];
  needs_none_left_behind: string[];
  shipped_rules: MoveItem[];
  same_principles: MoveItem[];
  /** Sentences: what to do afterwards. */
  after: string[];
  left_behind: {
    jira?: Record<string, string>;
    epic_jira?: Record<string, string>;
    requests?: Record<string, unknown>;
    accepted_concerns?: MoveItem[];
    [key: string]: unknown;
  };
  factory_authorized: false;
  /** The slices that were marked ready in the old repository (new IDs), how many `ready` would mark ready here, those held back
   *  because the file does not hold their approved version whole, and all that in words. */
  ready_in_source?: { slices: string[]; count: number; held_back: string[]; words: string };
  /** Principle rows recorded as "Not assessed": a slice that came did not answer a principle here, or the other way round. */
  principles_not_assessed?: Array<{ slice: string; principle: string; file: string; how: "slice_came" | "principle_came" | (string & {}) }>;
  /** Rows that answered a principle saying the same as one here, now quoting it as it is here. */
  principles_aligned?: MoveItem[];
  /** A slice that names a rule of one that came with it now depends on that one (`added`), or cannot (`added: false`). */
  dependencies_added?: MoveItem[];
  /** Numbers given again when an import that stopped was finished, because another item took them meanwhile. */
  renumbered_on_resume?: MoveItem[];
}

/** `project imports ready [<which>]`, and `ready` in an import's report: marking ready, dependencies first, what was ready
 *  in the old repository. `complete: false` (exit 1) when it stopped part way; asking again carries on. */
export interface ProjectImportsReady {
  marked_ready: Array<{ slice: string; saved_to?: string | null; issue?: number | null; folder?: string | null; warnings?: string[] }>;
  already_ready: string[];
  stopped_at: { slice: string; reason: string } | null;
  left: string[];
  not_ready_in_source: string[];
  record?: string;
  complete: boolean;
  note: string;
}

/** `project import <file> --plan`, with the host's `kept`. */
export interface ProjectImportPlan extends ProjectImportShared {
  plan: true;
  resuming?: boolean;
  writes: "nothing";
  note: string;
  kept: KeptFile;
}

/** `project import <file>` once it is in. */
export interface ProjectImportDone extends ProjectImportShared {
  imported: true;
  resumed: boolean;
  placed: Record<string, number>;
  already_there: number;
  kept_yours: MoveItem[];
  structural_errors: string[];
  numbers_moved: Array<{ id: string; planned: string; now: string }>;
  record: string;
  note: string;
  /** With `ready`: what marking ready did, and where it stopped. */
  ready?: ProjectImportsReady;
}

/** A file brought in before: answered, not refused (plan or import). */
export interface ProjectImportAlready {
  already: true;
  imported: false;
  plan: boolean;
  archive: { file: string; sha256: string };
  mode: "new" | "join" | null;
  into_project: string | null;
  from_project: string | null;
  map: Record<string, Array<[string, string]>>;
  finished_at: string | null;
  note: string;
  kept?: KeptFile;
}

/** Added by the host after a plan: how the next request names the same file. */
export interface KeptFile {
  sha256: string;
  name: string;
  bytes: number;
}

export type ProjectImportResult = ProjectImportPlan | ProjectImportDone | ProjectImportAlready;

/** `project import --abandon`. */
export interface ProjectImportSetAside {
  set_aside: true;
  archive: { file: string; sha256: string };
  from_project: string | null;
  /** Each new ID it had brought in, what it was, its files. */
  brought_in: Array<{ id: string; was: string | null; files: string[] }>;
  numbers_released: Record<string, number[]>;
  record: string;
  note: string;
  factory_authorized: false;
}

/** `project imports`: every project brought in here. */
export interface ProjectImportsList {
  imports: Array<{
    file: string | null;
    archive_sha256: string;
    mode: "new" | "join" | null;
    from_project: string | null;
    from_project_name: string | null;
    into_project: string | null;
    started_at: string | null;
    finished_at: string | null;
    set_aside_at: string | null;
    counts: Record<string, number>;
  }>;
  reads_only: true;
  note: string;
}

/** `project imports <ID>`: what one ID was or became. */
export interface ProjectImportsLookup {
  identifier: string;
  found: Array<{ from: string; to: string; from_project: string | null; from_project_name: string | null; finished: boolean; words: string }>;
  reads_only: true;
  note: string;
}

/** The host's limit for a project file brought in through the browser (ops_move.go); a larger one goes through /mach-studio. */
export const projectFileLimit = { maxBytes: 64 * 1024 * 1024, extensions: [".zip"] } as const;
