// Package security holds the observer's local defences: the loopback-only listener, the one-time
// start token and the session cookie it becomes, the Host, Origin and fetch-site checks, and the
// response headers.
//
// Copied and adapted from apps/studio/internal/security (M5, session.go and
// headers.go) rather than shared, so that Product Studio's host is not touched. The differences are
// deliberate: the observer answers GET everywhere except its two write routes (a person's decision
// and the Factory's stop, M23), which also pass CheckStateChange: the Origin must be this host and
// the X-MACH-CSRF header must carry the token derived from the browser's own session; it refuses
// any request whose Origin or Sec-Fetch-Site says it came from another site; and the cookie has
// its own name, so the two hosts never share a session.
package security

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// CSRFHeader carries the session's CSRF token on every request that changes something.
const CSRFHeader = "X-MACH-CSRF"

// CookieName is the session cookie. HttpOnly and SameSite=Strict; not Secure, because the
// observer serves plain HTTP on the loopback interface.
const CookieName = "mach_observer_session"

// MaxSessions is how many browser sessions one observer keeps. A further exchange forgets the
// oldest (that browser must open a new link).
const MaxSessions = 16

// Guard owns the secrets for one running observer.
//
// A one-time start token is exchanged for a session cookie; every tab of that browser shares the
// session. A second browser needs a second link: after each exchange the guard mints the next
// start token at once and hands it to OnMint, which the observer writes to a private file in its
// own folder (.factory/local/observer/link, mode 0600) for the skill to print. So there is never
// more than one unused token, a token works once, and no endpoint, process or control channel is
// needed to get a new link. Reading that file needs the same access as reading the printed link.
//
// Sessions survive a restart of the observer: the guard holds, and hands to OnSessions for the
// observer to keep in its own folder, only a keyed hash of each session token (HMAC-SHA256 under
// a per-project key) with its expiry, never the token. A browser's cookie is checked by hashing
// it under the same key; a record kept under another key (another project, or a copied folder)
// matches nothing.
type Guard struct {
	port     int
	key      []byte
	lifetime time.Duration
	now      func() time.Time

	mu         sync.Mutex
	startToken string
	sessions   []SessionRecord
	onMint     func(url string)
	onSessions func([]SessionRecord)
	version    uint64 // of g.sessions, under mu

	keepMu sync.Mutex
	kept   uint64 // the version last handed to onSessions, under keepMu
}

// keep hands a snapshot to onSessions, never an older one after a newer (callers run outside mu).
func (g *Guard) keep(recs []SessionRecord, ver uint64) {
	if g.onSessions == nil {
		return
	}
	g.keepMu.Lock()
	defer g.keepMu.Unlock()
	if ver <= g.kept {
		return
	}
	g.kept = ver
	g.onSessions(recs)
}

// SessionLifetime is how long a browser session lasts from the moment its link was used, across
// restarts of the observer: a working day. Then the browser needs a new link.
const SessionLifetime = 12 * time.Hour

// SessionRecord is what is kept of a session: the keyed hash of its token and when it expires.
type SessionRecord struct {
	Hash    string    `json:"hash"`
	Expires time.Time `json:"expires_at"`
}

// GuardOptions carry what an observer kept from its last run.
type GuardOptions struct {
	// Key is the per-project key session tokens are hashed under (at least 32 bytes). Empty: a
	// random key, so no session outlives this process.
	Key []byte
	// Sessions are the records kept from the last run; expired ones are dropped.
	Sessions []SessionRecord
	// OnSessions receives the records whenever they change (a link used, a session expired).
	OnSessions func([]SessionRecord)
	Lifetime   time.Duration // default SessionLifetime
	Now        func() time.Time
}

// NewGuard makes fresh random secrets for an observer listening on port; no session survives it.
func NewGuard(port int) (*Guard, error) { return NewGuardWith(port, GuardOptions{}) }

// NewGuardWith makes a guard that also accepts the sessions kept from the last run.
func NewGuardWith(port int, o GuardOptions) (*Guard, error) {
	if port <= 0 || port > 65535 {
		return nil, fmt.Errorf("port %d is not usable", port)
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Lifetime <= 0 {
		o.Lifetime = SessionLifetime
	}
	if len(o.Key) < 32 {
		o.Key = make([]byte, 32)
		if _, err := rand.Read(o.Key); err != nil {
			return nil, errors.New("could not make a random key")
		}
	}
	g := &Guard{port: port, key: o.Key, lifetime: o.Lifetime, now: o.Now, onSessions: o.OnSessions}
	now := o.Now()
	for _, r := range o.Sessions {
		if len(r.Hash) == 64 && r.Expires.After(now) && r.Expires.Before(now.Add(o.Lifetime+time.Minute)) {
			g.sessions = append(g.sessions, r)
		}
	}
	if len(g.sessions) > MaxSessions {
		g.sessions = g.sessions[len(g.sessions)-MaxSessions:]
	}
	token, err := randomToken()
	if err != nil {
		return nil, err
	}
	g.startToken = token
	return g, nil
}

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", errors.New("could not make a random token")
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// hash is the keyed hash a session is kept as.
func (g *Guard) hash(token string) string {
	m := hmac.New(sha256.New, g.key)
	m.Write([]byte(token))
	return hex.EncodeToString(m.Sum(nil))
}

// SessionKey derives the key session tokens are hashed under from a project's secret and its
// absolute folder, so a session record copied to another folder matches nothing there.
func SessionKey(secret []byte, projectRoot string) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte("mach-observer-session\x00" + projectRoot))
	return m.Sum(nil)
}

// records is a snapshot of the sessions and its version; call with mu held after a change.
func (g *Guard) records() ([]SessionRecord, uint64) {
	g.version++
	return append([]SessionRecord(nil), g.sessions...), g.version
}

func equal(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// Port is the port the guard was made for.
func (g *Guard) Port() int { return g.port }

func (g *Guard) urlFor(token string) string {
	return "http://127.0.0.1:" + strconv.Itoa(g.port) + "/?t=" + token
}

// StartURL is the current one-time link.
func (g *Guard) StartURL() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.urlFor(g.startToken)
}

// OnMint registers fn to receive each new one-time link (called with the current one at once).
func (g *Guard) OnMint(fn func(url string)) {
	g.mu.Lock()
	g.onMint = fn
	url := g.urlFor(g.startToken)
	g.mu.Unlock()
	if fn != nil {
		fn(url)
	}
}

// Exchange trades the start token for a new session cookie, once, and mints the next token.
func (g *Guard) Exchange(token string) (*http.Cookie, bool) {
	g.mu.Lock()
	if token == "" || g.startToken == "" || !equal(token, g.startToken) {
		g.mu.Unlock()
		return nil, false
	}
	session, err := randomToken()
	if err != nil {
		g.mu.Unlock()
		return nil, false
	}
	next, err := randomToken()
	if err != nil {
		next = "" // no further link until a restart; this exchange still succeeds
	}
	g.startToken = next
	g.pruneLocked()
	g.sessions = append(g.sessions, SessionRecord{Hash: g.hash(session), Expires: g.now().Add(g.lifetime).UTC().Truncate(time.Second)})
	if len(g.sessions) > MaxSessions {
		g.sessions = append([]SessionRecord(nil), g.sessions[len(g.sessions)-MaxSessions:]...)
	}
	fn, url := g.onMint, g.urlFor(next)
	recs, ver := g.records()
	g.mu.Unlock()
	g.keep(recs, ver)
	if fn != nil && next != "" {
		fn(url)
	}
	// Host-only (no Domain), HttpOnly, SameSite=Strict; a browser-session cookie whose server-side
	// record expires after SessionLifetime.
	return &http.Cookie{Name: CookieName, Value: session, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode}, true
}

// pruneLocked drops expired sessions and reports whether any went.
func (g *Guard) pruneLocked() bool {
	now := g.now()
	kept := g.sessions[:0]
	for _, r := range g.sessions {
		if r.Expires.After(now) {
			kept = append(kept, r)
		}
	}
	changed := len(kept) != len(g.sessions)
	g.sessions = kept
	return changed
}

// Sessions is how many browser sessions are held (expired ones are dropped first).
func (g *Guard) Sessions() int {
	g.mu.Lock()
	n := len(g.sessions)
	if !g.pruneLocked() {
		g.mu.Unlock()
		return n
	}
	n = len(g.sessions)
	recs, ver := g.records()
	g.mu.Unlock()
	g.keep(recs, ver)
	return n
}

// Authenticated reports whether the request carries a session cookie. Every held session is
// compared in constant time, so the comparison does not reveal which one (or none) matched.
func (g *Guard) Authenticated(r *http.Request) bool {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return false
	}
	h := g.hash(c.Value)
	g.mu.Lock()
	now := g.now()
	found, expired := 0, false
	for _, s := range g.sessions {
		live := s.Expires.After(now)
		expired = expired || !live
		match := subtle.ConstantTimeCompare([]byte(h), []byte(s.Hash))
		if live {
			found |= match
		}
	}
	if expired && g.pruneLocked() {
		recs, ver := g.records()
		g.mu.Unlock()
		g.keep(recs, ver) // an expired session is removed from what is kept
		return found == 1
	}
	g.mu.Unlock()
	return found == 1
}

// HostAllowed: the Host header must be exactly 127.0.0.1:<port> or localhost:<port>. This stops
// a page on another name that resolves to the loopback address (DNS rebinding).
func (g *Guard) HostAllowed(host string) bool {
	port := strconv.Itoa(g.port)
	return host == "127.0.0.1:"+port || host == "localhost:"+port
}

// SameSite checks the browser's own statement of where a request came from. Browsers send
// Origin on cross-origin requests (and on same-origin requests other than GET and HEAD), and
// Sec-Fetch-Site on every request. Either one naming another origin refuses the request; their
// absence (curl, an older browser) leaves the cookie and Host checks to decide.
func (g *Guard) SameSite(r *http.Request) error {
	if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
		return errors.New("The request came from another origin.")
	}
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "same-origin", "none":
		return nil
	}
	return errors.New("The request came from another site.")
}

// CSRF is the token a browser sends back in X-MACH-CSRF on a write: a keyed hash of its own session
// token under the guard's key, so each browser session has its own, nothing more is kept, and the
// token is useless without the cookie it was derived from. "" when the request has no session.
func (g *Guard) CSRF(r *http.Request) string {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return ""
	}
	m := hmac.New(sha256.New, g.key)
	m.Write([]byte("mach-observer-csrf\x00" + c.Value))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// ErrForbidden explains why a write was refused, without echoing a secret.
type ErrForbidden struct{ Reason string }

func (e *ErrForbidden) Error() string { return e.Reason }

// CheckStateChange applies to every request that can change something, after Authenticated: the
// Origin must be this host as the browser addressed it, and the CSRF header must carry the token
// of this request's own session.
func (g *Guard) CheckStateChange(r *http.Request) error {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return &ErrForbidden{"The request has no Origin header."}
	}
	if !g.HostAllowed(r.Host) || origin != "http://"+r.Host {
		return &ErrForbidden{"The request came from another origin."}
	}
	want := g.CSRF(r)
	token := r.Header.Get(CSRFHeader)
	if want == "" || token == "" || !equal(token, want) {
		return &ErrForbidden{"The request is missing this session's CSRF token. Reload the page."}
	}
	return nil
}
