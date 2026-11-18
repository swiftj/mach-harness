import { ChevronDown } from "lucide-react";
import { cloneElement, createContext, isValidElement, useContext, useState, type ReactElement, type ReactNode } from "react";
import { Button } from "../components/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { cn } from "../lib/cn";

const MenuContext = createContext<{ close: () => void }>({ close: () => {} });

export interface NavMenuProps {
  /** The trigger's words and the navigation's name, such as "More". */
  label: string;
  /** The destinations: <NavMenuItem> each. */
  children: ReactNode;
  /** Below the destinations, separated: the theme switch, for example. */
  footer?: ReactNode;
  /** Marks the trigger when the current page is one of the menu's destinations. */
  current?: boolean;
}

/**
 * Secondary destinations behind one quiet top-bar button, for a product whose home screen leads
 * everywhere and needs no rail. A navigation landmark inside a popover: Tab and Shift+Tab move
 * through the links, Escape closes it and focus returns to the button, following a link closes it.
 */
export function NavMenu({ label, children, footer, current = false }: NavMenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={cn(current && "text-accent-ink")}>
          {label}
          <ChevronDown aria-hidden="true" className={cn("transition-transform duration-[var(--mach-duration-fast)]", open && "rotate-180")} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <MenuContext.Provider value={{ close: () => setOpen(false) }}>
          <nav aria-label={label}>
            <ul className="flex flex-col gap-0.5">{children}</ul>
          </nav>
        </MenuContext.Provider>
        {footer ? <div className="mt-2 border-t border-line px-1 pt-2">{footer}</div> : null}
      </PopoverContent>
    </Popover>
  );
}

export interface NavMenuItemProps {
  label: string;
  /** One line under the label: what the destination is for. */
  description?: string;
  /** Marks the current page (aria-current="page"). */
  current?: boolean;
  /** Your router's link, with no children: <NavMenuItem asChild ...><Link to="/" /></NavMenuItem>. */
  asChild?: boolean;
  children?: ReactElement;
  href?: string;
}

export function NavMenuItem({ label, description, current, asChild, children, href }: NavMenuItemProps) {
  const { close } = useContext(MenuContext);
  const shared = {
    className: cn(
      "relative flex w-full flex-col gap-0.5 rounded-sm px-3 py-2 text-left",
      "transition-colors duration-[var(--mach-duration-fast)] hover:bg-surface-sunken",
      current && "bg-accent-soft hover:bg-accent-soft",
    ),
    onClick: close,
    "aria-current": current ? ("page" as const) : undefined,
  };
  const inner = (
    <>
      {current ? <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" /> : null}
      <span className={cn("text-body-sm", current ? "font-semibold text-accent-ink" : "text-ink")}>{label}</span>
      {description ? <span className="text-caption text-ink-muted">{description}</span> : null}
    </>
  );
  const content =
    asChild && isValidElement(children) ? (
      cloneElement(children as ReactElement<Record<string, unknown>>, shared, inner)
    ) : (
      <a href={href} {...shared}>
        {inner}
      </a>
    );
  return <li>{content}</li>;
}
