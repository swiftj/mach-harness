// Package security holds the observer's local defences: the loopback-only listener, the one-time
// start token and the session cookie it becomes, the Host, Origin and fetch-site checks, and the
// response headers.
//
// Copied and adapted from apps/studio/internal/security (MACH Next M5, session.go and
// headers.go) rather than shared, so that Product Studio's host is not touched in this wave. The
// differences are deliberate: the observer answers GET only, so it has no CSRF token and no
// state-changing check; it refuses any request whose Origin or Sec-Fetch-Site says it came from
// another site; and the cookie has its own name, so the two hosts never share a session.
package security

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
)

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
type Guard struct {
	port int

	mu         sync.Mutex
	startToken string
	sessions   []string
	onMint     func(url string)
}

// NewGuard makes fresh random secrets for an observer listening on port.
func NewGuard(port int) (*Guard, error) {
	if port <= 0 || port > 65535 {
		return nil, fmt.Errorf("port %d is not usable", port)
	}
	g := &Guard{port: port}
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
	g.sessions = append(g.sessions, session)
	if len(g.sessions) > MaxSessions {
		g.sessions = append([]string(nil), g.sessions[len(g.sessions)-MaxSessions:]...)
	}
	fn, url := g.onMint, g.urlFor(next)
	g.mu.Unlock()
	if fn != nil && next != "" {
		fn(url)
	}
	return &http.Cookie{Name: CookieName, Value: session, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode}, true
}

// Sessions is how many browser sessions are held.
func (g *Guard) Sessions() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.sessions)
}

// Authenticated reports whether the request carries a session cookie. Every held session is
// compared in constant time, so the comparison does not reveal which one (or none) matched.
func (g *Guard) Authenticated(r *http.Request) bool {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	found := 0
	for _, s := range g.sessions {
		found |= subtle.ConstantTimeCompare([]byte(c.Value), []byte(s))
	}
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
