import { Link } from "react-router";
import { Banner, Button } from "@mach/ui";
import type { Refresh, Status } from "@mach/ui/api";
import { useEngineAct } from "../api/act";
import { fromGithubLines } from "./team";

/**
 * "From GitHub" on the project home: what the last bringing-in from GitHub said, and what stays true from it, each in the
 * engine's own words with its one step: a copy MACH cannot tell apart from GitHub's (keep yours, or take GitHub's), a copy
 * changed here without being reopened (reopen it), slices waiting for an unfinished import (finish it), and what could not
 * be taken and why. Nothing when there is nothing.
 */
export function FromGithubPanel({ status, refresh }: { status: Status; refresh: Refresh | null }) {
  const act = useEngineAct();
  const lines = fromGithubLines(status, refresh);
  if (!lines.length) return null;
  return (
    <Banner tone="info" title="From GitHub">
      <ul className="flex flex-col gap-3">
        {lines.map((line) => (
          <li key={line.key} className="flex flex-col gap-1.5">
            <p className="max-w-reading">{line.text}</p>
            {line.step?.kind === "choose" ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void act.run("reconcile", { slice_id: line.step!.target, take: "mine" })}>
                  Keep mine
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void act.run("reconcile", { slice_id: line.step!.target, take: "theirs" })}>
                  Take GitHub's
                </Button>
              </div>
            ) : line.step?.kind === "reopen" ? (
              <Button size="sm" variant="secondary" className="self-start" asChild>
                <Link to={`/slices/${line.step.target}`}>Reopen it</Link>
              </Button>
            ) : line.step?.kind === "import" ? (
              <Button size="sm" variant="secondary" className="self-start" asChild>
                <Link to="/move">Finish bringing it in</Link>
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {act.shown ? <p className="mt-2 text-body-sm text-danger-ink">{act.shown.message}</p> : null}
    </Banner>
  );
}
