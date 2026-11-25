package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// --version prints the release the program was built for and starts nothing: no project is looked
// up, no index opened, nothing listens. A build without the release workflow's -ldflags says "dev".
func TestVersionFlagPrintsTheStampedVersionAndExits(t *testing.T) {
	t.Chdir(t.TempDir()) // no project here: --version must not need one
	for _, stamped := range []string{"dev", "9.8.7"} {
		previous := version
		version = stamped
		var out, errOut bytes.Buffer
		err := run(context.Background(), []string{"--version"}, &out, &errOut)
		version = previous
		if err != nil {
			t.Fatalf("--version returned %v (stderr %q)", err, errOut.String())
		}
		if got, want := out.String(), "mach-observer "+stamped+"\n"; got != want {
			t.Fatalf("--version printed %q, want %q", got, want)
		}
	}
	if version != "dev" {
		t.Fatalf("an unstamped test build should say dev, got %q", version)
	}
}

// The running observer says which release and process it is beside its link, privately, and
// removes that as it stops, so MACH can tell an older observer from the one now installed.
func TestTheObserverSaysWhichReleaseIsRunning(t *testing.T) {
	previous := version
	version = "9.8.7"
	t.Cleanup(func() { version = previous })
	root := fixture(t)
	r := launch(t, root)
	path := filepath.Join(root, IndexDir, HostName)
	info, err := os.Lstat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		r.stop(t)
		t.Fatalf("host file: %v %v", info, err)
	}
	var host Host
	data, _ := os.ReadFile(path)
	if err := json.Unmarshal(data, &host); err != nil {
		t.Fatal(err)
	}
	if host.Program != "mach-observer" || host.Version != "9.8.7" || host.PID != os.Getpid() || host.Project != root ||
		!strings.HasPrefix(r.link, "http://127.0.0.1:"+strconv.Itoa(host.Port)+"/") {
		t.Fatalf("host file %+v for link %s", host, r.link)
	}
	r.stop(t)
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the host file outlived the observer")
	}
}
