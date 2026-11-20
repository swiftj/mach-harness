import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { Badge, Button, Kbd, RichText, Text } from "@mach/ui";
import { shortcutKey } from "./shortcuts";

export interface SummaryCardProps {
  /** The interviewer's summary, as it wrote it. */
  text: string;
  /** Confirms the summary: the interviewer writes the specification from it. */
  onConfirm: () => void;
  /** A reply is on its way: the button and the shortcut wait. */
  busy: boolean;
}

/**
 * The interviewer's summary to confirm, with the one-press yes. Like a question, it takes focus when
 * it arrives and Y answers yes while it has focus; typing in a text box or holding a modifier never
 * counts, and nothing is sent while a reply is on its way. The free reply below it stays for what is
 * missing.
 */
export function SummaryCard({ text, onConfirm, busy }: SummaryCardProps) {
  const labelId = useId();
  const cardRef = useRef<HTMLElement>(null);

  // Each summary mounts a fresh card (keyed by message id); focus lands on the decision.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  const confirm = () => {
    if (!busy) onConfirm();
  };

  const shortcuts = (event: KeyboardEvent<HTMLElement>) => {
    if (shortcutKey(event) === "y") {
      event.preventDefault();
      confirm();
    }
  };

  return (
    // Y is a shortcut while the summary has focus; the answer is also a button.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      ref={cardRef}
      tabIndex={-1}
      aria-labelledby={labelId}
      onKeyDown={shortcuts}
      className="flex flex-col gap-6 rounded-md focus-visible:outline-2 focus-visible:outline-offset-8 focus-visible:outline-focus"
    >
      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-2 text-body-sm text-ink-muted">
          The interviewer
          <Badge tone="info">
            <span id={labelId}>Summary to confirm</span>
          </Badge>
        </span>
        <RichText text={text} editorial className="text-ink" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" loading={busy} onClick={confirm}>
            <Check aria-hidden="true" />
            Yes, write it up
          </Button>
          <span className="flex items-center gap-1 text-caption text-ink-subtle">
            <Kbd>Y</Kbd> writes it up
          </span>
        </div>
        <Text size="body-sm" tone="muted">
          The interviewer writes the specification from this summary.
        </Text>
      </div>
    </section>
  );
}
