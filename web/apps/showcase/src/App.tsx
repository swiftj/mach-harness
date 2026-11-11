import { useEffect, useState } from "react";
import { Activity, Boxes, Layers, MousePointerClick, Network, Palette, PanelsTopLeft, SquareStack } from "lucide-react";
import { AppShell, Brand, ConnectionIndicator, Heading, NavItem, NavRail, NavSection, Page, Text, ThemeSwitch, TopBar, type ProductName } from "@mach/ui";
import { Foundations } from "./sections/Foundations";
import { Controls } from "./sections/Controls";
import { Overlays } from "./sections/Overlays";
import { States } from "./sections/States";
import { Lifecycle } from "./sections/Lifecycle";
import { GraphSection } from "./sections/Graph";
import { ShellSection } from "./sections/Shell";
import { fx } from "./fixtures";

const sections = [
  { id: "foundations", label: "Foundations", icon: <Palette /> },
  { id: "controls", label: "Controls", icon: <MousePointerClick /> },
  { id: "overlays", label: "Dialogs and sheets", icon: <SquareStack /> },
  { id: "states", label: "Status and feedback", icon: <Activity /> },
  { id: "lifecycle", label: "Lifecycle", icon: <Layers /> },
  { id: "graph", label: "Graph", icon: <Network /> },
  { id: "shell", label: "Shell and API", icon: <PanelsTopLeft /> },
];

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.slice(1));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function App({ product }: { product: ProductName }) {
  const hash = useHash() || "foundations";
  const other: ProductName = product === "control-tower" ? "product-studio" : "control-tower";
  const status = fx.statusPublished;
  return (
    <AppShell
      nav={
        <NavRail brand={<Brand product="Design system" project="One family, two products" />} footer={<ThemeSwitch />}>
          <NavSection title="Contents">
            {sections.map((s) => (
              <NavItem key={s.id} href={`#${s.id}`} icon={s.icon} label={s.label} current={hash === s.id} />
            ))}
          </NavSection>
        </NavRail>
      }
      topBar={
        <TopBar
          title={
            <>
              <Boxes aria-hidden="true" className="size-4 text-ink-subtle" />
              <span className="text-label text-ink">@mach/ui</span>
              <span className="text-body-sm text-ink-muted">showing {product === "control-tower" ? "Control Tower" : "Product Studio"}</span>
            </>
          }
          status={
            <ConnectionIndicator
              host="online"
              shared={{ reachable: true, lastRefreshed: status.last_refreshed, description: status.shared_project }}
            />
          }
          actions={
            <a
              className="inline-flex h-control-sm items-center rounded-sm border border-line-control bg-surface px-2.5 text-body-sm font-semibold text-ink hover:bg-surface-sunken"
              href={`?product=${other}${window.location.hash}`}
            >
              View as {other === "control-tower" ? "Control Tower" : "Product Studio"}
            </a>
          }
        />
      }
    >
      <Page>
        <header className="mb-14 flex max-w-reading flex-col gap-3">
          <Heading level={1} size="display">
            The MACH design system
          </Heading>
          <Text size="body-lg" editorial tone="muted">
            Tokens, components and patterns shared by Product Studio and Control Tower. Every example on this page is drawn from the
            product engine's real output in <span className="font-mono text-mono">web/fixtures</span>.
          </Text>
        </header>
        <div className="flex flex-col gap-16">
          <Foundations />
          <Controls />
          <Overlays />
          <States />
          <Lifecycle />
          <GraphSection />
          <ShellSection />
        </div>
      </Page>
    </AppShell>
  );
}
