import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, CircleAlert, MessagesSquare, Pause, SearchX, Square, Users, WifiOff } from "lucide-react";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, Heading, LoadingState, Page, SliceStatusPill, Spinner, Text, Tooltip, describeError, HintAction } from "@mach/ui";
import { Composer } from "./Composer";
import { ContinueInClaudeCode } from "./ContinueInClaudeCode";
import { isBusy } from "./model";
import { QuestionCard } from "./QuestionCard";
import { SpecPreview } from "./SpecPreview";
import { Transcript } from "./Transcript";
import { useInterview, type InterviewController } from "./useInterview";
import { ENGINE_ID as SLICE_ID } from "@mach/ui/api";
import { useSliceShow } from "../../api/useSliceShow";

const PAUSE_REQUEST = "I need to stop here. Please save where we are so I can continue later.";

export function InterviewScreen() {
  const { sliceId = "" } = useParams();
  if (!SLICE_ID.test(sliceId)) {
    return (
      <Page width="reading">
        <EmptyState layout="page" headingLevel={1} icon={<SearchX />} title="That is not a slice" description={`"${sliceId}" is not a slice ID such as SLICE-001.`} />
      </Page>
    );
  }
  return <InterviewWorkspace key={sliceId} sliceId={sliceId} />;
}

function InterviewWorkspace({ sliceId }: { sliceId: string }) {
  const show = useSliceShow(sliceId);
  const iv = useInterview(sliceId);
  const { model } = iv;

  // Reload the validated draft when the host reports a write. Several arrive close together.
  const reload = show.reload;
  useEffect(() => {
    if (!model.draftChanges) return;
    const timer = setTimeout(reload, 400);
    return () => clearTimeout(timer);
  }, [model.draftChanges, reload]);

  const title = show.data?.slice.title ?? sliceId;
  const busy = iv.phase === "live" && !model.ended && (model.turnRunning || isBusy(model.hostState));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 border-b border-line px-8 py-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2 text-body-sm text-ink-muted">
            <Link to={`/slices/${sliceId}`} className="inline-flex items-center gap-1 rounded-xs text-accent-ink hover:underline">
              <ArrowLeft aria-hidden="true" className="size-4" />
              Specification
            </Link>
            <span aria-hidden="true">/</span>
            <ArtifactId>{sliceId}</ArtifactId>
            {show.data ? <SliceStatusPill status={show.data.slice.status} size="sm" /> : null}
          </div>
          <Heading level={1} size="title-1" className="truncate">
            Interview: {title}
          </Heading>
        </div>
        <InterviewActions iv={iv} busy={busy} />
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(19rem,25rem)]">
        <Conversation iv={iv} busy={busy} sliceId={sliceId} editable={show.data?.editable ?? true} editRefusal={show.data?.edit_refusal ?? null} resumeNote={show.data?.resume_note ?? null} interviewedBefore={Boolean(show.data && show.data.slice.status !== "draft")} />
        <aside aria-label="Draft specification and decisions" className="min-h-0 overflow-y-auto border-l border-line bg-surface px-6 py-4">
          <SpecPreview sliceId={sliceId} show={show} decisions={model.decisions} />
        </aside>
      </div>
    </div>
  );
}

function InterviewActions({ iv, busy }: { iv: InterviewController; busy: boolean }) {
  if (iv.phase !== "live" || iv.model.ended) return null;
  return (
    <div className="flex shrink-0 items-center gap-2">
      <StatusLine iv={iv} busy={busy} />
      {busy ? (
        <Button variant="secondary" loading={iv.sending === "interrupt"} onClick={iv.interrupt}>
          <Square aria-hidden="true" />
          Interrupt
        </Button>
      ) : (
        <Tooltip content="Asks the interviewer to save what is settled and the next question, then wait.">
          <Button variant="secondary" disabled={iv.sending !== null} onClick={() => iv.reply(PAUSE_REQUEST, "reply")}>
            <Pause aria-hidden="true" />
            Save and pause
          </Button>
        </Tooltip>
      )}
      <Tooltip content="Ends the interview now. Your draft and the saved note stay; you can continue later.">
        <Button variant="ghost" loading={iv.sending === "stop"} onClick={iv.stop}>
          Stop
        </Button>
      </Tooltip>
    </div>
  );
}

/** One calm line: thinking and working are the same "working" state, so rapid flips never show. */
function StatusLine({ iv, busy }: { iv: InterviewController; busy: boolean }) {
  const { model } = iv;
  let content: ReactNode;
  if (model.connection === "reconnecting") {
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
        <span className="max-w-64 truncate">{model.lastActivity ?? "Working on a reply"}</span>
      </>
    );
  } else {
    content = <>Waiting for you</>;
  }
  return (
    <span className="mr-2 flex items-center gap-2 text-body-sm text-ink-muted" role="status" aria-live="polite">
      {content}
    </span>
  );
}

function Conversation({
  iv,
  busy,
  sliceId,
  editable,
  editRefusal,
  resumeNote,
  interviewedBefore,
}: {
  iv: InterviewController;
  busy: boolean;
  interviewedBefore: boolean;
  sliceId: string;
  editable: boolean;
  editRefusal: string | null;
  resumeNote: string | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const { model } = iv;
  const streamed = Object.values(model.messages).reduce((n, m) => n + m.text.length, 0);

  // A new entry or a new question always brings the end of the conversation into view; streamed
  // text follows only while the person has not scrolled up to read something earlier.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
    pinned.current = true;
  }, [model.timeline.length, model.awaiting, busy]);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [streamed]);

  const center = (children: ReactNode) => (
    <section aria-label="Conversation" className="min-h-0 overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-[46rem]">{children}</div>
    </section>
  );

  switch (iv.phase) {
    case "loading":
      return center(<LoadingState label="Connecting to the interviewer" />);
    case "starting":
      return center(<LoadingState label="Starting the interviewer. The first reply takes about 20 seconds while it reads your project." />);
    case "unavailable":
      return center(iv.capability ? <ContinueInClaudeCode sliceId={sliceId} capability={iv.capability} /> : null);
    case "conflict":
      return center(
        <Banner tone="warning" title="The interview cannot be opened here" actions={<Button onClick={iv.retryLoad}>Check again</Button>}>
          {/* The host's own words when it gave them; otherwise the fact the lookup reported. */}
          {iv.problem?.kind === "conflict" ? iv.problem.message : "Another process holds this slice's interview."}
        </Banner>,
      );
    case "refused":
    case "error": {
      const error = iv.problem;
      const described = error ? describeError(error) : { title: "The interview could not start", message: "" };
      return center(
        <ErrorState
          icon={<CircleAlert />}
          title={error?.kind === "refused" ? "The interview did not start" : described.title}
          message={error?.kind === "refused" ? error.message : described.message}
          hint={error?.hint}
          action={<Button onClick={iv.retryLoad}>Try again</Button>}
        />,
      );
    }
    case "idle":
      return center(<StartPanel iv={iv} editable={editable} editRefusal={editRefusal} resumeNote={resumeNote} sliceId={sliceId} interviewedBefore={interviewedBefore} />);
    case "live":
      break;
  }

  const awaiting = model.awaiting ? model.messages[model.awaiting] : null;
  const lastFinal = awaiting ?? null;
  const announce = lastFinal?.question
    ? `Question ${lastFinal.question.number}: ${lastFinal.question.title}. Recommended: ${lastFinal.question.recommendation}`
    : lastFinal
      ? "The interviewer replied."
      : "";

  return (
    <section aria-label="Conversation" className="flex min-h-0 flex-col">
      {/* The history scrolls on its own, so it must be reachable by keyboard (axe scrollable-region-focusable). */}
      <div
        ref={scroller}
        role="region"
        aria-label="Conversation history"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto px-8 py-6 focus-visible:outline-offset-[-2px]"
        onScroll={(event) => {
          const node = event.currentTarget;
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        <div className="mx-auto flex max-w-[46rem] flex-col gap-5">
          <Text size="caption" tone="subtle" className="border-b border-line pb-3">
            The interviewer asks one question at a time and proposes an answer. Nothing it says is approved: the specification beside this
            conversation is what the engine checked, and only you approve it.
          </Text>
          {model.connection === "reconnecting" ? (
            <Banner tone="warning" title="Connection to Product Studio lost. Reconnecting." live="polite">
              Nothing you said is lost. The conversation catches up when the connection returns.
            </Banner>
          ) : null}
          <Transcript model={model} onRetry={model.lastReply && !busy ? () => iv.reply(model.lastReply ?? "", "reply") : null} />
          {busy && !model.lastActivity && !Object.values(model.messages).some((m) => !m.final) ? (
            <p className="flex items-center gap-2 text-body-sm text-ink-muted">
              <Spinner size="sm" />
              The interviewer is working on a reply
            </p>
          ) : null}
        </div>
      </div>
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      <div className="shrink-0 border-t border-line bg-canvas px-8 py-4">
        <div className="mx-auto flex max-w-[46rem] flex-col gap-3">
          {iv.problem ? (
            <Banner
              tone="danger"
              title={iv.problem.kind === "conflict" ? "The interviewer is still working on a reply" : describeError(iv.problem).title}
              actions={iv.problem.hint ? <HintAction hint={iv.problem.hint} /> : undefined}
            >
              {iv.problem.kind === "conflict" ? "Wait for it to finish, or interrupt it." : iv.problem.message}
            </Banner>
          ) : null}
          <Dock iv={iv} busy={busy} />
        </div>
      </div>
    </section>
  );
}

function Dock({ iv, busy }: { iv: InterviewController; busy: boolean }) {
  const { model } = iv;
  if (model.ended) {
    const reason = model.ended.reason;
    return (
      <Banner
        tone={reason === "failed" ? "danger" : reason === "host_shutdown" ? "warning" : "info"}
        title={reason === "failed" ? "The interview stopped because of a problem" : reason === "host_shutdown" ? "Product Studio's host was stopped" : "Interview stopped"}
        actions={
          <Button variant="primary" onClick={iv.start}>
            Continue the interview
          </Button>
        }
      >
        Your draft and the saved note remain. Continuing picks up from them.
      </Banner>
    );
  }
  const awaiting = model.awaiting ? model.messages[model.awaiting] : null;
  if (awaiting?.question) {
    return <QuestionCard key={awaiting.question.message_id} question={awaiting.question} busy={iv.sending === "reply"} onAnswer={iv.reply} />;
  }
  if (busy) {
    return (
      <Text size="body-sm" tone="muted" className="py-2">
        You can reply when the interviewer has finished. Interrupt it if it is going the wrong way.
      </Text>
    );
  }
  return (
    <Composer
      key={model.awaiting ?? "free"}
      focusOnMount={Boolean(awaiting)}
      busy={iv.sending === "reply"}
      label={awaiting?.kind === "confirmation" ? "Does this capture the intent?" : "Your reply"}
      hint={awaiting?.kind === "confirmation" ? "Say yes to have the specification written up, or say what is missing." : undefined}
      onSend={(text) => iv.reply(text, "reply")}
    />
  );
}

function StartPanel({
  iv,
  editable,
  editRefusal,
  resumeNote,
  sliceId,
  interviewedBefore,
}: {
  iv: InterviewController;
  editable: boolean;
  editRefusal: string | null;
  resumeNote: string | null;
  sliceId: string;
  interviewedBefore: boolean;
}) {
  const saved = Boolean(iv.summary) || Boolean(resumeNote) || interviewedBefore;
  if (!editable) {
    return (
      <Banner tone="info" title="This slice cannot be interviewed now" actions={<Button asChild><Link to={`/slices/${sliceId}`}>Open the specification</Link></Button>}>
        {editRefusal ?? "The engine reports that this slice cannot be edited."}
      </Banner>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <EmptyState
        icon={saved ? <MessagesSquare /> : <Users />}
        title={saved ? "Continue the interview" : "Start the interview"}
        description={
          saved
            ? "The interviewer picks up from what is settled and asks the next question. Your earlier answers are already in the draft."
            : "The interviewer asks one yes-or-no question at a time, each with a recommended answer. It reads your project first, so the first question takes about 20 seconds."
        }
        action={
          <Button variant="primary" size="lg" onClick={iv.start}>
            {saved ? "Continue the interview" : "Start the interview"}
          </Button>
        }
      />
      {resumeNote ? (
        <Banner tone="info" title="Where you stopped last time">
          {resumeNote}
        </Banner>
      ) : null}
      {iv.summary?.last_message?.question ? (
        <Text size="body-sm" tone="muted">
          The last question asked was “{iv.summary.last_message.question.title}”. Continuing shows it again without starting a new reply.
        </Text>
      ) : null}
    </div>
  );
}
