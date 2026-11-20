import { forwardRef, useState } from "react";
import { GitBranch } from "lucide-react";
import { Button, ConfirmDialog, Heading, RelativeTime, Text, toast } from "@mach/ui";
import { failureText, type PrinciplesPublished } from "@mach/ui/api";
import { client } from "../../api/client";
import { toApiError } from "../../api/session";

type Take = "mine" | "theirs";

function choices(version: string): Record<Take, { button: string; title: string; description: string; done: string }> {
  return {
    theirs: {
      button: "Take their version",
      title: `Take ${version} from GitHub?`,
      description:
        "Their principles replace yours here, and the changes you have not published are dropped. Nothing is published by taking them: the builders already have their version.",
      done: "Took the principles from GitHub",
    },
    mine: {
      button: "Keep mine",
      title: "Keep your principles?",
      description: `Your principles stay as they are here. When you publish them, they replace ${version} on GitHub.`,
      done: "Kept your principles",
    },
  };
}

/**
 * Someone else published a newer version of the principles while this workspace has changes that
 * are not published. The product manager keeps theirs or takes the other, whole; the app never
 * picks a side. Focusable, so a refused publish can lead here.
 */
export const ReconcileChoice = forwardRef<HTMLElement, { published: PrinciplesPublished; onChosen: () => void }>(function ReconcileChoice({ published, onChosen }, ref) {
  const [take, setTake] = useState<Take | null>(null);
  const [error, setError] = useState<ReturnType<typeof failureText> | null>(null);
  const theirs = published.github;
  const version = theirs?.revision != null ? `version ${theirs.revision}` : "their version";
  const words = choices(version);

  const choose = async () => {
    if (!take) return false;
    setError(null);
    try {
      const result = await client.op("reconcile.principles", { take });
      toast({ tone: "success", title: words[take].done, description: result.note });
      onChosen();
      return true;
    } catch (cause) {
      setError(failureText(toApiError(cause, "reconcile.principles"), "Nothing was chosen"));
      return false;
    }
  };

  return (
    <section ref={ref} tabIndex={-1} aria-labelledby="principles-newer" className="flex flex-col gap-3 rounded-md border border-info-line bg-info-soft px-5 py-4 outline-offset-2">
      <div className="flex items-start gap-3">
        <GitBranch aria-hidden="true" className="mt-1 size-[18px] shrink-0 text-info-ink" />
        <div className="flex min-w-0 flex-col gap-1">
          <Heading level={2} size="title-3" id="principles-newer">
            Someone else published a newer version
          </Heading>
          <Text size="body-sm">
            GitHub holds {version} of the principles
            {theirs?.approved_by ? (
              <>
                , approved by{" "}
                <span translate="no" className="font-mono">
                  {theirs.approved_by}
                </span>
              </>
            ) : null}
            {published.revision !== null ? `, newer than version ${published.revision}, which you published` : ""}. You also have changes here that are not published. Choose which to go on from.
          </Text>
          {theirs?.read_at ? (
            <Text size="caption" tone="muted">
              GitHub was last read <RelativeTime iso={theirs.read_at} />.
            </Text>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-7.5">
        <Button variant="primary" onClick={() => setTake("theirs")}>
          {words.theirs.button}
        </Button>
        <Button onClick={() => setTake("mine")}>{words.mine.button}</Button>
      </div>
      <ConfirmDialog
        open={take !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTake(null);
            setError(null);
          }
        }}
        title={take ? words[take].title : ""}
        description={take ? words[take].description : ""}
        confirmLabel={take ? words[take].button : ""}
        onConfirm={choose}
        error={error}
      />
    </section>
  );
});
