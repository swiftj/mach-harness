package project

import (
	"sort"
	"strings"

	"mach/observer/internal/feed"
)

// Per source class: how many events the projection applied and the time of the newest, kept per
// UTC hour so a reply "as of" a time can say what had arrived by then (the analytics envelope's
// history.sources). Folded as each event is applied (State.noteSource), so a reply reads a few
// hundred cells at most.

// Source classes, in display order.
var SourceClasses = []string{"intake", "lifecycle", "stream", "runs"}

const (
	sourceHourMS   = int64(3_600_000)
	maxSourceHours = 24 * 400 // hours kept per class; older ones are merged into Before
)

// SourceTally is one class's events, by hour.
type SourceTally struct {
	Events int64 `json:"events"`
	LastMS int64 `json:"last_ms"`
	// Hours: hour start (by order time) -> [events, newest order time, newest recorded time].
	Hours map[int64][3]int64 `json:"hours"`
	// Before merges the hours no longer kept (oldest first), the same three numbers.
	Before [3]int64 `json:"before"`
}

// sourceClass maps a stream to its class ("" for the observer's own events).
func sourceClass(stream string) string {
	switch stream {
	case "intake-log":
		return "intake"
	case "cell-lifecycle":
		return "lifecycle"
	case "execution-stream", "execution-record":
		return "stream"
	case "run-record":
		return "runs"
	}
	return ""
}

// SourceClassOfKey maps an ingest source key to its class: the ingest's own keys (ledger, runs,
// cell/<ticket>, archive/<ticket>, exec/<execution>, stream/<execution>) and the event origin keys
// (i:..., c:..., x:..., s:..., r:...). "" for anything else.
func SourceClassOfKey(key string) string {
	switch {
	case key == "ledger":
		return "intake"
	case key == "runs":
		return "runs"
	case strings.HasPrefix(key, "cell/"), strings.HasPrefix(key, "archive/"):
		return "lifecycle"
	case strings.HasPrefix(key, "exec/"), strings.HasPrefix(key, "stream/"):
		return "stream"
	}
	prefix, _, _ := strings.Cut(key, ":")
	switch prefix {
	case "i":
		return "intake"
	case "c":
		return "lifecycle"
	case "s", "x":
		return "stream"
	case "r":
		return "runs"
	}
	return ""
}

// noteSource folds one applied event into its class's tally.
func (s *State) noteSource(e *feed.Event, st *Stamp) {
	class := sourceClass(e.Origin.Stream)
	if class == "" {
		return
	}
	if s.Sources == nil {
		s.Sources = map[string]*SourceTally{}
	}
	t := s.Sources[class]
	if t == nil {
		t = &SourceTally{Hours: map[int64][3]int64{}}
		s.Sources[class] = t
	}
	// Placed by order time, as as_of_ms compares. The newest event time is its recorded time; an
	// event placed only by when it was read (precision arrival or unknown) adds to the count but not
	// to that time, which would otherwise depend on when the observer happened to read it.
	ms := st.OrderMS
	at := int64(0)
	if st.Precision != "arrival" && st.Precision != "unknown" {
		at = stampMS(st)
	}
	t.Events++
	t.LastMS = max(t.LastMS, at)
	h := ms - ((ms%sourceHourMS)+sourceHourMS)%sourceHourMS
	cell := t.Hours[h]
	cell[0]++
	cell[1] = max(cell[1], ms)
	cell[2] = max(cell[2], at)
	t.Hours[h] = cell
	if len(t.Hours) > maxSourceHours {
		oldest := int64(1) << 62
		for k := range t.Hours {
			oldest = min(oldest, k)
		}
		c := t.Hours[oldest]
		t.Before[0] += c[0]
		t.Before[1] = max(t.Before[1], c[1])
		t.Before[2] = max(t.Before[2], c[2])
		delete(t.Hours, oldest)
	}
}

// SourceFact is one class as the envelope serves it.
type SourceFact struct {
	Source      string `json:"source"`
	LastEventMS *int64 `json:"last_event_ms"`
	Events      *int64 `json:"events"`
	LastReadMS  *int64 `json:"last_read_ms"`
	// Precision: "hour" when as_of_ms falls inside an hour that also holds later events: events
	// and last_event_ms then count only the whole hours before it.
	Precision string `json:"precision,omitempty"`
	// Reason codes when a value is null: no-events, no-recorded-time (placed only when read),
	// not-tracked (a projection saved before
	// sources were tallied), not-read (the ingest has not read this class).
	Reason []string `json:"reason,omitempty"`
}

// SourceFacts are the classes' facts at the state's position, as of asOf when given.
func SourceFacts(s *State, asOf *int64) []SourceFact {
	out := make([]SourceFact, 0, len(SourceClasses))
	for _, class := range SourceClasses {
		f := SourceFact{Source: class}
		t := s.Sources[class]
		switch {
		case s.Sources == nil:
			f.Reason = append(f.Reason, "not-tracked")
		case t == nil || t.Events == 0:
			zero := int64(0)
			f.Events = &zero
			f.Reason = append(f.Reason, "no-events")
		case asOf == nil || lastOrder(t) <= *asOf:
			f.Events = ptr(t.Events)
			if t.LastMS > 0 {
				f.LastEventMS = ptr(t.LastMS)
			} else {
				f.Reason = append(f.Reason, "no-recorded-time")
			}
		default:
			n, last := int64(0), int64(0)
			if t.Before[0] > 0 {
				if t.Before[1] <= *asOf {
					n, last = t.Before[0], t.Before[2]
				} else {
					f.Precision = "hour" // the merged oldest hours also hold later events
				}
			}
			hours := make([]int64, 0, len(t.Hours))
			for h := range t.Hours {
				hours = append(hours, h)
			}
			sort.Slice(hours, func(i, j int) bool { return hours[i] < hours[j] })
			for _, h := range hours {
				c := t.Hours[h]
				if h > *asOf {
					break
				}
				if c[1] > *asOf {
					f.Precision = "hour" // the hour holding as_of also holds later events
					break
				}
				n += c[0]
				last = max(last, c[2])
			}
			f.Events = &n
			switch {
			case n == 0:
				f.Reason = append(f.Reason, "no-events")
			case last > 0:
				f.LastEventMS = &last
			default:
				f.Reason = append(f.Reason, "no-recorded-time")
			}
		}
		out = append(out, f)
	}
	return out
}

// lastOrder is the newest order time tallied.
func lastOrder(t *SourceTally) int64 {
	out := t.Before[1]
	for _, c := range t.Hours {
		out = max(out, c[1])
	}
	return out
}
