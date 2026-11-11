# MACH web workspace

The browser side of MACH Next: the design system and the apps built on it. Read `docs/mach-next/DESIGN_SYSTEM.md` first, and `docs/mach-next/M5_CONTRACT.md` for the host API.

```
packages/ui/          @mach/ui: tokens, themes, primitives, shell, lifecycle, graph, API client
apps/showcase/        every token and component, with real engine output (port 4174)
apps/product-studio/  the Product Studio app (port 5173 in development)
fixtures/             real engine output from generate.py; never edited by hand
```

Requires Node 22.18 or later (the token script uses built-in TypeScript stripping) and pnpm 10.

| Command (in `web/`) | Does |
|---------------------|------|
| `pnpm install` | Installs exact, pinned versions |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | Every package. `typecheck` also checks that `tokens.css` is current and that every contrast pair passes |
| `pnpm dev:showcase` | The showcase |
| `pnpm dev:studio:fixtures` | Product Studio answered from `fixtures/`; `?fixture=status.conflicts` picks the status it sees |
| `MACH_STUDIO_HOST=http://127.0.0.1:<port> pnpm dev:studio` | Product Studio against a running Go host. Open the host's start-up URL once first so the session cookie is set |
| `pnpm --filter @mach/ui tokens` | Regenerates `tokens.css` after editing `tokens.ts` |
| `pnpm --filter @mach/showcase build && pnpm capture` | Screenshots in both themes at 1440 and 1100, plus axe, into `apps/showcase/screenshots/` |
| `pnpm contrast` | The contrast table, as Markdown |

Adding a screen to Product Studio: add a route in `apps/product-studio/src/router.tsx`, read with `useOperation("status", {})`, act with `client.op(...)` from an event handler, and compose `@mach/ui` components. Do not compute product rules in TypeScript; if the engine does not report something, ask for a read-only engine operation.
