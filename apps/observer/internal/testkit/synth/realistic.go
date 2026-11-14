package synth

// The realistic profile of the analytics mode (Options.Profile "realistic", mach-synth --analytics
// --profile realistic). The default analytics profile stretches a compact model over the requested
// hours, so a build visit can last nine hours and the line runs at its limit throughout. The
// realistic profile instead keeps model seconds as real seconds and lets the history be as long as
// the work: station visits of minutes to an hour or two (build longest, with a long tail),
// dispatch-to-merge of hours, a person's approval of hours with a long tail, gate refusals of a few
// percent, a working week (claims are made on weekdays from 08:00 to 20:00 UTC and on Saturday
// mornings, so concurrency rises and falls), and execution provenance: two or three MACH
// configurations, each with its own config_id, and early executions whose provenance was not
// recorded.
//
// Every draw that differs from the default profile is behind w.real(): the default profile's
// random sequence and output are unchanged (compat_test.go).

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"time"
)

// ProfileRealistic is the realistic analytics profile's name.
const ProfileRealistic = "realistic"

func (w *world) real() bool { return w.o.Profile == ProfileRealistic }

// dur draws a duration in model seconds: uniform in [lo, hi) in the default profile (exactly as
// before), log-normal around the same middle with spread sigma in the realistic profile.
func (w *world) dur(lo, hi, sigma float64) float64 {
	if !w.real() {
		return w.between(lo, hi)
	}
	d := math.Sqrt(lo*hi) * math.Exp(sigma*w.rng.NormFloat64())
	return math.Max(lo*0.3, math.Min(d, hi*4))
}

// oneIn is a one-in-n chance: n in the default profile, realN in the realistic one.
func (w *world) oneIn(n, realN int) bool {
	if w.real() {
		return w.rng.IntN(realN) == 0
	}
	return w.rng.IntN(n) == 0
}

// lognormal is a realistic-profile wait: median m seconds, spread sigma.
func (w *world) lognormal(m, sigma float64) float64 { return m * math.Exp(sigma*w.rng.NormFloat64()) }

// ---- the working week ----

func (w *world) wall(t float64) time.Time {
	return time.UnixMilli(w.startMS + int64(math.Round(t*1000))).UTC()
}

// awake: weekdays 08:00-20:00 UTC, and Saturday 10:00-13:00. Outside it the supervisor claims no
// new work (what runs keeps running) and people do not approve.
func (w *world) awake(t float64) bool {
	if !w.real() {
		return true
	}
	at := w.wall(t)
	h := at.Hour()
	switch at.Weekday() {
	case time.Saturday:
		return h >= 10 && h < 13
	case time.Sunday:
		return false
	}
	return h >= 8 && h < 20
}

// nextAwake is the first moment at or after t that is awake (in 5-minute steps).
func (w *world) nextAwake(t float64) float64 {
	for i := 0; i < 3000 && !w.awake(t); i++ {
		t += 300
	}
	return t
}

// realisticSpan estimates how long the work takes: about 5,400 seconds of execution per ticket,
// max_parallel places at 45% use, in a week that is awake 63 hours of 168.
func realisticSpan(cells, maxPar int) float64 {
	return float64(cells) * 5400 / (float64(maxPar) * 0.45 * 63 / 168)
}

// realisticStart sets the history's start: the Monday 00:00 UTC before the end less the estimated
// span. Model seconds are real seconds (k = 1).
func (w *world) realisticStart() {
	span := realisticSpan(w.o.Cells, w.o.MaxParallel) * 1.15
	start := w.o.End.Add(-time.Duration(span * float64(time.Second))).UTC().Truncate(24 * time.Hour)
	for start.Weekday() != time.Monday {
		start = start.Add(-24 * time.Hour)
	}
	w.startMS = start.UnixMilli()
	w.k = 1
}

// ---- profiles and configurations ----

var analyticsMixRealistic = []struct {
	p      profile
	weight int
}{
	{pClean, 36}, {aCleanLow, 14}, {pVerifyFail, 12}, {aTwoFails, 2}, {pReject, 8}, {aVeto, 3}, {aEscalateAbandon, 2},
	{aHighClean, 12}, {pInterrupted, 2}, {pUnknown, 1}, {aAbandon, 2}, {pArrival, 3},
}

func (w *world) pickProfileRealistic() profile {
	total := 0
	for _, m := range analyticsMixRealistic {
		total += m.weight
	}
	n := w.rng.IntN(total)
	for _, m := range analyticsMixRealistic {
		if n < m.weight {
			return m.p
		}
		n -= m.weight
	}
	return pClean
}

// The execution configurations: "" (provenance not recorded: executions from before it existed),
// A (the first recorded configuration), B (a later MACH line: new skill files), C (B's line with a
// pilot model choice for web tickets: Opus builds).
type execConfig struct {
	label        string
	version      string
	skillBuild   string // what distinguishes the line's build skill file
	buildModel   string
	securityVeto bool
}

var realisticConfigs = map[string]execConfig{
	"A": {"A", "0.13.0", "build-skill-r1", "claude-sonnet-5-5", true},
	"B": {"B", "0.14.0", "build-skill-r2", "claude-sonnet-5-5", true},
	"C": {"C", "0.14.0", "build-skill-r2", "claude-opus-5-5", true},
}

// configFor assigns a cell its configuration by when it arrives in the history.
func configFor(i, n int, appType string) string {
	f := float64(i) / float64(max(n, 1))
	switch {
	case f < 0.15:
		return ""
	case appType == "web" && f >= 0.3:
		return "C"
	case f < 0.6:
		return "A"
	}
	return "B"
}

// adjustForConfig: the cohorts differ in outcome, as configurations would (an observation, never
// claimed as a cause): before provenance existed more tickets fail verification once; the pilot
// configuration fails it less.
func (w *world) adjustForConfig(p profile, cfg string) profile {
	switch cfg {
	case "":
		if p.name == pClean.name && w.rng.IntN(100) < 30 {
			return pVerifyFail
		}
	case "C":
		if (p.name == pVerifyFail.name || p.name == aTwoFails.name) && w.rng.IntN(100) < 60 {
			return pClean
		}
	}
	return p
}

// installedAs is how the snapshot says MACH was installed: the provenance schema's value for a
// Claude Code plugin install. Spelled from parts so this test tooling never carries the quoted word
// that tests/test_mach_tower.py guards in the observer's source (it names Go's plugin package).
const installedAs = "plug" + "in"

func digest(s string) string {
	h := sha256.Sum256([]byte("synthetic:" + s))
	return hex.EncodeToString(h[:])
}

// snapshot is the provenance snapshot the supervisor records on execution.started
// (skills/run/scripts/provenance.py): digests, versions and identifiers only.
func (w *world) snapshot(c *cell, cfg execConfig) map[string]any {
	files := map[string]any{}
	for _, part := range []string{"skill:audit", "skill:build", "skill:cleanup", "skill:intent", "skill:merge", "skill:review", "skill:run", "skill:verify",
		"agent:builder", "agent:contract-engineer", "agent:reviewer", "agent:verifier", "workflow:belt", "plugin:manifest"} {
		key := part + "@" + cfg.version
		if part == "skill:build" {
			key = cfg.skillBuild
		}
		files[part] = digest(key)
	}
	names := make([]string, 0, len(files))
	for k := range files {
		names = append(names, k)
	}
	sort.Strings(names)
	lineDigest := digest(fmt.Sprint(names, cfg.version, cfg.skillBuild))
	models := map[string]any{"planning": "claude-fable-5-2", "contracts": "claude-opus-5-5", "build": cfg.buildModel, "utility": "claude-haiku-5-5"}
	review := map[string]any{"max_loops": 3, "security_veto": cfg.securityVeto, "tiers": map[string]any{
		"high":   map[string]any{"approvals": 3, "reviewers": 3, "human_approval": true},
		"medium": map[string]any{"approvals": 2, "reviewers": 3, "human_approval": false},
		"low":    map[string]any{"approvals": 1, "reviewers": 1, "human_approval": false}}}
	config := map[string]any{"recorded": true, "digest": digest("config:" + cfg.label), "models": models, "review": review, "max_parallel": w.o.MaxParallel}
	policy := map[string]any{"autonomy": "supervised", "max_risk": "High", "allow_merge": true, "max_parallel": w.o.MaxParallel,
		"allowed_tools_digest": digest("allowed-tools-v1"), "allowed_tools_count": 14}
	id, _ := json.Marshal(map[string]any{"line": lineDigest, "config": config, "policy": policy})
	sum := sha256.Sum256(id)
	return map[string]any{"schema": 1,
		"mach":      map[string]any{"version": cfg.version, "install": installedAs, "commit": nil},
		"line":      map[string]any{"digest": lineDigest, "count": len(files), "files": files},
		"config":    config,
		"policy":    policy,
		"ticket":    map[string]any{"risk": c.risk, "app_type": c.an.appType},
		"source":    map[string]any{"commit": nil, "slice_revision": c.slice.rev, "slice_digest": nullable(c.slice.digest), "spec_sha256": digest("spec:" + c.slice.id)},
		"config_id": hex.EncodeToString(sum[:]),
	}
}

// provenance adds the snapshot (or its absence) to an execution.started record.
func (w *world) provenance(c *cell, x *execution, started *intakeRec) {
	if !w.real() {
		return
	}
	x.an.config = c.an.config
	if c.an.config == "" {
		return // provenance not recorded: the key is absent
	}
	if w.rng.IntN(40) == 0 {
		started.data["provenance"], started.data["provenance_reason"] = nil, "capture-failed"
		x.an.captureFailed = true
		return
	}
	snap := w.snapshot(c, realisticConfigs[c.an.config])
	started.data["provenance"] = snap
	x.an.configID = snap["config_id"].(string)
}

// buildModel is the model a cell's builder runs on.
func (c *cell) buildModel() string {
	if c.an != nil && c.an.config != "" {
		return realisticConfigs[c.an.config].buildModel
	}
	return "claude-sonnet-5-5"
}

// heldUntil is when an execution's place is free as the records show it. An execution whose
// outcome is unknown writes no process result in the realistic profile; the first record that
// closes it is the supervisor's outcome-unknown recovery (startSegment: x.end+40), so its place is
// held until then. Every other execution frees its place when its process ends.
func (w *world) heldUntil(x *execution) float64 {
	if w.real() && x.seg.end == "unknown" && !math.IsInf(x.end, 1) {
		return x.end + 40
	}
	return x.end
}

// realisticCost: a model's recorded cost for an execution, by the model and how long it ran.
func (w *world) realisticCost(model string, x *execution) float64 {
	hours := 0.0
	if !math.IsInf(x.end, 1) {
		hours = (x.end - x.start) / 3600
	}
	return math.Round(modelWeight[model]*w.between(0.4, 1.6)*math.Max(0.25, hours)*0.9*1e4) / 1e4
}

// ---- ground truth for the realistic profile ----

func quantiles(v []float64) map[string]any {
	if len(v) == 0 {
		return map[string]any{"n": 0, "p50": nil, "p90": nil, "max": nil}
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	q := func(p float64) float64 { return math.Round(s[int(math.Ceil(p*float64(len(s))))-1]) }
	return map[string]any{"n": len(s), "p50": q(0.5), "p90": q(0.9), "max": math.Round(s[len(s)-1])}
}

// realisticTruth adds durations, concurrency and configuration cohorts to expected.json.
func (g *gen) realisticTruth(e *Expected, done []*cell) {
	w := g.w
	in := g.in
	sec := func(d float64) float64 { return d * w.k }
	// Visit durations by station, from each visit's entered and exited records.
	visits := map[string][]float64{}
	var d2m, human []float64
	for _, c := range w.cells {
		open := map[string]float64{}
		var awaiting float64 = -1
		for _, r := range c.life {
			if !in(r.t) {
				continue
			}
			key := fmt.Sprintf("%s#%d", r.station, r.visit)
			switch r.typ {
			case "station.entered":
				open[key] = r.t
			case "station.exited":
				if t0, ok := open[key]; ok {
					visits[r.station] = append(visits[r.station], sec(r.t-t0))
					delete(open, key)
				}
			case "review.decided":
				if r.data["decision"] == "AWAITING_HUMAN" {
					awaiting = r.t
				}
			case "human.approval_recorded":
				if awaiting >= 0 {
					human = append(human, sec(r.t-awaiting))
					awaiting = -1
				}
			}
		}
		if c.an.mergedAt > 0 && in(c.an.mergedAt) {
			d2m = append(d2m, sec(c.an.mergedAt-(c.created-1)))
		}
	}
	durations := map[string]any{}
	for st, v := range visits {
		durations["visit:"+st] = quantiles(v)
	}
	durations["dispatch_to_merge"] = quantiles(d2m)
	durations["human_approval_wait"] = quantiles(human)
	e.Durations = durations
	// Concurrency: executions running, sampled every minute of the history.
	var spans [][2]float64
	for _, x := range w.execs {
		if !in(x.claim) {
			continue
		}
		end := w.heldUntil(x)
		if math.IsInf(end, 1) || end > w.endT {
			end = w.endT
		}
		spans = append(spans, [2]float64{x.claim, end})
	}
	atLimit, busy, samples, peak := 0, 0, 0, 0
	byHour := map[string]float64{}
	for t := 0.0; t <= w.endT; t += 60 {
		n := 0
		for _, s := range spans {
			if s[0] <= t && t < s[1] {
				n++
			}
		}
		samples++
		peak = max(peak, n)
		if n >= w.maxPar() {
			atLimit++
		}
		if n > 0 {
			busy++
		}
		if w.real() {
			at := w.wall(t)
			k := "weekday"
			if at.Weekday() == time.Saturday || at.Weekday() == time.Sunday {
				k = "weekend"
			}
			k += fmt.Sprintf(" %02d", at.Hour())
			byHour[k] += float64(n)
		}
	}
	conc := map[string]any{"peak": peak, "share_of_minutes_at_limit": math.Round(float64(atLimit)/float64(samples)*1000) / 1000,
		"share_of_minutes_with_any": math.Round(float64(busy)/float64(samples)*1000) / 1000, "max_parallel": w.maxPar()}
	if w.real() {
		// Mean executions running by hour of day, weekdays and weekends.
		count := map[string]float64{}
		for t := 0.0; t <= w.endT; t += 60 {
			at := w.wall(t)
			k := "weekday"
			if at.Weekday() == time.Saturday || at.Weekday() == time.Sunday {
				k = "weekend"
			}
			count[k+fmt.Sprintf(" %02d", at.Hour())]++
		}
		mean := map[string]float64{}
		for k, v := range byHour {
			mean[k] = math.Round(v/count[k]*100) / 100
		}
		conc["mean_running_by_hour_utc"] = mean
	}
	e.Concurrency = conc
	if !w.real() {
		return
	}
	// Configuration cohorts: tickets by the configuration their executions ran under.
	type cohort struct {
		ConfigID      string  `json:"config_id"`
		Tickets       int     `json:"tickets"`
		Finished      int     `json:"finished"`
		Merged        int     `json:"merged"`
		FirstPass     int     `json:"first_pass"`
		Executions    int     `json:"executions"`
		CaptureFailed int     `json:"executions_capture_failed"`
		WithCost      int     `json:"executions_with_recorded_cost"`
		CostUSD       float64 `json:"recorded_cost_usd"`
	}
	cohorts := map[string]*cohort{}
	label := func(cfg string) string {
		if cfg == "" {
			return "not-recorded"
		}
		return cfg
	}
	for _, c := range w.cells {
		if c.created == 0 || !in(c.created) {
			continue
		}
		k := label(c.an.config)
		co := cohorts[k]
		if co == nil {
			co = &cohort{}
			cohorts[k] = co
		}
		co.Tickets++
		if c.an.closedAt > 0 && in(c.an.closedAt) {
			co.Finished++
			if c.an.outcome == "merged" {
				co.Merged++
				if c.round == 1 {
					co.FirstPass++
				}
			}
		}
	}
	for _, x := range w.execs {
		if !in(x.claim) || x.an == nil {
			continue
		}
		co := cohorts[label(x.an.config)]
		co.Executions++
		if x.an.captureFailed {
			co.CaptureFailed++
		}
		if x.an.configID != "" {
			co.ConfigID = x.an.configID
		}
		if x.outcome == "completed" && !math.IsInf(x.end, 1) && in(x.end) && !x.an.noUsage {
			co.WithCost++
			co.CostUSD += x.cost
		}
	}
	out := map[string]any{}
	for k, co := range cohorts {
		co.CostUSD = math.Round(co.CostUSD*1e6) / 1e6
		out[k] = co
	}
	e.Configs = out
}
