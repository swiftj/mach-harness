import { Link, Outlet, useLocation } from "react-router";
import { AppShell, Badge, ConnectionIndicator, HintProvider, MachMark, NavMenu, NavMenuItem, ThemeSwitch, TopBar, useConnectionState, type Status } from "@mach/ui";
import { client, usingFixtures } from "./api/client";
import { useRefresh, useSession, useStatus } from "./api/store";
import { destinationFor, destinations } from "./features/registry";
import { AppHint } from "./shared/AppHint";

/**
 * The frame of every screen. No rail: the project home is the default screen and leads everywhere;
 * the top bar says where you are (a breadcrumb whose first step goes back home) and keeps the
 * secondary screens one click away in "More".
 */
export function Layout() {
  const location = useLocation();
  const host = useConnectionState(client.connection);
  const session = useSession();
  const status = useStatus();
  const refresh = useRefresh();
  const projectName = status.data?.project?.name ?? session.data?.project.name ?? session.data?.project.folder ?? "Project";
  const here = location.pathname;
  const atHome = here === "/";

  return (
    <AppShell
      topBar={
        <TopBar
          title={
            <>
              <span className="flex shrink-0 items-center gap-2 text-label text-ink">
                <MachMark />
                Product Studio
              </span>
              {atHome ? null : <Breadcrumb projectName={projectName} path={here} status={status.data} />}
            </>
          }
          status={
            <>
              {usingFixtures ? <Badge tone="warning">Fixture data</Badge> : null}
              <ConnectionIndicator
                host={host}
                shared={
                  status.data
                    ? {
                        reachable: refresh.data ? refresh.data.refreshed : refresh.error ? false : null,
                        lastRefreshed: status.data.last_refreshed,
                        description: status.data.shared_project,
                        problem: refresh.data?.problem ?? null,
                      }
                    : undefined
                }
              />
            </>
          }
          actions={
            <NavMenu label="More" current={Boolean(destinationFor(here))} footer={<ThemeSwitch />}>
              <NavMenuItem asChild label="Project home" description="Epics, slices and what to do next" current={atHome}>
                <Link to="/" />
              </NavMenuItem>
              {destinations.map((d) => (
                <NavMenuItem key={d.to} asChild label={d.label} description={d.description} current={destinationFor(here) === d}>
                  <Link to={d.to} />
                </NavMenuItem>
              ))}
            </NavMenu>
          }
        />
      }
    >
      <HintProvider render={(hint) => <AppHint hint={hint} />}>
        <Outlet />
      </HintProvider>
    </AppShell>
  );
}

/** Project / (epic /) where you are. The project's name always leads back to the project home. */
function Breadcrumb({ projectName, path, status }: { projectName: string; path: string; status: Status | null }) {
  const steps: string[] = [];
  const slice = path.match(/^\/slices\/([^/]+)(\/interview)?$/);
  if (slice) {
    const row = status?.slices.find((s) => s.slice_id === slice[1]);
    const epic = row ? status?.epics.find((e) => e.epic_id === row.epic_id) : undefined;
    if (epic) steps.push(epic.title);
    steps.push(row?.title ?? slice[1] ?? "");
  } else {
    const destination = destinationFor(path);
    if (destination) steps.push(destination.label);
  }
  return (
    <nav aria-label="Where you are" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-2 text-body-sm text-ink-muted">
        <li aria-hidden="true" className="text-line-strong">
          |
        </li>
        <li className="min-w-0 shrink-0">
          <Link to="/" className="rounded-xs text-accent-ink underline-offset-2 hover:underline">
            {projectName}
          </Link>
        </li>
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          return (
            <li key={`${index}-${step}`} className="flex min-w-0 items-center gap-2">
              <span aria-hidden="true">/</span>
              <span className={last ? "truncate font-semibold text-ink" : "truncate"} aria-current={last ? "page" : undefined}>
                {step}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
