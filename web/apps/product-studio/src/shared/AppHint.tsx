import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Button } from "@mach/ui";
import type { ApiErrorHint } from "@mach/ui/api";
import { routeForHint } from "../api/nextActions";
import { useRefresh, useStatus } from "../api/store";
import { ApproveEpicDialog } from "../features/vision/ApproveEpicDialog";
import { NewSliceDialog } from "../features/roadmap/NewSliceDialog";

/**
 * A refusal's hinted action as a real control, next to the engine's own words. Provided to every
 * screen through @mach/ui's HintProvider (see Layout). `name_approver` is answered in place by the
 * wave approval itself, so it renders nothing here.
 */
export function AppHint({ hint }: { hint: ApiErrorHint }) {
  const status = useStatus();
  const refresh = useRefresh();
  const [approve, setApprove] = useState<string | null>(null);
  const [newSlice, setNewSlice] = useState<{ epicId: string | null } | null>(null);
  if (hint.kind === "name_approver") return null;
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
  if (route.type === "refresh") {
    return (
      <Button size="sm" onClick={() => void refresh.run()} loading={refresh.loading}>
        <RefreshCw aria-hidden="true" />
        {route.label}
      </Button>
    );
  }
  const epics = status.data?.epics ?? [];
  const epic = route.type === "approve-epic" ? epics.find((e) => e.epic_id === route.epicId) : undefined;
  return (
    <>
      <Button size="sm" onClick={() => (route.type === "approve-epic" ? setApprove(route.epicId) : setNewSlice({ epicId: route.epicId }))}>
        {route.label}
      </Button>
      {route.type === "approve-epic" ? (
        <ApproveEpicDialog
          epic={approve ? { epic_id: approve, title: epic?.title ?? "" } : null}
          sliceTitles={(status.data?.slices ?? []).filter((s) => s.epic_id === approve).map((s) => `${s.slice_id} ${s.title}`)}
          onOpenChange={(open) => !open && setApprove(null)}
        />
      ) : (
        <NewSliceDialog open={newSlice !== null} onOpenChange={(open) => !open && setNewSlice(null)} epics={epics} epicId={newSlice?.epicId} />
      )}
    </>
  );
}
