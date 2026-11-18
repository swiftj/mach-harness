import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, HelpCircle, Send } from "lucide-react";
import { Button, Field, Kbd, RichText, Text, Textarea } from "@mach/ui";
import { answerText, type AnswerKind } from "./model";
import { type ParsedQuestion } from "@mach/ui/api";

export interface QuestionCardProps {
  question: ParsedQuestion;
  onAnswer: (text: string, answer: AnswerKind) => void;
  /** A reply is on its way: buttons wait. */
  busy: boolean;
}

/**
 * The question being asked, given the room: its number, its topic, the question itself in large
 * type, the interviewer's recommended answer with its reason, and the ways to answer. Accepting the
 * recommendation is the primary button; "No" asks for the answer in the PM's own words, which the
 * field below always offers. Y and N answer from the keyboard while the question has focus.
 * Shown only for a parsed `question` event; any other message gets a free reply instead.
 */
export function QuestionCard({ question, onAnswer, busy }: QuestionCardProps) {
  const [text, setText] = useState("");
  const titleId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLElement>(null);

  // Each question mounts a fresh card (keyed by message_id); focus lands on the decision.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  const [lead, ...reasoning] = question.recommendation.split(/(?<=\.)\s+/);
  const sendOwn = () => {
    if (text.trim() && !busy) onAnswer(text, "revised");
  };
  const accept = () => {
    if (!busy) onAnswer(answerText.accepted, "accepted");
  };

  const shortcuts = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (event.metaKey || event.ctrlKey || event.altKey || target.closest("textarea, input")) return;
    const key = event.key.toLowerCase();
    if (key === "y") {
      event.preventDefault();
      accept();
    } else if (key === "n") {
      event.preventDefault();
      textRef.current?.focus();
    }
  };

  return (
    // Y and N are shortcuts while the question has focus; every answer is also a button.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      ref={cardRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      onKeyDown={shortcuts}
      className="flex flex-col gap-6 rounded-md focus-visible:outline-2 focus-visible:outline-offset-8 focus-visible:outline-focus"
    >
      <div className="flex flex-col gap-2">
        <Text size="body-sm" tone="muted">
          <span title="Question numbers restart each time the interview is started">Question {question.number}</span>
          <span aria-hidden="true"> · </span>
          <span id={titleId} className="font-semibold text-ink">
            {question.title}
          </span>
        </Text>
        {question.preface ? <RichText text={question.preface} className="text-ink-muted" /> : null}
        <RichText text={question.body} className="font-display text-title-2 text-ink" />
      </div>

      <div className="flex flex-col gap-1 rounded-sm border-l-2 border-accent bg-accent-soft px-4 py-3">
        <p className="text-label text-accent-ink">Recommended</p>
        <p className="text-body-lg text-ink">
          <span className="font-semibold">{lead}</span>
          {reasoning.length ? <span> {reasoning.join(" ")}</span> : null}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" loading={busy} onClick={accept}>
            <Check aria-hidden="true" />
            Yes, accept
          </Button>
          <Button variant="secondary" size="lg" disabled={busy} onClick={() => textRef.current?.focus()}>
            No, I will say what instead
          </Button>
          <span className="flex items-center gap-1 text-caption text-ink-subtle">
            <Kbd>Y</Kbd> accepts, <Kbd>N</Kbd> moves to your own words
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <Field label="Or answer in your own words" hint="The interviewer records it and moves on.">
            <Textarea
              ref={textRef}
              rows={2}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  sendOwn();
                }
              }}
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAnswer(answerText.deferred, "deferred")}>
                I don't know
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAnswer(answerText.delegated, "delegated")}>
                You decide
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAnswer(answerText.explain, "explain")}>
                <HelpCircle aria-hidden="true" />
                Explain
              </Button>
            </div>
            <Button variant="secondary" disabled={!text.trim()} loading={busy && Boolean(text.trim())} onClick={sendOwn}>
              <Send aria-hidden="true" />
              Send answer
            </Button>
          </div>
          <Text size="caption" tone="subtle">
            “I don't know” records it as an open question. “You decide” records the recommendation as an assumption you can check later.
          </Text>
        </div>
      </div>
    </section>
  );
}
