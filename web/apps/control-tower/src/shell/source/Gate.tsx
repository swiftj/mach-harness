/**
 * What the page shows before there is anything to draw: looking for the observer, loading a history
 * to replay, no session with the observer, a history that could not be loaded. Each says what is
 * happening in plain words and offers only reading choices (the simulation, a retry); nothing here
 * can start or change anything in the Factory.
 */
import type { ReactNode } from "react";
import { Button, LoadingState, MachMark } from "@mach/ui";
import { SourceStamp } from "../SourceBadge";

function Page({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col bg-canvas text-ink">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
        <MachMark size={18} />
        <span className="text-label text-ink">
          MACH <span className="font-normal text-ink-muted">Control Tower</span>
        </span>
      </header>
      <div className="mx-auto flex w-full max-w-[640px] flex-1 flex-col justify-center px-4 py-10">{children}</div>
    </main>
  );
}

export function Probing({ label }: { label: string }) {
  return (
    <Page>
      <LoadingState label={label} />
    </Page>
  );
}

/** An observer answered, but this browser has no session with it. */
export function NoSession({ message, onSimulation, onRetry }: { message: string; onSimulation: () => void; onRetry: () => void }) {
  return (
    <Page>
      <h1 className="font-sans text-title-2 font-bold text-ink">This browser has no observer session</h1>
      <p className="mt-3 text-body text-ink">
        The observer is running, but it does not know this browser: the session is missing, it expired, or the observer was restarted. The link comes from the skill that started the observer. Open the link it printed; each link works once, and the next one is kept in
        <span className="font-mono text-[13px]"> .factory/local/observer/link</span> for a second browser.
      </p>
      <p className="mt-2 text-body-sm text-ink-muted">The observer said: {message}</p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={onRetry}>Try again</Button>
        <Button variant="secondary" onClick={onSimulation}>
          Show the simulation instead
        </Button>
        <SourceStamp source="simulation" />
      </div>
    </Page>
  );
}

export function LoadFailed({ title, message, onRetry, onSimulation }: { title: string; message: string; onRetry: () => void; onSimulation: () => void }) {
  return (
    <Page>
      <h1 className="font-sans text-title-2 font-bold text-ink">{title}</h1>
      <p className="mt-3 text-body text-ink">{message}</p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={onRetry}>Try again</Button>
        <Button variant="secondary" onClick={onSimulation}>
          Show the simulation instead
        </Button>
      </div>
    </Page>
  );
}
