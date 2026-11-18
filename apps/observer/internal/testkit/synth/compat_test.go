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
// the M6.3 performance work and the browser suite stay reproducible.
var compatGolden = []struct {
	name   string
	opts   synth.Options
	digest string
	sum    string
}{
	{"twelve cells, seed 7", synth.Options{Cells: 12, Events: 5000, Seed: 7, Hours: 30, AgentsPerExecution: 24},
		"2b64711568a06fe1914c5cfdcc3179d789b4e4c39bdb40c3967ae3ba9b9ff176", "9b13e5a68f9cdafa70f899918d88ae47e4554151b0763ec070fa1bdb3be98d42"},
	{"twenty cells, seed 3", synth.Options{Cells: 20, Events: 9000, Seed: 3, Hours: 12, AgentsPerExecution: 12},
		"ffc1805d4126ae1973d40d12d4c3d27b6d11148ae09e4b431e7e63ba280b9878", "2a505d1f5397a1696cc9818283167714f84353048bc12011806e78c73513e58d"},
	// The default history (mach-synth with no options but --out): the Timeline's 220,000 events.
	{"the default history", synth.Options{Seed: 1},
		"00dad56cc13f1f9151bbecfb97fada8f0a4c1b5a291ab17b2d49e60afeb16f4f", "2349d091028f841be7987582e8d09832c3480f0e9404003bcfc62e7d14603ac7"},
	// The analytics mode's default profile, recorded before --profile realistic was added: tiny,
	// medium and a third shape, as mach-synth --analytics writes them. Re-recorded for M11: a run
	// record's product block names its epic and source and no wave, as cleanup.py writes it.
	{"analytics tiny", synth.Options{Analytics: true, Cells: 2, Waves: 1, Seed: 1},
		"66e5e9b40549af13a15c832a18e39dd5d9ab62b030e7339204853a9ace457bfd", "576fe4de05df146dd04f05f8d55c88830ed1f55bdf6169a6ec525620013cb52c"},
	{"analytics medium", synth.Options{Analytics: true, Cells: 60, Waves: 8, Seed: 1},
		"9ce1728123e829953d8a88e5971e3b9a1fbbdacd3126c6607ba972f890cdbd3c", "983a2ad61d7fae89302debb029cd3aa2567541f61543b85b1c4978a2e95c8f49"},
	{"analytics thirty cells, seed 5", synth.Options{Analytics: true, Cells: 30, Waves: 4, Seed: 5},
		"c37021dbf3d629889caca8d0f092247be249d418e6bd60491fea9b6dfc246738", "86ce36463aa00f3a934ec57c1142811013e5cb63f78e7ea5cc73824867a31610"},
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
