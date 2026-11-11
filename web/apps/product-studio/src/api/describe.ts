/**
 * Workspace paths in product terms, for refresh summaries and decisions. Presentation only.
 *
 *   describePath("product/epics/EPIC-001.json", status)  → "Epic EPIC-001, Team membership"
 */
import { formatWhen } from "@mach/ui";
import type { Status } from "@mach/ui/api";

export interface DescribedPath {
  /** "The project", "Epic EPIC-001, Team membership", "The spec of SLICE-002". */
  label: string;
  /** The engine ID in it, when there is one. */
  id: string | null;
  kind: "project" | "epic" | "work-order" | "spec" | "why" | "wave" | "other";
}

export function describePath(path: string, status?: Status | null): DescribedPath {
  const title = (id: string) =>
    status?.epics.find((e) => e.epic_id === id)?.title ?? status?.slices.find((s) => s.slice_id === id)?.title ?? null;
  const named = (prefix: string, id: string) => {
    const t = title(id);
    return t ? `${prefix} ${id}, ${t}` : `${prefix} ${id}`;
  };
  if (path === "product/project.json") return { label: "The project", id: null, kind: "project" };
  let m = path.match(/^product\/epics\/(EPIC-\d+)\.json$/);
  if (m?.[1]) return { label: named("Epic", m[1]), id: m[1], kind: "epic" };
  m = path.match(/^product\/slices\/(SLICE-\d+)\.json$/);
  if (m?.[1]) return { label: named("Slice", m[1]), id: m[1], kind: "work-order" };
  m = path.match(/^specs\/slices\/(SLICE-\d+)-[^/]+\.md$/);
  if (m?.[1]) return { label: `The spec of ${named("slice", m[1]).replace(/^slice /, "")}`, id: m[1], kind: "spec" };
  m = path.match(/^product\/intents\/(SLICE-\d+)\.md$/);
  if (m?.[1]) return { label: `The why of ${named("slice", m[1]).replace(/^slice /, "")}`, id: m[1], kind: "why" };
  m = path.match(/^product\/delivery-waves\/(WAVE-\d+)\.json$/);
  if (m?.[1]) return { label: `Delivery wave ${m[1]}`, id: m[1], kind: "wave" };
  return { label: path, id: null, kind: "other" };
}

/** Field names as words: "acceptance_criteria" → "acceptance criteria". */
export function fieldWords(field: string): string {
  return field.replaceAll("_", " ");
}

/* ── From the delivery screens (inbox, waves, shared project) ───────────── */

export type ArtifactKind = "project" | "epic" | "work_order" | "why" | "spec" | "wave" | "other";

export interface ArtifactRef {
  kind: ArtifactKind;
  /** The engine ID it belongs to (SLICE-001, EPIC-001, WAVE-002), or null for the project. */
  id: string | null;
  /** The slice, epic or wave this concerns, for routing and grouping. */
  owner: string | null;
  /** "Epic", "Specification", "Slice", ... */
  noun: string;
  path: string;
}

const ID = /[A-Z]+-\d{3,}/;

/** Reads a workspace path such as "product/epics/EPIC-001.json" or "specs/slices/SLICE-001-x.md". */
export function artifactFromPath(path: string): ArtifactRef {
  const id = path.match(ID)?.[0] ?? null;
  if (path === "product/project.json") return { kind: "project", id: null, owner: null, noun: "The project", path };
  if (path.startsWith("product/epics/")) return { kind: "epic", id, owner: id, noun: "Epic", path };
  if (path.startsWith("product/slices/")) return { kind: "work_order", id, owner: id, noun: "Slice", path };
  if (path.startsWith("product/intents/")) return { kind: "why", id, owner: id, noun: "The why for", path };
  if (path.startsWith("specs/slices/")) return { kind: "spec", id, owner: id, noun: "Specification for", path };
  if (path.startsWith("product/delivery-waves/")) return { kind: "wave", id, owner: id, noun: "Delivery wave", path };
  return { kind: "other", id, owner: id, noun: "Item", path };
}

/** The title the workspace knows for an ID, from status. */
export function titleFor(status: Status | null, id: string | null): string | null {
  if (!status) return null;
  if (!id) return status.project?.name ?? null;
  return status.slices.find((s) => s.slice_id === id)?.title ?? status.epics.find((e) => e.epic_id === id)?.title ?? null;
}

const fieldLabels: Record<string, string> = {
  title: "Title",
  name: "Name",
  vision: "Vision",
  outcomes: "Outcomes",
  acceptance_criteria: "Acceptance criteria",
  dependencies: "Depends on",
  epic_id: "Epic",
  slices: "Slices in the wave",
  status: "State",
  open_questions: "Open questions",
  spec_sha256: "Approved specification text",
  spec_path: "Specification",
  approval: "Approval",
};

/** A field name the engine reports, in words. Unknown names are de-snaked. */
export function fieldLabel(field: string): string {
  return fieldLabels[field] ?? field.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** How a single field value reads. Lists stay lists; the spec fingerprint is never shown as a hash. */
export function valueLines(field: string, value: unknown): { lines: string[]; empty: boolean } {
  if (field === "spec_sha256") {
    if (value === null || value === undefined || value === "") return { lines: ["No approved text recorded"], empty: true };
    return { lines: ["Tied to an approved version of the text"], empty: false };
  }
  if (value === null || value === undefined || value === "") return { lines: ["Nothing set"], empty: true };
  if (Array.isArray(value)) return value.length ? { lines: value.map((v) => valueText(v)), empty: false } : { lines: ["None"], empty: true };
  return { lines: [valueText(value)], empty: false };
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && "actor" in value) {
    const approval = value as { actor?: string; approved_at?: string };
    return `Approved by ${approval.actor ?? "someone"}${approval.approved_at ? `, ${formatWhen(approval.approved_at)}` : ""}`;
  }
  return JSON.stringify(value);
}

/** A reviewer remark's kind ("changes_requested", "approved", "commented", "comment") in words. */
export function remarkKind(kind: string): string {
  switch (kind) {
    case "changes_requested":
      return "asked for changes";
    case "approved":
      return "approved";
    case "commented":
    case "comment":
      return "commented";
    default:
      return kind.replace(/_/g, " ");
  }
}

