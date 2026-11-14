package server

import (
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"mach/observer/internal/feed"
	"mach/observer/internal/metrics"
	"mach/observer/internal/project"
)

// The parameters and envelope every /api/v1/analytics/... route shares (M6_5_DESIGN.md section 3).
//
// Window convention: from_ms is inclusive and to_ms exclusive. Analytics cells are kept per UTC
// day, so the window is widened to whole days: effective_from_ms is the UTC midnight at or before
// from_ms, effective_to_ms the UTC midnight at or after to_ms (exclusive). FromDay and ToDay are
// the first and last day the effective window covers, inclusive ("2006-01-02").

const dayMS = int64(24 * time.Hour / time.Millisecond)

// analyticsCommon are the parameters every analytics route reads itself.
var analyticsCommon = map[string]bool{"at": true, "as_of_ms": true, "from_ms": true, "to_ms": true, "last_runs": true, "risk": true, "app_type": true, "model": true,
	"station": true, "wave": true, "outcome": true, "provenance": true, "schema": true}

// Fixed value sets; a value outside them is a 400. "unknown" selects what recorded no value.
var (
	analyticsRisks    = map[string]bool{"High": true, "Medium": true, "Low": true, "unknown": true}
	analyticsAppTypes = map[string]bool{"web": true, "cli": true, "api": true, "grpc": true, "rest": true, "desktop": true, "mobile": true,
		"library": true, "unknown": true}
	analyticsOutcomes = map[string]bool{"merged": true, "abandoned": true, "unknown": true}
)

// analyticsParams are the common parameters, read and checked.
type analyticsParams struct {
	At    uint64 // 0: the head
	AtRaw string
	// AsOfMS (as_of_ms): a time filter, with or without at: nothing whose establishing record is
	// later than it is counted or listed. Routes that cut exactly (flow, contributors, runs) set
	// Exact; for the others (per-day metric cells) the effective window ends at the start of the
	// as_of day: whole UTC days before it only.
	AsOfMS   *int64
	Exact    bool
	FromMS   *int64 // as asked (inclusive)
	ToMS     *int64 // as asked (exclusive)
	LastRuns int    // 0: not asked; exclusive with a window
	// Filters ("" when not asked).
	Risk, AppType, Model, Station, Wave, Outcome, Provenance string
}

// EffectiveWindow is the asked window widened to whole UTC days; ok is false when no window was
// asked (from and to are then 0). With as_of_ms on a route that is not Exact, the window also ends
// at the start of the as_of day (the day of as_of_ms is never included); an empty result has
// to == from.
func (p analyticsParams) EffectiveWindow() (from, to int64, ok bool) {
	clip := p.AsOfMS != nil && !p.Exact
	if p.FromMS == nil && p.ToMS == nil && !clip {
		return 0, 0, false
	}
	from, to = 0, int64(1)<<62
	if p.FromMS != nil {
		from = floorDay(*p.FromMS)
	}
	if p.ToMS != nil {
		to = ceilDay(*p.ToMS)
	}
	if clip {
		to = max(from, min(to, floorDay(*p.AsOfMS)))
	}
	return from, to, true
}

// EmptyWindow reports an effective window that holds nothing (as_of_ms at or before from_ms's day).
func (p analyticsParams) EmptyWindow() bool {
	from, to, ok := p.EffectiveWindow()
	return ok && to <= from
}

// Days are the first and last UTC day of the effective window, inclusive; ok false with no window.
// An open side is "" (no bound). With EmptyWindow, toDay is the day before fromDay.
func (p analyticsParams) Days() (fromDay, toDay string, ok bool) {
	from, to, ok := p.EffectiveWindow()
	if !ok {
		return "", "", false
	}
	if p.FromMS != nil {
		fromDay = dayOf(from)
	}
	if p.ToMS != nil || p.AsOfMS != nil && !p.Exact {
		toDay = dayOf(to - 1)
	}
	return fromDay, toDay, true
}

// InWindow reports whether an instant falls in the effective window (always, with no window).
func (p analyticsParams) InWindow(ms int64) bool {
	from, to, ok := p.EffectiveWindow()
	return !ok || ms >= from && ms < to
}

// Filters is the filters asked, by name (only those asked).
func (p analyticsParams) Filters() map[string]string {
	out := map[string]string{}
	for k, v := range map[string]string{"risk": p.Risk, "app_type": p.AppType, "model": p.Model, "station": p.Station, "wave": p.Wave,
		"outcome": p.Outcome, "provenance": p.Provenance} {
		if v != "" {
			out[k] = v
		}
	}
	return out
}

func floorDay(ms int64) int64 {
	d := ms % dayMS
	if d < 0 {
		d += dayMS
	}
	return ms - d
}

func ceilDay(ms int64) int64 {
	f := floorDay(ms)
	if f == ms {
		return ms
	}
	return f + dayMS
}

func dayOf(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02") }

// parseAnalytics reads the common parameters. route lists the parameters the route reads itself
// (ids, group_by, ...); any other parameter is a 400 naming it. A value outside a fixed set, a
// malformed number or cursor, a window that is empty, or last_runs with a window is a 400 too.
// The cursor (at) is resolved against the log: another generation or ahead is a 409, older than
// what is held a 410 (as /snapshot).
func (s *Server) parseAnalytics(r *http.Request, route map[string]bool) (analyticsParams, int, *Envelope) {
	var p analyticsParams
	q := r.URL.Query()
	bad := func(msg string) (analyticsParams, int, *Envelope) {
		env := fail(KindInvalid, msg)
		return p, http.StatusBadRequest, &env
	}
	names := make([]string, 0, len(q))
	for k := range q {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		if !analyticsCommon[k] && !route[k] {
			return bad("Unknown parameter " + kindQuote(k) + ".")
		}
		if len(q[k]) > 1 {
			return bad("Parameter " + kindQuote(k) + " is given more than once.")
		}
	}
	num := func(name string) (*int64, bool) {
		v := q.Get(name)
		if v == "" {
			return nil, true
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 || n > 999_999_999_999_999 {
			return nil, false
		}
		return &n, true
	}
	var good bool
	if p.FromMS, good = num("from_ms"); !good {
		return bad("from_ms must be a whole number of milliseconds.")
	}
	if p.ToMS, good = num("to_ms"); !good {
		return bad("to_ms must be a whole number of milliseconds.")
	}
	if p.FromMS != nil && p.ToMS != nil && *p.ToMS <= *p.FromMS {
		return bad("The window is empty: to_ms must be after from_ms.")
	}
	if v := q.Get("last_runs"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 100000 {
			return bad("last_runs must be a whole number between 1 and 100000.")
		}
		if p.FromMS != nil || p.ToMS != nil {
			return bad("last_runs and a time window (from_ms, to_ms) cannot be asked together.")
		}
		p.LastRuns = n
	}
	set := func(name string, vals map[string]bool, dst *string) bool {
		v := q.Get(name)
		if v == "" {
			return true
		}
		if vals != nil {
			if !vals[v] {
				return false
			}
		} else if _, ok := ident(v); !ok {
			return false
		}
		*dst = v
		return true
	}
	for _, f := range []struct {
		name string
		vals map[string]bool
		dst  *string
	}{{"risk", analyticsRisks, &p.Risk}, {"app_type", analyticsAppTypes, &p.AppType}, {"outcome", analyticsOutcomes, &p.Outcome},
		{"model", nil, &p.Model}, {"station", nil, &p.Station}, {"wave", nil, &p.Wave}, {"provenance", nil, &p.Provenance}} {
		if !set(f.name, f.vals, f.dst) {
			if f.vals != nil {
				return bad(f.name + " must be one of " + strings.Join(sortedKeys(f.vals), ", ") + ".")
			}
			return bad(f.name + " is not an identifier.")
		}
	}
	if v := q.Get("as_of_ms"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 || n > 999_999_999_999_999 {
			return bad("as_of_ms must be a whole number of milliseconds.")
		}
		p.AsOfMS = &n
	}
	if raw := q.Get("at"); raw != "" {
		pos, cerr := s.resolve(raw, 0)
		if cerr != nil {
			return p, cursorStatus(cerr), &Envelope{Error: cerr}
		}
		p.At, p.AtRaw = pos, raw
	}
	return p, 0, nil
}

// unsupported is a 400 when the request asks a filter or parameter the route cannot honour (never
// silently unfiltered). supported lists what the route honours of the common filters.
func unsupported(p analyticsParams, supported ...string) *Envelope {
	ok := map[string]bool{}
	for _, k := range supported {
		ok[k] = true
	}
	asked := p.Filters()
	if p.LastRuns > 0 {
		asked["last_runs"] = strconv.Itoa(p.LastRuns)
	}
	for _, k := range sortedKeys(asked) {
		if !ok[k] {
			env := fail(KindInvalid, "This route cannot honour "+k+"; it supports "+strings.Join(supported, ", ")+".")
			return &env
		}
	}
	return nil
}

// analyticsAt runs fn on the projection at p.At: the live head under its lock (as s.view) when no
// cursor or the head's own was asked, else a private copy rebuilt at that cursor (410 when it can
// no longer be rebuilt, 409 when it is ahead), and writes the reply.
func (s *Server) analyticsAt(w http.ResponseWriter, p analyticsParams, fn func(st *project.State) (int, Envelope)) {
	if p.At == 0 {
		s.view(w, fn)
		return
	}
	// The head's own position (the cursor every reply at the head carries): the live projection
	// under its lock, as with no cursor, when it is still there; no copy is rebuilt.
	var data []byte
	status, done := http.StatusOK, false
	s.opts.Projector.View(func(st *project.State) {
		if st.Pos != p.At {
			return
		}
		var env Envelope
		status, env = fn(st)
		var bad int
		if data, bad = encode(env); bad != 0 {
			status = bad
		}
		done = true
	})
	if done {
		writeBytes(w, status, data)
		return
	}
	// An earlier position: a private copy rebuilt there, kept (one per server) while the same
	// position is asked again; replies built from it take turns, as a reply may fill a state's caches.
	c := s.atCache()
	c.mu.Lock()
	defer c.mu.Unlock()
	st := c.st
	if st == nil || st.Pos != p.At || st.Epoch != s.opts.Log.Epoch() {
		var err error
		st, _, err = s.opts.Projector.At(p.At)
		if e := s.atError(err); e != nil {
			writeJSON(w, cursorStatus(e), Envelope{Error: e})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, fail(KindInternal, "The projection at that cursor could not be built."))
			return
		}
		c.st = st
	}
	status, env := fn(st)
	data, bad := encode(env)
	if bad != 0 {
		status = bad
	}
	writeBytes(w, status, data)
}

// atCacheEntry is the last projection rebuilt at a cursor for the analytics routes.
type atCacheEntry struct {
	mu sync.Mutex
	st *project.State
}

var atCaches sync.Map // *Server -> *atCacheEntry

func (s *Server) atCache() *atCacheEntry {
	c, _ := atCaches.LoadOrStore(s, &atCacheEntry{})
	return c.(*atCacheEntry)
}

// atError maps Projector.At's errors as /snapshot does (nil for any other error).
func (s *Server) atError(err error) *Error {
	floor, head := s.opts.Log.Bounds()
	state := &CursorState{Generation: s.opts.Log.Epoch(), Floor: s.cursor(floor), Head: s.cursor(head)}
	switch {
	case errors.Is(err, project.ErrNotHeld):
		state.Reason = "expired"
		return &Error{Kind: KindCursorExpired, Message: "The state at that cursor can no longer be rebuilt; ask at a later cursor.", Cursor: state}
	case errors.Is(err, feed.ErrFuture):
		state.Reason = "ahead"
		return &Error{Kind: KindCursorReset, Message: "The cursor is ahead of the observer's log.", Cursor: state}
	}
	return nil
}

// analyticsEnvelope is the contract's common reply fields at the state st was read at: cursor,
// projection, generated_ms, window, filters, history. A route adds its own keys to the map.
func (s *Server) analyticsEnvelope(st *project.State, p analyticsParams) map[string]any {
	return analyticsEnvelopeAt(s, st.Epoch, st.Pos, st, p)
}

// analyticsEnvelopeAt is analyticsEnvelope for a reply built at pos (a timeline may stand for the
// head; st is the state it was built from).
func analyticsEnvelopeAt(s *Server, epoch string, pos uint64, st *project.State, p analyticsParams) map[string]any {
	window := map[string]any{"from_ms": p.FromMS, "to_ms": p.ToMS, "effective_from_ms": nil, "effective_to_ms": nil, "last_runs": nil}
	lo, hi := int64(0), int64(1)<<62
	if from, to, ok := p.EffectiveWindow(); ok {
		lo, hi = from, to
		if p.FromMS != nil {
			window["effective_from_ms"] = from
		}
		if p.ToMS != nil || p.AsOfMS != nil && !p.Exact {
			window["effective_to_ms"] = to // with as_of_ms on a day-celled route: the start of the as_of day
		}
	}
	if p.LastRuns > 0 {
		window["last_runs"] = p.LastRuns
	}
	facts := project.HistoryFacts(st)
	lost, _ := facts["lost"].(map[string]int64)
	gaps := []map[string]any{}
	for _, g := range st.Gaps {
		if !g.Lost {
			continue
		}
		var at any
		if g.At != nil {
			at = project.StampMS(g.At)
		}
		gaps = append(gaps, map[string]any{"class": g.Class, "at_ms": at, "count": g.Count})
	}
	// from_ms: the first event the observer holds (its order time, floored to the minute, as the
	// store keeps it); null when nothing is held or the log cannot say.
	var from any
	if sr, ok := s.opts.Log.(feed.Serieser); ok {
		if lo, _ := sr.SeriesBounds(); lo > 0 {
			from = lo - lo%60_000
		}
	}
	cursor := feed.Cursor{Epoch: epoch, Pos: pos}.String()
	var asOf any
	if p.AsOfMS != nil {
		if p.Exact {
			asOf = map[string]any{"ms": *p.AsOfMS, "exact": true, "effective_to_ms": *p.AsOfMS,
				"rule": "nothing whose establishing record is later than ms is counted or listed; what was open then is open"}
		} else {
			asOf = map[string]any{"ms": *p.AsOfMS, "exact": false, "effective_to_ms": floorDay(*p.AsOfMS),
				"rule": "whole UTC days before the playhead; the day of the playhead is not included"}
		}
	}
	return map[string]any{
		"as_of":        asOf,
		"cursor":       cursor,
		"projection":   map[string]any{"format": project.FormatVersion, "definitions": metrics.DefinitionsVersion},
		"generated_ms": s.opts.Now().UnixMilli(),
		"window":       window,
		"filters":      p.Filters(),
		"history": map[string]any{
			"complete":        len(lost) == 0 && st.Partial == "",
			"complete_window": !project.HistoryLostIn(st, lo, hi),
			"from_ms":         from,
			"from_precision":  "minute",
			"partial":         st.Partial,
			"gaps":            gaps,
			"sources":         s.sourceFacts(st, p),
		},
	}
}

// sourceFacts are history.sources: per source class, the newest event's time and the events the
// projection applied (at its cursor, as of as_of_ms when asked; hour precision then), and when the
// observer last read a file of that class (the observer's own clock now: not a time-travel value).
func (s *Server) sourceFacts(st *project.State, p analyticsParams) []project.SourceFact {
	facts := project.SourceFacts(st, p.AsOfMS)
	read := map[string]int64{}
	for _, src := range s.ingestState().Sources {
		class := project.SourceClassOfKey(src.Key)
		if class == "" || src.LastReadAt.IsZero() {
			continue
		}
		read[class] = max(read[class], src.LastReadAt.UnixMilli())
	}
	for i := range facts {
		if ms, ok := read[facts[i].Source]; ok {
			facts[i].LastReadMS = &ms
		} else {
			facts[i].Reason = append(facts[i].Reason, "not-read")
		}
	}
	return facts
}
