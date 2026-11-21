import { useId, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { CircleAlert, History } from "lucide-react";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, Heading, Quote, RelativeTime, Skeleton, SkeletonText, StateGlyph, Text, describeError } from "@mach/ui";
import type { IdeaChain, IdeaRow, IdeaShow } from "@mach/ui/api";
import { reloadStatus } from "../../../api/store";
import { useOperation } from "../../../api/useOperation";
import { IdeaStepFrame } from "../shell/IdeaStepFrame";
import { ideaPath, nextPathOf, stepForNext, stepName } from "../shell/steps";
import { ChainLine } from "./ChainLine";
import { RecordItem } from "./RecordItem";
import { chainLines, decisionWord, lookbackGate, lookbackItems, progressWords, type Gate } from "./model";

/**
 * Look back: the chain from why the idea was wanted to what shipped, one line per outcome, and the product manager's
 * record of each outcome (Met, Not met, Too early to say) and each assumption (Confirmed, Wrong, Still unknown) in their
 * own words. Data: idea.show (the record, `lookback`), idea.chain (read only), lookback.record (the act). The app shows
 * what the engine returns: it never infers a result and never fills in what the chain lists as missing.
 */
export function LookBackScreen() {
  const ideaId = useParams().ideaId ?? "";
  return (
    <IdeaStepFrame key={ideaId} ideaId={ideaId} step="look-back" lead="What shipped, followed back to why it was wanted, and what you saw once it was out.">
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
    return <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={reload}>Try again</Button>} />;
  }
  if (!show.data || (shaped && !chain.data)) return <Loading />;

  const idea = show.data.idea;
  const gate = lookbackGate(idea, show.data.acts.look_back);
  if (gate.kind === "decided-against") return <DecidedAgainst ideaId={ideaId} gate={gate} reason={show.data.verdict?.reason ?? null} />;
  if (gate.kind === "not-shaped") return <NotShaped row={idea} />;
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

function Shaped({ show, chain, gate, onRecorded }: { show: IdeaShow; chain: IdeaChain; gate: Extract<Gate, { kind: "waiting" | "open" }>; onRecorded: () => Promise<void> }) {
  const chainHeading = useId();
  const recordHeading = useId();
  const lines = chainLines(chain);
  const items = lookbackItems(chain, show.lookback);
  const outcomes = items.filter((i) => i.kind === "outcome");
  const assumptions = items.filter((i) => i.kind === "assumption");
  const github = show.idea.github;
  const open = gate.kind === "open";

  return (
    <div className="flex flex-col gap-12">
      <section aria-labelledby={chainHeading} className="flex flex-col gap-5">
        <div className="flex max-w-reading flex-col gap-1.5">
          <Heading level={2} id={chainHeading}>
            From why it was wanted to what shipped
          </Heading>
          <Text size="body-sm" tone="muted">
            One line for each outcome of the brief. Where each slice stands is as{" "}
            {chain.last_read ? (
              <>
                the last check of GitHub saw it, <RelativeTime iso={chain.last_read} />.
              </>
            ) : (
              "this workspace records it: GitHub has not been read from this computer yet."
            )}{" "}
            {chain.note}
          </Text>
        </div>
        {chain.missing.length ? (
          <Banner tone="warning" title="Part of the chain is missing">
            {chain.missing.map((m) => (
              <span key={m} className="block">
                {m.charAt(0).toUpperCase() + m.slice(1)}.
              </span>
            ))}
          </Banner>
        ) : null}
        {lines.length === 0 ? (
          <Text tone="muted">The brief has no outcome to follow, so there is no line to show.</Text>
        ) : (
          <div className="flex flex-col gap-8">
            {lines.map((line) => (
              <div key={line.outcome.outcome} className="flex flex-col gap-3">
                <Heading level={3} size="title-3">
                  The chain for <ArtifactId plain>{line.outcome.outcome}</ArtifactId>
                </Heading>
                <ChainLine line={line} label={`The chain for ${line.outcome.outcome}`} />
              </div>
            ))}
          </div>
        )}
        {chain.made ? (
          <Text size="body-sm" tone="muted">
            Made from this idea: {chain.made.epics.length ? <IdList ids={chain.made.epics} kind="epic" /> : "no new epic"} and{" "}
            {chain.made.slices.length ? <IdList ids={chain.made.slices} kind="slice" /> : "no slice"}.
          </Text>
        ) : null}
      </section>

      <section aria-labelledby={recordHeading} className="flex flex-col gap-4">
        <div className="flex max-w-reading flex-col gap-1.5">
          <Heading level={2} id={recordHeading}>
            What you saw
          </Heading>
          {open ? (
            <>
              <Text>
                Record each outcome and each assumption in your own words, one at a time. These are your judgements: MACH never proposes a result.
              </Text>
              <Text size="body-sm" tone="muted" className="flex flex-wrap items-center gap-x-2">
                <span className="font-semibold text-ink">{progressWords(items)}</span>
                <span>
                  {github.saved === "github" && github.issue !== null
                    ? `Each one is also posted on the idea's issue #${github.issue} when this computer is signed in to GitHub.`
                    : "The idea is not saved on GitHub, so each one is kept on this computer."}
                </span>
              </Text>
            </>
          ) : null}
        </div>
        {!open ? (
          <Banner tone="info" title="Waiting for something made from this idea to ship">
            {gate.sentence} Where each slice stands is shown in the chain above.
          </Banner>
        ) : null}
        <ItemGroup title="Outcomes" empty="The brief has no outcome.">
          {outcomes.map((item) => (
            <RecordItem key={item.id} ideaId={show.idea.idea_id} item={item} open={open} github={github} onRecorded={onRecorded} />
          ))}
        </ItemGroup>
        <ItemGroup title="Assumptions" empty="The brief lists no assumption.">
          {assumptions.map((item) => (
            <RecordItem key={item.id} ideaId={show.idea.idea_id} item={item} open={open} github={github} onRecorded={onRecorded} />
          ))}
        </ItemGroup>
      </section>
    </div>
  );
}

function ItemGroup({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col">
      <Heading level={3} size="title-3" id={id} className="pb-1">
        {title}
      </Heading>
      {children.length ? (
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
