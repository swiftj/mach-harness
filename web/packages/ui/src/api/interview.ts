import { ENGINE_ID } from "./ids";
import { MachApiError } from "./errors";
import { interviewEventNames, type InterviewEvent, type InterviewHistory, type InterviewSummary, type StartResult } from "./types";

/** The minimum of EventSource the stream needs, so tests and fixture mode can supply their own. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

/** The stream's link to the host, separate from the interviewer's own state. */
export type StreamConnection = "connecting" | "open" | "reconnecting" | "closed";

export interface StreamHandlers {
  /** Every event, in order, typed, each at most once. */
  onEvent: (event: InterviewEvent) => void;
  onConnection: (state: StreamConnection) => void;
}

/**
 * Everything an interview screen asks of the host (contract 8.2). One interface, so the HTTP
 * client and a development script are interchangeable.
 */
export interface InterviewClient {
  /** GET /api/interview?slice_id=. Null when the slice has never been interviewed here. */
  current(sliceId: string, signal?: AbortSignal): Promise<InterviewSummary | null>;
  /** GET /api/interview/history?slice_id=: every saved event for the slice, oldest first. */
  history(sliceId: string, signal?: AbortSignal): Promise<InterviewHistory>;
  /**
   * POST /api/interview: start or resume. For a new idea, run `slice.new` first and pass the idea.
   * Rejects with `conflict` when another window holds the slice, `refused` for an approved slice,
   * `unavailable` when the host cannot run interviews.
   */
  start(sliceId: string, idea?: string): Promise<StartResult>;
  /**
   * GET /api/interview/<id>/events. Reconnects by itself (the browser resends Last-Event-ID; a closed
   * stream is reopened with back-off) and drops events whose sequence number it has already seen.
   * Returns the unsubscribe function.
   */
  subscribe(interviewId: string, handlers: StreamHandlers): () => void;
  reply(interviewId: string, text: string): Promise<void>;
  /** Stop the current turn; the interview stays open. */
  interrupt(interviewId: string): Promise<void>;
  /** End the interview. The draft, the saved note and the session remain. */
  stop(interviewId: string): Promise<void>;
}

const INTERVIEW_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Turns one event as the host sends it (live or from history) into the typed event. The host sends
 * `state` as `{state, ...}`; the typed event carries the state word itself.
 */
export function toInterviewEvent(name: string, data: unknown, seq: number | null = null): InterviewEvent | null {
  if (!(interviewEventNames as string[]).includes(name)) return null;
  const value = name === "state" && data && typeof data === "object" && "state" in data ? (data as { state: unknown }).state : data;
  return { type: name, data: value, seq } as InterviewEvent;
}

function checkId(id: string, operation: string): string {
  if (!INTERVIEW_ID.test(id)) throw new MachApiError("invalid", "That is not an interview ID.", operation);
  return encodeURIComponent(id);
}

export function createInterviewClient(deps: {
  get: (path: string, operation: string, signal?: AbortSignal) => Promise<unknown>;
  post: (path: string, operation: string, body: unknown) => Promise<unknown>;
  baseUrl: string;
  eventSource?: EventSourceFactory;
}): InterviewClient {
  const open: EventSourceFactory =
    deps.eventSource ?? ((url) => new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike);

  return {
    async current(sliceId, signal) {
      if (!ENGINE_ID.test(sliceId)) throw new MachApiError("invalid", `"${sliceId}" is not a slice ID.`, "interview.current");
      const data = (await deps.get(`/api/interview?slice_id=${encodeURIComponent(sliceId)}`, "interview.current", signal)) as {
        interview: InterviewSummary | null;
      };
      return data.interview;
    },
    async history(sliceId, signal) {
      if (!ENGINE_ID.test(sliceId)) throw new MachApiError("invalid", `"${sliceId}" is not a slice ID.`, "interview.history");
      return (await deps.get(`/api/interview/history?slice_id=${encodeURIComponent(sliceId)}`, "interview.history", signal)) as InterviewHistory;
    },
    start(sliceId, idea) {
      if (!ENGINE_ID.test(sliceId)) return Promise.reject(new MachApiError("invalid", `"${sliceId}" is not a slice ID.`, "interview.start"));
      return deps.post("/api/interview", "interview.start", idea ? { slice_id: sliceId, idea } : { slice_id: sliceId }) as Promise<StartResult>;
    },
    async reply(id, text) {
      await deps.post(`/api/interview/${checkId(id, "interview.reply")}/reply`, "interview.reply", { text });
    },
    async interrupt(id) {
      await deps.post(`/api/interview/${checkId(id, "interview.interrupt")}/interrupt`, "interview.interrupt", {});
    },
    async stop(id) {
      await deps.post(`/api/interview/${checkId(id, "interview.stop")}/stop`, "interview.stop", {});
    },
    subscribe(id, { onEvent, onConnection }) {
      const url = `${deps.baseUrl}/api/interview/${checkId(id, "interview.events")}/events`;
      let source: EventSourceLike | null = null;
      let lastSeq = -1;
      let closed = false;
      let failures = 0;
      let retry: ReturnType<typeof setTimeout> | null = null;

      const connect = () => {
        if (closed) return;
        onConnection(failures === 0 ? "connecting" : "reconnecting");
        source = open(url);
        source.onopen = () => {
          failures = 0;
          onConnection("open");
        };
        source.onerror = () => {
          if (closed || !source) return;
          // While CONNECTING (0) the browser retries by itself, sending Last-Event-ID. A CLOSED (2)
          // source (an error envelope, a dropped host) is reopened here with a growing delay; the
          // host then replays the current turn and the sequence numbers drop what was seen.
          if (source.readyState === 2) {
            source = null;
            failures += 1;
            onConnection("reconnecting");
            retry = setTimeout(connect, Math.min(1000 * 2 ** Math.min(failures, 4), 15000));
          } else {
            onConnection("reconnecting");
          }
        };
        for (const name of interviewEventNames) {
          source.addEventListener(name, (message) => {
            const seq = message.lastEventId ? Number(message.lastEventId) : NaN;
            if (Number.isFinite(seq)) {
              if (seq <= lastSeq) return;
              lastSeq = seq;
            }
            let data: unknown;
            try {
              data = JSON.parse(message.data);
            } catch {
              return;
            }
            const event = toInterviewEvent(name, data, Number.isFinite(seq) ? seq : null);
            if (event) onEvent(event);
            if (name === "ended") {
              closed = true;
              source?.close();
              onConnection("closed");
            }
          });
        }
      };

      connect();
      return () => {
        closed = true;
        if (retry) clearTimeout(retry);
        source?.close();
      };
    },
  };
}
