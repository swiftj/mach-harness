package analyticscheck

import (
	"time"
)

// Reusable pieces of history. Each writes what MACH's own writers write for one step.

const (
	X1 = "x00000000000a"
	X2 = "x00000000000b"
	X3 = "x00000000000c"
	X4 = "x00000000000d"
	X5 = "x00000000000e"
	X6 = "x00000000000f"
)

// product files a wave, its slice and ticket, and the dispatch: wave.discovered at w,
// slice.materialized at w+10s (no dependencies), work.scheduled at sched.
func (f *fx) product(wave, slice, ticket string, w, sched time.Time, risk string) {
	f.slice(slice, ticket, wave, 1)
	f.intake(
		L{At: w, Type: "wave.discovered", Wave: wave, Source: "intake", Data: M{"slices": []string{slice}}},
		L{At: w.Add(10 * sec), Type: "slice.materialized", Wave: wave, Slice: slice, Ticket: ticket, Source: "intake", Data: M{"dependencies": []string{}}},
		L{At: sched, Type: "work.scheduled", Wave: wave, Slice: slice, Ticket: ticket, Data: M{"stage": "spec-ready", "risk": risk}},
	)
}

// visit writes a station's entry and exit (and any records between them).
func visit(station string, n, round int, x string, in, out time.Time, outcome string, between ...R) []R {
	recs := []R{{At: in, Type: "station.entered", Station: station, Visit: n, Round: round, Exec: x, Data: M{"stage": station}}}
	for _, r := range between {
		r.Station, r.Visit, r.Round, r.Exec = station, n, round, x
		recs = append(recs, r)
	}
	if !out.IsZero() {
		recs = append(recs, R{At: out, Type: "station.exited", Station: station, Visit: n, Round: round, Exec: x, Data: M{"outcome": outcome, "stage": station}})
	}
	return recs
}

// planVisit is a plan visit whose exit records the risk and app type (revision 2).
func planVisit(in, out time.Time, risk, app string) []R {
	return []R{
		{At: in, Type: "station.entered", Station: "plan", Visit: 1, Data: M{"stage": "spec-ready"}},
		{At: out, Type: "station.exited", Station: "plan", Visit: 1, Data: M{"outcome": "planned", "stage": "planned", "risk": risk, "app_type": app,
			"counts": M{"tasks": 2, "contracts": 0}}},
	}
}

func task(at time.Time, id string) R {
	return R{At: at, Type: "build.task_completed", Data: M{"task": id, "kind": "test", "step": "red", "first_run": "fail", "suite": "fail", "commit": "0123456789ab"}}
}

func verdict(at time.Time, status string) R {
	outcome := "pass"
	if status != "PASS" {
		outcome = "refuse"
	}
	return R{At: at, Type: "gate.evaluated", Data: M{"gate": "verify.verdict", "outcome": outcome, "reason_code": status}}
}

func check(at time.Time, item, kind, result string) R {
	return R{At: at, Type: "verify.check_recorded", Data: M{"item": item, "kind": kind, "result": result, "evidence": []any{}}}
}

func roundStarted(at time.Time, round int, risk string, seats ...string) R {
	models := M{}
	for _, s := range seats {
		models[s] = "claude-sonnet-5-5"
	}
	return R{At: at, Type: "review.round_started", Data: M{"round": round, "max_rounds": 3, "risk": risk, "tuning": false, "seats": seats,
		"models": models, "approvals_needed": 2, "human_approval_required": false, "delta": round > 1}}
}

func vote(at time.Time, round int, seat, v string, blockers int) R {
	return R{At: at, Type: "review.verdict_submitted", Data: M{"round": round, "seat": seat, "vote": v, "blockers": blockers, "notes": 0, "rules": []string{}}}
}

func decided(at time.Time, round int, decision string, votes M, veto bool) R {
	appr := 0
	for _, v := range votes {
		if v == "APPROVE" {
			appr++
		}
	}
	return R{At: at, Type: "review.decided", Data: M{"round": round, "decision": decision, "approvals": appr, "needed": 2, "votes": votes,
		"blockers": 0, "security_veto": veto, "human_approval_required": decision == "AWAITING_HUMAN"}}
}

// happyCell writes one ticket's whole successful pass through the line, starting at s (an offset
// from T0), with execution x: plan 30 s, build 600 s (2 tasks), verify 360 s (PASS), review 540 s
// (APPROVED, three seats), merge 90 s. It returns the merge time.
//
//	plan    s+1m10s .. s+1m40s          =  30,000 ms
//	build   s+3m    .. s+13m            = 600,000 ms
//	verify  s+14m   .. s+20m            = 360,000 ms
//	review  s+21m   .. s+30m            = 540,000 ms
//	merge   s+31m   .. s+32m30s         =  90,000 ms (merge.completed at s+32m)
func (f *fx) happyCell(ticket, x string, s time.Duration, risk, app string) time.Time {
	b := T0.Add(s)
	recs := planVisit(b.Add(70*sec), b.Add(100*sec), risk, app)
	recs = append(recs, visit("build", 1, 1, x, b.Add(3*min_), b.Add(13*min_), "built", task(b.Add(5*min_), "T1"), task(b.Add(10*min_), "T2"))...)
	recs = append(recs, visit("verify", 1, 1, x, b.Add(14*min_), b.Add(20*min_), "PASS", check(b.Add(16*min_), "AC-01", "scenario", "pass"),
		verdict(b.Add(19*min_), "PASS"))...)
	recs = append(recs, visit("review", 1, 1, x, b.Add(21*min_), b.Add(30*min_), "APPROVED", roundStarted(b.Add(21*min_+sec), 1, risk, "architecture", "security", "product"),
		vote(b.Add(25*min_), 1, "architecture", "APPROVE", 0), vote(b.Add(26*min_), 1, "security", "APPROVE", 0), vote(b.Add(27*min_), 1, "product", "APPROVE", 0),
		decided(b.Add(29*min_), 1, "APPROVED", M{"architecture": "APPROVE", "security": "APPROVE", "product": "APPROVE"}, false))...)
	recs = append(recs, visit("merge", 1, 0, x, b.Add(31*min_), b.Add(32*min_+30*sec), "merged",
		R{At: b.Add(32 * min_), Type: "merge.completed", Data: M{"method": "local", "approved_commit": "0123456789ab", "landed_commit": "0123456789ab",
			"merge_commit": "fedcba987654", "revalidated": false, "pull_request": nil}})...)
	f.lifecycle(ticket, recs...)
	return b.Add(32 * min_)
}

// supervised writes a claim, a start, the process records and the supervisor's completion for x:
// claim at c, execution.started at c+1s, process c+5s .. pe, execution.completed at done.
func (f *fx) supervised(ticket, x string, c, pe, done time.Time, cost any) {
	f.exec(x, ticket, c.Add(5*sec), pe, "exited", 0)
	data := M{"stage": "merged", "next": "cleanup", "how": "exited", "seen_to_end": true, "refused_tools": []string{}}
	if cost != nil {
		data["cost_usd"] = cost
	}
	f.intake(
		L{At: c, Type: "work.claimed", Ticket: ticket, Exec: x, Data: M{"stage": "planned", "next": "build", "attempt": 1}},
		L{At: c.Add(sec), Type: "execution.started", Ticket: ticket, Exec: x, Data: M{"until": "merge", "workflow": "mach-belt"}},
	)
	if !done.IsZero() {
		f.intake(L{At: done, Type: "execution.completed", Ticket: ticket, Exec: x, Data: data})
	}
}
