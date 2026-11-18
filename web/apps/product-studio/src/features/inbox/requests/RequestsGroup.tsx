import { RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { Banner, Button, formatWhen, plural, SkeletonText, Text, type Status } from "@mach/ui";
import type { RequestList } from "./api";
import { RequestCard } from "./RequestCard";

/**
 * The Requests group's body: GitHub issues labelled as requests, as the last refresh found them
 * (`request.list` never calls GitHub). The Inbox shows the group only for a project whose shared
 * repository is on GitHub.
 */
export function RequestsGroup({ list, status }: { list: RequestList; status: Status }) {
  const block = list.data;
  if (!block) {
    return list.error ? (
      <Banner tone="info" title="Requests could not be read just now" actions={<Button size="sm" onClick={list.reload}>Try again</Button>}>
        The requests found at the last refresh will appear here once they can be read.
      </Banner>
    ) : (
      <SkeletonText lines={2} />
    );
  }
  const waiting = block.updates_waiting ?? 0;
  const notMade = block.could_not_update?.length ?? 0;
  return (
    <>
      {block.problem ? (
        <Banner tone="warning" title="GitHub could not be reached">
          {block.refreshed_at ? `Last checked ${formatWhen(block.refreshed_at)}. ` : ""}
          {block.problem} The list below is what the last check found.
        </Banner>
      ) : !block.refreshed_at ? (
        <Banner
          tone="info"
          title="Not checked with GitHub yet"
          actions={
            <Button asChild size="sm">
              <Link to="/github">
                <RefreshCw aria-hidden="true" />
                Check for changes
              </Link>
            </Button>
          }
        >
          Requests appear after GitHub is checked for changes.
        </Banner>
      ) : (
        <Text size="caption" tone="subtle">
          Last checked {formatWhen(block.refreshed_at)}.
        </Text>
      )}
      {waiting > 0 ? (
        <Banner tone="info" title="Updates to GitHub waiting">
          {plural(waiting, "update")} to GitHub {waiting === 1 ? "is" : "are"} waiting and will be sent on the next refresh.
        </Banner>
      ) : null}
      {notMade > 0 ? (
        <Banner tone="warning" title="Updates to GitHub not made">
          {plural(notMade, "update")} could not be made and will not be tried again.
        </Banner>
      ) : null}
      {block.truncated_note ? (
        <Text size="body-sm" tone="muted">
          {block.truncated_note}
        </Text>
      ) : null}
      {block.items.length === 0 ? (
        <Text tone="muted">No open requests.</Text>
      ) : (
        block.items.map((item) => <RequestCard key={item.number} item={item} status={status} onChanged={list.reload} />)
      )}
    </>
  );
}
