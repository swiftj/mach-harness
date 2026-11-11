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
	"mach/studio/internal/interview"
	"mach/studio/internal/security"
	"mach/studio/internal/server"
	"mach/studio/internal/webui"
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "mach-studio:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("mach-studio", flag.ContinueOnError)
	flags.SetOutput(stderr)
	projectFlag := flags.String("project", "", "the project folder (default: the nearest folder above the current one that holds the project's tool folder or .git)")
	noOpen := flags.Bool("no-open", false, "do not open a browser; only print the address")
	port := flags.Int("port", 0, "the loopback port to listen on (default: a free one)")
	python := flags.String("python", "", "the Python interpreter (default: python3 on PATH)")
	script := flags.String("engine", "", "the path to studio.py (default: found next to this program, then in the project)")
	if err := flags.Parse(args); err != nil {
		return err
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
	srv := server.New(server.Options{
		Engine: eng, Guard: guard, Bridge: interview.Unavailable{}, UI: webui.Handler(),
		Logger: logger, EngineInstall: located.Install,
	}).HTTPServer()

	fmt.Fprintf(stdout, "MACH Product Studio for %s\n", filepath.Base(project))
	fmt.Fprintf(stdout, "Open: %s\n", guard.StartURL())
	fmt.Fprintln(stdout, "The link works once. Press Ctrl+C to stop.")
	if f, ok := stdout.(*os.File); ok {
		f.Sync()
	}
	if !*noOpen {
		if err := openBrowser(guard.StartURL()); err != nil {
			logger.Printf("could not open a browser; open the address above yourself")
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
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
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return srv.Shutdown(shutdown)
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
