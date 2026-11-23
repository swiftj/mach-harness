import { useId } from "react";
import { Heading, Text } from "@mach/ui";
import { ProjectCreator } from "../../vision/ProjectForm";

/**
 * The step a way to start reaches when it needs the project to exist (M19): naming the product, in place, on the page
 * the person is already on. The words are the person's; nothing fills them in. Once the project exists the shared status
 * reloads and the page that holds this step moves on by itself. `level` null leaves the heading out, for a page whose own
 * step is already called "Name the product".
 */
export function NameTheProduct({ why, level = 3 }: { why: string; level?: 2 | 3 | 4 | null }) {
  const id = useId();
  return (
    <section aria-labelledby={level ? id : undefined} aria-label={level ? undefined : "Name the product"} className="flex flex-col gap-5 border-l-2 border-accent pl-5">
      <div className="flex max-w-reading flex-col gap-1">
        {level ? (
          <Heading level={level} size="title-3" id={id}>
            Name the product
          </Heading>
        ) : null}
        <Text tone="muted">{why}</Text>
        <Text size="body-sm" tone="subtle">
          Write it in your own words. You can change all of it later under Vision and outcomes.
        </Text>
      </div>
      <ProjectCreator submitLabel="Name the product" doneVerb="Named" createdNote="It is a draft in your workspace." />
    </section>
  );
}
