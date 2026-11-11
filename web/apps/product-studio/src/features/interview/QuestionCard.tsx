import { useEffect, useId, useRef, useState } from "react";
import { Check, HelpCircle, PencilLine, Send, Sparkles } from "lucide-react";
import { Button, Field, Text, Textarea, RichText } from "@mach/ui";
import type { AnswerKind } from "./model";
import { type ParsedQuestion } from "@mach/ui/api";

export interface QuestionCardProps {
  question: ParsedQuestion;
  onAnswer: (text: string, answer: AnswerKind) => void;
  /** A reply is on its way: buttons wait. */
  busy: boolean;
}

/**
 * The question being asked, as a first-class object: its title, its body, the interviewer's
 * recommended answer and its reasoning, and the ways to answer. Shown only for a parsed `question`
 * event; any other message gets a free reply instead.
 */
export function QuestionCard({ question, onAnswer, busy }: QuestionCardProps) {
  const [revising, setRevising] = useState(false);
  const [text, setText] = useState("");
  const titleId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLElement>(null);

  // Each question mounts a fresh card (keyed by message_id); focus lands on the decision.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (revising) textRef.current?.focus();
  }, [revising]);

  const [lead, ...reasoning] = question.recommendation.split(/(?<=\.)\s+/);
  const sendRevision = () => {
    if (text.trim()) onAnswer(text, "revised");
  };

  return (
    <section
      ref={cardRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      className="flex max-h-[min(30rem,55vh)] flex-col rounded-md border border-line-strong bg-surface shadow-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-3 pt-4">
        <div className="flex items-baseline gap-2.5">
          <span className="shrink-0 font-mono text-mono text-ink-subtle" translate="no" title="Question numbers restart in each session">
            Q{question.number}
          </span>
          <h2 id={titleId} className="font-display text-title-2 text-ink">
            {question.title}
          </h2>
        </div>
        <RichText text={question.body} editorial className="text-ink" />
        <div className="flex gap-3 rounded-sm border-l-2 border-accent bg-accent-soft px-3.5 py-2.5">
          <Sparkles aria-hidden="true" className="mt-1 size-4 shrink-0 text-accent-ink" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-label text-accent-ink">Recommended</p>
            <p className="text-body text-ink">
              <span className="font-semibold">{lead}</span>
              {reasoning.length ? <span> {reasoning.join(" ")}</span> : null}
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-line px-5 py-3">
        {revising ? (
          <div className="flex flex-col gap-2">
            <Field label="Your answer" hint="Say it in your own words. The interviewer records it and moves on.">
              <Textarea
                ref={textRef}
                rows={2}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    sendRevision();
                  }
                  if (event.key === "Escape") setRevising(false);
                }}
              />
            </Field>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={() => setRevising(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!text.trim()} loading={busy} onClick={sendRevision}>
                <Send aria-hidden="true" />
                Send answer
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-2">
                <Button variant="primary" loading={busy} onClick={() => onAnswer("yes", "accepted")}>
                  <Check aria-hidden="true" />
                  Yes, accept
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => setRevising(true)}>
                  <PencilLine aria-hidden="true" />
                  Answer differently
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" disabled={busy} onClick={() => onAnswer("I don't know", "deferred")}>
                  I don't know
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => onAnswer("You decide", "delegated")}>
                  You decide
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => onAnswer("Why do you recommend that? Explain before I answer.", "explain")}>
                  <HelpCircle aria-hidden="true" />
                  Explain
                </Button>
              </div>
            </div>
            <Text size="caption" tone="subtle">
              “I don't know” records it as an open question. “You decide” records the recommendation as an assumption you can check later.
            </Text>
          </>
        )}
      </div>
    </section>
  );
}
