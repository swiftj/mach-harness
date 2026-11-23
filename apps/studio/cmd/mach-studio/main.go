// mach-studio is the local host for the visual Product Studio: it serves the embedded web app on
// the loopback interface and passes the app's requests to the Product Studio engine (studio.py).
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
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"mach/studio/internal/engine"
	"mach/studio/internal/hostdir"
	"mach/studio/internal/interview"
	"mach/studio/internal/security"
	"mach/studio/internal/server"
	"mach/studio/internal/webui"
)

// version is the MACH release this program was built for, stamped by the release workflow with
// -ldflags "-X main.version=<version>" (build.sh passes VERSION). A local build says "dev".
var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, os.Args[1:], os.Stdout, os.Stderr)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "mach-studio:", err)
		os.Exit(1)
	}
}

// run serves until ctx ends (main: Ctrl+C or SIGTERM), then shuts down.
func run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("mach-studio", flag.ContinueOnError)
	flags.SetOutput(stderr)
	projectFlag := flags.String("project", "", "the project folder (default: the nearest folder above the current one that holds the project's tool folder or .git)")
	noOpen := flags.Bool("no-open", false, "do not open a browser; only print the address")
	port := flags.Int("port", 0, "the loopback port to listen on (default: a free one)")
	python := flags.String("python", "", "the Python interpreter (default: python3 on PATH)")
	script := flags.String("engine", "", "the path to studio.py (default: found next to this program, then in the project)")
	claudeFlag := flags.String("claude", "", "the claude command for interviews (default: claude on PATH)")
	model := flags.String("model", "", "the model for interviews (default: the person's Claude Code default)")
	budget := flags.Float64("budget-per-turn", 2, "the spending cap in US dollars for each interview turn")
	turnTimeout := flags.Duration("turn-timeout", 600*time.Second, "the time limit for each interview turn")
	showVersion := flags.Bool("version", false, "print the MACH release this program was built for, and exit")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *showVersion {
		fmt.Fprintln(stdout, "mach-studio", version)
		return nil
	}
	if flags.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", flags.Arg(0))
	}

	start := *projectFlag
	if start == "" {
		wd, err := os.Getwd()
		if err != nil {
			return err
		}
		start = wd
	}
	project, err := engine.FindProject(start)
	if err != nil {
		return err
	}
	if info, err := os.Stat(project); err != nil || !info.IsDir() {
		return fmt.Errorf("%s is not a folder", project)
	}
	executable, _ := os.Executable()
	located, err := engine.LocateScript(*script, executable, project)
	if err != nil {
		return err
	}
	interpreter, err := engine.LocatePython(*python)
	if err != nil {
		return err
	}
	eng, err := engine.New(engine.Config{Python: interpreter, Script: located.Script, Project: project})
	if err != nil {
		return err
	}
	// One host per project: a second start stops here, before it touches anything the running one
	// uses. The lock ends with the process, so a host that crashed does not block the next start.
	// A project with no tool folder keeps no host folder, no lock and no link file.
	hostDir, err := hostdir.Prepare(project)
	if err != nil {
		return fmt.Errorf("could not prepare Product Studio's own folder: %w", err)
	}
	if hostDir != nil {
		held, err := hostDir.Acquire()
		if err != nil {
			return err
		}
		defer held.Release()
	}
	// A file staged for one engine call is removed after it; one left by a host that stopped in the
	// middle of a call is removed here.
	if err := security.ClearUploads(project); err != nil {
		return fmt.Errorf("could not clear Product Studio's staged uploads: %w", err)
	}

	listener, err := server.Listen(*port)
	if err != nil {
		return fmt.Errorf("could not listen on 127.0.0.1: %w", err)
	}
	guard, err := security.NewGuard(listener.Addr().(*net.TCPAddr).Port)
	if err != nil {
		listener.Close()
		return err
	}
	logger := log.New(stderr, "mach-studio ", log.LstdFlags)
	if *budget <= 0 || *budget > 100 || *turnTimeout < time.Second {
		listener.Close()
		return errors.New("--budget-per-turn must be between 0 and 100 dollars and --turn-timeout at least 1s")
	}
	claudePath := locateClaude(*claudeFlag)
	var readDirs []string
	if where := eng.Do(context.Background(), "where", nil); where.OK {
		readDirs = interview.ReadDirsFromWhere(where.Data, project)
	}
	bridge, err := interview.New(interview.Config{
		ReadDirs: readDirs,
		Project:  project, Python: interpreter, Script: located.Script, Claude: claudePath, Model: *model,
		BudgetUSD: *budget, TurnTimeout: *turnTimeout, HostEnv: os.Environ(), Logger: logger,
	})
	if err != nil {
		listener.Close()
		return err
	}
	// The next unused link is kept in a private file, replaced each time a link is used, so a
	// second browser (or a page closed by mistake) can have one without a restart.
	linkKept := false
	if hostDir != nil {
		guard.OnMint(func(url string) {
			if err := hostDir.WriteLink(url); err != nil {
				logger.Printf("could not keep the next one-time link: %v", err)
			}
		})
		defer hostDir.RemoveLink()
		linkKept = true
	}
	srv := server.New(server.Options{
		Engine: eng, Guard: guard, Bridge: bridge, UI: webui.Handler(),
		Logger: logger, EngineInstall: located.Install, LinkKept: linkKept,
	}).HTTPServer()

	fmt.Fprintf(stdout, "MACH Product Studio for %s\n", filepath.Base(project))
	fmt.Fprintf(stdout, "Open: %s\n", guard.StartURL())
	if linkKept {
		fmt.Fprintf(stdout, "The link works once. A fresh link for another browser is kept in %s/%s. Press Ctrl+C to stop.\n", hostdir.Rel, hostdir.LinkName)
	} else {
		fmt.Fprintln(stdout, "The link works once. Press Ctrl+C to stop.")
	}
	if f, ok := stdout.(*os.File); ok {
		f.Sync()
	}
	if !*noOpen {
		if err := openBrowser(guard.StartURL()); err != nil {
			logger.Printf("could not open a browser; open the address above yourself")
		}
	}

	served := make(chan error, 1)
	go func() { served <- srv.Serve(listener) }()
	select {
	case err := <-served:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	bridge.Shutdown(shutdown) // ends every interview (host_shutdown), so event streams close
	return srv.Shutdown(shutdown)
}

// locateClaude resolves the claude command once, to an absolute path; "" when it is not found.
func locateClaude(explicit string) string {
	name := explicit
	if name == "" {
		name = "claude"
	}
	path, err := exec.LookPath(name)
	if err != nil {
		return ""
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return ""
	}
	return abs
}

// openBrowser starts the system's own opener with the address as one argument; no shell.
func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
