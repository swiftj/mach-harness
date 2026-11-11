import { createConnectionStore, type ConnectionStore } from "./connection";
import { MachApiError, type HostErrorKind } from "./errors";
import type { DraftDocument, DraftWriteResult, OperationArgs, OperationName, OperationResult, Session } from "./types";

/** The envelope every host response uses (contract section 4). */
export type Envelope<T> = { ok: true; data: T } | { ok: false; error: { kind: HostErrorKind; message: string } };

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
  /** Where the CSRF token is found in the session reply. Defaults to `csrf_token`. */
  csrfFrom?: (session: Session) => string | null | undefined;
}

export interface MachClient {
  /** GET /api/session. Also stores the CSRF token for later state-changing calls. */
  session(signal?: AbortSignal): Promise<Session>;
  /** POST /api/ops/<name> with typed arguments; resolves with the engine's JSON. */
  op<K extends OperationName>(name: K, args: OperationArgs<K>, signal?: AbortSignal): Promise<OperationResult<K>>;
  readDraft(kind: "spec" | "intent", sliceId: string, signal?: AbortSignal): Promise<DraftDocument>;
  /** PUT a draft's markdown; the host runs `slice check` afterwards and returns its result. */
  writeDraft(kind: "spec" | "intent", sliceId: string, markdown: string, signal?: AbortSignal): Promise<DraftWriteResult>;
  connection: ConnectionStore;
}

export const CSRF_HEADER = "X-MACH-CSRF";

/** Engine IDs (SLICE-001, EPIC-001, WAVE-001). Checked before a value is placed in a URL path. */
const ID_PATTERN = /^[A-Z]+-\d{3,}$/;

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
 *   await client.session();
 *   const status = await client.op("status", {});
 *
 * Failures reject with MachApiError. The connection store reflects whether the host answered.
 */
export function createClient(options: ClientOptions = {}): MachClient {
  const transport = options.transport ?? fetchTransport(options.baseUrl ?? "");
  const connection = options.connection ?? createConnectionStore();
  const csrfFrom = options.csrfFrom ?? ((session: Session) => session.csrf_token);
  let csrf: string | null = null;

  async function call<T>(method: TransportRequest["method"], path: string, operation: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      if (csrf) headers[CSRF_HEADER] = csrf;
    }
    let response: TransportResponse;
    try {
      response = await transport({ method, path, headers, body: payload === undefined ? undefined : JSON.stringify(payload), signal });
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
    connection.set(envelope.error.kind === "unauthorized" ? "unauthorized" : "online");
    throw new MachApiError(envelope.error.kind, envelope.error.message, operation, response.status);
  }

  function draftPath(kind: "spec" | "intent", sliceId: string): string {
    if (!ID_PATTERN.test(sliceId)) throw new MachApiError("invalid", `"${sliceId}" is not a slice ID.`, `drafts.${kind}`);
    return `/api/drafts/${kind}/${encodeURIComponent(sliceId)}`;
  }

  return {
    connection,
    async session(signal) {
      const session = await call<Session>("GET", "/api/session", "session", undefined, signal);
      csrf = csrfFrom(session) ?? null;
      return session;
    },
    op(name, args, signal) {
      return call("POST", `/api/ops/${name}`, name, args, signal);
    },
    readDraft(kind, sliceId, signal) {
      return call("GET", draftPath(kind, sliceId), `drafts.${kind}`, undefined, signal);
    },
    writeDraft(kind, sliceId, markdown, signal) {
      return call("PUT", draftPath(kind, sliceId), `drafts.${kind}`, { markdown }, signal);
    },
  };
}
