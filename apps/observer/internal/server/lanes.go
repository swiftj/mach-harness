package server

import (
	"mach/observer/internal/artifact"
	"mach/observer/internal/project"
)

// Lanes (M22): GET /api/v1/cells/{ticket} gains "lanes" for a build in lanes, read from the cell's
// own files (artifact.ReadLanes) and joined with the build gates the lifecycle log recorded about
// them. A cell whose build has no lanes gets no "lanes" key: its reply is exactly as before.

// lanesGateNames are the build gates about lanes (build.py lanes-open and join).
var lanesGateNames = map[string]bool{"build.lanes-open": true, "build.join": true}

// maxLanesGates bounds the gates served with the lanes (the latest are kept).
const maxLanesGates = 50

// lanesExpected reports whether a cell's events show a build in lanes: a task built in a lane, or a
// lanes gate. Then a build.json that cannot be read is reported rather than left out.
func lanesExpected(c *project.Cell) bool {
	for _, k := range c.Tasks {
		if k.Lane != "" {
			return true
		}
	}
	for _, g := range c.Gates {
		if lanesGateNames[g.Gate] {
			return true
		}
	}
	return false
}

// lanesGate is one evaluation of a lanes gate, as the lifecycle log recorded it.
type lanesGate struct {
	Gate       string            `json:"gate"`
	Verdict    string            `json:"verdict"`
	ReasonCode *string           `json:"reason_code"`
	Lane       *string           `json:"lane"`
	At         *project.TimeView `json:"at"`
}

// lanesReply is the served "lanes": the files' account and the gates.
type lanesReply struct {
	*artifact.Lanes
	Gates []lanesGate `json:"gates"`
}

func lanesOf(ln *artifact.Lanes, c *project.Cell) lanesReply {
	out := lanesReply{Lanes: ln, Gates: []lanesGate{}}
	if c == nil {
		return out
	}
	for _, g := range c.Gates {
		if !lanesGateNames[g.Gate] {
			continue
		}
		item := lanesGate{Gate: g.Gate, Verdict: g.Verdict, At: project.TV(g.At)}
		if g.ReasonCode != "" {
			rc := g.ReasonCode
			item.ReasonCode = &rc
		}
		if g.Lane != "" {
			l := g.Lane
			item.Lane = &l
		}
		out.Gates = append(out.Gates, item)
	}
	if n := len(out.Gates); n > maxLanesGates {
		out.Gates = out.Gates[n-maxLanesGates:]
	}
	return out
}

// cellLanes reads a ticket's lanes outside the projection's lock: the files are read first, the
// reply is put together under the lock.
func (s *Server) cellLanes(ticket string) *artifact.Lanes {
	expected := false
	s.opts.Projector.View(func(st *project.State) {
		if c := st.Cells[ticket]; c != nil {
			expected = lanesExpected(c)
		}
	})
	if s.opts.Root == "" {
		return nil
	}
	return artifact.ReadLanes(s.opts.Root, ticket, expected)
}
