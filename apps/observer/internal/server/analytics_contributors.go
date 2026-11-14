package server

import (
	"net/http"
	"slices"
	"strconv"
	"strings"

	"mach/observer/internal/project"
)

// Contributor limits.
const (
	DefaultContributors = 100
	MaxContributors     = 500
)

// analyticsContributors: GET /api/v1/analytics/contributors?metric=&group=dim:code[,dim:code]
// &order=impact|recent&limit= (M6_5_DESIGN.md 3.3). The entities behind a figure, as entity refs,
// with identifiers, codes and numbers only.
func (s *Server) analyticsContributors(w http.ResponseWriter, r *http.Request) {
	p, status, bad := s.parseAnalytics(r, map[string]bool{"metric": true, "group": true, "order": true, "limit": true})
	if bad != nil {
		writeJSON(w, status, *bad)
		return
	}
	p.Exact = true // as_of_ms cuts records, spans and executions exactly
	q := r.URL.Query()
	invalid := func(msg string) { writeJSON(w, http.StatusBadRequest, fail(KindInvalid, msg)) }
	id := q.Get("metric")
	fig, known := project.ContributorFigures[id]
	if !known {
		names := make([]string, 0, len(project.ContributorFigures))
		for k := range project.ContributorFigures {
			names = append(names, k)
		}
		slices.Sort(names)
		invalid("metric must be one of " + strings.Join(names, ", ") + ".")
		return
	}
	cq := project.ContributorQuery{Risk: p.Risk, AppType: p.AppType, Wave: p.Wave, Group: map[string]string{}, Order: "impact", Limit: DefaultContributors}
	if v := q.Get("order"); v != "" {
		if v != "impact" && v != "recent" {
			invalid("order must be impact or recent.")
			return
		}
		cq.Order = v
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > MaxContributors {
			invalid("limit must be between 1 and " + strconv.Itoa(MaxContributors) + ".")
			return
		}
		cq.Limit = n
	}
	dims := map[string]bool{}
	for _, d := range fig.Dimensions {
		dims[d] = true
	}
	if v := q.Get("group"); v != "" {
		for _, part := range strings.Split(v, ",") {
			k, code, found := strings.Cut(part, ":")
			if !found || !dims[k] {
				invalid("group must be dimension:code pairs; " + id + " has the dimensions " + strings.Join(fig.Dimensions, ", ") + ".")
				return
			}
			if _, good := ident(code); !good {
				invalid("The code for " + k + " is not an identifier.")
				return
			}
			if _, dup := cq.Group[k]; dup {
				invalid("group names " + k + " twice.")
				return
			}
			cq.Group[k] = code
		}
	}
	// station and model filters become the matching dimension, when the figure has it.
	for name, v := range map[string]string{"station": p.Station, "model": p.Model} {
		if v == "" {
			continue
		}
		if !dims[name] {
			invalid("This figure cannot be filtered by " + name + ".")
			return
		}
		if g, dup := cq.Group[name]; dup && g != v {
			invalid(name + " and group disagree.")
			return
		}
		cq.Group[name] = v
	}
	supported := []string{"risk", "app_type", "wave", "station", "model"}
	if project.RunFigures[id] {
		supported = append(supported, "last_runs")
		cq.LastRuns = p.LastRuns
	}
	if e := unsupported(p, supported...); e != nil {
		writeJSON(w, http.StatusBadRequest, *e)
		return
	}
	ix, status, bad := s.flowIndex(p)
	if bad != nil {
		writeJSON(w, status, *bad)
		return
	}
	cq.From, cq.To, cq.Window = p.EffectiveWindow()
	page := ix.Contributors(id, cq)
	env := analyticsEnvelopeAt(s, ix.Epoch, ix.Pos, ix.State(), p)
	env["metric"], env["group"], env["figure"] = id, cq.Group, page.Figure
	env["items"], env["total"], env["truncated"], env["by_basis"], env["order"], env["limit"] = page.Items, page.Total, page.Truncated, page.ByBasis, page.Order, page.Limit
	env["rules"] = []string{
		"identifiers, codes and numbers only: no title, reason or finding text",
		"an item is placed in a window by at_ms (its start, or the record's time)",
		"value is null when the duration was not measured (min_ms and max_ms say what is known) or not recorded",
		"impact orders by value, then by the upper bound; recent by at_ms",
	}
	writeJSON(w, http.StatusOK, ok(env))
}
