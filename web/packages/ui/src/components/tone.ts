/** The feedback tones. Each maps to an -ink, -soft, -line and -fill token. */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

export const toneClasses: Record<Tone, { soft: string; ink: string; line: string; fill: string }> = {
  neutral: { soft: "bg-neutral-soft", ink: "text-neutral-ink", line: "border-neutral-line", fill: "bg-neutral-fill" },
  info: { soft: "bg-info-soft", ink: "text-info-ink", line: "border-info-line", fill: "bg-info-fill" },
  success: { soft: "bg-success-soft", ink: "text-success-ink", line: "border-success-line", fill: "bg-success-fill" },
  warning: { soft: "bg-warning-soft", ink: "text-warning-ink", line: "border-warning-line", fill: "bg-warning-fill" },
  danger: { soft: "bg-danger-soft", ink: "text-danger-ink", line: "border-danger-line", fill: "bg-danger-fill" },
  accent: { soft: "bg-accent-soft", ink: "text-accent-ink", line: "border-accent", fill: "bg-accent-fill" },
};
