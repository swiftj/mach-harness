package normalize

import (
	"encoding/json"
	"sort"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
)

// Source 3: Claude execution streams, .factory/local/executions/<id>/stream.jsonl.
//
// DEPENDS ON the stream format being established from a real run (the m61-stream-proof work).
// Until then no handler is registered by default: every record is unrecognised. The contract a
// handler must keep is enforced here, not trusted:
//
//   - A record is classified by its "type" and, if present, "subtype" ("assistant",
//     "system/task_started"). Only a classification with a registered handler is looked at
//     further. Deny by default.
//   - An unrecognised record yields no event and no content: it increments a counter, which the
//     ingest loop may report as a count.
//   - A handler returns Observations. Their data is filtered again here: keys must be short
//     lower-case words, and values must be numbers, booleans, identifiers or words. Free text,
//     nested objects and anything else are dropped and counted, whatever the handler put there.
//     Raw tool inputs, file contents, commands and transcripts therefore cannot pass, even through
//     a faulty handler.

// Observation is what a stream handler may report about one record.
type Observation struct {
	Type string         // e.g. "agent.started", "tool.called"; must be a word
	Data map[string]any // filtered again by safeObservation
}

// StreamHandler looks at one decoded record of a classification it was registered for.
type StreamHandler func(record map[string]any) []Observation

// Stream normalizes the lines of one execution's stream.
type Stream struct {
	handlers map[string]StreamHandler
	// Unrecognised counts records with no handler; Malformed counts lines that are not JSON
	// objects. Neither keeps anything of the line.
	Unrecognised int
	Malformed    int
}

// NewStream makes a normalizer with exactly these handlers. nil means none: deny everything.
func NewStream(handlers map[string]StreamHandler) *Stream {
	if handlers == nil {
		handlers = map[string]StreamHandler{}
	}
	return &Stream{handlers: handlers}
}

// Classify gives the record's classification key, or "" when it has none usable.
func Classify(record map[string]any) string {
	typ, ok := redact.Token(record["type"])
	if !ok {
		return ""
	}
	if sub, ok := redact.Token(record["subtype"]); ok {
		return typ + "/" + sub
	}
	return typ
}

// Normalize returns the events for one line; none for an unrecognised or malformed one.
func (s *Stream) Normalize(line []byte, ctx Context, executionID string) []*event.Event {
	var record map[string]any
	if err := json.Unmarshal(line, &record); err != nil || record == nil {
		s.Malformed++
		return nil
	}
	key := Classify(record)
	handler, ok := s.handlers[key]
	if !ok {
		// Try the bare type when type/subtype has no handler of its own.
		if typ, okType := redact.Token(record["type"]); okType {
			handler, ok = s.handlers[typ]
		}
	}
	if !ok {
		s.Unrecognised++
		return nil
	}
	// Observed whether read live or afterwards: the stream is the runtime's own record; only its
	// time quality differs (M6_1_EVENT_CONTRACT.md D7).
	authority := event.Observed
	partition := event.StreamPartition(executionID)
	precision := "arrival"
	if !ctx.Live {
		precision = "unknown"
	}
	var out []*event.Event
	for i, obs := range handler(record) {
		typ, ok := redact.Token(obs.Type)
		if !ok {
			continue
		}
		data, withheld := safeObservation(obs.Data)
		out = append(out, &event.Event{
			V:          event.Version,
			ID:         event.Part(partition, ctx.Line, i),
			Type:       typ,
			Authority:  authority,
			Source:     event.Source{Kind: event.KindExecution, Key: partition, Epoch: ctx.Epoch, Line: ctx.Line, Offset: ctx.Offset},
			Precision:  precision,
			OccurredAt: Stamp(ctx.ObservedAt),
			ObservedAt: Stamp(ctx.ObservedAt),
			Live:       ctx.Live,
			Subject:    event.Subject{ExecutionID: executionID, Actor: "observer"},
			Data:       data,
			Withheld:   withheld,
		})
	}
	return out
}

func safeObservation(data map[string]any) (map[string]any, int) {
	if len(data) == 0 {
		return nil, 0
	}
	keys := make([]string, 0, len(data))
	for k := range data {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := map[string]any{}
	withheld := 0
	for _, k := range keys {
		name, ok := redact.Token(k)
		if !ok || len(out) >= 32 {
			withheld++
			continue
		}
		switch v := data[k].(type) {
		case bool:
			out[name] = v
		case int:
			out[name] = v
		case int64:
			out[name] = v
		case float64:
			if n, ok := redact.Number(v); ok {
				out[name] = n
			} else {
				withheld++
			}
		case string:
			if t, ok := redact.Token(v); ok {
				out[name] = t
			} else if id, ok := redact.ID(v); ok {
				out[name] = id
			} else {
				withheld++
			}
		default:
			withheld++
		}
	}
	if len(out) == 0 {
		out = nil
	}
	return out, withheld
}
