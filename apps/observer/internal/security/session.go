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

// Guard owns the secrets for one running observer. There is one session: the browser that
// exchanged the start token. Every tab of that browser shares it.
type Guard struct {
	port int

	mu         sync.Mutex
	startToken string
	used       bool
	session    string
}

// NewGuard makes fresh random secrets for an observer listening on port.
func NewGuard(port int) (*Guard, error) {
	if port <= 0 || port > 65535 {
		return nil, fmt.Errorf("port %d is not usable", port)
	}
	g := &Guard{port: port}
	for _, target := range []*string{&g.startToken, &g.session} {
		value, err := randomToken()
		if err != nil {
			return nil, err
		}
		*target = value
	}
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

// StartURL is printed once at start-up.
func (g *Guard) StartURL() string {
	return "http://127.0.0.1:" + strconv.Itoa(g.port) + "/?t=" + g.startToken
}

// Exchange trades the start token for the session cookie, once.
func (g *Guard) Exchange(token string) (*http.Cookie, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.used || token == "" || !equal(token, g.startToken) {
		return nil, false
	}
	g.used = true
	g.startToken = ""
	return &http.Cookie{Name: CookieName, Value: g.session, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode}, true
}

// Authenticated reports whether the request carries the session cookie.
func (g *Guard) Authenticated(r *http.Request) bool {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return false
	}
	return equal(c.Value, g.session)
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
