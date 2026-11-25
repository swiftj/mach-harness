import { useEffect, useState } from "react";
import { Spinner } from "@mach/ui";
import { elapsedWords } from "./model";

/**
 * Work in flight, said as what is happening and for how long ("working, for this long"), never as a bar toward an end
 * nobody knows. The time is counted from when it appeared.
 */
export function Working({ words, detail }: { words: string; detail?: string }) {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(started);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div role="status" className="flex items-start gap-3 rounded-md border border-line bg-surface px-4 py-3">
      <Spinner size="sm" className="mt-1" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-body font-semibold text-ink">
          {words} <span className="font-normal text-ink-muted tabular">· {elapsedWords(now - started)} so far</span>
        </p>
        {detail ? <p className="max-w-reading text-body-sm text-ink-muted">{detail}</p> : null}
      </div>
    </div>
  );
}
