package synth_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"testing"

	"mach/observer/internal/testkit"
	"mach/observer/internal/testkit/synth"
)

// treeDigest is one hash over every generated file's path and content, in path order.
func treeDigest(t *testing.T, root string) string {
	t.Helper()
	files := contents(t, root)
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	h := sha256.New()
	for _, n := range names {
		h.Write([]byte(n + "\x00" + files[n] + "\n"))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// The outputs of the Timeline-era options, recorded before the analytics mode was added. Without
// --analytics the generator must keep producing exactly these bytes, so histories already used by
// the M6.3 performance work and the browser suite stay reproducible. Every digest was re-recorded
// for M11's epics: intake lines of version 3 with epic_id and issue, no wave.discovered, ledger
// slices that name their epic, and cell.json product blocks with epic_id (run records unchanged).
var compatGolden = []struct {
	name   string
	opts   synth.Options
	digest string
	sum    string
}{
	{"twelve cells, seed 7", synth.Options{Cells: 12, Events: 5000, Seed: 7, Hours: 30, AgentsPerExecution: 24},
		"4b291b580f45ff36e6d38f246edf583aa2ea6201c21742769c4bbdb9d4390858", "682e04a90a4a15878ccdaed94b008b6cbf2d81064f85b6cdb90f4e08c5d0e1d0"},
	{"twenty cells, seed 3", synth.Options{Cells: 20, Events: 9000, Seed: 3, Hours: 12, AgentsPerExecution: 12},
		"4e990060cd76b2731b6a44931971964dc7cc7d39c2f0ab50235e878602dd45d5", "2258cc9f36e799c7755415f5c5e7f208c5f7d38d4b84c774e0ec3303f20e536c"},
	// The default history (mach-synth with no options but --out): the Timeline's 220,000 events.
	{"the default history", synth.Options{Seed: 1},
		"c618fe0e3512a587468d4f8fe8703135c521c47fd1f9c45b545136a4955ff879", "ed8f864ad8fbdc1899303e05dc6677f11381b8da6ce7cdbc80d99894c6516f27"},
	// The analytics mode's default profile, recorded before --profile realistic was added: tiny,
	// medium and a third shape, as mach-synth --analytics writes them. Re-recorded for M11: a run
	// record's product block names its epic and source and no epic, as cleanup.py writes it.
	{"analytics tiny", synth.Options{Analytics: true, Cells: 2, Epics: 1, Seed: 1},
		"7404eac6eb8ea15c1e046c43dc391551db2562cbb8af3f8b401a510192af725b", "ff98a6691438da7bcad451cea0e4f74a19d3e755ebf4141da2e6cbbf23d6e392"},
	{"analytics medium", synth.Options{Analytics: true, Cells: 60, Epics: 8, Seed: 1},
		"5da9d41341fd434bbffff89f58ad07b34b0d381d5144971e20e0e5dec9845e70", "d89cf320a05ed028d172e162fb5f94146da354adf6ae3cc93e5235cfe8332c1e"},
	{"analytics thirty cells, seed 5", synth.Options{Analytics: true, Cells: 30, Epics: 4, Seed: 5},
		"ad64d49269c1c7710cfdda74d955e6dcb82bd4c17f358109d3274a88708fc819", "fa5eb29d9d7380617260406a855bcb154b508ebc6464edb490d4edb53f2522ab"},
}

// TestCompatibleWithoutAnalytics: the same options and seed give byte-identical files and the same
// summary as before the analytics mode existed, and the analytics mode's default profile as before
// the realistic profile existed.
func TestCompatibleWithoutAnalytics(t *testing.T) {
	for _, c := range compatGolden {
		if c.opts.Cells == 0 && (testing.Short() || testkit.Race) {
			continue // the full default history takes seconds; -short and the race detector skip it
		}
		dir := t.TempDir()
		o := c.opts
		o.Out = dir
		sum, err := synth.Generate(o)
		if err != nil {
			t.Fatal(err)
		}
		got := treeDigest(t, dir)
		b, _ := json.Marshal(sum)
		s := sha256.Sum256(b)
		t.Logf("%s: files %s summary %s", c.name, got, hex.EncodeToString(s[:]))
		if got != c.digest {
			t.Errorf("%s: the generated files changed (digest %s, want %s)", c.name, got, c.digest)
		}
		if hs := hex.EncodeToString(s[:]); hs != c.sum {
			t.Errorf("%s: the summary changed (digest %s, want %s)", c.name, hs, c.sum)
		}
	}
}
