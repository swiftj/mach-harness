package server

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"mach/observer/internal/project"
)

// The Execution Timeline's routes (M6_3_DESIGN.md section 6): spans, concurrency and marks, all
// GET, all derived from the projection under its lock, none writing anything.

// Marks limits.
const (
	DefaultMarks = 200
	MaxMarks     = 1000
)

var spanKinds = map[string]bool{"wave": true, "slice-wait": true, "slice-eligible": true, "capacity-wait": true, "cell": true, "round": true, "visit": true,
	"gate-wait": true, "person-wait": true, "seat": true, "claim": true, "execution": true, "workflow": true, "agent-queue": true, "agent": true, "tool": true, "task": true}

var markKinds = func() map[string]bool {
	m := map[string]bool{}
	for _, k := range project.MarkKinds {
		m[k] = true
	}
	return m
}()

// msParam reads an optional whole number of milliseconds.
func msParam(q url.Values, name string) (*int64, *Envelope) {
	v := q.Get(name)
	if v == "" {
		return nil, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < 0 || n > 999_999_999_999_999 {
		env := fail(KindInvalid, name+" must be a whole number of milliseconds.")
		return nil, &env
	}
	return &n, nil
}

// kindsParam reads a comma-separated list of kinds from a known set.
func kindsParam(q url.Values, known map[string]bool, what string) (map[string]bool, *Envelope) {
	k := q.Get("kinds")
	if k == "" {
		return nil, nil
	}
	out := map[string]bool{}
	for _, kind := range strings.Split(k, ",") {
		if !known[kind] {
			env := fail(KindInvalid, "unknown "+what+" kind "+kindQuote(kind)+".")
			return nil, &env
		}
		out[kind] = true
	}
	return out, nil
}

// spans: GET /api/v1/spans?ticket|execution|wave|entity|span&kinds&from_ms&to_ms&sort=start&limit&offset
// Sorted by start (earliest bound); at most MaxSpans after filtering, and a cut is said
// (truncated, total_uncapped).
func (s *Server) spans(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	bad := func(env Envelope) { writeJSON(w, http.StatusBadRequest, env) }
	var f project.SpanFilter
	var e *Envelope
	for _, p := range []struct {
		name string
		dst  *string
	}{{"ticket", &f.Ticket}, {"execution", &f.Execution}, {"wave", &f.Wave}} {
		if *p.dst, e = optIdent(q, p.name); e != nil {
			bad(*e)
			return
		}
	}
	f.Entity, f.SpanID = q.Get("entity"), q.Get("span")
	if len(f.Entity) > 300 || len(f.SpanID) > 400 || strings.ContainsAny(f.Entity+f.SpanID, "\x00\n\r") {
		bad(fail(KindInvalid, "entity or span is too long or not plain text."))
		return
	}
	if v := q.Get("sort"); v != "" && v != "start" {
		bad(fail(KindInvalid, "sort may only be start."))
		return
	}
	if f.Kinds, e = kindsParam(q, spanKinds, "span"); e != nil {
		bad(*e)
		return
	}
	if f.FromMS, e = msParam(q, "from_ms"); e != nil {
		bad(*e)
		return
	}
	if f.ToMS, e = msParam(q, "to_ms"); e != nil {
		bad(*e)
		return
	}
	if f.FromMS != nil && f.ToMS != nil && *f.ToMS < *f.FromMS {
		bad(fail(KindInvalid, "The window is empty: to_ms must not be before from_ms."))
		return
	}
	limit, e := pageLimit(r, MaxPage)
	if e != nil {
		bad(*e)
		return
	}
	off, e := offset(r)
	if e != nil {
		bad(*e)
		return
	}
	s.view(w, func(st *project.State) (int, Envelope) {
		all := project.Spans(st, f)
		uncapped := len(all)
		if len(all) > MaxSpans {
			all = all[:MaxSpans]
		}
		v := pageOf(all, off, limit, s.cursor(st.Pos))
		v["truncated"], v["total_uncapped"], v["sort"] = uncapped > MaxSpans, uncapped, "start"
		v["basis_vocabulary"] = []string{"measured", "bounded", "inferred", "open", "unknown"}
		v["live_ms"] = st.LastMS
		return http.StatusOK, ok(v)
	})
}

// concurrency: GET /api/v1/concurrency?from_ms&to_ms&bucket_ms&kinds
// Per bucket and span kind, the most and the mean number of spans active, with the Factory's
// recorded limits. Bucket rules are /series's.
func (s *Server) concurrency(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	invalid := func(msg string) { writeJSON(w, http.StatusBadRequest, fail(KindInvalid, msg)) }
	var e *Envelope
	from, e := msParam(q, "from_ms")
	if e == nil {
		var to, bucket *int64
		if to, e = msParam(q, "to_ms"); e == nil {
			if bucket, e = msParam(q, "bucket_ms"); e == nil {
				var kinds map[string]bool
				if kinds, e = kindsParam(q, spanKinds, "span"); e == nil {
					s.concurrencyReply(w, from, to, bucket, kinds, invalid)
					return
				}
			}
		}
	}
	writeJSON(w, http.StatusBadRequest, *e)
}

func (s *Server) concurrencyReply(w http.ResponseWriter, fromP, toP, bucketP *int64, kinds map[string]bool, invalid func(string)) {
	if bucketP != nil && (*bucketP < 1000 || *bucketP%1000 != 0) {
		invalid("bucket_ms must be a whole number of seconds (at least 1000).")
		return
	}
	if fromP != nil && toP != nil && *toP <= *fromP {
		invalid("The range is empty: to_ms must be after from_ms.")
		return
	}
	s.view(w, func(st *project.State) (int, Envelope) {
		lo, hi, _ := project.SpanExtent(st)
		from, to := lo, hi+1
		if fromP != nil {
			from = *fromP
		}
		if toP != nil {
			to = *toP
		}
		if to <= from {
			to = from + 1
		}
		var bucket int64
		if bucketP != nil {
			bucket = *bucketP
		} else {
			bucket = seriesSteps[len(seriesSteps)-1]
			for _, step := range seriesSteps {
				if (to-from+step-1)/step <= DefaultSeriesBuckets {
					bucket = step
					break
				}
			}
			if fromP == nil {
				from -= from % bucket
			}
		}
		if n := (to - from + bucket - 1) / bucket; n > MaxSeriesBuckets {
			return http.StatusBadRequest, fail(KindInvalid, fmt.Sprintf("That would be %d buckets; at most %d. Ask for a larger bucket_ms or a shorter range.", n, MaxSeriesBuckets))
		}
		return http.StatusOK, ok(map[string]any{
			"from_ms": from, "to_ms": to, "bucket_ms": bucket, "buckets": project.Concurrency(st, from, to, bucket, kinds),
			"limits": project.Limits(st), "complete": !project.HistoryLostIn(st, from, to), "live_ms": st.LastMS, "cursor": s.cursor(st.Pos),
			"rules": "active over [start's earliest bound, end's latest bound); an open span until live_ms; mean is time-weighted over the bucket",
		})
	})
}

// marks: GET /api/v1/marks?from_ms&to_ms | after_ms | before_ms &kinds&limit
// In a window, ascending by time; after_ms (strictly after) ascending and before_ms (strictly
// before) descending, so the nearest mark is first.
func (s *Server) marks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	bad := func(env Envelope) { writeJSON(w, http.StatusBadRequest, env) }
	var f project.MarkFilter
	var e *Envelope
	for _, p := range []struct {
		name string
		dst  **int64
	}{{"from_ms", &f.FromMS}, {"to_ms", &f.ToMS}, {"after_ms", &f.AfterMS}, {"before_ms", &f.BeforeMS}} {
		if *p.dst, e = msParam(q, p.name); e != nil {
			bad(*e)
			return
		}
	}
	if f.AfterMS != nil && f.BeforeMS != nil {
		bad(fail(KindInvalid, "Ask for marks after_ms or before_ms, not both."))
		return
	}
	if f.Kinds, e = kindsParam(q, markKinds, "mark"); e != nil {
		bad(*e)
		return
	}
	limit := DefaultMarks
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > MaxMarks {
			bad(fail(KindInvalid, "limit must be between 1 and "+strconv.Itoa(MaxMarks)+"."))
			return
		}
		limit = n
	}
	order := "ascending"
	if f.BeforeMS != nil {
		order = "descending"
	}
	s.view(w, func(st *project.State) (int, Envelope) {
		items, total := project.Marks(st, f, limit)
		return http.StatusOK, ok(map[string]any{"items": items, "total": total, "truncated": total > len(items), "order": order,
			"kinds": project.MarkKinds, "cursor": s.cursor(st.Pos), "live_ms": st.LastMS})
	})
}
