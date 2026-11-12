package main

import (
	"encoding/json"
	"testing"
)

// The real ingest's version 3 events reach the serving side's projection: what the fixture's
// ledger and lifecycle lines say shows up in /project, /cells and /runs. A mismatch between the
// envelope ingest writes and the one the projection reads would show as not_v3 here.
func TestRealIngestFeedsTheProjection(t *testing.T) {
	root := fixture(t)
	r := launch(t, root)
	defer r.stop(t)
	waitEvents(t, r, 7)
	var health struct {
		Data struct {
			Projection struct {
				Applied int64 `json:"applied"`
				NotV3   int64 `json:"not_v3"`
			} `json:"projection"`
		} `json:"data"`
	}
	json.Unmarshal(r.get(t, "/api/v1/health"), &health)
	if health.Data.Projection.NotV3 != 0 || health.Data.Projection.Applied < 7 {
		t.Fatalf("projection %+v", health.Data.Projection)
	}
	var cell struct {
		Data struct {
			TicketID string `json:"ticket_id"`
			Visits   []any  `json:"visits"`
		} `json:"data"`
	}
	json.Unmarshal(r.get(t, "/api/v1/cells/T-1"), &cell)
	if cell.Data.TicketID != "T-1" || len(cell.Data.Visits) == 0 {
		t.Fatalf("cell %+v", cell.Data)
	}
}
