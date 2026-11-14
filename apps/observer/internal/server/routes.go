package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"mach/observer/internal/feed"
	"mach/observer/internal/project"
)

// Kinds are the version 3 event kinds (schemas/factory-event.v3.schema.json). Revision 1 added
// no kind.
var Kinds = []string{
	"wave.discovered", "intake.validated", "intake.refused", "slice.materialized", "slice.integrated", "dependency.resolved", "dependency.blocked",
	"work.scheduled", "revision.superseded", "human.required", "factory.activated", "factory.disabled", "factory.paused", "factory.resumed",
	"revision.discovered", "scheduling.decided", "work.claimed", "execution.started", "station.observed", "recovery.started", "execution.completed",
	"execution.failed", "station.entered", "station.exited", "gate.evaluated", "build.task_completed", "verify.check_recorded", "review.round_started",
	"review.verdict_submitted", "review.decided", "human.approval_recorded", "merge.completed", "cleanup.completed", "execution.process_started",
	"execution.process_ended", "run.recorded", "session.initialized", "workflow.started", "workflow.phases_declared", "workflow.finished",
	"agent.queued", "agent.started", "agent.progressed", "agent.finished", "tool.called", "tool.returned", "tool.refused", "execution.usage",
	"review.finding", "artifact.recorded", "history.began", "verify.targets_listed", "capacity.wait_changed", "history.gap",
}

// streamObservations is session.capabilities.stream_observations: the policy (each stream record
// is accepted or refused on its own shape), the versions the fixtures prove, the worst state over
// every stream read, and each version seen. ok is false only when records were refused.
func (s *Server) streamObservations() map[string]any {
	in := s.ingestState()
	out := map[string]any{"policy": "structural", "ok": nil, "claude_code_version": nil, "state": "unknown", "versions": []any{},
		"reason": "no execution stream has been read yet"}
	rt, ok := in.Runtime.(interface {
		Summary() (string, []string, []map[string]any)
	})
	if !ok {
		// No ingest summary (a reader of a log only): what the projection recorded from the
		// streams' init records.
		var v string
		s.opts.Projector.View(func(st *project.State) { v = st.Stream.ClaudeCodeVersion })
		out["proven_versions"] = feed.ProvenStreamVersions
		if v != "" {
			state := "compatible-unproven"
			for _, p := range feed.ProvenStreamVersions {
				if p == v {
					state = "proven"
				}
			}
			out["claude_code_version"], out["state"], out["ok"] = v, state, true
			out["versions"] = []any{map[string]any{"version": v, "state": state}}
			out["reason"] = "read from the streams' init records; records refused for their shape are counted by the ingest loop only"
		}
		return out
	}
	{
		state, proven, versions := rt.Summary()
		out["state"], out["proven_versions"] = state, proven
		vs := make([]any, len(versions))
		for i, v := range versions {
			vs[i] = v
		}
		out["versions"] = vs
		if len(versions) > 0 {
			out["claude_code_version"] = versions[len(versions)-1]["version"]
			out["ok"] = state != "incompatible"
			out["reason"] = map[string]string{
				"proven":              "every stream was written by a Claude Code version the observer's fixtures come from",
				"compatible-unproven": "observed on a Claude Code version the fixtures do not come from; every record matched the known shapes",
				"incompatible":        "some stream records did not match the known shapes and were refused (counted; nothing of them is shown)",
				"unknown":             "a stream has not said which Claude Code wrote it yet",
			}[state]
		}
	}
	return out
}

func ms(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC().Format(time.RFC3339Nano)
}

// ---- session, health, status ----

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	_, set := s.opts.Catalog.Snapshot()
	streamObs := s.streamObservations()
	var link any
	if s.opts.LinkFile != "" {
		link = map[string]any{"file": s.opts.LinkFile, "note": "a fresh one-time link for another browser is kept here, readable only by you"}
	}
	writeJSON(w, http.StatusOK, ok(map[string]any{
		"project":        map[string]any{"folder": projectFolder(s.opts.Root)},
		"versions":       map[string]any{"observer": Version, "api": APIVersion, "event": map[string]any{"schema": feed.SchemaVersion, "revision": feed.SchemaRevision, "kinds": Kinds}},
		"generation":     s.opts.Log.Epoch(),
		"read_only":      true,
		"display_policy": map[string]any{"people": "role", "free_text": freeTextPolicy()},
		"capabilities": map[string]any{"execution": false, "snapshot": true, "artifacts": true, "analytics": true,
			"evidence_media": set.EvidenceMedia, "evidence_media_setting": `.factory/config.json "tower": {"evidence_media": true}`,
			"stream_observations": streamObs},
		"limits": map[string]any{"page_default": DefaultPage, "page_max": MaxPage, "scan_cap": ScanCap, "spans_max": MaxSpans, "history_max": MaxHistory,
			"marks_default": DefaultMarks, "marks_max": MaxMarks, "concurrency_buckets_default": DefaultSeriesBuckets, "concurrency_buckets_max": MaxSeriesBuckets,
			"stream_batch": s.opts.StreamBatch, "streams_max": s.opts.MaxStreams, "stream_write_timeout_ms": s.opts.WriteTimeout.Milliseconds(),
			"heartbeat_ms": s.opts.Heartbeat.Milliseconds(), "content_reads_max": MaxContentReads,
			"artifact_text_bytes": 256 << 10, "artifact_image_bytes": 16 << 20, "artifact_video_bytes": 64 << 20},
		"sessions": map[string]any{"count": s.opts.Guard.Sessions()},
		"new_link": link,
	}))
}

func (s *Server) ingestState() IngestState {
	if s.opts.Ingest == nil {
		return IngestState{}
	}
	return s.opts.Ingest.Ingest()
}

// freshness is what a client needs to tell "live" from "stale" or "disconnected".
func (s *Server) freshness(now time.Time, in IngestState) map[string]any {
	floor, head := s.opts.Log.Bounds()
	var age any
	stale := true
	if !in.LastTickAt.IsZero() {
		d := now.Sub(in.LastTickAt)
		age = d.Milliseconds()
		stale = d > IngestStaleAfter
	}
	sources := make([]map[string]any, 0, len(in.Sources))
	for _, src := range in.Sources {
		var lag, readAge any
		if src.Size != nil {
			lag = max(0, *src.Size-src.Offset)
		}
		if !src.LastReadAt.IsZero() {
			readAge = now.Sub(src.LastReadAt).Milliseconds()
		}
		sources = append(sources, map[string]any{"key": src.Key, "path": src.Path, "state": src.State, "last_read_at": ms(src.LastReadAt),
			"last_read_age_ms": readAge, "offset": src.Offset, "size": src.Size, "lag_bytes": lag, "lines": src.Lines, "refused": src.Refused,
			"duplicates": src.Duplicates, "oversized": src.Oversized, "resets": src.Resets})
		if src.Runtime != nil {
			sources[len(sources)-1]["runtime"] = src.Runtime
		}
	}
	ps := s.opts.Projector.Status()
	return map[string]any{
		"observer_time": now.UTC().Format(time.RFC3339Nano),
		"head":          s.cursor(head),
		"floor":         s.cursor(floor),
		"ingest": map[string]any{"last_tick_at": ms(in.LastTickAt), "last_tick_age_ms": age, "stale": stale, "stale_after_ms": IngestStaleAfter.Milliseconds(),
			"watermark_ms": in.WatermarkMS, "catching_up": in.CatchingUp},
		"projection": map[string]any{"cursor": s.cursor(ps.Pos), "lag_events": head - min(head, ps.Pos), "partial": ps.Partial},
		"sources":    sources,
	}
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	now := s.opts.Now()
	in := s.ingestState()
	ps := s.opts.Projector.Status()
	fresh := s.freshness(now, in)
	status := "ok"
	if in.LastError != "" || ps.LastError != "" || fresh["ingest"].(map[string]any)["stale"] == true {
		status = "degraded"
	}
	floor, head := s.opts.Log.Bounds()
	writeJSON(w, http.StatusOK, ok(map[string]any{
		"status":         status,
		"observer":       Version,
		"api":            APIVersion,
		"observer_time":  fresh["observer_time"],
		"uptime_seconds": int64(now.Sub(s.opts.Started).Seconds()),
		"index":          map[string]any{"generation": s.opts.Log.Epoch(), "head": s.cursor(head), "floor": s.cursor(floor)},
		"projection":     ps,
		"ingest": map[string]any{"ticks": in.Ticks, "last_tick_at": ms(in.LastTickAt), "last_tick_ms": in.LastTickMS, "interval_ms": in.IntervalMS,
			"errors": in.Errors, "last_error": in.LastError, "factory_found": in.FactoryFound, "catching_up": in.CatchingUp, "late": in.Late, "backfill": in.Backfill,
			"runtime": in.Runtime, "delivery": in.Delivery},
		"freshness": fresh,
		"streams":   map[string]any{"active": s.streams.Load(), "max": s.opts.MaxStreams},
		"sessions":  s.opts.Guard.Sessions(),
	}))
}

func (s *Server) factoryState(now time.Time) FactoryState {
	s.statusMu.Lock()
	defer s.statusMu.Unlock()
	if s.opts.Factory != nil && now.Sub(s.statusAt) > statusTTL {
		s.statusData = s.opts.Factory.Factory(now)
		s.statusAt = now
	}
	return s.statusData
}

// factoryStatus: the Factory's files (policy summary, lease, counts) with the facts a client
// needs to say whether what it shows is current.
func (s *Server) factoryStatus(w http.ResponseWriter, r *http.Request) {
	now := s.opts.Now()
	fs := s.factoryState(now)
	in := s.ingestState()
	fresh := s.freshness(now, in)
	leaseFresh := fs.LeasePresent && fs.LeaseLive && !fs.LeaseExpired
	if fs.LeaseInterval > 0 && fs.LeaseAgeSec != nil {
		leaseFresh = leaseFresh && *fs.LeaseAgeSec <= fs.LeaseInterval
	}
	var recorded map[string]any
	s.opts.Projector.View(func(st *project.State) { recorded = project.FactoryView(st) })
	writeJSON(w, http.StatusOK, ok(map[string]any{
		"factory_present": fs.Present,
		"report":          fs.Report,
		"summary": map[string]any{"enabled": fs.Enabled, "paused": fs.Paused, "mode": fs.Effective, "autonomy": fs.Autonomy, "policy_usable": fs.PolicyUsable,
			"note": "a reading of the machine-local policy; run.py decides whether execution is authorized"},
		"supervisor":    map[string]any{"lease_present": fs.LeasePresent, "heartbeat_fresh": leaseFresh, "heartbeat_age_seconds": fs.LeaseAgeSec, "lease_expired": fs.LeaseExpired},
		"recorded_mode": recorded,
		"read_at":       ms(fs.ReadAt),
		"freshness":     fresh,
	}))
}

// ---- snapshot ----

// snapshot: GET /api/v1/snapshot?at=<cursor>. The projected state at that cursor (default: the
// projection's own position, which the log has reached). Stream from the returned cursor with
// Last-Event-ID to continue with no gap and no repeat.
func (s *Server) snapshot(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("at")
	at := uint64(0)
	if raw != "" {
		pos, cerr := s.resolve(raw, 0)
		if cerr != nil {
			writeJSON(w, cursorStatus(cerr), Envelope{Error: cerr})
			return
		}
		at = pos
	}
	if at == 0 {
		s.snapshotHead(w)
		return
	}
	st, reconstructed, err := s.opts.Projector.At(at)
	switch {
	case errors.Is(err, project.ErrNotHeld):
		floor, head := s.opts.Log.Bounds()
		writeJSON(w, http.StatusGone, Envelope{Error: &Error{Kind: KindCursorExpired, Message: "The state at that cursor can no longer be rebuilt; take a snapshot at a later cursor.",
			Cursor: &CursorState{Generation: s.opts.Log.Epoch(), Floor: s.cursor(floor), Head: s.cursor(head), Reason: "expired"}}})
		return
	case errors.Is(err, feed.ErrFuture):
		floor, head := s.opts.Log.Bounds()
		writeJSON(w, http.StatusConflict, Envelope{Error: &Error{Kind: KindCursorReset, Message: "The cursor is ahead of the observer's log.",
			Cursor: &CursorState{Generation: s.opts.Log.Epoch(), Floor: s.cursor(floor), Head: s.cursor(head), Reason: "ahead"}}})
		return
	case err != nil:
		writeJSON(w, http.StatusInternalServerError, fail(KindInternal, "The snapshot could not be built."))
		return
	}
	authority := "projection"
	if reconstructed {
		authority = "reconstructed"
	}
	writeJSON(w, http.StatusOK, ok(map[string]any{
		"cursor":        s.cursor(st.Pos),
		"generation":    st.Epoch,
		"pos":           st.Pos,
		"reconstructed": reconstructed,
		"authority":     authority,
		"partial":       st.Partial,
		"applied":       st.Applied,
		"state":         project.SnapshotView(st),
	}))
}

// snapshotHead is the snapshot at the projection's own position: built from the live projection
// under its lock (no copy of the state) and encoded there, then kept until the projection moves.
func (s *Server) snapshotHead(w http.ResponseWriter) {
	s.snapMu.Lock()
	defer s.snapMu.Unlock()
	var data []byte
	status := http.StatusOK
	s.opts.Projector.View(func(st *project.State) {
		if s.snapData != nil && s.snapEpoch == st.Epoch && s.snapPos == st.Pos {
			data = s.snapData
			return
		}
		var bad int
		data, bad = encode(ok(map[string]any{
			"cursor": s.cursor(st.Pos), "generation": st.Epoch, "pos": st.Pos, "reconstructed": false, "authority": "projection",
			"partial": st.Partial, "applied": st.Applied, "state": project.SnapshotView(st),
		}))
		data = append(data, '\n')
		if bad != 0 {
			status = bad
			return
		}
		s.snapEpoch, s.snapPos, s.snapData = st.Epoch, st.Pos, data
	})
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	w.Write(data)
}

// ---- project, waves, slices, cells ----

func (s *Server) project(w http.ResponseWriter, r *http.Request) {
	s.view(w, func(st *project.State) (int, Envelope) {
		v := project.ProjectView(st)
		v["cursor"] = s.cursor(st.Pos)
		return http.StatusOK, ok(v)
	})
}

func (s *Server) waves(w http.ResponseWriter, r *http.Request) {
	s.view(w, func(st *project.State) (int, Envelope) {
		return http.StatusOK, ok(map[string]any{"items": project.Waves(st), "cursor": s.cursor(st.Pos)})
	})
}

func (s *Server) wave(w http.ResponseWriter, r *http.Request) {
	id, good := ident(r.PathValue("wave"))
	if !good {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "That is not a wave identifier."))
		return
	}
	s.view(w, func(st *project.State) (int, Envelope) {
		wv := st.Waves[id]
		if wv == nil {
			return http.StatusNotFound, fail(KindNotFound, "No such wave has been seen.")
		}
		v := project.WaveDetail(st, wv)
		v["cursor"] = s.cursor(st.Pos)
		return http.StatusOK, ok(v)
	})
}

var sliceStates = map[string]bool{"completed": true, "active": true, "ready": true, "blocked": true, "superseded": true, "unknown": true}

func (s *Server) slices(w http.ResponseWriter, r *http.Request) {
	wave, bad := optIdent(r.URL.Query(), "wave")
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	state := r.URL.Query().Get("state")
	if state != "" && !sliceStates[state] {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "state must be completed, active, ready, blocked, superseded or unknown."))
		return
	}
	limit, bad := pageLimit(r, MaxPage)
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	off, bad := offset(r)
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	s.view(w, func(st *project.State) (int, Envelope) {
		return http.StatusOK, ok(pageOf(project.Slices(st, wave, state), off, limit, s.cursor(st.Pos)))
	})
}

func pageOf[T any](items []T, off, limit int, cursor string) map[string]any {
	total := len(items)
	start := min(off, total)
	end := min(start+limit, total)
	return map[string]any{"items": items[start:end], "total": total, "offset": start, "more": end < total, "cursor": cursor}
}

func (s *Server) slice(w http.ResponseWriter, r *http.Request) {
	id, good := ident(r.PathValue("slice"))
	if !good {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "That is not a slice identifier."))
		return
	}
	s.view(w, func(st *project.State) (int, Envelope) {
		sl := st.Slices[id]
		if sl == nil {
			return http.StatusNotFound, fail(KindNotFound, "No such slice has been seen.")
		}
		v := project.SliceView(st, sl)
		v["cursor"] = s.cursor(st.Pos)
		return http.StatusOK, ok(v)
	})
}

func (s *Server) cells(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	stage := q.Get("stage")
	if stage != "" && !idRe.MatchString(stage) {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "stage is not a stage name."))
		return
	}
	var archived *bool
	switch q.Get("archived") {
	case "":
	case "true":
		archived = new(bool)
		*archived = true
	case "false":
		archived = new(bool)
	default:
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "archived must be true or false."))
		return
	}
	limit, bad := pageLimit(r, MaxPage)
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	off, bad := offset(r)
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	s.view(w, func(st *project.State) (int, Envelope) {
		return http.StatusOK, ok(pageOf(project.Cells(st, stage, archived), off, limit, s.cursor(st.Pos)))
	})
}

func (s *Server) cell(w http.ResponseWriter, r *http.Request) {
	t, good := ident(r.PathValue("ticket"))
	if !good {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "That is not a ticket identifier."))
		return
	}
	s.view(w, func(st *project.State) (int, Envelope) {
		c := st.Cells[t]
		if c == nil {
			return http.StatusNotFound, fail(KindNotFound, "No such cell has been seen.")
		}
		v := project.CellDetail(st, c)
		v["cursor"] = s.cursor(st.Pos)
		return http.StatusOK, ok(v)
	})
}

// visit: one station visit, with its events from the log (by the visit's entity ref).
func (s *Server) visit(w http.ResponseWriter, r *http.Request) {
	t, good := ident(r.PathValue("ticket"))
	v, good2 := ident(r.PathValue("visit"))
	if !good || !good2 {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "That is not a ticket and visit (for example build#2, sent as build%232)."))
		return
	}
	visitID := t + "/" + v
	var view json.RawMessage
	found := false
	s.opts.Projector.View(func(st *project.State) {
		if c := st.Cells[t]; c != nil {
			for _, vv := range project.Visits(c) {
				if vv.VisitID == visitID {
					view, _ = json.Marshal(vv) // encoded under the projection's lock
					found = true
				}
			}
		}
	})
	if !found {
		writeJSON(w, http.StatusNotFound, fail(KindNotFound, "No such visit has been seen."))
		return
	}
	floor, _ := s.opts.Log.Bounds()
	page, err := feed.Scan(s.opts.Log, floor, feed.Filter{Entity: "visit:" + visitID}, MaxPage, 1<<20)
	if err != nil && !errors.Is(err, feed.ErrExpired) {
		writeJSON(w, http.StatusInternalServerError, fail(KindInternal, "The visit's events could not be read."))
		return
	}
	events := make([]any, 0, len(page.Records))
	for _, rec := range page.Records {
		events = append(events, rec.Raw)
	}
	writeJSON(w, http.StatusOK, ok(map[string]any{"visit": view, "events": events, "events_from": s.cursor(floor),
		"more": len(page.Records) >= MaxPage, "note": "events still held by the log, oldest first"}))
}

// ---- runs ----

func (s *Server) runs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	class := q.Get("state")
	if class != "" && class != "active" && class != "finished" && class != "unknown" {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "state must be active, finished or unknown."))
		return
	}
	ticket, bad := optIdent(q, "ticket")
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	limit, bad := pageLimit(r, DefaultPage)
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	off, bad := offset(r)
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	s.view(w, func(st *project.State) (int, Envelope) {
		return http.StatusOK, ok(pageOf(project.Runs(st, class, ticket), off, limit, s.cursor(st.Pos)))
	})
}

func (s *Server) withRun(w http.ResponseWriter, r *http.Request, fn func(st *project.State, x *project.Execution) any) {
	id, good := ident(r.PathValue("execution"))
	if !good {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "That is not an execution identifier."))
		return
	}
	s.view(w, func(st *project.State) (int, Envelope) {
		x := st.Executions[id]
		if x == nil {
			return http.StatusNotFound, fail(KindNotFound, "No such execution has been seen.")
		}
		return http.StatusOK, ok(fn(st, x))
	})
}

func (s *Server) run(w http.ResponseWriter, r *http.Request) {
	s.withRun(w, r, func(st *project.State, x *project.Execution) any {
		workflows := []*project.Workflow{}
		for _, k := range sortedKeys(x.Workflows) {
			workflows = append(workflows, x.Workflows[k])
		}
		var claude any
		if x.Session != nil {
			claude = x.Session
		}
		return map[string]any{"run": project.Run(st, x), "session": claude, "workflows": workflows, "usage": x.Usage,
			"observations": map[string]any{"agents": len(x.Agents) + len(x.Queued), "main_loop_tools": len(x.Tools), "tools_dropped": x.ToolsDropped, "refused": len(x.Refused)},
			"refused":      x.Refused, "cursor": s.cursor(st.Pos)}
	})
}

// agents: workflow agents and Agent-tool sub-agents. A token total and a tool-call COUNT per
// agent; never a cost and never per-call records (contract 8.1).
func (s *Server) agents(w http.ResponseWriter, r *http.Request) {
	s.withRun(w, r, func(st *project.State, x *project.Execution) any {
		return map[string]any{"items": project.Agents(x), "cursor": s.cursor(st.Pos),
			"note": "workflow agents' individual tool calls are not observable: tool_calls is a count; no agent has a cost"}
	})
}

// tools: per-call records for the main loop and Agent-tool sub-agents only.
func (s *Server) tools(w http.ResponseWriter, r *http.Request) {
	s.withRun(w, r, func(st *project.State, x *project.Execution) any {
		return map[string]any{"items": project.Tools(x), "refused": x.Refused, "dropped": x.ToolsDropped, "cursor": s.cursor(st.Pos),
			"note": "main loop and Agent-tool sub-agent calls only; a workflow agent's calls appear as its tool_calls count"}
	})
}

func kindQuote(s string) string {
	if len(s) > 40 {
		s = s[:40]
	}
	return `"` + strings.Map(func(r rune) rune {
		if r < 32 || r == '"' {
			return -1
		}
		return r
	}, s) + `"`
}

// ---- analytics ----

// The metrics route is in analytics_metrics.go.

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// ---- series ----

// Series limits: buckets are at least a second, at most MaxSeriesBuckets per reply, and by
// default as few seconds as keep the range within DefaultSeriesBuckets.
const (
	MaxSeriesBuckets     = 2000
	DefaultSeriesBuckets = 500
)

// seriesSteps are the bucket sizes chosen when none is asked for: whole seconds and minutes,
// then hours and days, so buckets line up with a clock.
var seriesSteps = []int64{1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000}

// series: GET /api/v1/series?from_ms&to_ms&bucket_ms&ticket&execution (shared contracts 2.8).
// Event counts per time bucket, by kind and authority, placed by order_ms (a late event counts
// where it belongs): enough to draw a long timeline without fetching every event. With
// whole-minute buckets and no filter, or one filter (ticket or execution), the counts cover
// everything indexed (kept per minute; source "minutes"); finer buckets, or both filters, are
// counted from the memory window (source "memory-window"). complete says whether every event of
// the range was counted. Empty buckets are left out.
func (s *Server) series(w http.ResponseWriter, r *http.Request) {
	sr, ok2 := s.opts.Log.(feed.Serieser)
	if !ok2 {
		writeJSON(w, http.StatusServiceUnavailable, fail(KindUnavailable, "This observer cannot count events per time bucket."))
		return
	}
	q := r.URL.Query()
	invalid := func(msg string) { writeJSON(w, http.StatusBadRequest, fail(KindInvalid, msg)) }
	num := func(name string) (int64, bool, bool) {
		v := q.Get(name)
		if v == "" {
			return 0, false, true
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 || n > 999_999_999_999_999 {
			invalid(name + " must be a whole number of milliseconds.")
			return 0, false, false
		}
		return n, true, true
	}
	lo, hi := sr.SeriesBounds()
	from, hasFrom, good := num("from_ms")
	if !good {
		return
	}
	to, hasTo, good := num("to_ms")
	if !good {
		return
	}
	bucket, hasBucket, good := num("bucket_ms")
	if !good {
		return
	}
	if !hasFrom {
		from = lo
	}
	if !hasTo {
		to = hi + 1
	}
	if to <= from {
		if hasFrom || hasTo {
			invalid("The range is empty: to_ms must be after from_ms.")
			return
		}
		to = from + 1 // nothing indexed yet
	}
	if hasBucket {
		if bucket < 1000 || bucket%1000 != 0 {
			invalid("bucket_ms must be a whole number of seconds (at least 1000).")
			return
		}
	} else {
		bucket = seriesSteps[len(seriesSteps)-1]
		for _, step := range seriesSteps {
			if (to-from+step-1)/step <= DefaultSeriesBuckets {
				bucket = step
				break
			}
		}
	}
	if !hasFrom {
		from -= from % bucket // align an open start to the bucket
	}
	if n := (to - from + bucket - 1) / bucket; n > MaxSeriesBuckets {
		invalid(fmt.Sprintf("That would be %d buckets; at most %d. Ask for a larger bucket_ms or a shorter range.", n, MaxSeriesBuckets))
		return
	}
	var fq feed.SeriesQuery
	fq.FromMS, fq.ToMS, fq.BucketMS = from, to, bucket
	var bad *Envelope
	if fq.Ticket, bad = optIdent(q, "ticket"); bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	if fq.Execution, bad = optIdent(q, "execution"); bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	res := sr.Series(fq)
	buckets := make([]map[string]any, 0, len(res.Buckets))
	for _, b := range res.Buckets {
		buckets = append(buckets, map[string]any{"from_ms": b.FromMS, "count": b.Count, "kinds": b.Kinds, "authorities": b.Authorities})
	}
	floor, head := s.opts.Log.Bounds()
	in := s.ingestState()
	writeJSON(w, http.StatusOK, ok(map[string]any{
		"from_ms": from, "to_ms": to, "bucket_ms": bucket, "buckets": buckets, "total": res.Total, "kinds": res.Kinds,
		"authorities": res.Authorities, "complete": res.Complete, "source": res.Source, "head": s.cursor(head), "floor": s.cursor(floor),
		"watermark_ms": in.WatermarkMS, "limits": map[string]int64{"buckets_max": MaxSeriesBuckets, "bucket_ms_min": 1000},
	}))
}
