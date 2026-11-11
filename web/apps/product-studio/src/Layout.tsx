import { useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { House } from "lucide-react";
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
            <NavItem asChild icon={<House />} label="Home" current={location.pathname === "/"}>
              <Link to="/">
                <House aria-hidden="true" className="size-[18px]" />
                <span className="min-w-0 flex-1 truncate text-left">Home</span>
              </Link>
            </NavItem>
          </NavSection>
        </NavRail>
      }
      topBar={
        <TopBar
          title={<span className="text-label text-ink">Home</span>}
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
