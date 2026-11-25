package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
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
// export finished, under one random token, and the file the last `project.export` wrote (below).
// Nothing else can be downloaded: no route takes a path, a new export replaces its set, and a
// stopped host forgets them.
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
	// project is the last `project.export`'s file (M21 F), offered beside the Jira files: a new
	// project export replaces it, a Jira export leaves it.
	project projectFile
}

// The project's own file (M21 F): `project export` writes one file, mach-project-<id>-<time>.zip,
// straight into its folder. It can be as large as engine.MaxProjectFileBytes, so the host keeps
// only where it is, its size and its SHA-256, and reads it again for each download, serving it
// only while it is still exactly those bytes.
//
//	POST /api/ops/project.export       -> the engine's answer, plus downloads: [{name, url, bytes}]
//	                                      (or downloads: [] and download_problem: <sentence>)
//	GET  /api/downloads/<token>/<name> -> that file, as an attachment (application/zip)
var (
	projectExportFolder = []string{".factory", "studio", "export"}
	projectFileName     = regexp.MustCompile(`^mach-project-[a-z][a-z0-9-]{1,63}-[0-9]{8}T[0-9]{6}Z(-[1-9][0-9]{0,2})?\.zip$`)
)

type projectFile struct {
	token, name, path, sha256 string
	size                      int64
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

// recordProject checks the file a successful project export names (in the engine's own folder, no
// symbolic link on the way, a regular file with the export's name), keeps where it is, its size and
// its SHA-256, and returns the engine's answer with `downloads` added. A file larger than the host
// serves is not an error: the answer says where it is instead (`download_problem`).
func (d *downloads) recordProject(project string, data json.RawMessage) (json.RawMessage, error) {
	path, err := engine.ExportedFile(data)
	if err != nil {
		return nil, err
	}
	name, info, err := projectExported(project, path)
	if err != nil {
		return nil, err
	}
	var answer map[string]json.RawMessage
	if err := json.Unmarshal(data, &answer); err != nil {
		return nil, errors.New("the export's answer could not be read")
	}
	list := []map[string]any{}
	if info.Size() > engine.MaxProjectFileBytes {
		problem, _ := json.Marshal("The file is larger than 64 MB, more than Product Studio downloads. MACH saved it on this computer, in " +
			filepath.Dir(path) + ". Copy it from there.")
		answer["download_problem"] = problem
	} else {
		content, err := readProjectFile(path, info.Size())
		if err != nil {
			return nil, err
		}
		token, err := newToken()
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(content)
		d.mu.Lock()
		d.project = projectFile{token: token, name: name, path: path, sha256: hex.EncodeToString(sum[:]), size: int64(len(content))}
		d.mu.Unlock()
		list = append(list, map[string]any{"name": name, "url": "/api/downloads/" + token + "/" + name, "bytes": len(content)})
	}
	encoded, err := json.Marshal(list)
	if err != nil {
		return nil, err
	}
	answer["downloads"] = encoded
	return json.Marshal(answer)
}

// projectExported accepts only projectExportFolder/<name> under the project, walking each component
// with Lstat, and returns the file's name and what Lstat said of it.
func projectExported(project, path string) (string, os.FileInfo, error) {
	outside := errors.New("the export was written outside Product Studio's folder")
	rel, err := filepath.Rel(project, path)
	if err != nil || !filepath.IsAbs(path) {
		return "", nil, outside
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) != len(projectExportFolder)+1 || !projectFileName.MatchString(parts[len(parts)-1]) {
		return "", nil, outside
	}
	for i, part := range projectExportFolder {
		if parts[i] != part {
			return "", nil, outside
		}
	}
	current := project
	var info os.FileInfo
	for i, part := range parts {
		current = filepath.Join(current, part)
		info, err = os.Lstat(current)
		if err != nil {
			return "", nil, err
		}
		last := i == len(parts)-1
		if info.Mode()&fs.ModeSymlink != 0 || (last && !info.Mode().IsRegular()) || (!last && !info.IsDir()) {
			return "", nil, errors.New("the export folder holds a symbolic link or an unexpected entry")
		}
	}
	return parts[len(parts)-1], info, nil
}

// readProjectFile reads at most size bytes (no more than the host serves) of a file already checked.
func readProjectFile(path string, size int64) ([]byte, error) {
	if size > engine.MaxProjectFileBytes {
		return nil, errors.New("an exported file is larger than the host serves")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, engine.MaxProjectFileBytes+1))
	if err != nil || int64(len(content)) != size {
		return nil, errors.New("an exported file could not be read")
	}
	return content, nil
}

// serveProject sends the last project export's file, if the token is its and the file on disk is
// still exactly what the export wrote.
func (s *Server) serveProject(w http.ResponseWriter, r *http.Request, token, name string) {
	s.downloads.mu.Lock()
	current := s.downloads.project
	s.downloads.mu.Unlock()
	if current.token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(current.token)) != 1 || name != current.name {
		writeEnvelope(w, http.StatusNotFound, engine.Fail(engine.KindInvalid, "This download is no longer offered. Download the project again to get the file."))
		return
	}
	gone := engine.Fail(engine.KindInvalid, "The file is no longer the one MACH exported: it was changed or removed on this computer. Download the project again.")
	checkedName, info, err := projectExported(s.opts.Engine.Project(), current.path)
	if err != nil || checkedName != current.name || info.Size() != current.size {
		writeEnvelope(w, http.StatusNotFound, gone)
		return
	}
	content, err := readProjectFile(current.path, current.size)
	sum := sha256.Sum256(content)
	if err != nil || hex.EncodeToString(sum[:]) != current.sha256 {
		writeEnvelope(w, http.StatusNotFound, gone)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		w.Write(content)
	}
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
	if downloadToken.MatchString(token) && projectFileName.MatchString(name) {
		s.serveProject(w, r, token, name)
		return
	}
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
