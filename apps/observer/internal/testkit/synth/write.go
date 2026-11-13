package synth

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"time"

	"mach/observer/internal/testkit"
)

// Summary describes what was generated, for tests and the performance harness.
type Summary struct {
	Seed    uint64  `json:"seed"`
	Cells   int     `json:"cells"`
	Slices  int     `json:"slices"`
	Waves   int     `json:"waves"`
	Hours   float64 `json:"hours"`
	Start   string  `json:"start"`
	End     string  `json:"end"`
	StartMS int64   `json:"start_ms"`
	EndMS   int64   `json:"end_ms"`
	Scale   float64 `json:"scale"`
	MaxPar  int     `json:"max_parallel"`
	Target  int     `json:"events_target"`
	// Events the sources yield as version 3 events, by type, as the generator wrote them (one per
	// line or record, plus the deliberate gap). The observer adds its own reconstructed events.
	Events      int            `json:"events"`
	ByType      map[string]int `json:"events_by_type"`
	BySource    map[string]int `json:"events_by_source"`
	Reconstruct map[string]int `json:"reconstructed_expected"`
	// Spans the generator's model holds, by kind (what the projection should find, approximately:
	// the projection's own rules decide, these are for orientation and sanity checks).
	Spans        map[string]int `json:"spans_expected"`
	Executions   int            `json:"executions"`
	Agents       int            `json:"agents"`
	Files        int            `json:"files"`
	Bytes        int64          `json:"bytes"`
	GapsExpected []string       `json:"gaps_expected"`
	Features     map[string]any `json:"features"`
	Tickets      []string       `json:"tickets"`
}

type counter struct {
	byType   map[string]int
	bySource map[string]int
}

func (c *counter) add(source, typ string, n int) {
	if n <= 0 {
		return
	}
	c.byType[typ] += n
	c.bySource[source] += n
}

// Generate writes the project and returns its summary.
func Generate(o Options) (*Summary, error) {
	o.Defaults()
	if err := o.check(); err != nil {
		return nil, err
	}
	if entries, err := os.ReadDir(o.Out); err == nil && len(entries) > 0 {
		return nil, fmt.Errorf("%s is not empty", o.Out)
	}
	w := newWorld(o)
	settled := w.simulate()
	w.endT = settled / 0.93
	w.k = o.Hours * 3600 / w.endT
	w.startMS = o.End.Add(-time.Duration(o.Hours * float64(time.Hour))).UnixMilli()
	g := &gen{w: w, root: o.Out, cnt: counter{byType: map[string]int{}, bySource: map[string]int{}}, recon: map[string]int{}}
	if err := g.write(); err != nil {
		return nil, err
	}
	return g.summary(), nil
}

type gen struct {
	w      *world
	root   string
	cnt    counter
	recon  map[string]int
	spans  map[string]int
	files  int
	bytes  int64
	agents int
	state  *State
}

func (g *gen) path(rel ...string) string { return filepath.Join(append([]string{g.root}, rel...)...) }

func (g *gen) put(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	g.files++
	g.bytes += int64(len(data))
	return os.WriteFile(path, data, 0o644)
}

func (g *gen) in(t float64) bool { return t <= g.w.endT }

// resolve turns model times inside a record's data into timestamps.
func (g *gen) resolve(v any) any {
	switch x := v.(type) {
	case mt:
		return isoS(g.w.ms(float64(x)))
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = g.resolve(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = g.resolve(e)
		}
		return out
	}
	return v
}

func (g *gen) write() error {
	w := g.w
	g.spans = map[string]int{"wave": len(w.waves), "capacity-wait": w.capacityWaits}
	for _, d := range []string{".factory/intake", ".factory/worktrees", ".factory/local/executions", ".factory/archive", ".factory/observations"} {
		if err := os.MkdirAll(g.path(d), 0o755); err != nil {
			return err
		}
	}
	cfg, _ := json.MarshalIndent(map[string]any{"synthetic": true, "factory": map[string]any{"max_parallel": maxParallel},
		"tickets": map[string]any{"provider": "local"}}, "", "  ")
	if err := g.put(g.path(".factory", "config.json"), append(cfg, '\n')); err != nil {
		return err
	}
	if err := g.writeIntake(); err != nil {
		return err
	}
	if err := g.writeLedger(); err != nil {
		return err
	}
	for _, c := range w.cells {
		if err := g.writeCell(c); err != nil {
			return err
		}
	}
	// The stream budget: what is left after every other source.
	fixed := 0
	for _, n := range g.cnt.byType {
		fixed += n
	}
	streams := make([]*streamGen, 0, len(w.execs))
	for _, x := range w.execs {
		s := g.newStream(x)
		fixed += s.fixedEvents
		streams = append(streams, s)
	}
	g.budget(streams, w.o.Events-fixed)
	for _, s := range streams {
		if err := g.writeExecution(s); err != nil {
			return err
		}
	}
	return g.writeState()
}

// ---- intake log and ledger ----

func (g *gen) writeIntake() error {
	w := g.w
	var recs []*intakeRec
	for _, r := range w.intake {
		if g.in(r.t) {
			recs = append(recs, r)
		}
	}
	// A late, out-of-order batch: three sampled stage observations queued five minutes late.
	var obs []*intakeRec
	for _, r := range recs {
		if r.typ == "station.observed" {
			obs = append(obs, r)
		}
	}
	if len(obs) > 10 {
		for _, r := range obs[len(obs)/2 : len(obs)/2+3] {
			r.wt = r.t + 300
		}
		w.feature["late_intake_batch"] = 3
	}
	sort.SliceStable(recs, func(i, j int) bool { return recs[i].wt < recs[j].wt })
	var buf bytes.Buffer
	seq := 0
	gapAt := len(recs) * 45 / 100
	for i, r := range recs {
		seq++
		if i == gapAt {
			seq += 2 // two lines lost: a history gap (missing-seq)
			g.cnt.add("intake-log", "history.gap", 1)
			w.feature["intake_gap"] = fmt.Sprintf("seq %d-%d missing", seq-2, seq-1)
		}
		var ticket, x, slice, wave, rev any
		if r.ticket != "" {
			ticket = r.ticket
		}
		if r.exec != "" {
			x = r.exec
		}
		if r.slice != "" {
			slice, rev = r.slice, r.rev
		}
		if r.wave != "" {
			wave = r.wave
		}
		line, _ := json.Marshal(map[string]any{"schema_version": 2, "seq": seq, "at": isoS(w.ms(r.t)), "type": r.typ, "project_id": "P-SYNTH",
			"source_commit": nil, "wave_id": wave, "slice_id": slice, "revision": rev, "ticket_id": ticket, "runner_id": "runner-synth",
			"execution_id": x, "source": r.source, "cause": nil, "refs": nil, "data": g.resolve(r.data)})
		buf.Write(line)
		buf.WriteByte('\n')
		g.cnt.add("intake-log", r.typ, 1)
		switch r.typ {
		case "dependency.blocked":
			g.spans["slice-wait"]++
		case "work.scheduled":
			g.spans["slice-eligible"]++
		case "work.claimed":
			g.spans["claim"]++
		}
	}
	g.state = &State{IntakeSeq: seq}
	return g.put(g.path(".factory", "intake", "events.jsonl"), buf.Bytes())
}

func (g *gen) writeLedger() error {
	w := g.w
	slices := map[string]any{}
	for _, s := range w.slices {
		state := "waiting"
		if s.cell != nil && s.cell.created > 0 && g.in(s.cell.created) {
			state = "dispatched"
			if s.cell.integrated > 0 && g.in(s.cell.integrated) {
				state = "integrated"
			}
		}
		slices[s.id] = map[string]any{"ticket_id": s.ticket, "wave_id": s.wave.id, "revision": s.rev, "state": state}
	}
	execs := map[string]any{}
	for _, x := range w.execs {
		if !g.in(x.claim) {
			continue
		}
		state := x.outcome
		if math.IsInf(x.end, 1) || !g.in(x.end) {
			state = "running"
		}
		execs[x.id] = map[string]any{"ticket_id": x.cell.ticket, "state": state, "attempt": x.attempt}
	}
	data, _ := json.MarshalIndent(map[string]any{"version": 1, "project_id": "P-SYNTH", "synthetic": true, "slices": slices,
		"supervisor": map[string]any{"executions": execs, "attempts": map[string]any{}, "parked": map[string]any{}, "observed": map[string]any{}}}, "", "  ")
	return g.put(g.path(".factory", "intake", "ledger.json"), append(data, '\n'))
}

// ---- cells, archives, run records ----

func (g *gen) writeCell(c *cell) error {
	w := g.w
	if c.created == 0 || !g.in(c.created) {
		return nil
	}
	var recs []*lifeRec
	for _, r := range c.life {
		if g.in(r.t) && g.in(r.wt) {
			recs = append(recs, r)
		}
	}
	sort.SliceStable(recs, func(i, j int) bool { return recs[i].wt < recs[j].wt })
	var live, full bytes.Buffer
	rounds := map[int]bool{}
	for i, r := range recs {
		line := testkit.Record{Seq: i + 1, At: isoMS(w.ms(r.t)), Ticket: c.ticket, Type: r.typ, Station: r.station, Visit: r.visit,
			Round: r.round, Execution: r.exec, Data: g.resolve(r.data).(map[string]any)}.Line()
		full.Write(line)
		if !r.archive {
			live.Write(line)
		}
		g.cnt.add("cell-lifecycle", r.typ, 1)
		switch r.typ {
		case "station.entered":
			g.spans["visit"]++
		case "build.task_completed":
			g.spans["task"]++
		case "review.verdict_submitted":
			g.spans["seat"]++
		case "review.decided":
			if r.data["decision"] == "AWAITING_HUMAN" {
				g.spans["person-wait"]++
			}
		}
		if r.round > 0 {
			rounds[r.round] = true
		}
	}
	g.spans["cell"]++
	g.spans["round"] += len(rounds)
	if c.ticket == w.feature["open_ticket"] {
		// The live edge: the open build visit the appender continues.
		g.state.LifeSeq, g.state.Round = len(recs), c.round
		for _, r := range recs {
			if r.typ == "station.entered" && r.station == "build" {
				g.state.Visit = r.visit
			}
		}
	}
	stage := c.stage
	if s := stageAtTime(c, w.endT); s != "" {
		stage = s
	}
	cellJSON, _ := json.MarshalIndent(map[string]any{"ticket_id": c.ticket, "stage": stage, "created_at": isoS(w.ms(c.created)), "round": c.round,
		"mode": "headless", "risk_tier": c.risk, "app_type": "cli", "slice_id": c.slice.id,
		"product": map[string]any{"slice_id": c.slice.id, "wave_id": c.slice.wave.id, "revision": c.slice.rev}, "synthetic": true}, "", "  ")
	files := map[string][]byte{"cell.json": append(cellJSON, '\n')}
	for name, body := range c.files {
		if name[0] != '#' {
			files[name] = body
		}
	}
	if !c.archived {
		dir := g.path(".factory", "worktrees", c.ticket)
		for name, body := range files {
			if err := g.put(filepath.Join(dir, filepath.FromSlash(name)), body); err != nil {
				return err
			}
		}
		return g.put(filepath.Join(dir, "lifecycle.jsonl"), live.Bytes())
	}
	files["lifecycle.jsonl"] = full.Bytes()
	if err := g.writeArchive(c.ticket, files); err != nil {
		return err
	}
	return g.appendRun(c)
}

func (g *gen) writeArchive(ticket string, files map[string][]byte) error {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	stamp := g.w.o.End.Truncate(time.Second)
	for _, n := range names {
		data := files[n]
		if err := tw.WriteHeader(&tar.Header{Name: ticket + "/" + n, Mode: 0o644, Size: int64(len(data)), Typeflag: tar.TypeReg, ModTime: stamp, Format: tar.FormatPAX}); err != nil {
			return err
		}
		tw.Write(data)
	}
	tw.Close()
	gz.Close()
	return g.put(g.path(".factory", "archive", ticket+".tar.gz"), buf.Bytes())
}

func (g *gen) appendRun(c *cell) error {
	w := g.w
	verifyFails, rejections := 0, 0
	for _, r := range c.life {
		if r.typ == "station.exited" && r.station == "verify" && r.data["outcome"] == "FAIL_WITH_EVIDENCE" {
			verifyFails++
		}
		if r.typ == "review.decided" && r.data["decision"] == "REJECTED" {
			rejections++
		}
	}
	closed := 0.0
	for _, r := range c.life {
		closed = math.Max(closed, r.t)
	}
	line, _ := json.Marshal(map[string]any{"record_version": 2, "ticket_id": c.ticket, "closed_at": isoS(w.ms(closed) + 1000), "outcome": "merged",
		"rounds": c.round, "first_pass": verifyFails+rejections == 0, "verify_failures": verifyFails, "review_rejections": rejections, "escalated": false,
		"human_approval": false, "deviations": []any{}, "blockers": []any{}, "risk": c.risk, "app_type": "cli", "tests_seen_failing_first": 2,
		"tests_passing_on_first_run": 2, "integration": map[string]any{"method": "local", "merge_commit": c.head},
		"product": map[string]any{"slice_id": c.slice.id, "wave_id": c.slice.wave.id, "revision": c.slice.rev}})
	path := g.path(".factory", "archive", "runs.jsonl")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(append(line, '\n')); err != nil {
		return err
	}
	if fi, err := f.Stat(); err == nil && fi.Size() == int64(len(line)+1) {
		g.files++
	}
	g.bytes += int64(len(line) + 1)
	g.cnt.add("run-record", "run.recorded", 1)
	return nil
}

// ---- executions ----

func (g *gen) writeExecution(s *streamGen) error {
	w := g.w
	x := s.x
	if !g.in(x.claim) {
		return nil
	}
	dir := g.path(".factory", "local", "executions", x.id)
	n := len(w.execs)
	for i, y := range w.execs {
		if y == x {
			n = i
		}
	}
	started, _ := json.Marshal(map[string]any{"execution_id": x.id, "wrapper_pid": 41000 + n, "child_pid": 42000 + n, "started_at": isoS(w.ms(x.start))})
	if err := g.put(filepath.Join(dir, "started.json"), append(started, '\n')); err != nil {
		return err
	}
	g.cnt.add("execution-record", "execution.process_started", 1)
	g.spans["execution"]++
	if x.workflow {
		g.spans["workflow"]++
	}
	if !math.IsInf(x.end, 1) && g.in(x.end) {
		var code any = 0
		if x.ended != "exited" {
			code = nil
		}
		startS := w.ms(x.start) / 1000
		endS := w.ms(x.end) / 1000
		result, _ := json.Marshal(map[string]any{"execution_id": x.id, "ended": x.ended, "exit_code": code, "ended_at": isoS(endS * 1000), "seconds": endS - startS})
		if err := g.put(filepath.Join(dir, "result.json"), append(result, '\n')); err != nil {
			return err
		}
		g.cnt.add("execution-record", "execution.process_ended", 1)
	}
	f, err := os.Create(filepath.Join(dir, "stream.jsonl"))
	if err != nil {
		return err
	}
	bw := bufio.NewWriterSize(f, 1<<20)
	size, err := s.write(bw)
	if err == nil {
		err = bw.Flush()
	}
	f.Close()
	g.files++
	g.bytes += size
	return err
}

func (g *gen) summary() *Summary {
	w := g.w
	total := 0
	for _, n := range g.cnt.byType {
		total += n
	}
	var tickets []string
	for _, c := range w.cells {
		tickets = append(tickets, c.ticket)
	}
	return &Summary{Seed: w.o.Seed, Cells: len(w.cells), Slices: len(w.slices), Waves: len(w.waves), Hours: w.o.Hours,
		Start: isoMS(w.startMS), End: isoMS(w.ms(w.endT)), StartMS: w.startMS, EndMS: w.ms(w.endT), Scale: math.Round(w.k*1000) / 1000, MaxPar: maxParallel,
		Target: w.o.Events, Events: total, ByType: g.cnt.byType, BySource: g.cnt.bySource, Reconstruct: g.recon, Spans: g.spans,
		Executions: len(w.execs), Agents: g.agents, Files: g.files, Bytes: g.bytes,
		GapsExpected: []string{"intake-log missing-seq (2 lines), deliberate"}, Features: w.feature, Tickets: tickets}
}
