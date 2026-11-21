import { FolderUp } from "lucide-react";
import { Heading, Text, cn } from "@mach/ui";
import type { MocksToCommit as ToCommit } from "@mach/ui/api";
import { Fold } from "./layout/Fold";

/**
 * The delivery step after "Mark ready to build": the pictures do not travel in the GitHub issue.
 * With the engine's answer, its folder, place and note are shown as written; without it (this
 * window did not mark the slice ready), the step is still said, from the slice's own record.
 * Shown on the Design mocks tab. It is something the person must act on, so it is never folded; only the list of
 * file names is. `narrow` sets it for a 22rem pane: the icon beside the heading, no hanging indent, smaller text.
 */
export function MocksToCommitPanel({
  sliceId,
  toCommit,
  files,
  level = 2,
  narrow = false,
}: {
  sliceId: string;
  toCommit: ToCommit | null;
  files: string[];
  level?: 2 | 3;
  narrow?: boolean;
}) {
  const headingId = `mocks-to-commit-${sliceId}`;
  const names = toCommit?.files.length ? toCommit.files : files;
  const indent = narrow ? "" : "pl-8";
  const text = narrow ? "body-sm" : "body";
  return (
    <section aria-labelledby={headingId} className={cn("flex flex-col rounded-md border-2 border-dashed border-warning-line bg-warning-soft", narrow ? "gap-3 px-4 py-3" : "gap-4 px-5 py-4")}>
      <div className={cn("flex items-start", narrow ? "gap-2" : "gap-3")}>
        <FolderUp aria-hidden="true" className={cn("mt-0.5 shrink-0 text-warning-ink", narrow ? "size-4" : "size-5")} />
        <div className="flex min-w-0 flex-col gap-1">
          <Heading level={level} size="title-3" id={headingId}>
            Waiting for its pictures to be committed
          </Heading>
          {narrow ? null : (
            <Text className="max-w-reading">
              {sliceId} is marked ready, but its pictures do not travel in the GitHub issue. The builders will not start it until the pictures are on the project&apos;s main branch.
            </Text>
          )}
        </div>
      </div>
      {narrow ? (
        <Text size="body-sm">
          {sliceId} is marked ready, but its pictures do not travel in the GitHub issue. The builders will not start it until the pictures are on the project&apos;s main branch.
        </Text>
      ) : null}

      {toCommit ? (
        <ol className={cn("flex max-w-reading list-decimal flex-col text-ink", narrow ? "gap-2 pl-5 text-body-sm" : "gap-3 pl-12 text-body")}>
          <li>
            Product Studio put the pictures in this folder:
            <span translate="no" className="mt-1 block break-all rounded-xs bg-surface px-2 py-1 font-mono text-body-sm">
              {toCommit.folder}
            </span>
          </li>
          <li>
            Commit them to the main branch at
            <span translate="no" className="mt-1 block break-all rounded-xs bg-surface px-2 py-1 font-mono text-body-sm">
              {toCommit.commit_as}
            </span>
            or hand the folder to an engineer to do it.
          </li>
          <li>The builders take the slice once the pictures are there and match what you approved.</li>
        </ol>
      ) : (
        <Text size={text} className={cn("max-w-reading", indent)}>
          Product Studio named the folder to commit when you marked the slice ready. If you no longer have it, an engineer can find the pictures by their file names below.
        </Text>
      )}

      {toCommit ? (
        <Text size="body-sm" tone="muted" className={cn("max-w-reading", indent)}>
          {toCommit.note}
        </Text>
      ) : null}

      {names.length ? (
        <Fold label={`File names: ${names.length}`} className={indent}>
          <ul className="flex flex-col gap-1 text-body-sm">
            {names.map((name) => (
              <li key={name} translate="no" className="break-all font-mono">
                {name}
              </li>
            ))}
          </ul>
        </Fold>
      ) : null}
    </section>
  );
}
