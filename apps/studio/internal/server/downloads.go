package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"mach/studio/internal/engine"
)

// Downloads hold exactly the files the last `jira.export` wrote, as their bytes at the moment the
// export finished, under one random token. Nothing else can be downloaded: no route takes a path,
// a new export replaces the set, and a stopped host forgets it.
//
//	POST /api/ops/jira.export          -> the engine's answer, plus downloads: [{name, url, bytes}]
//	GET  /api/downloads/<token>/<name> -> that file, as an attachment
const (
	// maxDownloadBytes bounds one exported file. The export is bounded by the engine; this is the host's own cap.
	maxDownloadBytes = 16 << 20
)

// exportFolder is where the engine writes an export when it is given no --out, which the host
// never gives: studio/jira/<flavour>[-EPIC-NNN][-all]/ inside the project's tool folder.
var exportFolder = []string{".factory", "studio", "jira"}

var (
	exportSetName  = regexp.MustCompile(`^(cloud|data-center)(-EPIC-[0-9]{3,})?(-all)?$`)
	exportFileName = regexp.MustCompile(`^(mach-jira\.csv|README\.txt)$`)
	downloadToken  = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

type download struct {
	name string
	data []byte
}

type downloads struct {
	mu    sync.Mutex
	token string
	files []download
}

// exportView is the part of jira export's answer the host reads: where it wrote.
type exportView struct {
	File   string `json:"file"`
	Readme string `json:"readme"`
}

// record reads the files a successful export names, checks each lies in the engine's own export
// folder (no symbolic link on the way, a regular file, a known name), keeps their bytes, and
// returns the engine's answer with `downloads` added. Any doubt and nothing is offered.
func (d *downloads) record(project string, data json.RawMessage) (json.RawMessage, error) {
	var view exportView
	if err := json.Unmarshal(data, &view); err != nil {
		return nil, errors.New("the export's answer could not be read")
	}
	var files []download
	for _, path := range []string{view.File, view.Readme} {
		content, name, err := readExported(project, path)
		if err != nil {
			return nil, err
		}
		files = append(files, download{name: name, data: content})
	}
	token, err := newToken()
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	d.token, d.files = token, files
	d.mu.Unlock()

	var answer map[string]json.RawMessage
	if err := json.Unmarshal(data, &answer); err != nil {
		return nil, errors.New("the export's answer could not be read")
	}
	list := make([]map[string]any, 0, len(files))
	for _, f := range files {
		list = append(list, map[string]any{"name": f.name, "url": "/api/downloads/" + token + "/" + f.name, "bytes": len(f.data)})
	}
	encoded, err := json.Marshal(list)
	if err != nil {
		return nil, err
	}
	answer["downloads"] = encoded
	return json.Marshal(answer)
}

// readExported accepts only exportFolder/<set>/<file> under the project, walking each component
// with Lstat.
func readExported(project, path string) ([]byte, string, error) {
	rel, err := filepath.Rel(project, path)
	if err != nil || !filepath.IsAbs(path) {
		return nil, "", errors.New("the export was written outside Product Studio's folder")
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) != len(exportFolder)+2 || !exportSetName.MatchString(parts[len(parts)-2]) || !exportFileName.MatchString(parts[len(parts)-1]) {
		return nil, "", errors.New("the export was written outside Product Studio's folder")
	}
	for i, part := range exportFolder {
		if parts[i] != part {
			return nil, "", errors.New("the export was written outside Product Studio's folder")
		}
	}
	current := project
	for i, part := range parts {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return nil, "", err
		}
		last := i == len(parts)-1
		if info.Mode()&fs.ModeSymlink != 0 || (last && !info.Mode().IsRegular()) || (!last && !info.IsDir()) {
			return nil, "", errors.New("the export folder holds a symbolic link or an unexpected entry")
		}
		if last && info.Size() > maxDownloadBytes {
			return nil, "", errors.New("an exported file is larger than the host serves")
		}
	}
	file, err := os.Open(current)
	if err != nil {
		return nil, "", err
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxDownloadBytes+1))
	if err != nil || len(content) > maxDownloadBytes {
		return nil, "", errors.New("an exported file could not be read")
	}
	return content, parts[len(parts)-1], nil
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", errors.New("could not make a random token")
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// GET /api/downloads/{token}/{name}: one file of the last export, as an attachment. Errors are the
// envelope, as on every API route.
func (s *Server) download(w http.ResponseWriter, r *http.Request) {
	token, name := r.PathValue("token"), r.PathValue("name")
	if !downloadToken.MatchString(token) || !exportFileName.MatchString(name) {
		writeEnvelope(w, http.StatusNotFound, engine.Fail(engine.KindInvalid, "There is no such download."))
		return
	}
	s.downloads.mu.Lock()
	current, files := s.downloads.token, s.downloads.files
	s.downloads.mu.Unlock()
	if current == "" || subtle.ConstantTimeCompare([]byte(token), []byte(current)) != 1 {
		writeEnvelope(w, http.StatusNotFound, engine.Fail(engine.KindInvalid, "This download is no longer offered. Export again to get the files."))
		return
	}
	for _, f := range files {
		if f.name != name {
			continue
		}
		kind := "text/plain; charset=utf-8"
		if strings.HasSuffix(name, ".csv") {
			kind = "text/csv; charset=utf-8"
		}
		w.Header().Set("Content-Type", kind)
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		w.Header().Set("Content-Length", strconv.Itoa(len(f.data)))
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			w.Write(f.data)
		}
		return
	}
	writeEnvelope(w, http.StatusNotFound, engine.Fail(engine.KindInvalid, "There is no such download."))
}
