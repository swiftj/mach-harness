import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@mach/ui";
import type { ApiErrorHint, failureText } from "@mach/ui/api";
import { routeForHint } from "../api/nextActions";
import { useStatus } from "../api/store";
import { NewSliceDialog } from "../features/roadmap/NewSliceDialog";
import { RenumberDialog } from "./RenumberDialog";
import { IssueLink } from "./IssueLink";
import { CloseProjectIssues } from "./CloseProjectIssue";
import { extraProjectIssues } from "./team";
import { AnswerQuestionDialog } from "./BuildersQuestion";
import { EpicSheet } from "../features/vision/EpicSheet";

/**
 * A refusal's hinted action as a real control, next to the engine's own words. Provided to every
 * screen through @mach/ui's HintProvider (see Layout).
 */
export function AppHint({ hint }: { hint: ApiErrorHint }) {
  const status = useStatus();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ReturnType<typeof failureText> | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  // Answered in place by the screen that asked: the interview screen joins the open interview.
  if (hint.kind === "open_interview") return null;
  // Answered in place too: the conversation screen offers "Take it over here" (TakeOverBanner).
  if (hint.kind === "take_over") return null;
  // A conversation is writing what the act changes: the host warned, and this goes ahead (useEngineAct sets proceed).
  if (hint.kind === "interrupt_turn") {
    return hint.proceed ? (
      <Button size="sm" onClick={hint.proceed}>
        Stop the reply and go ahead
      </Button>
    ) : null;
  }
  // M20: the project issues the engine names, each linked where it gave the address, and the fix MACH offers: closing
  // each extra one, on the person's one yes.
  if (hint.kind === "several_projects") {
    if (!hint.issues?.length) return null;
    const extra = extraProjectIssues(
      hint.issues.map((item) => item.issue),
      status.data?.project?.issue,
    );
    return (
      <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-2 text-body-sm text-ink-muted">
        On GitHub:
        {hint.issues.map((item) => (
          <IssueLink key={item.issue} number={item.issue} url={item.url} />
        ))}
        <CloseProjectIssues numbers={extra} />
      </span>
    );
  }
  const route = routeForHint(hint);

  if (route.type === "navigate") {
    return (
      <Button size="sm" asChild>
        <Link to={route.to} state={route.state}>
          {route.label}
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    );
  }
  const epics = status.data?.epics ?? [];
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        {route.label}
      </Button>
      {route.type === "renumber" ? (
        <RenumberDialog
          id={open ? route.id : null}
          onOpenChange={setOpen}
          // A slice renumbered from one of its own pages: that page moves to the new number (M20).
          onRenumbered={({ from, to }) => {
            const path = location.pathname;
            if (path === `/slices/${from}` || path.startsWith(`/slices/${from}/`)) void navigate(path.replace(`/slices/${from}`, `/slices/${to}`), { replace: true });
          }}
        />
      ) : route.type === "add-epic" ? (
        <EpicSheet state={open ? { mode: "add" } : null} onClose={() => setOpen(false)} />
      ) : route.type === "answer-question" ? (
        <AnswerQuestionDialog
          sliceId={route.sliceId}
          open={open}
          onOpenChange={setOpen}
          error={error}
          setError={setError}
          onReopened={() => void navigate(`/slices/${route.sliceId}/interview`, { state: { answer: true } })}
        />
      ) : (
        <NewSliceDialog open={open} onOpenChange={setOpen} epics={epics} epicId={route.epicId} />
      )}
    </>
  );
}
