/**
 * The inspector's "In time" section (M6.3 design section 3C), and the evidence hook Evidence
 * Theater (M6.4) builds on:
 *
 * - `InTimeSection({ entity })`: shown by the existing inspector, in both workspaces, for any entity
 *   with spans; renders nothing for the rest.
 * - `evidenceRefsOf(scene, ref, events?)`: pure. The artifacts the inspector already knows for an
 *   entity, newest first, as `{ artifactId, producedBy, verifiedBy }`: the catalog id (the scene
 *   artifact id; `artifact:<id>` is its ref), the event that recorded the write, and the
 *   verification records among `events` (the entity's cell's log entries up to the playhead) that
 *   cite its file. References only: nothing reads a file.
 */
export { InTimeSection } from "./InTimeSection";
export { evidenceRefsOf, hasTimeSection, type EvidenceRef, type EvidenceEvent } from "./model";
