/**
 * DEVELOPMENT ONLY. Shared by the scripted interview and the fixture transport under
 * `vite --mode fixtures`, so the specification preview changes when the script "writes up" the
 * spec. Never imported by production code.
 */
export const devState = {
  /** Set when the scripted interview's write-up turn reports draft_changed. */
  writtenUp: false,
  /** Set after a successful approval in fixture mode; cleared by reopen. */
  approved: new Set<string>(),
};

/** Query parameters before the hash: http://127.0.0.1:5173/?show=errors#/slices/SLICE-002 */
export function devParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}
