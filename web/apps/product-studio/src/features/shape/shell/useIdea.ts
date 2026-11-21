/**
 * Shape's shared reads (shell-owned). The board comes from the shared status (`status.ideas`), so every screen and the
 * project home agree and reload together after any act. A screen that needs more about one idea reads it itself with
 * `useOperation("idea.show", {idea_id})` and the step's own operations.
 */
import type { IdeaRow, StatusIdeas } from "@mach/ui/api";
import { useStatus } from "../../../api/store";

export interface IdeaState {
  /** The idea's row as the engine reported it, or null when the board has no such idea (yet, or at all). */
  row: IdeaRow | null;
  /** The whole board; null when the workspace has no idea. */
  board: StatusIdeas | null;
  /** True until the first status has arrived. */
  loading: boolean;
  error: ReturnType<typeof useStatus>["error"];
  reload: () => void;
}

export function useIdea(ideaId: string | null): IdeaState {
  const status = useStatus();
  const board = status.data?.ideas ?? null;
  return {
    row: (ideaId && board?.ideas.find((row) => row.idea_id === ideaId)) || null,
    board,
    loading: !status.data && !status.error,
    error: status.error,
    reload: () => void status.reload(),
  };
}

/** The board alone. */
export const useIdeaBoard = (): Omit<IdeaState, "row"> => {
  const { board, loading, error, reload } = useIdea(null);
  return { board, loading, error, reload };
};
