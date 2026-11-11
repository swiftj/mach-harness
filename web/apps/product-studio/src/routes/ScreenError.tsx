import { Link, useRouteError } from "react-router";
import { CircleAlert } from "lucide-react";
import { Button, Disclosure, ErrorState, Page } from "@mach/ui";

/**
 * A screen failed while showing. The shell stays (this boundary sits inside it), so the PM can move
 * to another screen; the technical message is kept behind a disclosure for an engineer.
 */
export function ScreenError() {
  const error = useRouteError();
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  return (
    <Page width="reading">
      <div className="flex flex-col gap-4">
        <ErrorState
          icon={<CircleAlert />}
          title="This screen could not be shown"
          message="Something on it did not load as expected. Your drafts are safe. Try again, or go to another screen."
          action={
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => window.location.reload()}>Try again</Button>
              <Button variant="ghost" asChild>
                <Link to="/">Go to the workspace</Link>
              </Button>
            </div>
          }
        />
        {detail ? (
          <Disclosure summary="Details for an engineer">
            <p className="break-words font-mono text-caption text-ink-muted">{detail}</p>
          </Disclosure>
        ) : null}
      </div>
    </Page>
  );
}
