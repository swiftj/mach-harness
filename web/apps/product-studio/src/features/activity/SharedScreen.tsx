import { CircleAlert, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArtifactId, Banner, Button, ErrorState, Heading, Page, Skeleton, SliceStatusPill, SourceBadge, Text, WaveStatusPill, EpicStatusPill, toast, type MachApiError, type Status, Disclosure, FactList, Panel, formatWhen, plural } from "@mach/ui";
import { rememberRefresh, useDeliveryMemory } from "../waves/delivery/memory";
import { asApiError, deliveryOp, useDeliveryRead } from "../waves/delivery/ops";
import { RefreshSummary } from "./RefreshSummary";
import { failureText } from "@mach/ui/api";

interface Row {
  id: string;
  kind: string;
  title: string;
  state: ReactNode;
  source: Status["slices"][number]["source"];
  next: { to: string; label: string } | null;
}

/** Each artifact with where it stands against the shared project, and where to go for it. */
function rows(status: Status): Row[] {
  const out: Row[] = [];
  for (const e of status.epics) {
    out.push({
      id: e.epic_id,
      kind: "Epic",
      title: e.title,
      state: <EpicStatusPill status={e.status} size="sm" />,
      source: e.source,
      next: e.source === "conflict" || e.source === "collision" ? { to: "/inbox", label: "Decide" } : { to: "/roadmap", label: "Open" },
    });
  }
  for (const s of status.slices) {
    const decide = s.source === "conflict" || s.source === "collision";
    const next = decide
      ? { to: "/inbox", label: "Decide" }
      : s.status === "draft" || s.status === "interviewing"
        ? { to: `/slices/${s.slice_id}/interview`, label: "Continue the interview" }
        : s.status === "ready_for_approval"
          ? { to: `/slices/${s.slice_id}`, label: "Review and approve" }
          : { to: `/slices/${s.slice_id}`, label: "Open" };
    out.push({ id: s.slice_id, kind: "Slice", title: s.title, state: <SliceStatusPill status={s.status} size="sm" />, source: s.source, next });
  }
  for (const w of status.waves) {
    const decide = w.source === "conflict" || w.source === "collision";
    const next = decide
      ? { to: "/inbox", label: "Decide" }
      : w.sent
        ? { to: `/waves/${w.wave_id}/review`, label: "Review progress" }
        : w.status === "approved_for_engineering"
          ? { to: `/waves/${w.wave_id}/send`, label: "Send" }
          : { to: "/waves", label: "Open" };
    out.push({ id: w.wave_id, kind: "Delivery wave", title: `${plural(w.slices.length, "slice")}`, state: <WaveStatusPill status={w.status} size="sm" />, source: w.source, next });
  }
  return out;
}

export function SharedScreen() {
  const status = useDeliveryRead("status", {});
  const memory = useDeliveryMemory();
  const [running, setRunning] = useState(false);
  const [hostError, setHostError] = useState<MachApiError | null>(null);
  const last = memory.lastRefresh;

  const refresh = async () => {
    setRunning(true);
    setHostError(null);
    try {
      const result = await deliveryOp("refresh", {});
      rememberRefresh(result);
      if (result.refreshed) toast({ tone: "info", title: "Refreshed the shared project" });
      status.reload();
    } catch (cause) {
      setHostError(asApiError(cause, "refresh"));
    } finally {
      setRunning(false);
    }
  };

  const data = status.data;
  const offline = last && !last.result.refreshed ? last.result : null;
  const decisions = data ? data.needs_reconciling.conflicts.length + data.needs_reconciling.collisions.length : 0;
  const questions = data ? data.slices.filter((s) => s.open_questions > 0).length : 0;

  return (
    <Page>
      <div className="flex flex-col gap-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex max-w-reading flex-col gap-2">
            <Heading level={1}>Shared project</Heading>
            <Text tone="muted">
              What other product managers have shared arrives when you refresh. Refreshing brings their work in beside yours; it never changes your
              unpublished drafts.
            </Text>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Button variant="primary" loading={running} onClick={refresh}>
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
            <Text size="caption" tone="subtle" aria-live="polite">
              {data?.last_refreshed ? `Last refreshed ${formatWhen(data.last_refreshed)}` : data ? "Not refreshed yet" : ""}
            </Text>
          </div>
        </header>

        {hostError ? (
          <ErrorState
            icon={<CircleAlert />}
            {...failureText(hostError, "The shared project was not refreshed")}
            action={<Button onClick={refresh}>Try again</Button>}
          />
        ) : null}

        {offline ? (
          <Banner
            tone="warning"
            live="polite"
            title="The refresh didn't finish"
            actions={
              <Button size="sm" loading={running} onClick={refresh}>
                <RefreshCw aria-hidden="true" />
                Try again
              </Button>
            }
          >
            <p>{offline.problem ?? "The refresh did not finish."}</p>
            <p className="mt-1">
              Nothing in your workspace was changed, and you can keep working.{" "}
              {data?.last_refreshed ? `What you see is from the last successful refresh, ${formatWhen(data.last_refreshed)}.` : "You have not refreshed successfully yet."}
            </p>
          </Banner>
        ) : null}

        {last && last.result.refreshed ? (
          <RefreshSummary result={last.result} status={data} heading={`What changed when you refreshed at ${formatWhen(last.at)}`} />
        ) : null}

        {!last && data ? (
          <Panel className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <Text>
              {data.last_refreshed
                ? `Your workspace last caught up with the shared project ${formatWhen(data.last_refreshed)}. Refresh to see what has changed since.`
                : "Your workspace has not caught up with the shared project yet. Refresh to bring in what others have shared."}
            </Text>
          </Panel>
        ) : null}

        {data && (decisions || questions) ? (
          <nav aria-label="Waiting for you" className="flex flex-wrap gap-3">
            {decisions ? (
              <Button asChild>
                <Link to="/inbox">{plural(decisions, "decision")} to settle</Link>
              </Button>
            ) : null}
            {questions ? (
              <Button asChild>
                <Link to="/inbox">{plural(questions, "interview")} with open questions</Link>
              </Button>
            ) : null}
            <Button asChild variant="ghost">
              <Link to="/waves">Delivery waves and review</Link>
            </Button>
          </nav>
        ) : null}

        <section aria-labelledby="standing-title" className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <Heading level={2} id="standing-title" size="title-2">
              Where everything stands
            </Heading>
            <Text size="body-sm" tone="muted">
              Shared means the shared project has exactly your version. Your draft means only you have it so far.
            </Text>
          </div>
          {status.loading && !data ? (
            <div role="status" aria-busy="true" aria-label="Reading your workspace" className="flex flex-col gap-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !data ? (
            <ErrorState title="Your workspace could not be read" message={status.error ? failureText(status.error, "").message : undefined} action={<Button onClick={status.reload}>Try again</Button>} />
          ) : (
            <div className="overflow-hidden rounded-md border border-line bg-surface">
              <table className="w-full table-fixed border-collapse text-left">
                <caption className="sr-only">Each item in your workspace and where it stands against the shared project</caption>
                <thead className="bg-surface-sunken text-caption text-ink-muted">
                  <tr>
                    <th scope="col" className="w-[44%] px-4 py-2 font-semibold">Item</th>
                    <th scope="col" className="w-[20%] px-4 py-2 font-semibold">State</th>
                    <th scope="col" className="w-[16%] px-4 py-2 font-semibold">Against the shared project</th>
                    <th scope="col" className="w-[20%] px-4 py-2 font-semibold"><span className="sr-only">Go to</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows(data).map((row) => (
                    <tr key={row.id}>
                      <td className="px-4 py-2.5">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <ArtifactId>{row.id}</ArtifactId>
                          <span className="min-w-0 truncate text-body text-ink">{row.title}</span>
                        </div>
                        <span className="text-caption text-ink-subtle">{row.kind}</span>
                      </td>
                      <td className="px-4 py-2.5">{row.state}</td>
                      <td className="px-4 py-2.5">
                        <SourceBadge source={row.source} showDraft />
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {row.next ? (
                          <Link to={row.next.to} className="text-body-sm font-semibold text-accent-ink underline underline-offset-2">
                            {row.next.label}
                            <span className="sr-only"> for {row.id}</span>
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {data || offline ? (
          <Disclosure summary="Details for an engineer">
            <FactList
              facts={[
                ["Shared project", data?.shared_project ?? offline?.shared_project ?? "Unknown"],
                ["Last refreshed", data?.last_refreshed ?? "never"],
                ...(offline?.problem_detail ? ([["Last message", offline.problem_detail]] as Array<[string, string]>) : []),
              ]}
            />
          </Disclosure>
        ) : null}
      </div>
    </Page>
  );
}
