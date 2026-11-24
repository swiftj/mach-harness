package artifact

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// cleanup.archive: a finished ticket whose cell folder is gone and whose archive cleanup did not
// keep is said plainly, with the run record's reason; a kept archive, a live cell and a ticket with
// no run record say nothing.

const notKeptReason = `The evidence files were not kept after cleanup: cleanup.archive is "raised" and no person decided anything on this ticket.`

func runsLine(fields string) string {
	return `{"record_version":2,"ticket_id":"T-5","outcome":"merged"` + fields + "}\n"
}

func TestNoArchiveKeptIsSaidWithTheRunRecordsReason(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	write(t, filepath.Join(root, ".factory/archive/runs.jsonl"), []byte(
		`{"ticket_id":"T-4","archive":null}`+"\n"+
			runsLine(`,"archive":null,"raised_to_person":["escalated","Not A Code"],"archive_kept":{"kept":false,"setting":"raised","chosen_by":"setting","published":null,"reason":`+jsonQuote(notKeptReason)+`}`)))
	nk := NotKeptAt(root, "T-5")
	if nk == nil {
		t.Fatal("nothing said for a ticket with no archive kept")
	}
	if nk.Reason != notKeptReason || *nk.Setting != "raised" || *nk.ChosenBy != "setting" || nk.Archive != nil || *nk.Outcome != "merged" ||
		!reflect.DeepEqual(nk.RaisedToPerson, []string{"escalated"}) {
		t.Errorf("not kept: %+v", nk)
	}
	// A record with no reason of its own: the plain fallback.
	write(t, filepath.Join(root, ".factory/archive/runs.jsonl"), []byte(runsLine(`,"archive":null`)))
	if nk := NotKeptAt(root, "T-5"); nk == nil || nk.Reason != NotKeptFallback || nk.Setting != nil || len(nk.RaisedToPerson) != 0 {
		t.Errorf("fallback: %+v", nk)
	}
	// A reason that is not a plain sentence (a path outside the project, a control character) is not served.
	write(t, filepath.Join(root, ".factory/archive/runs.jsonl"), []byte(runsLine(`,"archive":null,"archive_kept":{"reason":"kept at /Users/someone/x"}`)))
	if nk := NotKeptAt(root, "T-5"); nk == nil || nk.Reason != NotKeptFallback {
		t.Errorf("a path served: %+v", nk)
	}
}

func TestAnArchiveNamedButGoneIsSaid(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	write(t, filepath.Join(root, ".factory/archive/runs.jsonl"), []byte(runsLine(`,"archive":".factory/archive/T-5.tar.gz"`)))
	nk := NotKeptAt(root, "T-5")
	if nk == nil || nk.Archive == nil || *nk.Archive != ".factory/archive/T-5.tar.gz" || !strings.Contains(nk.Reason, "is not in .factory/archive/") {
		t.Fatalf("archive gone: %+v", nk)
	}
	write(t, filepath.Join(root, ".factory/archive/T-5.tar.gz"), []byte("x"))
	if nk := NotKeptAt(root, "T-5"); nk != nil {
		t.Errorf("an archive that is there said not kept: %+v", nk)
	}
}

func TestNothingIsSaidWhereTheFilesAreThere(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	if nk := NotKeptAt(root, "T-5"); nk != nil {
		t.Errorf("no run record: %+v", nk)
	}
	// An old record without the archive key and with its archive at the default name.
	write(t, filepath.Join(root, ".factory/archive/runs.jsonl"), []byte(runsLine("")))
	write(t, filepath.Join(root, ".factory/archive/T-5.tar.gz"), []byte("x"))
	if nk := NotKeptAt(root, "T-5"); nk != nil {
		t.Errorf("an old record's archive: %+v", nk)
	}
	os.Remove(filepath.Join(root, ".factory/archive/T-5.tar.gz"))
	write(t, filepath.Join(root, ".factory/archive/runs.jsonl"), []byte(runsLine(`,"archive":null`)))
	if err := os.MkdirAll(filepath.Join(root, ".factory/worktrees/T-5"), 0o755); err != nil {
		t.Fatal(err)
	}
	if nk := NotKeptAt(root, "T-5"); nk != nil {
		t.Errorf("a live cell: %+v", nk)
	}
}

func TestTheLanesOfABuildWithNoArchiveKept(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	write(t, filepath.Join(root, ".factory/archive/runs.jsonl"), []byte(runsLine(`,"archive":null,"archive_kept":{"kept":false,"reason":`+jsonQuote(notKeptReason)+`}`)))
	ln, _ := ReadBuild(root, "T-5", true, false)
	if ln == nil || ln.State != "not-kept" || ln.Source != "none" || ln.NotKept == nil || ln.NotKept.Reason != notKeptReason ||
		ln.Build.Why == nil || *ln.Build.Why != notKeptReason {
		t.Fatalf("lanes not kept: %+v", ln)
	}
	if ln, _ := ReadBuild(root, "T-5", false, true); ln != nil {
		t.Errorf("a build not in lanes has lanes: %+v", ln)
	}
}

func jsonQuote(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
}
