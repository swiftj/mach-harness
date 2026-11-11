import { type ReactNode } from "react";
import { BookOpen, CircleDot, ListChecks, Lock, PenLine, Save, Search } from "lucide-react";
import { Badge, Banner, Button, Text, cn, RichText, plural as count } from "@mach/ui";
import type { AnswerKind, InterviewModel, InterviewerMessage, TimelineItem } from "./model";
import { type ActivityKind } from "@mach/ui/api";

const answerLabels: Record<AnswerKind, string> = {
  accepted: "Accepted the recommendation",
  revised: "Answered differently",
  deferred: "Left open",
  delegated: "Let the interviewer decide",
  explain: "Asked why",
  reply: "Replied",
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

/** Consecutive activities of one turn are shown together; a finished turn's routine steps fold away. */
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

export function Transcript({
  model,
  onRetry,
}: {
  model: InterviewModel;
  /** Sends the last reply again after a failed turn. */
  onRetry: (() => void) | null;
}) {
  const list = rows(model.timeline);
  return (
    <ol className="flex flex-col gap-5" aria-label="Conversation with the interviewer">
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
                <InterviewerEntry message={message} awaiting={model.awaiting === message.id} />
              </li>
            );
          }
          case "reply":
            return (
              <li key={item.key} className="flex justify-end">
                <div className="flex max-w-[85%] flex-col items-end gap-1">
                  <span className="text-caption text-ink-subtle">
                    You <span aria-hidden="true">·</span> {answerLabels[item.answer]}
                  </span>
                  <p className="whitespace-pre-wrap break-words rounded-md bg-surface-sunken px-3.5 py-2 text-body text-ink">{item.text}</p>
                </div>
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
  );
}

function InterviewerEntry({ message, awaiting }: { message: InterviewerMessage; awaiting: boolean }) {
  const q = message.question;
  // The question being asked lives in the question card below; here only its preface stays in the flow.
  if (q && awaiting) {
    return q.preface ? (
      <Speaker>
        <RichText text={q.preface} />
        <p className="mt-2 text-body-sm text-ink-muted">Question {q.number} is below.</p>
      </Speaker>
    ) : null;
  }
  if (q) {
    return (
      <Speaker>
        {q.preface ? <RichText text={q.preface} className="mb-3" /> : null}
        <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface px-4 py-3">
          <p className="flex items-baseline gap-2">
            <span className="font-mono text-mono text-ink-subtle" translate="no">
              Q{q.number}
            </span>
            <span className="text-label text-ink">{q.title}</span>
          </p>
          <RichText text={q.body} className="text-body-sm text-ink-muted" />
          <p className="text-body-sm text-ink-muted">
            <span className="font-semibold text-ink">Recommended:</span> {q.recommendation}
          </p>
        </div>
      </Speaker>
    );
  }
  return (
    <Speaker streaming={!message.final} badge={message.kind === "confirmation" ? <Badge tone="info">Summary to confirm</Badge> : null}>
      <RichText text={message.text} />
    </Speaker>
  );
}

function Speaker({ children, streaming = false, badge }: { children: ReactNode; streaming?: boolean; badge?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2 text-caption text-ink-subtle">
        Interviewer
        {badge}
        {streaming ? <span className="italic">writing…</span> : null}
      </span>
      <div className={cn("text-ink", streaming && "text-ink-muted")}>{children}</div>
    </div>
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
          <details className="group">
            <summary className="flex cursor-pointer items-center gap-2 rounded-xs text-body-sm text-ink-muted marker:content-none [&_svg]:size-3.5">
              <BookOpen aria-hidden="true" />
              {count(routine.length, "step")} taken
              <span className="text-caption text-ink-subtle group-open:hidden">(show)</span>
            </summary>
            <div className="pt-1.5">{list(routine)}</div>
          </details>
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
              Approving, sending and settling differences are yours to do, with the buttons in Product Studio. The interview carries on.
            </Text>
          </div>
        </div>
      ))}
    </div>
  );
}
