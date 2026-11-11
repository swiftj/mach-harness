import { CircleAlert, Compass } from "lucide-react";
import { Button, EmptyState, ErrorState, Heading, Page, Skeleton, Text, describeError } from "@mach/ui";
import { useOperation } from "../api/useOperation";

/**
 * Placeholder home. The next wave replaces it with the real home screen; it shows that the shell,
 * the client and the engine's status are wired end to end.
 */
export function Home() {
  const status = useOperation("status", {});

  if (status.loading && !status.data) {
    return (
      <Page width="reading">
        <div role="status" aria-busy="true" aria-label="Reading your workspace" className="flex flex-col gap-4">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-4/5" />
        </div>
      </Page>
    );
  }

  if (status.error) {
    const { title, message } = describeError(status.error);
    return (
      <Page width="reading">
        <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={status.reload}>Try again</Button>} />
      </Page>
    );
  }

  const data = status.data;
  if (!data?.project) {
    return (
      <Page width="reading">
        <EmptyState layout="page" headingLevel={1} icon={<Compass />} title="No project yet" description={data?.suggested_next[0]} />
      </Page>
    );
  }

  return (
    <Page width="reading">
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-2">
          <Heading level={1} size="display">
            {data.project.name}
          </Heading>
          <Text size="body-lg" editorial tone="muted">
            {data.project.vision}
          </Text>
        </header>
        <section aria-labelledby="next-title" className="flex flex-col gap-3">
          <Heading level={2} id="next-title" size="title-3">
            Suggested next
          </Heading>
          <ul className="flex flex-col gap-2">
            {data.suggested_next.map((line) => (
              <li key={line} className="border-l-2 border-accent pl-3 text-body text-ink">
                {line}
              </li>
            ))}
          </ul>
        </section>
        <Text size="body-sm" tone="subtle">
          {count(data.epics.length, "epic")}, {count(data.slices.length, "slice")}, {count(data.waves.length, "wave")}. The Product Studio
          screens are built on top of this starting point.
        </Text>
      </div>
    </Page>
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
