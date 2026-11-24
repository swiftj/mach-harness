/**
 * DEVELOPMENT ONLY. Shared by the scripted interview and the fixture transport under
 * `vite --mode fixtures`, so the specification preview changes when the script "writes up" the
 * spec. Never imported by production code.
 */
export const devState = {
  /** Set when the scripted interview's write-up turn reports draft_changed. */
  writtenUp: false,
  /** Set after a reopen in fixture mode; cleared by marking the slice ready again. */
  reopened: new Set<string>(),
  /** How many times slice.ready was asked, for ?ready=refused-once. */
  readyAsked: 0,
  /** What a Shape act answered in this page's life (a verdict recorded, a route found), by idea, for the board's row. */
  ideaActs: new Map<string, { stage?: string; verdict?: unknown; route?: string }>(),
};

/** Query parameters before the hash: http://127.0.0.1:5173/?show=errors#/slices/SLICE-002 */
export function devParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}
