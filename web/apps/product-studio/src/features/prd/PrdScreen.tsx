import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { CircleAlert, FileText } from "lucide-react";
import { ArtifactId, Banner, Button, ConfirmDialog, ErrorState, Heading, LoadingState, SliceStatusPill, Text, plural, describeError, toast } from "@mach/ui";
import type { PrdApply, PrdCoverageRow, PrdMapSlice, PrdStatus } from "@mach/ui/api";
import { useEngineAct } from "../../api/act";
import { useStatus } from "../../api/store";
import { useOperation } from "../../api/useOperation";
import { Fold } from "../../shared/layout/Fold";
import { Part, Parts } from "../../shared/layout/Parts";
import { ContextRow, OnePane, WorkPane, WorkPanes, WorkScreen } from "../../shared/layout/WorkScreen";
import {
  JOURNEY,
  applyBlocked,
  applyPlan,
  applySummary,
  applyWhat,
  coverageCounts,
  coverageProgress,
  coverageWords,
  fencedLines,
  importSummary,
  journeyStep,
  mapSummary,
  partForStep,
  partPlace,
  quote,
  quotedCount,
  settleSummary,
  type ApplyPlan,
} from "./model";
import { CoveragePill, DataNotice, PrdQuote, lineCount, linesLabel } from "./parts";
import { SettleDialog } from "./SettleDialog";
import { PrdConversation } from "./PrdConversation";
import { usePrdConversation } from "./usePrdConversation";
import { NameTheProduct } from "../home/start/NameTheProduct";
import { prdNeedsTheProduct } from "../home/start/model";

const about = "How its sections map to epics and slices, and what is left to settle.";

/**
 * One PRD, in two panes (M16 layout). The wide pane is the path as four parts, one open at a time: the import, the
 * map of epics and thin slices with the lines each rests on, settling the sections no slice cites, and making the
 * drafts. The part the path is at is open; each part's row says its state. The narrow pane keeps the document's counts
 * in view. Reads `prd.status` and `prd.show`; acts `prd.settle` and `prd.apply`, each confirmed. The same shape as
 * Shape's Size and route, which was modelled on this page.
 */
export function PrdScreen() {
  const prdId = useParams().prdId ?? "";
  const status = useOperation("prd.status", { prd_id: prdId });
  const show = useOperation("prd.show", { prd_id: prdId });

  if (!status.data && status.loading) {
    return (
      <PrdFrame prdId={prdId} title={prdId}>
        <OnePane label={prdId}>
          <LoadingState label={`Reading ${prdId}`} />
        </OnePane>
      </PrdFrame>
    );
  }
  if (!status.data) {
    const shown = status.error ? describeError(status.error) : { title: "Not available right now", message: "" };
    return (
      <PrdFrame prdId={prdId} title={prdId}>
        <OnePane label={prdId}>
          <ErrorState
            className="max-w-reading"
            icon={<CircleAlert />}
            title={status.error?.kind === "refused" ? `Could not read ${prdId}` : shown.title}
            message={shown.message}
            action={
              <>
                <Button onClick={status.reload}>Try again</Button>
                <Button asChild variant="ghost">
                  <Link to="/prds">All PRDs</Link>
                </Button>
              </>
            }
          />
        </OnePane>
      </PrdFrame>
    );
  }
  return (
    <PrdFrame prdId={status.data.prd.prd_id} title={status.data.prd.name}>
      <PrdPage data={status.data} lines={fencedLines(show.data?.fenced)} truncated={show.data?.truncated ?? false} reload={status.reload} />
    </PrdFrame>
  );
}

/** The slim context row: the PRD's ID, its file name as the page's h1, and what the page is for behind "About this page". */
function PrdFrame({ prdId, title, children }: { prdId: string; title: string; children: ReactNode }) {
  return (
    <WorkScreen header={<ContextRow identity={<ArtifactId plain>{prdId}</ArtifactId>} title={title} about={about} />}>
      {children}
    </WorkScreen>
  );
}

function PrdPage({ data, lines, truncated, reload }: { data: PrdStatus; lines: Map<number, string> | null; truncated: boolean; reload: () => void }) {
  const prd = data.prd;
  const step = journeyStep(data);
  const status = useStatus();
  const conv = usePrdConversation(prd.prd_id);
  // The conversation recorded a map: read the PRD's state again. Several writes arrive close together.
  const changes = conv.model.draftChanges;
  useEffect(() => {
    if (!changes) return;
    const timer = setTimeout(reload, 400);
    return () => clearTimeout(timer);
  }, [changes, reload]);
  const needsProduct = prdNeedsTheProduct(data, status.data?.project);
  const [settling, setSettling] = useState<PrdCoverageRow | null>(null);
  const map = data.map;
  const plan = useMemo(() => (map ? applyPlan(map, (id) => status.data?.epics.find((e) => e.epic_id === id)?.title ?? null) : null), [map, status.data]);
  const [open, setOpen] = useState<string | null>(partForStep(step));
  const [seenStep, setSeenStep] = useState(step);
  // When an act moves the path on (the last section settled, the drafts made), the part that now needs the person opens.
  if (seenStep !== step) {
    setSeenStep(step);
    setOpen(partForStep(step));
  }
  const sections = data.sections ?? [];

  return (
    <WorkPanes>
      <WorkPane label={`${prd.prd_id}, from import to drafts`}>
        <div className="flex flex-col gap-6">
          {!prd.document_matches ? (
            <Banner tone="danger" title="The copy in your workspace changed">
              It no longer matches the document that was imported, so nothing is shown or made from it. Import the document again from Start from a PRD.
            </Banner>
          ) : null}
          <Parts label="Starting from a PRD" open={open} onOpenChange={setOpen}>
            <Part id="import" number={1} place={partPlace("import", step)} name={JOURNEY[0]?.label ?? "Import"} summary={importSummary(prd)}>
              <ImportBody prdId={prd.prd_id} sections={sections} lines={lines} truncated={truncated} />
            </Part>
            <Part id="map" number={2} place={partPlace("map", step)} name={JOURNEY[1]?.label ?? "Map"} summary={mapSummary(data)}>
              <div className="flex flex-col gap-8">
                {map ? <MapBody prdId={prd.prd_id} map={map} lines={lines} /> : null}
                {map?.applied || !prd.document_matches ? null : <PrdConversation prdId={prd.prd_id} conv={conv} hasMap={Boolean(map)} />}
              </div>
            </Part>
            <Part id="settle" number={3} place={partPlace("settle", step)} name={JOURNEY[2]?.label ?? "Settle"} summary={map ? settleSummary(data.coverage) : "After the map"}>
              {map ? <CoverageBody data={data} lines={lines} onSettle={setSettling} /> : undefined}
            </Part>
            <Part id="apply" number={4} place={partPlace("apply", step)} name={JOURNEY[3]?.label ?? "Make the drafts"} summary={applySummary(data, plan, needsProduct)}>
              {map && plan ? <ApplyBody data={data} plan={plan} needsProduct={needsProduct} onDone={reload} /> : undefined}
            </Part>
          </Parts>
        </div>
        {map ? (
          <SettleDialog
            prdId={prd.prd_id}
            section={settling}
            quotations={settling ? quote(lines, settling.lines) : []}
            slices={map.slices}
            onOpenChange={(isOpen) => (isOpen ? undefined : setSettling(null))}
            onDone={reload}
          />
        ) : null}
      </WorkPane>
      <WorkPane side label={`Where ${prd.prd_id} stands`}>
        <CountsAside data={data} />
      </WorkPane>
    </WorkPanes>
  );
}

/** The narrow pane: the document's counts, coverage by state and the map's size, then where the PRD's text goes. */
function CountsAside({ data }: { data: PrdStatus }) {
  const prd = data.prd;
  const map = data.map;
  const progress = coverageProgress(data.coverage);
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="prd-aside-document" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Heading level={2} size="title-3" id="prd-aside-document">
            The document
          </Heading>
          <Text size="body-sm" tone="muted">
            {prd.format === "markdown" ? "Markdown" : "Plain text"}, imported as <ArtifactId plain>{prd.prd_id}</ArtifactId>.
          </Text>
        </div>
        <Counts rows={[{ label: "Sections", value: prd.sections }, { label: "Lines", value: prd.line_count }]} />
      </section>
      {map ? (
        <section aria-labelledby="prd-aside-coverage" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Heading level={2} size="title-3" id="prd-aside-coverage">
              Coverage
            </Heading>
            <Text size="body-sm" tone="muted">
              {progress.total > 0 ? `${progress.settled} of ${plural(progress.total, "section")} no slice cites settled.` : "Every section is cited by a slice on the map."}
            </Text>
          </div>
          <Counts rows={coverageCounts(data)} />
        </section>
      ) : null}
      {map ? (
        <section aria-labelledby="prd-aside-map" className="flex flex-col gap-3">
          <Heading level={2} size="title-3" id="prd-aside-map">
            The map
          </Heading>
          <Counts
            rows={[
              { label: map.applied ? "Epics it proposed" : "New epics", value: map.epics.length },
              { label: "Thin slices", value: map.slices.length },
              { label: "Draft slices made", value: (prd.applied ?? []).length },
            ]}
          />
        </section>
      ) : null}
      <DataNotice />
    </div>
  );
}

function Counts({ rows }: { rows: Array<{ label: string; value: number }> }) {
  return (
    <dl className="grid grid-cols-2 gap-2">
      {rows.map((r) => (
        <div key={r.label} className="flex min-w-0 flex-col gap-0.5 rounded-sm bg-surface-sunken px-2.5 py-2">
          <dt className="text-caption text-ink-muted">{r.label}</dt>
          <dd className="text-title-3 font-semibold text-ink tabular">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The import: the document's sections, and the whole text folded as data. */
function ImportBody({ prdId, sections, lines, truncated }: { prdId: string; sections: NonNullable<PrdStatus["sections"]>; lines: Map<number, string> | null; truncated: boolean }) {
  return (
    <div className="flex max-w-[48rem] flex-col gap-4">
      {sections.length ? (
        <div className="flex flex-col gap-2">
          <Heading level={3}>The document's sections</Heading>
          <ol className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {sections.map((s) => (
              <li key={s.n} className="flex items-baseline gap-4 px-4 py-2.5 text-body-sm">
                <span className="w-6 shrink-0 text-right text-ink-subtle tabular">{s.n}</span>
                <span className="min-w-0 flex-1 text-ink">{s.title}</span>
                <span className="shrink-0 text-ink-muted tabular">{linesLabel(s.lines)}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <Text size="body-sm" tone="muted">
          Its sections are listed under Settle what is not covered, each with what covers it.
        </Text>
      )}
      {lines ? (
        <Fold boxed label="The document as written, with its line numbers">
          <div className="flex flex-col gap-2">
            <p className="text-body-sm text-ink-muted">The document's words, as data. {truncated ? "Long documents are cut; this shows the first part." : null}</p>
            <PrdQuote prdId={prdId} quotations={quote(lines, `1-${Math.max(...lines.keys(), 1)}`)} />
          </div>
        </Fold>
      ) : null}
    </div>
  );
}

/**
 * Coverage: every section and what covers it. Sections no slice cites are settled one by one; settled of total is a
 * real fraction, and nothing is made while any is open.
 */
function CoverageBody({ data, lines, onSettle }: { data: PrdStatus; lines: Map<number, string> | null; onSettle: (row: PrdCoverageRow) => void }) {
  const rows = data.coverage ?? [];
  const progress = coverageProgress(rows);
  const applied = data.map?.applied ?? false;
  const slices = data.map?.slices ?? [];

  return (
    <div className="flex max-w-[48rem] flex-col gap-4">
      <Text size="body-sm" tone="muted" className="max-w-reading">
        Each section of the document, and what covers it. A section no slice cites needs your word: part of a slice, out of scope, or later.
      </Text>
      {progress.total > 0 ? (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-4 py-3">
          <p className="text-body font-semibold text-ink tabular">
            {progress.settled} of {plural(progress.total, "section")} settled
          </p>
          <div className="flex gap-1" aria-hidden="true">
            {Array.from({ length: progress.total }, (_, i) => (
              <span key={i} className={i < progress.settled ? "h-1.5 flex-1 rounded-full bg-ink-subtle" : "h-1.5 flex-1 rounded-full border border-dashed border-line-strong"} />
            ))}
          </div>
          <p className="text-body-sm text-ink-muted">
            {progress.left.length
              ? `${plural(progress.left.length, "section")} still to settle. Nothing can be made from this PRD while any section is unsettled.`
              : "Every section no slice cites is settled."}
          </p>
          {progress.left.length && !applied ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {progress.left.map((row) => (
                <Button key={row.n} size="sm" onClick={() => onSettle(row)} aria-label={`Settle section ${row.n}, ${row.title}`}>
                  Settle section {row.n}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-body-sm text-ink-muted">Every section is cited by a slice on the map, so there is nothing to settle.</p>
      )}
      <ol aria-label="Sections of the document" className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
        {rows.map((row) => {
          const quotations = row.state === "not_covered" && lines ? quote(lines, row.lines) : [];
          return (
            <li key={row.n} className={row.state === "not_covered" ? "flex flex-col gap-2 bg-warning-soft px-4 py-3" : "flex flex-col gap-2 px-4 py-3"}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="w-6 shrink-0 text-right text-body-sm text-ink-subtle tabular">{row.n}</span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body font-semibold text-ink">{row.title}</span>
                  <span className="text-body-sm text-ink-muted">
                    {linesLabel(row.lines)} · {coverageWords(row, slices)}
                  </span>
                </div>
                <CoveragePill state={row.state} />
              </div>
              {row.settled?.reason ? (
                <p className="pl-10 text-body-sm text-ink-muted">
                  Your reason: <span className="text-ink">{row.settled.reason}</span>
                </p>
              ) : null}
              {quotations.length ? (
                <Fold className="pl-10" label={`Read section ${row.n}, ${lineCount(quotedCount(quotations))}`}>
                  <PrdQuote prdId={data.prd.prd_id} quotations={quotations} />
                </Fold>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The proposed epics and thin slices, in the order the builders take them, each with the lines it rests on folded. */
function MapBody({ prdId, map, lines }: { prdId: string; map: NonNullable<PrdStatus["map"]>; lines: Map<number, string> | null }) {
  const status = useStatus();
  const epicTitle = (id: string) => status.data?.epics.find((e) => e.epic_id === id)?.title ?? null;
  const newEpics = new Map(map.epics.map((e) => [e.key, e.title]));
  const keyTitle = new Map(map.slices.map((s) => [s.key, s.title]));
  const epicName = (epic: string) => newEpics.get(epic) ?? epicTitle(epic) ?? epic;

  return (
    <div className="flex max-w-[48rem] flex-col gap-5">
      <Text size="body-sm" tone="muted" className="max-w-reading">
        {map.applied
          ? "What was proposed and made from this PRD. The map is kept as it was when the drafts were made."
          : "Proposed in Claude Code and recorded there. To change it, ask for a new map there; until the drafts are made, a new map replaces this one."}
      </Text>
      {map.epics.length ? (
        <div className="flex flex-col gap-2">
          <Heading level={3}>{map.applied ? "Epics it proposed" : "New epics"}</Heading>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3">
            {map.epics.map((e) => (
              <li key={e.key} className="flex flex-col gap-1 rounded-md border border-line bg-surface px-4 py-3">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-body font-semibold text-ink">{e.title}</span>
                  <ArtifactId plain>{e.key}</ArtifactId>
                </span>
                {e.criteria.length ? (
                  <>
                    <span className="text-body-sm text-ink-muted">Done when:</span>
                    <ul className="list-disc pl-5 text-body-sm text-ink-muted">
                      {e.criteria.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <Heading level={3}>Thin slices, in the order they are built</Heading>
        <ol className="flex flex-col gap-4">
          {map.slices.map((s, index) => (
            <MapSliceItem key={s.key} prdId={prdId} slice={s} index={index} epicName={epicName(s.epic)} keyTitle={keyTitle} lines={lines} />
          ))}
        </ol>
      </div>
    </div>
  );
}

function MapSliceItem({
  prdId,
  slice,
  index,
  epicName,
  keyTitle,
  lines,
}: {
  prdId: string;
  slice: PrdMapSlice;
  index: number;
  epicName: string;
  keyTitle: Map<string, string>;
  lines: Map<number, string> | null;
}) {
  const depends = slice.depends_on.map((d) => (keyTitle.has(d) ? `${d}, “${keyTitle.get(d)}”` : d));
  const answers = slice.answers;
  const quotations = quote(lines, slice.cites);
  const quoted = quotedCount(quotations);
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong text-caption font-semibold text-ink-muted tabular" aria-hidden="true">
          {index + 1}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <Heading level={4} className="text-body font-semibold">
              {slice.title}
            </Heading>
            <ArtifactId plain>{slice.key}</ArtifactId>
            {slice.slice_id ? <ArtifactId>{slice.slice_id}</ArtifactId> : null}
            {slice.status ? <SliceStatusPill status={slice.status} size="sm" /> : null}
          </span>
          <Text size="body-sm">{slice.scope}</Text>
          <p className="text-body-sm text-ink-muted">
            In {epicName} · {depends.length ? `after ${depends.join(" and ")}` : "depends on no other slice"}
            {slice.lines !== slice.cites ? ` · with settled sections, ${linesLabel(slice.lines).toLowerCase()}` : null}
          </p>
          {answers ? (
            <p className="text-body-sm text-ink-muted">
              Drafted answers: {answers.accepted.length} accepted · {answers.pending.length} waiting for you · {answers.discuss.length} to discuss
            </p>
          ) : null}
        </div>
      </div>
      {quoted ? (
        <Fold className="pl-9" label={`Rests on ${lineCount(quoted)} of the PRD`}>
          <PrdQuote prdId={prdId} quotations={quotations} />
        </Fold>
      ) : (
        <p className="pl-9 text-body-sm text-ink-muted">Cites {slice.cites}.</p>
      )}
      {slice.slice_id ? (
        <nav aria-label={`Pages of ${slice.slice_id}`} className="flex flex-wrap gap-x-5 gap-y-1 pl-9 text-body-sm font-semibold">
          <Link to={`/slices/${slice.slice_id}`} className="text-accent-ink underline-offset-2 hover:underline">
            Open the specification of {slice.slice_id}
          </Link>
          <Link to={`/slices/${slice.slice_id}/prd`} className="text-accent-ink underline-offset-2 hover:underline">
            Its answers from the PRD
          </Link>
        </nav>
      ) : null}
    </li>
  );
}

/**
 * Make the drafts (`prd.apply`): an explicit act, confirmed in a dialog naming exactly what it makes.
 * Repeating it makes nothing twice, and the page says what already exists.
 */
function ApplyBody({ data, plan, needsProduct, onDone }: { data: PrdStatus; plan: ApplyPlan; needsProduct: boolean; onDone: () => void }) {
  const act = useEngineAct();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<PrdApply | null>(null);
  const again = data.map?.applied ?? false;
  const blocked = applyBlocked(data);
  const what = applyWhat(plan);

  const confirm = async () => {
    const applied = await act.run("prd.apply", { prd_id: data.prd.prd_id });
    if (!applied) return false;
    setResult(applied);
    toast({ tone: "success", title: applied.made.slices.length || applied.made.epics.length ? `Made the drafts from ${data.prd.prd_id}` : "Nothing new to make", description: applied.note });
    onDone();
    return true;
  };

  return (
    <div className="flex max-w-reading flex-col gap-4">
      <Text size="body-sm" tone="muted">
        {again
          ? `The drafts were made: ${plural((data.prd.applied ?? []).length, "draft slice")}. Running it again makes nothing twice; it only makes what is missing and says what already exists.`
          : `Adds ${what} to your workspace as drafts, in the map's order. Nothing is approved, sent or started, and nothing goes to GitHub.`}
      </Text>
      {again ? <Text size="body-sm">Every step is done. Each draft slice is now confirmed on its own page, under “From the PRD”.</Text> : null}
      {blocked ? (
        <p className="text-body-sm text-ink" id="apply-blocked">
          {blocked}
        </p>
      ) : null}
      {needsProduct ? (
        // The one act here until the product is named; the button that makes the drafts follows once it is.
        <NameTheProduct
          level={4}
          why={`Making the drafts needs the product to exist: its name, a one-sentence vision and the outcomes people should get. Name it here, then make ${what}. MACH's suggestion, if it made one, is in the conversation under Map.`}
        />
      ) : (
        <div>
          <Button
            variant={again ? "secondary" : "primary"}
            disabled={blocked !== null}
            aria-describedby={blocked ? "apply-blocked" : undefined}
            onClick={() => {
              act.reset();
              setOpen(true);
            }}
          >
            {again ? "Make the drafts again" : `Make ${what}`}
          </Button>
        </div>
      )}
      {result ? <ApplyResult result={result} /> : again ? <MadeBefore slices={data.map?.slices ?? []} /> : null}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={again ? `Make the drafts from ${data.prd.prd_id} again?` : `Make ${what} from ${data.prd.prd_id}?`}
        description={
          again
            ? "Anything already made is kept as it is and not made twice; a slice made and then removed is not made again. Nothing is approved, sent or started."
            : "Each becomes a draft in your workspace. Each slice is then confirmed with you on its own page, from the PRD's lines. Nothing is approved, sent or started, and nothing goes to GitHub."
        }
        confirmLabel={again ? "Make the drafts again" : "Make the drafts"}
        onConfirm={confirm}
        error={act.shown ? { ...act.shown, title: act.error?.kind === "refused" ? "Nothing was made" : act.shown.title } : null}
      >
        <div className="flex flex-col gap-3 text-body-sm">
          {plan.epics.length ? (
            <div className="flex flex-col gap-1">
              <p className="font-semibold text-ink">{again ? "Epics on the map" : plural(plan.epics.length, "new epic")}</p>
              <ul className="list-disc pl-5 text-ink">
                {plan.epics.map((e) => (
                  <li key={e.key}>{e.title}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <p className="font-semibold text-ink">{again ? "Slices on the map, in order" : `${plural(plan.slices.length, "draft slice")}, in this order`}</p>
            <ol className="list-decimal pl-5 text-ink">
              {plan.slices.map((s) => (
                <li key={s.key}>
                  {s.title} <span className="text-ink-muted">in {s.epic}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </ConfirmDialog>
    </div>
  );
}

/** The draft slices the map made, each with the way to its specification and to its answers from the PRD. */
function MadeBefore({ slices }: { slices: PrdMapSlice[] }) {
  const made = slices.filter((s): s is PrdMapSlice & { slice_id: string } => Boolean(s.slice_id));
  if (!made.length) return null;
  return (
    <ul aria-label="Draft slices made from this PRD" className="flex flex-col gap-2 border-t border-line pt-4 text-body-sm">
      {made.map((s) => (
        <li key={s.slice_id} className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <FileText aria-hidden="true" className="size-4 text-ink-subtle" />
          <ArtifactId>{s.slice_id}</ArtifactId>
          <span className="text-ink">{s.title}</span>
          <Link to={`/slices/${s.slice_id}`} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
            Open {s.slice_id}
          </Link>
          <Link to={`/slices/${s.slice_id}/prd`} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
            Its answers from the PRD
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** What the last apply made, what already existed, and what was removed since and not made again. */
function ApplyResult({ result }: { result: PrdApply }) {
  const made = [...result.made.epics, ...result.made.slices];
  const kept = [...result.kept.epics, ...result.kept.slices];
  return (
    <div role="status" className="flex flex-col gap-3 border-t border-line pt-4">
      <Banner tone={made.length ? "success" : "info"} title={made.length ? `Made ${made.join(", ")}` : "Nothing new was made"}>
        {result.note}
      </Banner>
      {kept.length ? (
        <p className="text-body-sm text-ink">
          Already there, so not made again: <span className="font-semibold">{kept.join(", ")}</span>.
        </p>
      ) : null}
      {result.missing.length ? (
        <p className="text-body-sm text-ink">
          Made before and since removed, so not made again: <span className="font-semibold">{result.missing.join(", ")}</span>.
        </p>
      ) : null}
      {result.made.slices.length ? (
        <ul className="flex flex-col gap-1 text-body-sm">
          {result.made.slices.map((id) => (
            <li key={id} className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <FileText aria-hidden="true" className="size-4 text-ink-subtle" />
              <ArtifactId>{id}</ArtifactId>
              <Link to={`/slices/${id}`} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
                Open {id}
              </Link>
              <Link to={`/slices/${id}/prd`} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
                Its answers from the PRD
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
