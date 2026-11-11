// Package engine is the host's only way to reach the Product Studio engine (studio.py).
//
// Every operation is a row in a fixed table: a name, a typed argument struct and a function that
// turns those arguments into a fixed argument vector. Nothing is ever built from text into a
// command line and no shell is involved. The engine decides every product rule; this package
// only checks the shape of a request and reports what the engine said, in one envelope.
package engine

import "encoding/json"

// Error kinds, as the HTTP contract names them.
const (
	KindRefused      = "refused"
	KindInvalid      = "invalid"
	KindUnauthorized = "unauthorized"
	KindConflict     = "conflict"
	KindUnavailable  = "unavailable"
	KindInternal     = "internal"
)

// Error is the error half of the envelope.
type Error struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
	// Hint is the engine's structured suggestion for a refusal, {kind, target}: the app action
	// that would resolve it. Absent when the engine gives none.
	Hint json.RawMessage `json:"hint,omitempty"`
}

// Envelope is the one shape every API response takes.
type Envelope struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error *Error          `json:"error,omitempty"`
}

// OK wraps engine output.
func OK(data json.RawMessage) Envelope { return Envelope{OK: true, Data: data} }

// Fail builds an error envelope.
func Fail(kind, message string) Envelope {
	return Envelope{OK: false, Error: &Error{Kind: kind, Message: message}}
}

// OKValue marshals a host-built value (only used for host facts such as the session, never for
// product state).
func OKValue(v any) Envelope {
	data, err := json.Marshal(v)
	if err != nil {
		return Fail(KindInternal, "The host could not encode its reply.")
	}
	return OK(data)
}
