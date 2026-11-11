import { contrastPairs, elevation, fonts, motion, palette, radius, themes, typeScale, useTheme, Text, Badge, type Role } from "@mach/ui";
import { Row, Section, Specimen } from "../layout";
import { fx } from "../fixtures";

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
}
function ratio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const brand: Array<{ name: keyof typeof palette; role: string }> = [
  { name: "charcoal", role: "Ink; the Control Tower canvas" },
  { name: "cream", role: "The Product Studio canvas" },
  { name: "terracotta", role: "Brand accent: the primary action and where you are" },
  { name: "blue", role: "Information, in-progress, focus" },
  { name: "green", role: "Approved and accepted" },
  { name: "ochre", role: "Warnings: something to settle" },
  { name: "brick", role: "Errors, blocked, destructive" },
];

const neutrals = ["paper0", "paper50", "paper100", "paper150", "paper200", "paper300", "paper400", "paper500", "paper600", "paper700", "paper800", "paper850", "paper900", "paper950", "paper1000"] as const;

const roleGroups: Array<{ title: string; roles: Role[] }> = [
  { title: "Surfaces", roles: ["canvas", "surface", "surface-raised", "surface-sunken", "surface-nav", "surface-inverse"] },
  { title: "Ink and lines", roles: ["ink", "ink-muted", "ink-subtle", "line", "line-strong", "line-control"] },
  { title: "Accent and focus", roles: ["accent", "accent-fill", "accent-ink", "accent-soft", "focus"] },
  {
    title: "Feedback",
    roles: ["info-ink", "info-soft", "success-ink", "success-soft", "warning-ink", "warning-soft", "danger-ink", "danger-soft", "neutral-ink", "neutral-soft"],
  },
];

export function Foundations() {
  const { resolved } = useTheme();
  const theme = themes[resolved];
  return (
    <Section
      id="foundations"
      title="Foundations"
      intro="Warm paper for Product Studio, charcoal night for Control Tower: one set of roles, two themes. Components use roles, never raw colours."
    >
      <Specimen title="Brand colours" note="The starting palette. Terracotta is used sparingly: one primary action per region, and the current place in navigation.">
        <ul className="grid grid-cols-7 gap-3">
          {brand.map(({ name, role }) => (
            <li key={name} className="flex flex-col gap-2">
              <span className="h-16 rounded-sm border border-line" style={{ background: palette[name] }} />
              <span className="text-label text-ink">{name}</span>
              <span className="font-mono text-caption text-ink-muted">{palette[name]}</span>
              <span className="text-caption text-ink-muted">{role}</span>
            </li>
          ))}
        </ul>
      </Specimen>

      <Specimen title="Warm neutrals" note="Fifteen steps from white to near-black, all warm. Surfaces, lines and ink in both themes are drawn from this ramp.">
        <ul className="grid grid-cols-[repeat(15,minmax(0,1fr))] gap-1.5">
          {neutrals.map((name) => (
            <li key={name} className="flex flex-col gap-1.5">
              <span className="h-12 rounded-xs border border-line" style={{ background: palette[name] }} />
              <span className="font-mono text-[11px] leading-tight text-ink-muted">{name.replace("paper", "")}</span>
            </li>
          ))}
        </ul>
      </Specimen>

      <Specimen title={`Semantic roles, ${resolved} theme`} note="Switch the theme in the navigation to see the other set. Each role is a CSS variable --mach-<role> and a Tailwind colour (bg-surface, text-ink-muted).">
        <div className="grid grid-cols-2 gap-x-10 gap-y-6">
          {roleGroups.map((group) => (
            <div key={group.title} className="flex flex-col gap-2">
              <Text weight="semibold" size="body-sm">
                {group.title}
              </Text>
              <ul className="flex flex-col">
                {group.roles.map((role) => (
                  <li key={role} className="flex items-center gap-3 border-b border-line py-1.5 last:border-b-0">
                    <span className="size-6 shrink-0 rounded-xs border border-line-strong" style={{ background: `var(--mach-${role})` }} />
                    <span className="min-w-0 flex-1 font-mono text-mono text-ink">{role}</span>
                    <span className="font-mono text-caption text-ink-muted">{theme[role]}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen title="Contrast, checked" note="Every text pair meets WCAG AA (4.5:1); control borders, focus rings and graph edges meet 3:1. The token script fails the build if one does not.">
        <table className="w-full border-collapse text-left text-body-sm">
          <caption className="sr-only">Contrast ratios for the {resolved} theme</caption>
          <thead>
            <tr className="border-b border-line-strong text-caption text-ink-muted">
              <th scope="col" className="py-2 pr-4 font-semibold">Sample</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Foreground on background</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Used for</th>
              <th scope="col" className="py-2 text-right font-semibold">Ratio</th>
            </tr>
          </thead>
          <tbody>
            {contrastPairs.map((pair) => {
              const r = ratio(theme[pair.fg], theme[pair.bg]);
              return (
                <tr key={`${pair.fg}/${pair.bg}`} className="border-b border-line last:border-b-0">
                  <td className="py-1.5 pr-4">
                    <span
                      className="inline-flex h-7 w-14 items-center justify-center rounded-xs border border-line text-label"
                      style={{ background: `var(--mach-${pair.bg})`, color: `var(--mach-${pair.fg})` }}
                    >
                      Aa
                    </span>
                  </td>
                  <td className="py-1.5 pr-4 font-mono text-caption text-ink">
                    {pair.fg} / {pair.bg}
                  </td>
                  <td className="py-1.5 pr-4 text-ink-muted">{pair.use}</td>
                  <td className="py-1.5 text-right tabular">
                    <span className="mr-2 font-semibold text-ink">{r.toFixed(2)}</span>
                    <Badge tone={r >= pair.min ? "success" : "danger"}>{r >= pair.min ? `AA ${pair.min}` : `fails ${pair.min}`}</Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Specimen>

      <Specimen title="Typography" note="Newsreader for headings and product writing, Source Sans 3 for the interface, JetBrains Mono for identifiers. All three are bundled; nothing loads from a font service.">
        <div className="flex flex-col divide-y divide-line">
          {(Object.keys(typeScale) as Array<keyof typeof typeScale>).map((step) => {
            const t = typeScale[step];
            const family = t.family === "serif" ? "var(--mach-font-display)" : t.family === "mono" ? "var(--mach-font-mono)" : "var(--mach-font-sans)";
            const sample =
              step === "mono"
                ? "SLICE-001  EPIC-001  WAVE-002  FR-01"
                : step === "body-lg"
                  ? fx_vision
                  : step.startsWith("title") || step === "display"
                    ? "Invite a teammate"
                    : "Settled who may invite and the seat limit. Next: do invitations expire?";
            return (
              <div key={step} className="grid grid-cols-[150px_1fr] items-baseline gap-6 py-3">
                <div className="flex flex-col">
                  <span className="font-mono text-mono text-ink">{step}</span>
                  <span className="text-caption text-ink-subtle tabular">
                    {t.size} / {t.line}, {t.weight}
                  </span>
                </div>
                <p
                  className="min-w-0 truncate text-ink"
                  style={{
                    fontFamily: step === "body-lg" ? "var(--mach-font-serif)" : family,
                    fontSize: t.size,
                    lineHeight: t.line,
                    fontWeight: t.weight,
                    letterSpacing: t.tracking,
                  }}
                >
                  {sample}
                </p>
              </div>
            );
          })}
        </div>
        <dl className="mt-6 border-t border-line pt-4">
          <Row term="serif">{fonts.serif}</Row>
          <Row term="sans">{fonts.sans}</Row>
          <Row term="mono">{fonts.mono}</Row>
        </dl>
      </Specimen>

      <div className="grid grid-cols-3 gap-6">
        <Specimen title="Spacing" note="A 4px step. Rhythm inside a panel: 8, 12, 16. Between sections: 32, 40.">
          <ul className="flex flex-col gap-2">
            {[4, 8, 12, 16, 24, 32, 40, 48].map((px) => (
              <li key={px} className="flex items-center gap-3">
                <span className="w-8 text-right font-mono text-caption text-ink-muted tabular">{px}</span>
                <span className="h-3 rounded-xs bg-accent" style={{ width: px * 2 }} />
              </li>
            ))}
          </ul>
        </Specimen>
        <Specimen title="Radius" note="Tighter for smaller things. Pills are full.">
          <ul className="grid grid-cols-2 gap-3">
            {(Object.keys(radius) as Array<keyof typeof radius>).map((name) => (
              <li key={name} className="flex flex-col items-start gap-1.5">
                <span className="h-12 w-full border border-line-control bg-surface-sunken" style={{ borderRadius: radius[name] }} />
                <span className="font-mono text-caption text-ink-muted">
                  {name} {radius[name]}
                </span>
              </li>
            ))}
          </ul>
        </Specimen>
        <Specimen title="Elevation" note="Three levels. Dark relies on lighter surfaces more than shadow." well>
          <ul className="flex flex-col gap-4">
            {(["1", "2", "3"] as const).map((level) => (
              <li key={level} className="flex h-12 items-center rounded-md bg-surface-raised px-4 text-body-sm text-ink" style={{ boxShadow: `var(--mach-shadow-${level})` }}>
                shadow-{level}: {level === "1" ? "rows, product node" : level === "2" ? "popovers, menus" : "dialogs, sheets, toasts"}
                <span className="sr-only">{elevation[resolved][level]}</span>
              </li>
            ))}
          </ul>
        </Specimen>
      </div>

      <Specimen title="Motion" note="Motion answers a person's action or shows what changed. Under reduced motion every duration becomes zero.">
        <dl>
          {(Object.keys(motion.duration) as Array<keyof typeof motion.duration>).map((name) => (
            <Row key={name} term={`${name} ${motion.duration[name]}ms`}>
              {
                {
                  instant: "State that must not lag: checkbox ticks, selection.",
                  fast: "Hover, press and focus feedback.",
                  base: "Popovers, tooltips, tab changes.",
                  slow: "Dialogs, sheets and toasts entering.",
                  layout: "Graph re-layout and list reordering after a change.",
                }[name]
              }
            </Row>
          ))}
        </dl>
      </Specimen>
    </Section>
  );
}

const fx_vision = fx.statusConflicts.project?.vision ?? "";
