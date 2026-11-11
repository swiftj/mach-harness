import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";
import { Spinner } from "./spinner";

export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm font-sans font-semibold",
    "transition-[background-color,border-color,color,box-shadow] duration-[var(--mach-duration-fast)] ease-standard",
    "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
    "[&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        /** The one main action in a region: approve, send, save. */
        primary: "bg-accent-fill text-ink-on-accent hover:bg-accent-fill-hover shadow-1",
        /** Everything else that is a button. */
        secondary: "border border-line-control bg-surface text-ink hover:bg-surface-sunken",
        /** Low-emphasis actions in toolbars and lists. */
        ghost: "text-ink-muted hover:bg-surface-sunken hover:text-ink",
        /** Withdraws or removes something. Always confirmed in a dialog. */
        danger: "bg-danger-fill text-ink-on-accent hover:bg-danger-fill-hover shadow-1",
        /** Inline text action. */
        link: "h-auto px-0 text-accent-ink underline decoration-1 underline-offset-[3px] hover:decoration-2",
      },
      size: {
        sm: "h-control-sm px-2.5 text-body-sm",
        md: "h-control-md px-3.5 text-body-sm",
        lg: "h-control-lg px-5 text-body",
        icon: "size-control-md p-0",
        "icon-sm": "size-control-sm p-0",
      },
    },
    compoundVariants: [{ variant: "link", className: "h-auto px-0" }],
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render the child element (a link, a router link) with button styling. */
  asChild?: boolean;
  /** Shows a spinner, keeps the width, sets aria-busy and blocks clicks. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, loading = false, disabled, children, type, onClick, ...props },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      type={asChild ? undefined : (type ?? "button")}
      disabled={asChild ? undefined : disabled}
      aria-busy={loading || undefined}
      onClick={loading ? (event) => event.preventDefault() : onClick}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? (
            <span className="absolute inset-0 flex items-center justify-center">
              <Spinner size="sm" label="Working" />
            </span>
          ) : null}
          <span className={cn("inline-flex items-center gap-2", loading && "invisible")}>{children}</span>
        </>
      )}
    </Comp>
  );
});
