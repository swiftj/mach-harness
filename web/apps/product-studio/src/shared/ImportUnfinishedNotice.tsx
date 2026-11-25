import { Link } from "react-router";
import { Banner, Button } from "@mach/ui";
import type { Status } from "@mach/ui/api";
import { unfinishedImport } from "../features/move/model";

/**
 * M21 F: bringing in a project stopped part way (`status.saved`, `import_unfinished`). Said where the person starts, in
 * the engine's words, with the way to the screen that finishes it or sets it aside. Nothing when there is none.
 */
export function ImportUnfinishedNotice({ status, className }: { status: Status; className?: string }) {
  const unfinished = unfinishedImport(status);
  if (!unfinished) return null;
  return (
    <Banner
      tone="warning"
      title="Bringing in a project stopped part way"
      className={className}
      actions={
        <Button size="sm" asChild>
          <Link to="/move">Finish it or set it aside</Link>
        </Button>
      }
    >
      {unfinished.text}
    </Banner>
  );
}
