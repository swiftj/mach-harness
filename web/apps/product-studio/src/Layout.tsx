import { useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import {
  AppShell,
  Badge,
  Brand,
  ConnectionIndicator,
  NavItem,
  NavRail,
  NavSection,
  ThemeSwitch,
  TopBar,
  useConnectionState,
  type Session,
} from "@mach/ui";
import { client, usingFixtures } from "./api/client";
import { navigation } from "./features/registry";

export function Layout() {
  const location = useLocation();
  const host = useConnectionState(client.connection);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    client.session().then(setSession, () => undefined);
  }, []);

  return (
    <AppShell
      nav={
        <NavRail brand={<Brand product="Product Studio" project={session?.project.name ?? session?.project.folder} />} footer={<ThemeSwitch />}>
          <NavSection>
            {navigation.map((entry) => {
              const Icon = entry.icon;
              const current = entry.to === "/" ? location.pathname === "/" : location.pathname.startsWith(entry.to);
              return (
                <NavItem key={entry.to} asChild icon={<Icon />} label={entry.label} current={current}>
                  <Link to={entry.to}>
                    <Icon aria-hidden="true" className="size-[18px]" />
                    <span className="min-w-0 flex-1 truncate text-left">{entry.label}</span>
                  </Link>
                </NavItem>
              );
            })}
          </NavSection>
        </NavRail>
      }
      topBar={
        <TopBar
          title={<span className="text-label text-ink">{navigation.find((entry) => (entry.to === "/" ? location.pathname === "/" : location.pathname.startsWith(entry.to)))?.label ?? "Product Studio"}</span>}
          status={
            <>
              {usingFixtures ? <Badge tone="warning">Fixture data</Badge> : null}
              <ConnectionIndicator host={host} />
            </>
          }
        />
      }
    >
      <Outlet />
    </AppShell>
  );
}
