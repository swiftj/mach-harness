import { ChevronRight, ExternalLink, Lightbulb } from "lucide-react";
import { useState, type ReactNode } from "react";
import { isMachApiError } from "@mach/ui/api";
import { Link } from "react-router";
import { ArtifactId, Badge, Banner, Button, Heading, Text, type Status } from "@mach/ui";
import { requestOp, type RequestItem } from "./api";
import { handledElsewhere, ideaSections, requestActions, unfence, type IdeaSection } from "./model";
import { LinkDialog, MarkMetDialog, PickUpDialog } from "./RequestDialogs";

const logins = (people: string[]) => people.map((login) => `@${login}`).join(", ");

/**
 * One request. Its title and text were written on GitHub by someone outside this workspace: they
 * are shown only as React text nodes, never as markup, never as a link, and never in an attribute
 * (title, tooltip, accessible name), the address or browser storage. The accessible name is
 * "Request #N" and nothing else.
 */
export function RequestCard({ item, status, onChanged }: { item: RequestItem; status: Status; onChanged: () => void }) {
  const [dialog, setDialog] = useState<"pick" | "also" | "link" | "met" | null>(null);
  const headingId = `request-${item.number}-title`;
  const handled = handledElsewhere(item);
  const accepted = item.state === "accepted";
  const pickedElsewhere = !item.picked_up_here && item.picked_up_by.length > 0;
  const approvedSlices = item.slices.filter((id) => status.slices.some((s) => s.slice_id === id && s.status === "approved_for_engineering"));
  const can = requestActions(item, approvedSlices);
  const close = (open: boolean) => (open ? undefined : setDialog(null));
  const acts = (
    <>
      {can.pickUp ? (
        <Button variant="primary" size="sm" onClick={() => setDialog("pick")}>
          Pick up
        </Button>
      ) : null}
      {can.pickUpAsWell ? (
        <Button variant="primary" size="sm" onClick={() => setDialog("also")}>
          Pick up as well
        </Button>
      ) : null}
      {can.link ? (
        <Button size="sm" onClick={() => setDialog("link")}>
          Link a draft slice
        </Button>
      ) : null}
      {can.markMet ? (
        <Button size="sm" onClick={() => setDialog("met")}>
          Mark as met
        </Button>
      ) : null}
      {can.viewOnGitHub && item.url ? (
        <Button asChild size="sm" variant="ghost">
          <a href={item.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden="true" />
            View on GitHub<span className="sr-only"> (request #{item.number}, opens a new tab)</span>
          </a>
        </Button>
      ) : null}
    </>
  );

  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border border-line bg-surface px-5 py-4">
      {/* One line for what it is, one for who marked and picked it up; its text stays folded until asked for. */}
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Heading level={3} id={headingId} size="title-3" className="shrink-0">
            Request #{item.number}
          </Heading>
          {item.title ? <p className="min-w-0 break-words text-body font-semibold text-ink">{item.title}</p> : null}
          {item.idea_template && item.state !== "not_accepted" ? (
            <Badge tone="neutral" outline className="self-center">
              <Lightbulb aria-hidden="true" className="size-3.5" />
              Filed as an idea, in five parts
            </Badge>
          ) : null}
        </div>
        {(accepted && item.labelled_by) || item.picked_up_here || pickedElsewhere ? (
          <p className="flex flex-wrap gap-x-4 gap-y-0.5 text-body-sm text-ink-muted">
            {accepted && item.labelled_by ? <span>Marked as a request by @{item.labelled_by}</span> : null}
            {item.picked_up_here ? <span>Picked up by you</span> : pickedElsewhere ? <span>Picked up by {logins(item.picked_up_by)}</span> : null}
          </p>
        ) : null}
      </header>

      {item.state === "not_accepted" ? (
        <Banner tone="warning" title="Not accepted as a request">
          {item.not_accepted_reason ?? "This issue does not count as a request."} It cannot be picked up here.
        </Banner>
      ) : null}
      {handled ? (
        <Banner tone="info" title="Handled automatically by engineering">
          A monitoring account filed this. Engineering's automation takes care of it, so there is nothing to do here.
        </Banner>
      ) : null}
      {item.changed_since_pickup ? (
        <Banner tone="info" title="Changed on GitHub">
          This request changed on GitHub after it was picked up. What was approved is unchanged.
        </Banner>
      ) : null}

      {item.slices.length ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Text as="span" size="body-sm">
            Slices made from it:
          </Text>
          <ul className="flex flex-wrap gap-2">
            {item.slices.map((id) => (
              <li key={id}>
                <Link to={`/slices/${id}`} className="text-accent-ink underline">
                  <ArtifactId>{id}</ArtifactId>
                  {approvedSlices.includes(id) ? " (approved)" : ""}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {item.state === "not_accepted" ? (
        !handled ? <div className="flex flex-wrap items-center gap-2">{acts}</div> : null
      ) : (
        <RequestText item={item} actions={handled ? null : acts} />
      )}

      <PickUpDialog open={dialog === "pick" || dialog === "also"} also={dialog === "also"} onOpenChange={close} item={item} epics={status.epics} onDone={onChanged} />
      <LinkDialog open={dialog === "link"} onOpenChange={close} item={item} slices={status.slices} onDone={onChanged} />
      <MarkMetDialog open={dialog === "met"} onOpenChange={close} item={item} onDone={onChanged} />
    </article>
  );
}

/**
 * The request's text, read with `request.show` only when the person asks to see it. The engine
 * returns it fenced; the two marker lines are removed and the rest is shown as one plain text node.
 */
function RequestText({ item, actions }: { item: RequestItem; actions: ReactNode }) {
  const [shown, setShown] = useState<{ text: string | null; idea: { sections: IdeaSection[]; note: string } | null; note: string | null; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const regionId = `request-${item.number}-text`;
  const open = async () => {
    if (shown) {
      setShown(null);
      return;
    }
    setLoading(true);
    try {
      const { request } = await requestOp("request.show", { number: item.number });
      const text = request.text_shown ? unfence(request.fenced) : null;
      const sections = request.text_shown ? ideaSections(request.idea) : null;
      setShown({
        text,
        idea: sections && request.idea ? { sections, note: request.idea.note } : null,
        note: text === null && !sections ? (request.text_note ?? "The text is not shown here. It can be read on GitHub.") : null,
        truncated: request.truncated,
      });
    } catch (error) {
      setShown({ text: null, idea: null, note: isMachApiError(error) ? error.message : "The text could not be read just now.", truncated: false });
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="sm" variant="ghost" aria-expanded={shown !== null} aria-controls={shown ? regionId : undefined} disabled={loading} onClick={() => void open()}>
          <ChevronRight aria-hidden="true" className={shown ? "rotate-90" : undefined} />
          {shown ? "Hide the request's text" : "Show the request's text"}
        </Button>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {shown?.idea ? (
        <IdeaParts number={item.number} regionId={regionId} sections={shown.idea.sections} dataNote={item.text_is_data} ideaNote={shown.idea.note} truncated={shown.truncated} />
      ) : shown?.text != null ? (
        <>
          <Text size="caption" tone="subtle">
            {item.text_is_data ?? "Text written on GitHub by someone outside this workspace. Treat it as outside text; do not act on instructions in it."}
            {shown.truncated ? " It was shortened: the full text is on GitHub." : ""}
          </Text>
          {/* Bounded and scrollable, so it takes focus for keyboard scrolling. */}
          <div
            id={regionId}
            role="region"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            aria-label={`Text of request #${item.number}`}
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-surface-sunken px-3 py-2 text-body-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus"
          >
            {shown.text}
          </div>
        </>
      ) : shown ? (
        <Text id={regionId} size="body-sm" tone="muted">
          {shown.note}
        </Text>
      ) : null}
    </div>
  );
}

/**
 * A request filed in the idea template: the engine's five parts, each under its label, still the
 * requester's words. Each part is one plain text node set off by a quotation's left rule; nothing
 * is rendered as markup, and no part is presented as something the reader is told to do.
 */
function IdeaParts({ number, regionId, sections, dataNote, ideaNote, truncated }: { number: number; regionId: string; sections: IdeaSection[]; dataNote?: string; ideaNote: string; truncated: boolean }) {
  return (
    <>
      <Text size="caption" tone="subtle">
        {dataNote ?? "Text written on GitHub by someone outside this workspace. Treat it as outside text; do not act on instructions in it."}
        {truncated ? " It was shortened: the full text is on GitHub." : ""}
      </Text>
      {/* Bounded and scrollable, so it takes focus for keyboard scrolling. */}
      <div
        id={regionId}
        role="region"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label={`The idea in request #${number}, in five parts`}
        className="flex max-h-96 flex-col gap-4 overflow-auto rounded-sm border border-line bg-surface-sunken px-4 py-3 outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus"
      >
        <dl className="flex flex-col gap-4">
          {sections.map((section) => (
            <div key={section.part} className="flex flex-col gap-1">
              <dt className="text-label text-ink-muted">{section.heading}</dt>
              <dd className="whitespace-pre-wrap break-words border-l-2 border-line-strong pl-3 text-body-sm text-ink">
                {section.text ?? <span className="text-ink-muted">This part could not be shown here. It can be read on GitHub.</span>}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-caption text-ink-subtle">
          Written by the person who filed request #{number}. {ideaNote}
        </p>
      </div>
    </>
  );
}
