import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { Button, ErrorState, LoadingState, describeError } from "@mach/ui";
import type { MachApiError } from "@mach/ui/api";

/**
 * Loading and error for one engine read on Technical needs' pages (shell-owned), from the shared components: until
 * the first answer, a loading line; on a failure with nothing to show, the host's or engine's words and "Try again".
 * Renders `children` once there is data. The screens may keep using it or replace it.
 */
export function Loaded<T>({
  state,
  reading,
  children,
}: {
  state: { data: T | null; error: MachApiError | null; loading: boolean; reload: () => void };
  /** What is being read, for the loading line ("Reading your technical needs"). */
  reading: string;
  children: (data: T) => ReactNode;
}) {
  if (state.data !== null) return <>{children(state.data)}</>;
  if (state.error) {
    const { title, message } = describeError(state.error);
    return <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={state.reload}>Try again</Button>} />;
  }
  return <LoadingState label={reading} />;
}
