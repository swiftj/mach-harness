import type { ReactNode } from "react";
import { DiagnosticList, Heading, StateGlyph, StatusPill, type GlyphShape, type Tone } from "@mach/ui";
import type { answerFindings } from "./model";

/** A state as word, shape and tone, so it reads in greyscale. */
export function StatePill({ word, shape, tone, size = "sm" }: { word: string; shape: GlyphShape; tone: Tone; size?: "sm" | "md" }) {
  return (
    <StatusPill tone={tone} size={size} icon={<StateGlyph shape={shape} size={12} />}>
      {word}
    </StatusPill>
  );
}

/** A labelled fact inside a definition list: the term above, the value under it. */
export function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-body-sm text-ink-muted">{term}</dt>
      <dd className="min-w-0 break-words text-body text-ink">{children}</dd>
    </div>
  );
}

/** The engine's findings about these answers, each in its own words. */
export function Findings({ items }: { items: ReturnType<typeof answerFindings> }) {
  if (!items.length) return null;
  return (
    <section aria-labelledby="policy-findings" className="flex flex-col gap-2">
      <Heading level={2} size="title-3" id="policy-findings">
        What the check says about these answers
      </Heading>
      <DiagnosticList items={items.map((item) => ({ ...item, section: null }))} />
    </section>
  );
}
