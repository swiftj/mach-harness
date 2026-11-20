import { NavLink } from "react-router";
import { cn } from "@mach/ui";

/**
 * The pages of one slice, as a row of tabs that are links: its specification and, since M15, its
 * effects on shipped behaviour, its principles and policies, its design mocks, and (for a slice
 * made from a PRD) the answers drafted from the PRD. Owned by the shell; each page's content is
 * its feature's.
 */
export type SliceSection = "spec" | "effects" | "policies" | "mocks" | "prd";

const SECTIONS: Array<{ id: SliceSection; label: string; path: string }> = [
  { id: "spec", label: "Specification", path: "" },
  { id: "effects", label: "Effects on shipped behaviour", path: "/effects" },
  { id: "policies", label: "Principles and policies", path: "/policies" },
  { id: "mocks", label: "Design mocks", path: "/mocks" },
  { id: "prd", label: "From the PRD", path: "/prd" },
];

/** The label of a slice page, for the breadcrumb. */
export function sliceSectionLabel(path: string): string | null {
  return SECTIONS.find((s) => s.path && s.path === path)?.label ?? null;
}

export function SliceSections({ sliceId, fromPrd = false }: { sliceId: string; fromPrd?: boolean }) {
  const shown = SECTIONS.filter((s) => s.id !== "prd" || fromPrd);
  return (
    <nav aria-label="This slice" className="border-b border-line">
      <ul className="-mb-px flex flex-wrap gap-x-5">
        {shown.map((s) => (
          <li key={s.id}>
            <NavLink
              end
              to={`/slices/${sliceId}${s.path}`}
              className={({ isActive }) =>
                cn(
                  "inline-flex h-10 items-center border-b-2 text-label transition-colors duration-[var(--mach-duration-fast)]",
                  isActive ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink",
                )
              }
            >
              {s.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
