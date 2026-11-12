package security

import "net/http"

// ContentSecurityPolicy allows nothing but this origin, as M5's host does: every script, style,
// font and image is embedded in the binary, and the app talks only to its own API (including the
// event stream, which is same-origin and covered by connect-src 'self').
const ContentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
	"font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; " +
	"frame-ancestors 'none'; object-src 'none'"

// Headers sets the response headers every reply carries.
func Headers(h http.Header) {
	h.Set("Content-Security-Policy", ContentSecurityPolicy)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
}
