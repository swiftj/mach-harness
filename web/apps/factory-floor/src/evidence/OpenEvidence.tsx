/**
 * The ways into the evidence player (M6.4, design 4.1): from a cell's inspector, from a check in a
 * verification gate's "What it checked", from an artifact cited by a check, and from an evidence
 * reference in the Timeline's inspector. Each only asks the store to open the player; the address then
 * carries the ticket and the check, never a path. Button names are IDs and words, never file names.
 */
import { useCallback } from "react";
import { Button, cn } from "@mach/ui";
import { FileSearch } from "lucide-react";
import { useStore, type EvidenceOpen } from "../scene";

export interface OpenEvidenceProps {
  readonly ticket: string;
  readonly check?: string | null;
  /** In memory only: the file to start at. */
  readonly start?: EvidenceOpen["start"];
  /** Visible words; the accessible name is the same words (IDs only). */
  readonly children: string;
  readonly size?: "sm" | "md";
  readonly variant?: "secondary" | "ghost" | "link";
  readonly className?: string;
}

export function OpenEvidence({ ticket, check = null, start = null, children, size = "sm", variant = "secondary", className }: OpenEvidenceProps) {
  const store = useStore();
  const open = useCallback(() => store.openEvidence(ticket, { check, start }), [store, ticket, check, start]);
  return (
    <Button type="button" size={size} variant={variant} onClick={open} className={cn("gap-1.5", className)} data-open-evidence={check ?? ticket} aria-haspopup="dialog">
      {variant === "link" ? null : <FileSearch aria-hidden="true" />}
      {children}
    </Button>
  );
}
