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
		"daa388a20f4ccca1864fb8f4aff98cd522fda9fc99e71e9588e61665c2c7ca00", "4a5307c1a91bc9121a0a98df41a3107d6b9a7037bd7f8d4c1538f637f6657113"},
	{"twenty cells, seed 3", synth.Options{Cells: 20, Events: 9000, Seed: 3, Hours: 12, AgentsPerExecution: 12},
		"9b4afb05824b60d7fe9ebcf9cbfd9a8501500cb81d8f2c50705be3ab3e2adfa8", "f80c846422ffbba1787efbc47a03cb4bfbd61df05d4220d3eb4d492cd700985f"},
	// The default history (mach-synth with no options but --out): the Timeline's 220,000 events.
	{"the default history", synth.Options{Seed: 1},
		"440512d4b74b3131f83eee09c3b88e0be3aefbe1f61f04e06353c9fb5cc3be61", "cde0dd1f5494e57ffdd8ecd7b7de4cbd66f54fb988c45ab937855b08600e3c24"},
	// The analytics mode's default profile, recorded before --profile realistic was added: tiny,
	// medium and a third shape, as mach-synth --analytics writes them.
	{"analytics tiny", synth.Options{Analytics: true, Cells: 2, Waves: 1, Seed: 1},
		"296128d52df4f5261d7c4b38d783a10ec0f8a57cf0411b6bb76b89fe94a1e1e9", "6acf2a5b8c22b533d58f8bb4e4806f64b55847b5646f6203233502f49203da28"},
	{"analytics medium", synth.Options{Analytics: true, Cells: 60, Waves: 8, Seed: 1},
		"266a6edfb09f9eabf4aa608941de22c6ccda875305325c9d20bb8f18e3a54720", "f2f47dfb7b5bbe9d6b0517bc50df02c90098c5beadbe77bb0719c9f8a93e4c35"},
	{"analytics thirty cells, seed 5", synth.Options{Analytics: true, Cells: 30, Waves: 4, Seed: 5},
		"4ac7d8719642c24c64e561723c79e626554c600a51b1125f3f1acf6e85716e2e", "bb526e552935e6647d3aac26190e033f15cceec008a8d18254ec7e536131d9e2"},
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
