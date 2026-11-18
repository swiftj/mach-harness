import { useState } from "react";
import { ArtifactId, Button, ConfirmDialog, Heading, SliceGithubPills, Text, toast, type StatusSliceRow } from "@mach/ui";
import { failureText } from "@mach/ui/api";
import { client } from "../../api/client";
import { toApiError } from "../../api/session";
import { IssueLink } from "../../shared/IssueLink";

type Take = "mine" | "theirs";

const choices: Record<Take, { button: string; title: (id: string) => string; description: string }> = {
  theirs: {
    button: "Take their version",
    title: (id) => `Take the newer version of ${id}?`,
    description:
      "Their why and specification replace your draft of this slice. It does not become ready: read it, then mark it ready yourself to approve it. A version changed after it was approved cannot be taken.",
  },
  mine: {
    button: "Keep mine",
    title: (id) => `Keep your version of ${id}?`,
    description: "Your draft stays as it is. When you mark it ready, your version replaces theirs on GitHub.",
  },
};

/** Someone else saved a newer version of this slice on GitHub. The PM keeps theirs or takes the other, whole. */
export function NewerVersionCard({ slice }: { slice: StatusSliceRow }) {
  const [take, setTake] = useState<Take | null>(null);
  const [error, setError] = useState<ReturnType<typeof failureText> | null>(null);
  const id = slice.slice_id;
  const headingId = `newer-${id}`;

  const choose = async () => {
    if (!take) return false;
    setError(null);
    try {
      const result = await client.op("reconcile", { slice_id: id, take });
      toast({ tone: "success", title: take === "theirs" ? `Took the newer version of ${id}` : `Kept your version of ${id}`, description: result.note });
      return true;
    } catch (cause) {
      setError(failureText(toApiError(cause, "reconcile"), `Nothing was chosen for ${id}`));
      return false;
    }
  };

  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border border-line bg-surface px-5 py-4">
      <header className="flex flex-wrap items-center gap-2">
        <Heading level={3} id={headingId} size="title-3">
          <span className="inline-flex flex-wrap items-center gap-2">
            <ArtifactId className="text-body text-ink">{id}</ArtifactId>
            <span>{slice.title}</span>
          </span>
        </Heading>
        <SliceGithubPills github={slice.github} size="sm" />
        {slice.github.issue ? <IssueLink number={slice.github.issue} url={slice.github.url} /> : null}
      </header>
      <Text>
        Someone else saved a newer version of this slice on GitHub. Choose which version your draft goes on from.
      </Text>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => setTake("theirs")}>
          {choices.theirs.button}
        </Button>
        <Button onClick={() => setTake("mine")}>{choices.mine.button}</Button>
      </div>
      <ConfirmDialog
        open={take !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTake(null);
            setError(null);
          }
        }}
        title={take ? choices[take].title(id) : ""}
        description={take ? choices[take].description : ""}
        confirmLabel={take ? choices[take].button : ""}
        onConfirm={choose}
        error={error}
      />
    </article>
  );
}
