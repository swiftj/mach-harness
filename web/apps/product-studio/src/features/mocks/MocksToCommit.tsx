import { FolderUp } from "lucide-react";
import { Disclosure, Heading, Text } from "@mach/ui";
import type { MocksToCommit as ToCommit } from "@mach/ui/api";

/**
 * The delivery step after "Mark ready to build": the pictures do not travel in the GitHub issue.
 * With the engine's answer, its folder, place and note are shown as written; without it (this
 * window did not mark the slice ready), the step is still said, from the slice's own record.
 *
 * Named for promotion: the ready dialog (features/spec/SliceActs.tsx) could show this panel under
 * `SavedPlace` when `slice.ready` answers with `mocks`.
 */
export function MocksToCommitPanel({ sliceId, toCommit, files }: { sliceId: string; toCommit: ToCommit | null; files: string[] }) {
  const headingId = `mocks-to-commit-${sliceId}`;
  const names = toCommit?.files.length ? toCommit.files : files;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4 rounded-md border-2 border-dashed border-warning-line bg-warning-soft px-5 py-4">
      <div className="flex items-start gap-3">
        <FolderUp aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning-ink" />
        <div className="flex min-w-0 flex-col gap-1">
          <Heading level={2} size="title-3" id={headingId}>
            Waiting for its pictures to be committed
          </Heading>
          <Text className="max-w-reading">
            {sliceId} is marked ready, but its pictures do not travel in the GitHub issue. The builders will not start it until the pictures are on the project&apos;s main branch.
          </Text>
        </div>
      </div>

      {toCommit ? (
        <ol className="flex max-w-reading list-decimal flex-col gap-3 pl-12 text-body text-ink">
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
        <Text className="max-w-reading pl-8">
          Product Studio named the folder to commit when you marked the slice ready. If you no longer have it, an engineer can find the pictures by their file names below.
        </Text>
      )}

      {toCommit ? (
        <Text size="body-sm" tone="muted" className="max-w-reading pl-8">
          {toCommit.note}
        </Text>
      ) : null}

      {names.length ? (
        <Disclosure summary={`The ${names.length === 1 ? "picture's file name" : `${names.length} pictures' file names`}`} className="ml-8">
          <ul className="flex flex-col gap-1">
            {names.map((name) => (
              <li key={name} translate="no" className="break-all font-mono">
                {name}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </section>
  );
}
