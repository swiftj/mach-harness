/**
 * Line ranges of a document someone else wrote (a PRD, an idea's brief), and the lines they cite, for quoting as data.
 * Pure, so the PRD on-ramp and Shape's map share one implementation and it is unit-tested through both.
 */

/** "5-9", "12", "8-8, 14-14" (or a list of them) as ranges; anything unreadable is left out. */
export function parseRanges(text: string | readonly string[] | null | undefined): Array<[number, number]> {
  if (!text) return [];
  const parts = typeof text === "string" ? text.split(",") : text.flatMap((t) => t.split(","));
  const out: Array<[number, number]> = [];
  for (const part of parts) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!match) continue;
    const a = Number(match[1]);
    const b = match[2] ? Number(match[2]) : a;
    out.push(a <= b ? [a, b] : [b, a]);
  }
  return out;
}

/** A range in words for reading: "line 8", "lines 5 to 9". */
export function rangeWords([a, b]: [number, number]): string {
  return a === b ? `line ${a}` : `lines ${a} to ${b}`;
}

export interface Quotation {
  range: [number, number];
  lines: Array<{ n: number; text: string }>;
  /** Lines of the range the page does not have (past what it read, or past the document's end). */
  unread: number;
}

/** The cited lines, one quotation per range, from the lines the page read. */
export function quote(lines: Map<number, string> | null, cites: string | readonly string[] | null | undefined): Quotation[] {
  return parseRanges(cites).map((range) => {
    const found: Array<{ n: number; text: string }> = [];
    let unread = 0;
    for (let n = range[0]; n <= range[1]; n++) {
      const text = lines?.get(n);
      if (text === undefined) unread++;
      else found.push({ n, text });
    }
    return { range, lines: found, unread };
  });
}
