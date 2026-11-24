import { useEffect, useRef } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { AppShell, Badge, ConnectionIndicator, HintProvider, MachMark, NavMenu, NavMenuItem, ThemeSwitch, TopBar, savedState, useConnectionState, type Status } from "@mach/ui";
import { client, usingFixtures } from "./api/client";
import { useRefresh, useSession, useStatus } from "./api/store";
import { destinationFor, destinations } from "./features/registry";
import { AppHint } from "./shared/AppHint";
import { sliceSectionLabel } from "./shared/SliceSections";
import { shapeBreadcrumb } from "./features/shape/shell/steps";
import { needsBreadcrumb } from "./features/needs/shell/paths";

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
  useGithubRecheck(Boolean(status.data?.saved.github_check), refresh.loading, refresh.run);
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
                saved={status.data ? savedState(status.data.saved) : undefined}
                onCheckAgain={() => void refresh.run()}
                checking={refresh.loading}
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
  const slice = path.match(/^\/slices\/([^/]+)(\/[a-z]+)?$/);
  const epicPage = path.match(/^\/epics\/([^/]+)\/today$/);
  const prdPage = path.match(/^\/prds\/([^/]+)$/);
  const requestStart = path.match(/^\/start\/requests\/(\d+)$/);
  const shape = shapeBreadcrumb(path, status);
  const needs = needsBreadcrumb(path, status?.designs);
  if (shape) {
    steps.push(...shape);
  } else if (needs) {
    steps.push(...needs);
  } else if (slice) {
    const row = status?.slices.find((s) => s.slice_id === slice[1]);
    const epic = row ? status?.epics.find((e) => e.epic_id === row.epic_id) : undefined;
    if (epic) steps.push(epic.title);
    steps.push(row?.title ?? slice[1] ?? "");
    // M15: a slice's own pages (effects, principles and policies, mocks, from the PRD).
    const section = slice[2] && slice[2] !== "/interview" ? sliceSectionLabel(slice[2]) : null;
    if (section) steps.push(section);
  } else if (epicPage) {
    const epic = status?.epics.find((e) => e.epic_id === epicPage[1]);
    steps.push(epic?.title ?? epicPage[1] ?? "", "How it works today");
  } else if (prdPage) {
    steps.push("Start from a PRD", prdPage[1] ?? "");
  } else if (requestStart) {
    steps.push(`Start from request #${requestStart[1] ?? ""}`);
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

/** The app's own checks of GitHub after one failed: the first after a moment, then one, two, four ... up to fifteen minutes apart. */
const FIRST_RECHECK_MS = 5_000;
const RECHECK_MS = 60_000;
const RECHECK_MAX_MS = 15 * 60_000;

/**
 * A failed check of GitHub is tried again without being asked: shortly after the app shows the failure, then when the
 * window is looked at, the computer is back on a network, or the wait is over. Each check that fails again doubles the
 * wait, so a long outage does not keep the project busy; a check that works ends it. The indicator's "Check GitHub
 * again" does the same on a person's word.
 */
function useGithubRecheck(failed: boolean, checking: boolean, check: () => Promise<void>) {
  const state = useRef({ last: 0, wait: FIRST_RECHECK_MS, since: 0 });
  useEffect(() => {
    if (!failed) {
      state.current = { last: 0, wait: FIRST_RECHECK_MS, since: 0 };
      return;
    }
    if (!state.current.since) state.current.since = Date.now();
    const again = () => {
      const s = state.current;
      if (checking || document.visibilityState === "hidden" || Date.now() - Math.max(s.last, s.since) < s.wait) return;
      s.last = Date.now();
      s.wait = s.wait < RECHECK_MS ? RECHECK_MS : Math.min(s.wait * 2, RECHECK_MAX_MS);
      void check();
    };
    const timer = window.setInterval(again, FIRST_RECHECK_MS);
    window.addEventListener("focus", again);
    window.addEventListener("online", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", again);
      window.removeEventListener("online", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [failed, checking, check]);
}
