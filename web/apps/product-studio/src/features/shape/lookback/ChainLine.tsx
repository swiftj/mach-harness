import { useId, type ReactNode } from "react";
import { Link } from "react-router";
import { ArtifactId, RelativeTime, StateGlyph, cn, type GlyphShape } from "@mach/ui";
import type { IdeaChain } from "@mach/ui/api";
import { IssueLink } from "../../../shared/IssueLink";
import { progressLook, resultLook, settledWords, type ChainLine as Line } from "./model";

/**
 * One outcome's line, left to right: the outcome and how we would know, each slice that serves it, its requirements
 * and scenarios by ID, where it stands, its epic's acceptance, and the look back. A table, so each link keeps its
 * column's name for a screen reader; drawn as one line with a node per link. Where several slices serve the outcome the
 * line forks, one row per slice. A link the engine lists as missing is a dashed ring with the word "Missing" and the
 * engine's reason, and the rule leading to it is dashed: never filled in, never a zero.
 */
export function ChainLine({ line, label }: { line: Line; label: string }) {
  const captionId = useId();
  const { outcome, slices, missing } = line;
  const rows = slices.length || 1;
  return (
    <div className="flex flex-col gap-2">
      <div
        role="region"
        aria-labelledby={captionId}
        // Reachable by keyboard so the line can be scrolled sideways when the window is narrow.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="overflow-x-auto rounded-md pb-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <table className="w-full min-w-[52rem] table-fixed border-separate border-spacing-0 text-left">
          <caption id={captionId} className="sr-only">
            {label}, from the outcome to the look back, left to right
          </caption>
          <colgroup>
            <col className="w-[16%]" />
            <col className="w-[15%]" />
            <col className="w-[19%]" />
            <col className="w-[13%]" />
            <col className="w-[22%]" />
            <col className="w-[15%]" />
          </colgroup>
          <thead>
            <tr>
              {["Outcome", "Slice", "Requirements and scenarios", "Where it stands", "Epic's acceptance", "Look back"].map((name) => (
                <th key={name} scope="col" className="pb-2 pr-4 align-bottom text-caption font-normal text-ink-subtle">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, index) => {
              const entry = slices[index];
              return (
                <tr key={entry?.slice.slice_id ?? "none"}>
                  {index === 0 ? (
                    <Cell rowSpan={rows} dashed={!outcome.in_brief}>
                      <OutcomeNode line={line} />
                    </Cell>
                  ) : null}
                  {entry ? (
                    <>
                      <Cell fork={{ index, of: rows }} dashed={entry.slice.missing.some((m) => /not in this workspace/.test(m))}>
                        <SliceNode slice={entry.slice} />
                      </Cell>
                      <Cell dashed={!entry.slice.spec}>
                        <SpecNode slice={entry.slice} />
                      </Cell>
                      <Cell dashed={!progressLook(entry.slice.progress).known}>
                        <StandsNode slice={entry.slice} />
                      </Cell>
                      <Cell dashed>
                        <AcceptanceNode epicId={entry.slice.epic_id ?? null} epic={entry.epic} />
                      </Cell>
                    </>
                  ) : (
                    <>
                      <Cell dashed>
                        <NoSliceNode line={line} />
                      </Cell>
                      <Cell dashed colSpan={3}>
                        <Node glyph="open" word="Nothing to follow">
                          <Small>No slice carries this outcome, so there is no requirement, place with the builders or acceptance to show.</Small>
                        </Node>
                      </Cell>
                    </>
                  )}
                  {index === 0 ? (
                    <Cell rowSpan={rows} last dashed={!outcome.lookback}>
                      <LookbackNode line={line} />
                    </Cell>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {missing.rest.length ? <MissingList sentences={missing.rest} /> : null}
    </div>
  );
}

/** A table cell drawn as one stretch of the line: the rule runs through it at the node's height. */
function Cell({
  children,
  rowSpan,
  colSpan,
  dashed = false,
  last = false,
  fork,
}: {
  children: ReactNode;
  rowSpan?: number;
  colSpan?: number;
  dashed?: boolean;
  last?: boolean;
  /** For a slice cell when the line forks: draws the joint to the rows above and below. */
  fork?: { index: number; of: number };
}) {
  const forked = fork && fork.of > 1;
  return (
    <td
      rowSpan={rowSpan}
      colSpan={colSpan}
      className={cn(
        "relative pb-5 pr-4 align-top",
        "before:absolute before:left-0 before:top-[11px] before:border-t-2 before:border-line-strong before:content-['']",
        last ? "before:w-3" : "before:right-0",
        dashed && "before:border-dashed",
        forked && "after:absolute after:left-0 after:border-l-2 after:border-line-strong after:content-['']",
        forked && fork.index === 0 && "after:bottom-0 after:top-[11px]",
        forked && fork.index > 0 && fork.index < fork.of - 1 && "after:bottom-0 after:top-0",
        forked && fork.index > 0 && fork.index === fork.of - 1 && "after:top-0 after:h-[13px]",
      )}
    >
      {children}
    </td>
  );
}

/** A node: its mark on the line (a state's shape, or a plain point for a link that is simply there), then its content. */
function Node({ glyph, word, children }: { glyph?: GlyphShape; word?: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <span className="relative z-[1] grid size-6 place-items-center rounded-full bg-canvas text-ink-muted">
        {glyph ? <StateGlyph shape={glyph} size={16} /> : <span aria-hidden="true" className="size-2.5 rounded-full bg-ink-muted" />}
      </span>
      {word ? <span className="text-body-sm font-semibold text-ink">{word}</span> : null}
      {children}
    </div>
  );
}

function Small({ children }: { children: ReactNode }) {
  return <span className="text-body-sm text-ink-muted">{children}</span>;
}

/** A missing value: the word and the engine's reason, never a stand-in. */
function Missing({ sentences }: { sentences: readonly string[] }) {
  return (
    <Node glyph="open" word="Missing">
      {sentences.map((sentence) => (
        <Small key={sentence}>{sentenceCase(sentence)}</Small>
      ))}
    </Node>
  );
}

const sentenceCase = (text: string): string => {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

function OutcomeNode({ line }: { line: Line }) {
  const { outcome, missing } = line;
  if (!outcome.in_brief) {
    return (
      <div className="flex flex-col gap-1.5">
        <Node glyph="superseded" word="No longer in the brief">
          <ArtifactId className="text-body-sm">{outcome.outcome}</ArtifactId>
          {(missing.placed.outcome ?? []).map((m) => (
            <Small key={m}>{sentenceCase(m)}</Small>
          ))}
        </Node>
      </div>
    );
  }
  return (
    <Node>
      <span className="flex flex-col gap-1">
        <ArtifactId className="text-body-sm">{outcome.outcome}</ArtifactId>
        <span className="text-body-sm text-ink">{outcome.text ?? "Not recorded"}</span>
      </span>
      <span className="text-caption text-ink-muted">
        <span className="font-semibold text-ink">How we would know:</span> {outcome.how_we_would_know ?? "not recorded"}
      </span>
    </Node>
  );
}

const linkClass = "rounded-xs font-semibold text-accent-ink underline-offset-2 hover:underline";

function SliceNode({ slice }: { slice: IdeaChain["slices"][number] }) {
  const absent = slice.missing.filter((m) => /not in this workspace/.test(m));
  if (absent.length) {
    return (
      <div className="flex flex-col gap-1">
        <ArtifactId className="pl-8 text-body-sm">{slice.slice_id}</ArtifactId>
        <Missing sentences={absent} />
      </div>
    );
  }
  return (
    <Node>
      <Link to={`/slices/${encodeURIComponent(slice.slice_id)}`} className={cn(linkClass, "flex flex-col gap-0.5")}>
        <ArtifactId plain className="text-body-sm">
          {slice.slice_id}
        </ArtifactId>
        <span className="text-body-sm font-normal">{slice.title ?? "Title not recorded"}</span>
      </Link>
      {slice.issue ? (
        <span className="text-caption text-ink-muted">
          Issue <IssueLink number={slice.issue} url={null} />
        </span>
      ) : null}
    </Node>
  );
}

const specGroups = [
  ["functional_requirements", "Requirements"],
  ["invariants", "Invariants"],
  ["matrix_rules", "Decision rules"],
  ["scenarios", "Scenarios"],
] as const;

function SpecNode({ slice }: { slice: IdeaChain["slices"][number] }) {
  if (!slice.spec) {
    const why = slice.missing.filter((m) => /spec/.test(m));
    return <Missing sentences={why.length ? why : ["no spec is recorded here"]} />;
  }
  const spec = slice.spec;
  const groups = specGroups.filter(([key]) => spec[key].length);
  if (!groups.length) return <Missing sentences={["the spec names no requirement or scenario yet"]} />;
  return (
    <Node>
      <dl className="flex flex-col gap-1">
        {groups.map(([key, name]) => (
          <div key={key} className="flex flex-col">
            <dt className="text-caption text-ink-subtle">{name}</dt>
            <dd className="flex flex-wrap gap-x-1.5 font-mono text-caption text-ink" translate="no">
              {spec[key].join(" ")}
            </dd>
          </div>
        ))}
      </dl>
    </Node>
  );
}

const timeFor: Record<string, "shipped" | "building" | "question" | "marked_ready"> = {
  shipped: "shipped",
  being_built: "building",
  question: "question",
  ready_to_build: "marked_ready",
};

function StandsNode({ slice }: { slice: IdeaChain["slices"][number] }) {
  const look = progressLook(slice.progress);
  const notes = slice.missing.filter((m) => /where it stands|builders/.test(m));
  const key = slice.progress ? timeFor[slice.progress] : undefined;
  const when = key ? slice.times?.[key] : null;
  if (!look.known) return <Missing sentences={notes.length ? notes : ["where it stands is not known here"]} />;
  return (
    <Node glyph={look.glyph} word={look.word}>
      {when ? (
        <span className="text-caption text-ink-muted">
          <RelativeTime iso={when} />
        </span>
      ) : null}
      {notes.map((m) => (
        <Small key={m}>{sentenceCase(m)}</Small>
      ))}
    </Node>
  );
}

function AcceptanceNode({ epicId, epic }: { epicId: string | null; epic: IdeaChain["epics"][number] | null }) {
  if (!epicId) return <Missing sentences={["no epic is recorded for this slice"]} />;
  return (
    <div className="flex flex-col gap-1.5">
      <Node glyph="open" word="Missing">
        <Link to={`/epics/${encodeURIComponent(epicId)}/today`} className={cn(linkClass, "text-body-sm")}>
          <ArtifactId plain>{epicId}</ArtifactId>
        </Link>
        <Small>{epic?.missing ?? "Its acceptance is not recorded here."}</Small>
      </Node>
    </div>
  );
}

function NoSliceNode({ line }: { line: Line }) {
  const settled = settledWords(line.outcome.settled);
  if (settled) {
    return (
      <Node glyph="superseded" word={settled}>
        {line.outcome.settled?.reason ? <Small>{line.outcome.settled.reason}</Small> : null}
      </Node>
    );
  }
  return <Missing sentences={line.missing.placed.slice ?? ["no slice serves it"]} />;
}

function LookbackNode({ line }: { line: Line }) {
  const result = line.outcome.lookback;
  if (!result) return <Missing sentences={line.missing.placed.lookback ?? ["no look back is recorded"]} />;
  const look = resultLook(result.result);
  return (
    <Node glyph={look.glyph} word={look.word}>
      <span className="text-caption text-ink-muted">
        Recorded <RelativeTime iso={result.at} />
      </span>
    </Node>
  );
}

function MissingList({ sentences }: { sentences: readonly string[] }) {
  return (
    <div className="flex flex-col gap-1 text-body-sm text-ink-muted">
      <p className="text-label text-ink">Also missing from this line</p>
      <ul className="list-disc pl-5">
        {sentences.map((s) => (
          <li key={s}>{sentenceCase(s)}</li>
        ))}
      </ul>
    </div>
  );
}
