package server_test

// M15: the preview of a draft's own design mock. Only product/mocks/<SLICE>/<sha256>.png|.jpg in
// the draft workspace, exactly the bytes with that hash, a PNG or JPEG by its content, with no
// symbolic link anywhere on the way, behind the same session and Host checks as every route.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"mach/studio/internal/engine"
	"mach/studio/internal/testkit"
)

// A small but real PNG signature followed by bytes; the host checks the signature only.
var pngBytes = append([]byte("\x89PNG\r\n\x1a\n"), []byte("\x00\x00\x00\rIHDR picture bytes")...)

func hashOf(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// placeMock writes data as the slice's mock file and returns its hash.
func placeMock(t *testing.T, project, slice, ext string, data []byte) string {
	t.Helper()
	sum := hashOf(data)
	dir := testkit.Draft(project, "product", "mocks", slice)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, sum+ext), data, 0o644); err != nil {
		t.Fatal(err)
	}
	return sum
}

func mockURL(slice, sum string) string { return "/api/slices/" + slice + "/mocks/" + sum }

// refused expects the envelope with the status, and no picture.
func refusedMock(t *testing.T, h *host, path string, status int, adjust func(*http.Request)) {
	t.Helper()
	resp, raw := h.get(path, adjust)
	var env engine.Envelope
	if resp.StatusCode != status || json.Unmarshal(raw, &env) != nil || env.OK {
		t.Errorf("%s: %d %q, want %d and the envelope", path, resp.StatusCode, raw, status)
	}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "image/") {
		t.Errorf("%s: served as a picture", path)
	}
}

func TestTheMockPreviewServesExactlyTheDraftsPicture(t *testing.T) {
	h := start(t)
	h.login()
	sum := placeMock(t, h.project, "SLICE-001", ".png", pngBytes)
	resp, body := h.get(mockURL("SLICE-001", sum), nil)
	if resp.StatusCode != 200 || string(body) != string(pngBytes) {
		t.Fatalf("preview: %d, %d bytes", resp.StatusCode, len(body))
	}
	for key, want := range map[string]string{"Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
		"Content-Disposition": "inline", "Content-Length": strconv.Itoa(len(pngBytes))} {
		if got := resp.Header.Get(key); got != want {
			t.Errorf("%s: %q, want %q", key, got, want)
		}
	}
	jpeg := append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, []byte("jpeg picture bytes")...)
	jsum := placeMock(t, h.project, "SLICE-001", ".jpg", jpeg)
	if resp, body := h.get(mockURL("SLICE-001", jsum), nil); resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/jpeg" || string(body) != string(jpeg) {
		t.Fatalf("jpeg preview: %d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
}

func TestTheMockPreviewNeedsTheSessionHostAndMethod(t *testing.T) {
	h := start(t)
	h.login()
	sum := placeMock(t, h.project, "SLICE-001", ".png", pngBytes)
	path := mockURL("SLICE-001", sum)
	if resp, _ := h.get(path, func(r *http.Request) { r.Header.Del("Cookie") }); resp.StatusCode != 401 {
		t.Errorf("without the session: %d", resp.StatusCode)
	}
	if resp, _ := h.get(path, func(r *http.Request) { r.Host = "evil.example" }); resp.StatusCode != 403 {
		t.Errorf("another host: %d", resp.StatusCode)
	}
	if status, env := h.call("POST", path, `{}`, nil); status != 405 || env.OK {
		t.Errorf("POST: %d %+v", status, env.Error)
	}
}

func TestTheMockPreviewRefusesMalformedNames(t *testing.T) {
	h := start(t)
	h.login()
	sum := placeMock(t, h.project, "SLICE-001", ".png", pngBytes)
	for _, slice := range []string{"SLICE-1", "slice-001", "SLICE-001x", "%2e%2e"} {
		refusedMock(t, h, mockURL(slice, sum), 400, nil)
	}
	for _, bad := range []string{sum[:63], strings.ToUpper(sum), sum[:63] + "g", sum + ".png", sum + "0"} {
		refusedMock(t, h, mockURL("SLICE-001", bad), 400, nil)
	}
	// Path tricks never reach the route as a slice or a hash.
	for _, path := range []string{"/api/slices/../mocks/" + sum, "/api/slices/SLICE-001/mocks/../" + sum, "/api/slices/SLICE-001/mocks"} {
		if resp, _ := h.get(path, nil); resp.StatusCode == 200 {
			t.Errorf("%s: served", path)
		}
	}
}

func TestTheMockPreviewRefusesAnythingButTheExactFile(t *testing.T) {
	h := start(t)
	h.login()
	mocks := testkit.Draft(h.project, "product", "mocks")

	// Missing: no file with that hash, and a slice with no folder at all.
	refusedMock(t, h, mockURL("SLICE-001", hashOf([]byte("nothing"))), 404, nil)
	sum := placeMock(t, h.project, "SLICE-001", ".png", pngBytes)
	refusedMock(t, h, mockURL("SLICE-002", sum), 404, nil)

	// Changed after it was named: the bytes no longer have the hash.
	os.WriteFile(filepath.Join(mocks, "SLICE-001", sum+".png"), append(pngBytes, 'x'), 0o644)
	refusedMock(t, h, mockURL("SLICE-001", sum), 404, nil)

	// Neither PNG nor JPEG, though named .png and with a matching hash.
	text := []byte("just some text, not a picture")
	refusedMock(t, h, mockURL("SLICE-001", placeMock(t, h.project, "SLICE-001", ".png", text)), 404, nil)

	// Over 5 MiB, with a PNG signature and a matching hash.
	big := append(append([]byte{}, pngBytes...), make([]byte, 5<<20)...)
	refusedMock(t, h, mockURL("SLICE-001", placeMock(t, h.project, "SLICE-001", ".png", big)), 404, nil)

	// A folder where the file goes.
	dirSum := hashOf([]byte("a folder"))
	os.MkdirAll(filepath.Join(mocks, "SLICE-001", dirSum+".png"), 0o755)
	refusedMock(t, h, mockURL("SLICE-001", dirSum), 404, nil)
}

func TestTheMockPreviewFollowsNoSymbolicLink(t *testing.T) {
	h := start(t)
	h.login()
	outside := t.TempDir()
	sum := hashOf(pngBytes)
	os.WriteFile(filepath.Join(outside, sum+".png"), pngBytes, 0o644)
	mocks := testkit.Draft(h.project, "product", "mocks")

	// The file is a link.
	os.MkdirAll(filepath.Join(mocks, "SLICE-001"), 0o755)
	if err := os.Symlink(filepath.Join(outside, sum+".png"), filepath.Join(mocks, "SLICE-001", sum+".png")); err != nil {
		t.Fatal(err)
	}
	refusedMock(t, h, mockURL("SLICE-001", sum), 404, nil)

	// The slice's folder is a link.
	if err := os.Symlink(outside, filepath.Join(mocks, "SLICE-002")); err != nil {
		t.Fatal(err)
	}
	refusedMock(t, h, mockURL("SLICE-002", sum), 404, nil)

	// The mocks folder itself is a link.
	os.RemoveAll(mocks)
	linked := t.TempDir()
	os.MkdirAll(filepath.Join(linked, "SLICE-003"), 0o755)
	os.WriteFile(filepath.Join(linked, "SLICE-003", sum+".png"), pngBytes, 0o644)
	if err := os.Symlink(linked, mocks); err != nil {
		t.Fatal(err)
	}
	refusedMock(t, h, mockURL("SLICE-003", sum), 404, nil)
}
