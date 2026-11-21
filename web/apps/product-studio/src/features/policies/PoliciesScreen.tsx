import { useState } from "react";
import { CircleAlert, ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, Heading, Skeleton, Text, describeError, plain, plural } from "@mach/ui";
import type { PolicyList } from "@mach/ui/api";
import { useOperation } from "../../api/useOperation";
import { useStatus } from "../../api/store";
import { Part, Parts } from "../../shared/layout/Parts";
import { ContextRow, OnePane, WorkScreen } from "../../shared/layout/WorkScreen";
import { otherProblems, packRow, packState, packSummary, slicesAnsweredUnderOlder, type PackRow } from "./model";
import { Fact, StatePill } from "./parts";

/**
 * Policy packs (M14 A): every pack the organisation keeps in the repository, read only. Packs are
 * changed by an engineer's pull request, never here. A pack that cannot be read is shown with the
 * engine's reason; slices answered under an older version of a pack are listed to look at again.
 * Reads `policy.list` and `status` (for slice titles).
 *
 * M16 layout: a context row (the page's lead behind "About this page"), then what needs attention (what cannot be read,
 * with each malformed pack's reasons never folded, and the slices to look at again), then each pack a row that says its
 * state, owner and reach, its facts and statements folded.
 */
export function PoliciesScreen() {
  const list = useOperation("policy.list", {});
  const status = useStatus();
  const data = list.data;

  return (
    <WorkScreen
      header={
        <ContextRow
          title="Policy packs"
          about="The rules your organisation keeps for every product, each with an owner. Every slice says how it follows the packs that apply to it."
        />
      }
    >
      <OnePane label="Policy packs">
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
      </OnePane>
    </WorkScreen>
  );
}

function Packs({ list, titles }: { list: PolicyList; titles: Parameters<typeof slicesAnsweredUnderOlder>[1] }) {
  const rows = list.packs.map(packRow);
  const problems = otherProblems(list);
  const older = slicesAnsweredUnderOlder(list, titles);
  // The first pack that can be read opens on arrival, so a pack's statements are in view; each row says its state.
  const [open, setOpen] = useState<string | null>(() => rows.find((row) => !row.problems.length)?.id ?? null);

  return (
    <div className="flex flex-col gap-6">
      <Text size="body-sm" tone="muted" className="max-w-reading">
        This page only reads. Packs live in the <span className="font-mono text-mono text-ink" translate="no">{list.dir}/</span> folder of your repository, and an engineer changes them by pull
        request.
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
            <Text size="body-sm">A changed pack binds slices marked ready from now on. These slices are not reopened; look at their answers again before you mark them ready.</Text>
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
        <section aria-labelledby="packs-title" className="flex flex-col gap-3">
          <Heading level={2} size="title-3" id="packs-title">
            {plural(rows.length, "pack")}
          </Heading>
          <Parts label="Policy packs" open={open} onOpenChange={setOpen} headingLevel={3}>
            {rows.map((row) => (
              <Pack key={row.id} row={row} />
            ))}
          </Parts>
        </section>
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

/** A pack that cannot be read: its reasons, under its own row and never folded, open or closed. */
function PackProblems({ row }: { row: PackRow }) {
  return (
    <section aria-label={`Why ${row.title ?? row.id} cannot be read`} className="flex flex-col gap-2 rounded-md border border-danger-line bg-danger-soft px-4 py-3">
      <p className="flex flex-wrap items-center gap-2 text-label text-danger-ink">
        Why {row.title ?? row.id} cannot be read <ArtifactId>{row.id}</ArtifactId>
      </p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-ink">
        {row.problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
      <Text size="body-sm">Until an engineer fixes it, no slice&apos;s specification passes its check.</Text>
    </section>
  );
}

function Pack({ row }: { row: PackRow }) {
  const state = packState(row);
  return (
    <Part
      id={row.id}
      name={row.title ?? row.id}
      summary={packSummary(row)}
      attention={row.problems.length ? <PackProblems row={row} /> : undefined}
      status={
        <>
          <ArtifactId>{row.id}</ArtifactId>
          <StatePill {...state} />
        </>
      }
    >
      <div className="flex flex-col gap-4">
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
      </div>
    </Part>
  );
}
