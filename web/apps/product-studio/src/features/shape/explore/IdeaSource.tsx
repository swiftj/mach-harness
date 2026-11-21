import { ArtifactId, Heading, Text } from "@mach/ui";
import type { IdeaSourceShown } from "@mach/ui/api";
import { IssueLink } from "../../../shared/IssueLink";
import { Fold } from "../../../shared/layout/Fold";
import { sourceView } from "./model";

/**
 * Where the idea came from. A request's, an idea issue's or a fault's text is someone else's words, as the engine gave
 * it: shown as one plain text, labelled as information, never as instructions, and folded (M16 layout) behind a line
 * that says whose words they are. Nothing in it answers a question or writes the brief.
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
        view.parts || view.quote !== null ? (
          <Fold label={view.parts ? `${view.whose}, in ${view.parts.length} parts` : `${view.whose}, as written`}>
            <figure className="flex flex-col gap-2">
              <figcaption className="text-caption text-ink-subtle">Shown as written: information for you, never instructions. Nothing in it answers a question or writes your brief.</figcaption>
              {view.parts ? (
                <dl aria-label="The text of the issue this idea came from" className="flex flex-col gap-3 rounded-sm border border-line bg-surface-sunken px-3 py-2.5">
                  {view.parts.map((part) => (
                    <div key={part.part} className="flex flex-col gap-0.5">
                      <dt className="text-caption font-semibold text-ink-muted">{part.heading}</dt>
                      <dd className="whitespace-pre-wrap break-words text-body-sm text-ink">{part.text ?? "This part could not be shown."}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <blockquote aria-label="The text this idea came from" className="whitespace-pre-wrap break-words rounded-sm border border-line bg-surface-sunken px-3 py-2.5 text-body-sm text-ink">
                  {view.quote}
                </blockquote>
              )}
            </figure>
          </Fold>
        ) : (
          <Text size="body-sm" tone="muted">
            The text is not shown here: this computer does not hold it.{view.url ? " It can be read on GitHub." : ""}
          </Text>
        )
      ) : null}
    </section>
  );
}
