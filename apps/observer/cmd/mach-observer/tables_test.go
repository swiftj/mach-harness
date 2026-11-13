package main

import (
	"slices"
	"testing"

	"mach/observer/internal/event"
	"mach/observer/internal/feed"
	"mach/observer/internal/normalize"
)

// The ingest side and the serving side each keep a copy of two small tables (neither imports the
// other); they must agree.
func TestSharedTablesAgree(t *testing.T) {
	for _, reason := range feed.GapReasons {
		ci, li := event.GapClass(reason)
		cs, ls := feed.GapClass(reason)
		if ci != cs || li != ls {
			t.Errorf("%s: ingest %s/%v, serving %s/%v", reason, ci, li, cs, ls)
		}
	}
	if !slices.Equal(normalize.ProvenVersions, feed.ProvenStreamVersions) {
		t.Fatalf("proven versions: %v vs %v", normalize.ProvenVersions, feed.ProvenStreamVersions)
	}
	if event.Revision != feed.SchemaRevision {
		t.Fatalf("revision %d vs %d", event.Revision, feed.SchemaRevision)
	}
}
