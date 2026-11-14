package metrics

import (
	"math"
	"slices"
)

// ValueCap is how many measured durations a cell keeps besides its histogram: up to it, a
// percentile is exact; beyond it the cell keeps the histogram only.
const ValueCap = 512

// Pct is one percentile as every analytics route serves it (metrics, flow, insights read it
// through Percentile only, so two places can never disagree for the same population).
type Pct struct {
	Value float64
	// Basis is "exact" (nearest rank over every measured duration) or "histogram" (interpolated
	// inside the log-histogram bucket that holds the rank; Lo and Hi are that bucket's bounds).
	Basis  string
	Lo, Hi float64
}

// Percentile is the q-th percentile of a population of measured durations. sorted holds every
// value in ascending order when the population is known exactly (nil otherwise); hist is the full
// histogram (Buckets long), count the population, lo and hi its observed minimum and maximum.
// Exact: the nearest rank, the value at ceil(q * n). From the histogram: the bucket holding that
// rank, interpolated linearly by the rank's place in it, clamped to [lo, hi], with the bucket's
// bounds. ok is false for an empty population.
func Percentile(sorted []int64, hist []int64, count int64, lo, hi float64, q float64) (Pct, bool) {
	if count <= 0 {
		return Pct{}, false
	}
	rank := max(int64(math.Ceil(q*float64(count))), 1)
	if int64(len(sorted)) == count {
		v := float64(sorted[min(rank, count)-1])
		return Pct{Value: v, Basis: "exact", Lo: v, Hi: v}, true
	}
	var seen int64
	for i, n := range hist {
		if n == 0 {
			continue
		}
		if seen+n >= rank {
			bl, bu := max(lower(i), lo), min(upper(i), hi)
			if bu < bl {
				bu = bl
			}
			frac := (float64(rank-seen) - 0.5) / float64(n)
			v := bl + frac*(bu-bl)
			return Pct{Value: math.Round(v), Basis: "histogram", Lo: math.Round(bl), Hi: math.Round(bu)}, true
		}
		seen += n
	}
	return Pct{}, false
}

// complete reports whether the cell holds every measured value.
func (a *Agg) complete() bool { return int64(len(a.Vals)) == a.Count }

// sortedVals is the cell's measured values in order when it holds all of them (nil otherwise).
func (a *Agg) sortedVals() []int64 {
	if a.Count == 0 || !a.complete() {
		return nil
	}
	v := slices.Clone(a.Vals)
	slices.Sort(v)
	return v
}
