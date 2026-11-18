import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@mach/ui";
import type { ApiErrorHint } from "@mach/ui/api";
import { routeForHint } from "../api/nextActions";
import { useStatus } from "../api/store";
import { ApproveEpicDialog } from "../features/vision/ApproveEpicDialog";
import { NewSliceDialog } from "../features/roadmap/NewSliceDialog";
import { RenumberDialog } from "./RenumberDialog";

/**
 * A refusal's hinted action as a real control, next to the engine's own words. Provided to every
 * screen through @mach/ui's HintProvider (see Layout).
 */
export function AppHint({ hint }: { hint: ApiErrorHint }) {
  const status = useStatus();
  const [open, setOpen] = useState(false);
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
      {route.type === "approve-epic" ? (
        <ApproveEpicDialog
          epic={open ? { epic_id: route.epicId, title: epics.find((e) => e.epic_id === route.epicId)?.title ?? "" } : null}
          sliceTitles={(status.data?.slices ?? []).filter((s) => s.epic_id === route.epicId).map((s) => `${s.slice_id} ${s.title}`)}
          onOpenChange={setOpen}
        />
      ) : route.type === "renumber" ? (
        <RenumberDialog id={open ? route.id : null} onOpenChange={setOpen} />
      ) : (
        <NewSliceDialog open={open} onOpenChange={setOpen} epics={epics} epicId={route.epicId} />
      )}
    </>
  );
}
