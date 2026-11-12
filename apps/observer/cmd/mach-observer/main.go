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

func main() {
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
	projectFlag := flags.String("project", "", "the project folder (default: the nearest folder above the current one that holds .factory)")
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

	listener, err := security.Listen("127.0.0.1", *port)
	if err != nil {
		return fmt.Errorf("could not listen on 127.0.0.1: %w", err)
	}
	guard, err := security.NewGuard(listener.Addr().(*net.TCPAddr).Port)
	if err != nil {
		listener.Close()
		return err
	}
	loop := ingest.New(ingest.Options{Root: root, Store: st, Logger: logger})
	feedLog := storeLog{st}
	proj := project.New(project.Options{Log: feedLog, PersistDir: projectionDir(indexDir), Logger: logger})
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

// findProject walks up from start (or the working folder) to the first folder holding .factory
// or .git.
func findProject(start string) (string, error) {
	if start == "" {
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
