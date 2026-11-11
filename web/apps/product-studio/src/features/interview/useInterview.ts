import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toInterviewEvent, type MachApiError, type InterviewClient, type InterviewSummary } from "@mach/ui/api";
import { client } from "../../api/client";
import { forgetIdea, peekIdea } from "../../api/pendingIdea";
import { initialModel, interviewReducer, type AnswerKind, type InterviewModel } from "./model";
import { interviewCapability, loadSession, toApiError, type InterviewCapability } from "../../api/session";

export type InterviewPhase =
  /** Asking the host whether interviews can run and whether this slice has one. */
  | "loading"
  /** The host cannot run interviews (`capabilities.interview: false`). */
  | "unavailable"
  /** No interview is running for this slice; the PM can start or continue one. */
  | "idle"
  | "starting"
  | "live"
  /** Another window or host holds this slice's interview. */
  | "conflict"
  /** The host or engine refused to start (an approved slice, for one). */
  | "refused"
  | "error";

export interface InterviewController {
  phase: InterviewPhase;
  capability: InterviewCapability | null;
  summary: InterviewSummary | null;
  model: InterviewModel;
  /** A failure starting, reading or acting; shown in the host's or engine's words. */
  problem: MachApiError | null;
  /** True while a reply, an interrupt or a stop is on its way to the host. */
  sending: "reply" | "interrupt" | "stop" | null;
  start: () => void;
  reply: (text: string, answer: AnswerKind) => void;
  interrupt: () => void;
  stop: () => void;
  retryLoad: () => void;
}

export function useInterview(sliceId: string): InterviewController {
  const [model, dispatch] = useReducer(interviewReducer, initialModel);
  const [phase, setPhase] = useState<InterviewPhase>("loading");
  const [capability, setCapability] = useState<InterviewCapability | null>(null);
  const [summary, setSummary] = useState<InterviewSummary | null>(null);
  const [problem, setProblem] = useState<MachApiError | null>(null);
  const [sending, setSending] = useState<InterviewController["sending"]>(null);
  const [loadTick, setLoadTick] = useState(0);
  const clientRef = useRef<InterviewClient | null>(null);
  const idRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const attach = useCallback((client: InterviewClient, interviewId: string) => {
    unsubscribeRef.current?.();
    idRef.current = interviewId;
    dispatch({ type: "attached", interviewId });
    setPhase("live");
    unsubscribeRef.current = client.subscribe(interviewId, {
      onEvent: (event) => dispatch({ type: "event", event }),
      onConnection: (state) => dispatch({ type: "connection", state }),
    });
  }, []);

  // Load: capability, then the slice's current interview. Re-attaches after a reload or restart.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const [client, session] = await Promise.all([getInterviewClient(), loadSession()]);
        if (cancelled) return;
        clientRef.current = client;
        const cap = interviewCapability(session);
        setCapability(cap);
        // The saved conversation: restores the transcript and the decisions after a reload or a
        // host restart. An older host without the route shows nothing earlier, as before.
        try {
          const history = await client.history(sliceId, controller.signal);
          if (cancelled) return;
          const events = history.events.flatMap((saved) => {
            const event = toInterviewEvent(saved.event, saved.data);
            return event ? [{ event, interviewId: saved.interview_id }] : [];
          });
          dispatch({ type: "history", events, truncated: history.truncated });
        } catch (cause) {
          const error = toApiError(cause, "interview.history");
          if (error.kind === "aborted") return;
          if (error.kind !== "invalid" && error.kind !== "protocol") throw error;
        }
        if (!cap.available) {
          setPhase("unavailable");
          return;
        }
        let found: InterviewSummary | null = null;
        try {
          found = await client.current(sliceId, controller.signal);
        } catch (cause) {
          const error = toApiError(cause, "interview.current");
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
        const error = toApiError(cause, "interview");
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
  }, [sliceId, loadTick, attach]);

  const start = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    setPhase("starting");
    setProblem(null);
    // The idea typed in "Start a slice" goes with this slice's first start, then is forgotten.
    const idea = peekIdea(sliceId);
    client.start(sliceId, idea).then(
      (result) => {
        forgetIdea(sliceId);
        attach(client, result.interview_id);
      },
      (cause: unknown) => {
        const error = toApiError(cause, "interview.start");
        // This host already runs the slice's interview (another tab, or this window before a
        // reload): the hint names it, so join it instead of refusing.
        if (error.kind === "conflict" && error.hint?.kind === "open_interview" && error.hint.target) {
          forgetIdea(sliceId);
          attach(client, error.hint.target);
          return;
        }
        setProblem(error);
        setPhase(error.kind === "conflict" ? "conflict" : error.kind === "refused" ? "refused" : "error");
      },
    );
  }, [sliceId, attach]);

  const reply = useCallback((text: string, answer: AnswerKind) => {
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
        setProblem(toApiError(cause, "interview.reply"));
      },
    );
  }, []);

  const interrupt = useCallback(() => {
    const client = clientRef.current;
    const id = idRef.current;
    if (!client || !id) return;
    setSending("interrupt");
    client.interrupt(id).then(
      () => setSending(null),
      (cause: unknown) => {
        setSending(null);
        setProblem(toApiError(cause, "interview.interrupt"));
      },
    );
  }, []);

  const stop = useCallback(() => {
    const client = clientRef.current;
    const id = idRef.current;
    if (!client || !id) return;
    setSending("stop");
    client.stop(id).then(
      () => setSending(null),
      (cause: unknown) => {
        setSending(null);
        setProblem(toApiError(cause, "interview.stop"));
      },
    );
  }, []);

  const retryLoad = useCallback(() => {
    dispatch({ type: "reset" });
    setPhase("loading");
    setProblem(null);
    setSummary(null);
    setLoadTick((t) => t + 1);
  }, []);

  return { phase, capability, summary, model, problem, sending, start, reply, interrupt, stop, retryLoad };
}

/**
 * The interview client this screen uses: the shared one from @mach/ui/api. Under
 * `vite --mode fixtures` it is the scripted development interview (dev/scriptedInterview.ts),
 * loaded lazily so the production bundle never contains it.
 */
async function getInterviewClient(): Promise<InterviewClient> {
  if (import.meta.env.MODE === "fixtures") {
    return (await import("./dev/scriptedInterview")).scriptedInterviewClient;
  }
  return client.interview;
}
