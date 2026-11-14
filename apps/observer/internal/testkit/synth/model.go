// Package synth generates a large, realistic, entirely synthetic Factory history on disk, in the
// file formats the observer ingests (docs/mach-next/M6_1_EVENT_CONTRACT.md section 2): the intake
// log and ledger, each cell's lifecycle log and files, execution records and Claude Code stream
// lines, cell archives and the run record. It is test tooling for the M6.3 performance budget
// (docs/mach-next/M6_3_PERFORMANCE.md); it is never built into mach-observer.
//
// Everything is a pure function of the options: the same seed gives byte-identical files (file
// modification times aside). Ids are invented (SYN-*, SLICE-*, WAVE-*, P-SYNTH), people appear only
// as roles, and nothing names a path outside the generated folder.
//
// The generator works in two steps. A small scheduler (simulate.go) plays the Factory forward in
// model seconds: waves arrive, slices wait on dependencies, the supervisor dispatches and holds work
// against max_parallel, and each cell runs its executions (profile.go) station by station. The
// whole model is then scaled so the history spans the requested hours, and written (write.go),
// spreading the remaining event budget over the workflow agents' progress records.
package synth

import (
	"fmt"
	"math"
	"math/rand/v2"
	"time"
)

// Options say what to generate.
type Options struct {
	Out    string    // the project folder to write (created; must be empty or absent)
	Cells  int       // cells (tickets) with a lifecycle; at least 4
	Events int       // the v3 events the sources should yield, approximately (within 1%)
	Seed   uint64    // the random seed
	Hours  float64   // how long the history is
	End    time.Time // when it ends (the live edge of the generated history)
	// AgentsPerExecution is the target number of workflow agents per belt execution.
	AgentsPerExecution int
	// Analytics generates an analytics-grade project instead (analytics.go): many finished tickets
	// over many delivery waves, run records exactly as the cleanup station writes them, and a
	// ground-truth expected.json. Without it every other option behaves exactly as before.
	Analytics   bool
	Waves       int // analytics: delivery waves (default: one per eight cells)
	MaxParallel int // analytics: the supervisor's max_parallel (default 4)
	// Profile is the analytics profile: "" (the default, compact and stretched over Hours) or
	// "realistic" (realistic.go: real-time durations, a working week, provenance configurations;
	// the history is as long as the work, and Hours is not used).
	Profile string
}

// DefaultEnd is the fixed end of a default history, so the default output is repeatable.
var DefaultEnd = time.Date(2026, 11, 12, 6, 0, 0, 0, time.UTC)

// Defaults fills unset options.
func (o *Options) Defaults() {
	if o.Analytics {
		o.analyticsDefaults()
		return
	}
	if o.Cells == 0 {
		o.Cells = 12
	}
	if o.Events == 0 {
		o.Events = 220000
	}
	if o.Hours == 0 {
		o.Hours = 30
	}
	if o.End.IsZero() {
		o.End = DefaultEnd
	}
	if o.AgentsPerExecution == 0 {
		o.AgentsPerExecution = 36
	}
}

func (o Options) check() error {
	if o.Analytics {
		return o.analyticsCheck()
	}
	if o.Profile != "" {
		return fmt.Errorf("--profile applies only with --analytics")
	}
	switch {
	case o.Out == "":
		return fmt.Errorf("an output folder is required")
	case o.Cells < 4 || o.Cells > 400:
		return fmt.Errorf("cells must be between 4 and 400")
	case o.Hours < 1 || o.Hours > 24*60:
		return fmt.Errorf("hours must be between 1 and 1440")
	case o.Events < 1000:
		return fmt.Errorf("events must be at least 1000")
	case o.AgentsPerExecution < 8 || o.AgentsPerExecution > 400:
		return fmt.Errorf("agents per execution must be between 8 and 400")
	}
	return nil
}

// ---- the model (times are model seconds from the start, scaled when written) ----

type wave struct {
	id     string
	at     float64
	slices []*slice
}

type slice struct {
	id     string
	n      int
	wave   *wave
	ticket string
	cell   *cell // nil for a slice that never gets a cell
	rev    int
	// phases of dependencies: the slice waits for every cell of phase k, then a new revision adds
	// phase k+1 (a slice blocked several times). Most slices have zero or one phase.
	phases     [][]*cell
	phase      int
	blockedAt  float64
	blocked    bool
	resolvedAt float64
	ready      bool // dependencies resolved
	dispatched bool
	supersede  float64 // when the next revision is due, 0 if none
	digest     string  // the current revision's digest
}

type lifeRec struct {
	t, wt   float64 // when it happened, when it was written (wt > t for a late batch)
	typ     string
	station string
	visit   int
	round   int
	exec    string
	data    map[string]any
	archive bool // written only to the archived copy (cleanup's own records)
}

type intakeRec struct {
	t, wt  float64
	typ    string
	source string
	wave   string
	slice  string
	rev    int
	ticket string
	exec   string
	data   map[string]any
}

type cell struct {
	n          int
	ticket     string
	slice      *slice
	prof       profile
	risk       string
	created    float64 // dispatch time
	life       []*lifeRec
	execs      []*execution
	seg        int // next segment
	round      int
	visits     map[string]int
	stage      string
	stages     []stageAt // stage changes, for station.observed
	readyAt    float64   // when the next segment may claim a place
	running    bool
	waitOpen   bool // a person's approval still open at the end
	done       bool
	merged     float64 // when the merge landed, 0 if never
	integrated float64
	archived   bool
	head       string
	attempts   int
	heldSince  float64 // a capacity hold began, -1 if not held
	files      map[string][]byte
	an         *cellFacts // analytics mode only
}

type stageAt struct {
	t     float64
	stage string
}

type agent struct {
	index     int
	label     string
	phase     int
	agentType string
	model     string
	queued    float64
	start     float64
	end       float64 // math.Inf(1) when it never ends inside the history
	status    string  // done, error, or "" (open: closed by the observer at the process end)
	tokens    int64
	calls     int64
	progress  int // progress records, set by the budget
	id        string
}

type mainCall struct {
	id     string
	tool   string
	called float64
	ret    float64
	noTime bool // the record carries no timestamp (placed by arrival when read live)
}

type execution struct {
	id        string
	cell      *cell
	attempt   int
	seg       segment
	claim     float64
	start     float64 // process start
	end       float64 // process end (math.Inf(1) when still running)
	ended     string  // exited, interrupted, or "" (running)
	outcome   string  // completed, failed, unknown, running
	workflow  bool
	wfStart   float64
	wfEnd     float64 // math.Inf(1) when not reported
	taskID    string
	toolUse   string
	agents    []*agent
	calls     []mainCall
	stations  []string
	stage     string // the cell's stage at the end
	next      string
	waiting   any
	cost      float64
	session   string
	nextIndex int
	an        *execFacts // analytics mode only
}

type world struct {
	o             Options
	rng           *rand.Rand
	waves         []*wave
	slices        []*slice
	cells         []*cell
	execs         []*execution
	intake        []*intakeRec
	k             float64 // model seconds -> real seconds
	endT          float64 // the end of the history, in model seconds
	startMS       int64
	ids           map[string]bool
	toolSeq       int
	feature       map[string]any
	capacityWaits int
	an            *analyticsWorld // analytics mode only
}

func newWorld(o Options) *world {
	return &world{o: o, rng: rand.New(rand.NewPCG(o.Seed, 0x6d616368)), ids: map[string]bool{}, feature: map[string]any{}}
}

// maxPar is the supervisor's max_parallel.
func (w *world) maxPar() int {
	if w.o.Analytics {
		return w.o.MaxParallel
	}
	return maxParallel
}

// between is a uniform draw in [lo, hi).
func (w *world) between(lo, hi float64) float64 { return lo + w.rng.Float64()*(hi-lo) }

func (w *world) hex(n int) string {
	const digits = "0123456789abcdef"
	b := make([]byte, n)
	for i := range b {
		b[i] = digits[w.rng.IntN(16)]
	}
	return string(b)
}

func (w *world) unique(prefix string, n int) string {
	for {
		id := prefix + w.hex(n)
		if !w.ids[id] {
			w.ids[id] = true
			return id
		}
	}
}

func (w *world) commit() string { return w.hex(7) }

// ms is a model time as Unix milliseconds.
func (w *world) ms(t float64) int64 { return w.startMS + int64(math.Round(t*w.k*1000)) }

// mt is a model time inside a record's data, written as a whole-second timestamp.
type mt float64

func isoMS(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z") }
func isoS(ms int64) string  { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05Z") }
