import { Link, Outlet, useLocation } from "react-router";
import {
  AppShell,
  Badge,
  Brand,
  HintProvider,
  ConnectionIndicator,
  NavItem,
  NavRail,
  NavSection,
  ThemeSwitch,
  TopBar,
  useConnectionState,
} from "@mach/ui";
import { client, usingFixtures } from "./api/client";
import { useRefresh, useSession, useStatus } from "./api/store";
import { navigation } from "./features/registry";
import { AppHint } from "./shared/AppHint";
import type { NavEntry } from "./features/types";

const sections: Array<{ id: NavEntry["section"]; title: string }> = [
  { id: "work", title: "Product" },
  { id: "attention", title: "Attention" },
  { id: "deliver", title: "Delivery" },
];

const isCurrent = (entry: NavEntry, path: string) => (entry.to === "/" ? path === "/" : path === entry.to || path.startsWith(`${entry.to}/`));

export function Layout() {
  const location = useLocation();
  const host = useConnectionState(client.connection);
  const session = useSession();
  const status = useStatus();
  const refresh = useRefresh();
  const toSettle = status.data ? status.data.needs_reconciling.conflicts.length + status.data.needs_reconciling.collisions.length : 0;
  const here = navigation.find((entry) => isCurrent(entry, location.pathname));
  const projectName = status.data?.project?.name ?? session.data?.project.name ?? session.data?.project.folder;

  return (
    <AppShell
      nav={
        <NavRail brand={<Brand product="Product Studio" project={projectName} />} footer={<ThemeSwitch />}>
          {sections.map((section) => {
            const entries = navigation.filter((entry) => entry.section === section.id);
            if (!entries.length) return null;
            return (
              <NavSection key={section.id} title={section.title}>
                {entries.map((entry) => {
                  const Icon = entry.icon;
                  const badge = entry.to === "/inbox" && toSettle > 0 ? toSettle : null;
                  return (
                    <NavItem
                      key={entry.to}
                      asChild
                      icon={<Icon />}
                      label={entry.label}
                      current={isCurrent(entry, location.pathname)}
                      badge={badge ? <Badge tone="warning">{badge}</Badge> : undefined}
                      badgeLabel={badge ? `${badge} to settle` : undefined}
                    >
                      <Link to={entry.to} />
                    </NavItem>
                  );
                })}
              </NavSection>
            );
          })}
        </NavRail>
      }
      topBar={
        <TopBar
          title={<span className="text-label text-ink">{here?.label ?? "Product Studio"}</span>}
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
        />
      }
    >
      <HintProvider render={(hint) => <AppHint hint={hint} />}>
        <Outlet />
      </HintProvider>
    </AppShell>
  );
}
