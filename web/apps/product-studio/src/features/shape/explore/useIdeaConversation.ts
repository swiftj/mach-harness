import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toInterviewEvent, type IdeaConversationClient, type InterviewSummary, type MachApiError } from "@mach/ui/api";
import { client } from "../../../api/client";
import { interviewCapability, loadSession, toApiError, type InterviewCapability } from "../../../api/session";
import { initialModel, interviewReducer, type AnswerKind, type InterviewModel } from "../../interview/model";

/**
 * The Shape conversation for one idea, driven exactly as the slice interview drives its own
 * (features/interview/useInterview.ts): the same phases, the same model (its reducer, reused as it is), the same
 * history, re-attach, join-on-conflict, reply, interrupt and stop. Only the client differs: `client.ideaConversation`,
 * named by the idea. Proposed for promotion with useInterview as one hook over either client (see the report).
 */
export type ConversationPhase = "loading" | "unavailable" | "idle" | "starting" | "live" | "conflict" | "refused" | "error";

export interface ConversationController {
  phase: ConversationPhase;
  capability: InterviewCapability | null;
  summary: InterviewSummary | null;
  model: InterviewModel;
  problem: MachApiError | null;
  sending: "reply" | "interrupt" | "stop" | null;
  start: () => void;
  reply: (text: string, answer: AnswerKind) => void;
  interrupt: () => void;
  stop: () => void;
  retryLoad: () => void;
}

export function useIdeaConversation(ideaId: string, conversations: IdeaConversationClient = client.ideaConversation): ConversationController {
  const [model, dispatch] = useReducer(interviewReducer, initialModel);
  const [phase, setPhase] = useState<ConversationPhase>("loading");
  const [capability, setCapability] = useState<InterviewCapability | null>(null);
  const [summary, setSummary] = useState<InterviewSummary | null>(null);
  const [problem, setProblem] = useState<MachApiError | null>(null);
  const [sending, setSending] = useState<ConversationController["sending"]>(null);
  const [loadTick, setLoadTick] = useState(0);
  const idRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const attach = useCallback(
    (interviewId: string) => {
      unsubscribeRef.current?.();
      idRef.current = interviewId;
      dispatch({ type: "attached", interviewId });
      setPhase("live");
      unsubscribeRef.current = conversations.subscribe(interviewId, {
        onEvent: (event) => dispatch({ type: "event", event }),
        onConnection: (state) => dispatch({ type: "connection", state }),
      });
    },
    [conversations],
  );

  // Load: capability, the saved conversation, then whether one is running for this idea.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const session = await loadSession();
        if (cancelled) return;
        const cap = interviewCapability(session);
        setCapability(cap);
        try {
          const history = await conversations.history(ideaId, controller.signal);
          if (cancelled) return;
          const events = history.events.flatMap((saved) => {
            const event = toInterviewEvent(saved.event, saved.data);
            return event ? [{ event, interviewId: saved.interview_id }] : [];
          });
          dispatch({ type: "history", events, truncated: history.truncated });
        } catch (cause) {
          const error = toApiError(cause, "conversation.history");
          if (error.kind === "aborted") return;
          if (error.kind !== "invalid" && error.kind !== "protocol") throw error;
        }
        if (!cap.available) {
          setPhase("unavailable");
          return;
        }
        let found: InterviewSummary | null = null;
        try {
          found = await conversations.current(ideaId, controller.signal);
        } catch (cause) {
          const error = toApiError(cause, "conversation.current");
          if (error.kind === "aborted") return;
          if (error.kind !== "invalid" && error.kind !== "protocol") throw error;
        }
        if (cancelled) return;
        setSummary(found);
        if (found?.locked_elsewhere) setPhase("conflict");
        else if (found?.live && found.interview_id) attach(found.interview_id);
        else setPhase("idle");
      } catch (cause) {
        if (cancelled) return;
        const error = toApiError(cause, "conversation");
        if (error.kind === "aborted") return;
        setProblem(error);
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      idRef.current = null;
    };
  }, [ideaId, loadTick, attach, conversations]);

  const start = useCallback(() => {
    setPhase("starting");
    setProblem(null);
    conversations.start(ideaId).then(
      (result) => attach(result.interview_id),
      (cause: unknown) => {
        const error = toApiError(cause, "conversation.start");
        // This host already runs the idea's conversation (another tab, or this window before a reload): join it.
        if (error.kind === "conflict" && error.hint?.kind === "open_interview" && error.hint.target) {
          attach(error.hint.target);
          return;
        }
        setProblem(error);
        setPhase(error.kind === "conflict" ? "conflict" : error.kind === "refused" ? "refused" : "error");
      },
    );
  }, [ideaId, attach, conversations]);

  const reply = useCallback(
    (text: string, answer: AnswerKind) => {
      const id = idRef.current;
      const trimmed = text.trim();
      if (!id || !trimmed) return;
      setProblem(null);
      setSending("reply");
      dispatch({ type: "replied", text: trimmed, answer });
      conversations.reply(id, trimmed).then(
        () => setSending(null),
        (cause: unknown) => {
          setSending(null);
          dispatch({ type: "reply-failed" });
          setProblem(toApiError(cause, "conversation.reply"));
        },
      );
    },
    [conversations],
  );

  const interrupt = useCallback(() => {
    const id = idRef.current;
    if (!id) return;
    setSending("interrupt");
    conversations.interrupt(id).then(
      () => setSending(null),
      (cause: unknown) => {
        setSending(null);
        setProblem(toApiError(cause, "conversation.interrupt"));
      },
    );
  }, [conversations]);

  const stop = useCallback(() => {
    const id = idRef.current;
    if (!id) return;
    setSending("stop");
    conversations.stop(id).then(
      () => setSending(null),
      (cause: unknown) => {
        setSending(null);
        setProblem(toApiError(cause, "conversation.stop"));
      },
    );
  }, [conversations]);

  const retryLoad = useCallback(() => {
    dispatch({ type: "reset" });
    setPhase("loading");
    setProblem(null);
    setSummary(null);
    setLoadTick((t) => t + 1);
  }, []);

  return { phase, capability, summary, model, problem, sending, start, reply, interrupt, stop, retryLoad };
}
