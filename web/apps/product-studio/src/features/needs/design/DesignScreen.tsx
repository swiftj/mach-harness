import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { CircleAlert, MessagesSquare } from "lucide-react";
import { ArtifactId, Button, CommandLine, ErrorState, Heading, LoadingState, RelativeTime, Text, describeError } from "@mach/ui";
import type { DesignShow } from "@mach/ui/api";
import { loadSession } from "../../../api/session";
import { quote } from "../../../shared/lineRanges";
import { Fold } from "../../../shared/layout/Fold";
import { Part, Parts } from "../../../shared/layout/Parts";
import { ContextRow, OnePane, WorkPane, WorkPanes, WorkScreen } from "../../../shared/layout/WorkScreen";
import { DESIGNS_LABEL, DESIGNS_PATH, NEEDS_LABEL, NEEDS_PATH } from "../shell/paths";
import { useDesignShow } from "../shell/useNeeds";
import { ConflictsSection } from "./ConflictsSection";
import {
  appliesWords,
  designFacts,
  designLines,
  designPartPlace,
  linesWords,
  partForDesign,
  publishSummary,
  rangesText,
  readSummary,
  settleSummary,
  topicCounts,
  topicRows,
  type TopicRow,
} from "./model";
import { DesignDataNotice, DesignQuote, StagePill, TopicPill, WritingNotice } from "./parts";
import { PublishSection } from "./PublishSection";
import { useNeedsWriting } from "./useNeedsWriting";

const about =
  "What the document decides on each topic the engineers must decide, with the lines it cites; the places where it contradicts what you already said, for you to settle; and publishing it so the engineers' decisions can start from it.";

/**
 * One design you already have (M17 part D), in two panes (M16 layout). The wide pane is the path as three parts, one
 * open at a time: what MACH read in it (each required topic as decided, partly decided or silent, with the lines
 * cited, then the decisions outside those topics), settling the conflicts, and publishing it. The narrow pane keeps
 * where it stands and the document itself, numbered, as data. Reads `design.show`; acts `design.settle` and
 * `design.publish`, each confirmed. The document is read by the needs conversation on Technical needs, never here.
 * No act on an engineer's decision is shown or offered.
 */
export function DesignScreen() {
  const { designId = "" } = useParams();
  const shown = useDesignShow(designId);
  const writing = useNeedsWriting(shown.reload);

  if (!shown.valid) {
    return (
      <Frame designId={null} title={DESIGNS_LABEL}>
        <OnePane label={DESIGNS_LABEL}>
          <ErrorState
            className="max-w-reading"
            icon={<CircleAlert />}
            title="Not a design"
            message={`"${designId}" is not a design's ID, such as DES-01.`}
            action={<AllDesigns />}
          />
        </OnePane>
      </Frame>
    );
  }
  if (!shown.data && shown.error) {
    const error = describeError(shown.error);
    return (
      <Frame designId={designId} title={designId}>
        <OnePane label={designId}>
          <ErrorState
            className="max-w-reading"
            icon={<CircleAlert />}
            title={shown.error.kind === "refused" ? `${designId} is not shown` : error.title}
            message={error.message}
            hint={error.hint}
            action={
              <>
                <Button onClick={shown.reload}>Try again</Button>
                <AllDesigns />
              </>
            }
          />
        </OnePane>
      </Frame>
    );
  }
  if (!shown.data) {
    return (
      <Frame designId={designId} title={designId}>
        <OnePane label={designId}>
          <LoadingState label={`Reading ${designId}`} />
        </OnePane>
      </Frame>
    );
  }
  return (
    <Frame designId={shown.data.design.design_id} title={shown.data.design.name ?? shown.data.design.design_id}>
      <DesignPage show={shown.data} writing={writing} reload={shown.reload} />
    </Frame>
  );
}

function AllDesigns() {
  return (
    <Button asChild variant="ghost">
      <Link to={DESIGNS_PATH}>All designs</Link>
    </Button>
  );
}

/** The slim context row: the design's ID, its file name as the page's h1, and what the page is for behind "About this page". */
function Frame({ designId, title, children }: { designId: string | null; title: string; children: ReactNode }) {
  return <WorkScreen header={<ContextRow identity={designId ? <ArtifactId plain>{designId}</ArtifactId> : undefined} title={title} about={about} />}>{children}</WorkScreen>;
}

function DesignPage({ show, writing, reload }: { show: DesignShow; writing: boolean; reload: () => void }) {
  const designId = show.design.design_id;
  const lines = useMemo(() => designLines(show.fenced), [show.fenced]);
  const part = partForDesign(show);
  const [open, setOpen] = useState<string | null>(part);
  const [seenPart, setSeenPart] = useState(part);
  // When an act or a new reading moves the path on (the last conflict settled, the map recorded), the part that now needs the person opens.
  if (seenPart !== part) {
    setSeenPart(part);
    setOpen(part);
  }
  const map = show.map;

  return (
    <WorkPanes>
      <WorkPane label={`${designId}, from reading to publishing`}>
        <div className="flex flex-col gap-6">
          {writing ? <WritingNotice /> : null}
          <Parts label={`Bringing in ${designId}`} open={open} onOpenChange={setOpen}>
            <Part id="read" number={1} place={designPartPlace("read", show)} name="What it decides" summary={readSummary(show)}>
              {map ? <ReadBody show={show} lines={lines} /> : <NotRead show={show} />}
            </Part>
            <Part id="settle" number={2} place={designPartPlace("settle", show)} name="Settle the conflicts" summary={settleSummary(show)}>
              {map ? <ConflictsSection designId={designId} map={map} lines={lines} writing={writing} onSettled={reload} /> : undefined}
            </Part>
            <Part id="publish" number={3} place={designPartPlace("publish", show)} name="Publish" summary={publishSummary(designId, show)}>
              {map ? <PublishSection show={show} writing={writing} onPublished={reload} /> : undefined}
            </Part>
          </Parts>
        </div>
      </WorkPane>
      <WorkPane side label={`${designId} and where it stands`}>
        <DocumentAside show={show} lines={lines} />
      </WorkPane>
    </WorkPanes>
  );
}

/**
 * Before the document is read: how it gets read (the conversation on Technical needs, or the same conversation in
 * Claude Code), and the topics it will be read for. This page has no conversation of its own: one conversation reads
 * the needs and the designs, on Technical needs.
 */
function NotRead({ show }: { show: DesignShow }) {
  const designId = show.design.design_id;
  const [command, setCommand] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadSession().then(
      (session) => {
        const found = session.capabilities.needs_command;
        if (!cancelled) setCommand(typeof found === "string" && found.trim() ? found : null);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="flex max-w-reading flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Text size="body-sm">
          MACH reads {designId} in the conversation on {NEEDS_LABEL}, not on this page. Ask it there to read {designId}: it says, for each topic below, what the
          document decides and the lines it cites, and names each place where the document contradicts what you already said. It decides nothing; this page then
          shows what it read.
        </Text>
        <div>
          <Button asChild variant="secondary">
            <Link to={NEEDS_PATH}>
              <MessagesSquare aria-hidden="true" />
              Go to {NEEDS_LABEL}
            </Link>
          </Button>
        </div>
        {command ? (
          <div className="flex flex-col gap-1.5">
            <Text size="body-sm" tone="muted">
              Or have the same conversation in Claude Code:
            </Text>
            <CommandLine command={command} purpose="to talk about your technical needs and designs in Claude Code" />
          </div>
        ) : null}
      </div>
      <TopicList rows={topicRows(show)} designId={designId} lines={null} />
    </div>
  );
}

/** What the document decides: the required topics in the engine's order, then its decisions outside them. */
function ReadBody({ show, lines }: { show: DesignShow; lines: Map<number, string> | null }) {
  const designId = show.design.design_id;
  const other = show.map?.other ?? [];
  return (
    <div className="flex max-w-[48rem] flex-col gap-6">
      <TopicList rows={topicRows(show)} designId={designId} lines={lines} />
      {other.length ? (
        <section aria-labelledby="design-other" className="flex flex-col gap-2">
          <Heading level={3} id="design-other">
            Other decisions in the document
          </Heading>
          <Text size="body-sm" tone="muted">
            Decisions it makes outside the topics above. The engineers read them too.
          </Text>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {other.map((item) => {
              const quotations = quote(lines, rangesText(item.lines));
              return (
                <li key={`${rangesText(item.lines)} ${item.summary}`} className="flex flex-col gap-1.5 px-4 py-3">
                  <p className="text-body text-ink">{item.summary}</p>
                  <p className="text-body-sm text-ink-muted">About {appliesWords(item.applies_to)}</p>
                  {quotations.length ? (
                    <Fold label={`Cites ${linesWords(item.lines)}`}>
                      <DesignQuote designId={designId} quotations={quotations} />
                    </Fold>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <Text size="body-sm" tone="muted">
        Read in the conversation on {NEEDS_LABEL}. To have it read again, ask there; your word on a conflict it finds again is kept.
      </Text>
    </div>
  );
}

function TopicList({ rows, designId, lines }: { rows: TopicRow[]; designId: string; lines: Map<number, string> | null }) {
  return (
    <section aria-labelledby="design-topics" className="flex flex-col gap-2">
      <Heading level={3} id="design-topics">
        What the engineers must decide
      </Heading>
      <Text size="body-sm" tone="muted" className="max-w-reading">
        For each topic, what the document decides. It covers none of them by itself: the engineers still make each decision, starting from it.
      </Text>
      <ol className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
        {rows.map((row) => (
          <TopicItem key={row.topic} row={row} designId={designId} lines={lines} />
        ))}
      </ol>
    </section>
  );
}

function TopicItem({ row, designId, lines }: { row: TopicRow; designId: string; lines: Map<number, string> | null }) {
  const quotations = lines ? quote(lines, rangesText(row.lines)) : [];
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-body font-semibold text-ink">{row.name}</span>
        {row.state ? <TopicPill state={row.state} /> : null}
      </div>
      {row.summary ? <p className="text-body text-ink">{row.summary}</p> : null}
      {row.missing ? (
        <p className="text-body-sm text-ink">
          <span className="text-ink-muted">What it leaves out: </span>
          {row.missing}
        </p>
      ) : null}
      {row.state === "silent" ? <p className="text-body-sm text-ink-muted">The document says nothing on it.</p> : null}
      {row.means ? <p className="text-body-sm text-ink-muted">{row.means}</p> : null}
      {quotations.length ? (
        <Fold label={`Cites ${linesWords(row.lines)}`}>
          <DesignQuote designId={designId} quotations={quotations} />
        </Fold>
      ) : null}
    </li>
  );
}

/** The narrow pane: where the design stands and its counts, then the document itself, numbered, as data. */
function DocumentAside({ show, lines }: { show: DesignShow; lines: Map<number, string> | null }) {
  const design = show.design;
  const map = show.map;
  const counts = map ? topicCounts(map.topics) : null;
  const settled = map ? map.conflicts.length - map.unsettled.length : 0;
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="design-aside-stands" className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Heading level={2} size="title-3" id="design-aside-stands">
            Where it stands
          </Heading>
          <div>
            <StagePill design={design} />
          </div>
          <Text size="body-sm" tone="muted">
            {designFacts(design)}.
            {map?.published ? (
              <>
                {" "}
                Published <RelativeTime iso={map.published.at} />.
              </>
            ) : null}
          </Text>
        </div>
        {counts && map ? (
          <dl className="grid grid-cols-2 gap-2">
            {[
              { label: "Topics decided", value: `${counts.decided}` },
              { label: "Partly decided", value: `${counts.partly}` },
              { label: "Silent", value: `${counts.silent}` },
              { label: "Other decisions", value: `${map.other.length}` },
              { label: "Conflicts settled", value: map.conflicts.length ? `${settled} of ${map.conflicts.length}` : "none" },
            ].map((r) => (
              <div key={r.label} className="flex min-w-0 flex-col gap-0.5 rounded-sm bg-surface-sunken px-2.5 py-2">
                <dt className="text-caption text-ink-muted">{r.label}</dt>
                <dd className="text-title-3 font-semibold text-ink tabular">{r.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>
      <section aria-labelledby="design-aside-document" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Heading level={2} size="title-3" id="design-aside-document">
            The document as written
          </Heading>
          <Text size="body-sm" tone="muted">
            Numbered as MACH cites it{show.truncated ? `; long documents are cut, so this shows lines ${show.lines}` : ""}.
          </Text>
        </div>
        {lines ? (
          <ol aria-label={`${design.design_id}, as written in the design`} className="flex flex-col rounded-sm border-l-2 border-line-strong bg-surface-sunken py-2 pl-2 pr-3 text-body-sm text-ink">
            {[...lines.entries()].map(([n, text]) => (
              <li key={n} className="flex gap-3">
                <span className="w-7 shrink-0 select-none text-right text-caption leading-6 text-ink-subtle tabular" aria-hidden="true">
                  {n}
                </span>
                <span className="min-w-0 whitespace-pre-wrap break-words">{text || " "}</span>
              </li>
            ))}
          </ol>
        ) : (
          <Text size="body-sm" tone="muted">
            The document's text could not be shown.
          </Text>
        )}
      </section>
      <DesignDataNotice />
    </div>
  );
}
