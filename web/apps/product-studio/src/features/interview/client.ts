import { CSRF_HEADER, MachApiError, type HostErrorKind } from "@mach/ui/api";
import { loadSession, SLICE_ID, studioClient } from "../spec/api";
import { interviewEventNames, type InterviewEvent, type InterviewSummary, type StartResult } from "./events";

/** The stream's link to the host, separate from the interviewer's own state. */
export type StreamConnection = "connecting" | "open" | "reconnecting" | "closed";

export interface StreamHandlers {
  onEvent: (event: InterviewEvent) => void;
  onConnection: (state: StreamConnection) => void;
}

/**
 * Everything the interview screen asks of the host. One interface so the HTTP client below, a
 * future `@mach/ui/api` interview client, and the development script are interchangeable.
 *
 * PROMOTION CANDIDATE: this interface and `httpInterviewClient` belong in `@mach/ui/api` next to
 * `createClient`. They are here because the shell's typed interview client did not exist yet.
 */
export interface InterviewClient {
  /** GET /api/interview?slice_id=. Null when the slice has never been interviewed here. */
  current(sliceId: string, signal?: AbortSignal): Promise<InterviewSummary | null>;
  /** POST /api/interview: start or resume. `conflict` when another window holds the slice. */
  start(sliceId: string): Promise<StartResult>;
  /** GET /api/interview/<id>/events. Reconnects by itself; returns the unsubscribe function. */
  subscribe(interviewId: string, handlers: StreamHandlers): () => void;
  reply(interviewId: string, text: string): Promise<void>;
  interrupt(interviewId: string): Promise<void>;
  stop(interviewId: string): Promise<void>;
}

const INTERVIEW_ID = /^[A-Za-z0-9_-]{1,64}$/;

function checkId(id: string): string {
  if (!INTERVIEW_ID.test(id)) throw new MachApiError("invalid", "That is not an interview ID.", "interview");
  return encodeURIComponent(id);
}

async function call<T>(method: "GET" | "POST", path: string, operation: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method === "POST") {
    const session = await loadSession();
    headers["Content-Type"] = "application/json";
    headers[CSRF_HEADER] = session.csrf_token;
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    if (signal?.aborted) throw new MachApiError("aborted", "The request was cancelled.", operation);
    studioClient.connection.set("offline");
    throw new MachApiError("network", "Could not reach the Product Studio host.", operation);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  const envelope = json as { ok?: boolean; data?: unknown; error?: { kind?: string; message?: string } } | undefined;
  if (!envelope || typeof envelope.ok !== "boolean") {
    throw new MachApiError("protocol", `The host replied with status ${response.status} and no envelope.`, operation, response.status);
  }
  if (envelope.ok) {
    studioClient.connection.set("online");
    return envelope.data as T;
  }
  const kind = (envelope.error?.kind ?? "internal") as HostErrorKind;
  studioClient.connection.set(kind === "unauthorized" ? "unauthorized" : "online");
  throw new MachApiError(kind, envelope.error?.message ?? "The host refused the request.", operation, response.status);
}

/** The real host (contract 8.2). Same origin only. */
export const httpInterviewClient: InterviewClient = {
  async current(sliceId, signal) {
    if (!SLICE_ID.test(sliceId)) throw new MachApiError("invalid", `"${sliceId}" is not a slice ID.`, "interview.current");
    const data = await call<{ interview: InterviewSummary | null }>(
      "GET",
      `/api/interview?slice_id=${encodeURIComponent(sliceId)}`,
      "interview.current",
      undefined,
      signal,
    );
    return data.interview;
  },
  start(sliceId) {
    return call<StartResult>("POST", "/api/interview", "interview.start", { slice_id: sliceId });
  },
  async reply(id, text) {
    await call("POST", `/api/interview/${checkId(id)}/reply`, "interview.reply", { text });
  },
  async interrupt(id) {
    await call("POST", `/api/interview/${checkId(id)}/interrupt`, "interview.interrupt", {});
  },
  async stop(id) {
    await call("POST", `/api/interview/${checkId(id)}/stop`, "interview.stop", {});
  },
  subscribe(id, { onEvent, onConnection }) {
    const url = `/api/interview/${checkId(id)}/events`;
    let source: EventSource | null = null;
    let lastSeq = -1;
    let closed = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (closed) return;
      onConnection(failures === 0 ? "connecting" : "reconnecting");
      source = new EventSource(url, { withCredentials: true });
      source.onopen = () => {
        failures = 0;
        onConnection("open");
      };
      source.onerror = () => {
        if (closed || !source) return;
        // EventSource retries by itself (sending Last-Event-ID) while it is CONNECTING. A CLOSED
        // source (an error envelope, a dropped host) is reopened here with a growing delay; the
        // host then replays the current turn and its sequence numbers let us drop what we saw.
        if (source.readyState === EventSource.CLOSED) {
          source = null;
          failures += 1;
          onConnection("reconnecting");
          retry = setTimeout(open, Math.min(1000 * 2 ** Math.min(failures, 4), 15000));
        } else {
          onConnection("reconnecting");
        }
      };
      for (const name of interviewEventNames) {
        source.addEventListener(name, (raw) => {
          const message = raw as MessageEvent<string>;
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
          onEvent({ type: name, data, seq: Number.isFinite(seq) ? seq : null } as InterviewEvent);
          if (name === "ended") {
            closed = true;
            source?.close();
            onConnection("closed");
          }
        });
      }
    };

    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  },
};

/**
 * The client this screen uses. Under `vite --mode fixtures` it is the scripted development
 * interview (dev/scriptedInterview.ts), loaded lazily so the production bundle never contains it.
 */
export async function getInterviewClient(): Promise<InterviewClient> {
  if (import.meta.env.MODE === "fixtures") {
    return (await import("./dev/scriptedInterview")).scriptedInterviewClient;
  }
  return httpInterviewClient;
}
