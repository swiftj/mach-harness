/**
 * Missing is not zero, for count figures whose members are known only by exclusion (shared by the
 * areas; pure, tested in test/analytics-wire.test.mjs).
 */
import type { MetricRow } from "../contract";

/**
 * Why a count figure observed no member although members are known by exclusion (the observer's
 * coverage says so): its value is null, or members were excluded with a reason. Null when "none" is true.
 */
export function unobserved(row: MetricRow | undefined): string | null {
  if (!row) return null;
  const excluded = (row.coverage.excluded ?? []).filter((e) => e.count > 0);
  if (row.value !== null && !excluded.length) return null;
  if (row.value !== null && (row.numerator_value ?? 0) > 0) return null;
  const parts = excluded.map((e) =>
    /^blockers counted in the run record with no review finding/.test(e.reason)
      ? `${e.count} ${e.count === 1 ? "blocker is" : "blockers are"} counted in run records, with no review finding in the lifecycle to say which rule${/no vote file/.test(e.reason) ? " (no vote file was read)" : ""}`
      : `${e.count} ${e.reason}`,
  );
  return parts.length ? `${parts.join("; ")}.` : row.null_reason ? `${row.null_reason.charAt(0).toUpperCase()}${row.null_reason.slice(1)}.` : null;
}

