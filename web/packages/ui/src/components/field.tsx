import { createContext, useContext, useId, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { cn } from "../lib/cn";

interface FieldContextValue {
  id: string;
  hintId: string | undefined;
  errorId: string | undefined;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Inputs inside a <Field> pick up its id, hint and error for labelling and aria-describedby. */
export function useField(): FieldContextValue | null {
  return useContext(FieldContext);
}

export interface FieldProps {
  label: ReactNode;
  /** Shown under the label; says what belongs here. */
  hint?: ReactNode;
  /** Shown under the control; says what is wrong and how to fix it. */
  error?: ReactNode;
  /** Shown after the label in the subtle ink. */
  optional?: boolean;
  children: ReactNode;
  className?: string;
}

/** Label, hint, control and error, wired together for assistive technology. */
export function Field({ label, hint, error, optional, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <FieldContext.Provider value={{ id, hintId, errorId, invalid: Boolean(error) }}>
      <div className={cn("flex flex-col gap-1.5", className)}>
        <label htmlFor={id} className="text-label text-ink">
          {label}
          {optional ? <span className="ml-1.5 font-normal text-ink-subtle">optional</span> : null}
        </label>
        {hint ? (
          <p id={hintId} className="-mt-0.5 text-body-sm text-ink-muted">
            {hint}
          </p>
        ) : null}
        {children}
        {error ? (
          <p id={errorId} className="flex items-start gap-1.5 text-body-sm text-danger-ink">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

export function fieldControlProps(field: FieldContextValue | null, own: { id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling" }) {
  const describedBy = [own["aria-describedby"], field?.hintId, field?.errorId].filter(Boolean).join(" ") || undefined;
  return {
    id: own.id ?? field?.id,
    "aria-describedby": describedBy,
    "aria-invalid": own["aria-invalid"] ?? (field?.invalid || undefined),
  };
}
