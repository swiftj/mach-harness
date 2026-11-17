/**
 * The identifiers the evidence player (M6.4) accepts in the address and the store: a ticket and a
 * check id. Letters, digits, `.`, `_`, `-`; never a path, a file name or prose.
 */
export const EVIDENCE_TICKET = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const EVIDENCE_CHECK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
