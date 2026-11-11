// Package security holds the host's local defences: the one-time start token and the session it
// becomes, Host/Origin/CSRF checks, response headers, and safe resolution of draft files.
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

// CookieName is the session cookie. HttpOnly and SameSite=Strict; not Secure, because the host
// serves plain HTTP on the loopback interface.
const CookieName = "mach_studio_session"

// CSRFHeader carries the session's CSRF token on every state-changing request.
const CSRFHeader = "X-MACH-CSRF"

// Guard owns the secrets for one running host. There is one session: the browser that exchanged
// the start token.
type Guard struct {
	port int

	mu         sync.Mutex
	startToken string
	used       bool
	session    string
	csrf       string
}

// NewGuard makes fresh random secrets for a host listening on port.
func NewGuard(port int) (*Guard, error) {
	if port <= 0 || port > 65535 {
		return nil, fmt.Errorf("port %d is not usable", port)
	}
	g := &Guard{port: port}
	for _, target := range []*string{&g.startToken, &g.session, &g.csrf} {
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

// StartURL is printed and opened once at start-up.
func (g *Guard) StartURL() string {
	return "http://127.0.0.1:" + strconv.Itoa(g.port) + "/?t=" + g.startToken
}

// CSRF is the token the app sends back in the X-MACH-CSRF header.
func (g *Guard) CSRF() string { return g.csrf }

// Exchange trades the start token for the session cookie, once. It returns true when it did.
// A token that is wrong, or already used, is refused; it never issues a second session.
func (g *Guard) Exchange(token string) (cookie *http.Cookie, ok bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.used || token == "" || !equal(token, g.startToken) {
		return nil, false
	}
	g.used = true
	g.startToken = "" // nothing left to match
	return &http.Cookie{
		Name:     CookieName,
		Value:    g.session,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	}, true
}

// Authenticated reports whether the request carries the session cookie.
func (g *Guard) Authenticated(r *http.Request) bool {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return false
	}
	return equal(c.Value, g.session)
}

// HostAllowed: the Host header must be exactly 127.0.0.1:<port> or localhost:<port>. This stops a
// page on another name that resolves to the loopback address (DNS rebinding).
func (g *Guard) HostAllowed(host string) bool {
	port := strconv.Itoa(g.port)
	return host == "127.0.0.1:"+port || host == "localhost:"+port
}

// ErrForbidden explains why a state-changing request was refused, without echoing secrets.
type ErrForbidden struct{ Reason string }

func (e *ErrForbidden) Error() string { return e.Reason }

// CheckStateChange applies to every request that can change something: the Origin must be this
// host as the browser addressed it, and the CSRF header must carry the session's token.
func (g *Guard) CheckStateChange(r *http.Request) error {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return &ErrForbidden{"The request has no Origin header."}
	}
	if !g.HostAllowed(r.Host) || origin != "http://"+r.Host {
		return &ErrForbidden{"The request came from another origin."}
	}
	token := r.Header.Get(CSRFHeader)
	if token == "" || !equal(token, g.csrf) {
		return &ErrForbidden{"The request is missing the session's CSRF token."}
	}
	return nil
}

// IsStateChanging is every method except the safe ones.
func IsStateChanging(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	}
	return true
}
