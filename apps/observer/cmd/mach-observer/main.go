// mach-observer is the read-only local observer behind the MACH Control Tower. It follows the
// Factory's own files, keeps a redacted index of what it saw under .factory/local/observer/, and
// serves that index and a live event stream on the loopback interface.
//
// It writes nothing outside its own index folder, takes no lock MACH uses, runs no MACH command
// and starts no process. It is started by a skill, never by a MACH command, and prints the
// one-time link; it does not open a browser itself (that would need to start a process).
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"mach/observer/internal/artifact"
	"mach/observer/internal/ingest"
	"mach/observer/internal/lock"
	"mach/observer/internal/project"
	"mach/observer/internal/security"
	"mach/observer/internal/server"
	"mach/observer/internal/store"
	"mach/observer/internal/webui"
)

// MemoryLimit is the soft limit the Go runtime keeps the observer's memory under (D18 of the
// M6.2 acceptance: reading a 230,000-event history peaked at 1.6 GB). It is a target for the
// garbage collector, not a cap: what the observer must hold is bounded by its own limits (the
// tick budget, the store's memory window, shared checkpoints); this keeps the collector from
// letting garbage pile up to twice that. GOMEMLIMIT, when set, wins.
const MemoryLimit = 208 << 20

func main() {
	if os.Getenv("GOMEMLIMIT") == "" {
		debug.SetMemoryLimit(MemoryLimit)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "mach-observer:", err)
		stop()
		os.Exit(1)
	}
}

// LinkName is the file in the observer's folder that holds the next one-time link (mode 0600),
// for a second browser: the skill prints it. It is removed when the observer stops.
const LinkName = "link"

// IndexDir is the observer's own folder, relative to the project root. It is the only place the
// observer writes.
const IndexDir = ".factory/local/observer"

func run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("mach-observer", flag.ContinueOnError)
	flags.SetOutput(stderr)
	projectFlag := flags.String("project", "", "the project folder, used exactly as given (default: the nearest folder at or above the current one that holds .factory or .git)")
	port := flags.Int("port", 0, "the loopback port to listen on (default: a free one)")
	memory := flags.Int("memory-events", store.DefaultMaxMemory, "how many recent events to hold in memory and serve by cursor")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", flags.Arg(0))
	}
	root, err := findProject(*projectFlag)
	if err != nil {
		return err
	}
	logger := log.New(stderr, "mach-observer ", log.LstdFlags)

	// The index lives under .factory/local/, which MACH git-ignores. A project with no .factory is
	// observed from memory only: the observer does not create a Factory where there is none.
	indexDir := ""
	var held *lock.Lock
	if info, err := os.Lstat(filepath.Join(root, ".factory")); err == nil && info.IsDir() {
		indexDir = filepath.Join(root, filepath.FromSlash(IndexDir))
		if err := prepareIndexDir(root, indexDir); err != nil {
			return err
		}
		held, err = lock.Acquire(filepath.Join(indexDir, "lock"))
		if err != nil {
			return err
		}
		defer held.Release()
	}
	st, err := store.Open(indexDirOrEmpty(indexDir, "index"), *memory)
	if err != nil {
		return err
	}
	defer st.Close()

	// The last port is bound again when it is free, so a Control Tower page left open across a
	// restart reaches the observer at the same origin; its cookie is still valid (sessions below).
	want, remembered := *port, false
	if want == 0 && indexDir != "" {
		if p := readPort(indexDir); p > 0 {
			want, remembered = p, true
		}
	}
	listener, err := security.Listen("127.0.0.1", want)
	if err != nil && remembered {
		fmt.Fprintf(stdout, "The last port, %d, is in use: listening on a new one. A page left open must be opened again.\n", want)
		listener, err = security.Listen("127.0.0.1", 0)
	}
	if err != nil {
		return fmt.Errorf("could not listen on 127.0.0.1: %w", err)
	}
	bound := listener.Addr().(*net.TCPAddr).Port
	opts := security.GuardOptions{}
	if indexDir != "" {
		if err := writePrivate(filepath.Join(indexDir, PortName), []byte(strconv.Itoa(bound)+"\n")); err != nil {
			logger.Printf("could not remember the port: %v", err)
		}
		opts = keptSessions(root, indexDir, logger, stderr)
	}
	guard, err := security.NewGuardWith(bound, opts)
	if err != nil {
		listener.Close()
		return err
	}
	loop := ingest.New(ingest.Options{Root: root, Store: st, Logger: logger, HotFor: ingest.DefaultHotFor, ColdEvery: ingest.DefaultColdEvery})
	feedLog := storeLog{st}
	proj := project.New(project.Options{Log: feedLog, PersistDir: projectionDir(indexDir), Logger: logger, BackgroundRebuild: true})
	defer proj.Close()
	linkFile := ""
	if indexDir != "" {
		linkFile = IndexDir + "/" + LinkName
		path := filepath.Join(indexDir, LinkName)
		guard.OnMint(func(url string) {
			if err := writePrivate(path, []byte(url+"\n")); err != nil {
				logger.Printf("could not save the next one-time link: %v", err)
			}
		})
		defer os.Remove(path) // a stale link must not outlive the observer
	}
	done := make(chan struct{})
	srv := server.New(server.Options{Root: root, Guard: guard, Log: feedLog, Projector: proj, Catalog: artifact.New(root),
		Ingest: ingestSource{loop}, Factory: factorySource{root}, UI: webui.Handler(), Logger: logger, Done: done, LinkFile: linkFile}).HTTPServer()

	fmt.Fprintf(stdout, "MACH Control Tower observer for %s (read-only)\n", filepath.Base(root))
	fmt.Fprintf(stdout, "Open: %s\n", guard.StartURL())
	if linkFile != "" {
		fmt.Fprintf(stdout, "The link works once. A fresh link for another browser is kept in %s. Press Ctrl+C to stop.\n", linkFile)
	} else {
		fmt.Fprintln(stdout, "The link works once. Press Ctrl+C to stop.")
	}
	if f, ok := stdout.(*os.File); ok {
		f.Sync()
	}

	go proj.Run(done)
	go loop.Run(done)
	served := make(chan error, 1)
	go func() { served <- srv.Serve(listener) }()
	select {
	case err := <-served:
		close(done)
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}
	close(done) // ends the ingest loop and every event stream
	shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		// Every stream has already ended (done is closed). What can remain is a connection a
		// browser opened and never sent a request on, which Shutdown waits up to 5 s for. There
		// is nothing to finish, so close it.
		if errors.Is(err, context.DeadlineExceeded) {
			return srv.Close()
		}
		return err
	}
	return nil
}

// Files in the observer's folder that let a browser survive a restart.
const (
	PortName     = "port"           // the last port bound
	SecretName   = "session-secret" // 32 random bytes; with the project folder, the key sessions are hashed under
	SessionsName = "sessions.json"  // keyed hashes of session tokens and their expiry; never a token
)

// readPort returns the port remembered from the last run, or 0.
func readPort(indexDir string) int {
	b, ok := readPrivate(filepath.Join(indexDir, PortName), 16)
	if !ok {
		return 0
	}
	p, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || p < 1024 || p > 65535 {
		return 0
	}
	return p
}

// readPrivate reads a small regular file that only this user can read or write. ok is false
// when it is missing; insecure is reported separately by privateMode.
func readPrivate(path string, max int64) ([]byte, bool) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > max || info.Mode().Perm()&0o077 != 0 {
		return nil, false
	}
	b, err := os.ReadFile(path)
	return b, err == nil
}

// insecure: the path exists and is not a regular file private to this user.
func insecure(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && (!info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0)
}

type sessionFile struct {
	Version  int                      `json:"version"`
	Project  string                   `json:"project"` // a hash of the project folder the sessions belong to
	Sessions []security.SessionRecord `json:"sessions"`
}

func projectTag(root string) string {
	h := sha256.Sum256([]byte("mach-observer-project\x00" + root))
	return hex.EncodeToString(h[:8])
}

// keptSessions loads the per-project secret (making one if there is none) and the session records
// of the last run, and returns guard options that keep them up to date. A secret or a session file
// that another user could read or change, or that is a link, is not trusted: both are discarded
// and made again (every browser then needs a new link), and stderr says so. Records written for
// another project folder are ignored.
func keptSessions(root, indexDir string, logger *log.Logger, stderr io.Writer) security.GuardOptions {
	secretPath, sessionsPath := filepath.Join(indexDir, SecretName), filepath.Join(indexDir, SessionsName)
	if insecure(secretPath) || insecure(sessionsPath) {
		fmt.Fprintln(stderr, "mach-observer: the kept browser sessions are readable by others or not plain files; discarding them (open a new link)")
		os.Remove(secretPath)
		os.Remove(sessionsPath)
	}
	secret, ok := readPrivate(secretPath, 256)
	if !ok || len(secret) < 32 {
		secret = make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			return security.GuardOptions{}
		}
		if err := writePrivate(secretPath, secret); err != nil {
			logger.Printf("could not keep the session secret: %v", err)
			return security.GuardOptions{} // sessions last this run only
		}
		os.Remove(sessionsPath) // records hashed under another secret match nothing
	}
	opts := security.GuardOptions{Key: security.SessionKey(secret, root)}
	if b, ok := readPrivate(sessionsPath, 64<<10); ok {
		var f sessionFile
		if json.Unmarshal(b, &f) == nil && f.Version == 1 && f.Project == projectTag(root) {
			opts.Sessions = f.Sessions
		} else {
			fmt.Fprintln(stderr, "mach-observer: the kept browser sessions belong to another project folder; ignoring them")
		}
	}
	tag := projectTag(root)
	opts.OnSessions = func(recs []security.SessionRecord) {
		b, _ := json.Marshal(sessionFile{Version: 1, Project: tag, Sessions: recs})
		if err := writePrivate(sessionsPath, b); err != nil {
			logger.Printf("could not keep the browser sessions: %v", err)
		}
	}
	return opts
}

func projectionDir(indexDir string) string {
	if indexDir == "" {
		return ""
	}
	dir := filepath.Join(indexDir, "projection")
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return ""
	}
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() {
		return "" // a link or a file: keep the projection in memory only
	}
	return dir
}

// writePrivate writes data to path atomically, readable only by this user.
func writePrivate(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

func indexDirOrEmpty(dir, sub string) string {
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, sub)
}

// prepareIndexDir makes .factory/local/observer (and .factory/local if missing) private to the
// user, refuses either if it is a symbolic link, and writes a .gitignore of "*" inside, so the
// index never shows in git status even in a project that does not ignore .factory/local/.
func prepareIndexDir(root, dir string) error {
	local := filepath.Join(root, ".factory", "local")
	for _, d := range []string{local, dir} {
		if err := os.Mkdir(d, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("could not make %s: %w", d, err)
		}
		info, err := os.Lstat(d)
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return fmt.Errorf("%s is not a folder (a link is refused)", d)
		}
	}
	ignore := filepath.Join(dir, ".gitignore")
	if _, err := os.Lstat(ignore); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(ignore, []byte("# The MACH observer's index: machine-local, rebuilt from the Factory's files.\n*\n"), 0o600); err != nil {
			return err
		}
	}
	return nil
}

// findProject: --project names the project folder exactly (it need not hold .factory or a Git
// repository; nothing above it is ever considered, so a folder inside another repository is not
// mistaken for it). Without the flag, the walk goes up from the working folder to the first folder
// holding .factory or .git, else the working folder itself.
func findProject(start string) (string, error) {
	explicit := start != ""
	if !explicit {
		wd, err := os.Getwd()
		if err != nil {
			return "", err
		}
		start = wd
	}
	abs, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	if info, err := os.Stat(abs); err != nil || !info.IsDir() {
		return "", fmt.Errorf("%s is not a folder", abs)
	}
	if explicit {
		return abs, nil
	}
	for dir := abs; ; dir = filepath.Dir(dir) {
		for _, marker := range []string{".factory", ".git"} {
			if _, err := os.Lstat(filepath.Join(dir, marker)); err == nil {
				return dir, nil
			}
		}
		if filepath.Dir(dir) == dir {
			return abs, nil
		}
	}
}
