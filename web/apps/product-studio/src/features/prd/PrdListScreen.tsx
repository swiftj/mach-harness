import { useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router";
import { CircleAlert, FileText, FileUp, TriangleAlert } from "lucide-react";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, Heading, LoadingState, StatusPill, Text, describeError, plural, toast } from "@mach/ui";
import { isMachApiError, uploadFile, uploadLimits, type PrdImport, type PrdSummary } from "@mach/ui/api";
import { useEngineAct } from "../../api/act";
import { useOperation } from "../../api/useOperation";
import { ScreenFrame } from "../../shared/ScreenFrame";
import { DataNotice } from "./parts";
import { limitWords, sectionLines } from "./model";

/**
 * Start from a PRD: the PRDs imported so far, and a way to import one (`prd.list`, `prd.import`).
 * The path is optional; a product manager without a PRD never needs this screen.
 */
export function PrdListScreen() {
  const list = useOperation("prd.list", {});
  const prds = list.data?.prds ?? null;

  return (
    <ScreenFrame
      title="Start from a PRD"
      lead="If you have an approved product requirements document, bring it in and turn it into epics and thin slices that you confirm one at a time. It is optional: without one, you work exactly as before."
    >
      <DataNotice />
      <ImportPanel onImported={list.reload} first={prds !== null && prds.length === 0} />
      <section aria-labelledby="prds-heading" className="flex max-w-reading flex-col gap-4">
        <Heading level={2} id="prds-heading">
          Your PRDs
        </Heading>
        {prds === null && list.loading ? <LoadingState label="Reading your PRDs" /> : null}
        {prds === null && list.error ? (
          <ErrorState
            icon={<CircleAlert />}
            title={describeError(list.error).title}
            message={describeError(list.error).message}
            action={<Button onClick={list.reload}>Try again</Button>}
          />
        ) : null}
        {prds && prds.length === 0 ? (
          <EmptyState
            icon={<FileText />}
            headingLevel={3}
            title="No PRD imported yet"
            description="Import one above when you have it. Each document you import is listed here with what has been made from it."
          />
        ) : null}
        {prds && prds.length > 0 ? (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {prds.map((prd) => (
              <PrdRow key={prd.prd_id} prd={prd} />
            ))}
          </ul>
        ) : null}
      </section>
    </ScreenFrame>
  );
}

/** Where a PRD stands, as the engine's summary says it, in one word with a shape. */
function prdStage(prd: PrdSummary): { word: string; tone: "neutral" | "warning" | "success" | "info" } {
  if ((prd.applied ?? []).length > 0) return { word: "Drafts made", tone: "success" };
  if (!prd.mapped) return { word: "No map yet", tone: "neutral" };
  if ((prd.not_covered ?? []).length > 0) return { word: "Sections to settle", tone: "warning" };
  return { word: "Ready to make the drafts", tone: "info" };
}

function PrdRow({ prd }: { prd: PrdSummary }) {
  const stage = prdStage(prd);
  const facts = [plural(prd.sections, "section"), plural(prd.line_count, "line")];
  if (prd.mapped && prd.slices_mapped !== undefined) facts.push(`${plural(prd.slices_mapped, "slice")} on its map`);
  if ((prd.not_covered ?? []).length) facts.push(`${plural(prd.not_covered!.length, "section")} not covered`);
  if ((prd.applied ?? []).length) facts.push(`${plural(prd.applied!.length, "draft slice")} made`);
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link to={`/prds/${prd.prd_id}`} className="text-body font-semibold text-ink underline-offset-2 hover:underline">
            {prd.name}
          </Link>
          <ArtifactId>{prd.prd_id}</ArtifactId>
        </div>
        <p className="text-body-sm text-ink-muted">{facts.join(" · ")}</p>
        {!prd.document_matches ? (
          <p className="flex items-center gap-1.5 text-body-sm text-danger-ink">
            <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
            The copy in your workspace no longer matches what was imported. Import the document again.
          </p>
        ) : null}
      </div>
      <StatusPill tone={stage.tone} size="sm" className={stage.tone === "warning" ? "border-dashed" : undefined}>
        {stage.word}
      </StatusPill>
    </li>
  );
}

/**
 * Import: the product manager picks one Markdown or plain-text file. The app checks the kind and
 * size the host would refuse, then the engine judges the content and answers in its own words.
 */
function ImportPanel({ onImported, first }: { onImported: () => void; first: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const act = useEngineAct();
  const [picking, setPicking] = useState(false);
  const [tooEarly, setTooEarly] = useState<string | null>(null);
  const [result, setResult] = useState<PrdImport | null>(null);
  const limit = uploadLimits.prd;

  const choose = () => {
    setTooEarly(null);
    act.reset();
    input.current?.click();
  };

  const picked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPicking(true);
    setResult(null);
    try {
      const upload = await uploadFile(file, limit, "prd.import");
      const imported = await act.run("prd.import", { file: upload });
      if (imported) {
        setResult(imported);
        toast({ tone: "success", title: imported.imported ? `Imported ${imported.prd.prd_id}` : `${imported.prd.prd_id} was already imported` });
        onImported();
      }
    } catch (error) {
      setTooEarly(isMachApiError(error) ? error.message : String(error));
    } finally {
      setPicking(false);
    }
  };

  const busy = picking || act.pending;
  return (
    <section aria-labelledby="import-heading" className="flex max-w-reading flex-col gap-4 rounded-md border border-line bg-surface px-6 py-5">
      <div className="flex flex-col gap-1">
        <Heading level={2} id="import-heading" size="title-3">
          {first ? "Import your PRD" : "Import a PRD"}
        </Heading>
        <Text size="body-sm" tone="muted">
          {limitWords(limit)} Export Word, PDF or Google Docs to Markdown or text first. A revised document becomes a new PRD; the same document twice is the same PRD.
        </Text>
      </div>
      <div>
        <input ref={input} type="file" accept={limit.extensions.join(",")} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void picked(e)} />
        <Button variant="primary" onClick={choose} loading={busy}>
          <FileUp aria-hidden="true" />
          Choose a file to import
        </Button>
      </div>
      {tooEarly ? (
        <div role="alert" className="flex items-start gap-2 text-body-sm text-danger-ink">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>{tooEarly} Nothing was imported.</p>
        </div>
      ) : null}
      {act.shown ? (
        <ErrorState icon={<CircleAlert />} title={act.error?.kind === "refused" ? "Not imported" : act.shown.title} message={act.shown.message} hint={act.shown.hint} />
      ) : null}
      {result ? <Imported result={result} /> : null}
    </section>
  );
}

/** What the import made: the PRD, its sections and their line counts, and the way on. */
function Imported({ result }: { result: PrdImport }) {
  const prd = result.prd;
  return (
    <div role="status" className="flex flex-col gap-3 border-t border-line pt-4">
      <Banner tone={result.imported ? "success" : "info"} title={result.imported ? `Imported as ${prd.prd_id}` : `Already imported as ${prd.prd_id}`}>
        {result.note}
      </Banner>
      {result.sections?.length ? (
        <div className="flex flex-col gap-2">
          <p className="text-body-sm text-ink-muted">
            {plural(result.sections.length, "section")}, {plural(prd.line_count, "line")} in all:
          </p>
          <ol className="flex flex-col gap-1 text-body-sm">
            {result.sections.map((s) => (
              <li key={s.n} className="flex items-baseline gap-3">
                <span className="w-6 shrink-0 text-right text-ink-subtle tabular">{s.n}</span>
                <span className="min-w-0 flex-1 text-ink">{s.title}</span>
                <span className="shrink-0 text-ink-muted tabular">{s.heading_only ? "heading only" : plural(sectionLines(s), "line")}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <div>
        <Button asChild variant="secondary">
          <Link to={`/prds/${prd.prd_id}`}>Open {prd.prd_id}</Link>
        </Button>
      </div>
    </div>
  );
}
