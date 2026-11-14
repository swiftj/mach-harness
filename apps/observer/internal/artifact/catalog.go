// Package artifact is the Evidence Theater's source: a catalog of the artifacts a cell's
// verification and review left behind (metadata only), and a restricted reader for their content.
//
// What can be catalogued is fixed here, never taken from a request: a cell's evidence/ folder
// (results.json, summary.json, findings.md and the evidence files results.json names, in the
// current run and in previous-N/) and its review/round-N/ findings.md and decision.json; and the
// same members of the cell's archive after cleanup. Never repo/, never .factory/local/, never an
// execution stream, never test-suite.log or contract-check.log (test output). A client names an
// artifact by the catalog's opaque id; the observer looks the path up itself.
package artifact

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"mach/observer/internal/redact"
)

// Caps.
const (
	MaxText     = 16 << 20  // a text file read (and hashed) whole
	ServedText  = 256 << 10 // what is served of it
	MaxImage    = 16 << 20
	MaxVideo    = 64 << 20
	maxRecord   = 4 << 20 // results.json, summary.json
	maxArchive  = 1 << 30
	maxMembers  = 20000
	maxUnpacked = 2 << 30
	maxEntries  = 20000 // per catalog
	maxPrevious = 99
	maxRounds   = 99
	cacheTTL    = 2 * time.Second
	configMax   = 64 << 10
)

var ticketRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$`)

// excluded are names never served even when a record lists them (test output; see M6_0 gaps 5.7).
var excluded = map[string]bool{"test-suite.log": true, "contract-check.log": true}

// Entry is one catalogued artifact (shared contracts, section 3.1).
type Entry struct {
	ID             string   `json:"id"`
	Ref            string   `json:"ref"`
	Logical        string   `json:"logical"`
	TicketID       string   `json:"ticket_id"`
	Origin         string   `json:"origin"` // cell | archive
	Path           string   `json:"path_rel"`
	Kind           string   `json:"kind"`
	Nature         string   `json:"nature"` // evidence | record | prose
	MediaType      string   `json:"media_type"`
	Bytes          int64    `json:"bytes"`
	SHA256         string   `json:"sha256"`
	RecordedSHA256 string   `json:"recorded_sha256,omitempty"`
	Integrity      string   `json:"integrity"` // match | mismatch | missing | unchecked
	Verified       bool     `json:"verified_evidence"`
	Targets        []Target `json:"targets"`
	Round          *int64   `json:"round"`
	Commit         string   `json:"commit,omitempty"`
	VisitID        string   `json:"visit_id,omitempty"`
	// Visit is the station visit the artifact belongs to: "recorded" when a lifecycle record names
	// this file and its hash (a verification check), "reconstructed" when it is joined by round and
	// file time (the observer's inference). Null when no visit fits. Set by the server from the
	// projection; RoundBasis says the same of Round ("recorded" from results.json's review loop or
	// the review folder's number).
	Visit      *VisitLink `json:"visit"`
	RoundBasis string     `json:"round_basis,omitempty"`
	// ModifiedMS is the file's modification time (Unix ms), for the join; never served.
	ModifiedMS    int64  `json:"-"`
	ContentAccess string `json:"content_access"` // text | media | media-disabled | none
	AccessReason  string `json:"access_reason,omitempty"`
	// FreeText: the served text holds prose the observer cannot check for names (R1): a name
	// MACH's records or git identities give is replaced wherever it appears, a name that appears
	// only in prose is not. FreeTextNote is then redact.FreeTextNote, else null. False for media
	// and for content that is not served.
	FreeText     bool       `json:"free_text"`
	FreeTextNote *string    `json:"free_text_note"`
	Provenance   Provenance `json:"provenance"`

	member    string // archive member name
	free      bool   // the file's text holds prose (redact.HasFreeText), whatever its access
	duplicate bool   // the archive holds this name more than once (M6.6 F7): which one is meant is unknown
}

// Refusal reasons that name what is wrong with the file itself (M6.6 F7), for access_reason and
// the content route.
const (
	TooLargeReason  = "the file is larger than the observer reads (64 MB at most); it is listed, not hashed or served"
	DuplicateReason = "the archive holds more than one file of this name; which one is meant is unknown, so neither is served"
)

// VisitLink links an artifact to a station visit.
type VisitLink struct {
	VisitID string `json:"visit_id"`
	Basis   string `json:"basis"` // recorded | reconstructed
	Rule    string `json:"rule"`  // how: check-hash, folder, round-and-time
}

// Target is a check an evidence file proves.
type Target struct {
	ID     string `json:"id"`
	Kind   string `json:"kind,omitempty"`
	Result string `json:"result,omitempty"`
}

// Provenance says which MACH record named the artifact.
type Provenance struct {
	NamedBy string `json:"named_by"` // the record that lists it, cell-relative
	Writer  string `json:"writer"`   // the MACH script that wrote that record
}

// Settings are the project's tracked Control Tower settings (.factory/config.json "tower"),
// read only. EvidenceMedia (default false) lets screenshots and recordings be served.
type Settings struct {
	EvidenceMedia bool   `json:"evidence_media"`
	Source        string `json:"source"`
}

// SettingKey is where the opt-in lives, for messages.
const SettingKey = `.factory/config.json: {"tower": {"evidence_media": true}}`

// Catalog builds and caches the catalog for one project.
type Catalog struct {
	root   string
	salt   string
	now    func() time.Time
	mu     sync.Mutex
	at     time.Time
	byID   map[string]*Entry
	order  []*Entry
	set    Settings
	hashes map[string]hashed // "<origin>:<path>" -> hash of an unchanged file
	arcs   map[string]archiveScan
}

type hashed struct {
	id    fileID
	sum   string
	media string
	free  bool
}

type archiveScan struct {
	id      fileID
	entries []*Entry
}

// New makes a catalog for the project at root (an absolute, link-resolved path).
func New(root string) *Catalog {
	h := sha256.Sum256([]byte("mach-observer-artifacts\x00" + root))
	return &Catalog{root: root, salt: hex.EncodeToString(h[:8]), now: time.Now, hashes: map[string]hashed{}, arcs: map[string]archiveScan{}}
}

// id is opaque and specific to this project, ticket, origin, path and content: an id from another
// project, or from before the file changed, is unknown here.
func (c *Catalog) id(ticket, origin, rel, sum string) string {
	h := sha256.Sum256([]byte(c.salt + "\x00" + ticket + "\x00" + origin + "\x00" + rel + "\x00" + sum))
	return "a" + hex.EncodeToString(h[:12])
}

// Snapshot returns the catalog (refreshed at most every two seconds) and the settings.
func (c *Catalog) Snapshot() ([]Entry, Settings) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refreshLocked()
	out := make([]Entry, 0, len(c.order))
	for _, e := range c.order {
		out = append(out, *e)
	}
	return out, c.set
}

// SafeNames are the names of a ticket's catalogued artifacts as a served text may hold them:
// cell-relative ("review/round-3/findings.md"), project-relative
// (".factory/worktrees/T/review/round-3/findings.md") and the bare file names. They are kept by
// the scrubber (a long relative name looks like an opaque token to it).
func (c *Catalog) SafeNames(ticket string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	seen := map[string]bool{}
	var out []string
	add := func(s string) {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	for _, e := range c.order {
		if e.TicketID != ticket {
			continue
		}
		add(e.Path)
		add(".factory/worktrees/" + ticket + "/" + e.Path)
		add(baseName(e.Path))
	}
	return out
}

// Lookup finds an entry by id.
func (c *Catalog) Lookup(id string) (Entry, Settings, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refreshLocked()
	e, ok := c.byID[id]
	if !ok {
		return Entry{}, c.set, false
	}
	return *e, c.set, true
}

func (c *Catalog) refreshLocked() {
	if c.byID != nil && c.now().Sub(c.at) < cacheTTL {
		return
	}
	c.at = c.now()
	c.byID, c.order = map[string]*Entry{}, nil
	root, err := os.OpenRoot(c.root)
	if err != nil {
		return
	}
	defer root.Close()
	c.set = readSettings(root)
	live := map[string]bool{}
	for _, t := range sortedNames(listDir(root, ".factory/worktrees")) {
		if !ticketRe.MatchString(t) || len(t) > 128 || !isDir(root, ".factory/worktrees/"+t) {
			continue
		}
		live[t] = true
		for _, e := range c.scanCell(root, t) {
			c.add(e)
		}
	}
	for _, name := range sortedNames(listDir(root, ".factory/archive")) {
		t, ok := strings.CutSuffix(name, ".tar.gz")
		if !ok || !ticketRe.MatchString(t) || len(t) > 128 || live[t] {
			continue // a live cell speaks for itself; its archive is read once the folder is gone
		}
		for _, e := range c.scanArchive(root, t) {
			c.add(e)
		}
	}
	note := redact.FreeTextNote
	for _, e := range c.order {
		e.ContentAccess, e.AccessReason = access(e, c.set)
		e.FreeText, e.FreeTextNote = e.ContentAccess == "text" && e.free, nil
		if e.FreeText {
			e.FreeTextNote = &note
		}
	}
}

func (c *Catalog) add(e *Entry) {
	if len(c.order) >= maxEntries {
		return
	}
	if _, dup := c.byID[e.ID]; dup {
		return
	}
	c.byID[e.ID] = e
	c.order = append(c.order, e)
}

func sortedNames(names []string) []string {
	sort.Strings(names)
	return names
}

func access(e *Entry, set Settings) (string, string) {
	switch {
	case e.duplicate:
		return "none", DuplicateReason
	case e.Integrity == "unchecked" && e.SHA256 == "" && e.Bytes > 0:
		return "none", TooLargeReason // fill could not hash it: larger than the observer reads
	case e.Integrity == "missing" || e.SHA256 == "":
		return "none", "the file is not there to read"
	}
	class, ok := Allowed(e.Path, e.MediaType)
	switch {
	case redact.CredentialPath(e.Path):
		return "none", CredentialReason
	case !ok:
		return "none", "its contents are not a type the observer serves (" + e.MediaType + ")"
	case class == ClassText:
		return "text", "served as plain text, scrubbed of credentials and paths"
	case !set.EvidenceMedia:
		return "media-disabled", "screenshots and recordings are served only when the project opts in: " + SettingKey
	}
	return "media", ""
}

func readSettings(root *os.Root) Settings {
	data, _, err := readFile(root, ".factory/config.json", configMax)
	if err != nil {
		return Settings{Source: "default (no readable .factory/config.json)"}
	}
	var cfg struct {
		Tower struct {
			EvidenceMedia *bool `json:"evidence_media"`
		} `json:"tower"`
	}
	if json.Unmarshal(data, &cfg) != nil {
		return Settings{Source: "default (.factory/config.json is not valid JSON)"}
	}
	if cfg.Tower.EvidenceMedia == nil {
		return Settings{Source: "default (tower.evidence_media not set)"}
	}
	return Settings{EvidenceMedia: *cfg.Tower.EvidenceMedia, Source: ".factory/config.json tower.evidence_media"}
}

// ---- reading what verify.py and review.py wrote ----

type results struct {
	Head       string `json:"head"`
	ReviewLoop *int64 `json:"review_loop"`
	Records    map[string]struct {
		Kind     string `json:"kind"`
		Result   string `json:"result"`
		Evidence []struct {
			File   string `json:"file"`
			SHA256 string `json:"sha256"`
		} `json:"evidence"`
	} `json:"records"`
}

var hexRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
var commitRe = regexp.MustCompile(`^[0-9a-f]{7,64}$`)

// evidenceFolders are the cell-relative evidence folders: evidence/ and evidence/previous-N/.
func evidenceFolders(names []string) []string {
	out := []string{"evidence"}
	var prev []int
	for _, n := range names {
		if k, ok := strings.CutPrefix(n, "previous-"); ok {
			if v, err := strconv.Atoi(k); err == nil && v > 0 && v <= maxPrevious && strconv.Itoa(v) == k {
				prev = append(prev, v)
			}
		}
	}
	sort.Ints(prev)
	for _, v := range prev {
		out = append(out, fmt.Sprintf("evidence/previous-%d", v))
	}
	return out
}

func roundFolders(names []string) []int {
	var out []int
	for _, n := range names {
		if k, ok := strings.CutPrefix(n, "round-"); ok {
			if v, err := strconv.Atoi(k); err == nil && v > 0 && v <= maxRounds && strconv.Itoa(v) == k {
				out = append(out, v)
			}
		}
	}
	sort.Ints(out)
	return out
}

// source abstracts a live cell folder and an archive's members.
type source interface {
	read(rel string, max int64) ([]byte, error) // a record (results.json)
	hash(rel string) (h hashed, size, modMS int64, err error)
}

// plan lists what a cell's records name, as entries without hashes; fill completes them.
func plan(src source, ticket string, folders []string, rounds []int, people *redact.People) []*Entry {
	var out []*Entry
	for _, folder := range folders {
		var res results
		data, err := src.read(folder+"/results.json", maxRecord)
		if err == nil && json.Unmarshal(data, &res) != nil {
			res = results{}
		}
		var round *int64
		if res.ReviewLoop != nil && *res.ReviewLoop >= 0 && *res.ReviewLoop < 100 {
			round = ptr(*res.ReviewLoop + 1)
		}
		commit := ""
		if commitRe.MatchString(res.Head) {
			commit = res.Head
		}
		if err == nil {
			out = append(out, &Entry{Path: folder + "/results.json", Kind: "verification-results", Nature: "record", Round: round, Commit: commit,
				Provenance: Provenance{NamedBy: folder + "/results.json", Writer: "verify.py"}})
		}
		for _, name := range []string{"summary.json", "findings.md"} {
			kind, nature := "verification-summary", "record"
			if name == "findings.md" {
				kind, nature = "verification-findings", "prose"
			}
			out = append(out, &Entry{Path: folder + "/" + name, Kind: kind, Nature: nature, Round: round, Commit: commit,
				Provenance: Provenance{NamedBy: folder + "/" + name, Writer: "verify.py"}})
		}
		files := map[string]*Entry{}
		var ids []string
		for id := range res.Records {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			rec := res.Records[id]
			for _, ev := range rec.Evidence {
				rel := folder + "/" + ev.File
				// A name that is itself a credential (or an e-mail) is never catalogued: it would be
				// shown, and protected from the scrubber as a safe name (M6.5 S1).
				if !plainRel(ev.File) || !cleanRel(rel) || excluded[path.Base(ev.File)] || strings.HasPrefix(ev.File, "previous-") || redact.SecretName(ev.File) {
					continue
				}
				e := files[rel]
				if e == nil {
					e = &Entry{Path: rel, Kind: "evidence", Nature: "evidence", Round: round, Commit: commit, Targets: []Target{},
						Provenance: Provenance{NamedBy: folder + "/results.json", Writer: "verify.py"}}
					if hexRe.MatchString(ev.SHA256) {
						e.RecordedSHA256 = ev.SHA256
					}
					files[rel] = e
					out = append(out, e)
				}
				e.Targets = append(e.Targets, Target{ID: id, Kind: rec.Kind, Result: rec.Result})
			}
		}
	}
	for _, r := range rounds {
		// The people a review records (an approver, whoever recorded the approval) are learned
		// before anything of the cell is served, so their names are scrubbed from every text.
		if data, err := src.read(fmt.Sprintf("review/round-%d/decision.json", r), maxRecord); err == nil {
			people.LearnJSON(data)
		}
		for _, name := range []string{"findings.md", "decision.json"} {
			kind, nature := "review-findings", "prose"
			if name == "decision.json" {
				kind, nature = "review-decision", "record"
			}
			out = append(out, &Entry{Path: fmt.Sprintf("review/round-%d/%s", r, name), Kind: kind, Nature: nature, Round: ptr(int64(r)),
				Provenance: Provenance{NamedBy: fmt.Sprintf("review/round-%d/%s", r, name), Writer: "review.py"}})
		}
	}
	for _, e := range out {
		e.TicketID = ticket
		if e.Targets == nil {
			e.Targets = []Target{}
		}
		if e.Round != nil {
			e.RoundBasis = "recorded" // results.json's review loop, or the review folder's number
		}
	}
	return out
}

func ptr[T any](v T) *T { return &v }

// fill hashes each planned entry; a fixed record that is absent is dropped, a named evidence file
// that is absent stays, as missing.
func (c *Catalog) fill(src source, origin string, planned []*Entry) []*Entry {
	var out []*Entry
	for _, e := range planned {
		e.Origin = origin
		h, size, mod, err := src.hash(e.Path)
		sum, media := h.sum, h.media
		e.free = h.free
		e.ModifiedMS = mod
		if errors.Is(err, ErrTooLarge) {
			e.Integrity, e.Bytes = "unchecked", size
		} else if err != nil {
			if e.Nature != "evidence" {
				continue
			}
			e.Integrity = "missing"
		} else {
			e.SHA256, e.MediaType, e.Bytes = sum, media, size
			switch {
			case e.RecordedSHA256 == "":
				e.Integrity = "unchecked"
			case e.RecordedSHA256 == sum:
				e.Integrity = "match"
			default:
				e.Integrity = "mismatch"
			}
		}
		e.Verified = e.Nature == "evidence" && e.Integrity == "match"
		short := e.SHA256
		if len(short) > 12 {
			short = short[:12]
		}
		e.Logical = "artifact:" + e.TicketID + ":" + e.Path
		e.Ref = e.Logical
		if short != "" {
			e.Ref += "@" + short
		}
		e.ID = c.id(e.TicketID, origin, e.Path, e.SHA256)
		out = append(out, e)
	}
	return out
}

// ---- live cells ----

type cellSource struct {
	c      *Catalog
	root   *os.Root
	prefix string // .factory/worktrees/<t>/
}

func (s cellSource) read(rel string, max int64) ([]byte, error) {
	data, _, err := readFile(s.root, s.prefix+rel, max)
	return data, err
}

func (s cellSource) hash(rel string) (hashed, int64, int64, error) {
	full := s.prefix + rel
	id, err := statFile(s.root, full)
	if err != nil {
		return hashed{}, 0, 0, err
	}
	mod := id.ModNS / 1e6
	key := "cell:" + full
	if h, ok := s.c.hashes[key]; ok && h.id == id {
		return h, id.Size, mod, nil
	}
	data, id, err := readFile(s.root, full, MaxVideo)
	if err != nil {
		return hashed{}, id.Size, mod, err
	}
	h := hashOf(rel, data)
	h.id = id
	s.c.hashes[key] = h
	return h, id.Size, mod, nil
}

// hashOf hashes a file's bytes, sniffs its type and notes whether its text holds free prose.
func hashOf(rel string, data []byte) hashed {
	sum := sha256.Sum256(data)
	media := Sniff(data)
	h := hashed{sum: hex.EncodeToString(sum[:]), media: media}
	if class, ok := Allowed(rel, media); ok && class == ClassText {
		h.free = redact.HasFreeText(rel, data)
	}
	return h
}

func (c *Catalog) scanCell(root *os.Root, ticket string) []*Entry {
	prefix := ".factory/worktrees/" + ticket + "/"
	src := cellSource{c: c, root: root, prefix: prefix}
	folders := evidenceFolders(listDir(root, prefix+"evidence"))
	if !isDir(root, prefix+"evidence") {
		folders = nil
	}
	rounds := roundFolders(listDir(root, prefix+"review"))
	return c.fill(src, "cell", plan(src, ticket, folders, rounds, redact.PeopleFor(c.root)))
}

// ---- archives ----

type member struct {
	sum, media string
	free       bool
	size       int64
	modMS      int64
	tooLarge   bool
	duplicate  bool   // the name occurs more than once in the archive
	data       []byte // records only
}

type archiveSource struct{ members map[string]member }

func (s archiveSource) read(rel string, max int64) ([]byte, error) {
	m, ok := s.members[rel]
	if !ok || m.data == nil || m.size > max {
		return nil, ErrNotHeld
	}
	return m.data, nil
}

func (s archiveSource) hash(rel string) (hashed, int64, int64, error) {
	m, ok := s.members[rel]
	if !ok {
		return hashed{}, 0, 0, ErrNotHeld
	}
	if m.tooLarge {
		return hashed{}, m.size, m.modMS, ErrTooLarge
	}
	return hashed{sum: m.sum, media: m.media, free: m.free}, m.size, m.modMS, nil
}

// archived reports whether a cell-relative member name is one the catalog may hold.
func archived(rel string) bool {
	if !plainRel(rel) || excluded[path.Base(rel)] {
		return false
	}
	parts := strings.Split(rel, "/")
	switch parts[0] {
	case "evidence":
		return len(parts) >= 2
	case "review":
		return len(parts) == 3 && strings.HasPrefix(parts[1], "round-") && (parts[2] == "findings.md" || parts[2] == "decision.json")
	}
	return false
}

func (c *Catalog) scanArchive(root *os.Root, ticket string) []*Entry {
	rel := ".factory/archive/" + ticket + ".tar.gz"
	id, err := statFile(root, rel)
	if err != nil || id.Size > maxArchive {
		return nil
	}
	if cached, ok := c.arcs[rel]; ok && cached.id == id {
		out := make([]*Entry, 0, len(cached.entries))
		for _, e := range cached.entries {
			cp := *e
			out = append(out, &cp)
		}
		return out
	}
	members := map[string]member{}
	err = walkArchive(root, rel, ticket, func(name string, hdr *tar.Header, r io.Reader) error {
		if !archived(name) {
			return nil
		}
		if m, seen := members[name]; seen {
			m.duplicate = true
			members[name] = m
			return nil
		}
		if hdr.Size > MaxVideo {
			members[name] = member{size: hdr.Size, tooLarge: true, modMS: hdr.ModTime.UnixMilli()}
			return nil
		}
		data, err := io.ReadAll(io.LimitReader(r, MaxVideo+1))
		if err != nil {
			return err
		}
		h := hashOf(name, data)
		m := member{sum: h.sum, media: h.media, free: h.free, size: int64(len(data)), modMS: hdr.ModTime.UnixMilli()}
		if (strings.HasSuffix(name, "results.json") || strings.HasSuffix(name, "decision.json")) && len(data) <= maxRecord {
			m.data = data
		}
		members[name] = m
		return nil
	})
	if err != nil {
		return nil
	}
	src := archiveSource{members: members}
	var folderNames, roundNames []string
	for name := range members {
		parts := strings.Split(name, "/")
		if parts[0] == "evidence" && len(parts) >= 3 {
			folderNames = append(folderNames, parts[1])
		}
		if parts[0] == "review" && len(parts) == 3 {
			roundNames = append(roundNames, parts[1])
		}
	}
	entries := c.fill(src, "archive", plan(src, ticket, evidenceFolders(uniq(folderNames)), roundFolders(uniq(roundNames)), redact.PeopleFor(c.root)))
	for _, e := range entries {
		e.member = ticket + "/" + e.Path
		e.duplicate = members[e.Path].duplicate
	}
	c.arcs[rel] = archiveScan{id: id, entries: entries}
	out := make([]*Entry, 0, len(entries))
	for _, e := range entries {
		cp := *e
		out = append(out, &cp)
	}
	return out
}

func uniq(list []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range list {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

var errStop = errors.New("stop")

// walkArchive opens a cell archive through the same guarded open as every other read, and calls
// fn for each regular member under "<ticket>/" with its cell-relative name. Links, devices and
// names that leave the cell are skipped; the member count and the unpacked size are capped (a
// decompression bomb stops the walk).
func walkArchive(root *os.Root, rel, ticket string, fn func(name string, hdr *tar.Header, r io.Reader) error) error {
	f, err := openGuarded(root, rel)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(io.LimitReader(f, maxArchive))
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(&capped{r: gz, left: maxUnpacked})
	for n := 0; n < maxMembers; n++ {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		name, ok := strings.CutPrefix(hdr.Name, ticket+"/")
		if !ok || !cleanRel(name) {
			continue
		}
		if err := fn(name, hdr, tr); err != nil {
			if errors.Is(err, errStop) {
				return nil
			}
			return err
		}
	}
	return nil
}

type capped struct {
	r    io.Reader
	left int64
}

func (c *capped) Read(p []byte) (int, error) {
	if c.left <= 0 {
		return 0, errors.New("the archive unpacks to more than the cap")
	}
	if int64(len(p)) > c.left {
		p = p[:c.left]
	}
	n, err := c.r.Read(p)
	c.left -= int64(n)
	return n, err
}
