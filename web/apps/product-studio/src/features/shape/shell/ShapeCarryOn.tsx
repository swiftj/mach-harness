import { Link } from "react-router";
import { ArtifactId, Text } from "@mach/ui";
import type { Status } from "@mach/ui/api";
import { firstWithANextStep, nextPathOf } from "./steps";

/**
 * Shape's next step on the project home (shell-owned), shown only when the engine's `status.ideas` holds an idea with
 * something to do: the first such idea in the engine's order, its sentence as written, and a link to that step. Quiet
 * on purpose: the project's own next step (status.next_actions) stays the home's main one. A project with no ideas
 * shows nothing here.
 */
export function ShapeCarryOn({ status }: { status: Status }) {
  const row = status.ideas ? firstWithANextStep(status.ideas.ideas) : null;
  if (!row) return null;
  return (
    <section aria-labelledby="shape-next-title" className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-l-2 border-line-strong pl-4">
      <div className="flex min-w-0 max-w-reading flex-col gap-0.5">
        <h2 id="shape-next-title" className="text-body-sm font-semibold text-ink">
          Next in Shape
        </h2>
        <Text size="body-sm" tone="muted">
          <ArtifactId plain>{row.idea_id}</ArtifactId> {row.title}: {row.next.sentence}
        </Text>
      </div>
      <Link to={nextPathOf(row)} className="rounded-xs text-body-sm font-semibold text-accent-ink underline-offset-2 hover:underline">
        Open {row.idea_id}
      </Link>
    </section>
  );
}
