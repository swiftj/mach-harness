package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/store"
)

// stream: GET /api/v1/stream, server-sent events.
//
// The stream has no queue of its own. Each client pulls from the store after its cursor, writes
// a bounded batch, and waits for the store's next append. The ingest loop never waits for a
// client: appending only closes a channel. A client that cannot keep up simply falls behind in
// the store; if it falls behind what the store still holds, it is told so (a "gap" event) and
// the stream ends. A client whose socket stops draining hits its write deadline and is dropped.
//
// Events:
//
//	hello      {generation, cursor, head, floor, heartbeat_ms}   first, always
//	(message)  id: <cursor>, data: <normalized event>            one per event
//	heartbeat  {head, at}                                         when idle, every Heartbeat
//	gap        {reason:"expired", after, floor, head}             cursor older than what is held; stream ends
//	reset      {reason:"generation"|"ahead", generation, head}    cursor from another index; stream ends
//
// The start position is Last-Event-ID (a reconnecting EventSource sends it), else ?after=, else
// the head (live only: a client that wants history fetches /api/v1/events first and passes its
// cursor).
func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	if n := s.streams.Add(1); n > int64(s.opts.MaxStreams) {
		s.streams.Add(-1)
		w.Header().Set("Retry-After", "5")
		writeJSON(w, http.StatusServiceUnavailable, fail(KindUnavailable, "Too many open event streams."))
		return
	}
	defer s.streams.Add(-1)

	raw := r.Header.Get("Last-Event-ID")
	if raw == "" {
		raw = r.URL.Query().Get("after")
	}
	_, head := s.opts.Store.Bounds()
	pos, cerr := s.resolve(raw, head)
	if cerr != nil && cerr.Kind == KindInvalid {
		writeJSON(w, http.StatusBadRequest, Envelope{Error: cerr})
		return
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	rc := http.NewResponseController(w)
	gen := s.opts.Store.Generation()
	cur := func(p uint64) string { return event.Cursor{Generation: gen, Position: p}.String() }

	send := func(chunk []byte) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(s.opts.WriteTimeout))
		if _, err := w.Write(chunk); err != nil {
			return false
		}
		return rc.Flush() == nil
	}
	control := func(name string, data any) bool {
		body, _ := json.Marshal(data)
		return send([]byte(fmt.Sprintf("event: %s\ndata: %s\n\n", name, body)))
	}

	if cerr != nil {
		name := "reset"
		if cerr.Kind == KindCursorExpired {
			name = "gap"
		}
		control(name, map[string]any{"reason": cerr.Cursor.Reason, "after": raw, "generation": cerr.Cursor.Generation,
			"floor": cerr.Cursor.Floor, "head": cerr.Cursor.Head})
		return
	}
	floor, head := s.opts.Store.Bounds()
	if !send([]byte("retry: 2000\n\n")) || !control("hello", map[string]any{"generation": gen, "cursor": cur(pos), "head": cur(head),
		"floor": cur(floor), "heartbeat_ms": s.opts.Heartbeat.Milliseconds()}) {
		return
	}

	heartbeat := time.NewTicker(s.opts.Heartbeat)
	defer heartbeat.Stop()
	for {
		changed := s.opts.Store.Changed() // taken before reading, so no append is missed
		entries, err := s.opts.Store.After(pos, s.opts.StreamBatch)
		if errors.Is(err, store.ErrExpired) {
			floor, head := s.opts.Store.Bounds()
			control("gap", map[string]any{"reason": "expired", "after": cur(pos), "generation": gen, "floor": cur(floor), "head": cur(head)})
			return
		}
		if err != nil {
			return
		}
		if len(entries) > 0 {
			buf := make([]byte, 0, 512*len(entries))
			for _, e := range entries {
				buf = append(buf, "id: "...)
				buf = append(buf, e.Event.Cursor...)
				buf = append(buf, "\ndata: "...)
				buf = append(buf, e.Raw...) // one line: encoding/json escapes newlines
				buf = append(buf, "\n\n"...)
			}
			if !send(buf) {
				return
			}
			pos = entries[len(entries)-1].Event.Position
			continue
		}
		select {
		case <-changed:
		case <-heartbeat.C:
			_, head := s.opts.Store.Bounds()
			if !control("heartbeat", map[string]any{"head": cur(head), "at": time.Now().UTC().Format(time.RFC3339Nano)}) {
				return
			}
		case <-r.Context().Done():
			return
		case <-s.opts.Done:
			return
		}
	}
}
