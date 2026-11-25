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
 * How a start goes ahead when another window on this computer holds the conversation. `takeOver` follows the
 * host's warning (a `conflict` with hint `take_over`): this host's own conversation is ended and resumed here; another
 * process keeps writing too, and the draft keeps whichever saves last.
 */
export interface StartOptions {
  takeOver?: boolean;
}

const startBody = (body: Record<string, unknown>, options?: StartOptions) => (options?.takeOver ? { ...body, take_over: true } : body);

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
   * Rejects with `conflict` when another window holds the slice (hint `take_over`: the message is the warning, and
   * the same start with `takeOver` goes ahead), `refused` for an approved slice, `unavailable` when the host cannot
   * run interviews.
   */
  start(sliceId: string, idea?: string, options?: StartOptions): Promise<StartResult>;
  /**
   * GET /api/interview/<id>/events. Reconnects by itself (the browser resends Last-Event-ID; a closed
   * stream is reopened with back-off) and drops events whose sequence number it has already seen.
   * Returns the unsubscribe function.
   */
  subscribe(interviewId: string, handlers: StreamHandlers): () => void;
  /**
   * Rejects with `conflict` while the interviewer is writing its reply (hint `interrupt_turn`: the message is the
   * warning, and the same reply with `interrupt` stops that turn and is sent), or after the conversation ended.
   */
  reply(interviewId: string, text: string, options?: { interrupt?: boolean }): Promise<void>;
  /** Stop the current turn; the interview stays open. */
  interrupt(interviewId: string): Promise<void>;
  /** End the interview. The draft, the saved note and the session remain. */
  stop(interviewId: string): Promise<void>;
}

/**
 * M16: the Shape conversation for one idea. The same routes as a slice's interview, named by `idea_id`; once
 * started, it is subscribed, replied to, interrupted and stopped by its interview ID exactly as an interview is.
 * Its rules let it write only that idea's brief and case and record what it looked up; it can never record a
 * verdict, size, map, apply, publish or look back (apps/studio/internal/interview, the idea mode).
 */
export interface IdeaConversationClient extends Pick<InterviewClient, "subscribe" | "reply" | "interrupt" | "stop"> {
  /** GET /api/interview?idea_id=. Null when the idea has never had a conversation here. */
  current(ideaId: string, signal?: AbortSignal): Promise<InterviewSummary | null>;
  /** GET /api/interview/history?idea_id=. */
  history(ideaId: string, signal?: AbortSignal): Promise<InterviewHistory>;
  /** POST /api/interview {idea_id}. Refused for an idea shaped into work; `conflict` when another window holds it. */
  start(ideaId: string, options?: StartOptions): Promise<StartResult>;
}

/**
 * M17: the needs conversation, for the product as a whole (one per project). The same routes, named by `needs: true`;
 * once started, it is subscribed, replied to, interrupted and stopped by its interview ID as an interview is. Its
 * rules let it record needs and "nothing to say" with the product manager's words (need add, set, none), read a
 * design and record a design's map; it can never retire or publish needs, choose a version, bring in, settle or
 * publish a design (apps/studio/internal/interview, the needs mode). Every act on the needs or a design is refused
 * with `conflict` while its turn runs.
 */
export interface NeedsConversationClient extends Pick<InterviewClient, "subscribe" | "reply" | "interrupt" | "stop"> {
  /** GET /api/interview?needs=true. Null when the needs have never had a conversation here. */
  current(signal?: AbortSignal): Promise<InterviewSummary | null>;
  /** GET /api/interview/history?needs=true. */
  history(signal?: AbortSignal): Promise<InterviewHistory>;
  /** POST /api/interview {needs: true}. Refused before a project exists; `conflict` when another window holds it. */
  start(options?: StartOptions): Promise<StartResult>;
}

/**
 * M19: the PRD conversation, for one imported PRD. The same routes, named by `prd_id`; once started, it is subscribed,
 * replied to, interrupted and stopped by its interview ID as an interview is. Its rules let it read the PRD and record
 * that PRD's map from one fixed file; it can never settle a section, make the drafts, define the project or confirm a
 * slice's answers (apps/studio/internal/interview, the PRD mode). Every act on that PRD's map, its settlements or its
 * drafts is refused with `conflict` while its turn runs. It needs no project.
 */
export interface PrdConversationClient extends Pick<InterviewClient, "subscribe" | "reply" | "interrupt" | "stop"> {
  /** GET /api/interview?prd_id=. Null when the PRD has never had a conversation here. */
  current(prdId: string, signal?: AbortSignal): Promise<InterviewSummary | null>;
  /** GET /api/interview/history?prd_id=. */
  history(prdId: string, signal?: AbortSignal): Promise<InterviewHistory>;
  /** POST /api/interview {prd_id}. Refused once the drafts are made from it; `conflict` when another window holds it. */
  start(prdId: string, options?: StartOptions): Promise<StartResult>;
}

/** IDEA-NNN, checked before it is placed in a URL. */
export const IDEA_ID = /^IDEA-\d{3,}$/;

/** PRD-NN, checked before it is placed in a URL. */
export const PRD_ID = /^PRD-\d{2,}$/;

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

  const client: InterviewClient = {
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
    start(sliceId, idea, options) {
      if (!ENGINE_ID.test(sliceId)) return Promise.reject(new MachApiError("invalid", `"${sliceId}" is not a slice ID.`, "interview.start"));
      return deps.post("/api/interview", "interview.start", startBody(idea ? { slice_id: sliceId, idea } : { slice_id: sliceId }, options)) as Promise<StartResult>;
    },
    async reply(id, text, options) {
      await deps.post(`/api/interview/${checkId(id, "interview.reply")}/reply`, "interview.reply", options?.interrupt ? { text, interrupt: true } : { text });
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
  return client;
}

export function createIdeaConversationClient(
  deps: Parameters<typeof createInterviewClient>[0],
  interviews: InterviewClient = createInterviewClient(deps),
): IdeaConversationClient {
  const check = (ideaId: string, operation: string) => {
    if (!IDEA_ID.test(ideaId)) throw new MachApiError("invalid", `"${ideaId}" is not an idea ID.`, operation);
    return encodeURIComponent(ideaId);
  };
  return {
    async current(ideaId, signal) {
      const id = check(ideaId, "conversation.current");
      const data = (await deps.get(`/api/interview?idea_id=${id}`, "conversation.current", signal)) as { interview: InterviewSummary | null };
      return data.interview;
    },
    async history(ideaId, signal) {
      return (await deps.get(`/api/interview/history?idea_id=${check(ideaId, "conversation.history")}`, "conversation.history", signal)) as InterviewHistory;
    },
    start(ideaId, options) {
      if (!IDEA_ID.test(ideaId)) return Promise.reject(new MachApiError("invalid", `"${ideaId}" is not an idea ID.`, "conversation.start"));
      return deps.post("/api/interview", "conversation.start", startBody({ idea_id: ideaId }, options)) as Promise<StartResult>;
    },
    subscribe: interviews.subscribe,
    reply: interviews.reply,
    interrupt: interviews.interrupt,
    stop: interviews.stop,
  };
}

/** M17: the needs conversation's client (NeedsConversationClient). */
export function createNeedsConversationClient(
  deps: Parameters<typeof createInterviewClient>[0],
  interviews: InterviewClient = createInterviewClient(deps),
): NeedsConversationClient {
  return {
    async current(signal) {
      const data = (await deps.get("/api/interview?needs=true", "conversation.current", signal)) as { interview: InterviewSummary | null };
      return data.interview;
    },
    async history(signal) {
      return (await deps.get("/api/interview/history?needs=true", "conversation.history", signal)) as InterviewHistory;
    },
    start(options) {
      return deps.post("/api/interview", "conversation.start", startBody({ needs: true }, options)) as Promise<StartResult>;
    },
    subscribe: interviews.subscribe,
    reply: interviews.reply,
    interrupt: interviews.interrupt,
    stop: interviews.stop,
  };
}

/** M19: the PRD conversation's client (PrdConversationClient). */
export function createPrdConversationClient(
  deps: Parameters<typeof createInterviewClient>[0],
  interviews: InterviewClient = createInterviewClient(deps),
): PrdConversationClient {
  const check = (prdId: string, operation: string) => {
    if (!PRD_ID.test(prdId)) throw new MachApiError("invalid", `"${prdId}" is not a PRD ID.`, operation);
    return encodeURIComponent(prdId);
  };
  return {
    async current(prdId, signal) {
      const id = check(prdId, "conversation.current");
      const data = (await deps.get(`/api/interview?prd_id=${id}`, "conversation.current", signal)) as { interview: InterviewSummary | null };
      return data.interview;
    },
    async history(prdId, signal) {
      return (await deps.get(`/api/interview/history?prd_id=${check(prdId, "conversation.history")}`, "conversation.history", signal)) as InterviewHistory;
    },
    start(prdId, options) {
      if (!PRD_ID.test(prdId)) return Promise.reject(new MachApiError("invalid", `"${prdId}" is not a PRD ID.`, "conversation.start"));
      return deps.post("/api/interview", "conversation.start", startBody({ prd_id: prdId }, options)) as Promise<StartResult>;
    },
    subscribe: interviews.subscribe,
    reply: interviews.reply,
    interrupt: interviews.interrupt,
    stop: interviews.stop,
  };
}
