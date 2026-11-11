import { ENGINE_ID } from "./ids";
import { MachApiError } from "./errors";
import { interviewEventTypes, type InterviewEvent, type InterviewEventMap, type InterviewEventType } from "./types";

/** The minimum of EventSource the stream needs, so tests and fixture mode can supply their own. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

/**
 * The stream's own connection, separate from the interview's state:
 *
 *   connecting  opening for the first time
 *   open        receiving events
 *   retrying    the connection dropped; reopening with back-off (the browser resumes with Last-Event-ID)
 *   closed      ended (an `ended` event, `close()`, or too many failed attempts)
 */
export type StreamState = "connecting" | "open" | "retrying" | "closed";

export interface InterviewStreamHandlers {
  /** Every event, in order, typed. */
  onEvent: (event: InterviewEvent) => void;
  onStreamState?: (state: StreamState) => void;
}

export interface InterviewStream {
  close(): void;
}

export interface InterviewClient {
  /**
   * POST /api/interview. For a new idea, the app runs `slice.new` first and passes the new slice's ID
   * (with the idea in the PM's words). Rejects with `conflict` while that slice's interview is running,
   * `refused` for an approved slice, `unavailable` when the host cannot run interviews.
   */
  start(sliceId: string, idea?: string): Promise<{ interview_id: string }>;
  /** GET /api/interview/<id>/events as a typed stream that reconnects by itself. */
  events(interviewId: string, handlers: InterviewStreamHandlers): InterviewStream;
  /** The PM's answer. */
  reply(interviewId: string, text: string): Promise<{ sent: boolean }>;
  /** Stop the current turn; the interview stays open. */
  interrupt(interviewId: string): Promise<unknown>;
  /** End the interview. The draft, the saved note and the session remain. */
  stop(interviewId: string): Promise<unknown>;
}

const INTERVIEW_ID = /^[A-Za-z0-9_-]{1,64}$/;

function checkId(id: string, operation: string): string {
  if (!INTERVIEW_ID.test(id)) throw new MachApiError("invalid", "That is not an interview ID.", operation);
  return encodeURIComponent(id);
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // `state` may arrive as a bare word
  }
}

export function createInterviewClient(deps: {
  post: (path: string, operation: string, body: unknown) => Promise<unknown>;
  baseUrl: string;
  eventSource?: EventSourceFactory;
}): InterviewClient {
  const open: EventSourceFactory = deps.eventSource ?? ((url) => new EventSource(url) as unknown as EventSourceLike);

  return {
    start(sliceId, idea) {
      if (!ENGINE_ID.test(sliceId)) return Promise.reject(new MachApiError("invalid", `"${sliceId}" is not a slice ID.`, "interview.start"));
      return deps.post("/api/interview", "interview.start", idea ? { slice_id: sliceId, idea } : { slice_id: sliceId }) as Promise<{ interview_id: string }>;
    },
    reply(id, text) {
      return deps.post(`/api/interview/${checkId(id, "interview.reply")}/reply`, "interview.reply", { text }) as Promise<{ sent: boolean }>;
    },
    interrupt(id) {
      return deps.post(`/api/interview/${checkId(id, "interview.interrupt")}/interrupt`, "interview.interrupt", {});
    },
    stop(id) {
      return deps.post(`/api/interview/${checkId(id, "interview.stop")}/stop`, "interview.stop", {});
    },
    events(id, { onEvent, onStreamState }) {
      const url = `${deps.baseUrl}/api/interview/${checkId(id, "interview.events")}/events`;
      let source: EventSourceLike | null = null;
      let attempts = 0;
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const setState = (state: StreamState) => onStreamState?.(state);

      const connect = () => {
        source = open(url);
        source.onopen = () => {
          attempts = 0;
          setState("open");
        };
        source.onerror = () => {
          if (finished) return;
          // CONNECTING (0): the browser is already retrying with Last-Event-ID. CLOSED (2): it gave up
          // (the host answered with an error status); reopen ourselves with back-off.
          if (source && source.readyState === 2) {
            source.close();
            attempts += 1;
            if (attempts > 6) {
              finished = true;
              setState("closed");
              return;
            }
            setState("retrying");
            timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** (attempts - 1)));
          } else {
            setState("retrying");
          }
        };
        for (const type of interviewEventTypes) {
          source.addEventListener(type, (message) => {
            const data = parse(message.data) as InterviewEventMap[InterviewEventType];
            onEvent({ type, data } as InterviewEvent);
            if (type === "ended") {
              finished = true;
              source?.close();
              setState("closed");
            }
          });
        }
      };

      setState("connecting");
      connect();
      return {
        close() {
          finished = true;
          if (timer) clearTimeout(timer);
          source?.close();
          setState("closed");
        },
      };
    },
  };
}
