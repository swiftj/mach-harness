import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { toneClasses } from "./tone";

export type BannerTone = "info" | "success" | "warning" | "danger";

const icons: Record<BannerTone, ReactNode> = {
  info: <Info aria-hidden="true" />,
  success: <CircleCheck aria-hidden="true" />,
  warning: <TriangleAlert aria-hidden="true" />,
  danger: <CircleAlert aria-hidden="true" />,
};

export interface BannerProps {
  tone: BannerTone;
  title: ReactNode;
  children?: ReactNode;
  /** Buttons that resolve the situation. */
  actions?: ReactNode;
  className?: string;
  /**
   * "polite" announces a change that arrived while the person worked (refresh results).
   * "assertive" only for a failure that blocks what they are doing. Leave unset for static banners.
   */
  live?: "polite" | "assertive";
}

/**
 * A persistent message about the page or the workspace: something to settle, something offline,
 * an approval that was withdrawn. Stays until the situation changes; it is not a toast.
 */
export function Banner({ tone, title, children, actions, className, live }: BannerProps) {
  const t = toneClasses[tone];
  return (
    <div
      role={live === "assertive" ? "alert" : live === "polite" ? "status" : undefined}
      className={cn("flex items-start gap-3 rounded-md border px-4 py-3", t.soft, t.line, className)}
    >
      <span className={cn("mt-0.5 [&_svg]:size-[18px]", t.ink)}>{icons[tone]}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className={cn("text-label", t.ink)}>{title}</p>
        {children ? <div className="text-body-sm text-ink">{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2 self-center">{actions}</div> : null}
    </div>
  );
}
