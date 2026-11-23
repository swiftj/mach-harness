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

// Guard owns the secrets for one running host. There is one session for the life of the host.
// A one-time start link trades for it once; each trade mints the next start link at once and hands
// it to OnMint (the host keeps it in a private file, for a second browser or a page closed by
// mistake). Every browser that traded a link holds the same session cookie and CSRF token: a later
// link never makes a second session value, it lets one more browser into the one there is.
type Guard struct {
	port int

	mu         sync.Mutex
	startToken string // "" when no further link could be made
	session    string
	csrf       string
	onMint     func(url string)
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

// StartURL is the current, unused one-time link; "" when none could be made.
func (g *Guard) StartURL() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.urlFor(g.startToken)
}

func (g *Guard) urlFor(token string) string {
	if token == "" {
		return ""
	}
	return "http://127.0.0.1:" + strconv.Itoa(g.port) + "/?t=" + token
}

// OnMint registers fn to receive each new one-time link; it is called with the current one at once.
// fn runs while the guard is locked, so the links reach it in the order they were made and a file
// it writes always holds the newest; it must not call the guard.
func (g *Guard) OnMint(fn func(url string)) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.onMint = fn
	if url := g.urlFor(g.startToken); fn != nil && url != "" {
		fn(url)
	}
}

// CSRF is the token the app sends back in the X-MACH-CSRF header.
func (g *Guard) CSRF() string { return g.csrf }

// Exchange trades the current start token for the session cookie, once, and mints the next start
// token, which it hands to OnMint. It returns true when it traded. A token that is wrong, or already
// used, is refused. It never issues a second session value: every trade gives the same cookie.
func (g *Guard) Exchange(token string) (cookie *http.Cookie, ok bool) {
	g.mu.Lock()
	if token == "" || g.startToken == "" || !equal(token, g.startToken) {
		g.mu.Unlock()
		return nil, false
	}
	next, err := randomToken()
	if err != nil {
		next = "" // no further link until a restart; this trade still succeeds
	}
	g.startToken = next
	if url := g.urlFor(next); g.onMint != nil && url != "" {
		g.onMint(url)
	}
	g.mu.Unlock()
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
