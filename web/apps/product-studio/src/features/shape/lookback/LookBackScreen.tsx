import { useEffect, useId, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { CircleAlert, History } from "lucide-react";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, Heading, Quote, RelativeTime, Skeleton, SkeletonText, StateGlyph, StatusPill, Text, describeError } from "@mach/ui";
import type { IdeaChain, IdeaRow, IdeaShow } from "@mach/ui/api";
import { reloadStatus } from "../../../api/store";
import { useOperation } from "../../../api/useOperation";
import { Part, Parts } from "../../../shared/layout/Parts";
import { OnePane, WorkPane, WorkPanes } from "../../../shared/layout/WorkScreen";
import { IdeaStepFrame } from "../shell/IdeaStepFrame";
import { ideaPath, nextPathOf, stepForNext, stepName } from "../shell/steps";
import { ChainLine } from "./ChainLine";
import { RecordItem, Recorded } from "./RecordItem";
import { chainLines, chainSummary, decisionWord, lookbackGate, lookbackItems, openOnArrival, progressWords, resultLook, type Gate, type LookbackItem } from "./model";

/**
 * Look back: the chain from why the idea was wanted to what shipped, one line per outcome, and the product manager's
 * record of each outcome (Met, Not met, Too early to say) and each assumption (Confirmed, Wrong, Still unknown) in their
 * own words. Data: idea.show (the record, `lookback`), idea.chain (read only), lookback.record (the act). The app shows
 * what the engine returns: it never infers a result and never fills in what the chain lists as missing.
 */
export function LookBackScreen() {
  const ideaId = useParams().ideaId ?? "";
  return (
    <IdeaStepFrame key={ideaId} ideaId={ideaId} step="look-back" layout="panes" lead="What shipped, followed back to why it was wanted, and what you saw once it was out.">
      {(row) => <LookBack row={row} />}
    </IdeaStepFrame>
  );
}

function LookBack({ row }: { row: IdeaRow }) {
  const ideaId = row.idea_id;
  const show = useOperation("idea.show", { idea_id: ideaId });
  const shaped = (show.data?.idea ?? row).stage === "shaped";
  const chain = useOperation("idea.chain", shaped ? { idea_id: ideaId } : null);
  const reload = () => {
    show.reload();
    chain.reload();
  };

  if (show.error || chain.error) {
    const error = (show.error ?? chain.error)!;
    const { title, message } = describeError(error);
    return (
      <OnePane label="Look back">
        <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={reload}>Try again</Button>} />
      </OnePane>
    );
  }
  if (!show.data || (shaped && !chain.data))
    return (
      <OnePane label="Look back">
        <Loading />
      </OnePane>
    );

  const idea = show.data.idea;
  const gate = lookbackGate(idea, show.data.acts.look_back);
  if (gate.kind === "decided-against")
    return (
      <OnePane label="Look back">
        <DecidedAgainst ideaId={ideaId} gate={gate} reason={show.data.verdict?.reason ?? null} />
      </OnePane>
    );
  if (gate.kind === "not-shaped")
    return (
      <OnePane label="Look back">
        <NotShaped row={idea} />
      </OnePane>
    );
  return (
    <Shaped
      show={show.data}
      chain={chain.data!}
      gate={gate}
      onRecorded={async () => {
        show.reload();
        chain.reload();
        await reloadStatus();
      }}
    />
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" role="status" aria-label="Reading the chain and the look back">
      <Skeleton className="h-6 w-72" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
      <SkeletonText lines={4} />
    </div>
  );
}

/** Decided Not now or No: nothing was made, so there is nothing to look back on. The decision stays with the idea. */
function DecidedAgainst({ ideaId, gate, reason }: { ideaId: string; gate: Extract<Gate, { kind: "decided-against" }>; reason: string | null }) {
  return (
    <div className="flex max-w-reading flex-col gap-5">
      <EmptyState
        icon={<History />}
        title="Nothing was made from this idea"
        description={`It was decided ${decisionWord(gate.decision)}, so no slice came from it and there is nothing to look back on. The decision and its reason stay with the idea.`}
        action={
          <Button asChild>
            <Link to={ideaPath(ideaId, "case")}>Go to the case and the verdict</Link>
          </Button>
        }
      />
      {reason ? (
        <Quote
          from="Product manager"
          kind={
            <>
              decided {decisionWord(gate.decision)}, <RelativeTime iso={gate.verdict.at} />
            </>
          }
        >
          {reason}
        </Quote>
      ) : null}
    </div>
  );
}

/** Still being shaped: the look back comes after work made from it has shipped. The engine's own next step leads on. */
function NotShaped({ row }: { row: IdeaRow }) {
  const step = stepForNext(row.next.kind, row.stage);
  return (
    <EmptyState
      icon={<History />}
      title="Not shaped into work yet"
      description={`A look back comes once slices made from this idea have shipped. Next: ${row.next.sentence}`}
      action={
        step === "look-back" ? undefined : (
          <Button asChild>
            <Link to={nextPathOf(row)}>Go to {stepName(step)}</Link>
          </Button>
        )
      }
    />
  );
}

/** The id of an item's part body, so its row can be found and given focus. */
const itemBodyId = (id: string) => `look-back-item-${id}`;
const partRow = (id: string) => document.getElementById(itemBodyId(id))?.closest("li")?.querySelector<HTMLElement>("button") ?? null;

/**
 * Laid out in two panes (M16 layout). The wide pane holds one part per outcome and per assumption, one open at a time:
 * each row says what serves the outcome and where it stands (the chain in a line) and the result recorded, as a word
 * and a shape. An open outcome shows its whole chain and the act. The narrow pane keeps what is already recorded in view.
 */
function Shaped({ show, chain, gate, onRecorded }: { show: IdeaShow; chain: IdeaChain; gate: Extract<Gate, { kind: "waiting" | "open" }>; onRecorded: () => Promise<void> }) {
  const lines = chainLines(chain);
  const items = lookbackItems(chain, show.lookback);
  const outcomes = items.filter((i) => i.kind === "outcome");
  const assumptions = items.filter((i) => i.kind === "assumption");
  const allowed = gate.kind === "open";

  const [open, setOpen] = useState<string | null>(() => openOnArrival(items, gate.kind));
  // When a record lands, the next item still to record opens and its row takes focus: the visible result of the act.
  const recordedKey = items
    .filter((i) => i.entry)
    .map((i) => `${i.id}:${i.entry?.at}`)
    .join(",");
  const [seenKey, setSeenKey] = useState(recordedKey);
  // A new object each time, so the same row can be asked for twice.
  const [focusRow, setFocusRow] = useState<{ id: string } | null>(null);
  if (seenKey !== recordedKey) {
    setSeenKey(recordedKey);
    const next = openOnArrival(items, gate.kind) ?? open;
    setOpen(next);
    setFocusRow(next ? { id: next } : null);
  }
  useEffect(() => {
    if (focusRow) partRow(focusRow.id)?.focus();
  }, [focusRow]);

  const part = (item: LookbackItem) => {
    const line = lines.find((l) => l.outcome.outcome === item.id);
    return (
      <Part
        key={item.id}
        id={item.id}
        name={
          <>
            <ArtifactId plain>{item.id}</ArtifactId> {item.text ?? "Its words are not in the brief as it is now"}
          </>
        }
        summary={item.kind === "outcome" && line ? chainSummary(line) : assumptionSummary(item)}
        status={<ResultPill item={item} />}
      >
        {/* The act first, with what the brief said would show it; then the whole chain, for reference. */}
        <div id={itemBodyId(item.id)} className="flex flex-col gap-5">
          {item.howWeWouldKnow ? (
            <Text size="body-sm" tone="muted" className="max-w-reading">
              <span className="font-semibold text-ink">How we would know:</span> {item.howWeWouldKnow}
            </Text>
          ) : null}
          <RecordItem ideaId={show.idea.idea_id} item={item} open={allowed} onRecorded={onRecorded} partRow={() => partRow(item.id)} />
          {line ? (
            <div className="flex flex-col gap-3">
              <h4 className="text-label text-ink">
                From <ArtifactId plain>{item.id}</ArtifactId> to what shipped
              </h4>
              <ChainLine line={line} label={`The chain for ${item.id}`} />
            </div>
          ) : null}
        </div>
      </Part>
    );
  };

  return (
    <WorkPanes>
      <WorkPane label="Outcomes and assumptions">
        <div className="flex flex-col gap-6">
          {!allowed ? (
            <Banner tone="info" title="Waiting for something made from this idea to ship">
              {gate.sentence} Where each slice stands is in each outcome&apos;s row.
            </Banner>
          ) : null}
          {chain.missing.length ? (
            <Banner tone="warning" title="Part of the chain is missing">
              {chain.missing.map((m) => (
                <span key={m} className="block">
                  {m.charAt(0).toUpperCase() + m.slice(1)}.
                </span>
              ))}
            </Banner>
          ) : null}
          <ItemGroup title="Outcomes" empty={lines.length === 0 ? "The brief has no outcome to follow, so there is no line to show." : "The brief has no outcome."} count={outcomes.length}>
            <Parts label="Outcomes" headingLevel={3} open={open} onOpenChange={setOpen}>
              {outcomes.map(part)}
            </Parts>
          </ItemGroup>
          <ItemGroup title="Assumptions" empty="The brief lists no assumption." count={assumptions.length}>
            <Parts label="Assumptions" headingLevel={3} open={open} onOpenChange={setOpen}>
              {assumptions.map(part)}
            </Parts>
          </ItemGroup>
        </div>
      </WorkPane>
      <WorkPane side label="What is already recorded">
        <AlreadyRecorded show={show} chain={chain} items={items} allowed={allowed} />
      </WorkPane>
    </WorkPanes>
  );
}

/** An assumption's row: whether it is recorded yet, and when. The result itself is the row's pill. */
function assumptionSummary(item: LookbackItem): ReactNode {
  if (!item.entry) return "Nothing recorded on it yet";
  return (
    <>
      Recorded <RelativeTime iso={item.entry.at} />
    </>
  );
}

/** The result recorded, as a word and a shape; every result looks alike, so none reads as the hoped-for one. */
function ResultPill({ item }: { item: LookbackItem }) {
  if (!item.entry)
    return (
      <StatusPill tone="neutral" icon={<StateGlyph shape="open" />} className="border-dashed">
        Not recorded yet
      </StatusPill>
    );
  const look = resultLook(item.entry.result);
  return (
    <StatusPill tone="neutral" icon={<StateGlyph shape={look.glyph} />}>
      {look.word}
    </StatusPill>
  );
}

/** Beside the parts: how far the look back has come, where it is kept, each result recorded with its note, and where the chain was read from. */
function AlreadyRecorded({ show, chain, items, allowed }: { show: IdeaShow; chain: IdeaChain; items: LookbackItem[]; allowed: boolean }) {
  const github = show.idea.github;
  const recorded = items.filter((i) => i.entry);
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="look-back-saw" className="flex flex-col gap-3">
        <Heading level={2} size="title-3" id="look-back-saw">
          What you saw so far
        </Heading>
        <p className="text-body-sm font-semibold text-ink">{progressWords(items)}</p>
        {allowed ? (
          <Text size="body-sm" tone="muted">
            Record each outcome and each assumption in your own words, one at a time. These are your judgements: MACH never proposes a result.{" "}
            {github.saved === "github" && github.issue !== null
              ? `Each one is also posted on the idea's issue #${github.issue} when this computer is signed in to GitHub.`
              : "The idea is not saved on GitHub, so each one is kept on this computer."}
          </Text>
        ) : null}
        {recorded.length ? (
          <ul className="flex flex-col gap-4 border-t border-line pt-4">
            {recorded.map((item) => (
              <li key={item.id}>
                <Recorded id={item.id} entry={item.entry!} github={github} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-body-sm text-ink-muted">
            <StateGlyph shape="open" />
            Nothing recorded yet
          </p>
        )}
      </section>

      <section aria-labelledby="look-back-chain" className="flex flex-col gap-2 border-t border-line pt-4">
        <Heading level={2} size="title-3" id="look-back-chain">
          Where the chain was read from
        </Heading>
        <Text size="body-sm" tone="muted">
          Where each slice stands is as{" "}
          {chain.last_read ? (
            <>
              the last check of GitHub saw it, <RelativeTime iso={chain.last_read} />.
            </>
          ) : (
            "this workspace records it: GitHub has not been read from this computer yet."
          )}{" "}
          {chain.note}
        </Text>
        {chain.made ? (
          <Text size="body-sm" tone="muted">
            Made from this idea: {chain.made.epics.length ? <IdList ids={chain.made.epics} kind="epic" /> : "no new epic"} and{" "}
            {chain.made.slices.length ? <IdList ids={chain.made.slices} kind="slice" /> : "no slice"}.
          </Text>
        ) : null}
      </section>
    </div>
  );
}

function ItemGroup({ title, empty, count, children }: { title: string; empty: string; count: number; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <Heading level={2} size="title-3" id={id}>
        {title}
      </Heading>
      {count ? (
        children
      ) : (
        <p className="flex items-center gap-2 border-t border-line py-4 text-body-sm text-ink-muted">
          <StateGlyph shape="open" />
          {empty}
        </p>
      )}
    </section>
  );
}

function IdList({ ids, kind }: { ids: string[]; kind: "epic" | "slice" }) {
  return (
    <>
      {ids.map((id, index) => (
        <span key={id}>
          {index ? ", " : ""}
          <Link
            to={kind === "slice" ? `/slices/${encodeURIComponent(id)}` : `/epics/${encodeURIComponent(id)}/today`}
            className="rounded-xs font-semibold text-accent-ink underline-offset-2 hover:underline"
          >
            <ArtifactId plain>{id}</ArtifactId>
          </Link>
        </span>
      ))}
    </>
  );
}
