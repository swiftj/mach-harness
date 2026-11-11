import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import {
  Button,
  ConnectionIndicator,
  ErrorState,
  LoadingState,
  SliceStatusPill,
  ArtifactId,
  Text,
} from "@mach/ui";
import { createClient, describeError, isMachApiError, type Status, type Transport, type MachApiError } from "@mach/ui/api";
import { Section, Specimen } from "../layout";
import { fx, runs } from "../fixtures";

/**
 * A transport that answers from fixtures, the way the host would: engine data in the envelope, a
 * refusal as { ok: false, error: { kind: "refused" } }. Lets the showcase run the real client.
 */
const fixtureTransport: Transport = async ({ path }) => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (path === "/api/session") {
    return { status: 200, json: { ok: true, data: { project: { name: "Team Space", folder: "team-space" }, csrf_token: "showcase", capabilities: { interview: false, interview_reason: "Showcase" }, versions: {} } } };
  }
  if (path === "/api/ops/status") return { status: 200, json: { ok: true, data: fx.statusConflicts } };
  if (path === "/api/ops/send") return { status: 200, json: { ok: false, error: { kind: "refused", message: runs.sendRefusedOffline.refused } } };
  return { status: 404, json: { ok: false, error: { kind: "invalid", message: `No such operation: ${path}` } } };
};

export function ShellSection() {
  const [client] = useState(() => createClient({ transport: fixtureTransport }));
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<MachApiError | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let live = true;
    client
      .session()
      .then(() => client.op("status", {}))
      .then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, [client]);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await client.op("send", { wave_id: "WAVE-001" });
    } catch (e) {
      if (isMachApiError(e)) setError(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <Section
      id="shell"
      title="Shell and API client"
      intro="The frame this page sits in is the application shell. Both apps talk to their host through one client that speaks the envelope."
    >
      <Specimen
        title="Connection indicator"
        source="status.published.json, refresh.offline.json"
        note="Two links: the browser to the local host, and the workspace to the shared project. Icon and words for each; the popover explains."
      >
        <div className="grid grid-cols-2 gap-x-8 gap-y-4">
          <ConnectionIndicator host="online" shared={{ reachable: true, lastRefreshed: fx.statusPublished.last_refreshed, description: fx.statusPublished.shared_project }} />
          <ConnectionIndicator host="connecting" />
          <ConnectionIndicator
            host="online"
            shared={{ reachable: false, lastRefreshed: null, description: fx.refreshOffline.shared_project, problem: fx.refreshOffline.problem }}
          />
          <ConnectionIndicator host="offline" />
          <ConnectionIndicator host="unauthorized" />
        </div>
      </Specimen>

      <Specimen
        title="The client, running against fixtures"
        source="status.conflicts.json, send.refused-offline.json"
        note="createClient() with a fixture transport. In the apps the transport is fetch against the host."
      >
        <div className="flex flex-col gap-5">
          {status ? (
            <ul className="flex flex-col divide-y divide-line" aria-label="Slices from status">
              {status.slices.map((s) => (
                <li key={s.slice_id} className="flex items-center gap-3 py-2">
                  <ArtifactId>{s.slice_id}</ArtifactId>
                  <span className="flex-1 text-body">{s.title}</span>
                  <SliceStatusPill status={s.status} size="sm" />
                </li>
              ))}
            </ul>
          ) : (
            <LoadingState label="Reading your workspace" />
          )}
          <div className="flex items-center gap-3">
            <Button onClick={send} loading={sending}>
              <Send aria-hidden="true" />
              Send WAVE-001
            </Button>
            <Text as="span" size="body-sm" tone="muted">
              The fixture answers with the engine's refusal.
            </Text>
          </div>
          {error ? <ErrorState title={describeError(error).title} message={describeError(error).message} /> : null}
          <pre className="overflow-x-auto rounded-md bg-surface-sunken p-4 font-mono text-mono text-ink">
{`const client = createClient();          // fetch, same origin
await client.session();                 // stores the CSRF token
const status = await client.op("status", {});
await client.op("slice.approve", { slice_id: "SLICE-001" });
// failure: MachApiError { kind: "refused", message: "SLICE-001 cannot be approved yet: ..." }`}
          </pre>
        </div>
      </Specimen>
    </Section>
  );
}
