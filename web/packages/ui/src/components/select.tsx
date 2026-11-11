import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { controlClass } from "./input";
import { fieldControlProps, useField } from "./field";

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** A second line in the subtle ink, such as an epic's status. */
  description?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps extends Omit<ComponentPropsWithoutRef<typeof SelectPrimitive.Root>, "children"> {
  options: SelectOption[];
  placeholder?: string;
  id?: string;
  className?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
  "aria-describedby"?: string;
}

/** A single choice from a short list. For more than ~12 options use a searchable combobox instead. */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  { options, placeholder = "Choose…", id, className, size = "md", "aria-label": ariaLabel, "aria-describedby": describedBy, ...root },
  ref,
) {
  const field = useField();
  return (
    <SelectPrimitive.Root {...root}>
      <SelectPrimitive.Trigger
        ref={ref}
        aria-label={ariaLabel}
        className={cn(
          controlClass,
          "inline-flex items-center justify-between gap-2 text-left data-[placeholder]:text-ink-subtle",
          size === "sm" ? "h-control-sm px-2 text-body-sm" : "h-control-md px-3 text-body",
          className,
        )}
        {...fieldControlProps(field, { id, "aria-describedby": describedBy })}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown aria-hidden="true" className="size-4 text-ink-muted" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-line-strong bg-surface-raised shadow-2 data-[state=open]:animate-pop-in"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="relative flex cursor-default select-none flex-col rounded-sm py-1.5 pl-8 pr-3 text-body outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-soft data-[highlighted]:text-ink"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2 top-2">
                  <Check aria-hidden="true" className="size-4 text-accent-ink" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                {option.description ? <span className="text-caption text-ink-subtle">{option.description}</span> : null}
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
});
