package project

import (
	"sort"
	"strconv"
)

// Waits the projection no longer keeps one by one (the oldest beyond maxCapacityWaits and
// maxWaitsPerSlice) are folded into per-day flow cells as they are dropped (CAPACITY_SPEC.md), so
// the flow totals count every wait and only the contributor list is bounded. The cell's dims (risk,
// app type, wave) and the station entered next are fixed when the wait is dropped.

// WaitCell is a mergeable, encodable aggregate of dropped waits of one kind, day, dims and next station.
type WaitCell struct {
	Kind            string   `json:"kind"`
	Day             int64    `json:"day"`
	Risk            string   `json:"risk,omitempty"`
	AppType         string   `json:"app_type,omitempty"`
	Wave            string   `json:"wave,omitempty"`
	Next            string   `json:"next,omitempty"`
	Basis           [5]int64 `json:"basis"`
	Measured        []int64  `json:"measured"`
	BoundMin        int64    `json:"bound_min"`
	BoundMax        int64    `json:"bound_max"`
	BoundNoMax      int64    `json:"bound_no_max"`
	InferMax        int64    `json:"infer_max"`
	InferNoMax      int64    `json:"infer_no_max"`
	Tickets         []string `json:"tickets"`
	MeasuredTickets []string `json:"measured_tickets"`
	NoTicket        int64    `json:"no_ticket"`
}

func addSorted(list []string, v string) []string {
	i := sort.SearchStrings(list, v)
	if i < len(list) && list[i] == v {
		return list
	}
	list = append(list, "")
	copy(list[i+1:], list[i:])
	list[i] = v
	return list
}

// foldDroppedWait adds one dropped wait (from start to end, end nil while open) to its cell.
func (s *State) foldDroppedWait(kind, ticket, wave string, start, end *Stamp) {
	if start == nil && end == nil {
		return
	}
	edge := start
	if edge == nil {
		edge = end
	}
	from, ok := edge.lo()
	if !ok {
		from = edge.OrderMS
	}
	risk, app := "", ""
	if td := TicketDims(s, ticket); td != nil {
		risk, app = td["risk"], td["app_type"]
		if td["wave"] != "" {
			wave = td["wave"]
		}
	}
	next := ""
	if c := s.Cells[ticket]; c != nil && ticket != "" {
		best := int64(1) << 62
		for _, v := range c.Visits {
			if v.Entered == nil {
				continue
			}
			lo, ok := v.Entered.lo()
			if !ok {
				lo = v.Entered.OrderMS
			}
			if lo >= from && lo < best {
				best, next = lo, orDefault(v.Station, "unknown")
			}
		}
	}
	day := flowDay(from)
	key := kind + "|" + strconv.FormatInt(day, 10) + "|" + risk + "|" + app + "|" + wave + "|" + next
	if s.DroppedWaits == nil {
		s.DroppedWaits = map[string]*WaitCell{}
	}
	c := s.DroppedWaits[key]
	if c == nil {
		c = &WaitCell{Kind: kind, Day: day, Risk: risk, AppType: app, Wave: wave, Next: next, Measured: []int64{}, Tickets: []string{}, MeasuredTickets: []string{}}
		s.DroppedWaits[key] = c
	}
	d := between(start, end, false)
	c.Basis[basisIndex(d.Basis)]++
	switch d.Basis {
	case "measured":
		if d.MS != nil {
			c.Measured = append(c.Measured, *d.MS)
		}
		if ticket != "" {
			c.MeasuredTickets = addSorted(c.MeasuredTickets, ticket)
		}
	case "bounded":
		if d.MinMS != nil {
			c.BoundMin += *d.MinMS
		}
		if d.MaxMS != nil {
			c.BoundMax += *d.MaxMS
		} else {
			c.BoundNoMax++
		}
	case "inferred":
		if d.MaxMS != nil {
			c.InferMax += *d.MaxMS
		} else {
			c.InferNoMax++
		}
	}
	if ticket == "" {
		c.NoTicket++
	} else {
		c.Tickets = addSorted(c.Tickets, ticket)
	}
}

// dropCapacity folds execution-capacity waits about to be dropped.
func (s *State) dropCapacity(ws []CapacityWait) {
	for _, w := range ws {
		s.foldDroppedWait(WaitCapacity, w.TicketID, "", w.Opened, w.Released)
	}
}

// dropSliceCapacity folds slice-capacity waits about to be dropped.
func (s *State) dropSliceCapacity(ws []*SliceCapacityWait) {
	for _, w := range ws {
		ticket := ""
		if sl := s.Slices[w.SliceID]; sl != nil {
			ticket = sl.TicketID
		}
		s.foldDroppedWait(WaitCapacitySlice, ticket, w.WaveID, w.Opened, w.Released)
	}
}

// dropDependency folds a slice's dependency waits about to be dropped.
func (s *State) dropDependency(sl *Slice, ws []*DependencyWait) {
	for _, w := range ws {
		end := w.Resolved
		if end == nil {
			end = w.Superseded
		}
		s.foldDroppedWait(WaitDependency, sl.TicketID, sl.WaveID, w.Blocked, end)
	}
}

// durAggOf is a dropped-wait cell as the flow index's aggregate.
func durAggOf(c *WaitCell) *durAgg {
	a := &durAgg{basis: c.Basis, measured: append([]int64(nil), c.Measured...), boundMin: c.BoundMin, boundMax: c.BoundMax, boundNoMax: c.BoundNoMax,
		inferMax: c.InferMax, inferNoMax: c.InferNoMax, noTicket: c.NoTicket}
	for _, t := range c.Tickets {
		a.ticket(t)
	}
	if len(c.MeasuredTickets) > 0 {
		a.measuredTix = map[string]struct{}{}
		for _, t := range c.MeasuredTickets {
			a.measuredTix[t] = struct{}{}
		}
	}
	return a
}
