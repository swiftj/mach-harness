# mach-studio: the local host for the visual Product Studio

A small Go program that serves the Product Studio web app on the loopback interface and passes the
app's requests to the Product Studio engine, `skills/product-studio/scripts/studio.py`. The engine
decides every product rule; the host checks the shape and safety of a request, runs one
allowlisted engine operation, and returns what the engine said. The working contract is
`docs/mach-next/M5_CONTRACT.md`.

Standard library only. Go 1.27.

```
cmd/mach-studio/     flags, start-up, opening the browser
internal/engine/     the operation allowlist: typed arguments -> fixed argument vector -> envelope
internal/security/   start token and session, Host/Origin/CSRF checks, headers, draft path safety
internal/server/     the HTTP routes
internal/interview/  the interface the interview bridge plugs into (unavailable for now)
internal/webui/      the built web app, embedded (dist/)
internal/testkit/    temporary projects for the tests
```

## Build and run

```
cd apps/studio
go build -o mach-studio ./cmd/mach-studio
./mach-studio                 # the project is the nearest folder above the current one with .git (or MACH's folder)
./mach-studio --project ~/work/team-space --no-open
```

| Flag | Meaning |
|------|---------|
| `--project <dir>` | The project. Default: the current folder, resolved the way the engine resolves it. |
| `--no-open` | Print the address; do not open a browser. |
| `--port <n>` | Loopback port. Default `0`: a free one. |
| `--python <path>` | The interpreter. Default: `python3` on `PATH`. For tests. |
| `--engine <path>` | `studio.py`. Default: found as below. For tests. |

Start-up prints `Open: http://127.0.0.1:<port>/?t=<token>` and opens it. The link works once.

## How the engine is found

Resolved once, at start-up, to absolute paths that are then fixed for the life of the process:

1. `--engine`, if given.
2. Next to the binary: its folder and each folder above it (up to eight levels), first
   `skills/product-studio/scripts/studio.py` (the plugin, or this repository), then
   `.claude/skills/mach-product-studio/scripts/studio.py` (a script install into a project).
3. The project: `<project>/.claude/skills/mach-product-studio/scripts/studio.py`.

The binary is checked before the project so the host and the engine come from the same install.
The interpreter is `--python`, else `python3` on `PATH`, made absolute (not resolved through
symlinks, so a virtual environment keeps working). The engine runs as
`<python> -I -B <studio.py> --project <root> <fixed arguments>`, in the project folder, with a time
limit (60 s; 180 s for operations that may fetch), bounded output (8 MiB stdout, 64 KiB stderr),
and in its own process group so a time limit stops the Git processes it started too.

## The web app

`internal/webui/dist/` is embedded with `//go:embed`. Until the real frontend is built, it holds a
placeholder `index.html`. To put the real app in, build it and copy its output over the placeholder,
then rebuild the binary:

```
cd web && pnpm install && pnpm --filter @mach/product-studio build
rm -rf ../apps/studio/internal/webui/dist && cp -R apps/product-studio/dist ../apps/studio/internal/webui/dist
cd ../apps/studio && go build -o mach-studio ./cmd/mach-studio
```

The build must reference only its own files (no CDN, no external font), and must work under the
host's Content-Security-Policy: `script-src 'self'` and `style-src 'self'`, so no inline `<script>`
or `<style>` blocks and no `style="..."` attributes in the HTML (styles set from JavaScript through
the DOM are fine). Any path without a file extension that is not a file in `dist/` is served
`index.html` (client-side routing); a missing file with an extension is a 404. Files under
`assets/` are cached as immutable, so they must be content-hashed (Vite does this by default).

## Tests

```
cd apps/studio && go vet ./... && go test ./...
python3 -m unittest tests.test_mach_product_host     # from the repository root: builds the binary, drives it over HTTP
```

The Go tests run the real `studio.py` in temporary Git projects (they need `python3` and `git`;
they skip without them). `tests/test_mach_product_host.py` checks that the host and the terminal
leave byte-identical files for the same operations.
