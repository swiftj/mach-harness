import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { Button, Field, Kbd, Textarea } from "@mach/ui";

/** A free reply, for any final message that is not a parsed question (a summary, an explanation, a note). */
export function Composer({
  onSend,
  busy,
  label = "Your reply",
  hint,
  focusOnMount = false,
}: {
  onSend: (text: string) => void;
  busy: boolean;
  label?: string;
  hint?: string;
  focusOnMount?: boolean;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  const send = () => {
    if (!text.trim() || busy) return;
    onSend(text);
    setText("");
  };
  return (
    <div className="flex flex-col gap-2">
      <Field label={label} hint={hint}>
        <Textarea
          ref={ref}
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
        />
      </Field>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1 text-caption text-ink-subtle">
          <Kbd>Ctrl</Kbd>
          <span aria-hidden="true">+</span>
          <Kbd>Enter</Kbd>
          <span>sends</span>
        </span>
        <Button variant="primary" disabled={!text.trim()} loading={busy} onClick={send}>
          <Send aria-hidden="true" />
          Send reply
        </Button>
      </div>
    </div>
  );
}
