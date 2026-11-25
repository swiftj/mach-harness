import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toInterviewEvent, type InterviewClient, type InterviewHistory, type InterviewSummary, type MachApiError, type StartOptions, type StartResult } from "@mach/ui/api";
import { interviewCapability, loadSession, toApiError, type InterviewCapability } from "../api/session";
import { initialModel, interviewReducer, type AnswerKind, type InterviewModel } from "../features/interview/model";

/**
 * One guided conversation with Claude Code, through the host: the slice interview (subject SLICE-NNN) and Shape's
 * conversation on one idea (subject IDEA-NNN) are the same thing over two clients, so they are driven by this one hook:
 * the capability, the saved history, re-attaching after a reload, joining a conversation this host already runs, reply,
 * interrupt and stop, all into the interview's own model.
 */
export type ConversationPhase =
  /** Asking the host whether conversations can run and whether this subject has one. */
  | "loading"
  /** The host cannot run them (`capabilities.interview: false`). */
  | "unavailable"
  /** None is running for this subject; the person can start or continue one. */
  | "idle"
  | "starting"
  | "live"
  /** Another window or host holds this subject's conversation: `takeOverWarning` says so, and `takeOver` continues here. */
  | "conflict"
  /** The host or engine refused to start (an approved slice, an idea shaped into work). */
  | "refused"
  | "error";

export interface ConversationController {
  phase: ConversationPhase;
  capability: InterviewCapability | null;
  summary: InterviewSummary | null;
  model: InterviewModel;
  /** A failure starting, reading or acting; shown in the host's or engine's words. */
  problem: MachApiError | null;
  /** True while a reply, an interrupt or a stop is on its way to the host. */
  sending: "reply" | "interrupt" | "stop" | null;
  start: () => void;
  /** While `conflict`: the host's warning about the other writer, shown before the one action that continues here. */
  takeOverWarning: string | null;
  /** Continue here although another window holds the conversation (the host warned first). */
  takeOver: () => void;
  reply: (text: string, answer: AnswerKind) => void;
  interrupt: () => void;
  stop: () => void;
  retryLoad: () => void;
}

/** What the hook needs of a client: the slice interview's and the idea conversation's both are this, by their subject. */
export interface ConversationClient extends Pick<InterviewClient, "subscribe" | "reply" | "interrupt" | "stop"> {
  current(subject: string, signal?: AbortSignal): Promise<InterviewSummary | null>;
  history(subject: string, signal?: AbortSignal): Promise<InterviewHistory>;
  start(subject: string, options?: StartOptions): Promise<StartResult>;
}

export interface ConversationSource {
  /**
   * The client, resolved once per load: lazily, so a development client loaded under `vite --mode fixtures` stays out
   * of the production bundle. Keep it stable (a module-level function), as it is a dependency of the load.
   */
  load: () => Promise<ConversationClient>;
  /** The word errors are named with ("interview", "conversation"). */
  label: string;
  /** Called once the conversation is started or joined (the slice forgets the idea typed in "Start a slice"). */
  started?: (subject: string) => void;
}

export function useConversation(subject: string, source: ConversationSource): ConversationController {
  const { load, label, started } = source;
  const [model, dispatch] = useReducer(interviewReducer, initialModel);
  const [phase, setPhase] = useState<ConversationPhase>("loading");
  const [capability, setCapability] = useState<InterviewCapability | null>(null);
  const [summary, setSummary] = useState<InterviewSummary | null>(null);
  const [problem, setProblem] = useState<MachApiError | null>(null);
  const [sending, setSending] = useState<ConversationController["sending"]>(null);
  const [loadTick, setLoadTick] = useState(0);
  const clientRef = useRef<ConversationClient | null>(null);
  const idRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const attach = useCallback((client: ConversationClient, interviewId: string) => {
    unsubscribeRef.current?.();
    idRef.current = interviewId;
    dispatch({ type: "attached", interviewId });
    setPhase("live");
    unsubscribeRef.current = client.subscribe(interviewId, {
      onEvent: (event) => dispatch({ type: "event", event }),
      onConnection: (state) => dispatch({ type: "connection", state }),
    });
  }, []);

  // Load: capability, the saved conversation, then whether one is running. Re-attaches after a reload or restart.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const [client, session] = await Promise.all([load(), loadSession()]);
        if (cancelled) return;
        clientRef.current = client;
        const cap = interviewCapability(session);
        setCapability(cap);
        // The saved conversation: restores the transcript and the decisions after a reload or a host restart. An older
        // host without the route shows nothing earlier, as before.
        try {
          const history = await client.history(subject, controller.signal);
          if (cancelled) return;
          const events = history.events.flatMap((saved) => {
            const event = toInterviewEvent(saved.event, saved.data);
            return event ? [{ event, interviewId: saved.interview_id }] : [];
          });
          dispatch({ type: "history", events, truncated: history.truncated });
        } catch (cause) {
          const error = toApiError(cause, `${label}.history`);
          if (error.kind === "aborted") return;
          if (error.kind !== "invalid" && error.kind !== "protocol") throw error;
        }
        if (!cap.available) {
          setPhase("unavailable");
          return;
        }
        let found: InterviewSummary | null = null;
        try {
          found = await client.current(subject, controller.signal);
        } catch (cause) {
          const error = toApiError(cause, `${label}.current`);
          if (error.kind === "aborted") return;
          // An older host without the lookup route: treat as "nothing running" and let Start decide.
          if (error.kind !== "invalid" && error.kind !== "protocol") throw error;
        }
        if (cancelled) return;
        setSummary(found);
        if (found?.locked_elsewhere) setPhase("conflict");
        else if (found?.live && found.interview_id) attach(client, found.interview_id);
        else setPhase("idle");
      } catch (cause) {
        if (cancelled) return;
        const error = toApiError(cause, label);
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
  }, [subject, loadTick, attach, load, label]);

  const begin = useCallback(
    (options?: StartOptions) => {
    const client = clientRef.current;
    if (!client) return;
    setPhase("starting");
    setProblem(null);
    client.start(subject, options).then(
      (result) => {
        started?.(subject);
        attach(client, result.interview_id);
      },
      (cause: unknown) => {
        const error = toApiError(cause, `${label}.start`);
        // This host already runs the conversation (another tab, or this window before a reload): the hint names it,
        // so join it instead of refusing.
        if (error.kind === "conflict" && error.hint?.kind === "open_interview" && error.hint.target) {
          started?.(subject);
          attach(client, error.hint.target);
          return;
        }
        setProblem(error);
        setPhase(error.kind === "conflict" ? "conflict" : error.kind === "refused" ? "refused" : "error");
      },
    );
  },
    [subject, attach, label, started],
  );
  const start = useCallback(() => begin(), [begin]);
  const takeOver = useCallback(() => begin({ takeOver: true }), [begin]);

  const reply = useCallback(
    (text: string, answer: AnswerKind) => {
      const client = clientRef.current;
      const id = idRef.current;
      const trimmed = text.trim();
      if (!client || !id || !trimmed) return;
      setProblem(null);
      setSending("reply");
      dispatch({ type: "replied", text: trimmed, answer });
      client.reply(id, trimmed).then(
        () => setSending(null),
        (cause: unknown) => {
          setSending(null);
          dispatch({ type: "reply-failed" });
          setProblem(toApiError(cause, `${label}.reply`));
        },
      );
    },
    [label],
  );

  const act = useCallback(
    (what: "interrupt" | "stop") => {
      const client = clientRef.current;
      const id = idRef.current;
      if (!client || !id) return;
      setSending(what);
      client[what](id).then(
        () => setSending(null),
        (cause: unknown) => {
          setSending(null);
          setProblem(toApiError(cause, `${label}.${what}`));
        },
      );
    },
    [label],
  );
  const interrupt = useCallback(() => act("interrupt"), [act]);
  const stop = useCallback(() => act("stop"), [act]);

  const retryLoad = useCallback(() => {
    dispatch({ type: "reset" });
    setPhase("loading");
    setProblem(null);
    setSummary(null);
    setLoadTick((t) => t + 1);
  }, []);

  // The host's warning: from the refused start when there was one, else from the lookup that found the lock held.
  const takeOverWarning =
    phase !== "conflict" ? null : problem?.kind === "conflict" && problem.hint?.kind === "take_over" ? problem.message : (summary?.take_over_warning ?? null);

  return { phase, capability, summary, model, problem, sending, start, takeOverWarning, takeOver, reply, interrupt, stop, retryLoad };
}
