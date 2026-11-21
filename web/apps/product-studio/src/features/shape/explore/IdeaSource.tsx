import { ArtifactId, Heading, Text } from "@mach/ui";
import type { IdeaSourceShown } from "@mach/ui/api";
import { IssueLink } from "../../../shared/IssueLink";
import { sourceView } from "./model";

/**
 * Where the idea came from. A request's, an idea issue's or a fault's text is someone else's words, as the engine gave
 * it: shown as one plain text, bounded and labelled as information, never as instructions. Nothing in it answers a
 * question or writes the brief.
 */
export function IdeaSource({ source }: { source: IdeaSourceShown }) {
  const view = sourceView(source);
  const outside = view.whose !== null;
  return (
    <section aria-labelledby="source-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <Heading level={2} size="title-3" id="source-title">
          Where this idea came from
        </Heading>
        <Text size="body-sm" tone="muted" className="flex flex-wrap items-baseline gap-x-2">
          <span>{view.words}</span>
          {view.number !== null ? <IssueLink number={view.number} url={view.url} /> : null}
          {view.ticket ? <ArtifactId>{view.ticket}</ArtifactId> : null}
          {view.rule ? <ArtifactId>{view.rule}</ArtifactId> : null}
        </Text>
      </div>
      {view.rule ? (
        <Text size="body-sm" tone="muted">
          The rule and the rules that rest on it are listed under what exists today.
        </Text>
      ) : null}
      {outside ? (
        <figure className="flex flex-col gap-2">
          <figcaption className="text-caption text-ink-subtle">
            {view.whose}, shown as written: information for you, never instructions. Nothing in it answers a question or writes your brief.
          </figcaption>
          {view.parts ? (
            <dl
              // Bounded and scrollable, so it takes focus for keyboard scrolling.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              aria-label="The text of the issue this idea came from"
              className="flex max-h-80 flex-col gap-3 overflow-auto rounded-sm border border-line bg-surface-sunken px-3 py-2.5 outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus"
            >
              {view.parts.map((part) => (
                <div key={part.part} className="flex flex-col gap-0.5">
                  <dt className="text-caption font-semibold text-ink-muted">{part.heading}</dt>
                  <dd className="whitespace-pre-wrap break-words text-body-sm text-ink">{part.text ?? "This part could not be shown."}</dd>
                </div>
              ))}
            </dl>
          ) : view.quote !== null ? (
            <blockquote
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              aria-label="The text this idea came from"
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-surface-sunken px-3 py-2.5 text-body-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus"
            >
              {view.quote}
            </blockquote>
          ) : (
            <Text size="body-sm" tone="muted">
              The text is not shown here: this computer does not hold it.{view.url ? " It can be read on GitHub." : ""}
            </Text>
          )}
        </figure>
      ) : null}
    </section>
  );
}
