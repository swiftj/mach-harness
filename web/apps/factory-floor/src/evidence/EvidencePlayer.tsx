/**
 * The evidence player (M6.4, docs/mach-next/M6_4_EVIDENCE_PLAYER.md section 4): a panel over the
 * workspace, for one ticket, showing what the verifier captured for each check beside the check it
 * proves. Read only: nothing here changes, approves, starts, downloads or deletes anything.
 *
 * The rules (design 4.3, M6_5_SECURITY.md B and C):
 * - content loads only for the file a person selects, by catalog id, through the content route; moving
 *   on unmounts the viewer and releases what it showed; nothing is fetched ahead, in bulk or cached;
 * - text goes into a text node (React children) only: no markup, no Markdown, no links made from it;
 * - file names and paths are shown contained (`UncheckedText`) and never reach the address, the page
 *   title, storage or an accessible name: accessible names use IDs, positions and types;
 * - nothing the catalog withholds is requested, and no image or video while media is off;
 * - integrity is always said, and a file that does not match its recorded hash is never shown as proof.
 *
 * The model (what is listed, stepping, what may be requested) is ./model.ts; this file only draws it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Banner, Button, Dialog, DialogContent, Kbd, cn } from "@mach/ui";
import { useSceneStore, useStore, type EvidenceOpen } from "../scene";
import { useSource } from "../shell/source/context";
import { StateGlyph } from "../shell/glyphs";
import { FREE_TEXT_LABEL, ObserverError, type ArtifactTextResult, type CellEvidence, type ObserverClient } from "../live/observer";
import { unchecked } from "../text/unchecked";
import { UncheckedNote, UncheckedText } from "../text/UncheckedText";
import type { CellState } from "../sim";
import {
  ARCHIVE_WORDS,
  CLASS_WORDS,
  INTEGRITY_WORDS,
  MEDIA_SETTING,
  MEDIA_SETTING_FILE,
  SIM_CONTENT_NOTE,
  SIM_RECORDING_WORDS,
  STATE_WORDS,
  buildLiveModel,
  buildSimModel,
  contentRequest,
  fileAccessibleName,
  fileBanner,
  notKeptWords,
  findCheck,
  initialSelection,
  keepSelection,
  kindWords,
  lineCount,
  listedChecks,
  mockResultWords,
  mockSides,
  reasonWords,
  ROLE_WORDS,
  resultLook,
  runWords,
  selectedFile,
  sizeWords,
  stepCheck,
  stepFile,
  type EvidenceCheck,
  type EvidenceFile,
  type EvidenceModel,
  type EvidenceSelection,
} from "./model";

/** Characters of a file name shown in a list (C2); the full name is not needed to tell files apart. */
const NAME_MAX = 80;

/** Mounted once by the shell; open while the store says so (`openEvidence`, or the address). */
export function EvidencePlayer() {
  const store = useStore();
  const open = useSceneStore((s) => s.evidence);
  const onOpenChange = useCallback((next: boolean) => {
    if (!next) store.closeEvidence();
  }, [store]);
  return (
    <Dialog open={open !== null} onOpenChange={onOpenChange}>
      {open ? <PlayerPanel key={open.ticket} open={open} /> : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------- where the checks come from

type Loaded = { readonly status: "loading" } | { readonly status: "ready"; readonly model: EvidenceModel } | { readonly status: "error"; readonly words: string };

/** The simulation: the scene now. */
function useSimModel(ticket: string, enabled: boolean): Loaded {
  const cell = useSceneStore((s) => (enabled ? (s.log.sceneAt(s.now).cells[ticket] ?? null) : null)) as CellState | null;
  return useMemo<Loaded>(() => {
    if (!enabled) return { status: "loading" };
    if (!cell) return { status: "error", words: `The simulation has no cell ${ticket} at this moment.` };
    return { status: "ready", model: buildSimModel(cell) };
  }, [cell, enabled, ticket]);
}

/** Live: `/cells/{ticket}/evidence`, read again when the cell records another check. One retry when the observer is busy. */
function useLiveModel(client: ObserverClient | null, ticket: string, enabled: boolean): Loaded {
  const recorded = useSceneStore((s) => (enabled ? (s.log.sceneAt(s.now).cells[ticket]?.verifications.reduce((n, v) => n + v.checks.filter((c) => c.result !== "pending").length, 0) ?? 0) : 0));
  const [reply, setReply] = useState<{ readonly ticket: string; readonly data: CellEvidence | null; readonly words: string | null; readonly media: boolean | null } | null>(null);
  useEffect(() => {
    if (!enabled || !client?.cellEvidence) return;
    const ctl = new AbortController();
    let alive = true;
    const read = async (): Promise<void> => {
      const once = () => (client.cellEvidence as NonNullable<ObserverClient["cellEvidence"]>)(ticket, ctl.signal);
      let data: CellEvidence;
      try {
        data = await once();
      } catch (error) {
        if (!(error instanceof ObserverError) || error.kind !== "unavailable") throw error;
        await new Promise((r) => setTimeout(r, 1000));
        if (!alive) return;
        data = await once();
      }
      let media: boolean | null = null;
      if (data.evidenceMedia === null) {
        try {
          media = (await client.session()).evidenceMedia ?? null;
        } catch {
          media = null;
        }
      }
      if (alive) setReply({ ticket, data, words: null, media });
    };
    read().catch((error: unknown) => {
      if (!alive || ctl.signal.aborted) return;
      const words =
        error instanceof ObserverError
          ? error.kind === "not_found"
            ? `The observer has no record of cell ${ticket}.`
            : error.kind === "unavailable"
              ? "The observer was busy and did not answer, even when asked again. Close the player and open it again in a moment."
              : error.kind === "unauthorized"
                ? "This browser's session with the observer has ended. Open the Factory Floor's link again."
                : "The observer did not answer."
          : "The observer did not answer.";
      setReply({ ticket, data: null, words, media: null });
    });
    return () => {
      alive = false;
      ctl.abort();
    };
  }, [client, ticket, enabled, recorded]);
  return useMemo<Loaded>(() => {
    if (enabled && !client?.cellEvidence) return { status: "error", words: "This observer does not serve a cell's evidence." };
    if (!enabled || !reply || reply.ticket !== ticket) return { status: "loading" };
    if (!reply.data) return { status: "error", words: reply.words ?? "The observer did not answer." };
    return { status: "ready", model: buildLiveModel(reply.data, { sessionMedia: reply.media }) };
  }, [enabled, client, reply, ticket]);
}

// ---------------------------------------------------------------- the panel

function PlayerPanel({ open }: { open: EvidenceOpen }) {
  const store = useStore();
  const source = useSceneStore((s) => s.source);
  const { client } = useSource();
  const sim = source === "simulation";
  const simLoaded = useSimModel(open.ticket, sim);
  const liveLoaded = useLiveModel(client ?? null, open.ticket, !sim);
  const loaded = sim ? simLoaded : liveLoaded;
  const model = loaded.status === "ready" ? loaded.model : null;
  const [failedOnly, setFailedOnly] = useState(false);
  const [sel, setSel] = useState<EvidenceSelection | null>(null);
  // The first selection, once the model is there (the address's check, the file the entry point named);
  // set during render, React's pattern for state derived from a first value. After that it is the person's.
  if (model && sel === null) setSel(initialSelection(model, { check: open.check, ...(open.start ?? {}) }, failedOnly));
  // Kept through reloads and the filter.
  const current = useMemo<EvidenceSelection | null>(() => (model && sel ? keepSelection(model, sel, failedOnly) : null), [model, sel, failedOnly]);

  // The address carries the check id (never a file): written when it changes.
  const checkId = model && current ? (findCheck(model, current.check)?.id ?? null) : null;
  useEffect(() => {
    if (model) store.setEvidenceCheck(checkId);
  }, [store, model, checkId]);

  const choose = useCallback((next: EvidenceSelection) => setSel(next), []);
  const step = useCallback(
    (what: "file" | "check", direction: 1 | -1) => {
      if (!model || !current) return;
      setSel(what === "file" ? stepFile(model, current, direction, failedOnly) : stepCheck(model, current, direction, failedOnly));
    },
    [model, current, failedOnly],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT|VIDEO)$/.test(t.tagName)) return;
      const map: Record<string, ["file" | "check", 1 | -1]> = { ",": ["file", -1], ".": ["file", 1], "[": ["check", -1], "]": ["check", 1] };
      const hit = map[e.key];
      if (!hit) return;
      e.preventDefault();
      step(hit[0], hit[1]);
    },
    [step],
  );

  const file = model && current ? selectedFile(model, current) : null;
  const check = model && current ? findCheck(model, current.check) : null;
  const description = sim
    ? "The simulation's checks, with sample content the Factory Floor draws and writes itself. Nothing here is a capture. Read only."
    : "What the verifier captured for each check, beside the check it proves, read through the observer. Read only.";

  return (
    <DialogContent
      title={`Evidence, ${open.ticket}`}
      description={description}
      width="lg"
      className="top-[3vh] max-h-[94vh] max-w-[min(1320px,calc(100vw-2rem))]"
      onKeyDown={onKeyDown}
      data-evidence-player=""
      footer={<Stepping onStep={step} disabled={!model || !current} />}
    >
      <div className="flex flex-col gap-3 pb-1">
        <Notices model={model} source={source} />
        {loaded.status === "loading" ? (
          <p role="status" className="text-body-sm text-ink-muted">
            Reading the checks…
          </p>
        ) : loaded.status === "error" ? (
          <p role="alert" className="text-body-sm text-ink">
            {loaded.words}
          </p>
        ) : model && listedChecks(model).length === 0 ? (
          model.notKept ? null : (
            <p className="text-body-sm text-ink-muted" data-evidence-empty="">
              No verification check has been recorded for this ticket yet.
            </p>
          )
        ) : model && current ? (
          <div className="grid min-h-0 gap-3 lg:h-[68vh] lg:grid-cols-[minmax(280px,320px)_minmax(220px,280px)_minmax(0,1fr)]">
            <ChecksColumn model={model} current={current} failedOnly={failedOnly} onFailedOnly={setFailedOnly} onChoose={choose} />
            <FilesColumn model={model} check={check} current={current} onChoose={choose} />
            <ViewerColumn model={model} check={check} file={file} client={client ?? null} />
          </div>
        ) : null}
      </div>
    </DialogContent>
  );
}

function Stepping({ onStep, disabled }: { onStep: (what: "file" | "check", direction: 1 | -1) => void; disabled: boolean }) {
  const b = (label: string, key: string, what: "file" | "check", direction: 1 | -1) => (
    <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onStep(what, direction)} aria-keyshortcuts={key === "," ? "Comma" : key === "." ? "Period" : key === "[" ? "BracketLeft" : "BracketRight"}>
      {label} <Kbd>{key}</Kbd>
    </Button>
  );
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <span className="text-caption text-ink-subtle">Read only: the player changes nothing in the Factory.</span>
      <span className="flex flex-wrap gap-2">
        {b("Previous check", "[", "check", -1)}
        {b("Previous file", ",", "file", -1)}
        {b("Next file", ".", "file", 1)}
        {b("Next check", "]", "check", 1)}
      </span>
    </div>
  );
}

function Notices({ model, source }: { model: EvidenceModel | null; source: string }) {
  return (
    <>
      {source === "simulation" ? (
        <p className="rounded-sm border border-dashed border-line-strong bg-surface-sunken px-3 py-2 text-body-sm text-ink" data-evidence-simulation="">
          Simulation. {SIM_CONTENT_NOTE}
        </p>
      ) : null}
      {model?.notKept ? <NotKeptNote words={notKeptWords(model.notKept)} /> : null}
      {model && (model.readFrom === "archive" || model.readFrom === "both") ? (
        <p className="text-body-sm text-ink-muted" data-evidence-archive="">
          {model.readFrom === "archive" ? ARCHIVE_WORDS : "Some files are read from the ticket's archive, the others from its cell folder; each file says which."}
        </p>
      ) : null}
      {model && !model.mediaEnabled ? (
        <Banner tone="info" title="Screenshots and recordings are off" className="py-2">
          This project's settings leave {MEDIA_SETTING} off (in <span className="font-mono text-[12px]">{MEDIA_SETTING_FILE}</span>), so images and video are listed with their facts and are not requested. Text still opens.
        </Banner>
      ) : null}
    </>
  );
}

/**
 * The cell was cleaned up and its files were not kept (cleanup.archive): a plain statement, not an error and
 * not an empty panel (STYLE_GUIDE 8.4, "Nothing to show, nothing to do"). The fact, then the run record's reason.
 */
function NotKeptNote({ words }: { words: { readonly title: string; readonly detail: string | null } }) {
  return (
    <div className="flex flex-col gap-1 rounded-sm border border-dashed border-line-strong px-3 py-2" data-evidence-not-kept="">
      <p className="text-body-sm text-ink">{words.title}</p>
      {words.detail ? <p className="text-body-sm text-ink-muted">{words.detail}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------- checks

function ChecksColumn({ model, current, failedOnly, onFailedOnly, onChoose }: { model: EvidenceModel; current: EvidenceSelection; failedOnly: boolean; onFailedOnly: (on: boolean) => void; onChoose: (s: EvidenceSelection) => void }) {
  const failed = listedChecks(model, true).length;
  return (
    <section aria-labelledby="evidence-checks" className="flex min-h-0 flex-col rounded-sm border border-line" data-evidence-checks="">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h3 id="evidence-checks" className="text-label text-ink">
          Checks
        </h3>
        <Button size="sm" variant="ghost" aria-pressed={failedOnly} disabled={failed === 0 && !failedOnly} onClick={() => onFailedOnly(!failedOnly)}>
          Failed only ({failed})
        </Button>
      </div>
      <div className="max-h-[30vh] min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5 lg:max-h-none" tabIndex={-1}>
        {model.runs.map((run) => {
          const checks = failedOnly ? run.checks.filter((c) => c.result === "fail") : run.checks;
          if (!checks.length) return null;
          const headingId = `evidence-run-${run.key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
          return (
            <div key={run.key} className="mb-2" role="group" aria-labelledby={headingId}>
              <p id={headingId} className="px-1.5 pb-1 pt-1 text-caption font-semibold text-ink-muted">
                {runWords(run)}
              </p>
              <ul className="flex flex-col">
                {checks.map((c) => (
                  <li key={c.key}>
                    <CheckButton check={c} selected={c.key === current.check} onChoose={onChoose} />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {failedOnly && failed === 0 ? <p className="px-1.5 text-body-sm text-ink-muted">No check failed.</p> : null}
      </div>
    </section>
  );
}

function CheckButton({ check, selected, onChoose }: { check: EvidenceCheck; selected: boolean; onChoose: (s: EvidenceSelection) => void }) {
  const look = resultLook(check.result);
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-evidence-check={check.id}
      onClick={() => onChoose({ check: check.key, file: check.files[0]?.key ?? null })}
      className={cn(
        "flex w-full items-center gap-2 rounded-xs px-1.5 py-1.5 text-left text-body-sm outline-none hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus",
        selected && "bg-accent-soft",
      )}
    >
      <StateGlyph state={look.state} size={12} />
      <span className="w-14 shrink-0 font-mono text-[12px] text-ink">{check.id}</span>
      <span className="min-w-0 flex-1 truncate text-ink-muted">{kindWords(check.kind)}</span>
      <span className={cn("shrink-0 text-caption font-semibold", check.result === "fail" ? "text-factory-fail" : "text-ink")}>{look.word}</span>
      <span className="w-12 shrink-0 text-right text-caption text-ink-subtle">
        {check.files.length} {check.files.length === 1 ? "file" : "files"}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------- files

function FilesColumn({ model, check, current, onChoose }: { model: EvidenceModel; check: EvidenceCheck | null; current: EvidenceSelection; onChoose: (s: EvidenceSelection) => void }) {
  const sim = model.source === "simulation";
  return (
    <section aria-labelledby="evidence-files" className="flex min-h-0 flex-col rounded-sm border border-line" data-evidence-files="">
      <div className="border-b border-line px-3 py-2">
        <h3 id="evidence-files" className="text-label text-ink">
          Files{check ? <span className="font-mono text-[12px] font-normal text-ink-muted"> of {check.id}</span> : null}
        </h3>
      </div>
      <div className="max-h-[22vh] min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5 lg:max-h-none">
        {!check || check.files.length === 0 ? (
          <p className="px-1.5 text-body-sm text-ink-muted">This check names no file.</p>
        ) : (
          <ul className="flex flex-col">
            {check.files.map((f, i) => (
              <li key={f.key}>
                <FileButton file={f} index={i} count={check.files.length} checkId={check.id} selected={f.key === current.file} onChoose={() => onChoose({ check: check.key, file: f.key })} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="border-t border-line px-3 py-1.5 text-caption text-ink-subtle">
        {sim ? "File names are the simulation's own." : (
          <>
            File names: <UncheckedNote />
          </>
        )}
      </p>
    </section>
  );
}

function FileButton({ file, index, count, checkId, selected, onChoose }: { file: EvidenceFile; index: number; count: number; checkId: string; selected: boolean; onChoose: () => void }) {
  const size = sizeWords(file.bytes);
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={fileAccessibleName(file, index, count, checkId)}
      data-evidence-file={file.artifactId ?? `${index + 1}`}
      data-evidence-state={file.state}
      onClick={onChoose}
      className={cn(
        "flex w-full flex-col items-start gap-0.5 rounded-xs px-1.5 py-1.5 text-left text-body-sm outline-none hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus",
        selected && "bg-accent-soft",
      )}
    >
      <span className="w-full min-w-0 truncate font-mono text-[12px] text-ink">
        <UncheckedText text={unchecked(file.name, "artifact path_rel", NAME_MAX)} max={NAME_MAX} labelled expandable={false} />
      </span>
      <span className="flex flex-wrap gap-x-2 text-caption text-ink-subtle">
        <span>{CLASS_WORDS[file.cls]}</span>
        {size ? <span>{size}</span> : null}
        <span className={cn(file.state === "ready" ? "text-ink-muted" : file.state === "changed" ? "text-factory-fail" : "text-warning-ink")}>{STATE_WORDS[file.state]}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------- the viewer and its facts

function ViewerColumn({ model, check, file, client }: { model: EvidenceModel; check: EvidenceCheck | null; file: EvidenceFile | null; client: ObserverClient | null }) {
  if (!check || !file) {
    return (
      <section aria-label="Viewer" className="flex min-h-0 flex-col rounded-sm border border-line p-3">
        <p className="text-body-sm text-ink-muted">Choose a file to see it.</p>
      </section>
    );
  }
  if (check.mock) return <MockCompare model={model} check={check} file={file} client={client} />;
  const index = check.files.indexOf(file);
  const banner = fileBanner(file);
  return (
    <section aria-label={`Viewer, check ${check.id}, file ${index + 1} of ${check.files.length}`} className="flex min-h-0 flex-col gap-2 rounded-sm border border-line p-3" data-evidence-viewer="">
      {banner ? (
        <p role="note" className={cn("rounded-sm border px-3 py-2 text-body-sm", file.integrity === "mismatch" ? "border-factory-fail bg-factory-fail-soft text-ink" : "border-line-strong bg-surface-sunken text-ink")} data-evidence-integrity={file.integrity}>
          {banner}
        </p>
      ) : null}
      <div className="flex min-h-[200px] min-w-0 flex-1 flex-col">
        {/* Keyed by file: moving on unmounts the viewer and releases what it showed. */}
        <Viewer key={`${check.key}/${file.key}`} model={model} check={check} file={file} index={index} client={client} />
      </div>
      <FileFacts file={file} model={model} />
    </section>
  );
}

/**
 * M15: a design mock's check (M14 part C): the approved mock and the captured screen side by side (stacked
 * when narrow), each named in words, with the recorded result and the verifier's words beside them as
 * plain text. The page compares nothing: what it says is what verify.py compare recorded. Selecting the
 * check is selecting the pair: both pictures are requested, by catalog id, and only while media is on.
 */
function MockCompare({ model, check, file, client }: { model: EvidenceModel; check: EvidenceCheck; file: EvidenceFile; client: ObserverClient | null }) {
  const mock = check.mock!;
  const { approved, captures } = mockSides(check);
  const sides: Array<readonly [EvidenceFile | null, string]> = [[approved, ROLE_WORDS["approved-mock"]], ...(captures.length ? captures.map((c) => [c, ROLE_WORDS.capture] as const) : [[null, ROLE_WORDS.capture] as const])];
  const look = resultLook(check.result);
  const sim = model.source === "simulation";
  return (
    <section aria-label={`Viewer, check ${check.id}: the approved mock beside the captured screen`} className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-sm border border-line p-3" data-evidence-viewer="" data-evidence-mock={mock.compared ?? "not-recorded"}>
      <div className="flex flex-col gap-1" data-mock-result="">
        <p className="flex flex-wrap items-center gap-2 text-body-sm text-ink">
          <StateGlyph state={look.state} size={12} />
          <span className="font-semibold">{mockResultWords(mock)}</span>
        </p>
        <p className="text-caption text-ink-muted">
          {mock.forScenario ? (
            <>
              Approved for <span className="font-mono text-[12px] text-ink">{mock.forScenario}</span>. The scenarios stay the authority; a mock adds no requirement.
            </>
          ) : (
            "Approved for the whole slice. The scenarios stay the authority; a mock adds no requirement."
          )}{" "}
          Nothing here is compared by the Factory Floor: this is what the verifier recorded.
        </p>
        {mock.differences.length ? (
          <div className="mt-1" data-mock-differences="">
            <p className="text-label text-ink-muted">Differences the verifier recorded</p>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-body-sm text-ink">
              {mock.differences.map((d, i) => (
                <li key={i}>
                  <UncheckedText text={unchecked(d, "mock difference", 280)} max={280} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {mock.note ? (
          <p className="mt-1 text-body-sm text-ink">
            <span className="text-ink-muted">The verifier's note: </span>
            <UncheckedText text={unchecked(mock.note, "mock note", 280)} max={280} />
          </p>
        ) : null}
        {mock.freeText ? <UncheckedNote className="text-caption text-ink-subtle opacity-70" /> : null}
      </div>
      <div className="grid min-h-0 gap-3 sm:grid-cols-2" data-mock-sides="">
        {sides.map(([f, words], i) => (
          <figure key={f?.key ?? `none-${i}`} className={cn("flex min-h-[220px] min-w-0 flex-col gap-1.5 rounded-sm border p-2", f && f.key === file.key ? "border-line-strong" : "border-line")} data-mock-side={f?.role ?? "missing"}>
            <figcaption className="text-label text-ink">
              {words}
              {sim ? <span className="ml-1 font-normal text-ink-subtle">(the simulation's sample)</span> : null}
            </figcaption>
            {f ? (
              <>
                {fileBanner(f) ? (
                  <p role="note" className={cn("rounded-sm border px-2 py-1 text-caption", f.integrity === "mismatch" ? "border-factory-fail bg-factory-fail-soft text-ink" : "border-line-strong bg-surface-sunken text-ink")} data-evidence-integrity={f.integrity}>
                    {fileBanner(f)}
                  </p>
                ) : null}
                <div className="flex min-h-0 flex-1 flex-col">
                  <Viewer key={`${check.key}/${f.key}`} model={model} check={check} file={f} index={check.files.indexOf(f)} client={client} />
                </div>
                <p className="text-caption text-ink-subtle">{INTEGRITY_WORDS[f.integrity].fact}</p>
              </>
            ) : (
              <Withheld words={`The check names no ${words.toLowerCase()}.`} />
            )}
          </figure>
        ))}
      </div>
      <FileFacts file={file} model={model} />
    </section>
  );
}

function Viewer({ model, check, file, index, client }: { model: EvidenceModel; check: EvidenceCheck; file: EvidenceFile; index: number; client: ObserverClient | null }) {
  const request = contentRequest(model, { check: check.key, file: file.key });
  const what = `${CLASS_WORDS[file.cls]}, check ${check.id}, file ${index + 1}`;
  switch (request.kind) {
    case "simulated":
      if (request.content.kind === "image") return <SimulatedImage checkId={request.content.checkId} result={request.content.result} round={request.content.round} role={request.content.role ?? null} label={`Simulated ${request.content.role ? ROLE_WORDS[request.content.role].toLowerCase() : "screenshot"}, check ${check.id}`} />;
      if (request.content.kind === "video") return <Withheld words={SIM_RECORDING_WORDS} />;
      return <TextBody text={request.content.text} label={`Simulated text, check ${check.id}, file ${index + 1}`} truncated={false} freeText={false} redacted={null} simulated />;
    case "text":
      return client ? <LiveText client={client} artifactId={request.artifactId} label={`Text, check ${check.id}, file ${index + 1}`} catalogFreeText={file.freeText} /> : <Withheld words={reasonWords("network")} />;
    case "image":
    case "video": {
      const url = client?.artifactContentUrl?.(request.artifactId) ?? null;
      if (!url) return <Withheld words={reasonWords("invalid")} />;
      return request.kind === "image" ? <LiveImage url={url} alt={what} /> : <LiveVideo url={url} label={what} />;
    }
    case "none":
      return <Withheld words={request.reason ? reasonWords(request.reason, file.cls) : "Nothing to show for this file."} observerWords={file.accessWords} cls={file.cls} />;
  }
}

function Withheld({ words, observerWords = null, cls }: { words: string; observerWords?: string | null; cls?: EvidenceFile["cls"] }) {
  return (
    <div className="flex flex-1 flex-col items-start justify-center gap-1.5 rounded-sm bg-surface-sunken px-4 py-6 text-body-sm text-ink" data-evidence-withheld="">
      {cls ? <p className="text-caption font-semibold text-ink-muted">{CLASS_WORDS[cls]}, not shown</p> : null}
      <p>{words}</p>
      {observerWords ? <p className="text-caption text-ink-muted">The observer says: {observerWords}</p> : null}
    </div>
  );
}

/** One text, fetched for this selection only; aborted and dropped when the person moves on. */
function useText(client: ObserverClient, artifactId: string): ArtifactTextResult | null {
  const [result, setResult] = useState<{ readonly id: string; readonly r: ArtifactTextResult } | null>(null);
  useEffect(() => {
    if (!client.artifactText) return;
    const ctl = new AbortController();
    let alive = true;
    client.artifactText(artifactId, ctl.signal).then(
      (r) => alive && setResult({ id: artifactId, r }),
      () => alive && !ctl.signal.aborted && setResult({ id: artifactId, r: { ok: false, reason: "network", status: 0, retried: false } }),
    );
    return () => {
      alive = false;
      ctl.abort();
      setResult(null);
    };
  }, [client, artifactId]);
  if (!client.artifactText) return { ok: false, reason: "refused", status: 0, retried: false };
  return result && result.id === artifactId ? result.r : null;
}

function LiveText({ client, artifactId, label, catalogFreeText }: { client: ObserverClient; artifactId: string; label: string; catalogFreeText: boolean }) {
  const r = useText(client, artifactId);
  if (!r) {
    return (
      <p role="status" className="text-body-sm text-ink-muted">
        Reading the file…
      </p>
    );
  }
  if (!r.ok) return <Withheld words={reasonWords(r.reason)} />;
  return <TextBody text={r.text} label={label} truncated={r.labels.truncated} freeText={catalogFreeText || r.labels.freeText} redacted={r.labels.redacted} evidenceMatch={r.labels.evidenceMatch} />;
}

/** Plain text in a text node, monospaced, with its line count; never markup, never links. */
function TextBody({ text, label, truncated, freeText, redacted, evidenceMatch = "match", simulated = false }: { text: string; label: string; truncated: boolean; freeText: boolean; redacted: number | null; evidenceMatch?: string | null; simulated?: boolean }) {
  const lines = lineCount(text);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5" data-evidence-text="">
      <p className="flex flex-wrap gap-x-3 text-caption text-ink-subtle">
        <span>
          {lines} {lines === 1 ? "line" : "lines"}
        </span>
        {simulated ? <span>The simulation's sample text</span> : null}
        {freeText ? (
          <span className="font-semibold text-warning-ink" data-free-text="">
            {FREE_TEXT_LABEL}
          </span>
        ) : null}
        {redacted ? <span>{redacted} {redacted === 1 ? "value" : "values"} replaced by the observer</span> : null}
      </p>
      {truncated ? (
        <p className="rounded-sm border border-line-strong px-2 py-1 text-caption text-ink" data-evidence-truncated="">
          The observer cut this text short: only its beginning is shown.
        </p>
      ) : null}
      {evidenceMatch !== null && evidenceMatch !== "match" ? (
        <p role="note" className="rounded-sm border border-factory-fail bg-factory-fail-soft px-2 py-1 text-caption text-ink">
          The observer did not confirm these are the bytes it catalogued. Not proof.
        </p>
      ) : null}
      {/* A scrollable region takes focus for keyboard scrolling; its name is the file's position and type. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <pre tabIndex={0} role="region" aria-label={label} className="min-h-0 flex-1 overflow-auto whitespace-pre rounded-sm bg-surface-sunken p-3 font-mono text-[12px] leading-[1.5] text-ink outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus">
        {text}
      </pre>
    </div>
  );
}

/** An image whose source is the content route. Retried once (the observer may answer "try again"), then said. */
function LiveImage({ url, alt }: { url: string; alt: string }) {
  const [actual, setActual] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const retry = useRetryOnce(attempt, setAttempt, setFailed);
  if (failed) return <Withheld words="The image did not load. The observer may have refused it (for example, it changed after it was catalogued) or been busy, even when asked again." />;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" aria-pressed={actual} onClick={() => setActual((a) => !a)}>
          Actual size
        </Button>
        <span className="text-caption text-ink-subtle">{actual ? "Shown at its own size; scroll to see all of it." : "Shown to fit."}</span>
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div tabIndex={actual ? 0 : -1} role={actual ? "region" : undefined} aria-label={actual ? `${alt}, actual size` : undefined} className={cn("min-h-0 flex-1 rounded-sm bg-surface-sunken", actual ? "overflow-auto" : "flex items-center justify-center overflow-hidden")}>
        <img key={attempt} src={url} alt={alt} onError={retry} className={actual ? "max-w-none" : "max-h-full max-w-full object-contain"} />
      </div>
    </div>
  );
}

/** A recording with the browser's own controls. Never autoplays; loads its metadata when selected. */
function LiveVideo({ url, label }: { url: string; label: string }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const retry = useRetryOnce(attempt, setAttempt, setFailed);
  if (failed) return <Withheld words="The recording did not load. The observer may have refused it or been busy, even when asked again." />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center rounded-sm bg-surface-sunken">
      {/* Recordings carry no captions: they are the verifier's silent screen recordings. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video key={attempt} src={url} controls preload="metadata" aria-label={label} onError={retry} className="max-h-full max-w-full" />
    </div>
  );
}

/** One retry, a second later, then failed. */
function useRetryOnce(attempt: number, setAttempt: (n: number) => void, setFailed: (f: boolean) => void): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return useCallback(() => {
    if (attempt >= 1) {
      setFailed(true);
      return;
    }
    timer.current = setTimeout(() => setAttempt(attempt + 1), 1000);
  }, [attempt, setAttempt, setFailed]);
}

/** The simulation's own drawing in place of a screenshot: a plain sketch of a page, labelled as such. */
function SimulatedImage({ checkId, result, round, role = null, label }: { checkId: string; result: string | null; round: number | null; role?: "approved-mock" | "capture" | null; label: string }) {
  const failed = result === "fail";
  // M15: the sample mock and its capture differ in one place the sample's difference names (a filled or an outlined chip).
  const chipFill = (i: number) => (role === "approved-mock" && i === 0 ? "var(--mach-factory-pass)" : i === 1 && failed ? "var(--mach-factory-fail-soft)" : "var(--mach-factory-pass-soft)");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5" data-evidence-simulated-image="">
      <p className="text-caption text-ink-subtle">Drawn by the Factory Floor for the simulation; not a screenshot.</p>
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-sm bg-surface-sunken p-3">
        <svg role="img" aria-label={label} viewBox="0 0 480 300" className="h-full max-h-[420px] w-full max-w-[640px]">
          <rect x="1" y="1" width="478" height="298" rx="8" fill="var(--mach-surface)" stroke="var(--mach-line-strong)" strokeWidth="2" />
          <rect x="1" y="1" width="478" height="34" rx="8" fill="var(--mach-surface-sunken)" stroke="var(--mach-line-strong)" strokeWidth="2" />
          {[24, 44, 64].map((cx) => (
            <circle key={cx} cx={cx} cy="18" r="6" fill="var(--mach-line-strong)" />
          ))}
          <text x="96" y="23" fontFamily="var(--mach-font-mono)" fontSize="13" fill="var(--mach-ink-muted)">
            simulation · {checkId}
            {round !== null ? ` · round ${round}` : ""}
          </text>
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <rect x="32" y={66 + i * 38} width="300" height="24" rx="4" fill="var(--mach-surface-sunken)" stroke="var(--mach-line)" />
              <rect x="348" y={66 + i * 38} width="100" height="24" rx="12" fill={chipFill(i)} stroke={i === 1 && failed ? "var(--mach-factory-fail)" : "var(--mach-factory-pass)"} />
            </g>
          ))}
          <text x="240" y="282" textAnchor="middle" fontFamily="var(--mach-font-sans)" fontSize="13" fill="var(--mach-ink-muted)">
            Sample drawing: not a capture
          </text>
        </svg>
      </div>
    </div>
  );
}

function FileFacts({ file, model }: { file: EvidenceFile; model: EvidenceModel }) {
  const facts: Array<[string, ReactNode]> = [
    ["Proves", <span key="p" className="font-mono text-[12px]">{file.proves.join(", ")}</span>],
    ["Integrity", INTEGRITY_WORDS[file.integrity].fact],
    ["Read from", file.origin === "archive" ? "The ticket's archive" : file.origin === "cell" ? "The cell folder (live)" : file.origin === "simulation" ? "The simulation's own sample" : "Not said"],
    ["Round", file.round === null ? "Not recorded" : String(file.round)],
  ];
  if (file.commit) facts.push(["Commit", <span key="c" className="font-mono text-[12px]">{file.commit.slice(0, 7)}</span>]);
  if (file.mediaType) facts.push(["Type", <span key="t" className="font-mono text-[12px]">{file.mediaType}</span>]);
  const size = sizeWords(file.bytes);
  if (size) facts.push(["Size", size]);
  if (file.freeText) facts.push(["Content", <span key="f" className="font-semibold text-warning-ink" data-free-text="">{FREE_TEXT_LABEL}</span>]);
  if (model.source !== "simulation" && file.state !== "ready") facts.push(["State", STATE_WORDS[file.state]]);
  return (
    <dl className="grid grid-cols-[minmax(84px,auto)_1fr] gap-x-4 gap-y-1 border-t border-line pt-2 text-body-sm" data-evidence-facts="">
      {facts.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-subtle">{k}</dt>
          <dd className="min-w-0 text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
