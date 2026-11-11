import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProductName, ThemeName } from "../tokens/tokens";

export type ThemePreference = ThemeName | "system";

interface ThemeContextValue {
  /** What the person chose. */
  preference: ThemePreference;
  /** What is showing now. */
  resolved: ThemeName;
  setPreference: (preference: ThemePreference) => void;
  product: ProductName;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "mach.theme";

function readStored(): ThemePreference | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : null;
  } catch {
    return null;
  }
}

function writeStored(value: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage can be unavailable (private windows, blocked site data). The choice then lasts for this visit.
  }
}

function systemTheme(): ThemeName {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export interface ThemeProviderProps {
  children: ReactNode;
  /** Which product's flavour of the family. Control Tower defaults to dark. */
  product?: ProductName;
  /** Used when nothing is stored. */
  defaultPreference?: ThemePreference;
  /** Do not remember the choice (the showcase renders both themes side by side). */
  persist?: boolean;
}

/**
 * Sets `data-theme` and `data-product` on <html>. Tokens and the Tailwind `dark:` variant key off these.
 */
export function ThemeProvider({
  children,
  product = "product-studio",
  defaultPreference,
  persist = true,
}: ThemeProviderProps) {
  const fallback: ThemePreference = defaultPreference ?? (product === "control-tower" ? "dark" : "system");
  const [preference, setPreferenceState] = useState<ThemePreference>(() => (persist ? readStored() : null) ?? fallback);
  const [system, setSystem] = useState<ThemeName>(systemTheme);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const onChange = () => setSystem(query.matches ? "dark" : "light");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolved: ThemeName = preference === "system" ? system : preference;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.product = product;
  }, [resolved, product]);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      setPreferenceState(next);
      if (persist) writeStored(next);
    },
    [persist],
  );

  const value = useMemo(() => ({ preference, resolved, setPreference, product }), [preference, resolved, setPreference, product]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>.");
  return value;
}
