import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@mach/ui";
import type { ApiErrorHint, failureText } from "@mach/ui/api";
import { routeForHint } from "../api/nextActions";
import { useStatus } from "../api/store";
import { NewSliceDialog } from "../features/roadmap/NewSliceDialog";
import { RenumberDialog } from "./RenumberDialog";
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
