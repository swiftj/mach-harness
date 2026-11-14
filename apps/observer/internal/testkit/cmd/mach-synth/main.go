// Command mach-synth writes a large, deterministic, entirely synthetic Factory history for the
// M6.3 performance work, or extends one live. Test tooling only: it is not part of mach-observer
// and no release builds it (apps/observer/build.sh and the release workflow build ./cmd/mach-observer).
//
//	go run ./internal/testkit/cmd/mach-synth --out <dir> --cells 12 --events 220000 --seed 1 [--hours 30] [--end now]
//	go run ./internal/testkit/cmd/mach-synth --out <dir> --append --rate 200 [--duration 60s]
//	go run ./internal/testkit/cmd/mach-synth --out <dir> --analytics [--cells 300] [--waves 38] [--hours 504] [--events N] [--seed 1] [--profile realistic]
//
// The first form writes <dir>/.factory/... (the intake log and ledger, cell lifecycle logs and
// files, archives, execution records and Claude Code streams), <dir>/synth-summary.json and
// <dir>/synth-state.json, and prints the summary as JSON. The second continues the history's open
// execution at about --rate events per second until --duration passes or it is interrupted, and
// prints what it appended. The third writes an analytics-grade project (synth/analytics.go) with
// <dir>/expected.json, the ground truth metric tests compare against.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"mach/observer/internal/testkit/synth"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "mach-synth:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	fs := flag.NewFlagSet("mach-synth", flag.ContinueOnError)
	out := fs.String("out", "", "the project folder to write (must be empty or absent; with --append, a generated project)")
	cells := fs.Int("cells", 12, "cells (tickets)")
	events := fs.Int("events", 220000, "version 3 events the sources should yield (approximately)")
	seed := fs.Uint64("seed", 1, "random seed")
	hours := fs.Float64("hours", 30, "length of the history")
	end := fs.String("end", "", "when the history ends: RFC 3339, or \"now\" (default: a fixed time, so output is repeatable)")
	agents := fs.Int("agents", 36, "workflow agents per belt execution (target)")
	appendMode := fs.Bool("append", false, "extend a generated project live instead of generating one")
	rate := fs.Int("rate", 200, "with --append: events per second")
	duration := fs.Duration("duration", 0, "with --append: how long to run (default: until interrupted)")
	analytics := fs.Bool("analytics", false, "generate an analytics-grade project (many finished tickets, run records, expected.json); unset options take the analytics defaults")
	waves := fs.Int("waves", 0, "with --analytics: delivery waves (default: one per eight cells)")
	maxPar := fs.Int("max-parallel", 0, "with --analytics: the supervisor's max_parallel (default 4)")
	profile := fs.String("profile", "", "with --analytics: \"realistic\" for real-time durations, a working week and provenance configurations (the history is as long as the work; --hours is not used)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	given := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { given[f.Name] = true })
	if *out == "" {
		return fmt.Errorf("--out is required")
	}
	abs, err := filepath.Abs(*out)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if *appendMode {
		stop := make(chan struct{})
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		go func() { <-sig; close(stop) }()
		sum, err := synth.Append(synth.AppendOptions{Out: abs, Rate: *rate, Duration: *duration, Seed: *seed}, stop)
		if sum != nil {
			enc.Encode(sum)
		}
		return err
	}
	o := synth.Options{Out: abs, Cells: *cells, Events: *events, Seed: *seed, Hours: *hours, AgentsPerExecution: *agents}
	if *profile != "" && !*analytics {
		return fmt.Errorf("--profile applies only with --analytics")
	}
	if *analytics {
		// Only what was asked for: the rest takes the analytics defaults (events: no progress fill).
		o = synth.Options{Out: abs, Seed: *seed, Analytics: true, Waves: *waves, MaxParallel: *maxPar, Profile: *profile}
		if given["cells"] {
			o.Cells = *cells
		}
		if given["events"] {
			o.Events = *events
		}
		if given["hours"] {
			o.Hours = *hours
		}
		if given["agents"] {
			o.AgentsPerExecution = *agents
		}
	}
	switch *end {
	case "":
	case "now":
		o.End = time.Now().UTC().Truncate(time.Minute)
	default:
		t, err := time.Parse(time.RFC3339, *end)
		if err != nil {
			return fmt.Errorf("--end: %w", err)
		}
		o.End = t
	}
	began := time.Now()
	sum, err := synth.Generate(o)
	if err != nil {
		return err
	}
	data, _ := json.MarshalIndent(sum, "", "  ")
	if err := os.WriteFile(filepath.Join(abs, synth.SummaryFile), append(data, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "mach-synth: wrote %s in %s\n", abs, time.Since(began).Round(time.Millisecond))
	return enc.Encode(sum)
}
