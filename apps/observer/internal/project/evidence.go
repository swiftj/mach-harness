package project

import (
	"path"
	"strings"
)

// LinkArtifact joins one of a cell's artifacts to the station visit it belongs to (D12 of the
// M6.2 acceptance). Recorded first: a verification check that names this file with this hash is
// the lifecycle saying which visit verified it ("recorded", rule "check-hash"). Otherwise the
// observer infers it from the round and the file's time: the visit of the artifact's station
// (verify for evidence/, review for review/) in that round that had begun when the file was last
// written, the latest such ("reconstructed", rule "round-and-time"); with no usable time, the
// round's last visit ("reconstructed", rule "round"). It returns "" when nothing fits.
func LinkArtifact(c *Cell, rel, sha string, round *int64, modMS int64) (visit, basis, rule string) {
	if c == nil {
		return "", "", ""
	}
	station := "verify"
	if strings.HasPrefix(rel, "review/") {
		station = "review"
	} else if !strings.HasPrefix(rel, "evidence/") {
		return "", "", ""
	}
	if station == "verify" && sha != "" {
		name := path.Base(rel)
		for _, k := range c.Checks {
			for _, ev := range k.Evidence {
				if ev.SHA256 == sha && path.Base(ev.File) == name && k.VisitID != "" {
					return k.VisitID, "recorded", "check-hash"
				}
			}
		}
	}
	if round == nil {
		return "", "", ""
	}
	last, best := "", ""
	var bestAt int64
	for _, v := range c.Visits {
		if v.Station != station || v.Round == nil || *v.Round != *round {
			continue
		}
		last = v.VisitID
		at, ok := v.Entered.lo()
		// A file is written during its visit: allow a second for a file time rounded down.
		if ok && modMS > 0 && at <= modMS+1000 && (best == "" || at >= bestAt) {
			best, bestAt = v.VisitID, at
		}
	}
	switch {
	case best != "":
		return best, "reconstructed", "round-and-time"
	case last != "":
		return last, "reconstructed", "round"
	}
	return "", "", ""
}
