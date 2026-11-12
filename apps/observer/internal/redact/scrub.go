package redact

import (
	"sort"

	"mach/observer/internal/event"
)

// MaxString is the longest string any event may carry. A longer one is long free text, which no
// kind allows, and is replaced whole.
const MaxString = 600

// ScrubEvent is the defence in depth behind the allowlist: it walks every string the event
// carries (identities, entities, parent, provenance, origin, every data value and key at any
// depth) and replaces whatever looks sensitive, counting each replacement in ev.Withheld and c.
// An identity or reference that looks sensitive is removed rather than rewritten, because a
// rewritten identifier would point at something else. Event ids and the order key are built by
// the observer from values that already passed these filters and are not rewritten.
func ScrubEvent(ev *event.Event, projectRoot string, c *Counters) {
	n := 0
	scan := func(s string) (string, bool) {
		if c != nil {
			c.Strings++
		}
		if len(s) > MaxString {
			n++
			return "[withheld]", true
		}
		if !Sensitive(s) {
			return s, false
		}
		out, k := scrubText(s, projectRoot, MaxString)
		if k == 0 {
			k = 1
		}
		n += k
		return out, true
	}
	drop := func(p *string) {
		if *p == "" {
			return
		}
		if _, changed := scan(*p); changed {
			*p = ""
		}
	}
	ids := &ev.IDs
	for _, p := range []*string{&ids.ProjectID, &ids.WaveID, &ids.SliceID, &ids.TicketID, &ids.CellInstance, &ids.ExecutionID,
		&ids.RunnerID, &ids.VisitID, &ids.Station, &ids.Seat, &ids.AgentID, &ids.ParentAgentID, &ids.ToolCallID,
		&ev.Parent, &ev.Origin.Script, &ev.Origin.SourceVersion} {
		drop(p)
	}
	if len(ev.Entities) > 0 {
		kept := ev.Entities[:0]
		for _, e := range ev.Entities {
			if _, changed := scan(e); !changed {
				kept = append(kept, e)
			}
		}
		ev.Entities = kept
	}
	if ev.Provenance != nil {
		files := ev.Provenance.Files[:0]
		for _, f := range ev.Provenance.Files {
			if _, changed := scan(f); !changed {
				files = append(files, f)
			}
		}
		ev.Provenance.Files = files
	}
	if len(ev.Artifacts) > 0 {
		kept := ev.Artifacts[:0]
		for _, a := range ev.Artifacts {
			if _, changed := scan(a.Ref); !changed {
				kept = append(kept, a)
			}
		}
		ev.Artifacts = kept
	}
	for k, v := range ev.Inferred {
		if _, changed := scan(k); changed {
			delete(ev.Inferred, k)
		} else if _, changed := scan(v); changed {
			delete(ev.Inferred, k)
		}
	}
	ev.Data = scrubMap(ev.Data, scan)
	ev.Withheld += n
	if c != nil {
		c.Replaced += int64(n)
	}
}

func scrubMap(m map[string]any, scan func(string) (string, bool)) map[string]any {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if _, changed := scan(k); changed {
			delete(m, k)
			continue
		}
		m[k] = scrubValue(m[k], scan)
	}
	return m
}

func scrubValue(v any, scan func(string) (string, bool)) any {
	switch x := v.(type) {
	case string:
		out, _ := scan(x)
		return out
	case map[string]any:
		return scrubMap(x, scan)
	case []any:
		for i := range x {
			x[i] = scrubValue(x[i], scan)
		}
		return x
	case []string:
		for i := range x {
			x[i], _ = scan(x[i])
		}
		return x
	}
	return v
}
