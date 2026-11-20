package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"syscall"

	"mach/studio/internal/engine"
	"mach/studio/internal/security"
)

// A preview of a draft's own design mock (M15): the picture the product manager attached to a
// slice, served so the mocks tab can show it. Only the draft workspace's own file can be named:
//
//	GET /api/slices/<SLICE-NNN>/mocks/<sha256> -> product/mocks/<SLICE-NNN>/<sha256>.png|.jpg, inline
//
// The slice ID must match the engine's pattern and the hash be 64 lower-case hex digits. Every
// folder from the project root down is checked with Lstat (no symbolic link, nothing that is not a
// folder), the file is opened without following a link and must be a regular file of at most 5 MiB,
// and its bytes are hashed again: anything but exactly the requested hash is refused. The type is
// taken from the bytes, never from the name: a PNG or a JPEG signature, or it is refused (so a
// JPEG saved under .png is served as image/jpeg, which is what it is; the engine never writes one).
const maxMockBytes = 5 << 20

var mockHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

// mockExtensions are the engine's MOCK_FORMATS (issue_rules.py): png -> .png, jpeg -> .jpg.
var mockExtensions = []string{".png", ".jpg"}

var (
	pngSignature  = []byte("\x89PNG\r\n\x1a\n")
	jpegSignature = []byte{0xFF, 0xD8, 0xFF}
)

var errNoMock = errors.New("no such mock")

func (s *Server) mockPreview(w http.ResponseWriter, r *http.Request) {
	slice, sum := r.PathValue("slice"), r.PathValue("sha")
	if !engine.SliceIDPattern.MatchString(slice) || !mockHash.MatchString(sum) {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "Name a slice as SLICE-NNN and a picture by its full SHA-256."))
		return
	}
	data, kind, err := readMock(s.opts.Engine.Project(), slice, sum)
	if err != nil {
		writeEnvelope(w, http.StatusNotFound, engine.Fail(engine.KindInvalid, "That picture is not in this slice's draft, or it changed since it was attached."))
		return
	}
	h := w.Header()
	h.Set("Content-Type", kind)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Disposition", "inline")
	h.Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		w.Write(data)
	}
}

// readMock returns the bytes and type of the slice's mock with that hash, or an error for any doubt.
func readMock(project, slice, sum string) ([]byte, string, error) {
	for _, ext := range mockExtensions {
		path, err := security.ResolveDraft(project, "product/mocks/"+slice+"/"+sum+ext, false)
		if err != nil {
			return nil, "", err // a link, a non-folder or a missing folder on the way, or not a regular file
		}
		data, err := readNoFollow(path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, "", err
		}
		got := sha256.Sum256(data)
		if hex.EncodeToString(got[:]) != sum {
			return nil, "", errors.New("the picture changed since it was attached")
		}
		switch {
		case bytes.HasPrefix(data, pngSignature):
			return data, "image/png", nil
		case bytes.HasPrefix(data, jpegSignature):
			return data, "image/jpeg", nil
		}
		return nil, "", errors.New("not a PNG or JPEG picture")
	}
	return nil, "", errNoMock
}

// readNoFollow opens path without following a symbolic link, requires a regular file within the
// limit, and reads at most one byte past it.
func readNoFollow(path string) ([]byte, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxMockBytes {
		return nil, errors.New("not a regular file within the limit")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxMockBytes+1))
	if err != nil || len(data) > maxMockBytes {
		return nil, errors.New("the picture could not be read within the limit")
	}
	return data, nil
}
