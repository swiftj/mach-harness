/**
 * What the Atlas's review chamber says about its consensus gate (D10), from the gate's own record
 * and in the inspector's words (`gateStateWords`), so the Atlas and the inspector can never tell two
 * stories about one gate. Pure: no React, no drawing.
 *
 * While a panel sits, the chamber shows that round's gate. When none sits, the chamber is empty, but
 * the gate it points at is still a real one: the latest review gate (of the selected cell when it has
 * one), named with its ticket and round as the last review, never "open".
 */
import { gateId, gateStateWords, latestGateOf, type CellState, type GateState, type ReviewRoundState, type Scene } from "../sim";

export interface ChamberGate {
  /** The gate the chamber's hit target selects and names; null before any review. */
  readonly gate: GateState | null;
  /** Whether a panel sits now (the gate is that round's). */
  readonly sitting: boolean;
  /** The ref to select: the gate's own, or the station's when there is no review yet. */
  readonly ref: `gate:${string}`;
  /** The accessible name of the chamber's gate. */
  readonly label: string;
}

const lower = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

/** The review round a gate state is for, read from the cell that holds it. */
function roundOf(scene: Scene, gate: GateState): ReviewRoundState | undefined {
  return scene.cells[gate.ticketId]?.reviews.find((r) => r.round === gate.round);
}

function outcomeWords(round: ReviewRoundState | undefined): string | null {
  if (!round?.outcome) return null;
  return round.outcome === "AWAITING_HUMAN" ? "the panel approved; a person must approve next at the human approval gate" : `panel outcome ${round.outcome}`;
}

/**
 * The chamber's consensus gate at this scene. `occupant` is the panel the chamber shows (null when
 * none sits); `prefer` the ticket of what the person selected; `sitting` how many panels sit.
 */
export function chamberGate(scene: Scene, occupant: { readonly cell: CellState; readonly roundIndex: number } | null, prefer: string | null, sitting = occupant ? 1 : 0): ChamberGate {
  const many = sitting > 1 ? `. ${sitting} panels sitting` : "";
  if (occupant) {
    const round = occupant.cell.reviews[occupant.roundIndex];
    const gate = scene.gates[gateId(occupant.cell.ticketId, "review", round?.round ?? 1)] ?? null;
    const outcome = outcomeWords(round);
    return {
      gate,
      sitting: true,
      ref: gate ? `gate:${gate.id}` : "gate:review",
      label: `Review consensus gate, ${occupant.cell.ticketId} round ${round?.round ?? "?"}: ${gate ? lower(gateStateWords(gate)) : "not reached yet"}${outcome ? `; ${outcome}` : ""}${many}`,
    };
  }
  const gate = (prefer ? latestGateOf(scene, "review", prefer) : null) ?? latestGateOf(scene, "review");
  if (!gate) return { gate: null, sitting: false, ref: "gate:review", label: "Review consensus gate: no panel sitting; no review yet" };
  const outcome = outcomeWords(roundOf(scene, gate));
  return {
    gate,
    sitting: false,
    ref: `gate:${gate.id}`,
    label: `Review consensus gate: no panel sitting. Last review: ${gate.ticketId} round ${gate.round ?? "?"}, ${lower(gateStateWords(gate))}${outcome ? `; ${outcome}` : ""}`,
  };
}
