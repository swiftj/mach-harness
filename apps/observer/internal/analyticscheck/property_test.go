package analyticscheck

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/testkit"
)

// A property-style check over random small histories from this suite's own seeded generator: the
// analytics answers do not depend on (a) the order in which sources' records arrive within the
// lateness a writer can have, (b) duplicate delivery of intake lines, (c) ingestion split across
// an observer restart.

// piece is one write a MACH writer makes: a source, the time it is stamped, and the write itself.
type piece struct {
	src   string // the file it appends to (per-source order is kept)
	t     time.Time
	after string // a piece key that must be written first (the ledger before an execution's files)
	key   string
	write func(f *fx)
}

// gen builds a random history of 2 to 5 tickets as pieces in time order.
func gen(seed uint64) []piece {
	r := rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))
	var ps []piece
	add := func(p piece) { ps = append(ps, p) }
	dur := func(lo, hi int) time.Duration { return time.Duration(lo+r.IntN(hi-lo+1)) * time.Second }
	cost := func() float64 { return float64(1+r.IntN(12)) * 0.25 } // exact in binary
	tickets := 2 + r.IntN(4)
	waves := map[string]bool{}
	for i := 0; i < tickets; i++ {
		tk := fmt.Sprintf("T-%d", i+1)
		x := fmt.Sprintf("x%012x", 0xa0+i)
		s := T0.Add(time.Duration(r.IntN(6*3600)) * time.Second)
		risk := []string{"Low", "Medium", "High"}[r.IntN(3)]
		app := []string{"cli", "web", "api"}[r.IntN(3)]
		product := r.IntN(2) == 0
		slice, wave := fmt.Sprintf("SLICE-%03d", i+1), fmt.Sprintf("WAVE-%03d", i%2+1)
		if product {
			if !waves[wave] {
				waves[wave] = true
				wv := wave
				add(piece{src: "intake", t: T0.Add(-time.Hour), write: func(f *fx) {
					f.intake(L{At: T0.Add(-time.Hour), Type: "wave.discovered", Wave: wv, Source: "intake", Data: M{"slices": []string{}}})
				}})
			}
			t0, t1 := s, s.Add(dur(10, 120))
			add(piece{src: "intake", t: t0, write: func(f *fx) {
				f.slice(slice, tk, wave, 1)
				f.intake(L{At: t0, Type: "slice.materialized", Wave: wave, Slice: slice, Ticket: tk, Source: "intake", Data: M{"dependencies": []string{}}})
			}})
			add(piece{src: "intake", t: t1, write: func(f *fx) {
				f.intake(L{At: t1, Type: "work.scheduled", Wave: wave, Slice: slice, Ticket: tk, Data: M{"stage": "spec-ready", "risk": risk}})
			}})
		}
		life := "life:" + tk
		lp := func(at time.Time, recs ...R) {
			add(piece{src: life, t: at, write: func(f *fx) { f.lifecycle(tk, recs...) }})
		}
		c := s.Add(dur(150, 200))
		claimKey := "claim:" + x
		add(piece{src: "intake", t: c, key: claimKey, write: func(f *fx) {
			f.claimOnly(x, tk)
			f.intake(L{At: c, Type: "work.claimed", Ticket: tk, Exec: x, Data: M{"stage": "planned", "next": "build", "attempt": 1}},
				L{At: c.Add(sec), Type: "execution.started", Ticket: tk, Exec: x, Data: M{"until": "merge", "workflow": "mach-belt"}})
		}})
		ps0 := c.Add(5 * sec)
		add(piece{src: "started:" + x, t: ps0, after: claimKey, key: "started:" + x, write: func(f *fx) { f.exec(x, tk, ps0, time.Time{}, "", nil) }})
		// The line, visit by visit.
		now := s.Add(dur(20, 60))
		pin, pout := now, now.Add(dur(10, 60))
		lp(pin, planVisit(pin, pout, risk, app)[0])
		lp(pout, planVisit(pin, pout, risk, app)[1])
		now = ps0.Add(dur(5, 30))
		fate := r.IntN(10) // 0: failed execution, 1: unknown outcome, else completed
		round, merged := 1, false
		visitN := map[string]int{}
		step := func(station string, rnd int, outcome string, between ...R) {
			visitN[station]++
			in := now
			out := in.Add(dur(60, 1200))
			for i := range between {
				between[i].At = in.Add(time.Duration(i+1) * sec)
			}
			recs := visit(station, visitN[station], rnd, x, in, out, outcome, between...)
			if station == "build" && visitN["build"] > 1 {
				recs[0].Data["revision"] = visitN["build"]
			}
			lp(in, recs[:len(recs)-1]...)
			lp(out, recs[len(recs)-1])
			now = out.Add(dur(5, 60))
		}
		if fate == 0 || fate == 1 {
			// The execution ends during build: the visit stays without an exit.
			visitN["build"]++
			in := now
			lp(in, R{At: in, Type: "station.entered", Station: "build", Visit: 1, Round: 1, Exec: x, Data: M{"stage": "building"}})
			end := in.Add(dur(60, 600))
			if fate == 0 {
				add(piece{src: "result:" + x, t: end, after: "started:" + x, write: func(f *fx) {
					f.exec(x, tk, ps0, end, "exited", 1)
				}})
				add(piece{src: "intake", t: end.Add(10 * sec), write: func(f *fx) {
					f.intake(L{At: end.Add(10 * sec), Type: "execution.failed", Ticket: tk, Exec: x, Data: M{"stage": "building", "next": "build", "how": "exited", "exit_code": 1, "attempt": 1}})
				}})
			} else {
				add(piece{src: "intake", t: end.Add(20 * min_), write: func(f *fx) {
					f.intake(L{At: end.Add(20 * min_), Type: "recovery.started", Ticket: tk, Exec: x, Data: M{"kind": "outcome-unknown"}})
				}})
			}
			continue
		}
		for {
			step("build", round, "built", task(time.Time{}, "T1"))
			pass := r.IntN(10) >= 3
			status := "PASS"
			if !pass {
				status = "FAIL_WITH_EVIDENCE"
			}
			res := "pass"
			if !pass {
				res = "fail"
			}
			step("verify", round, status, check(time.Time{}, "AC-01", "scenario", res), verdict(time.Time{}, status))
			if !pass && round < 3 {
				round++
				continue
			}
			decision := "APPROVED"
			if r.IntN(10) < 2 && round < 3 {
				decision = "REJECTED"
			}
			votes := M{"general": map[bool]string{true: "APPROVE", false: "REJECT"}[decision == "APPROVED"]}
			step("review", round, decision, roundStarted(time.Time{}, round, risk, "general"), vote(time.Time{}, round, "general", votes["general"].(string), 0),
				decided(time.Time{}, round, decision, votes, false))
			if decision == "REJECTED" {
				round++
				continue
			}
			break
		}
		step("merge", 0, "merged", R{Type: "merge.completed", Data: M{"method": "local", "merge_commit": "fedcba987654"}})
		merged = true
		pe := now
		k := cost()
		add(piece{src: "stream:" + x, t: pe, after: "started:" + x, key: "stream:" + x, write: func(f *fx) {
			f.usage(x, pe, k, U{Model: "claude-sonnet-5-5", Cost: k, Input: 100, Output: 200, CacheRead: 300, CacheCreation: 400})
		}})
		// The wrapper writes result.json after the process exits, so after the stream's last line.
		add(piece{src: "result:" + x, t: pe, after: "stream:" + x, write: func(f *fx) { f.exec(x, tk, ps0, pe, "exited", 0) }})
		done := pe.Add(dur(5, 40))
		add(piece{src: "intake", t: done, write: func(f *fx) {
			f.intake(L{At: done, Type: "execution.completed", Ticket: tk, Exec: x, Data: M{"stage": "merged", "next": "cleanup", "cost_usd": k}})
		}})
		if product && merged {
			ig := done.Add(dur(10, 300))
			add(piece{src: "intake", t: ig, write: func(f *fx) {
				f.intake(L{At: ig, Type: "slice.integrated", Wave: wave, Slice: slice, Ticket: tk, Source: "intake", Data: M{"commit": "fedcba987654"}})
			}})
		}
		closed := done.Add(dur(60, 600))
		rounds, fp := round, round == 1
		add(piece{src: "runs", t: closed, write: func(f *fx) {
			f.run(tk, closed, M{"risk": risk, "app_type": app, "rounds": rounds, "first_pass": fp})
		}})
	}
	// Writers stamp and write in time order within each source.
	sort.SliceStable(ps, func(i, j int) bool { return ps[i].t.Before(ps[j].t) })
	return ps
}

// writeOrder is the order the pieces reach the disk when each is delayed by up to lateness after
// its stamp: a piece never overtakes an earlier piece of its own source, nor what it depends on.
func writeOrder(ps []piece, r *rand.Rand, lateness time.Duration) []piece {
	type keyed struct {
		p piece
		k time.Time
	}
	last := map[string]time.Time{}
	done := map[string]time.Time{}
	var ks []keyed
	for _, p := range ps {
		k := p.t.Add(time.Duration(r.Int64N(int64(lateness))))
		if l, ok := last[p.src]; ok && k.Before(l) {
			k = l
		}
		if d, ok := done[p.after]; p.after != "" && ok && k.Before(d) {
			k = d
		}
		last[p.src] = k
		if p.key != "" {
			done[p.key] = k
		}
		ks = append(ks, keyed{p, k})
	}
	sort.SliceStable(ks, func(i, j int) bool { return ks[i].k.Before(ks[j].k) })
	out := make([]piece, len(ks))
	for i, k := range ks {
		out[i] = k.p
	}
	return out
}

func writeAll(f *fx, ps []piece) {
	for _, p := range ps {
		p.write(f)
	}
}

func TestPropertyInvariance(t *testing.T) {
	seeds := []uint64{1, 2, 3, 5, 8, 13, 21, 34}
	if testing.Short() || testkit.Race {
		seeds = seeds[:3]
	}
	for _, seed := range seeds {
		t.Run(fmt.Sprintf("seed-%d", seed), func(t *testing.T) {
			ps := gen(seed)
			base := newFx(t)
			writeAll(base, ps)
			want := answers(t, observe(base))
			if !strings.Contains(want[analyticsPaths[0]], `"id":"C1"`) {
				t.Fatal("no answers")
			}

			// (a) Arrival order within the lateness a writer can have (up to 30 minutes), read by an
			// observer that ticks at random points of the writing.
			r := rand.New(rand.NewPCG(seed, 7))
			late := newFx(t)
			o := observe(late)
			for i, p := range writeOrder(ps, r, 30*min_) {
				p.write(late)
				if i%(1+r.IntN(4)) == 0 {
					o.sync()
				}
			}
			o.sync()
			sameAnswers(t, "(a) arrival order", want, answers(t, o))

			// (b) Every intake line delivered twice (an identical rewrite).
			dup := newFx(t)
			writeAll(dup, ps)
			b, _ := os.ReadFile(testkit.LedgerPath(dup.root))
			var doubled []byte
			for _, line := range strings.SplitAfter(string(b), "\n") {
				doubled = append(doubled, line...)
				doubled = append(doubled, line...)
			}
			testkit.WriteFile(t, testkit.LedgerPath(dup.root), doubled)
			sameAnswers(t, "(b) duplicate intake lines", want, answers(t, observe(dup)))

			// (c) Ingestion split across a restart: half the history, a restart over the same index,
			// then the rest.
			split := newFx(t)
			index := t.TempDir()
			half := len(ps) / 2
			writeAll(split, ps[:half])
			first := open(t, split.root, index)
			first.close()
			writeAll(split, ps[half:])
			sameAnswers(t, "(c) split across a restart", want, answers(t, open(t, split.root, index)))
		})
	}
}

// TestGeneratorShapes keeps the generator honest: across the seeds it produces every fate it
// claims (failed, unknown, rejected, revised, product and hand-driven tickets).
func TestGeneratorShapes(t *testing.T) {
	seen := map[string]bool{}
	for _, seed := range []uint64{1, 2, 3, 5, 8, 13, 21, 34} {
		f := newFx(t)
		writeAll(f, gen(seed))
		b, _ := os.ReadFile(testkit.LedgerPath(f.root))
		for _, k := range []string{"execution.failed", "outcome-unknown", "slice.integrated", "execution.completed"} {
			if strings.Contains(string(b), k) {
				seen[k] = true
			}
		}
		filepath.Walk(filepath.Join(f.root, ".factory", "worktrees"), func(p string, info os.FileInfo, err error) error {
			if strings.HasSuffix(p, "lifecycle.jsonl") {
				data, _ := os.ReadFile(p)
				for _, k := range []string{"REJECTED", "FAIL_WITH_EVIDENCE", `"revision":2`} {
					if strings.Contains(string(data), k) {
						seen[k] = true
					}
				}
			}
			return nil
		})
		_ = json.Valid
	}
	for _, k := range []string{"execution.failed", "outcome-unknown", "slice.integrated", "execution.completed", "REJECTED", "FAIL_WITH_EVIDENCE", `"revision":2`} {
		if !seen[k] {
			t.Errorf("the generator never produced %s", k)
		}
	}
}
