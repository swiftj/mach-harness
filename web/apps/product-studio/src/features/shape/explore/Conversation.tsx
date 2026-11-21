import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router";
import { CircleAlert, Compass, MessagesSquare, Pause, Send, Square, WifiOff } from "lucide-react";
import { Banner, Button, EmptyState, ErrorState, Field, Heading, HintAction, Kbd, LoadingState, RichText, Spinner, Text, Textarea, Tooltip, describeError, toast } from "@mach/ui";
import type { IdeaRow } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { answerText, isBusy } from "../../interview/model";
import { ideaPath } from "../shell/steps";
import { ContinueInTerminal } from "./ContinueInTerminal";
import { ExploreTranscript } from "./ExploreTranscript";
import { exploreMode, openQuestion } from "./model";
import type { ConversationController } from "./useIdeaConversation";

const PAUSE_REQUEST = "I need to stop here. Please save where we are so I can continue later.";

/** True while a turn runs: the conversation is writing, and the idea's acts wait. */
export function conversationBusy(conv: ConversationController): boolean {
  return conv.phase === "live" && !conv.model.ended && (conv.model.turnRunning || isBusy(conv.model.hostState));
}

/**
 * The guided conversation about one idea: open questions, one at a time, answered in the product manager's own words.
 * It runs through the Shape conversation exactly as the slice interview runs (same phases, events and model). It can
 * write this idea's brief and case and record what it looked up; it cannot set the stage, so "Start exploring" is its
 * own act here, offered while the idea is New.
 */
export function Conversation({ conv, row }: { conv: ConversationController; row: IdeaRow }) {
  const busy = conversationBusy(conv);
  const mode = exploreMode(row);
  const shaped = mode === "shaped" && conv.phase !== "live";
  const transcript = conv.phase === "live" || conv.model.timeline.length > 0;
  const sectionRef = useRef<HTMLElement>(null);
  // A new turn, a new question, a reply sent or the conversation ending brings the pane back to its end.
  useNewestInView(sectionRef, `${conv.phase} ${conv.model.turn} ${conv.model.turnRunning} ${conv.model.awaiting ?? ""} ${conv.model.ended ? "ended" : ""}`);
  return (
    <section ref={sectionRef} aria-labelledby="conversation-title" className="flex min-w-0 flex-col gap-6">
      {/* The heading and the conversation's own acts stay at the top of its pane while the turns scroll under them. */}
      <div className="sticky -top-6 z-10 -mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line bg-canvas pb-3 pt-5 max-[1023px]:static [@media(max-height:619px)]:static">
        <Heading level={2} size="title-3" id="conversation-title">
          The conversation
        </Heading>
        <ConversationActions conv={conv} busy={busy} />
      </div>
      {mode === "new" ? <StartExploring row={row} busy={busy} /> : null}
      {shaped ? (
        <Banner
          tone="info"
          title="This idea is shaped into work"
          actions={
            <Button variant="secondary" asChild>
              <Link to={ideaPath(row.idea_id, "look-back")}>Go to Look back</Link>
            </Button>
          }
        >
          Its brief stays as it was when its slices were made, so there is no conversation to continue here. What was said and looked up is kept.
        </Banner>
      ) : null}
      {transcript ? <ExploreTranscript model={conv.model} onRetry={conv.model.lastReply && !busy ? () => conv.reply(conv.model.lastReply ?? "", "reply") : null} /> : null}
      {shaped ? null : (
        <Current conv={conv} busy={busy} row={row} />
      )}
    </section>
  );
}

/**
 * The newest turn stays in view (M16 layout): the conversation reads oldest first and ends with what is asked now, and
 * its pane is kept at its end while the conversation grows, unless the person has scrolled up to read; a new question
 * brings it back to the end. Only the conversation's own pane scrolls, never the page: where the window is too small
 * for panes, nothing is moved.
 */
function useNewestInView(ref: RefObject<HTMLElement | null>, turn: string) {
  const pinned = useRef(true);
  useEffect(() => {
    const node = ref.current;
    const pane = node?.closest<HTMLElement>("[data-pane]");
    if (!node || !pane) return;
    const toEnd = () => {
      if (pinned.current && getComputedStyle(pane).overflowY !== "visible") pane.scrollTop = pane.scrollHeight;
    };
    // Only the person scrolling up lets go of the end; growth and the pane's own move to the end never do.
    let last = pane.scrollTop;
    const onScroll = () => {
      const atEnd = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;
      pinned.current = atEnd || (pinned.current && pane.scrollTop >= last);
      last = pane.scrollTop;
    };
    pane.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(toEnd);
    observer?.observe(node);
    return () => {
      pane.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [ref]);
  useEffect(() => {
    const pane = ref.current?.closest<HTMLElement>("[data-pane]");
    if (!pane || getComputedStyle(pane).overflowY === "visible") return;
    pinned.current = true;
    pane.scrollTop = pane.scrollHeight;
  }, [ref, turn]);
}

/** "Start exploring": the one stage set by hand, from New. The engine refuses it in its own words when it cannot. */
function StartExploring({ row, busy }: { row: IdeaRow; busy: boolean }) {
  const act = useEngineAct();
  const run = async () => {
    const result = await act.run("idea.stage", { idea_id: row.idea_id, stage: "exploring" });
    if (result) toast({ tone: "success", title: `Started exploring ${row.idea_id}` });
  };
  return (
    <div className="flex flex-col gap-4 rounded-md border border-line bg-surface px-5 py-5">
      <div className="flex flex-col gap-1.5">
        <Heading level={3} size="title-3">
          This idea is New
        </Heading>
        <Text tone="muted">
          Starting to explore it moves it to Exploring on the board. The conversation then asks open questions, one at a time, and writes your brief from your answers.
        </Text>
      </div>
      {act.shown ? (
        <Banner tone="danger" title={act.shown.title} live="polite" actions={act.shown.hint ? <HintAction hint={act.shown.hint} /> : undefined}>
          {act.shown.message}
        </Banner>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" loading={act.pending} disabled={busy} onClick={() => void run()}>
          <Compass aria-hidden="true" />
          Start exploring
        </Button>
        {busy ? (
          <Text size="body-sm" tone="muted">
            Waits until the conversation has finished writing.
          </Text>
        ) : null}
      </div>
    </div>
  );
}

function ConversationActions({ conv, busy }: { conv: ConversationController; busy: boolean }) {
  if (conv.phase !== "live" || conv.model.ended) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <StatusLine conv={conv} busy={busy} />
      {busy ? (
        <Button variant="secondary" size="sm" loading={conv.sending === "interrupt"} onClick={conv.interrupt}>
          <Square aria-hidden="true" />
          Interrupt
        </Button>
      ) : (
        <Tooltip content="Asks MACH to save what is written so far and the next question, then wait.">
          <Button variant="secondary" size="sm" disabled={conv.sending !== null} onClick={() => conv.reply(PAUSE_REQUEST, "reply")}>
            <Pause aria-hidden="true" />
            Save and pause
          </Button>
        </Tooltip>
      )}
      <Tooltip content="Ends the conversation now. Your brief, your case and what was looked up stay; you can continue later.">
        <Button variant="ghost" size="sm" loading={conv.sending === "stop"} onClick={conv.stop}>
          Stop
        </Button>
      </Tooltip>
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

/** What the product manager answers now: the open question, MACH's latest reply, or how to start. */
function Current({ conv, busy, row }: { conv: ConversationController; busy: boolean; row: IdeaRow }) {
  const { model } = conv;
  switch (conv.phase) {
    case "loading":
      return <LoadingState label="Connecting to the conversation" />;
    case "starting":
      return <LoadingState label="Starting the conversation. The first question takes about 20 seconds while MACH reads your project and the idea." />;
    case "unavailable":
      return conv.capability ? <ContinueInTerminal ideaId={row.idea_id} capability={conv.capability} /> : null;
    case "conflict":
      return (
        <Banner tone="warning" title="The conversation cannot be opened here" actions={<Button onClick={conv.retryLoad}>Check again</Button>}>
          {conv.problem?.kind === "conflict" ? conv.problem.message : "Another window or process holds this idea's conversation."}
        </Banner>
      );
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
          {/* Claude Code cannot run it here (fixture mode says so too): the terminal is the honest way on. */}
          {error?.kind === "unavailable" && conv.capability ? <ContinueInTerminal ideaId={row.idea_id} capability={conv.capability} /> : null}
        </div>
      );
    }
    case "idle":
      return <StartPanel conv={conv} row={row} />;
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
        Your brief, your case and what was looked up remain. Continuing picks up from them.
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
      {/* A notice that ended the last turn is the transcript's last line, directly above: it is not repeated here. */}
      {conv.problem ? (
        <Banner
          tone="danger"
          title={conv.problem.kind === "conflict" ? "MACH is still working on a reply" : describeError(conv.problem).title}
          actions={conv.problem.hint ? <HintAction hint={conv.problem.hint} /> : undefined}
        >
          {conv.problem.kind === "conflict" ? "Wait for it to finish, or interrupt it." : conv.problem.message}
        </Banner>
      ) : null}
      {body}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

function StartPanel({ conv, row }: { conv: ConversationController; row: IdeaRow }) {
  const before = Boolean(conv.summary) || conv.model.timeline.length > 0;
  const waitingForStage = row.stage === "new";
  return (
    <EmptyState
      icon={<MessagesSquare />}
      title={before ? "Continue the conversation" : "Start the conversation"}
      description={
        waitingForStage
          ? "Once you start exploring, MACH asks open questions here, one at a time. There is no recommended answer: the answers are yours."
          : before
            ? "MACH picks up from your brief and what it looked up, and asks the next open question."
            : "MACH asks open questions, one at a time, and looks facts up rather than asking you. It reads your project first, so the first question takes about 20 seconds."
      }
      action={
        waitingForStage ? undefined : (
          <Button variant="primary" size="lg" onClick={conv.start}>
            {before ? "Continue the conversation" : "Start the conversation"}
          </Button>
        )
      }
    />
  );
}

/** The open question being asked: its number and topic, the question in large type, and the answer in the PM's own words. */
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
  // Each question mounts a fresh card (keyed by its message); focus lands on it, as the interview's does.
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
        hint="In your own words. MACH writes it into your brief and asks the next question."
        busy={busy}
        sendLabel="Send answer"
        onSend={(text) => onAnswer(text, "revised")}
        extra={
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAnswer(answerText.deferred, "deferred")}>
            I don't know
          </Button>
        }
      />
      <Text size="caption" tone="subtle">
        “I don't know” ends that line of questions; it goes into your brief as an open question.
      </Text>
    </section>
  );
}

/** A free answer, sent with the button or Ctrl+Enter (the interview's Composer, with Shape's words). */
function ReplyField({
  label,
  hint,
  busy,
  onSend,
  sendLabel = "Send reply",
  focusOnMount = false,
  extra,
}: {
  label: string;
  hint?: string;
  busy: boolean;
  onSend: (text: string) => void;
  sendLabel?: string;
  focusOnMount?: boolean;
  extra?: ReactNode;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  const send = () => {
    if (!text.trim() || busy) return;
    onSend(text);
    setText("");
  };
  return (
    <div className="flex flex-col gap-2">
      <Field label={label} hint={hint}>
        <Textarea
          ref={ref}
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-3">
          {extra}
          <span className="flex items-center gap-1 text-caption text-ink-subtle">
            <Kbd>Ctrl</Kbd>
            <span aria-hidden="true">+</span>
            <Kbd>Enter</Kbd>
            <span>sends</span>
          </span>
        </span>
        <Button variant="primary" disabled={!text.trim()} loading={busy} onClick={send}>
          <Send aria-hidden="true" />
          {sendLabel}
        </Button>
      </div>
    </div>
  );
}

