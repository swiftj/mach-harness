package normalize

import (
	"encoding/json"
	"sort"

	"mach/observer/internal/redact"
)

// Identity is what the observer knows that ties sources together: which ticket an execution
// served, and a ticket's product identities (contract 10.2: "from cell.json.product and the
// ledger (identity, not inference)"). It is filled by ingest from the intake ledger
// (.factory/intake/ledger.json), the intake log and each cell.json, and read by the normalisers.
// It is used by one goroutine.
type Identity struct {
	ProjectID string
	execs     map[string]string // execution -> ticket
	cells     map[string]Product
	// incarnations per ticket: generation -> first `at` of its lifecycle file (contract 5.2: the
	// k-th incarnation is cell:<ticket>~<k>, numbered by the file's first at).
	incarnations map[string]map[string]int64
	// titles per slice and of its epic, with the revision the ledger recorded them for (raw: scrubbed
	// when used).
	titles map[string]SliceTitles
}

// SliceTitles are a slice's title and its epic's name as the intake ledger records them (raw).
type SliceTitles struct {
	Title    string
	Epic     string
	revision int64
}

// SliceTitleMax is the most characters of a slice title or an epic name kept (redact.FreeTextFields).
const SliceTitleMax = 200

// SliceTitle is the title and epic name the intake ledger records for a slice, and the revision they
// are for.
func (id *Identity) SliceTitle(slice string) (SliceTitles, int64, bool) {
	t, ok := id.titles[slice]
	return t, t.revision, ok
}

// Product is a cell's product identity.
type Product struct {
	SliceID  string
	EpicID   string // M11
	Issue    int64  // M11: the slice's issue number; 0 when it came from a folder or is not recorded
	Revision *int64
}

// NewIdentity makes an empty identity map.
func NewIdentity() *Identity {
	return &Identity{execs: map[string]string{}, cells: map[string]Product{}, incarnations: map[string]map[string]int64{}, titles: map[string]SliceTitles{}}
}

// LearnExecution records that an execution served a ticket.
func (id *Identity) LearnExecution(execution, ticket string) {
	if _, ok := ExecutionID(execution); !ok {
		return
	}
	if t, ok := Ticket(ticket); ok {
		id.execs[execution] = t
	}
}

// TicketOf is the ticket an execution served, if known.
func (id *Identity) TicketOf(execution string) string { return id.execs[execution] }

// LearnProduct records a ticket's product identity.
func (id *Identity) LearnProduct(ticket string, p Product) {
	if _, ok := Ticket(ticket); ok {
		id.cells[ticket] = p
	}
}

// ProductOf is a ticket's product identity.
func (id *Identity) ProductOf(ticket string) Product { return id.cells[ticket] }

// LearnIncarnation records a lifecycle file generation of a ticket's cell and its first time.
func (id *Identity) LearnIncarnation(ticket, gen string, firstAt int64) {
	m := id.incarnations[ticket]
	if m == nil {
		m = map[string]int64{}
		id.incarnations[ticket] = m
	}
	if _, ok := m[gen]; !ok {
		m[gen] = firstAt
	}
}

// Incarnation is k for a generation: 1 for the earliest known file of the ticket.
func (id *Identity) Incarnation(ticket, gen string) int {
	m := id.incarnations[ticket]
	at, ok := m[gen]
	if !ok {
		return 1
	}
	type g struct {
		gen string
		at  int64
	}
	var all []g
	for k, v := range m {
		all = append(all, g{k, v})
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].at != all[j].at {
			return all[i].at < all[j].at
		}
		return all[i].gen < all[j].gen
	})
	for i, x := range all {
		if x.gen == gen && x.at == at {
			return i + 1
		}
	}
	return 1
}

// Current is the latest known incarnation of a ticket's cell (for refs from the intake log).
func (id *Identity) Current(ticket string) int {
	n := len(id.incarnations[ticket])
	if n == 0 {
		return 1
	}
	return n
}

// ReadLedger learns from .factory/intake/ledger.json: the project id, each execution's ticket
// (supervisor.executions) and each slice's ticket, epic and issue. Unknown shapes are ignored.
func (id *Identity) ReadLedger(data []byte) {
	var raw struct {
		ProjectID  any                       `json:"project_id"`
		Slices     map[string]map[string]any `json:"slices"`
		Supervisor struct {
			Executions map[string]map[string]any `json:"executions"`
		} `json:"supervisor"`
	}
	if json.Unmarshal(data, &raw) != nil {
		return
	}
	if p, ok := redact.ID(raw.ProjectID); ok {
		id.ProjectID = p
	}
	for x, rec := range raw.Supervisor.Executions {
		if t, ok := rec["ticket_id"].(string); ok {
			id.LearnExecution(x, t)
		}
	}
	for sliceID, rec := range raw.Slices {
		s, ok := redact.ID(sliceID)
		epic := obj(rec["epic"])
		title, _ := rec["title"].(string)
		epicTitle, _ := epic["title"].(string)
		if ok && len(title) <= 4*SliceTitleMax && len(epicTitle) <= 4*SliceTitleMax && (title != "" || epicTitle != "") {
			if r, okR := redact.Int(rec["revision"]); okR {
				id.titles[s] = SliceTitles{Title: title, Epic: epicTitle, revision: r}
			}
		}
		t, okT := Ticket(rec["ticket_id"])
		if !ok || !okT {
			continue
		}
		p := id.cells[t]
		if p.SliceID == "" {
			p.SliceID = s
		}
		if e, ok := redact.ID(epic["epic_id"]); ok && p.EpicID == "" {
			p.EpicID = e
		}
		if n, ok := redact.Int(rec["issue"]); ok && n > 0 && p.Issue == 0 {
			p.Issue = n
		}
		if r, ok := redact.Int(rec["revision"]); ok && p.Revision == nil {
			p.Revision = &r
		}
		id.cells[t] = p
	}
}

// CellInfo is what the observer reads from a cell.json: never shown whole.
type CellInfo struct {
	Stage     string
	CreatedAt string
	Round     int64
	Product   Product
	Present   bool
}

// ParseCell reads the fields the observer uses from a cell.json.
func ParseCell(data []byte) CellInfo {
	var raw map[string]any
	if json.Unmarshal(data, &raw) != nil {
		return CellInfo{}
	}
	ci := CellInfo{Present: true}
	if s, ok := raw["stage"].(string); ok && stage(s) != nil {
		ci.Stage = s
	}
	if s, ok := raw["created_at"].(string); ok && len(s) <= 40 {
		ci.CreatedAt = s
	}
	if p := obj(raw["product"]); p != nil {
		ci.Product.SliceID, _ = redact.ID(p["slice_id"])
		ci.Product.EpicID, _ = redact.ID(p["epic_id"])
		ci.Product.Issue = issueNumber(p["issue"])
		if r, ok := redact.Int(p["revision"]); ok {
			ci.Product.Revision = &r
		}
	}
	if ci.Product.SliceID == "" {
		ci.Product.SliceID, _ = redact.ID(raw["slice_id"])
	}
	return ci
}

// issueNumber is the number of a product block's issue ({"repository", "number"}, M11), or 0.
func issueNumber(v any) int64 {
	if n, ok := redact.Int(obj(v)["number"]); ok && n > 0 {
		return n
	}
	return 0
}
