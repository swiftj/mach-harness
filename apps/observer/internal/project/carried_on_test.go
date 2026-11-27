package project

import "testing"

// A ticket stopped after its third round keeps round 3 and no limit of its own. A person's carry-on
// (the build station's station.exited "carried-on-by-person") sets the limit it records (one more
// round: 4); a person starting the Factory ("rounds-reset" or a person-start carry-on) sets the rounds
// that no longer count. The recorded round stays the round's own number; each record is listed.
func TestACarryOnSetsTheLimitAndTheBase(t *testing.T) {
	s := project(
		lc("station.entered", 1000, "T-6", "build#4", 3).Data(map[string]any{"station": "build", "stage": "blocked", "action": "revise"}),
		lc("station.exited", 1100, "T-6", "build#4", 3).Data(map[string]any{"station": "build", "outcome": "escalated", "stage": "blocked"}),
	)
	c := s.Cells["T-6"]
	if c == nil || c.Round == nil || *c.Round != 3 || c.RoundMax != nil || c.RoundBase != nil || len(c.CarriedOn) != 0 {
		t.Fatalf("stopped: %+v", c)
	}
	s = project(
		lc("station.entered", 1000, "T-6", "build#4", 3).Data(map[string]any{"station": "build", "stage": "blocked", "action": "revise"}),
		lc("station.exited", 1100, "T-6", "build#4", 3).Data(map[string]any{"station": "build", "outcome": "escalated", "stage": "blocked"}),
		lc("station.exited", 5000, "T-6", "build#4", 3).Data(map[string]any{"station": "build", "outcome": "carried-on-by-person", "stage": "built",
			"carried_on": map[string]any{"outcome": "carried-on-by-person", "round": 4, "max": 4, "number": 4, "base": 0, "by": "person-decision", "stopped_at": "verify"}}),
		lc("station.entered", 6000, "T-6", "build#5", 4).Data(map[string]any{"station": "build", "stage": "building", "action": "revise"}),
		lc("station.exited", 9000, "T-6", "build#5", 4).Data(map[string]any{"station": "build", "outcome": "rounds-reset", "stage": "building",
			"carried_on": map[string]any{"outcome": "rounds-reset", "round": 1, "max": 3, "number": 4, "base": 3, "by": "person-start"}}),
	)
	c = s.Cells["T-6"]
	if *c.Round != 4 || c.RoundMax == nil || *c.RoundMax != 3 || c.RoundBase == nil || *c.RoundBase != 3 || len(c.CarriedOn) != 2 {
		t.Fatalf("carried on: round %v max %v base %v %+v", c.Round, c.RoundMax, c.RoundBase, c.CarriedOn)
	}
	if a, b := c.CarriedOn[0], c.CarriedOn[1]; a.Outcome != "carried-on-by-person" || *a.Round != 4 || *a.Max != 4 || a.By != "person-decision" || a.StoppedAt != "verify" || a.At == nil ||
		b.Outcome != "rounds-reset" || *b.Round != 1 || *b.Base != 3 || b.By != "person-start" {
		t.Fatalf("%+v %+v", a, b)
	}
}
