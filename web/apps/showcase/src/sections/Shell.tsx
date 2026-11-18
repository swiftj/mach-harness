import { useEffect, useState } from "react";
import { CircleCheck } from "lucide-react";
import {
  Button,
  ConnectionIndicator,
  savedState,
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
  if (path === "/api/ops/status") return { status: 200, json: { ok: true, data: fx.statusSliceReady } };
  if (path === "/api/ops/slice.ready") {
    const refused = runs.sliceReadyRefusedOpenQuestions;
    return { status: 200, json: { ok: false, error: { kind: "refused", message: refused.refused, hint: refused.hint } } };
  }
  return { status: 404, json: { ok: false, error: { kind: "invalid", message: `No such operation: ${path}` } } };
};

export function ShellSection() {
  const [client] = useState(() => createClient({ transport: fixtureTransport }));
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<MachApiError | null>(null);
  const [marking, setMarking] = useState(false);

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

  const markReady = async () => {
    setMarking(true);
    setError(null);
    try {
      await client.op("slice.ready", { slice_id: "SLICE-001" });
    } catch (e) {
      if (isMachApiError(e)) setError(e);
    } finally {
      setMarking(false);
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
        source="status.rich.json, status.offline.json"
        note="Two facts: the browser's link to the local host, and whether everything is saved, in the engine's words. Icon and words for each; the popover lists what is not saved."
      >
        <div className="grid grid-cols-2 gap-x-8 gap-y-4">
          <ConnectionIndicator host="online" saved={savedState(fx.statusRich.saved)} />
          <ConnectionIndicator host="connecting" />
          <ConnectionIndicator
            host="online"
            saved={savedState(fx.statusOffline.saved)}
          />
          <ConnectionIndicator host="offline" />
          <ConnectionIndicator host="unauthorized" />
        </div>
      </Specimen>

      <Specimen
        title="The client, running against fixtures"
        source="status.slice-ready.json, slice.ready.refused-open-questions.json"
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
            <Button variant="primary" onClick={markReady} loading={marking}>
              <CircleCheck aria-hidden="true" />
              Mark SLICE-001 ready to build
            </Button>
            <Text as="span" size="body-sm" tone="muted">
              The fixture answers with the engine's refusal.
            </Text>
          </div>
          {error ? <ErrorState title="SLICE-001 was not marked ready" message={error.kind === "refused" ? error.message : describeError(error).message} hint={error.hint} /> : null}
          <pre className="overflow-x-auto rounded-md bg-surface-sunken p-4 font-mono text-mono text-ink">
{`const client = createClient();          // fetch, same origin
await client.session();                 // stores the CSRF token
const status = await client.op("status", {});
await client.op("slice.ready", { slice_id: "SLICE-001" });
// failure: MachApiError { kind: "refused", message: "SLICE-001 cannot be marked ready yet: ...", hint }`}
          </pre>
        </div>
      </Specimen>
    </Section>
  );
}
