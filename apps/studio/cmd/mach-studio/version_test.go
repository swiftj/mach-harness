package main

import (
	"bytes"
	"testing"
)

// --version prints the release the program was built for and starts nothing. A build without the
// release workflow's -ldflags says "dev".
func TestVersionFlagPrintsTheStampedVersionAndExits(t *testing.T) {
	for _, stamped := range []string{"dev", "9.8.7"} {
		previous := version
		version = stamped
		var out, errOut bytes.Buffer
		err := run([]string{"--version"}, &out, &errOut)
		version = previous
		if err != nil {
			t.Fatalf("--version returned %v (stderr %q)", err, errOut.String())
		}
		if got, want := out.String(), "mach-studio "+stamped+"\n"; got != want {
			t.Fatalf("--version printed %q, want %q", got, want)
		}
	}
	if version != "dev" {
		t.Fatalf("an unstamped test build should say dev, got %q", version)
	}
}
