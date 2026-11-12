package feed_test

import (
	"errors"
	"testing"

	"mach/observer/internal/feed"
	"mach/observer/internal/feedtest"
)

func TestCursorParsing(t *testing.T) {
	c, err := feed.ParseCursor("0123456789abcdef.42")
	if err != nil || c.Pos != 42 || c.String() != "0123456789abcdef.42" {
		t.Fatal(c, err)
	}
	for _, bad := range []string{"x", "0123456789abcdef", "0123456789ABCDEF.1", "0123456789abcdef.-1", "0123456789abcdef.+1", "0123456789abcdef.1e3",
		"0123456789abcdef.", "0123456789abcdef.99999999999999999999999"} {
		if _, err := feed.ParseCursor(bad); err == nil {
			t.Fatalf("%q parsed", bad)
		}
	}
}

func TestScanFiltersAndCaps(t *testing.T) {
	m := feedtest.NewMem("", 0)
	m.Append(feedtest.Scenario()...)
	page, err := feed.Scan(m, 0, feed.Filter{Ticket: "T-1", TypePref: "station.exited"}, 100, 1000)
	if err != nil || len(page.Records) != 6 {
		t.Fatalf("%d %v", len(page.Records), err)
	}
	page, _ = feed.Scan(m, 0, feed.Filter{Ticket: "T-1"}, 100, 5)
	if page.Scanned != 5 || page.Next != 5 {
		t.Fatalf("scan cap: %+v", page)
	}
	small := feedtest.NewMem("", 3)
	small.Append(feedtest.Scenario()[:10]...)
	if _, err := feed.Scan(small, 1, feed.Filter{}, 10, 10); !errors.Is(err, feed.ErrExpired) {
		t.Fatalf("%v", err)
	}
	if _, err := m.After(9999, 1); !errors.Is(err, feed.ErrFuture) {
		t.Fatal(err)
	}
	m.AppendRaw(`{"schema_version":2}`)
	if (feed.Filter{Ticket: "T-1"}).MatchRaw(feed.Record{Pos: 1, Raw: []byte(`{"schema_version":2}`)}) {
		t.Fatal("a non-v3 record matched a filter")
	}
}
