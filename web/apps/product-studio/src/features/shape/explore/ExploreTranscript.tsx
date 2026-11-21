import { type ReactNode } from "react";
import { CircleDot, ListChecks, Lock, PenLine, Save, Search } from "lucide-react";
import { Banner, Button, Heading, RichText, Text, cn, plural as count } from "@mach/ui";
import type { ActivityKind } from "@mach/ui/api";
import type { AnswerKind, InterviewModel, InterviewerMessage, TimelineItem } from "../../interview/model";
import { Fold } from "../../../shared/layout/Fold";
import { openQuestion } from "./model";

const answerLabels: Record<AnswerKind, string> = {
  accepted: "You answered",
  revised: "You answered",
  deferred: "You did not know",
  delegated: "You answered",
  explain: "You asked",
  reply: "You replied",
};

const activityIcons: Record<ActivityKind, ReactNode> = {
  lookup: <Search aria-hidden="true" />,
  check: <ListChecks aria-hidden="true" />,
  save: <Save aria-hidden="true" />,
  write: <PenLine aria-hidden="true" />,
  refused: <Lock aria-hidden="true" />,
  other: <CircleDot aria-hidden="true" />,
};

type Row =
  | { type: "item"; item: Exclude<TimelineItem, { type: "activity" }> }
  | { type: "activities"; key: string; items: Array<Extract<TimelineItem, { type: "activity" }>>; turn: number };

/** Consecutive activities of one turn together; a finished turn's routine steps fold away (as the interview does). */
function rows(timeline: TimelineItem[]): Row[] {
  const out: Row[] = [];
  for (const item of timeline) {
    if (item.type === "activity") {
      const last = out[out.length - 1];
      if (last?.type === "activities" && last.turn === item.turn) last.items.push(item);
      else out.push({ type: "activities", key: item.key, items: [item], turn: item.turn });
    } else {
      out.push({ type: "item", item });
    }
  }
  return out;
}

/**
 * The conversation so far, as the sketch lays it out: "MACH asked" and "You answered", oldest first. The message being
 * answered now is shown below it, with what it said before its question, and not repeated here. Every word of it is the conversation's or the PM's, shown as text
 * (RichText interprets no HTML).
 */
export function ExploreTranscript({ model, onRetry }: { model: InterviewModel; onRetry: (() => void) | null }) {
  // The message being answered, with what it said before its question, is shown directly below the transcript.
  const list = rows(model.timeline).filter((row) => !(row.type === "item" && row.item.type === "message" && row.item.id === model.awaiting));
  if (!list.length) return null;
  return (
    <section aria-labelledby="so-far-title" className="flex flex-col gap-3 border-b border-line pb-6">
      <Heading level={3} size="title-3" id="so-far-title">
        The conversation so far
      </Heading>
      <ol className="flex flex-col gap-4" aria-label="The conversation so far">
        {list.map((row) => {
          if (row.type === "activities") {
            return (
              <li key={row.key}>
                <ActivityGroup items={row.items} finished={row.turn < model.turn} />
              </li>
            );
          }
          const item = row.item;
          switch (item.type) {
            case "message": {
              const message = model.messages[item.id];
              if (!message) return null;
              return (
                <li key={item.key}>
                  <Asked message={message} />
                </li>
              );
            }
            case "reply":
              return (
                <li key={item.key}>
                  <Turn who={answerLabels[item.answer]}>
                    <p className="whitespace-pre-wrap break-words text-body text-ink">{item.text}</p>
                    {item.pending ? (
                      <Text size="caption" tone="subtle">
                        Sending
                      </Text>
                    ) : null}
                  </Turn>
                </li>
              );
            case "notice":
              return (
                <li key={item.key}>
                  <Banner
                    tone={item.tone}
                    title={item.title}
                    actions={
                      item.retry && onRetry ? (
                        <Button size="sm" onClick={onRetry}>
                          Send again
                        </Button>
                      ) : undefined
                    }
                  >
                    {item.text}
                  </Banner>
                </li>
              );
          }
        })}
      </ol>
    </section>
  );
}

/** One line of the conversation: who, then what was said (stacked; the sketch's two columns need more width than half a page). */
function Turn({ who, children, muted = false }: { who: string; children: ReactNode; muted?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-ink-subtle">{who}</span>
      <div className={cn("min-w-0", muted ? "text-ink-muted" : "text-ink")}>{children}</div>
    </div>
  );
}

function Asked({ message }: { message: InterviewerMessage }) {
  const q = message.question ?? openQuestion(message.text);
  if (q) {
    return (
      <Turn who={`MACH asked, question ${q.number}: ${q.title}`}>
        {q.preface ? <RichText text={q.preface} className="mb-2 text-ink-muted" /> : null}
        <RichText text={q.body} className="font-semibold" />
      </Turn>
    );
  }
  return (
    <Turn who={message.final ? "MACH said" : "MACH is writing"} muted={!message.final}>
      <RichText text={message.text} />
    </Turn>
  );
}

function ActivityGroup({ items, finished }: { items: Array<Extract<TimelineItem, { type: "activity" }>>; finished: boolean }) {
  const refused = items.filter((a) => a.kind === "refused");
  const routine = items.filter((a) => a.kind !== "refused");
  const list = (entries: typeof items) => (
    <ul className="flex flex-col gap-1">
      {entries.map((a) => (
        <li key={a.key} className="flex items-center gap-2 text-body-sm text-ink-muted [&_svg]:size-3.5 [&_svg]:shrink-0">
          {activityIcons[a.kind]}
          <span>{a.text}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="flex flex-col gap-2 border-l-2 border-line pl-3">
      {routine.length ? (
        finished && routine.length > 2 ? (
          <Fold label={`${count(routine.length, "step")} taken`}>{list(routine)}</Fold>
        ) : (
          list(routine)
        )
      ) : null}
      {refused.map((a) => (
        <div key={a.key} className="flex items-start gap-2.5 rounded-sm bg-info-soft px-3 py-2">
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info-ink" />
          <div className="flex flex-col gap-0.5">
            <Text size="body-sm" className="text-ink">
              {a.text}
            </Text>
            <Text size="caption" tone="muted">
              Starting to explore, the verdict, sizing, the map, publishing and looking back are yours to do, with the buttons in Shape. The conversation carries on.
            </Text>
          </div>
        </div>
      ))}
    </div>
  );
}
