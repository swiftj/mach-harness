package security

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListenRefusesEverythingButLoopback(t *testing.T) {
	addrs := []string{"0.0.0.0", "", "::", "::1", "localhost", "127.0.0.2", "192.168.1.10", "10.0.0.1", "example.com", "127.0.0.1.nip.io"}
	if ifaces, err := net.InterfaceAddrs(); err == nil {
		for _, a := range ifaces {
			if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLoopback() {
				addrs = append(addrs, ipn.IP.String()) // this machine's real interfaces
			}
		}
	}
	for _, host := range addrs {
		if l, err := Listen(host, 0); err != ErrNotLoopback {
			if l != nil {
				l.Close()
			}
			t.Errorf("Listen(%q) = %v, want refusal", host, err)
		}
	}
	l, err := Listen("127.0.0.1", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if !l.Addr().(*net.TCPAddr).IP.IsLoopback() {
		t.Fatal("not bound to loopback")
	}
}

func TestExchangeOnceAndSession(t *testing.T) {
	g, _ := NewGuard(4000)
	token := g.startToken
	if _, ok := g.Exchange("wrong"); ok {
		t.Fatal("a wrong token was accepted")
	}
	cookie, ok := g.Exchange(token)
	if !ok || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie %+v", cookie)
	}
	if _, ok := g.Exchange(token); ok {
		t.Fatal("the token worked twice")
	}
	r := httptest.NewRequest("GET", "/api/v1/health", nil)
	r.AddCookie(cookie)
	if !g.Authenticated(r) {
		t.Fatal("the session cookie was not accepted")
	}
	r2 := httptest.NewRequest("GET", "/api/v1/health", nil)
	r2.AddCookie(&http.Cookie{Name: CookieName, Value: "forged"})
	if g.Authenticated(r2) {
		t.Fatal("a forged cookie was accepted")
	}
}

func TestHostAndSameSite(t *testing.T) {
	g, _ := NewGuard(4000)
	for host, want := range map[string]bool{"127.0.0.1:4000": true, "localhost:4000": true, "127.0.0.1:4001": false,
		"evil.example:4000": false, "127.0.0.1": false, "[::1]:4000": false} {
		if g.HostAllowed(host) != want {
			t.Errorf("HostAllowed(%q) != %v", host, want)
		}
	}
	r := httptest.NewRequest("GET", "/api/v1/health", nil)
	r.Host = "127.0.0.1:4000"
	for _, c := range []struct {
		origin, site string
		ok           bool
	}{
		{"", "", true}, {"http://127.0.0.1:4000", "same-origin", true}, {"", "none", true},
		{"http://evil.example", "", false}, {"http://localhost:4000", "", false}, {"null", "", false},
		{"", "cross-site", false}, {"", "same-site", false},
	} {
		r.Header.Set("Origin", c.origin)
		r.Header.Set("Sec-Fetch-Site", c.site)
		if (g.SameSite(r) == nil) != c.ok {
			t.Errorf("origin %q site %q: want ok=%v", c.origin, c.site, c.ok)
		}
	}
}

// A second browser: each exchange mints the next one-time link (handed to OnMint, which the
// observer writes to its private link file); every session stays valid; old tokens never work.
func TestSecondBrowserGetsTheNextLink(t *testing.T) {
	g, _ := NewGuard(4000)
	var minted []string
	g.OnMint(func(url string) { minted = append(minted, url) })
	if len(minted) != 1 || minted[0] != g.StartURL() {
		t.Fatalf("the current link was not handed over: %v", minted)
	}
	tokenOf := func(url string) string { return url[len("http://127.0.0.1:4000/?t="):] }
	first, ok := g.Exchange(tokenOf(minted[0]))
	if !ok || len(minted) != 2 || minted[1] == minted[0] {
		t.Fatalf("no next link after an exchange: %v", minted)
	}
	second, ok := g.Exchange(tokenOf(minted[1]))
	if !ok || first.Value == second.Value {
		t.Fatal("the second browser did not get its own session")
	}
	for _, c := range []*http.Cookie{first, second} {
		r := httptest.NewRequest("GET", "/api/v1/health", nil)
		r.AddCookie(c)
		if !g.Authenticated(r) {
			t.Fatal("a session was lost when another browser joined")
		}
	}
	for _, used := range minted[:2] {
		if _, ok := g.Exchange(tokenOf(used)); ok {
			t.Fatal("a used token worked again")
		}
	}
	if g.Sessions() != 2 {
		t.Fatalf("sessions %d", g.Sessions())
	}
	// Past the cap, the oldest session is forgotten.
	for i := 0; i < MaxSessions; i++ {
		if _, ok := g.Exchange(tokenOf(minted[len(minted)-1])); !ok {
			t.Fatal("exchange failed")
		}
	}
	r := httptest.NewRequest("GET", "/api/v1/health", nil)
	r.AddCookie(first)
	if g.Authenticated(r) || g.Sessions() != MaxSessions {
		t.Fatalf("the cap was not applied: %d", g.Sessions())
	}
}
