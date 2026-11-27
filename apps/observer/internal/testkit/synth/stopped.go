package synth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"

	"mach/observer/internal/testkit"
)

// Stopped: tickets stopped for a person after their last judging round, and carried on, so the
// Factory Floor's stopped panel, its rounds and its carry-on can be seen and tested (Options.Stopped):
//
//   - SYN-STOP1: verification failed in rounds 1, 2 and 3 (AC-03 each time, AC-05 in round 3), the
//     build station refused a fourth round (round-limit) and stopped it: stage blocked, round 3 of 3,
//     sent back 3 times, a findings file for each round;
//   - SYN-STOP2: the same three failed rounds, then a person carried it on with a fix (the build
//     station's carried-on-by-person record, by "person-decision": round 4 of 4), and it is building;
//   - SYN-STOP3: the same three failed rounds, then a person started the Factory, which gave it a fresh
//     set of rounds (by "person-start": round 1 of 3), verification failed once more in that round, and
//     it is building again in round 2 of 3: sent back 4 times across both sets.
//
// The carry-on record's shape is the one the build station writes (skills/intent/scripts/rounds.py): a
// station.exited with the outcome "carried-on-by-person", who gave it, the round a person reads and its
// limit (max_rounds), the round's own number and the rounds that no longer count. Every other record
// is one a station writes, in its own shape. Off by default, so every recorded history stays as it was.

const (
	stopTicket     = "SYN-STOP1"
	carriedTicket  = "SYN-STOP2"
	freshTicket    = "SYN-STOP3"
	stopFindingsAt = "verification-findings-%d.md"
)

func (w *world) stoppedOn() bool { return w.o.Stopped && w.an == nil }

// threeFailedRounds is a ticket's history up to its third failed verification, from `from` (a fraction
// of the history), each round its own build and verify visit.
func threeFailedRounds(from float64) []m15Rec {
	in := func(f float64, station string, visit, round int, data map[string]any) m15Rec {
		return m15Rec{f, "station.entered", station, visit, round, data}
	}
	out := func(f float64, station string, visit, round int, outcome, stage string) m15Rec {
		return m15Rec{f, "station.exited", station, visit, round, map[string]any{"outcome": outcome, "stage": stage}}
	}
	gate := func(f float64, station string, visit, round int, name, outcome string, code any) m15Rec {
		return m15Rec{f, "gate.evaluated", station, visit, round, map[string]any{"gate": name, "outcome": outcome, "reason_code": code, "overridden_by_reason": false}}
	}
	check := func(f float64, visit, round int, item, result string) m15Rec {
		return m15Rec{f, "verify.check_recorded", "verify", visit, round, map[string]any{"item": item, "kind": "scenario", "result": result, "evidence": []any{}}}
	}
	step := 0.004
	at := func(i int) float64 { return from + float64(i)*step }
	recs := []m15Rec{
		in(at(0), "groom", 1, 0, map[string]any{"stage": "interview"}), gate(at(1), "groom", 1, 0, "groom.finalize", "pass", nil), out(at(2), "groom", 1, 0, "spec-ready", "spec-ready"),
		in(at(3), "plan", 1, 0, map[string]any{"stage": "spec-ready"}), gate(at(4), "plan", 1, 0, "plan.check", "pass", nil),
		{at(5), "station.exited", "plan", 1, 0, map[string]any{"outcome": "planned", "stage": "planned", "app_type": "web", "risk": "Medium", "contracts": 1, "tasks": 2}},
	}
	i := 6
	for round := 1; round <= 3; round++ {
		build := map[string]any{"stage": "building"}
		if round > 1 {
			build["revision"] = round - 1
			build["findings_copied"] = true
		}
		recs = append(recs, in(at(i), "build", round, round, build), out(at(i+1), "build", round, round, "built", "built"),
			in(at(i+2), "verify", round, round, map[string]any{"stage": "built"}))
		for _, item := range []string{"AC-01", "AC-02", "AC-04"} {
			recs = append(recs, check(at(i+2)+0.0005, round, round, item, "pass"))
		}
		recs = append(recs, check(at(i+2)+0.001, round, round, "AC-03", "fail"))
		if round == 3 {
			recs = append(recs, check(at(i+2)+0.0012, round, round, "AC-05", "fail"))
		} else {
			recs = append(recs, check(at(i+2)+0.0012, round, round, "AC-05", "pass"))
		}
		recs = append(recs, gate(at(i+3), "verify", round, round, "verify.verdict", "refuse", "FAIL_WITH_EVIDENCE"),
			out(at(i+3)+0.0005, "verify", round, round, "FAIL_WITH_EVIDENCE", "built"))
		i += 4
	}
	return recs
}

// escalation is the build station refusing a fourth round: round-limit, then the blocked visit.
func escalation(f float64) []m15Rec {
	return []m15Rec{
		{f, "gate.evaluated", "build", 4, 3, map[string]any{"gate": "round-limit", "outcome": "refuse", "reason_code": "round-limit", "overridden_by_reason": false, "rounds": 3}},
		{f + 0.0002, "station.entered", "build", 4, 3, map[string]any{"stage": "blocked", "revision": 3}},
		{f + 0.0004, "station.exited", "build", 4, 3, map[string]any{"outcome": "escalated", "stage": "blocked"}},
	}
}

// carriedOn is the build station's record of a person carrying a stopped ticket on (rounds.py): a
// station.exited of the build station, judged round 3 (build.json's loop + 1), with the round a person
// reads, its limit, the round's own number and the rounds that no longer count. The revision that
// follows is a build visit of its own, its round the round's own number.
func carriedOn(f float64, shown, max, number, base int, by string) []m15Rec {
	return []m15Rec{
		{f, "station.exited", "build", 4, 3, map[string]any{"outcome": "carried-on-by-person", "by": by, "stage": "built", "round": shown, "max_rounds": max,
			"round_number": number, "rounds_base": base, "extra_rounds": max - 3, "stopped_at": "verify", "guidance": by == "person-decision", "via": "floor"}},
		{f + 0.002, "station.entered", "build", 5, number, map[string]any{"stage": "building", "revision": number - 1, "findings_copied": true}},
	}
}

// stoppedFindings is the findings file a failed verification round writes (verify.py's shape, abridged).
func stoppedFindings(ticket string, round int) []byte {
	failed := "- AC-03: Overdue invoices are listed. Observed: an invoice due today is listed as overdue."
	if round == 3 {
		failed += "\n- AC-05: The total is shown in the customer's currency. Observed: the total is shown in dollars for a customer billed in euros."
	}
	return []byte(fmt.Sprintf("# Verification findings: %s, round %d\n\nResult: FAIL_WITH_EVIDENCE\n\n%s\n", ticket, round, failed))
}

// writeStopped writes the three stopped and carried-on cells (live folders).
func (g *gen) writeStopped() error {
	w := g.w
	if !w.stoppedOn() {
		return nil
	}
	stop := append(threeFailedRounds(0.86), escalation(0.94)...)
	// One more round by a person's decision: round 4 of 4 (its own number 4, nothing set aside).
	carried := append(append(threeFailedRounds(0.80), escalation(0.88)...), carriedOn(0.95, 4, 4, 4, 0, "person-decision")...)
	// A fresh set by a person starting the Factory: rounds 1 to 3 no longer count, round 4 reads 1 of 3; it
	// fails verification and round 5 reads 2 of 3.
	fresh := append(append(threeFailedRounds(0.70), escalation(0.78)...), carriedOn(0.90, 1, 3, 4, 3, "person-start")...)
	fresh = append(fresh,
		m15Rec{0.9025, "station.exited", "build", 5, 4, map[string]any{"outcome": "built", "stage": "built"}},
		m15Rec{0.903, "station.entered", "verify", 4, 4, map[string]any{"stage": "built"}},
		m15Rec{0.904, "verify.check_recorded", "verify", 4, 4, map[string]any{"item": "AC-03", "kind": "scenario", "result": "pass", "evidence": []any{}}},
		m15Rec{0.9045, "verify.check_recorded", "verify", 4, 4, map[string]any{"item": "AC-05", "kind": "scenario", "result": "fail", "evidence": []any{}}},
		m15Rec{0.905, "gate.evaluated", "verify", 4, 4, map[string]any{"gate": "verify.verdict", "outcome": "refuse", "reason_code": "FAIL_WITH_EVIDENCE", "overridden_by_reason": false}},
		m15Rec{0.9052, "station.exited", "verify", 4, 4, map[string]any{"outcome": "FAIL_WITH_EVIDENCE", "stage": "built"}},
		m15Rec{0.906, "station.entered", "build", 6, 5, map[string]any{"stage": "building", "revision": 4, "findings_copied": true}},
	)
	cells := []struct {
		ticket, stage, slice string
		loop                 int
		recs                 []m15Rec
	}{
		{stopTicket, "blocked", "SLICE-095", 2, stop},
		{carriedTicket, "building", "SLICE-096", 3, carried},
		{freshTicket, "building", "SLICE-097", 4, fresh},
	}
	for _, c := range cells {
		var log bytes.Buffer
		for i, r := range c.recs {
			log.Write(testkit.Record{Seq: i + 1, At: isoMS(w.ms(w.endT * r.f)), Ticket: c.ticket, Type: r.typ, Station: r.station, Visit: r.visit,
				Round: r.round, Data: r.data}.Line())
			g.cnt.add("cell-lifecycle", r.typ, 1)
		}
		info := map[string]any{"ticket_id": c.ticket, "stage": c.stage, "created_at": isoS(w.ms(w.endT * c.recs[0].f)), "round": 1, "mode": "headless",
			"risk_tier": "Medium", "app_type": "web", "slice_id": c.slice, "title": "Overdue invoices", "product": map[string]any{"slice_id": c.slice, "epic_id": "EPIC-001", "source": "folder", "revision": 1},
			"synthetic": true}
		cellJSON, _ := json.MarshalIndent(info, "", "  ")
		dir := g.path(".factory", "worktrees", c.ticket)
		if err := g.put(filepath.Join(dir, "cell.json"), append(cellJSON, '\n')); err != nil {
			return err
		}
		build, _ := json.MarshalIndent(map[string]any{"loop": c.loop, "tasks": []any{}}, "", "  ")
		if err := g.put(filepath.Join(dir, "build.json"), append(build, '\n')); err != nil {
			return err
		}
		for round := 1; round <= 3; round++ {
			if err := g.put(filepath.Join(dir, fmt.Sprintf(stopFindingsAt, round)), stoppedFindings(c.ticket, round)); err != nil {
				return err
			}
		}
		if err := g.put(filepath.Join(dir, "lifecycle.jsonl"), log.Bytes()); err != nil {
			return err
		}
	}
	w.feature["stopped_ticket"] = stopTicket
	w.feature["carried_on_ticket"] = carriedTicket
	w.feature["fresh_rounds_ticket"] = freshTicket
	return nil
}
