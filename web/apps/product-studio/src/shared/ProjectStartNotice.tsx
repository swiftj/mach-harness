import { useState } from "react";
import { Banner, Button } from "@mach/ui";
import { useStatus } from "../api/store";
import type { ProjectStartNote } from "./team";
import type { Status } from "@mach/ui/api";
import { forgetProjectStart, useProjectStartNote } from "../api/projectStart";
import { IssueLink, IssueText } from "./IssueLink";
import { CloseProjectIssues } from "./CloseProjectIssue";
import { projectOnGithubWords } from "./team";

/**
 * M20: before the product is named, from the last time GitHub was read: this repository has a project issue MACH cannot
 * bring in (its text is not in MACH's form), so the person's own words define the project. Said before anything is typed,
 * on the start screen and above the "Name the product" form. Nothing otherwise: a project MACH can read is brought in.
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
  const kept = useProjectStartNote();
  const joined = useStatus().data?.joined_note ?? null;
  const [closedAt, setClosedAt] = useState<string | null>(() => readClosed());
  // The project came from GitHub: said from status in every browser, once, until it is closed there (whichever window joined).
  const fromStatus: ProjectStartNote | null =
    joined && joined.at !== closedAt ? { kind: "joined", note: joined.text, issue: joined.issue, url: joined.url } : null;
  const note = fromStatus ?? (kept?.kind === "joined" ? null : kept);
  if (!note) return null;
  const closeJoined = () => {
    if (joined) {
      writeClosed(joined.at);
      setClosedAt(joined.at);
    }
  };
  const close = (
    <Button size="sm" variant="secondary" onClick={forgetProjectStart}>
      Close
    </Button>
  );
  if (note.kind === "joined") {
    return (
      <Banner
        tone="info"
        live="polite"
        title="This project came from GitHub"
        actions={
          <Button size="sm" variant="secondary" onClick={closeJoined}>
            Close
          </Button>
        }
      >
        <p>{note.note}</p>
        {note.issue ? (
          <p className="mt-1">
            Its issue: <IssueLink number={note.issue} url={note.url} />. Every slice works as before: reopen one to change it, and mark it ready again.
          </p>
        ) : null}
      </Banner>
    );
  }
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

const CLOSED_KEY = "mach.joined-note-closed";

/** When this browser last closed the note: the bringing-in it was about, by its time. Guarded: storage may be blocked. */
function readClosed(): string | null {
  try {
    return window.localStorage.getItem(CLOSED_KEY);
  } catch {
    return null;
  }
}

function writeClosed(at: string): void {
  try {
    window.localStorage.setItem(CLOSED_KEY, at);
  } catch {
    // Storage blocked: closed for this page only.
  }
}
