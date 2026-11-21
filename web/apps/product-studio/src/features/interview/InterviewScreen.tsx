import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ArrowLeft, CircleAlert, MessagesSquare, Pause, SearchX, Square, Users, WifiOff } from "lucide-react";
import {
  ArtifactId,
  Badge,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Heading,
  HintAction,
  LoadingState,
  Page,
  RichText,
  SliceLifecycle,
  Spinner,
  Text,
  Tooltip,
  describeError,
  plural,
} from "@mach/ui";
import { ENGINE_ID as SLICE_ID, type SliceShow } from "@mach/ui/api";
import { Composer } from "./Composer";
import { ContinueInClaudeCode } from "./ContinueInClaudeCode";
import { isBusy, type Decision } from "./model";
import { QuestionCard } from "./QuestionCard";
import { SliceSoFar } from "./SliceDocument";
import { SummaryCard } from "./SummaryCard";
import { Transcript } from "./Transcript";
import { useInterview, type InterviewController } from "./useInterview";
import { useSliceShow } from "../../api/useSliceShow";
import { useStatus } from "../../api/store";
import { MarkReadyDialog } from "../spec/SliceActs";
import { BuildersQuestion } from "../../shared/BuildersQuestion";
import { Fold } from "../../shared/layout/Fold";
import { ContextRow, WorkPane, WorkPanes, WorkScreen } from "../../shared/layout/WorkScreen";

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

/**
 * The interview, with room to breathe: the question takes the larger half (where it stands, the
 * question in large type, the recommendation, the ways to answer, what is settled so far); the
 * slice builds up beside it as a document. When the engine's check says the slice is ready, the
 * approval act takes the question's place.
 */
function InterviewWorkspace({ sliceId }: { sliceId: string }) {
  const show = useSliceShow(sliceId);
  const status = useStatus();
  const iv = useInterview(sliceId);
  const { model } = iv;
  // Reached from "Answer it": start (or join) the interview at once; the host opens a turn on the builders' question.
  const answering = Boolean((useLocation().state as { answer?: boolean } | null)?.answer);
  const started = useRef(false);
  useEffect(() => {
    if (answering && (iv.phase === "idle" || iv.phase === "live") && !started.current) {
      started.current = true;
      iv.start();
    }
  }, [answering, iv]);

  // Reload the validated draft when the host reports a write. Several arrive close together.
  const reload = show.reload;
  useEffect(() => {
    if (!model.draftChanges) return;
    const timer = setTimeout(reload, 400);
    return () => clearTimeout(timer);
  }, [model.draftChanges, reload]);

  const title = show.data?.slice.title ?? sliceId;
  const epicId = show.data?.slice.epic_id;
  const epicTitle = status.data?.epics.find((e) => e.epic_id === epicId)?.title ?? null;
  const busy = iv.phase === "live" && !model.ended && (model.turnRunning || isBusy(model.hostState));

  // The newest turn stays in view: when the question, the reply or the working state changes, the conversation pane
  // (never the page) scrolls back to it if the person had scrolled away.
  const current = useRef<HTMLDivElement | null>(null);
  const turnKey = `${iv.phase}:${model.awaiting ?? ""}:${busy ? "busy" : "idle"}:${model.ended ? "ended" : ""}`;
  useLayoutEffect(() => {
    const node = current.current;
    const pane = node?.closest<HTMLElement>("[data-pane]");
    if (!node || !pane || getComputedStyle(pane).overflowY === "visible") return;
    const top = node.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    if (top < 0 || top > pane.clientHeight * 0.6) pane.scrollTop += top - 24;
  }, [turnKey]);

  // The window is the desk (M16 layout): the slim context row, then the conversation and the slice so far side by side,
  // each scrolling on its own (8.10's columns).
  return (
    <WorkScreen
      header={
        <ContextRow
          identity={
            <>
              <Link to={`/slices/${sliceId}`} className="inline-flex shrink-0 items-center gap-1 rounded-xs text-body-sm text-accent-ink hover:underline">
                <ArrowLeft aria-hidden="true" className="size-4" />
                Specification
              </Link>
              <ArtifactId>{sliceId}</ArtifactId>
              {epicTitle ? <span>in {epicTitle}</span> : null}
            </>
          }
          title={`Interview: ${title}`}
          trail={show.data ? <SliceLifecycle status={show.data.slice.status} openQuestions={show.data.check.open_questions.length} className="max-w-full" /> : undefined}
          actions={iv.phase === "live" && !model.ended ? <InterviewActions iv={iv} busy={busy} /> : undefined}
        />
      }
    >
      <WorkPanes split="conversation">
        <WorkPane label="Interview" width="column">
          <div className="flex flex-col gap-10 py-4">
            {show.data ? <BuildersQuestion github={show.data.github} /> : null}
            <div ref={current} className="flex scroll-mt-6 flex-col gap-10">
              <Current iv={iv} busy={busy} sliceId={sliceId} show={show.data} onApproved={show.reload} />
            </div>
            <Settled decisions={model.decisions} />
            {iv.phase === "live" && model.timeline.length ? (
              <Fold label={`The whole conversation: ${plural(model.timeline.filter((item) => item.type === "message").length, "message")}`}>
                <Transcript model={model} onRetry={model.lastReply && !busy ? () => iv.reply(model.lastReply ?? "", "reply") : null} />
              </Fold>
            ) : null}
          </div>
        </WorkPane>
        <SliceSoFar sliceId={sliceId} show={show} epicTitle={epicTitle} />
      </WorkPanes>
    </WorkScreen>
  );
}

function InterviewActions({ iv, busy }: { iv: InterviewController; busy: boolean }) {
  if (iv.phase !== "live" || iv.model.ended) return null;
  return (
    <div className="flex shrink-0 items-center gap-2">
      <StatusLine iv={iv} busy={busy} />
      {busy ? (
        <Button variant="secondary" size="sm" loading={iv.sending === "interrupt"} onClick={iv.interrupt}>
          <Square aria-hidden="true" />
          Interrupt
        </Button>
      ) : (
        <Tooltip content="Asks the interviewer to save what is settled and the next question, then wait.">
          <Button variant="secondary" size="sm" disabled={iv.sending !== null} onClick={() => iv.reply(PAUSE_REQUEST, "reply")}>
            <Pause aria-hidden="true" />
            Save and pause
          </Button>
        </Tooltip>
      )}
      <Tooltip content="Ends the interview now. Your draft and the saved note stay; you can continue later.">
        <Button variant="ghost" size="sm" loading={iv.sending === "stop"} onClick={iv.stop}>
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

/** What the PM answers now: the question, the interviewer's latest reply, or the approval when nothing is open. */
function Current({ iv, busy, sliceId, show, onApproved }: { iv: InterviewController; busy: boolean; sliceId: string; show: SliceShow | null; onApproved: () => void }) {
  const { model } = iv;
  const ready = Boolean(show && show.check.ready && show.slice.status !== "approved_for_engineering" && show.slice.status !== "superseded");
  const approval = ready && show ? <ApprovalOffer show={show} onApproved={onApproved} /> : null;

  switch (iv.phase) {
    case "loading":
      return <LoadingState label="Connecting to the interviewer" />;
    case "starting":
      return <LoadingState label="Starting the interviewer. The first reply takes about 20 seconds while it reads your project." />;
    case "unavailable":
      return (
        <>
          {approval}
          {iv.capability ? <ContinueInClaudeCode sliceId={sliceId} capability={iv.capability} /> : null}
        </>
      );
    case "conflict":
      return (
        <Banner tone="warning" title="The interview cannot be opened here" actions={<Button onClick={iv.retryLoad}>Check again</Button>}>
          {/* The host's own words when it gave them; otherwise the fact the lookup reported. */}
          {iv.problem?.kind === "conflict" ? iv.problem.message : "Another process holds this slice's interview."}
        </Banner>
      );
    case "refused":
    case "error": {
      const error = iv.problem;
      const described = error ? describeError(error) : { title: "The interview could not start", message: "" };
      return (
        <ErrorState
          icon={<CircleAlert />}
          title={error?.kind === "refused" ? "The interview did not start" : described.title}
          message={error?.kind === "refused" ? error.message : described.message}
          hint={error?.hint}
          action={<Button onClick={iv.retryLoad}>Try again</Button>}
        />
      );
    }
    case "idle":
      return (
        <>
          {approval}
          <StartPanel
            iv={iv}
            editable={show?.editable ?? true}
            editRefusal={show?.edit_refusal ?? null}
            resumeNote={show?.resume_note ?? null}
            sliceId={sliceId}
            interviewedBefore={Boolean(show && show.slice.status !== "draft")}
            quiet={Boolean(approval)}
          />
        </>
      );
    case "live":
      break;
  }

  const awaiting = model.awaiting ? model.messages[model.awaiting] : null;
  const announce = awaiting?.question
    ? `Question ${awaiting.question.number}: ${awaiting.question.title}. Recommended: ${awaiting.question.recommendation}`
    : awaiting
      ? "The interviewer replied."
      : "";
  const last = model.timeline.at(-1);
  const streaming = Object.values(model.messages).find((m) => !m.final && m.text);

  let body: ReactNode;
  if (model.ended) {
    const reason = model.ended.reason;
    body = (
      <>
        {approval}
        <Banner
          tone={reason === "failed" ? "danger" : reason === "host_shutdown" ? "warning" : "info"}
          title={reason === "failed" ? "The interview stopped because of a problem" : reason === "host_shutdown" ? "Product Studio's host was stopped" : "Interview stopped"}
          actions={
            <Button variant={approval ? "secondary" : "primary"} onClick={iv.start}>
              Continue the interview
            </Button>
          }
        >
          Your draft and the saved note remain. Continuing picks up from them.
        </Banner>
      </>
    );
  } else if (awaiting?.question) {
    body = <QuestionCard key={awaiting.question.message_id} question={awaiting.question} busy={iv.sending === "reply"} onAnswer={iv.reply} />;
  } else if (busy) {
    // Keyed apart from the answering body below, so the whole of it (the summary card with it) is
    // replaced when a reply starts rather than patched in place: patching left the focused summary behind.
    body = (
      <div key="working" className="flex flex-col gap-4">
        <p className="flex items-center gap-2 text-body text-ink-muted">
          <Spinner size="sm" />
          {model.lastActivity ?? "The interviewer is working on a reply"}
        </p>
        {streaming ? <RichText text={streaming.text} editorial className="text-ink-muted" /> : null}
        <Text size="body-sm" tone="subtle">
          You can reply when the interviewer has finished. Interrupt it if it is going the wrong way.
        </Text>
      </div>
    );
  } else {
    const confirming = awaiting?.kind === "confirmation" && !approval;
    body = (
      <div key="answer" className="flex flex-col gap-6">
        {approval}
        {confirming ? (
          <SummaryCard key={model.awaiting} text={awaiting.text} busy={iv.sending === "reply"} onConfirm={() => iv.reply("Yes.", "accepted")} />
        ) : awaiting ? (
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-2 text-body-sm text-ink-muted">
              The interviewer
              {awaiting.kind === "confirmation" ? <Badge tone="info">Summary to confirm</Badge> : null}
            </span>
            <RichText text={awaiting.text} editorial className="text-ink" />
          </div>
        ) : null}
        <Composer
          key={model.awaiting ?? "free"}
          focusOnMount={Boolean(awaiting) && !approval && !confirming}
          busy={iv.sending === "reply"}
          label={approval ? "Or tell the interviewer what is missing" : confirming ? "Or say what is missing or needs refining" : "Your reply"}
          onSend={(text) => iv.reply(text, "reply")}
        />
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
      {last?.type === "notice" ? (
        <Banner
          tone={last.tone}
          title={last.title}
          actions={
            last.retry && model.lastReply && !busy ? (
              <Button size="sm" onClick={() => iv.reply(model.lastReply ?? "", "reply")}>
                Send again
              </Button>
            ) : undefined
          }
        >
          {last.text}
        </Banner>
      ) : null}
      {iv.problem ? (
        <Banner
          tone="danger"
          title={iv.problem.kind === "conflict" ? "The interviewer is still working on a reply" : describeError(iv.problem).title}
          actions={iv.problem.hint ? <HintAction hint={iv.problem.hint} /> : undefined}
        >
          {iv.problem.kind === "conflict" ? "Wait for it to finish, or interrupt it." : iv.problem.message}
        </Banner>
      ) : null}
      {body}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

/**
 * The engine reports the slice ready (its check passes, nothing open): marking it ready to build,
 * with what that does. The dialog says it again and the engine checks once more.
 */
function ApprovalOffer({ show, onApproved }: { show: SliceShow; onApproved: () => void }) {
  const navigate = useNavigate();
  return (
    <section aria-labelledby="approval-title" className="flex flex-col gap-5">
      <Heading level={2} size="title-1" id="approval-title">
        Nothing is left open. Read it through, then mark it ready to build.
      </Heading>
      <div className="flex flex-col gap-1 rounded-sm border-l-2 border-accent bg-accent-soft px-4 py-3">
        <p className="text-label text-accent-ink">What marking it ready does</p>
        <p className="text-body-lg text-ink">
          It saves the slice to the project on GitHub, under its epic, and tells the builders it is ready. It records that you approved exactly
          this text, which stays frozen until you reopen it.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <MarkReadyDialog
          show={show}
          primary
          onDone={() => {
            onApproved();
            void navigate("/");
          }}
        />
        <Button variant="secondary" asChild>
          <Link to="/">Keep it as a draft</Link>
        </Button>
      </div>
    </section>
  );
}

const decisionWords: Record<Decision["answer"], string> = {
  accepted: "Accepted",
  revised: "Your answer",
  deferred: "Left open",
  delegated: "Interviewer decides",
  explain: "Asked why",
  reply: "Replied",
};

/** The answers given so far in this conversation, latest last; all of them behind a disclosure. */
function Settled({ decisions }: { decisions: Decision[] }) {
  if (!decisions.length) return null;
  const recent = decisions.slice(-3);
  const row = (d: Decision) => (
    <li key={d.messageId} className="grid grid-cols-[minmax(0,1fr)_minmax(0,14rem)] gap-4 border-t border-line py-2.5 first:border-t-0">
      <span className="text-body-sm text-ink">{d.title}</span>
      <span className="flex flex-col items-end gap-0.5 text-right">
        <Badge tone={d.answer === "deferred" ? "warning" : d.answer === "revised" ? "info" : "neutral"}>{decisionWords[d.answer]}</Badge>
        <span className="line-clamp-2 text-caption text-ink-muted">{d.answer === "accepted" || d.answer === "delegated" ? (d.recommendation.split(/(?<=\.)\s+/)[0] ?? d.recommendation) : d.text}</span>
      </span>
    </li>
  );
  return (
    <section aria-labelledby="settled-title" className="flex flex-col gap-2 border-t border-line pt-6">
      <Heading level={2} size="title-3" id="settled-title">
        Settled so far
      </Heading>
      <ol>{recent.map(row)}</ol>
      {decisions.length > recent.length ? (
        <Fold label={`Show all ${decisions.length}`}>
          <ol>{decisions.map(row)}</ol>
        </Fold>
      ) : null}
      <Text size="caption" tone="subtle">
        Kept in this browser; question numbers restart each session. The slice beside this is the record.
      </Text>
    </section>
  );
}

function StartPanel({
  iv,
  editable,
  editRefusal,
  resumeNote,
  sliceId,
  interviewedBefore,
  quiet,
}: {
  iv: InterviewController;
  editable: boolean;
  editRefusal: string | null;
  resumeNote: string | null;
  sliceId: string;
  interviewedBefore: boolean;
  /** The approval is offered above: starting the interview again is the lesser choice. */
  quiet: boolean;
}) {
  const saved = Boolean(iv.summary) || Boolean(resumeNote) || interviewedBefore;
  if (!editable) {
    return (
      <Banner tone="info" title="This slice cannot be interviewed now" actions={<Button asChild><Link to={`/slices/${sliceId}`}>Open the specification</Link></Button>}>
        {editRefusal ?? "MACH reports that this slice cannot be edited."}
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
          <Button variant={quiet ? "secondary" : "primary"} size="lg" onClick={iv.start}>
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

