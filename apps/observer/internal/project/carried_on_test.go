package project

import "testing"

// A ticket stopped after its third round keeps round 3 and no limit of its own; a person's carry-on
// sets the round and the limit it records (one more round: 4 of 4), and a fresh allowance from a person
// starting the Factory sets them again (1 of 3). Each carry-on is listed with when and by whom.
func TestACarryOnSetsTheRoundAndTheLimit(t *testing.T) {
	s := project(
		lc("station.entered", 1000, "T-6", "build#4", 3).Data(map[string]any{"station": "build", "stage": "blocked", "action": "revise"}),
		lc("station.exited", 1100, "T-6", "build#4", 3).Data(map[string]any{"station": "build", "outcome": "escalated", "stage": "blocked"}),
	)
	c := s.Cells["T-6"]
	if c == nil || c.Round == nil || *c.Round != 3 || c.RoundMax != nil || len(c.CarriedOn) != 0 {
		t.Fatalf("stopped: %+v", c)
	}
	s = project(
		lc("station.entered", 1000, "T-6", "build#4", 3).Data(map[string]any{"station": "build", "stage": "blocked", "action": "revise"}),
		lc("station.exited", 1100, "T-6", "build#4", 3).Data(map[string]any{"station": "build", "outcome": "escalated", "stage": "blocked"}),
		lc("station.entered", 5000, "T-6", "build#5", 3).Data(map[string]any{"station": "build", "stage": "building", "action": "revise",
			"carried_on": map[string]any{"round": 4, "max": 4, "by": "person-decision"}}),
		lc("station.entered", 9000, "T-6", "build#6", 4).Data(map[string]any{"station": "build", "stage": "building", "action": "revise",
			"carried_on": map[string]any{"round": 1, "max": 3, "by": "person-start"}}),
	)
	c = s.Cells["T-6"]
	if *c.Round != 1 || c.RoundMax == nil || *c.RoundMax != 3 || len(c.CarriedOn) != 2 {
		t.Fatalf("carried on: round %v max %v %+v", c.Round, c.RoundMax, c.CarriedOn)
	}
	if a, b := c.CarriedOn[0], c.CarriedOn[1]; *a.Round != 4 || *a.Max != 4 || a.By != "person-decision" || a.At == nil || *b.Round != 1 || *b.Max != 3 || b.By != "person-start" {
		t.Fatalf("%+v %+v", a, b)
	}
}
