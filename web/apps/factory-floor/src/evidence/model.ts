/**
 * The evidence player's model (M6.4, docs/mach-next/M6_4_EVIDENCE_PLAYER.md section 4). Pure: no
 * React, no fetch, no window, so every rule is tested in plain node (test/evidence-model.test.mjs).
 *
 * What it decides:
 * - the checks, grouped by verification run (round and visit), newest first, each with its files;
 * - each file's class (image, video, text), state (ready, withheld and why, missing, changed since it
 *   was recorded) and integrity, from the observer's catalog (live) or the scene (simulation);
 * - stepping across files and checks, with the failed-checks filter;
 * - what may be requested, and only for the one file selected (`contentRequest`): nothing ahead, nothing
 *   in bulk, nothing the catalog withholds, no image or video while media is off.
 *
 * Words for people live here too (`*_WORDS`, `reasonWords`), so the tests pin them.
 */
import type { ArtifactEntry, ArtifactRefusal, CellEvidence, CellEvidenceCheck, EvidenceNotKept, MockFacts, MockRole } from "../live/observer";
import type { ArtifactState, CellState, VerificationCheck, VerificationState } from "../sim";
import { ABANDONED_FILE_WORDS, ABANDONED_WORDS, NOT_KEPT_FILE_WORDS, NOT_KEPT_WORDS, notKeptDetail } from "./notKept";

export { ABANDONED_FILE_WORDS, ABANDONED_WORDS, NOT_KEPT_WORDS, NOT_KEPT_FILE_WORDS, notKeptDetail } from "./notKept";

export type FileClass = "image" | "video" | "text" | "none";
export type FileState = "ready" | "withheld" | "missing" | "changed";
export type Integrity = "match" | "mismatch" | "missing" | "unchecked" | "simulated";
export type EvidenceSource = "live" | "simulation";

/** Why a file is not shown: the content route's reason codes, and what the player itself knows. */
export type EvidenceReason = ArtifactRefusal | "missing" | "not-catalogued" | "not-kept" | "abandoned";

export interface EvidenceFile {
  /** Unique within its check: the catalog id, the scene artifact id, or a position. */
  readonly key: string;
  /** The observer's catalog id; the only thing a request is ever made with. Null in the simulation or when not catalogued. */
  readonly artifactId: string | null;
  /** The scene's artifact id (simulation), never put in a request or the address. */
  readonly sceneArtifactId: string | null;
  /** The path the check names (`evidence/…`): group B, shown contained, never in a URL, title, storage or accessible name. */
  readonly path: string;
  /** The last part of the path. Same rules as `path`. */
  readonly name: string;
  readonly mediaType: string | null;
  readonly bytes: number | null;
  readonly cls: FileClass;
  readonly state: FileState;
  /** Why it is withheld or missing; null when ready or changed. */
  readonly reason: EvidenceReason | null;
  /** The observer's own catalog words for a refusal it gave no code for (`access_reason`, group A); null otherwise. */
  readonly accessWords: string | null;
  readonly integrity: Integrity;
  /** Where it is read from: the live cell folder, the ticket's archive, or the simulation's own sample. */
  readonly origin: "cell" | "archive" | "simulation" | null;
  readonly commit: string | null;
  readonly round: number | null;
  /** The check ids it is evidence for (the catalog's `targets`, else the check that names it). */
  readonly proves: readonly string[];
  /** The served text holds prose the observer could not check for names (R1). */
  readonly freeText: boolean;
  readonly sha256: string | null;
  readonly recordedSha256: string | null;
  /** Simulation only: what the app draws or writes in its place. */
  readonly sim: SimulatedContent | null;
  /** M15: for a design mock's check, whether this file is the approved mock or the capture of the built screen; null otherwise. */
  readonly role: MockRole | null;
}

/** The simulation's own sample content, made by the app (never a capture). */
export type SimulatedContent =
  | { readonly kind: "image"; readonly checkId: string; readonly result: string | null; readonly round: number | null; readonly role?: MockRole | null }
  | { readonly kind: "video" }
  | { readonly kind: "text"; readonly text: string };

export interface EvidenceCheck {
  /** Unique in the model: the run's key and the check id. */
  readonly key: string;
  /** The check id (`AC-01`, `R3`, a holdout's id): the only part written to the address. */
  readonly id: string;
  readonly kind: string | null;
  readonly result: string | null;
  readonly round: number | null;
  readonly visitId: string | null;
  /** When it was recorded (source time), or null when not recorded. */
  readonly atMs: number | null;
  readonly files: readonly EvidenceFile[];
  readonly runKey: string;
  /** M15: a design mock's recorded result, binding flag and the verifier's words; null for every other check. */
  readonly mock: MockFacts | null;
}

export interface EvidenceRun {
  readonly key: string;
  readonly round: number | null;
  readonly visitId: string | null;
  readonly checks: readonly EvidenceCheck[];
  /** The latest check time in the run, for ordering. */
  readonly atMs: number | null;
}

export interface EvidenceModel {
  readonly ticket: string;
  readonly source: EvidenceSource;
  readonly runs: readonly EvidenceRun[];
  /** Screenshots and recordings are served (`floor.evidence_media`); always true for the simulation's own drawings. */
  readonly mediaEnabled: boolean;
  /** Where the files are read from: every one from the cell folder, every one from the archive, both, or none known. */
  readonly readFrom: "cell" | "archive" | "both" | "simulation" | null;
  /** The observer's note on what verified evidence is; null in the simulation. */
  readonly note: string | null;
  /** The cell was cleaned up and its files were not kept (cleanup.archive); null when they are there, and in the simulation. */
  readonly notKept?: EvidenceNotKept | null;
}

/** What the player says of files not kept after cleanup: the fact, then the run record's reason when it says more. */
export function notKeptWords(notKept: EvidenceNotKept): { readonly title: string; readonly detail: string | null } {
  if (notKept.outcome === "abandoned") return { title: ABANDONED_WORDS, detail: null };
  return { title: NOT_KEPT_WORDS, detail: notKeptDetail(notKept.reason) };
}

/** The banner above a file: its integrity's, or, for a file not kept after cleanup, that fact instead of "not there". */
export function fileBanner(file: Pick<EvidenceFile, "integrity" | "reason">): string | null {
  return file.reason === "not-kept" ? NOT_KEPT_FILE_WORDS : file.reason === "abandoned" ? ABANDONED_FILE_WORDS : INTEGRITY_WORDS[file.integrity].banner;
}

export interface EvidenceSelection {
  readonly check: string | null;
  readonly file: string | null;
}

export const NO_SELECTION: EvidenceSelection = { check: null, file: null };

// ---------------------------------------------------------------- words

/** The setting that switches screenshots and recordings on, as the observer names it. */
export const MEDIA_SETTING = "floor.evidence_media";
export const MEDIA_SETTING_FILE = ".factory/config.json";

export const KIND_WORDS: Readonly<Record<string, string>> = { scenario: "Scenario", "matrix rule": "Matrix rule", holdout: "Holdout", "design mock": "Design mock" };

/** M15: the two sides of a design mock's check, in words (never colour alone). */
export const ROLE_WORDS: Readonly<Record<MockRole, string>> = { "approved-mock": "Approved mock", capture: "Captured screen" };

/** M15: a design mock's recorded result in words, as verify.py compare records it. Nothing is compared here. */
export function mockResultWords(mock: MockFacts): string {
  const result = mock.compared === "matches" ? "Matches the approved mock" : mock.compared === "differs" ? "Differs from the approved mock" : mock.compared === "cannot compare" ? "Could not be compared" : "Result not recorded";
  const binding = mock.binding === true ? "Binding: a difference fails this check." : mock.binding === false ? "Not binding: a difference is a finding for the review panel's product seat." : "Whether it binds is not recorded.";
  return `${result}. ${binding}`;
}

/** M15: a design mock's check split into its approved mock and its captures, in the order the check names them. */
export function mockSides(check: Pick<EvidenceCheck, "files">): { readonly approved: EvidenceFile | null; readonly captures: readonly EvidenceFile[] } {
  return { approved: check.files.find((f) => f.role === "approved-mock") ?? null, captures: check.files.filter((f) => f.role === "capture") };
}
export function kindWords(kind: string | null): string {
  return kind ? (KIND_WORDS[kind] ?? kind) : "Kind not recorded";
}

export type ResultLook = "succeeded" | "failed" | "idle";
export function resultLook(result: string | null): { readonly word: string; readonly state: ResultLook } {
  if (result === "pass") return { word: "Passed", state: "succeeded" };
  if (result === "fail") return { word: "Failed", state: "failed" };
  if (result === "pending") return { word: "Not recorded yet", state: "idle" };
  return { word: result ? result : "Result not recorded", state: "idle" };
}

export const CLASS_WORDS: Readonly<Record<FileClass, string>> = { image: "Screenshot", video: "Recording", text: "Text", none: "File" };

export const STATE_WORDS: Readonly<Record<FileState, string>> = {
  ready: "Ready",
  withheld: "Withheld",
  missing: "Missing",
  changed: "Changed since it was recorded",
};

/** Plain words for each reason a file is not shown (design 4.3, rule 4). */
export function reasonWords(reason: EvidenceReason, cls: FileClass = "none"): string {
  switch (reason) {
    case "media-disabled":
      return `${cls === "video" ? "Recordings" : cls === "image" ? "Screenshots" : "Screenshots and recordings"} are off in this project's settings (${MEDIA_SETTING} in ${MEDIA_SETTING_FILE}), so this file is not requested.`;
    case "type":
      return "The observer does not serve this type of file, so it is listed with its facts only.";
    case "too-large":
      return "The file is larger than the observer serves.";
    case "changed":
      return "The file changed after the observer catalogued it, so it is not served. Reopen the player to read the catalog again.";
    case "credential-name":
      return "Its name looks like it holds credentials, so its content is never served.";
    case "link":
      return "It is a link, or not a plain file, so it is not read.";
    case "duplicate":
      return "The archive holds more than one file of this name, so neither is served.";
    case "missing":
      return "The file is not there to read.";
    case "abandoned":
      return ABANDONED_FILE_WORDS;
    case "not-kept":
      return NOT_KEPT_FILE_WORDS;
    case "not-catalogued":
      return "The observer's catalog has no entry for this file: no record it reads names it, or it is not there. It is not requested.";
    case "unavailable":
      return "The observer was busy and did not serve the file, even when asked again. Try again in a moment.";
    case "not-found":
      return "The observer no longer has this file in its catalog. Reopen the player to read the catalog again.";
    case "unauthorized":
      return "This browser's session with the observer has ended. Open the Factory Floor's link again.";
    case "network":
      return "The observer could not be reached.";
    case "invalid":
      return "The file has no catalog id the observer would accept, so it is not requested.";
    case "refused":
      return "The observer refused to serve the file.";
  }
}

/** Integrity in words: the fact beside the viewer, and the banner above it when the file is not proof. */
export const INTEGRITY_WORDS: Readonly<Record<Integrity, { readonly fact: string; readonly banner: string | null }>> = {
  match: { fact: "Matches the hash the verifier recorded", banner: null },
  mismatch: { fact: "Does not match the hash the verifier recorded", banner: "This file does not match the hash the verifier recorded for it: it changed after it was recorded, or is a later file of the same name. It is not proof of this check." },
  missing: { fact: "Not there to check", banner: "The file this check names is not there, so nothing can be checked or shown." },
  unchecked: { fact: "Not checked: no recorded hash to compare", banner: "No hash was recorded for this file, so it cannot be checked against what the verifier saw. It is not shown as proof." },
  simulated: { fact: "Simulation: no hash is checked", banner: null },
};

/** The note for the simulation's sample content (design 4.5). */
export const SIM_CONTENT_NOTE = "The simulation's own sample, drawn or written by the Factory Floor itself. It is not a capture of anything.";
export const SIM_RECORDING_WORDS = "There is no recording in a simulation. In a real Factory this is the verifier's recording of the flow.";
export const ARCHIVE_WORDS = "Read from the ticket's archive: the cell was cleaned up after it finished.";

// ---------------------------------------------------------------- classes and states

const EXT_CLASS: Readonly<Record<string, FileClass>> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  webm: "video", mp4: "video", mov: "video",
  txt: "text", md: "text", json: "text", log: "text", out: "text", cast: "text", csv: "text", yaml: "text", yml: "text", diff: "text", patch: "text", http: "text",
};

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function extOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** A file's class: from the served media type when known, else from its name (for describing what a withheld file is). */
export function classOf(mediaType: string | null, path: string, contentAccess: string | null = null): FileClass {
  const t = (mediaType ?? "").toLowerCase();
  if (contentAccess === "text") return "text";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("text/") || t === "application/json") return "text";
  return EXT_CLASS[extOf(path)] ?? "none";
}

/**
 * The catalog's `access_reason` for content it does not serve, as a reason code. The catalog gives
 * words, not a code (apps/observer/internal/artifact/catalog.go `access`), so they are matched on the
 * observer's own fixed phrases; anything else is `type` with the observer's words kept.
 */
export function accessReasonCode(accessReason: string | null): EvidenceReason {
  const r = (accessReason ?? "").toLowerCase();
  if (r.includes("credentials")) return "credential-name";
  if (r.includes("larger than")) return "too-large";
  if (r.includes("more than one file")) return "duplicate";
  if (r.includes("not there")) return "missing";
  if (r.includes("opts in") || r.includes("evidence_media")) return "media-disabled";
  return "type";
}

const KNOWN_ACCESS = new Set(["credential-name", "too-large", "duplicate", "missing", "media-disabled"]);

function integrityOf(value: string | null | undefined): Integrity {
  return value === "match" || value === "mismatch" || value === "missing" || value === "unchecked" ? value : "unchecked";
}

/** The state of a catalogued (or uncatalogued) file, strongest fact first: missing, withheld, changed, ready. */
function stateOf(input: { artifactId: string | null; integrity: Integrity; contentAccess: string | null; accessReason: string | null; cls: FileClass; mediaEnabled: boolean }): { state: FileState; reason: EvidenceReason | null; accessWords: string | null } {
  // The evidence route says `missing` for a file its catalog has no entry for, whether or not it is on disk
  // (a file no record the catalog reads names): without a catalog id the player can only say that.
  if (!input.artifactId) return { state: "missing", reason: "not-catalogued", accessWords: null };
  if (input.integrity === "missing") return { state: "missing", reason: "missing", accessWords: null };
  const access = input.contentAccess;
  if (access === "none" || access === null) {
    const code = accessReasonCode(input.accessReason);
    return { state: code === "missing" ? "missing" : "withheld", reason: code, accessWords: KNOWN_ACCESS.has(code) ? null : input.accessReason };
  }
  if (access === "media-disabled" || ((input.cls === "image" || input.cls === "video") && !input.mediaEnabled)) return { state: "withheld", reason: "media-disabled", accessWords: null };
  if (access !== "text" && access !== "media") return { state: "withheld", reason: "type", accessWords: input.accessReason };
  if (input.integrity === "mismatch") return { state: "changed", reason: null, accessWords: null };
  return { state: "ready", reason: null, accessWords: null };
}

// ---------------------------------------------------------------- building the model

/** A check's time: when it was recorded, else the latest it can have been. */
export function checkTime(check: Pick<CellEvidenceCheck, "at">): number | null {
  const at = check.at;
  if (!at) return null;
  return at.atMs ?? at.notAfterMs ?? null;
}

const runKeyOf = (round: number | null, visitId: string | null): string => `${round ?? "-"}|${visitId ?? ""}`;

function groupRuns(checks: readonly EvidenceCheck[]): EvidenceRun[] {
  const runs = new Map<string, { round: number | null; visitId: string | null; checks: EvidenceCheck[]; atMs: number | null }>();
  for (const c of checks) {
    let run = runs.get(c.runKey);
    if (!run) runs.set(c.runKey, (run = { round: c.round, visitId: c.visitId, checks: [], atMs: null }));
    run.checks.push(c);
    if (c.atMs !== null && (run.atMs === null || c.atMs > run.atMs)) run.atMs = c.atMs;
  }
  // Newest first: the higher round, then the later time; a run with no round last.
  return [...runs.entries()]
    .map(([key, r]) => ({ key, round: r.round, visitId: r.visitId, checks: r.checks, atMs: r.atMs }))
    .sort((a, b) => (b.round ?? -1) - (a.round ?? -1) || (b.atMs ?? -1) - (a.atMs ?? -1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function readFromOf(files: readonly EvidenceFile[]): EvidenceModel["readFrom"] {
  const origins = new Set(files.map((f) => f.origin).filter((o): o is NonNullable<EvidenceFile["origin"]> => o !== null));
  if (origins.has("simulation")) return "simulation";
  if (origins.has("cell") && origins.has("archive")) return "both";
  if (origins.has("archive")) return "archive";
  if (origins.has("cell")) return "cell";
  return null;
}

/**
 * The model for a live cell, from `/cells/{ticket}/evidence`. `mediaEnabled`: the reply's setting, else the session's capability, else off (fail closed).
 */
export function buildLiveModel(reply: CellEvidence, options: { readonly sessionMedia?: boolean | null } = {}): EvidenceModel {
  const mediaEnabled = reply.evidenceMedia ?? options.sessionMedia ?? false;
  const notKept = reply.notKept ?? null;
  const byId = new Map<string, ArtifactEntry>();
  for (const a of reply.artifacts) byId.set(a.id, a);
  const checks: EvidenceCheck[] = [];
  for (const k of reply.checks) {
    const atMs = checkTime(k);
    const runKey = runKeyOf(k.round, k.visitId);
    const files = k.evidence.map((ev, i): EvidenceFile => {
      const entry = ev.artifactId ? byId.get(ev.artifactId) : undefined;
      const integrity = integrityOf(ev.integrity);
      const contentAccess = ev.contentAccess ?? entry?.contentAccess ?? null;
      const path = ev.file || entry?.path || "";
      const cls = classOf(entry?.mediaType ?? null, path, contentAccess);
      const known = stateOf({ artifactId: ev.artifactId, integrity, contentAccess, accessReason: entry?.accessReason ?? null, cls, mediaEnabled });
      // The cell was cleaned up with no archive kept: a file not there was not kept, which is said as such.
      const st = notKept && known.state === "missing" ? { ...known, reason: notKept.outcome === "abandoned" ? ("abandoned" as const) : ("not-kept" as const) } : known;
      const proves = entry?.targets?.length ? entry.targets.map((t) => t.id) : [k.targetId];
      return {
        key: ev.artifactId ?? `n${i}`,
        artifactId: ev.artifactId,
        sceneArtifactId: null,
        path,
        name: baseName(path),
        mediaType: entry?.mediaType ?? null,
        bytes: entry?.bytes ?? null,
        cls,
        state: st.state,
        reason: st.reason,
        accessWords: st.accessWords,
        integrity,
        origin: entry?.origin ?? null,
        commit: entry?.commit ?? null,
        round: entry?.round ?? k.round,
        proves: [...new Set(proves)],
        freeText: entry?.freeText === true,
        sha256: entry?.sha256 ?? null,
        recordedSha256: ev.sha256 ?? entry?.recordedSha256 ?? null,
        sim: null,
        role: ev.role ?? null,
      };
    });
    checks.push({ key: `${runKey}/${k.targetId}`, id: k.targetId, kind: k.targetKind, result: k.result, round: k.round, visitId: k.visitId, atMs, files, runKey, mock: k.mock ?? null });
  }
  const runs = groupRuns(checks);
  return { ticket: reply.ticketId, source: "live", runs, mediaEnabled, readFrom: readFromOf(checks.flatMap((c) => c.files)), note: reply.note, notKept };
}

/** The path a simulated check's evidence names (`131:evidence/x.png`), without the ticket. */
function simPath(ticket: string, ref: string): string {
  return ref.startsWith(`${ticket}:`) ? ref.slice(ticket.length + 1) : ref;
}

/** The scene artifact a check's evidence names: the version written in the check's round, else the latest written by the check. */
function simArtifact(cell: CellState, path: string, round: number, at: number | null): ArtifactState | null {
  const same = cell.artifacts.filter((a) => a.path === path);
  return same.find((a) => a.round === round) ?? [...same].reverse().find((a) => at === null || a.writtenAt <= at) ?? same.at(-1) ?? null;
}

/** The simulation's sample text for a file, written by the app (design 4.5): never presented as a capture. */
export function simulatedText(input: { readonly ticket: string; readonly checkId: string; readonly kind: string | null; readonly result: string | null; readonly round: number | null; readonly note: string | null; readonly path: string }): string {
  const ext = extOf(input.path);
  if (ext === "json") {
    return `${JSON.stringify(
      {
        simulation: "sample written by the Factory Floor; not a capture",
        ticket: input.ticket,
        check: input.checkId,
        kind: input.kind,
        round: input.round,
        result: input.result,
        observed: input.note ?? null,
      },
      null,
      2,
    )}\n`;
  }
  return [
    "# Simulation: sample written by the Factory Floor; not a capture",
    `ticket  ${input.ticket}`,
    `check   ${input.checkId} (${input.kind ?? "kind not recorded"})`,
    `round   ${input.round ?? "not recorded"}`,
    `result  ${input.result ?? "not recorded"}`,
    "",
    input.note ?? "",
    "",
  ].join("\n");
}

/** The model for a cell of the simulation, from the scene now. */
export function buildSimModel(cell: CellState): EvidenceModel {
  const checks: EvidenceCheck[] = [];
  for (const v of cell.verifications as readonly VerificationState[]) {
    const visit = cell.visits.find((x) => x.station === "verify" && x.round === v.round) ?? null;
    const visitId = visit?.visitId ?? null;
    const runKey = runKeyOf(v.round, visitId);
    for (const c of v.checks as readonly VerificationCheck[]) {
      if (c.result === "pending") continue;
      const files = c.evidence.map((ref, i): EvidenceFile => {
        const path = simPath(cell.ticketId, ref);
        const art = simArtifact(cell, path, v.round, c.at);
        const cls = classOf(null, path);
        // M15: the simulation's design mock names its approved picture first, then the capture.
        const role: MockRole | null = c.mock ? (i === 0 ? "approved-mock" : "capture") : null;
        const sim: SimulatedContent | null =
          cls === "image" ? { kind: "image", checkId: c.targetId, result: c.result, round: v.round, ...(role ? { role } : {}) } : cls === "video" ? { kind: "video" } : cls === "text" ? { kind: "text", text: simulatedText({ ticket: cell.ticketId, checkId: c.targetId, kind: c.targetKind, result: c.result, round: v.round, note: c.note ?? art?.summary ?? null, path }) } : null;
        return {
          key: art?.id ?? `n${i}`,
          artifactId: null,
          sceneArtifactId: art?.id ?? null,
          path,
          name: baseName(path),
          mediaType: null,
          bytes: null,
          cls,
          state: sim ? "ready" : "withheld",
          reason: sim ? null : "type",
          accessWords: null,
          integrity: "simulated",
          origin: "simulation",
          commit: art?.sha ?? null,
          round: art?.round ?? v.round,
          proves: [c.targetId],
          freeText: false,
          sha256: null,
          recordedSha256: null,
          sim,
          role,
        };
      });
      const mock: MockFacts | null = c.mock ? { compared: c.mock.compared, binding: c.mock.binding, forScenario: c.mock.forScenario, note: c.note, differences: c.mock.differences, freeText: false } : null;
      checks.push({ key: `${runKey}/${c.targetId}`, id: c.targetId, kind: c.targetKind, result: c.result, round: v.round, visitId, atMs: c.at, files, runKey, mock });
    }
  }
  return { ticket: cell.ticketId, source: "simulation", runs: groupRuns(checks), mediaEnabled: true, readFrom: checks.length ? "simulation" : null, note: null };
}

// ---------------------------------------------------------------- the list, the filter, stepping

/** The checks in the order they are listed: runs newest first, checks as recorded; only failed ones with the filter. */
export function listedChecks(model: EvidenceModel, failedOnly = false): readonly EvidenceCheck[] {
  const all = model.runs.flatMap((r) => r.checks);
  return failedOnly ? all.filter((c) => c.result === "fail") : all;
}

export function findCheck(model: EvidenceModel, key: string | null): EvidenceCheck | null {
  if (!key) return null;
  for (const r of model.runs) for (const c of r.checks) if (c.key === key) return c;
  return null;
}

export function selectedFile(model: EvidenceModel, sel: EvidenceSelection): EvidenceFile | null {
  const check = findCheck(model, sel.check);
  return check?.files.find((f) => f.key === sel.file) ?? null;
}

/**
 * Where the player starts: the check holding a given file (by catalog id, scene artifact id or path),
 * else the newest check with a given id, else the first listed check; and that file or the check's first.
 */
export function initialSelection(
  model: EvidenceModel,
  start: { readonly check?: string | null; readonly artifactId?: string | null; readonly sceneArtifactId?: string | null; readonly path?: string | null } = {},
  failedOnly = false,
): EvidenceSelection {
  const checks = listedChecks(model, failedOnly);
  const fileMatch = (f: EvidenceFile) => (start.artifactId && f.artifactId === start.artifactId) || (start.sceneArtifactId && f.sceneArtifactId === start.sceneArtifactId) || (start.path && sameFile(f.path, start.path));
  if (start.artifactId || start.sceneArtifactId || start.path) {
    const preferred = start.check ? checks.filter((c) => c.id === start.check) : [];
    for (const c of [...preferred, ...checks]) {
      const f = c.files.find(fileMatch);
      if (f) return { check: c.key, file: f.key };
    }
  }
  const byId = start.check ? checks.find((c) => c.id === start.check) : undefined;
  const check = byId ?? checks[0];
  return check ? { check: check.key, file: check.files[0]?.key ?? null } : NO_SELECTION;
}

/** Two names for the same file: equal, or one ends with the other as a path. */
export function sameFile(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * The next or previous file. Within the check first; past its last file, the next listed check's first
 * file (before its first, the previous check's last). Checks with no file are passed over. At either end
 * of the list the selection stays.
 */
export function stepFile(model: EvidenceModel, sel: EvidenceSelection, direction: 1 | -1, failedOnly = false): EvidenceSelection {
  const checks = listedChecks(model, failedOnly);
  const at = checks.findIndex((c) => c.key === sel.check);
  if (at < 0) return initialSelection(model, {}, failedOnly);
  const check = checks[at] as EvidenceCheck;
  const i = check.files.findIndex((f) => f.key === sel.file);
  const next = i + direction;
  if (i >= 0 && next >= 0 && next < check.files.length) return { check: check.key, file: (check.files[next] as EvidenceFile).key };
  for (let j = at + direction; j >= 0 && j < checks.length; j += direction) {
    const c = checks[j] as EvidenceCheck;
    if (!c.files.length) continue;
    const f = direction > 0 ? c.files[0] : c.files[c.files.length - 1];
    return { check: c.key, file: (f as EvidenceFile).key };
  }
  return sel;
}

/** The next or previous listed check, at its first file. At either end the selection stays. */
export function stepCheck(model: EvidenceModel, sel: EvidenceSelection, direction: 1 | -1, failedOnly = false): EvidenceSelection {
  const checks = listedChecks(model, failedOnly);
  const at = checks.findIndex((c) => c.key === sel.check);
  const j = at < 0 ? 0 : at + direction;
  const c = checks[j];
  if (!c) return sel;
  return { check: c.key, file: c.files[0]?.key ?? null };
}

/** Whether a selection still names something listed (after a filter or a reload); if not, the nearest sensible one. */
export function keepSelection(model: EvidenceModel, sel: EvidenceSelection, failedOnly = false): EvidenceSelection {
  const checks = listedChecks(model, failedOnly);
  const check = checks.find((c) => c.key === sel.check);
  if (!check) {
    // The same check id in the newest run that lists it (a reload after a new round), else the first.
    const id = findCheck(model, sel.check)?.id ?? sel.check?.slice(sel.check.lastIndexOf("/") + 1) ?? null;
    return initialSelection(model, { check: id }, failedOnly);
  }
  if (check.files.some((f) => f.key === sel.file)) return sel;
  return { check: check.key, file: check.files[0]?.key ?? null };
}

// ---------------------------------------------------------------- what may be requested

export type ContentRequest =
  | { readonly kind: "text"; readonly artifactId: string }
  | { readonly kind: "image" | "video"; readonly artifactId: string }
  | { readonly kind: "simulated"; readonly content: SimulatedContent }
  | { readonly kind: "none"; readonly reason: EvidenceReason | null };

/**
 * What the player may load for the selection: one file, only the selected one, only by catalog id,
 * never a file the catalog withholds or marks missing, and no image or video while media is off.
 */
export function contentRequest(model: EvidenceModel, sel: EvidenceSelection): ContentRequest {
  const file = selectedFile(model, sel);
  if (!file) return { kind: "none", reason: null };
  if (file.sim) return { kind: "simulated", content: file.sim };
  if (file.state === "withheld" || file.state === "missing") return { kind: "none", reason: file.reason };
  if (!file.artifactId) return { kind: "none", reason: "not-catalogued" };
  if (file.cls === "text") return { kind: "text", artifactId: file.artifactId };
  if (file.cls === "image" || file.cls === "video") return model.mediaEnabled ? { kind: file.cls, artifactId: file.artifactId } : { kind: "none", reason: "media-disabled" };
  return { kind: "none", reason: "type" };
}

// ---------------------------------------------------------------- run and file words

/** A run's heading: "Round 2, verification visit verify#2" (identifiers only). */
export function runWords(run: Pick<EvidenceRun, "round" | "visitId">): string {
  const round = run.round === null ? "Round not recorded" : `Round ${run.round}`;
  const visit = run.visitId ? run.visitId.slice(run.visitId.lastIndexOf("/") + 1) : null;
  return visit ? `${round}, visit ${visit}` : round;
}

/** A size in words: "12 KB" (binary steps), or null when not recorded. */
export function sizeWords(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** Lines of a text for the count beside the viewer (a final newline ends the last line, it does not start another). */
export function lineCount(text: string): number {
  if (!text) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/** A file's accessible name: its class, its position and the check it belongs to (IDs and types only, never its name). */
export function fileAccessibleName(file: Pick<EvidenceFile, "cls" | "state">, index: number, count: number, checkId: string): string {
  return `${CLASS_WORDS[file.cls]} ${index + 1} of ${count}, check ${checkId}, ${STATE_WORDS[file.state].toLowerCase()}`;
}

// ---------------------------------------------------------------- scene artifacts

/** The check in a cell's verifications that names a file (by path), newest round first: for opening the player at an artifact. */
export function checkCitingPath(cell: Pick<CellState, "ticketId" | "verifications">, path: string): { readonly checkId: string; readonly round: number } | null {
  for (const v of [...cell.verifications].sort((a, b) => b.round - a.round)) {
    for (const c of v.checks) if (c.evidence.some((ref) => sameFile(simPath(cell.ticketId, ref), path))) return { checkId: c.targetId, round: v.round };
  }
  return null;
}
