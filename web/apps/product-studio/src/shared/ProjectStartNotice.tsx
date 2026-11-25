import { Banner, Button } from "@mach/ui";
import type { Status } from "@mach/ui/api";
import { forgetProjectStart, useProjectStartNote } from "../api/projectStart";
import { IssueLink, IssueText } from "./IssueLink";
import { CloseProjectIssues } from "./CloseProjectIssue";
import { projectOnGithubWords } from "./team";

/**
 * M20: before the product is named, from the last time GitHub was read: this repository already has a project, so naming
 * it here takes that project's name, vision and outcomes instead of what is typed. Said before anything is typed, on the
 * start screen and above the "Name the product" form. Nothing when GitHub held no project or was not read.
 */
export function ProjectOnGithubNotice({ found, className }: { found: Status["project_on_github"]; className?: string }) {
  const words = projectOnGithubWords(found);
  if (!found || !words) return null;
  return (
    <Banner tone="info" title={words.title} className={className}>
      <IssueText text={words.body} urls={{ [String(found.issue)]: found.url }} />
    </Banner>
  );
}

/** The fix MACH offers for several project issues, beside its sentence: closing each extra one. A note kept from before has none. */
function ExtraIssues({ numbers }: { numbers: number[] | undefined }) {
  if (!numbers?.length) return null;
  return (
    <div className="mt-2">
      <CloseProjectIssues numbers={numbers} />
    </div>
  );
}

/**
 * M20: after naming the product, on the page it moves on to. When the repository already had a project on GitHub, MACH
 * took its name, vision and outcomes, and the person's own words were not used: said plainly, with the issue linked.
 * When GitHub could not be checked, that is said too. The engine's sentence is shown as written. It stays until closed.
 */
export function ProjectStartNotice() {
  const note = useProjectStartNote();
  if (!note) return null;
  const close = (
    <Button size="sm" variant="secondary" onClick={forgetProjectStart}>
      Close
    </Button>
  );
  if (note.kind === "taken") {
    return (
      <Banner tone="info" live="polite" title="MACH used the project already on GitHub" actions={close}>
        <p>{note.note}</p>
        <p className="mt-1">
          Its issue: <IssueLink number={note.issue} url={note.url} />. You can change its text under Vision and outcomes.
        </p>
        <ExtraIssues numbers={note.close} />
      </Banner>
    );
  }
  if (note.kind === "warned") {
    return (
      <Banner tone="info" live="polite" title="The project is defined" actions={close}>
        <p>{note.note}</p>
        <ExtraIssues numbers={note.close} />
      </Banner>
    );
  }
  return (
    <Banner tone="warning" live="polite" title="GitHub was not checked" actions={close}>
      {note.note}
    </Banner>
  );
}
