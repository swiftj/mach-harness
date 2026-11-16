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
	// medium and a third shape, as mach-synth --analytics writes them.
	{"analytics tiny", synth.Options{Analytics: true, Cells: 2, Waves: 1, Seed: 1},
		"57b76cd821bc7b9d8c1f85d8e0c0ea3cb5fce5b737d22d5b2fc060be8f972ab3", "513ebb67c32f672ef740ccfef01c3ba99a47a5d66a2b106f84ffa1a0fcd09e54"},
	{"analytics medium", synth.Options{Analytics: true, Cells: 60, Waves: 8, Seed: 1},
		"7b4a6abaf394933d259f456201c7414cfa6beee839388c2621b7ded02bec46a3", "5532c2c7c76792ce50b60e13b74b4c7af986209b0f1e8d4bebe7f566b9ff803a"},
	{"analytics thirty cells, seed 5", synth.Options{Analytics: true, Cells: 30, Waves: 4, Seed: 5},
		"6399f5ea21bc02a4e663c27d3ff7b1b656d1e83e7c03fcb210f3fcd129c36d35", "994b0e1b4a47b86e9c16607b70875a2099b15084df464b28c3e29e6d120ab8ad"},
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
