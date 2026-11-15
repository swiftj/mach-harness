package main

import (
	"bytes"
	"context"
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
