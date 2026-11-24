package artifact

import (
	"math"
	"os"
)

// The join's moment (M22): the build station records in build.json's lanes block when a join
// started (join_started_at) and, until the join has its result, which process is doing it
// (join_running: its process ID and host). A join whose process is gone never finished; it can be
// run again. The process ID and host are only checked here, never served.

// hostName is this machine's name, as the build station records it (Python's platform.node()).
var hostName = func() string {
	name, err := os.Hostname()
	if err != nil {
		return ""
	}
	return name
}

// processAlive says whether a process is running on this machine; known is false when that cannot
// be told here. Replaced in tests.
var processAlive = aliveOnThisSystem

// joinState is "running", "interrupted" or "unknown" for a join the station recorded as under way.
func joinState(pid, host any) string {
	h, okH := host.(string)
	f, okP := pid.(float64)
	if !okH || !okP || f != math.Trunc(f) || f < 1 || f > math.MaxInt32 {
		return "unknown"
	}
	here := hostName()
	if here == "" || h != here {
		return "unknown"
	}
	alive, known := processAlive(int(f))
	switch {
	case !known:
		return "unknown"
	case alive:
		return "running"
	default:
		return "interrupted"
	}
}
