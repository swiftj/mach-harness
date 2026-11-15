/**
 * What the scenario is about: one approved delivery wave for the invoicing area of a B2B billing
 * web app ("Tally"), its five slices, and for each cell the plan, the evidence and the review
 * findings its agents produce. Plain data; the story (story.ts) decides when things happen.
 */
import type { ProductDefinitions } from "../model";
import type { ReviewSeat, TaskKind } from "../vocabulary";
import type { TargetKind } from "../events";

export const PROJECT = { id: "tally-web", name: "Tally", integrationBranch: "main" } as const;

export const PEOPLE = {
  /** Product manager who approved the wave in Product Studio. */
  productManager: "Maya Lindqvist",
  /** Engineer who enabled the Factory on this machine. */
  engineer: "Priya Raman",
  /** Staff engineer who owns payments and signs off High-risk changes. */
  approver: "Daniel Okafor",
} as const;

export const WAVE = {
  id: "WAVE-007",
  revision: 1,
  title: "Invoicing: get paid on time",
  epicId: "EPIC-004",
  epicTitle: "Collect what customers owe",
  approvedAt: "2026-11-10T13:42:18Z",
} as const;

export const SLICE_IDS = ["SLICE-021", "SLICE-022", "SLICE-023", "SLICE-024", "SLICE-025"] as const;

export const TICKETS: Readonly<Record<string, string>> = {
  "SLICE-021": "LOCAL-031",
  "SLICE-022": "LOCAL-032",
  "SLICE-023": "LOCAL-033",
  "SLICE-024": "LOCAL-034",
  "SLICE-025": "LOCAL-035",
};

export const DEFINITIONS: ProductDefinitions = {
  project: PROJECT,
  waves: { [WAVE.id]: { id: WAVE.id, title: WAVE.title, epicId: WAVE.epicId, epicTitle: WAVE.epicTitle } },
  slices: {
    "SLICE-021": {
      id: "SLICE-021",
      title: "Invoice list with status filters",
      summary: "Finance staff filter the invoice list by draft, open, overdue, paid or void, 25 to a page, oldest due first.",
      waveId: WAVE.id,
      epicId: WAVE.epicId,
      risk: "Medium",
      appType: "web",
      dependencies: [],
      specPath: "specs/slices/SLICE-021-invoice-list-status-filters.md",
    },
    "SLICE-022": {
      id: "SLICE-022",
      title: "Charge a saved card for an open invoice",
      summary: "From an open invoice, charge the customer's default saved card once; a decline leaves the invoice open with the processor's reason.",
      waveId: WAVE.id,
      epicId: WAVE.epicId,
      risk: "High",
      appType: "web",
      dependencies: [],
      specPath: "specs/slices/SLICE-022-charge-saved-card.md",
    },
    "SLICE-023": {
      id: "SLICE-023",
      title: "Download an invoice as a PDF",
      summary: "Anyone in the workspace downloads an invoice as a PDF named by its number; void invoices carry a VOID watermark.",
      waveId: WAVE.id,
      epicId: WAVE.epicId,
      risk: "Medium",
      appType: "web",
      dependencies: [],
      specPath: "specs/slices/SLICE-023-invoice-pdf-download.md",
    },
    "SLICE-024": {
      id: "SLICE-024",
      title: "Email a reminder when an invoice becomes overdue",
      summary: "On the first day an invoice is overdue the customer's billing contact gets one reminder, and no second one within seven days.",
      waveId: WAVE.id,
      epicId: WAVE.epicId,
      risk: "Medium",
      appType: "web",
      dependencies: ["SLICE-021"],
      specPath: "specs/slices/SLICE-024-overdue-reminder-email.md",
    },
    "SLICE-025": {
      id: "SLICE-025",
      title: "Pay-now link in overdue reminders",
      summary: "Each overdue reminder carries a signed link that charges the saved card for exactly that invoice.",
      waveId: WAVE.id,
      epicId: WAVE.epicId,
      risk: "High",
      appType: "web",
      dependencies: ["SLICE-022", "SLICE-024"],
      specPath: "specs/slices/SLICE-025-pay-now-link.md",
    },
  },
};

export interface TaskSpec {
  id: string;
  kind: TaskKind;
  text: string;
  files: string[];
  ids: string[];
  /** For a [test] task: how many test cases it adds. */
  tests?: number;
  /** What the builder reads before writing. */
  reads?: string[];
  /** Minutes of writing (factory time). */
  minutes: number;
}

export interface TargetSpec {
  id: string;
  kind: TargetKind;
  title: string;
  evidence: string;
  /** Results by verification round; a round not listed passes. */
  fail?: { round: number; note: string };
  note: string;
}

export interface FindingSpec {
  seat: ReviewSeat;
  severity: "blocker" | "note";
  title: string;
  rule: string | null;
  file: string | null;
}

export interface CellContent {
  slice: string;
  ticket: string;
  scope: string;
  contracts: Array<{ path: string; existing: boolean; summary: string }>;
  tasks: TaskSpec[];
  targets: TargetSpec[];
  /** The flow recording verify captures with the first scenario. */
  recording: string;
  /** Files the reviewers open, by seat. */
  reviewReads: Partial<Record<ReviewSeat, string[]>>;
  findings: Record<number, FindingSpec[]>;
  revise?: { tasks: TaskSpec[] };
  diffStat: string;
}

const tsx = (name: string) => `web/src/pages/invoices/${name}`;

export const CONTENT: Readonly<Record<string, CellContent>> = {
  // ---------------------------------------------------------------- LOCAL-031: fails verification once
  "LOCAL-031": {
    slice: "SLICE-021",
    ticket: "LOCAL-031",
    scope: "SLICE-021",
    contracts: [{ path: "proto/invoices/v1/invoice_list.proto", existing: false, summary: "ListInvoices with a status filter and cursor paging" }],
    tasks: [
      { id: "T01", kind: "test", text: "Status filter rules for draft, open, overdue, paid and void (FR-01, FR-02)", files: ["src/invoices/statusFilter.test.ts"], ids: ["FR-01", "FR-02"], tests: 9, reads: ["src/invoices/invoice.ts"], minutes: 1.6 },
      { id: "T02", kind: "impl", text: "Status filter", files: ["src/invoices/statusFilter.ts"], ids: ["FR-01", "FR-02"], reads: ["src/billing/dates.ts"], minutes: 2.2 },
      { id: "T03", kind: "test", text: "ListInvoices returns 25 per page, oldest due first (FR-03, INV-01)", files: ["src/api/invoices/listInvoices.test.ts"], ids: ["FR-03", "INV-01"], tests: 6, reads: ["proto/invoices/v1/invoice_list.proto"], minutes: 1.4 },
      { id: "T04", kind: "impl", text: "ListInvoices handler with cursor paging", files: ["src/api/invoices/listInvoices.ts", "src/api/routes.ts"], ids: ["FR-03", "INV-01"], reads: ["src/api/routes.ts"], minutes: 2.4 },
      { id: "T05", kind: "test", text: "Invoice list page: filter chips, empty state (FR-04, FR-05, AC-01, AC-02, AC-03)", files: [tsx("InvoiceList.test.tsx")], ids: ["FR-04", "FR-05", "AC-01", "AC-02", "AC-03"], tests: 7, reads: ["web/src/components/FilterChips.tsx"], minutes: 1.8 },
      { id: "T06", kind: "impl", text: "Invoice list page", files: [tsx("InvoiceList.tsx"), tsx("useInvoiceFilters.ts")], ids: ["FR-04", "FR-05"], reads: ["web/src/components/DataTable.tsx", "web/src/styles/tokens.css"], minutes: 2.6 },
    ],
    targets: [
      { id: "AC-01", kind: "scenario", title: "Filter the list to overdue invoices", evidence: "ac-01-overdue-filter.png", note: "Overdue chip shows INV-2287 and INV-2290 only, oldest due first." },
      { id: "AC-02", kind: "scenario", title: "Clear the filter", evidence: "ac-02-clear-filter.png", note: "All 41 invoices return, page 1 of 2." },
      { id: "AC-03", kind: "scenario", title: "No invoice matches", evidence: "ac-03-empty-state.png", note: "Void filter on a workspace with no void invoices shows 'No void invoices'." },
      { id: "R1", kind: "matrix rule", title: "Draft: never sent", evidence: "r1-draft.png", note: "INV-3001 (never sent) appears under Draft only." },
      { id: "R2", kind: "matrix rule", title: "Open: sent, unpaid, not yet due", evidence: "r2-open.png", note: "INV-3002 due 2026-11-24 appears under Open." },
      { id: "R3", kind: "matrix rule", title: "Paid: settled in full", evidence: "r3-paid.png", note: "INV-3003 paid 2026-11-02 appears under Paid only." },
      {
        id: "R4",
        kind: "matrix rule",
        title: "Overdue: unpaid after its due date",
        evidence: "r4-overdue-boundary.png",
        fail: { round: 1, note: "INV-3004, unpaid and due today (2026-11-10), is listed under Overdue. R4: an invoice is overdue only once its due date has passed." },
        note: "INV-3004 due today is Open; INV-3005 due yesterday is Overdue.",
      },
      { id: "R5", kind: "matrix rule", title: "Void: cancelled after sending", evidence: "r5-void.png", note: "INV-3006 (voided) appears under Void and in no other status." },
    ],
    recording: "invoice-filters-flow.webm",
    reviewReads: {
      architecture: ["src/invoices/statusFilter.ts", "src/api/invoices/listInvoices.ts", "src/billing/dates.ts"],
      security: ["src/api/invoices/listInvoices.ts", "src/api/routes.ts"],
      product: ["evidence/ac-01-overdue-filter.png", "evidence/r4-overdue-boundary.png", tsx("InvoiceList.tsx")],
    },
    findings: {
      2: [
        { seat: "architecture", severity: "note", title: "statusFilter.ts repeats the calendar-day comparison already in src/billing/dates.ts (isPastDueDay); reuse it", rule: null, file: "src/invoices/statusFilter.ts" },
        { seat: "security", severity: "note", title: "The status query parameter is checked against the enum before it reaches the query builder", rule: null, file: "src/api/invoices/listInvoices.ts" },
        { seat: "product", severity: "note", title: "Empty-state wording matches FR-05 exactly; due-today boundary now as R4 states", rule: null, file: "evidence/r4-overdue-boundary.png" },
      ],
    },
    revise: {
      tasks: [
        { id: "R1-T01", kind: "test", text: "An unpaid invoice due today is open, not overdue (R4)", files: ["src/invoices/statusFilter.test.ts"], ids: ["FR-02"], tests: 2, minutes: 1.2 },
        { id: "R1-T02", kind: "impl", text: "Compare due dates by calendar day in the workspace's time zone (R4)", files: ["src/invoices/statusFilter.ts"], ids: ["FR-02"], reads: ["src/billing/dates.ts"], minutes: 1.6 },
      ],
    },
    diffStat: "14 files changed, 912 insertions(+), 6 deletions(-)",
  },

  // ---------------------------------------------------------------- LOCAL-032: High risk, review blocker, human gate
  "LOCAL-032": {
    slice: "SLICE-022",
    ticket: "LOCAL-032",
    scope: "SLICE-022",
    contracts: [{ path: "proto/billing/v1/payments.proto", existing: true, summary: "adds ChargeInvoice to PaymentsService (changes an existing contract)" }],
    tasks: [
      { id: "T01", kind: "contract", text: "Generate the ChargeInvoice client and server stubs", files: ["src/gen/billing/v1/payments_pb.ts"], ids: ["FR-01"], reads: ["proto/billing/v1/payments.proto"], minutes: 1.1 },
      { id: "T02", kind: "test", text: "Charging an open invoice with the default card marks it paid (FR-01, AC-01)", files: ["src/payments/chargeInvoice.test.ts"], ids: ["FR-01", "AC-01"], tests: 5, reads: ["src/payments/processor.ts"], minutes: 1.9 },
      { id: "T03", kind: "impl", text: "chargeInvoice through the processor client", files: ["src/payments/chargeInvoice.ts"], ids: ["FR-01"], reads: ["src/payments/processor.ts", "src/invoices/invoice.ts"], minutes: 3.1 },
      { id: "T04", kind: "test", text: "A declined card leaves the invoice open with the processor's reason (FR-03, AC-02)", files: ["src/payments/chargeInvoice.test.ts"], ids: ["FR-03", "AC-02"], tests: 4, minutes: 1.5 },
      { id: "T05", kind: "impl", text: "Map processor declines to invoice events", files: ["src/payments/chargeInvoice.ts", "src/payments/declines.ts"], ids: ["FR-03", "INV-01"], minutes: 2.4 },
      { id: "T06", kind: "test", text: "Pay button: disabled without a saved card, refused on a paid invoice (FR-04, AC-03)", files: [tsx("InvoiceActions.test.tsx")], ids: ["FR-04", "AC-03", "INV-02"], tests: 6, minutes: 1.7 },
      { id: "T07", kind: "impl", text: "Pay with saved card action on the invoice page", files: [tsx("InvoiceActions.tsx")], ids: ["FR-04"], reads: ["web/src/components/ConfirmDialog.tsx"], minutes: 2.5 },
    ],
    targets: [
      { id: "AC-01", kind: "scenario", title: "Charge an open invoice with the default card", evidence: "ac-01-charge-succeeds.png", note: "INV-2291 charged $1,240.00 to Visa ending 4242; status Paid; one processor charge in the sandbox log." },
      { id: "AC-02", kind: "scenario", title: "The card is declined", evidence: "ac-02-declined.png", note: "Test card 4000 0000 0000 0002 declined: invoice stays Open, 'Your card was declined' shown." },
      { id: "AC-03", kind: "scenario", title: "No saved card", evidence: "ac-03-no-saved-card.png", note: "Pay button disabled with 'Add a card to pay'." },
      { id: "R1", kind: "matrix rule", title: "Open invoice, default card: charged once", evidence: "r1-charged-once.json", note: "Sandbox shows exactly one charge for INV-3101." },
      { id: "R2", kind: "matrix rule", title: "Declined: invoice stays open", evidence: "r2-declined.json", note: "INV-3102 open; decline code card_declined recorded on the invoice timeline." },
      { id: "R3", kind: "matrix rule", title: "Paid invoice: charge refused", evidence: "r3-already-paid.png", note: "Charging paid INV-3103 refused with 'This invoice is already paid'." },
      { id: "R4", kind: "matrix rule", title: "Processor times out: no second charge", evidence: "r4-timeout-retry.json", note: "Processor stub delayed 31 s; one charge after the retry." },
    ],
    recording: "charge-saved-card-flow.webm",
    reviewReads: {
      architecture: ["proto/billing/v1/payments.proto", "src/payments/chargeInvoice.ts", "src/payments/processor.ts"],
      security: ["src/payments/chargeInvoice.ts", "src/payments/processor.ts", "evidence/r4-timeout-retry.json"],
      product: ["evidence/ac-01-charge-succeeds.png", "evidence/ac-02-declined.png", tsx("InvoiceActions.tsx")],
    },
    findings: {
      1: [
        { seat: "security", severity: "blocker", title: "A timed-out charge is retried with a fresh idempotency key, so a slow processor response can charge the card twice", rule: "INV-02", file: "src/payments/chargeInvoice.ts" },
        { seat: "architecture", severity: "note", title: "ChargeInvoice returns the whole Invoice message; a smaller ChargeResult would keep payments from depending on invoices", rule: null, file: "proto/billing/v1/payments.proto" },
        { seat: "product", severity: "note", title: "Decline message matches FR-03; the receipt email is out of scope for this slice", rule: null, file: "evidence/ac-02-declined.png" },
      ],
      2: [
        { seat: "security", severity: "note", title: "Resolved: the idempotency key is derived from the invoice ID and attempt series, and the processor dedupes for 24 h", rule: null, file: "src/payments/chargeInvoice.ts" },
        { seat: "architecture", severity: "note", title: "idempotencyKey() belongs with the processor client if a second caller appears", rule: null, file: "src/payments/idempotency.ts" },
      ],
    },
    revise: {
      tasks: [
        { id: "R1-T01", kind: "test", text: "A retried charge reuses the invoice's idempotency key (INV-02)", files: ["src/payments/chargeInvoice.test.ts"], ids: ["INV-02"], tests: 3, minutes: 1.4 },
        { id: "R1-T02", kind: "impl", text: "Derive the idempotency key from the invoice ID and attempt series", files: ["src/payments/chargeInvoice.ts", "src/payments/idempotency.ts"], ids: ["INV-02"], reads: ["src/payments/processor.ts"], minutes: 2.3 },
      ],
    },
    diffStat: "11 files changed, 1047 insertions(+), 12 deletions(-)",
  },

  // ---------------------------------------------------------------- LOCAL-033: first-pass, one outvoted blocker
  "LOCAL-033": {
    slice: "SLICE-023",
    ticket: "LOCAL-033",
    scope: "SLICE-023",
    contracts: [{ path: "api/openapi/invoice-pdf.yaml", existing: false, summary: "GET /invoices/{id}/pdf, application/pdf" }],
    tasks: [
      { id: "T01", kind: "test", text: "PDF holds number, dates, line items, totals and tax ID when present (FR-01, FR-02)", files: ["src/invoices/pdf/renderInvoicePdf.test.ts"], ids: ["FR-01", "FR-02"], tests: 8, reads: ["src/invoices/invoice.ts"], minutes: 1.7 },
      { id: "T02", kind: "impl", text: "renderInvoicePdf with the shared document template", files: ["src/invoices/pdf/renderInvoicePdf.ts", "src/invoices/pdf/layout.ts"], ids: ["FR-01", "FR-02"], reads: ["src/documents/template.ts"], minutes: 3.0 },
      { id: "T03", kind: "test", text: "GET /invoices/{id}/pdf streams a file named by invoice number; other workspaces get 404 (FR-03, INV-01)", files: ["src/api/invoices/downloadPdf.test.ts"], ids: ["FR-03", "INV-01"], tests: 5, reads: ["api/openapi/invoice-pdf.yaml"], minutes: 1.3 },
      { id: "T04", kind: "impl", text: "downloadPdf route", files: ["src/api/invoices/downloadPdf.ts", "src/api/routes.ts"], ids: ["FR-03", "INV-01"], minutes: 1.9 },
      { id: "T05", kind: "test", text: "Download button and VOID watermark (FR-04, AC-01, AC-02)", files: [tsx("DownloadPdfButton.test.tsx")], ids: ["FR-04", "AC-01", "AC-02"], tests: 4, minutes: 1.2 },
      { id: "T06", kind: "impl", text: "Download PDF button on the invoice page", files: [tsx("DownloadPdfButton.tsx")], ids: ["FR-04"], reads: ["web/src/components/Button.tsx"], minutes: 1.6 },
    ],
    targets: [
      { id: "AC-01", kind: "scenario", title: "Download an open invoice", evidence: "ac-01-download.png", note: "INV-2291.pdf downloaded; number, dates, 6 line items and total $1,240.00 present." },
      { id: "AC-02", kind: "scenario", title: "Download a void invoice", evidence: "ac-02-void-watermark.png", note: "INV-2275.pdf carries a diagonal VOID watermark on every page." },
      { id: "R1", kind: "matrix rule", title: "Same workspace: file returned", evidence: "r1-same-workspace.json", note: "200, application/pdf, Content-Disposition filename=INV-3201.pdf." },
      { id: "R2", kind: "matrix rule", title: "Other workspace: not found", evidence: "r2-other-workspace.json", note: "404 with no body detail; nothing logged about the invoice." },
      { id: "R3", kind: "matrix rule", title: "Void invoice: watermarked", evidence: "r3-void.png", note: "INV-3203 (void) watermarked VOID." },
    ],
    recording: "invoice-pdf-flow.webm",
    reviewReads: {
      architecture: ["src/invoices/pdf/renderInvoicePdf.ts", "src/invoices/pdf/layout.ts"],
      security: ["src/api/invoices/downloadPdf.ts", "evidence/r2-other-workspace.json"],
      product: ["evidence/ac-01-download.png", "src/invoices/pdf/renderInvoicePdf.ts"],
    },
    findings: {
      1: [
        { seat: "product", severity: "blocker", title: "The downloaded PDF shows no tax ID line, which FR-02 lists among the required fields", rule: "FR-02", file: "evidence/ac-01-download.png" },
        { seat: "architecture", severity: "note", title: "layout.ts hard-codes A4; the template already reads the workspace's paper size", rule: null, file: "src/invoices/pdf/layout.ts" },
        { seat: "security", severity: "note", title: "Rendering is synchronous in the request; fine at the 200-line limit (INV-03)", rule: null, file: "src/api/invoices/downloadPdf.ts" },
      ],
    },
    diffStat: "12 files changed, 734 insertions(+), 3 deletions(-)",
  },

  // ---------------------------------------------------------------- LOCAL-034: dispatched once SLICE-021 is merged
  "LOCAL-034": {
    slice: "SLICE-024",
    ticket: "LOCAL-034",
    scope: "SLICE-024",
    contracts: [{ path: "proto/notifications/v1/reminders.proto", existing: false, summary: "OverdueReminder job and its delivery record" }],
    tasks: [
      { id: "T01", kind: "test", text: "A reminder is sent on the first day an invoice is overdue (FR-01, R1)", files: ["src/reminders/overdueReminder.test.ts"], ids: ["FR-01"], tests: 5, reads: ["src/invoices/statusFilter.ts"], minutes: 1.6 },
      { id: "T02", kind: "impl", text: "Daily overdue reminder job", files: ["src/reminders/overdueReminder.ts", "src/jobs/schedule.ts"], ids: ["FR-01"], reads: ["src/jobs/schedule.ts", "src/email/send.ts"], minutes: 2.8 },
      { id: "T03", kind: "test", text: "No second reminder within seven days (INV-01, R2)", files: ["src/reminders/overdueReminder.test.ts"], ids: ["INV-01"], tests: 3, minutes: 1.3 },
      { id: "T04", kind: "impl", text: "Record deliveries and skip recent ones", files: ["src/reminders/overdueReminder.ts", "src/reminders/deliveries.ts"], ids: ["INV-01"], minutes: 2.2 },
      { id: "T05", kind: "test", text: "Reminder email content and unsubscribe footer (FR-02, AC-01)", files: ["src/reminders/reminderEmail.test.ts"], ids: ["FR-02", "AC-01"], tests: 4, minutes: 1.4 },
      { id: "T06", kind: "impl", text: "Reminder email template", files: ["src/reminders/reminderEmail.ts"], ids: ["FR-02"], minutes: 2.0 },
    ],
    targets: [],
    recording: "",
    reviewReads: {},
    findings: {},
    diffStat: "",
  },
};
