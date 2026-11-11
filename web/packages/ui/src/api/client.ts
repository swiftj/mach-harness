import { ENGINE_ID } from "./ids";
import { createConnectionStore, type ConnectionStore } from "./connection";
import { MachApiError, type HostErrorKind } from "./errors";
import { createInterviewClient, type InterviewClient, type EventSourceFactory } from "./interview";
import type { DraftRead, DraftWriteResult, OperationArgs, OperationName, OperationResult, Session } from "./types";

/** The envelope every host response uses (contract section 4). */
export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { kind: HostErrorKind; message: string; hint?: { kind: string; target: string | null } | null } };

export interface TransportRequest {
  method: "GET" | "POST" | "PUT";
  /** Always starts with /api/. */
  path: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Parsed JSON, or undefined when the body was not JSON. */
  json: unknown;
}

/**
 * How requests leave the app. The default uses fetch against the same origin. Tests and the
 * fixture-backed dev mode supply their own; production code never does.
 */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface ClientOptions {
  /** Prefix for every path. Empty in production (the app is served by the host itself). */
  baseUrl?: string;
  transport?: Transport;
  /** Shared connection state; one is created when omitted. */
  connection?: ConnectionStore;
  /** Builds the interview event stream. Defaults to the browser's EventSource. */
  eventSource?: EventSourceFactory;
}

export interface MachClient {
  /**
   * GET /api/session. Called automatically before the first state-changing request; call it
   * yourself to read the project and capabilities. Repeated calls share one request until it settles.
   */
  session(signal?: AbortSignal): Promise<Session>;
  /** POST /api/ops/<name> with typed arguments; resolves with the engine's JSON. */
  op<K extends OperationName>(name: K, args: OperationArgs<K>, signal?: AbortSignal): Promise<OperationResult<K>>;
  readDraft(kind: "spec" | "intent", sliceId: string, signal?: AbortSignal): Promise<DraftRead>;
  /**
   * PUT a draft's markdown. The host runs `slice check` afterwards and returns it. `name` (such as
   * "invite-teammate") is only for a slice's first spec.
   */
  writeDraft(kind: "spec" | "intent", sliceId: string, markdown: string, options?: { name?: string; signal?: AbortSignal }): Promise<DraftWriteResult>;
  /** The interview routes (contract 8.2). */
  interview: InterviewClient;
  connection: ConnectionStore;
}

export const CSRF_HEADER = "X-MACH-CSRF";


export const fetchTransport =
  (baseUrl = ""): Transport =>
  async ({ method, path, headers, body, signal }) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body,
      signal,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  };

function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  const v = value as { ok: unknown; data?: unknown; error?: { kind?: unknown; message?: unknown } };
  if (v.ok === true) return "data" in v;
  return v.ok === false && typeof v.error?.kind === "string" && typeof v.error?.message === "string";
}

/**
 * The one way the apps talk to a MACH host.
 *
 *   const client = createClient();
 *   const status = await client.op("status", {});      // fetches the session (and CSRF token) first
 *
 * GET requests carry the session cookie only. Every POST and PUT carries
 * `Content-Type: application/json`, `X-MACH-CSRF` and same-origin credentials, and waits for the
 * session if the token is not known yet. Failures reject with MachApiError.
 */
export function createClient(options: ClientOptions = {}): MachClient {
  const transport = options.transport ?? fetchTransport(options.baseUrl ?? "");
  const connection = options.connection ?? createConnectionStore();
  let csrf: string | null = null;
  let pending: Promise<Session> | null = null;

  async function send<T>(method: TransportRequest["method"], path: string, operation: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method !== "GET") {
      if (!csrf) await loadSession();
      headers["Content-Type"] = "application/json";
      if (csrf) headers[CSRF_HEADER] = csrf;
    }
    let response: TransportResponse;
    try {
      response = await transport({
        method,
        path,
        headers,
        body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
        signal,
      });
    } catch (cause) {
      if (signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError")) {
        throw new MachApiError("aborted", "The request was cancelled.", operation);
      }
      connection.set("offline");
      throw new MachApiError("network", "Could not reach the Product Studio host.", operation);
    }

    if (!isEnvelope(response.json)) {
      connection.set("online");
      throw new MachApiError("protocol", `The host replied with status ${response.status} and no envelope.`, operation, response.status);
    }
    const envelope = response.json;
    if (envelope.ok) {
      connection.set("online");
      return envelope.data as T;
    }
    // 401 means the session cookie is missing or expired: the window must be reopened from the link.
    // A 403 "unauthorized" is a refused CSRF or Origin check on one request, not a lost session.
    connection.set(envelope.error.kind === "unauthorized" && response.status === 401 ? "unauthorized" : "online");
    const hint = envelope.error.hint && typeof envelope.error.hint.kind === "string" ? { kind: envelope.error.hint.kind, target: envelope.error.hint.target ?? null } : null;
    throw new MachApiError(envelope.error.kind, envelope.error.message, operation, response.status, hint);
  }

  function loadSession(signal?: AbortSignal): Promise<Session> {
    pending ??= send<Session>("GET", "/api/session", "session", undefined, signal).then(
      (session) => {
        csrf = session.csrf_token || null;
        pending = null;
        return session;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  }

  function draftPath(kind: "spec" | "intent", sliceId: string): string {
    if (!ENGINE_ID.test(sliceId)) throw new MachApiError("invalid", `"${sliceId}" is not a slice ID.`, `drafts.${kind}`);
    return `/api/drafts/${kind}/${encodeURIComponent(sliceId)}`;
  }

  return {
    connection,
    session: loadSession,
    op(name, args, signal) {
      return send("POST", `/api/ops/${name}`, name, args, signal);
    },
    readDraft(kind, sliceId, signal) {
      return send("GET", draftPath(kind, sliceId), `drafts.${kind}`, undefined, signal);
    },
    writeDraft(kind, sliceId, markdown, opts = {}) {
      const body = kind === "spec" && opts.name ? { markdown, name: opts.name } : { markdown };
      return send("PUT", draftPath(kind, sliceId), `drafts.${kind}`, body, opts.signal);
    },
    interview: createInterviewClient({
      get: (path, operation, signal) => send("GET", path, operation, undefined, signal),
      post: (path, operation, body) => send("POST", path, operation, body),
      baseUrl: options.baseUrl ?? "",
      eventSource: options.eventSource,
    }),
  };
}
