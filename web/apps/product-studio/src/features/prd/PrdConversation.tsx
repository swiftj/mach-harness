import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleAlert, Square, WifiOff } from "lucide-react";
import { Banner, Button, CommandLine, ErrorState, Heading, LoadingState, RichText, Spinner, Text, Tooltip, describeError } from "@mach/ui";
import { loadSession } from "../../api/session";
import { ExploreTranscript } from "../shape/explore/ExploreTranscript";
import { ReplyField, conversationBusy, useNewestInView } from "../shape/explore/Conversation";
import type { ConversationController } from "./usePrdConversation";
import { prdCommand } from "./model";
import { TakeOverBanner } from "../../shared/TakeOverBanner";
import { ConversationProblem } from "../../shared/ConversationProblem";

/**
 * The PRD conversation (M19), inside the map part of a PRD's page: MACH reads the PRD, proposes its epics and thin
 * slices with the lines each rests on, and records the map once the person agrees. With no project yet it also suggests
 * a name, vision and outcomes, in its own words, which the person may write into the form on this page or not. Settling,
 * naming the product and making the drafts stay this page's own buttons; the conversation cannot do them.
 */
export function PrdConversation({ prdId, conv, hasMap }: { prdId: string; conv: ConversationController; hasMap: boolean }) {
  const busy = conversationBusy(conv);
  const transcript = conv.phase === "live" || conv.model.timeline.length > 0;
  const sectionRef = useRef<HTMLElement>(null);
  useNewestInView(sectionRef, `${conv.phase} ${conv.model.turn} ${conv.model.turnRunning} ${conv.model.awaiting ?? ""} ${conv.model.ended ? "ended" : ""}`);
  return (
    <section ref={sectionRef} aria-labelledby={`${prdId}-conversation-title`} className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Heading level={3} id={`${prdId}-conversation-title`}>
          {hasMap ? "Talk the map through again" : "The map, proposed by MACH"}
        </Heading>
        {conv.phase === "live" && !conv.model.ended ? <Acts conv={conv} busy={busy} /> : null}
      </div>
      {transcript ? <ExploreTranscript model={conv.model} onRetry={conv.model.lastReply && !busy ? () => conv.reply(conv.model.lastReply ?? "", "reply") : null} /> : null}
      <Current prdId={prdId} conv={conv} busy={busy} hasMap={hasMap} />
    </section>
  );
}

function Acts({ conv, busy }: { conv: ConversationController; busy: boolean }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <span className="mr-1 flex items-center gap-2 text-body-sm text-ink-muted" role="status" aria-live="polite">
        {conv.model.connection === "reconnecting" ? (
          <>
            <WifiOff aria-hidden="true" className="size-4 text-warning-ink" />
            Reconnecting
          </>
        ) : busy ? (
          <>
            <Spinner size="sm" />
            <span className="max-w-56 truncate">{conv.model.lastActivity ?? "Working on a reply"}</span>
          </>
        ) : (
          "Waiting for you"
        )}
      </span>
      {busy ? (
        <Button variant="secondary" size="sm" loading={conv.sending === "interrupt"} onClick={conv.interrupt}>
          <Square aria-hidden="true" />
          Interrupt
        </Button>
      ) : null}
      <Tooltip content="Ends the conversation now. A map already recorded stays; you can talk again later.">
        <Button variant="ghost" size="sm" loading={conv.sending === "stop"} onClick={conv.stop}>
          Stop
        </Button>
      </Tooltip>
    </div>
  );
}

function Current({ prdId, conv, busy, hasMap }: { prdId: string; conv: ConversationController; busy: boolean; hasMap: boolean }) {
  const { model } = conv;
  switch (conv.phase) {
    case "loading":
      return <LoadingState label="Connecting to the conversation" />;
    case "starting":
      return <LoadingState label={`Starting the conversation. MACH reads ${prdId} first, so its proposal takes about 20 seconds.`} />;
    case "unavailable":
      return <InClaudeCode prdId={prdId} reason={conv.capability?.reason ?? null} />;
    case "conflict":
      return <TakeOverBanner conv={conv} subject={prdId} />;
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
          {error?.kind === "unavailable" ? <InClaudeCode prdId={prdId} reason={null} /> : null}
        </div>
      );
    }
    case "idle": {
      const before = Boolean(conv.summary) || model.timeline.length > 0;
      return (
        <div className="flex max-w-reading flex-col items-start gap-4">
          <Text tone="muted">
            {hasMap
              ? "Ask MACH for a different map if this one is not right. Until the drafts are made, a map it records replaces this one."
              : `MACH reads ${prdId} and proposes its epics and thin slices, each with the lines it rests on. You talk it through here; it records the map only when you agree.`}
          </Text>
          <Button variant={hasMap ? "secondary" : "primary"} onClick={conv.start}>
            {before ? "Continue the conversation" : hasMap ? "Ask for a different map" : "Ask MACH for a map"}
          </Button>
        </div>
      );
    }
    case "live":
      break;
  }

  const awaiting = model.awaiting ? model.messages[model.awaiting] : null;
  const streaming = Object.values(model.messages).find((m) => !m.final && m.text);
  let body: ReactNode;
  if (model.ended) {
    body = (
      <Banner
        tone={model.ended.reason === "failed" ? "danger" : "info"}
        title={model.ended.reason === "failed" ? "The conversation stopped because of a problem" : "Conversation stopped"}
        actions={
          <Button variant="secondary" onClick={conv.start}>
            Continue the conversation
          </Button>
        }
      >
        A map already recorded stays as it is.
      </Banner>
    );
  } else if (busy) {
    body = (
      <div className="flex flex-col gap-4">
        <p className="flex items-center gap-2 text-body text-ink-muted">
          <Spinner size="sm" />
          {model.lastActivity ?? "MACH is working on a reply"}
        </p>
        {streaming ? <RichText text={streaming.text} editorial className="text-ink-muted" /> : null}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-5">
        {awaiting ? (
          <div className="flex flex-col gap-2">
            <span className="text-body-sm text-ink-muted">MACH said</span>
            <RichText text={awaiting.text} editorial className="text-ink" />
          </div>
        ) : null}
        <ReplyField
          key={model.awaiting ?? "free"}
          label="Your reply"
          hint="Say what to change, or that it may record the map."
          focusOnMount={Boolean(awaiting)}
          busy={conv.sending === "reply"}
          onSend={(text) => conv.reply(text, "reply")}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {conv.problem ? <ConversationProblem problem={conv.problem} /> : null}
      {body}
    </div>
  );
}

/** Claude Code cannot run the conversation here: the map is proposed in Claude Code instead, and appears on this page. */
function InClaudeCode({ prdId, reason }: { prdId: string; reason: string | null }) {
  const [command, setCommand] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadSession().then(
      (session) => live && setCommand(prdCommand(session.capabilities.continue_command, prdId)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [prdId]);
  return (
    <div className="flex max-w-reading flex-col gap-4">
      <Text tone="muted">
        The conversation cannot run inside Product Studio on this computer, so MACH proposes the map in Claude Code instead. The map it records appears here.
      </Text>
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
            <CommandLine command={command} purpose={`to have MACH propose a map of ${prdId}`} />
          ) : (
            <Text tone="muted">Ask Claude Code to propose a map of {prdId} with the product studio skill.</Text>
          )}
        </li>
        <li>Agree the map there. Come back here to settle what it leaves out and make the drafts.</li>
      </ol>
    </div>
  );
}
