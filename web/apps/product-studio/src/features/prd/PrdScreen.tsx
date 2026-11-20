import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { CircleAlert, FileText, Map as MapIcon } from "lucide-react";
import {
  ArtifactId,
  Banner,
  Button,
  ConfirmDialog,
  Disclosure,
  EmptyState,
  ErrorState,
  Heading,
  LoadingState,
  SliceStatusPill,
  Text,
  describeError,
  plural,
  toast,
} from "@mach/ui";
import type { PrdApply, PrdCoverageRow, PrdMapSlice, PrdStatus } from "@mach/ui/api";
import { useEngineAct } from "../../api/act";
import { useStatus } from "../../api/store";
import { useOperation } from "../../api/useOperation";
import { ScreenFrame } from "../../shared/ScreenFrame";
import { applyPlan, coverageProgress, coverageWords, fencedLines, journeyStep, quote } from "./model";
import { CoveragePill, DataNotice, PrdJourney, PrdQuote, linesLabel } from "./parts";
import { SettleDialog } from "./SettleDialog";

/**
 * One PRD: where it is on the path, its map of epics and thin slices with the lines each rests on,
 * the coverage of every section (the product manager settles each one no slice cites), and making
 * the drafts. Reads `prd.status` and `prd.show`; acts `prd.settle` and `prd.apply`, each confirmed.
 */
export function PrdScreen() {
  const prdId = useParams().prdId ?? "";
  const status = useOperation("prd.status", { prd_id: prdId });
  const show = useOperation("prd.show", { prd_id: prdId });

  if (!status.data && status.loading) {
    return (
      <ScreenFrame title={prdId}>
        <LoadingState label={`Reading ${prdId}`} />
      </ScreenFrame>
    );
  }
  if (!status.data) {
    const shown = status.error ? describeError(status.error) : { title: "Not available right now", message: "" };
    return (
      <ScreenFrame title={prdId}>
        <ErrorState
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
      </ScreenFrame>
    );
  }
  return <PrdPage data={status.data} lines={fencedLines(show.data?.fenced)} truncated={show.data?.truncated ?? false} fenced={show.data?.fenced ?? null} reload={status.reload} />;
}

function PrdPage({ data, lines, truncated, fenced, reload }: { data: PrdStatus; lines: Map<number, string> | null; truncated: boolean; fenced: string | null; reload: () => void }) {
  const prd = data.prd;
  const step = journeyStep(data);
  const [settling, setSettling] = useState<PrdCoverageRow | null>(null);
  const map = data.map;

  return (
    <ScreenFrame
      title={
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span>{prd.name}</span>
          <ArtifactId className="text-body">{prd.prd_id}</ArtifactId>
        </span>
      }
      lead={`${prd.format === "markdown" ? "Markdown" : "Plain text"} · ${plural(prd.sections, "section")} · ${plural(prd.line_count, "line")}. How its sections map to epics and slices, and what is left to settle.`}
    >
      <PrdJourney step={step} />
      <DataNotice />
      {!prd.document_matches ? (
        <Banner tone="danger" title="The copy in your workspace changed">
          It no longer matches the document that was imported, so nothing is shown or made from it. Import the document again from Start from a PRD.
        </Banner>
      ) : null}
      {map ? (
        <>
          <CoverageSection data={data} lines={lines} onSettle={setSettling} />
          <MapSection prdId={prd.prd_id} map={map} lines={lines} />
          <ApplySection data={data} onDone={reload} />
        </>
      ) : (
        <NoMap data={data} />
      )}
      {fenced && lines ? (
        <Disclosure summary="Read the document" className="max-w-reading">
          <div className="flex flex-col gap-2">
            <p className="text-body-sm text-ink-muted">The document's words, as data. {truncated ? "Long documents are cut; this shows the first part." : null}</p>
            <PrdQuote prdId={prd.prd_id} quotations={quote(lines, `1-${Math.max(...lines.keys(), 1)}`)} />
          </div>
        </Disclosure>
      ) : null}
      {map ? (
        <SettleDialog
          prdId={prd.prd_id}
          section={settling}
          quotations={settling ? quote(lines, settling.lines) : []}
          slices={map.slices}
          onOpenChange={(open) => (open ? undefined : setSettling(null))}
          onDone={reload}
        />
      ) : null}
    </ScreenFrame>
  );
}

/** Before a map: what the map is, how to get one, and the document's sections. */
function NoMap({ data }: { data: PrdStatus }) {
  return (
    <section aria-labelledby="map-heading" className="flex max-w-reading flex-col gap-4">
      <Heading level={2} id="map-heading">
        The map
      </Heading>
      <EmptyState
        icon={<MapIcon />}
        headingLevel={3}
        title="No map yet"
        description={
          <>
            The map of epics and thin slices is proposed in a conversation in Claude Code, not on this page. Ask the product studio skill there to propose a map for{" "}
            {data.prd.prd_id}; it reads the document, proposes the slices with the lines each rests on, and records the map once you agree. This page then shows it, with
            every section no slice covers.
          </>
        }
      />
      {data.sections?.length ? (
        <div className="flex flex-col gap-2">
          <Heading level={3}>The document's sections</Heading>
          <ol className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {data.sections.map((s) => (
              <li key={s.n} className="flex items-baseline gap-4 px-4 py-2.5 text-body-sm">
                <span className="w-6 shrink-0 text-right text-ink-subtle tabular">{s.n}</span>
                <span className="min-w-0 flex-1 text-ink">{s.title}</span>
                <span className="shrink-0 text-ink-muted tabular">{linesLabel(s.lines)}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Coverage, the heart of the page: every section and what covers it. Sections no slice cites are
 * settled one by one; settled of total is a real fraction, and nothing is made while any is open.
 */
function CoverageSection({ data, lines, onSettle }: { data: PrdStatus; lines: Map<number, string> | null; onSettle: (row: PrdCoverageRow) => void }) {
  const rows = data.coverage ?? [];
  const progress = coverageProgress(rows);
  const applied = data.map?.applied ?? false;
  const slices = data.map?.slices ?? [];

  return (
    <section aria-labelledby="coverage-heading" className="flex max-w-reading flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Heading level={2} id="coverage-heading">
          Coverage
        </Heading>
        <Text tone="muted">
          Each section of the document, and what covers it. A section no slice cites needs your word: part of a slice, out of scope, or later.
        </Text>
      </div>
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
        </div>
      ) : (
        <p className="text-body-sm text-ink-muted">Every section is cited by a slice on the map, so there is nothing to settle.</p>
      )}
      <ol aria-label="Sections of the document" className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
        {rows.map((row) => (
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
              {row.state === "not_covered" && !applied ? (
                <Button size="sm" onClick={() => onSettle(row)} aria-label={`Settle section ${row.n}, ${row.title}`}>
                  Settle section {row.n}
                </Button>
              ) : null}
            </div>
            {row.settled?.reason ? (
              <p className="pl-10 text-body-sm text-ink-muted">
                Your reason: <span className="text-ink">{row.settled.reason}</span>
              </p>
            ) : null}
            {row.state === "not_covered" && lines ? (
              <Disclosure summary={`Read section ${row.n}`} className="ml-10 bg-surface">
                <PrdQuote prdId={data.prd.prd_id} quotations={quote(lines, row.lines)} />
              </Disclosure>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The proposed epics and thin slices, in the order the builders take them, each with the lines it rests on. */
function MapSection({ prdId, map, lines }: { prdId: string; map: NonNullable<PrdStatus["map"]>; lines: Map<number, string> | null }) {
  const status = useStatus();
  const epicTitle = (id: string) => status.data?.epics.find((e) => e.epic_id === id)?.title ?? null;
  const newEpics = new Map(map.epics.map((e) => [e.key, e.title]));
  const keyTitle = new Map(map.slices.map((s) => [s.key, s.title]));
  const epicName = (epic: string) => newEpics.get(epic) ?? epicTitle(epic) ?? epic;

  return (
    <section aria-labelledby="map-heading" className="flex max-w-reading flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Heading level={2} id="map-heading">
          The map
        </Heading>
        <Text tone="muted">
          {map.applied
            ? "What was proposed and made from this PRD. The map is kept as it was when the drafts were made."
            : "Proposed in Claude Code and recorded there. To change it, ask for a new map there; until the drafts are made, a new map replaces this one."}
        </Text>
      </div>
      {map.epics.length ? (
        <div className="flex flex-col gap-2">
          <Heading level={3}>{map.applied ? "Epics it proposed" : "New epics"}</Heading>
          <ul className="flex flex-col gap-3">
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
    </section>
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
  return (
    <li className="flex flex-col gap-3 rounded-md border border-line bg-surface px-5 py-4">
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
      <PrdQuote prdId={prdId} quotations={quote(lines, slice.cites)} className="pl-9" />
      {!lines ? <p className="pl-9 text-body-sm text-ink-muted">Cites {slice.cites}.</p> : null}
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
function ApplySection({ data, onDone }: { data: PrdStatus; onDone: () => void }) {
  const status = useStatus();
  const act = useEngineAct();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<PrdApply | null>(null);
  const map = data.map!;
  const plan = useMemo(() => applyPlan(map, (id) => status.data?.epics.find((e) => e.epic_id === id)?.title ?? null), [map, status.data]);
  const left = data.not_covered ?? [];
  const again = map.applied;
  const what = [plan.epics.length ? plural(plan.epics.length, "epic") : null, plural(plan.slices.length, "draft slice")].filter(Boolean).join(" and ");

  const confirm = async () => {
    const applied = await act.run("prd.apply", { prd_id: data.prd.prd_id });
    if (!applied) return false;
    setResult(applied);
    toast({ tone: "success", title: applied.made.slices.length || applied.made.epics.length ? `Made the drafts from ${data.prd.prd_id}` : "Nothing new to make", description: applied.note });
    onDone();
    return true;
  };

  return (
    <section aria-labelledby="apply-heading" className="flex max-w-reading flex-col gap-4 rounded-md border border-line bg-surface px-6 py-5">
      <div className="flex flex-col gap-1">
        <Heading level={2} id="apply-heading" size="title-3">
          Make the drafts
        </Heading>
        <Text size="body-sm" tone="muted">
          {again
            ? `The drafts were made: ${plural((data.prd.applied ?? []).length, "draft slice")}. Running it again makes nothing twice; it only makes what is missing and says what already exists.`
            : `Adds ${what} to your workspace as drafts, in the map's order. Nothing is approved, sent or started, and nothing goes to GitHub.`}
        </Text>
      </div>
      {left.length && !again ? (
        <p className="text-body-sm text-ink" id="apply-blocked">
          Settle {left.length === 1 ? `section ${left[0]}` : `sections ${left.join(", ")}`} first. Nothing can be made while any section is unsettled.
        </p>
      ) : null}
      <div>
        <Button
          variant={again ? "secondary" : "primary"}
          disabled={left.length > 0 && !again}
          aria-describedby={left.length && !again ? "apply-blocked" : undefined}
          onClick={() => {
            act.reset();
            setOpen(true);
          }}
        >
          {again ? "Make the drafts again" : `Make ${what}`}
        </Button>
      </div>
      {result ? <ApplyResult result={result} /> : null}
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
    </section>
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
