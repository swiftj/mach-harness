import { CircleAlert, ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, Heading, Skeleton, Text, describeError, plain, plural } from "@mach/ui";
import type { PolicyList } from "@mach/ui/api";
import { useOperation } from "../../api/useOperation";
import { useStatus } from "../../api/store";
import { ScreenFrame } from "../../shared/ScreenFrame";
import { otherProblems, packRow, packState, slicesAnsweredUnderOlder, type PackRow } from "./model";
import { Fact, StatePill } from "./parts";

/**
 * Policy packs (M14 A): every pack the organisation keeps in the repository, read only. Packs are
 * changed by an engineer's pull request, never here. A pack that cannot be read is shown with the
 * engine's reason; slices answered under an older version of a pack are listed to look at again.
 * Reads `policy.list` and `status` (for slice titles).
 */
export function PoliciesScreen() {
  const list = useOperation("policy.list", {});
  const status = useStatus();
  const data = list.data;

  return (
    <ScreenFrame title="Policy packs" lead="The rules your organisation keeps for every product, each with an owner. Every slice says how it follows the packs that apply to it.">
      {list.loading && !data ? (
        <div role="status" aria-busy="true" aria-label="Reading the policy packs" className="flex flex-col gap-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : !data ? (
        <ErrorState
          icon={<CircleAlert />}
          title="The policy packs could not be read"
          message={list.error ? (list.error.kind === "refused" ? list.error.message : describeError(list.error).message) : undefined}
          hint={list.error?.hint}
          action={<Button onClick={list.reload}>Try again</Button>}
        />
      ) : (
        <Packs list={data} titles={status.data?.slices ?? []} />
      )}
    </ScreenFrame>
  );
}

function Packs({ list, titles }: { list: PolicyList; titles: Parameters<typeof slicesAnsweredUnderOlder>[1] }) {
  const rows = list.packs.map(packRow);
  const problems = otherProblems(list);
  const older = slicesAnsweredUnderOlder(list, titles);

  return (
    <div className="flex flex-col gap-8">
      <Text size="body-sm" tone="muted" className="max-w-reading">
        This page only reads. Packs live in the <span className="font-mono text-mono text-ink" translate="no">{list.dir}/</span> folder of your repository, and
        an engineer changes them by pull request.
      </Text>

      {problems.length ? (
        <Banner tone="danger" title={problems.length === 1 ? "Something in the policy packs cannot be read" : `${problems.length} things in the policy packs cannot be read`}>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <p className="mt-1">An engineer fixes this in the repository.</p>
        </Banner>
      ) : null}

      {older.length ? (
        <section aria-labelledby="older-title" className="flex flex-col gap-3 rounded-md border border-warning-line bg-warning-soft px-5 py-4">
          <div className="flex flex-col gap-1">
            <Heading level={2} size="title-3" id="older-title" className="text-warning-ink">
              {older.length === 1 ? "1 slice was answered under an older version of a pack" : `${older.length} slices were answered under an older version of a pack`}
            </Heading>
            <Text size="body-sm">
              A changed pack binds slices marked ready from now on. These slices are not reopened; look at their answers again before you mark them ready.
            </Text>
          </div>
          <ul className="flex flex-col divide-y divide-warning-line">
            {older.map((slice) => (
              <li key={slice.sliceId} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/slices/${slice.sliceId}/policies`} className="text-body font-semibold text-ink underline-offset-2 hover:underline">
                    {slice.title ?? slice.sliceId}
                  </Link>
                  <ArtifactId>{slice.sliceId}</ArtifactId>
                </div>
                <Text size="body-sm" tone="muted">
                  {slice.note}
                </Text>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {rows.length ? (
        <div className="flex flex-col gap-8">
          {rows.map((row) => (
            <Pack key={row.id} row={row} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<ShieldCheck />}
          title="No policy packs yet"
          description={`A policy pack is a short set of rules your organisation keeps for every product, such as privacy or security, with the person or team who owns it. An engineer adds one as a policy.md file in its own folder under ${list.dir}/, by pull request.`}
        />
      )}
    </div>
  );
}

function Pack({ row }: { row: PackRow }) {
  const state = packState(row);
  const headingId = `pack-${row.id}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4 border-t border-line pt-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Heading level={2} id={headingId}>
          {row.title ?? row.id}
        </Heading>
        <ArtifactId>{row.id}</ArtifactId>
        <StatePill {...state} />
      </div>

      {row.problems.length ? (
        <div className="flex max-w-reading flex-col gap-2 rounded-md border border-danger-line bg-danger-soft px-4 py-3">
          <p className="text-label text-danger-ink">Why it cannot be read</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-ink">
            {row.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <Text size="body-sm">Until an engineer fixes it, no slice&apos;s specification passes its check.</Text>
        </div>
      ) : null}

      <dl className="grid max-w-reading grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
        <Fact term="Owner">{row.owner ?? <span className="text-ink-subtle">not recorded</span>}</Fact>
        <Fact term="Applies to">{row.appliesTo.join("; ")}</Fact>
        <Fact term="Version">
          <span className="font-mono text-mono" translate="no">
            {row.version || "not recorded"}
          </span>
        </Fact>
        <Fact term="Statements">{plural(row.statements.length, "statement")}</Fact>
      </dl>

      {row.statements.length ? (
        <ol aria-label={`Statements of ${row.title ?? row.id}`} className="flex max-w-reading flex-col divide-y divide-line rounded-md border border-line bg-surface">
          {row.statements.map((statement) => (
            <li key={statement.id} className="flex flex-col gap-1 px-4 py-3">
              <ArtifactId plain>{statement.id}</ArtifactId>
              <p className="text-body text-ink">{plain(statement.text)}</p>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
