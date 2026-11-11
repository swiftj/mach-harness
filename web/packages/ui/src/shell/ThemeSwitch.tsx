import { Monitor, Moon, Sun } from "lucide-react";
import { useId } from "react";
import { cn } from "../lib/cn";
import { useTheme, type ThemePreference } from "../theme/ThemeProvider";
import { useRail } from "./AppShell";

const options: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/** Light, dark or follow the system. A radio group: arrow keys move, the choice is remembered. */
export function ThemeSwitch({ compact }: { compact?: boolean }) {
  const { preference, setPreference } = useTheme();
  const { collapsed } = useRail();
  const name = useId();
  const iconOnly = compact ?? collapsed;
  return (
    <fieldset className={cn("flex rounded-sm border border-line bg-surface p-0.5", iconOnly ? "flex-col" : "flex-row")}>
      <legend className="sr-only">Theme</legend>
      {options.map(({ value, label, icon: Icon }) => (
        <label
          key={value}
          title={label}
          className={cn(
            "relative flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-xs py-1 text-caption text-ink-muted",
            "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus",
            preference === value && "bg-surface-sunken font-semibold text-ink",
          )}
        >
          <input
            type="radio"
            name={name}
            value={value}
            checked={preference === value}
            onChange={() => setPreference(value)}
            className="sr-only"
          />
          <Icon aria-hidden="true" className="size-3.5" />
          <span className={iconOnly ? "sr-only" : undefined}>{label}</span>
        </label>
      ))}
    </fieldset>
  );
}
