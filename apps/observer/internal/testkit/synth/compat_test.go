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
		"c47e8003b7b15f213be7b363b05a6dac70e9ed380dd677c1a61950dc30ca65fe", "8ec7df212cde9104528aef7a30640015da7d0a1c338686140e48e710026ec943"},
	{"twenty cells, seed 3", synth.Options{Cells: 20, Events: 9000, Seed: 3, Hours: 12, AgentsPerExecution: 12},
		"4479e9f22e186dafd48dd5ca0755700404e002a139980ab9cfb845ac032eca20", "00cda2ca6269e45199e76a845e9d4c1fe5d7cea8a292b48bc4339d45bd467d3d"},
	// The default history (mach-synth with no options but --out): the Timeline's 220,000 events.
	{"the default history", synth.Options{Seed: 1},
		"2d804da80ad74581214fc735f000de08fe2479fa59a60d9147533765f117eab2", "1ee3e9b9a8eeb5844cbbc200c50ebe61f36edc7763f4895aa8db5a04a032f644"},
	// The analytics mode's default profile, recorded before --profile realistic was added: tiny,
	// medium and a third shape, as mach-synth --analytics writes them.
	{"analytics tiny", synth.Options{Analytics: true, Cells: 2, Waves: 1, Seed: 1},
		"6bf9d2838e4e10e764d3b9c693f6fbde28b12d38ce020481415263226649d541", "56d4197e85741a17c9df1fad630613e26d895fd8038f0fe8104f0268bd70f8eb"},
	{"analytics medium", synth.Options{Analytics: true, Cells: 60, Waves: 8, Seed: 1},
		"bf1a44c61b1786dd5e29a5fa5fbf56ecbe774d22ecd942ffc473918f9c604826", "c40e1691449900dd8e6d59791d26f8e54974b730ddb1b4c74584f5bd1706116b"},
	{"analytics thirty cells, seed 5", synth.Options{Analytics: true, Cells: 30, Waves: 4, Seed: 5},
		"66bb0520b6e7f88465a5c355b522072171ae8d94a9b5a1f1c331fcfa75fd4eb3", "cc48c8d4425b0263169b79cd5aef1594a5708983ac833b5d4173b2908567f0f0"},
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
