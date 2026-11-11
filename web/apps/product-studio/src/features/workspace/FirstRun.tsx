import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { Button, Heading, Page, Spinner, Text } from "@mach/ui";
import type { Status } from "@mach/ui/api";

const steps = [
  { title: "Say what the product is for", body: "A name, a one-sentence vision, and the outcomes people should get from it." },
  { title: "Name the larger capabilities", body: "Epics, such as “Team membership”, each with a few criteria for when it is done." },
  { title: "Define one slice at a time", body: "A guided interview turns an idea into a specification engineering can build without asking you more." },
];

/** An empty project: what Product Studio is for, and the one action that starts it. */
export function FirstRun({ status, refreshing }: { status: Status; refreshing: boolean }) {
  return (
    <Page width="reading">
      <div className="flex flex-col gap-10 pt-6">
        <div className="flex flex-col gap-4">
          <Heading level={1} size="display">
            Start with what the product is for
          </Heading>
          <Text editorial size="body-lg" tone="muted">
            This project has no product definition yet. Everything you write stays a private draft in your workspace until you approve it and
            send it to engineering for review.
          </Text>
        </div>
        <ol className="flex flex-col gap-5 border-l border-line-strong pl-6">
          {steps.map((step, index) => (
            <li key={step.title} className="relative flex flex-col gap-1">
              <span
                aria-hidden="true"
                className="absolute -left-[37px] top-0.5 inline-flex size-6 items-center justify-center rounded-full border border-line-strong bg-canvas text-caption font-semibold text-ink-muted tabular"
              >
                {index + 1}
              </span>
              <span className="text-body font-semibold text-ink">{step.title}</span>
              <span className="text-body text-ink-muted">{step.body}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-4">
          <Button variant="primary" size="lg" asChild>
            <Link to="/vision">
              Define the project
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
          {refreshing ? (
            <span role="status" className="inline-flex items-center gap-2 text-body-sm text-ink-muted">
              <Spinner size="sm" /> Checking whether colleagues have already defined it in {status.shared_project}
            </span>
          ) : null}
        </div>
      </div>
    </Page>
  );
}
