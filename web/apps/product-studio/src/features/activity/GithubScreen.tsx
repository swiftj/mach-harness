import { CircleAlert, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { ArtifactId, Banner, Button, ErrorState, Heading, Page, Skeleton, SliceGithubPills, SliceStatusPill, EpicStatusPill, Text, builderStates, describeError, formatWhen, type RefreshGithubSlice, type Status } from "@mach/ui";
import { useRefresh, useStatus } from "../../api/store";
import { IssueLink, IssueNumber } from "../../shared/IssueLink";

/**
 * Where the project, its epics and its slices stand on GitHub, as the engine recorded them and as
 * the last refresh read them. Refreshing reads GitHub; it changes none of the PM's drafts.
 */
export function GithubScreen() {
  const status = useStatus();
  const refresh = useRefresh();
  const data = status.data;
  const github = refresh.data?.github ?? null;
  const problem = refresh.error ? describeError(refresh.error).message : (github?.problem ?? null);
  const elsewhere = (github?.slices ?? []).filter((s) => !s.in_workspace);

  return (
    <Page>
      <div className="flex flex-col gap-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex max-w-reading flex-col gap-2">
            <Heading level={1}>On GitHub</Heading>
            <Text tone="muted">
              A slice you mark ready is saved to the project on GitHub, under its epic, where the builders take it. Refreshing reads what is there
              now; it never changes your drafts.
            </Text>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Button variant="primary" loading={refresh.loading} onClick={() => void refresh.run()}>
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
            <Text size="caption" tone="subtle" aria-live="polite">
              {data?.github.last_read ? `Last read ${formatWhen(data.github.last_read)}` : data ? "Not read yet" : ""}
            </Text>
          </div>
        </header>

        {problem ? (
          <Banner tone="warning" live="polite" title="GitHub could not be read" actions={<Button size="sm" loading={refresh.loading} onClick={() => void refresh.run()}>Try again</Button>}>
            <p>{problem}</p>
            <p className="mt-1">Nothing in your workspace was changed. What you see below is from the last time GitHub was read.</p>
          </Banner>
        ) : null}

        {status.loading && !data ? (
          <div role="status" aria-busy="true" aria-label="Reading your workspace" className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !data ? (
          <ErrorState
            icon={<CircleAlert />}
            title="Your workspace could not be read"
            message={status.error ? describeError(status.error).message : undefined}
            action={<Button onClick={() => void status.reload()}>Try again</Button>}
          />
        ) : (
          <>
            <Where status={data} />
            <Slices status={data} />
          </>
        )}

        {elsewhere.length ? <Elsewhere slices={elsewhere} /> : null}
      </div>
    </Page>
  );
}

function Where({ status }: { status: Status }) {
  const project = status.project;
  return (
    <section aria-labelledby="where-title" className="flex flex-col gap-3">
      <Heading level={2} id="where-title" size="title-2">
        The project and its epics
      </Heading>
      {status.github.repository ? (
        <Text size="body-sm" tone="muted">
          Saved in the repository <span className="font-mono text-ink">{status.github.repository}</span>.
        </Text>
      ) : (
        <Text size="body-sm" tone="muted">
          Nothing from this workspace has been saved on GitHub yet.
        </Text>
      )}
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
        {project ? (
          <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
            <span className="min-w-0 flex-1 text-body font-semibold text-ink">{project.name}</span>
            {project.issue ? <IssueNumber number={project.issue} /> : <NotSaved />}
          </li>
        ) : null}
        {status.epics.map((epic) => (
          <li key={epic.epic_id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
              <ArtifactId>{epic.epic_id}</ArtifactId>
              <span className="text-body text-ink">{epic.title}</span>
            </span>
            <EpicStatusPill status={epic.status} size="sm" />
            {epic.issue ? <IssueNumber number={epic.issue} /> : <NotSaved />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function NotSaved() {
  return (
    <Text as="span" size="body-sm" tone="subtle">
      Not on GitHub yet
    </Text>
  );
}

function Slices({ status }: { status: Status }) {
  return (
    <section aria-labelledby="slices-title" className="flex flex-col gap-3">
      <Heading level={2} id="slices-title" size="title-2">
        Your slices
      </Heading>
      {status.slices.length ? (
        <div className="overflow-hidden rounded-md border border-line bg-surface">
          <table className="w-full table-fixed border-collapse text-left">
            <caption className="sr-only">Each slice in your workspace, its state, where it is with the builders and its issue</caption>
            <thead className="bg-surface-sunken text-caption text-ink-muted">
              <tr>
                <th scope="col" className="w-[38%] px-4 py-2 font-semibold">
                  Slice
                </th>
                <th scope="col" className="w-[18%] px-4 py-2 font-semibold">
                  Your draft
                </th>
                <th scope="col" className="w-[32%] px-4 py-2 font-semibold">
                  With the builders
                </th>
                <th scope="col" className="w-[12%] px-4 py-2 font-semibold">
                  Issue
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {status.slices.map((slice) => (
                <tr key={slice.slice_id}>
                  <td className="px-4 py-2.5">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-2">
                      <ArtifactId>{slice.slice_id}</ArtifactId>
                      <Link to={`/slices/${slice.slice_id}`} className="min-w-0 rounded-xs text-body text-ink underline-offset-2 hover:underline">
                        {slice.title}
                      </Link>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <SliceStatusPill status={slice.status} size="sm" />
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex flex-wrap gap-1.5">
                      <SliceGithubPills github={slice.github} size="sm" />
                    </span>
                  </td>
                  <td className="px-4 py-2.5">{slice.github.issue ? <IssueLink number={slice.github.issue} url={slice.github.url} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Text tone="muted">No slices yet.</Text>
      )}
    </section>
  );
}

/** Slices someone else saved on GitHub that are not in this workspace, as the last refresh read them. */
function Elsewhere({ slices }: { slices: RefreshGithubSlice[] }) {
  return (
    <section aria-labelledby="elsewhere-title" className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <Heading level={2} id="elsewhere-title" size="title-2">
          Saved by others
        </Heading>
        <Text size="body-sm" tone="muted">
          Slices on GitHub that are not in your workspace. Their titles are as written on GitHub.
        </Text>
      </div>
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
        {slices.flatMap((slice) =>
          slice.on_github.map((issue) => (
            <li key={issue.issue} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                <ArtifactId>{slice.slice_id}</ArtifactId>
                <span className="min-w-0 break-words text-body text-ink">{issue.title ?? ""}</span>
              </span>
              <Text as="span" size="body-sm" tone="muted">
                {issue.state_label ? builderStates[issue.state_label].label : issue.state === "closed" ? "Closed" : "Open"}
                {issue.approved_by ? `, approved by ${issue.approved_by}` : ""}
              </Text>
              <IssueNumber number={issue.issue} />
            </li>
          )),
        )}
      </ul>
    </section>
  );
}
