package main

// The one place the serving side meets the ingest side. internal/server, project, artifact and
// metrics know only feed.Log, server.IngestSource and server.FactorySource; this file adapts the
// store, the ingest loop and the factory reader to them. A change to those packages costs an edit
// here and nowhere else.

import (
	"errors"
	"time"

	"mach/observer/internal/factory"
	"mach/observer/internal/feed"
	"mach/observer/internal/ingest"
	"mach/observer/internal/server"
	"mach/observer/internal/store"
)

// storeLog is the store as a feed.Log.
type storeLog struct{ s *store.Store }

func (l storeLog) Epoch() string            { return l.s.Generation() }
func (l storeLog) Bounds() (uint64, uint64) { return l.s.Bounds() }
func (l storeLog) Changed() <-chan struct{} { return l.s.Changed() }
func (l storeLog) After(pos uint64, limit int) ([]feed.Record, error) {
	entries, err := l.s.After(pos, limit)
	switch {
	case errors.Is(err, store.ErrExpired):
		return nil, feed.ErrExpired
	case errors.Is(err, store.ErrFuture):
		return nil, feed.ErrFuture
	case err != nil:
		return nil, err
	}
	out := make([]feed.Record, len(entries))
	for i, e := range entries {
		out[i] = feed.Record{Pos: e.Event.Pos, Raw: e.Raw}
	}
	return out, nil
}

// ingestSource is the ingest loop as a server.IngestSource.
type ingestSource struct{ o *ingest.Observer }

func (a ingestSource) Ingest() server.IngestState {
	st := a.o.Stats()
	out := server.IngestState{Ticks: st.Ticks, LastTickMS: st.LastTickMS, IntervalMS: st.IntervalMS, Errors: st.Errors,
		LastError: st.LastError, FactoryFound: st.FactoryFound}
	if t, err := time.Parse(time.RFC3339Nano, st.LastTickAt); err == nil {
		out.LastTickAt = t
	}
	if st.Watermark > 0 {
		w := st.Watermark
		out.WatermarkMS = &w
	}
	for _, src := range st.Sources {
		state := src.State
		switch {
		case src.Blocked:
			state = "blocked"
		case src.Gone:
			state = "gone"
		case state == "":
			state = "unknown"
		}
		s := server.SourceState{Key: src.Key, Path: src.Path, State: state, Offset: src.Offset, Lines: src.Lines,
			Duplicates: src.Duplicates, Oversized: src.Oversized, Resets: src.Resets}
		// Every tick checks every source it holds, so a source that is neither gone nor blocked was
		// last read at the last tick. Ingest does not report a source's size, so lag stays null.
		if !src.Gone && !src.Blocked {
			s.LastReadAt = out.LastTickAt
		}
		out.Sources = append(out.Sources, s)
	}
	return out
}

// factorySource is the factory reader as a server.FactorySource.
type factorySource struct{ root string }

func (f factorySource) Factory(now time.Time) server.FactoryState {
	r := factory.Read(f.root, now)
	out := server.FactoryState{Present: r.FactoryPresent, Report: r, Effective: r.Policy.Effective, Enabled: r.Policy.Enabled,
		Paused: r.Policy.Paused, Autonomy: r.Policy.Autonomy, PolicyUsable: r.Policy.Usable, LeasePresent: r.Lease.Present,
		LeaseLive: r.Lease.Live, LeaseExpired: r.Lease.Expired, ReadAt: now}
	if r.Lease.Present && r.Lease.HeartbeatAt != "" {
		age := r.Lease.HeartbeatAgeSec
		out.LeaseAgeSec = &age
	}
	return out
}
