package synth_test

import (
	"path/filepath"
	"strconv"
	"testing"

	"mach/observer/internal/testkit/synth"
)

// M6.6 F7: every size the options accept generates; --cells 4 to 7 panicked (index out of range).
func TestSmallWorldsGenerate(t *testing.T) {
	for n := 4; n <= 8; n++ {
		dir := filepath.Join(t.TempDir(), "p"+strconv.Itoa(n))
		if _, err := synth.Generate(synth.Options{Out: dir, Cells: n, Events: 2000, Seed: 7, Hours: 6, AgentsPerExecution: 12}); err != nil {
			t.Fatalf("--cells %d: %v", n, err)
		}
	}
}
