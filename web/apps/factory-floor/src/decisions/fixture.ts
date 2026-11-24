/**
 * The Simulation's sample decisions: a fixture in the observer's reply shape, read by the same
 * readers as a real reply (model.ts), so the Decisions workspace can be seen without a project. It is
 * shown only while the source is the Simulation, under the Simulation's permanent stamp and a banner
 * that says these are sample decisions, never a project's. The tickets are named SAMPLE-*, which no
 * project's tickets are, and nothing here is derived from real records.
 */

const BASIS = "Sample decisions for the Simulation. No project was read.";

const adr = (n: number, slug: string, title: string, status: string, topics: string[], extra: Record<string, unknown> = {}) => ({
  id: `ADR-${String(n).padStart(4, "0")}`,
  number: n,
  file: `docs/adr/${String(n).padStart(4, "0")}-${slug}.md`,
  file_text: null,
  title,
  status,
  superseded_by: null,
  supersedes: [],
  topics,
  applies_to: topics.map((t) => `topic:${t}`),
  applies_to_hidden: 0,
  applies_to_given: true,
  binding: status === "accepted",
  readable: true,
  unread: false,
  problems: [],
  digest: null,
  ...extra,
});

const ADRS = [
  adr(1, "write-services-in-typescript", "Write every service in TypeScript on Node 22", "accepted", ["language"]),
  adr(2, "keep-data-in-sqlite", "Keep the service's data in SQLite", "superseded", ["storage"], { superseded_by: "ADR-0004", binding: false }),
  adr(3, "test-with-node-test-runner", "Test with Node's own test runner, beside the code", "accepted", ["testing"]),
  adr(4, "use-postgresql", "Use PostgreSQL for every service's own data", "accepted", ["storage"], { supersedes: ["ADR-0002"] }),
  adr(5, "format-and-lint", "Format with Prettier and lint with ESLint's recommended rules", "accepted", ["coding-standards"]),
  adr(6, "deploy-to-one-host", "Deploy to one host with a container per service", "proposed", ["deployment"]),
  adr(7, "use-a-message-queue", "", "accepted", [], {
    title: null,
    binding: false,
    readable: false,
    problems: ["it has no title: the first heading after the header must be '# <the decision>'"],
  }),
];

export const SAMPLE_DECISIONS = {
  basis: BASIS,
  source: { kind: "sample", dir: "docs/adr", dir_found: true, dir_setting_problem: false, config: "read" },
  adrs: ADRS,
  problems: ["docs/adr/0007-use-a-message-queue.md: it has no title: the first heading after the header must be '# <the decision>'"],
  baseline: {
    required: ["language", "framework", "storage", "testing", "deployment", "coding-standards"],
    topics: [
      { topic: "language", description: "Language and runtime: the programming languages the code is written in, and the runtime versions it runs on.", added_by_project: false, covered_by: ["ADR-0001"], files: [] },
      { topic: "framework", description: "Framework and application type: the frameworks the code is built on, and what kind of application it is.", added_by_project: false, covered_by: [], files: [] },
      { topic: "storage", description: "Data storage: where and how the application keeps its data, or that it keeps none.", added_by_project: false, covered_by: ["ADR-0004"], files: [] },
      { topic: "testing", description: "Testing approach: the test runner, the kinds of tests, and where they live.", added_by_project: false, covered_by: ["ADR-0003"], files: [] },
      { topic: "deployment", description: "Deployment environment: where the application runs, and how a change gets there.", added_by_project: false, covered_by: [], files: [] },
      { topic: "coding-standards", description: "Coding standards: the linter, formatter, type checking and conventions the code follows.", added_by_project: false, covered_by: ["ADR-0005"], files: [] },
    ],
    missing: ["framework", "deployment"],
    covered: false,
    unusable_entries: 0,
    setting_problems: [],
  },
  waiting: {
    proposals: [{ ticket: "SAMPLE-204", adr: "ADR-0008", title: "Cache sessions in Redis", file: "docs/adr/0008-cache-sessions-in-redis.md", stage: "planned", risk: "High", holds_build: true }],
    stopped: [
      { ticket: "SAMPLE-201", needs: "adr-decision", stage: "spec-ready", adr: "ADR-0004", adrs: ["ADR-0004"], title: "Use PostgreSQL for every service's own data", reason: "The slice stores free-form documents that change shape often; a document store fits it better.", at: "2026-11-20T10:00:00Z", also_recorded: null },
      { ticket: "SAMPLE-204", needs: "adr-acceptance", stage: "planned", adr: null, adrs: ["ADR-0008"], title: null, reason: null, at: null, also_recorded: null },
    ],
    proposed_on_main: ["ADR-0006"],
  },
  cells: { read: 4, unreadable: [], archived: "not read" },
};

const TEXT: Record<string, string> = {
  "ADR-0004": [
    "---",
    "status: accepted",
    "date: 2026-11-12",
    "applies-to:",
    "  - topic:storage",
    "---",
    "",
    "# Use PostgreSQL for every service's own data",
    "",
    "## Context and Problem Statement",
    "",
    "Each service keeps its own data. SQLite served the first service; two services now need the same data at once.",
    "",
    "## Decision Outcome",
    "",
    "PostgreSQL, one database per service, because it serves several writers at once.",
  ].join("\n"),
};

/** One sample decision's page, in the observer's reply shape; null for an ID the sample does not have. */
export function sampleDecision(id: string): Record<string, unknown> | null {
  const found = ADRS.find((a) => a.id === id) ?? null;
  const proposal = id === "ADR-0008";
  if (!found && !proposal) return null;
  return {
    basis: BASIS,
    id,
    adr: found ? { ...found, same_number: [] } : null,
    text: TEXT[id] ?? (found ? `---\nstatus: ${found.status}\n---\n\n# ${found.title ?? ""}\n\nSample text for the Simulation.\n` : null),
    text_cut: false,
    text_limit: 6000,
    planned_under:
      id === "ADR-0004"
        ? [
            { ticket: "SAMPLE-202", stage: "built", planned_at: "2026-11-18T09:00:00Z", origin: "main", same_text: true },
            { ticket: "SAMPLE-203", stage: "planned", planned_at: "2026-11-10T09:00:00Z", origin: "main", same_text: false },
          ]
        : [],
    exceptions:
      id === "ADR-0004"
        ? [{ ticket: "SAMPLE-203", stage: "planned", at: "2026-11-11T15:30:00Z", by: "a person", recorded_by: "an agent, on the person's instruction in conversation", reason: "A one-off import script reads the old SQLite file once; it is removed after the move.", reason_cut: false, same_text: false }]
        : [],
    conflicts: id === "ADR-0004" ? [{ ticket: "SAMPLE-201", stage: "spec-ready", at: "2026-11-20T10:00:00Z", reason: "The slice stores free-form documents that change shape often; a document store fits it better." }] : [],
    proposed_by: proposal ? [{ ticket: "SAMPLE-204", stage: "planned", risk: "High", title: "Cache sessions in Redis", file: "docs/adr/0008-cache-sessions-in-redis.md", accepted: false, holds_build: true }] : [],
    acceptances: [],
    cells: { read: 4, unreadable: [], archived: "not read" },
  };
}
