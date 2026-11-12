# mach-observer

The read-only local observer behind the MACH Control Tower (MACH Next M6.1, experimental). It follows
the Factory's own files, keeps a redacted index under `.factory/local/observer/`, and serves a
versioned GET-only API and a server-sent event stream on `127.0.0.1`. Design and API:
`docs/mach-next/M6_1_OBSERVER_DESIGN.md`.

    make test        # go vet + go test
    make build       # bin/mach-observer
    bin/mach-observer --project <path>   # prints a one-time link; started by a skill, not a MACH command

Standard library only. It writes nothing outside its own folder, takes no MACH lock, runs no MACH
command, starts no process and connects to nothing.
