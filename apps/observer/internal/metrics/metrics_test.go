package metrics

import "testing"

func TestDurationsAndNulls(t *testing.T) {
	tb := NewTable()
	for _, ms := range []int64{500, 2000, 4000, 60000} {
		tb.Duration("C1", []Dim{{"station", "build"}}, "2026-11-12", ms)
	}
	row := tb.Rows([]string{"C1"}, "station")[0]
	if *row.Value != 16625 || *row.Min != 500 || *row.Max != 60000 || row.P50 == nil || len(row.Groups) != 1 || row.Groups[0].Key != "build" {
		t.Fatalf("%+v", row)
	}
	if day := tb.Rows([]string{"C1"}, "day")[0]; len(day.Groups) != 1 || day.Groups[0].Key != "2026-11-12" {
		t.Fatalf("%+v", day.Groups)
	}
	tb.Rate("Q1", nil, "", 0, 0)
	if r := tb.Rows([]string{"Q1"}, "")[0]; r.Value != nil || r.NullReason != "the denominator is empty" {
		t.Fatalf("%+v", r)
	}
	if r := tb.Rows([]string{"G4"}, "")[0]; r.Value != nil || r.Basis != "not-recorded" {
		t.Fatalf("%+v", r)
	}
	if len(tb.Rows(nil, "")) != len(Catalog) {
		t.Fatal("not every metric was returned")
	}
}

func TestGroupsAreBounded(t *testing.T) {
	tb := NewTable()
	for i := 0; i < MaxGroups+50; i++ {
		tb.Count("S5", []Dim{{"tool", string(rune('a'+i%26)) + string(rune(i))}}, "", 1)
	}
	if len(tb.Cells["S5"]) > MaxGroups || tb.Overflow == 0 {
		t.Fatalf("%d groups, overflow %d", len(tb.Cells["S5"]), tb.Overflow)
	}
}
