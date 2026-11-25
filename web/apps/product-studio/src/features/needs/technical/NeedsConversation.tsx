import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CircleAlert, MessagesSquare, Pause, Square, WifiOff } from "lucide-react";
import { Banner, Button, CommandLine, EmptyState, ErrorState, Heading, LoadingState, RichText, Spinner, Text, Tooltip, describeError } from "@mach/ui";
import { answerText } from "../../interview/model";
import { loadSession } from "../../../api/session";
import { ExploreTranscript } from "../../shape/explore/ExploreTranscript";
import { ReplyField, conversationBusy, useNewestInView } from "../../shape/explore/Conversation";
import { openQuestion } from "../../shape/explore/model";
import type { ConversationController } from "../shell/useNeedsConversation";
import { needsCommand } from "./model";
import { TakeOverBanner } from "../../../shared/TakeOverBanner";
import { ConversationProblem } from "../../../shared/ConversationProblem";

const PAUSE_REQUEST = "I need to stop here. Please save where we are so I can continue later.";
const NOTHING_TO_SAY = "Nothing to say about this.";

export { conversationBusy };

/**
 * The conversation's heading and its own acts, given to its pane as the pane's header so they stay at the top while
 * the turns scroll under them (as Shape's Explore has it).
 */
export function NeedsConversationHeader({ conv }: { conv: ConversationController }) {
  const busy = conversationBusy(conv);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <Heading level={2} size="title-3" id="needs-conversation-title">
        The conversation
      </Heading>
      {conv.phase === "live" && !conv.model.ended ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <StatusLine conv={conv} busy={busy} />
          {busy ? (
            <Button variant="secondary" size="sm" loading={conv.sending === "interrupt"} onClick={conv.interrupt}>
              <Square aria-hidden="true" />
              Interrupt
            </Button>
          ) : (
            <Tooltip content="Asks MACH to save what is recorded so far and the next question, then wait.">
              <Button variant="secondary" size="sm" disabled={conv.sending !== null} onClick={() => conv.reply(PAUSE_REQUEST, "reply")}>
                <Pause aria-hidden="true" />
                Save and pause
              </Button>
            </Tooltip>
          )}
          <Tooltip content="Ends the conversation now. Your needs stay as recorded; you can continue later.">
            <Button variant="ghost" size="sm" loading={conv.sending === "stop"} onClick={conv.stop}>
              Stop
            </Button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}

function StatusLine({ conv, busy }: { conv: ConversationController; busy: boolean }) {
  let content: ReactNode;
  if (conv.model.connection === "reconnecting") {
    content = (
      <>
        <WifiOff aria-hidden="true" className="size-4 text-warning-ink" />
        Reconnecting
      </>
    );
  } else if (busy) {
    content = (
      <>
        <Spinner size="sm" />
        <span className="max-w-56 truncate">{conv.model.lastActivity ?? "Working on a reply"}</span>
      </>
    );
  } else {
    content = <>Waiting for you</>;
  }
  return (
    <span className="mr-1 flex items-center gap-2 text-body-sm text-ink-muted" role="status" aria-live="polite">
      {content}
    </span>
  );
}

/**
 * The needs conversation (the third narrow mode of the guided interview): open questions about the product as a whole,
 * one at a time, answered in the product manager's own words; it never offers a technology. It may record a need or
 * "nothing to say" with the person's words; retiring, publishing and choosing a version are this page's own buttons.
 */
export function NeedsConversation({ conv }: { conv: ConversationController }) {
  const busy = conversationBusy(conv);
  const transcript = conv.phase === "live" || conv.model.timeline.length > 0;
  const sectionRef = useRef<HTMLElement>(null);
  // A new turn, a new question, a reply sent or the conversation ending brings the pane back to its end (M16 layout).
  useNewestInView(sectionRef, `${conv.phase} ${conv.model.turn} ${conv.model.turnRunning} ${conv.model.awaiting ?? ""} ${conv.model.ended ? "ended" : ""}`);
  return (
    <section ref={sectionRef} aria-labelledby="needs-conversation-title" className="flex min-w-0 flex-col gap-6">
      {transcript ? <ExploreTranscript model={conv.model} onRetry={conv.model.lastReply && !busy ? () => conv.reply(conv.model.lastReply ?? "", "reply") : null} /> : null}
      <Current conv={conv} busy={busy} />
    </section>
  );
}

function Current({ conv, busy }: { conv: ConversationController; busy: boolean }) {
  const { model } = conv;
  switch (conv.phase) {
    case "loading":
      return <LoadingState label="Connecting to the conversation" />;
    case "starting":
      return <LoadingState label="Starting the conversation. The first question takes about 20 seconds while MACH reads your project and your needs." />;
    case "unavailable":
      return <ContinueInClaudeCode reason={conv.capability?.reason ?? null} />;
    case "conflict":
      return <TakeOverBanner conv={conv} subject="the technical needs" />;
    case "refused":
    case "error": {
      const error = conv.problem;
      const described = error ? describeError(error) : { title: "The conversation could not start", message: "" };
      return (
        <div className="flex flex-col gap-6">
          <ErrorState
            icon={<CircleAlert />}
            title={error?.kind === "refused" ? "The conversation did not start" : described.title}
            message={error?.kind === "refused" ? error.message : described.message}
            hint={error?.hint}
            action={<Button onClick={conv.retryLoad}>Try again</Button>}
          />
          {error?.kind === "unavailable" ? <ContinueInClaudeCode reason={null} /> : null}
        </div>
      );
    }
    case "idle":
      return <StartPanel conv={conv} />;
    case "live":
      break;
  }

  const awaiting = model.awaiting ? model.messages[model.awaiting] : null;
  const parsed = awaiting?.question
    ? { number: awaiting.question.number, title: awaiting.question.title, body: awaiting.question.body, preface: awaiting.question.preface || null }
    : awaiting
      ? openQuestion(awaiting.text)
      : null;
  const announce = parsed ? `Question ${parsed.number}: ${parsed.title}.` : awaiting ? "MACH replied." : "";
  const streaming = Object.values(model.messages).find((m) => !m.final && m.text);

  let body: ReactNode;
  if (model.ended) {
    const reason = model.ended.reason;
    body = (
      <Banner
        tone={reason === "failed" ? "danger" : reason === "host_shutdown" ? "warning" : "info"}
        title={reason === "failed" ? "The conversation stopped because of a problem" : reason === "host_shutdown" ? "Product Studio's host was stopped" : "Conversation stopped"}
        actions={
          <Button variant="primary" onClick={conv.start}>
            Continue the conversation
          </Button>
        }
      >
        Your needs stay as recorded. Continuing picks up from them and asks about the kinds not answered yet.
      </Banner>
    );
  } else if (awaiting && parsed) {
    body = <AskCard key={awaiting.id} question={parsed} busy={conv.sending === "reply"} onAnswer={conv.reply} />;
  } else if (busy) {
    body = (
      <div key="working" className="flex flex-col gap-4">
        <p className="flex items-center gap-2 text-body text-ink-muted">
          <Spinner size="sm" />
          {model.lastActivity ?? "MACH is working on a reply"}
        </p>
        {streaming ? <RichText text={streaming.text} editorial className="text-ink-muted" /> : null}
        <Text size="body-sm" tone="subtle">
          You can reply when it has finished. Interrupt it if it is going the wrong way.
        </Text>
      </div>
    );
  } else {
    body = (
      <div key="answer" className="flex flex-col gap-6">
        {awaiting ? (
          <div className="flex flex-col gap-2">
            <span className="text-body-sm text-ink-muted">MACH said</span>
            <RichText text={awaiting.text} editorial className="text-ink" />
          </div>
        ) : null}
        <ReplyField key={model.awaiting ?? "free"} label="Your reply" focusOnMount={Boolean(awaiting)} busy={conv.sending === "reply"} onSend={(text) => conv.reply(text, "reply")} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {model.connection === "reconnecting" ? (
        <Banner tone="warning" title="Connection to Product Studio lost. Reconnecting." live="polite">
          Nothing you said is lost. The conversation catches up when the connection returns.
        </Banner>
      ) : null}
      {conv.problem ? <ConversationProblem problem={conv.problem} /> : null}
      {body}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

function StartPanel({ conv }: { conv: ConversationController }) {
  const before = Boolean(conv.summary) || conv.model.timeline.length > 0;
  return (
    <EmptyState
      icon={<MessagesSquare />}
      title={before ? "Continue the conversation" : "Talk it through"}
      description={
        before
          ? "MACH picks up from the needs you have recorded and asks about the kinds not answered yet."
          : "MACH asks the six questions beside this, one at a time, and records your answers in your words. It never suggests a technology. It reads your project first, so the first question takes about 20 seconds."
      }
      action={
        <Button variant="primary" size="lg" onClick={conv.start}>
          {before ? "Continue the conversation" : "Start the conversation"}
        </Button>
      }
    />
  );
}

/** The open question being asked: its number and topic, the question large, and the answer in the PM's own words. */
function AskCard({
  question,
  onAnswer,
  busy,
}: {
  question: { number: number; title: string; body: string; preface: string | null };
  onAnswer: ConversationController["reply"];
  busy: boolean;
}) {
  const titleId = useId();
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      ref={cardRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      className="flex flex-col gap-5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-8 focus-visible:outline-focus"
    >
      <div className="flex flex-col gap-2">
        <Text size="body-sm" tone="muted">
          <span title="Question numbers restart each time the conversation is started">Question {question.number}</span>
          <span aria-hidden="true"> · </span>
          <span id={titleId} className="font-semibold text-ink">
            {question.title}
          </span>
        </Text>
        {question.preface ? <RichText text={question.preface} className="text-ink-muted" /> : null}
        <RichText text={question.body} className="font-display text-title-2 text-ink" />
      </div>
      <ReplyField
        label="Your answer"
        hint="In your own words, without naming a technology. If someone already decided one, say who and when."
        busy={busy}
        sendLabel="Send answer"
        onSend={(text) => onAnswer(text, "revised")}
        extra={
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAnswer(NOTHING_TO_SAY, "revised")}>
              Nothing to say
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAnswer(answerText.deferred, "deferred")}>
              I don't know
            </Button>
          </>
        }
      />
      <Text size="caption" tone="subtle">
        “Nothing to say” is recorded, so it is not asked again. “I don't know” leaves it unanswered for now.
      </Text>
    </section>
  );
}

/**
 * Claude Code cannot run the conversation here: it happens in Claude Code instead, with the host's own command. The
 * needs beside it can still be added and changed by hand.
 */
function ContinueInClaudeCode({ reason }: { reason: string | null }) {
  const [command, setCommand] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadSession().then(
      (session) => live && setCommand(needsCommand(session.capabilities.needs_command)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="flex max-w-reading flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Heading level={3} size="title-3">
          Continue this conversation in Claude Code
        </Heading>
        <Text tone="muted">
          The conversation cannot run inside Product Studio on this computer, so it happens in Claude Code instead. The needs it records appear here. You can also add and change needs here by hand.
        </Text>
      </div>
      {reason ? (
        <Banner tone="info" title="Why it is not available here">
          {reason}
        </Banner>
      ) : null}
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-body text-ink">
        <li>Open Claude Code in your project's folder.</li>
        <li>
          <span className="mb-2 block">Run this command:</span>
          {command ? (
            <CommandLine command={command} purpose="to talk through the technical needs in Claude Code" />
          ) : (
            <Text tone="muted">The host did not report the command. Ask Claude Code to talk through the technical needs with the product studio skill.</Text>
          )}
        </li>
        <li>Answer the questions there. Come back here to read and publish your needs.</li>
      </ol>
    </div>
  );
}
