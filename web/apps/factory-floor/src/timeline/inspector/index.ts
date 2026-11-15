/**
 * The inspector's "In time" section (M6.3 design section 3C), and the evidence hook Evidence
 * Theater (M6.4) builds on:
 *
 * - `InTimeSection({ entity })`: shown by the existing inspector, in both workspaces, for any entity
 *   with spans (a station on its own lists its visits across cells); renders nothing for the rest.
 * - `evidenceRefsOf(scene, ref, events?)`: pure. The artifacts the inspector already knows for an
 *   entity, newest first, as `EvidenceRef` `{ artifactId, producedBy, verifiedBy }`: the catalog id
 *   (the scene artifact id; `artifact:<id>` is its ref), the event that recorded the write, and the
 *   verification records among `events` (the entity's cell's log entries up to the playhead) that
 *   cite its file. References only: nothing reads a file. The section marks each with
 *   `data-evidence-artifact="<catalog id>"`; M6.4 makes these open the Evidence Theater.
 * - `TIMELINE_RULE_WORDS`: rule words the shared RULE_WORDS (shell/inspector/Provenance) lacks; merge
 *   at the call site, the shared words first.
 */
export { InTimeSection } from "./InTimeSection";
export { evidenceRefsOf, hasTimeSection, endedWithoutExit, TIMELINE_RULE_WORDS, gatePositionWords, outcomeStateWords, outcomeWordsOf, visitStateWords, type EvidenceRef, type EvidenceEvent } from "./model";
