import { NotBuiltYet, ScreenFrame } from "../../shared/ScreenFrame";

/**
 * Jira: `status` (epics and slices; each work order's `tracking` via `slice.show`); acts
 * `epic.link`, `slice.link`, `jira.export` (offer its `downloads`, links to the host's download
 * route), `jira.keys` with `uploadFile(file, uploadLimits.jiraKeys)` and `dry_run` first.
 * Fixtures: epic.link, slice.link, jira.export(.all), jira.keys(.dry-run), ?refuse=jira.keys.
 */
export function JiraScreen() {
  return (
    <ScreenFrame title="Jira" lead="Link epics and slices to Jira, export a file for Jira's importer, and bring the keys back. Nothing is sent to Jira.">
      <NotBuiltYet what="Each epic and slice with its Jira key, the export, and the keys handed back will be here." />
    </ScreenFrame>
  );
}
