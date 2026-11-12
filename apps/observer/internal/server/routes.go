package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"mach/observer/internal/feed"
	"mach/observer/internal/metrics"
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

// ProvenStreamVersion is the Claude Code version the stream mapping was proven against.
const ProvenStreamVersion = "2.1.322"

func ms(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC().Format(time.RFC3339Nano)
}

// ---- session, health, status ----

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	_, set := s.opts.Catalog.Snapshot()
	var streamObs map[string]any
	s.opts.Projector.View(func(st *project.State) {
		v := st.Stream.ClaudeCodeVersion
		switch {
		case v == "":
			streamObs = map[string]any{"ok": nil, "claude_code_version": nil, "reason": "no execution stream has been read yet"}
		case v == ProvenStreamVersion:
			streamObs = map[string]any{"ok": true, "claude_code_version": v, "reason": nil}
		default:
			streamObs = map[string]any{"ok": false, "claude_code_version": v,
				"reason": "the stream mapping was proven for Claude Code " + ProvenStreamVersion + "; other versions yield only what the parser knows"}
		}
	})
	var link any
	if s.opts.LinkFile != "" {
		link = map[string]any{"file": s.opts.LinkFile, "note": "a fresh one-time link for another browser is kept here, readable only by you"}
	}
	writeJSON(w, http.StatusOK, ok(map[string]any{
		"project":        map[string]any{"folder": projectFolder(s.opts.Root)},
		"versions":       map[string]any{"observer": Version, "api": APIVersion, "event": map[string]any{"schema": feed.SchemaVersion, "revision": feed.SchemaRevision, "kinds": Kinds}},
		"generation":     s.opts.Log.Epoch(),
		"read_only":      true,
		"display_policy": map[string]any{"people": "role"},
		"capabilities": map[string]any{"execution": false, "snapshot": true, "artifacts": true, "analytics": true,
			"evidence_media": set.EvidenceMedia, "evidence_media_setting": `.factory/config.json "tower": {"evidence_media": true}`,
			"stream_observations": streamObs},
		"limits": map[string]any{"page_default": DefaultPage, "page_max": MaxPage, "scan_cap": ScanCap, "spans_max": MaxSpans, "history_max": MaxHistory,
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
			"errors": in.Errors, "last_error": in.LastError, "factory_found": in.FactoryFound, "catching_up": in.CatchingUp, "late": in.Late, "backfill": in.Backfill},
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
		return map[string]any{"run": project.Run(x), "session": claude, "workflows": workflows, "usage": x.Usage,
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

// ---- timeline ----

var spanKinds = map[string]bool{"wave": true, "slice-wait": true, "slice-eligible": true, "cell": true, "round": true, "visit": true, "gate-wait": true,
	"person-wait": true, "seat": true, "claim": true, "execution": true, "workflow": true, "agent-queue": true, "agent": true, "tool": true, "task": true}

// spans: GET /api/v1/spans?ticket|execution|wave|entity&kinds=visit,agent&limit&offset
func (s *Server) spans(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var f project.SpanFilter
	var bad *Envelope
	if f.Ticket, bad = optIdent(q, "ticket"); bad == nil {
		if f.Execution, bad = optIdent(q, "execution"); bad == nil {
			f.Wave, bad = optIdent(q, "wave")
		}
	}
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	f.Entity = q.Get("entity")
	if len(f.Entity) > 300 {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "entity is too long."))
		return
	}
	if k := q.Get("kinds"); k != "" {
		f.Kinds = map[string]bool{}
		for _, kind := range strings.Split(k, ",") {
			if !spanKinds[kind] {
				writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "unknown span kind "+kindQuote(kind)+"."))
				return
			}
			f.Kinds[kind] = true
		}
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
		all := project.Spans(st, f)
		if len(all) > MaxSpans {
			all = all[:MaxSpans]
		}
		v := pageOf(all, off, limit, s.cursor(st.Pos))
		v["basis_vocabulary"] = []string{"measured", "bounded", "inferred", "open", "unknown"}
		return http.StatusOK, ok(v)
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

var groupDims = map[string]bool{"day": true, "risk": true, "app_type": true, "station": true, "round": true, "seat": true, "model": true, "phase": true,
	"wave": true, "stage": true, "gate": true, "reason_code": true, "kind": true, "tool": true, "rule": true, "target_kind": true, "stop_reason": true,
	"writer": true, "ticket": true, "token_kind": true}

func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var ids []string
	if v := q.Get("ids"); v != "" {
		for _, id := range strings.Split(v, ",") {
			if _, known := metrics.Lookup(id); !known {
				writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "unknown metric "+kindQuote(id)+"."))
				return
			}
			ids = append(ids, id)
		}
	}
	group := q.Get("group_by")
	if group != "" && !groupDims[group] {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "group_by is not a known dimension."))
		return
	}
	s.view(w, func(st *project.State) (int, Envelope) {
		return http.StatusOK, ok(map[string]any{"metrics": st.Metrics.Rows(ids, group), "definitions_version": metrics.DefinitionsVersion,
			"cursor": s.cursor(st.Pos), "group_overflow": st.Metrics.Overflow, "partial": st.Partial,
			"rules": "recorded values only; an empty denominator is null with a reason; nothing is estimated or apportioned"})
	})
}

func (s *Server) analyticsRuns(w http.ResponseWriter, r *http.Request) {
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
		runs := st.Runs
		if runs == nil {
			runs = []*project.RunRecord{}
		}
		return http.StatusOK, ok(pageOf(runs, off, limit, s.cursor(st.Pos)))
	})
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
