package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"mach/observer/internal/feed"
)

// stream: GET /api/v1/stream, server-sent events.
//
// The stream has no queue of its own. Each client pulls from the log after its cursor, writes a
// bounded batch, and waits for the log's next append. The ingest loop never waits for a client:
// appending only closes a channel. A client that cannot keep up falls behind in the log; if it
// falls behind what the log still holds, it is told so (a "gap" event) and the stream ends. A
// client whose socket stops draining hits its write deadline and is dropped.
//
// Events:
//
//	hello      {generation, cursor, head, floor, heartbeat_ms, schema, filter, limits}   first, always
//	(message)  id: <cursor>, data: <version 3 event>                                    one per event
//	heartbeat  {head, scanned, at, at_ms, watermark_ms}                                  when idle
//	gap        {reason:"expired", after, floor, head}                                    stream ends
//	reset      {reason:"generation"|"ahead", generation, head}                           stream ends
//
// The start position is Last-Event-ID (a reconnecting EventSource sends it), else ?after=, else
// the head. With filters (ticket, execution, station, type, entity, authority), only matching
// events are sent; "scanned" in the heartbeat is how far the server has looked, so a client can
// resume from there instead of from its last matching event.
func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	f, bad := filter(r)
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
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
	_, head := s.opts.Log.Bounds()
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
	gen := s.opts.Log.Epoch()

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
	floor, head := s.opts.Log.Bounds()
	if !send([]byte("retry: 2000\n\n")) || !control("hello", map[string]any{"generation": gen, "cursor": s.cursor(pos), "head": s.cursor(head),
		"floor": s.cursor(floor), "heartbeat_ms": s.opts.Heartbeat.Milliseconds(), "schema": feed.SchemaVersion,
		"filter": map[string]string{"ticket": f.Ticket, "execution": f.Execution, "station": f.Station, "type": f.TypePref, "entity": f.Entity, "authority": f.Authority},
		"limits": map[string]any{"batch": s.opts.StreamBatch, "max_streams": s.opts.MaxStreams, "write_timeout_ms": s.opts.WriteTimeout.Milliseconds()}}) {
		return
	}

	heartbeat := time.NewTicker(s.opts.Heartbeat)
	defer heartbeat.Stop()
	scanned := pos // with a filter, how far the server has looked
	for {
		changed := s.opts.Log.Changed() // taken before reading, so no append is missed
		recs, err := s.opts.Log.After(scanned, s.opts.StreamBatch)
		if errors.Is(err, feed.ErrExpired) {
			floor, head := s.opts.Log.Bounds()
			control("gap", map[string]any{"reason": "expired", "after": s.cursor(scanned), "generation": gen, "floor": s.cursor(floor), "head": s.cursor(head)})
			return
		}
		if err != nil {
			return
		}
		if len(recs) > 0 {
			buf := make([]byte, 0, 512*len(recs))
			for _, rec := range recs {
				if !f.MatchRaw(rec) {
					continue
				}
				buf = append(buf, "id: "...)
				buf = append(buf, s.cursor(rec.Pos)...)
				buf = append(buf, "\ndata: "...)
				buf = append(buf, rec.Raw...) // one line: encoding/json escapes newlines
				buf = append(buf, "\n\n"...)
			}
			scanned = recs[len(recs)-1].Pos
			if len(buf) > 0 && !send(buf) {
				return
			}
			continue
		}
		select {
		case <-changed:
		case <-heartbeat.C:
			_, head := s.opts.Log.Bounds()
			var watermark any
			if s.opts.Ingest != nil {
				if wm := s.opts.Ingest.Ingest().WatermarkMS; wm != nil {
					watermark = *wm
				}
			}
			if !control("heartbeat", map[string]any{"head": s.cursor(head), "scanned": s.cursor(scanned), "at": s.opts.Now().UTC().Format(time.RFC3339Nano), "at_ms": s.opts.Now().UnixMilli(), "watermark_ms": watermark}) {
				return
			}
		case <-r.Context().Done():
			return
		case <-s.opts.Done:
			return
		}
	}
}
