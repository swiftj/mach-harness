import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cloneElement, createContext, isValidElement, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { layout } from "../tokens/tokens";
import { Tooltip } from "../components/tooltip";

const RailContext = createContext<{ collapsed: boolean }>({ collapsed: false });

function useNarrow(): boolean {
  const query = `(max-width: ${layout.compactBreakpoint - 1}px)`;
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia?.(query).matches);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return Boolean(narrow);
}

export interface AppShellProps {
  /** The navigation rail (<NavRail>). */
  nav: ReactNode;
  /** The top bar (<TopBar>). */
  topBar: ReactNode;
  children: ReactNode;
  /** Id of the main region, the skip link's target. */
  mainId?: string;
}

/**
 * The application frame shared by Product Studio and Control Tower:
 *
 *   ┌──────────┬──────────────────────────────────────┐
 *   │          │ top bar: place, connection, actions   │
 *   │   rail   ├──────────────────────────────────────┤
 *   │          │ main content (scrolls)                │
 *   └──────────┴──────────────────────────────────────┘
 *
 * The page never scrolls horizontally; only <main> scrolls. A skip link jumps past the rail.
 */
export function AppShell({ nav, topBar, children, mainId = "main" }: AppShellProps) {
  return (
    <div data-mach-shell="" className="flex h-dvh min-w-[1024px] overflow-hidden bg-canvas text-ink">
      <a
        href={`#${mainId}`}
        className="sr-only z-[70] rounded-sm bg-surface-raised px-3 py-2 text-label text-ink shadow-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      {nav}
      <div className="flex min-w-0 flex-1 flex-col">
        {topBar}
        <main id={mainId} tabIndex={-1} className="relative min-h-0 flex-1 overflow-y-auto focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}

export interface NavRailProps {
  /** Product mark and project name, at the top. */
  brand: ReactNode;
  children: ReactNode;
  /** Pinned to the bottom: theme switch, help. */
  footer?: ReactNode;
  /** Controlled collapse. When omitted, the rail collapses itself below the compact breakpoint. */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  label?: string;
}

export function NavRail({ brand, children, footer, collapsed: controlled, onCollapsedChange, label = "Main" }: NavRailProps) {
  const narrow = useNarrow();
  const [own, setOwn] = useState<boolean | null>(null);
  const collapsed = controlled ?? own ?? narrow;
  const toggle = () => {
    const next = !collapsed;
    if (onCollapsedChange) onCollapsedChange(next);
    else setOwn(next);
  };
  return (
    <RailContext.Provider value={{ collapsed }}>
      <nav
        aria-label={label}
        style={{ width: collapsed ? layout.railCollapsed : layout.railExpanded }}
        className="flex shrink-0 flex-col border-r border-line bg-surface-nav transition-[width] duration-[var(--mach-duration-base)] ease-standard"
      >
        <div className={cn("flex h-top-bar items-center gap-2 border-b border-line", collapsed ? "justify-center px-0" : "px-4")}>
          {collapsed ? null : <div className="min-w-0 flex-1">{brand}</div>}
          <Tooltip content={collapsed ? "Expand navigation" : "Collapse navigation"} side="right">
            <button
              type="button"
              onClick={toggle}
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
              className="inline-flex size-8 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-sunken hover:text-ink"
            >
              {collapsed ? <PanelLeftOpen aria-hidden="true" className="size-4" /> : <PanelLeftClose aria-hidden="true" className="size-4" />}
            </button>
          </Tooltip>
        </div>
        <div className={cn("flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto py-4", collapsed ? "px-2" : "px-3")}>{children}</div>
        {footer ? <div className={cn("border-t border-line py-3", collapsed ? "px-2" : "px-3")}>{footer}</div> : null}
      </nav>
    </RailContext.Provider>
  );
}

export function useRail() {
  return useContext(RailContext);
}

export function NavSection({ title, children }: { title?: string; children: ReactNode }) {
  const { collapsed } = useRail();
  return (
    <div className="flex flex-col gap-0.5">
      {title && !collapsed ? <p className="px-2 pb-1 text-caption font-semibold text-ink-subtle">{title}</p> : null}
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

export interface NavItemProps {
  icon: ReactNode;
  label: string;
  /** Marks the current page (aria-current="page"). */
  current?: boolean;
  /** A count or short marker after the label, such as open conflicts. Announced with the label. */
  badge?: ReactNode;
  /** Plain-text version of the badge for the accessible name, e.g. "3 to settle". */
  badgeLabel?: string;
  /**
   * Your router's link, with no children: <NavItem asChild ...><Link to="/" /></NavItem>.
   * NavItem fills it with the icon, label and badge, so a link looks and collapses like any item.
   */
  asChild?: boolean;
  children?: ReactElement;
  onClick?: () => void;
  href?: string;
}

export function NavItem({ icon, label, current, badge, badgeLabel, asChild, children, onClick, href }: NavItemProps) {
  const { collapsed } = useRail();
  const className = cn(
    "group relative flex h-9 w-full items-center gap-2.5 rounded-sm text-body-sm text-ink-muted",
    "transition-colors duration-[var(--mach-duration-fast)] hover:bg-surface-sunken hover:text-ink",
    collapsed ? "justify-center px-0" : "px-2",
    current && "bg-accent-soft font-semibold text-accent-ink hover:bg-accent-soft hover:text-accent-ink",
  );
  const inner = (
    <>
      {current ? <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" /> : null}
      <span aria-hidden="true" className="inline-flex shrink-0 [&_svg]:size-[18px]">
        {icon}
      </span>
      {collapsed ? null : <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
      {!collapsed && badge ? (
        <span className="ml-auto">
          {badge}
          {badgeLabel ? <span className="sr-only">, {badgeLabel}</span> : null}
        </span>
      ) : null}
      {collapsed && badge ? <span aria-hidden="true" className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-warning-fill" /> : null}
    </>
  );
  const shared = {
    className,
    onClick,
    "aria-current": current ? ("page" as const) : undefined,
    "aria-label": collapsed ? [label, badgeLabel].filter(Boolean).join(", ") : undefined,
  };
  const content =
    asChild && isValidElement(children) ? (
      cloneElement(children as ReactElement<Record<string, unknown>>, shared, inner)
    ) : href ? (
      <a href={href} {...shared}>
        {inner}
      </a>
    ) : (
      <button type="button" {...shared}>
        {inner}
      </button>
    );
  return <li>{collapsed ? <Tooltip content={label} side="right">{content}</Tooltip> : content}</li>;
}

export interface TopBarProps {
  /** Where the person is: a breadcrumb or a title. */
  title: ReactNode;
  /** Connection indicator and other status, before the actions. */
  status?: ReactNode;
  /** The page's actions. At most one primary button. */
  actions?: ReactNode;
}

export function TopBar({ title, status, actions }: TopBarProps) {
  return (
    <header className="flex h-top-bar shrink-0 items-center gap-4 border-b border-line bg-canvas px-6">
      <div className="flex min-w-0 flex-1 items-center gap-2">{title}</div>
      {status ? <div className="flex shrink-0 items-center gap-3">{status}</div> : null}
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export interface PageProps {
  children: ReactNode;
  /** "reading" keeps text to a comfortable measure; "wide" fills to the content maximum; "full" for graphs. */
  width?: "reading" | "wide" | "full";
  className?: string;
}

/** Content padding and width for one page inside <main>. */
export function Page({ children, width = "wide", className }: PageProps) {
  return (
    <div
      className={cn(
        "px-10 py-8",
        width === "reading" && "max-w-[calc(var(--mach-reading-measure)+5rem)]",
        width === "wide" && "max-w-content",
        width === "full" && "h-full p-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface BrandProps {
  /** "Product Studio" or "Control Tower". */
  product: string;
  /** The project's name from the session or status. */
  project?: string | null;
}

/**
 * The MACH mark: four cells, one lit. Each ticket in the factory is built in its own isolated cell;
 * the mark is that idea, drawn plainly. It is MACH's own and borrows no third-party logo.
 */
export function MachMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className="shrink-0">
      <rect x="1" y="1" width="8" height="8" rx="1.5" fill="var(--mach-ink)" />
      <rect x="11" y="1" width="8" height="8" rx="1.5" fill="none" stroke="var(--mach-ink)" strokeWidth="1.5" />
      <rect x="1" y="11" width="8" height="8" rx="1.5" fill="none" stroke="var(--mach-ink)" strokeWidth="1.5" />
      <rect x="11" y="11" width="8" height="8" rx="1.5" fill="var(--mach-accent)" />
    </svg>
  );
}

export function Brand({ product, project }: BrandProps) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <MachMark />
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-label text-ink">
          MACH <span className="font-normal text-ink-muted">{product}</span>
        </span>
        {project ? <span className="truncate text-caption text-ink-subtle">{project}</span> : null}
      </div>
    </div>
  );
}
