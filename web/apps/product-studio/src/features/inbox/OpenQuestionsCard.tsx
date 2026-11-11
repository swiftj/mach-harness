import { MessageCircleQuestion } from "lucide-react";
import { Link } from "react-router";
import { ArtifactId, Button, Heading, SkeletonText, SliceStatusPill, Text, type Status, type StatusSliceRow } from "@mach/ui";
import { useDeliveryRead } from "../waves/delivery/ops";
import { plural } from "../waves/delivery/words";
import { Affects } from "./Affects";

/** A slice whose interview has questions only the PM can answer. The text comes from `slice.show`. */
export function OpenQuestionsCard({ slice, status }: { slice: StatusSliceRow; status: Status }) {
  const show = useDeliveryRead("slice.show", { slice_id: slice.slice_id });
  const questions = show.data?.slice.open_questions ?? show.data?.check.open_questions ?? [];
  const headingId = `questions-${slice.slice_id}`;
  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border border-line bg-surface px-5 py-4">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Heading level={3} id={headingId} size="title-3">
            <span className="inline-flex flex-wrap items-center gap-2">
              <ArtifactId className="text-body text-ink">{slice.slice_id}</ArtifactId>
              <span>{slice.title}</span>
            </span>
          </Heading>
          <SliceStatusPill status={slice.status} size="sm" />
        </div>
        <Text size="body-sm" tone="muted">
          {plural(slice.open_questions, "open question")}. It can't be approved until each is answered.
        </Text>
        <Affects status={status} id={slice.slice_id} />
      </header>
      <div aria-busy={show.loading && !show.data} aria-live="polite">
        {show.loading && !show.data ? (
          <SkeletonText lines={2} />
        ) : show.error ? (
          <Text size="body-sm" tone="muted">
            The questions could not be read just now. They are waiting in the interview.
          </Text>
        ) : (
          <ol className="flex flex-col gap-2">
            {questions.map((q, i) => (
              <li key={i} className="flex items-start gap-2.5 text-body text-ink">
                <MessageCircleQuestion aria-hidden="true" className="mt-1 size-4 shrink-0 text-info-ink" />
                <span className="font-serif text-body-lg">{q}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div>
        <Button asChild>
          <Link to={`/slices/${slice.slice_id}/interview`}>Continue the interview for {slice.slice_id}</Link>
        </Button>
      </div>
    </article>
  );
}
